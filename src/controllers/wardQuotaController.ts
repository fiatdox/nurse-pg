/**
 * อัตรากำลังต่อเวรของแต่ละหอผู้ป่วย
 *
 * ตอบคำถามว่า "หอผู้ป่วยนี้ เวรนี้ ตำแหน่งนี้ ขึ้นได้กี่คน"
 * ใช้รหัสเวรชุดเดียวกับ nurse_shift_types เหมือนหน้าอัตราค่าตอบแทน
 * เพื่อให้เทียบกับเวรที่จัดจริงใน nurse_shift_assignments ได้ตรงๆ
 *
 * โครงหน้าจอเหมือนหน้าค่าตอบแทน ต่างกันตรงกรอกจำนวนคนแทนจำนวนเงิน
 * ตั้งใจให้เหมือนกัน คนใช้จะได้ไม่ต้องเรียนรู้สองแบบ
 *
 * รหัสหอผู้ป่วยใช้ ward.his_code แปลงเป็นตัวเลข ไม่ใช่ ward.ward
 * เพราะ ward_staffs และ nurse_shift_assignments ใช้ his_code ทั้งคู่
 * ถ้าใช้คนละชุดจะ join กันแล้วได้คนละหอ ทั้งที่ชื่อบนหน้าจอถูกต้อง
 */

import { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor } from '../utils/nursingRecord';

const clean = (v: unknown) => sanitizeHTML(String(v ?? '').trim()) ?? '';

/** เวรที่จัดกำลังคนได้ — ตัด OFF ออกเพราะไม่ใช่เวรจริง */
const payableShifts = () => nurse`
    SELECT nst.code, nst.name, nst.display_order,
           nst.admission_change_shift_type_id AS shift_group_id,
           acst.shift_name AS shift_group_name
    FROM nurse_shift_types nst
    LEFT JOIN admission_change_shift_types acst
           ON acst.admission_change_shift_type_id = nst.admission_change_shift_type_id
    WHERE nst.admission_change_shift_type_id > 0
    ORDER BY nst.admission_change_shift_type_id, nst.display_order
`;

/** โครงตารางว่างของหน้าจอ — กลุ่มตำแหน่ง เวร และหอผู้ป่วยที่เลือกได้ */
export const getQuotaOptions = async ({ set }: Context) => {
    try {
        const [positions, shifts, wards] = await Promise.all([
            nurse`SELECT staff_position_id, position_name, code FROM staff_position ORDER BY staff_position_id`,
            payableShifts(),
            // คืน his_code เป็นตัวเลขในชื่อ ward เพื่อให้กุญแจตรงกับ ward_staffs
            // กรองหอที่ his_code ไม่ใช่ตัวเลขทิ้ง เพราะจับคู่กับตารางอื่นไม่ได้อยู่ดี
            nurse`
                SELECT his_code::int AS ward, ward_name
                FROM ward
                WHERE is_active = 'Y' AND his_code ~ '^[0-9]+$'
                ORDER BY ward_name
            `,
        ]);

        return {
            success: true,
            data: {
                positions: positions.map(p => ({
                    staff_position_id: Number(p.staff_position_id),
                    position_name: clean(p.position_name),
                    code: clean(p.code),
                })),
                shifts: shifts.map(s => ({
                    code: clean(s.code),
                    name: clean(s.name),
                    shift_group_id: Number(s.shift_group_id),
                    shift_group_name: clean(s.shift_group_name),
                    display_order: Number(s.display_order ?? 0),
                })),
                wards: wards.map(w => ({ ward: Number(w.ward), ward_name: clean(w.ward_name) })),
            },
        };
    } catch (error) {
        console.error('Get quota options error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** โควตาที่ตั้งไว้ของหอผู้ป่วยหนึ่ง */
export const getWardQuotas = async ({ params, set }: Context) => {
    const ward = Number((params as { ward: string }).ward);
    if (!Number.isInteger(ward)) {
        set.status = 400;
        return { success: false, message: 'รหัสหอผู้ป่วยไม่ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT staff_position_id, shift_code, quota, updated_at, updated_by
            FROM ward_shift_quotas WHERE ward = ${ward}
        `;
        return {
            success: true,
            data: rows.map(r => ({
                staff_position_id: Number(r.staff_position_id),
                shift_code: clean(r.shift_code),
                quota: Number(r.quota),
                updated_at: r.updated_at,
                updated_by: clean(r.updated_by) || null,
            })),
        };
    } catch (error) {
        console.error('Get ward quotas error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * บันทึกโควตาของหอผู้ป่วยหนึ่ง
 *
 * ช่องที่เว้นว่าง (quota = null) แปลว่ายังไม่ได้กำหนด จึงลบแถวทิ้ง
 * ต่างจากใส่ 0 ซึ่งแปลว่าตั้งใจไม่ให้ขึ้นเวรนี้เลย
 */
export const saveWardQuotas = async ({ body, set, user }: Context & { user: any }) => {
    const { ward, quotas } = body as {
        ward: number;
        quotas: { staff_position_id: number; shift_code: string; quota: number | null }[];
    };

    const wardId = Number(ward);
    if (!Number.isInteger(wardId)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุหอผู้ป่วยให้ถูกต้อง' };
    }

    try {
        const [wardRow, positions, shifts] = await Promise.all([
            nurse`
                SELECT his_code FROM ward
                WHERE his_code ~ '^[0-9]+$' AND his_code::int = ${wardId} AND is_active = 'Y'
                LIMIT 1
            `,
            nurse`SELECT staff_position_id FROM staff_position`,
            payableShifts(),
        ]);

        if (wardRow.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบหอผู้ป่วยที่ระบุ หรือหอผู้ป่วยถูกปิดใช้งาน' };
        }

        const validPositions = new Set(positions.map(p => Number(p.staff_position_id)));
        const validShifts = new Set(shifts.map(s => String(s.code)));

        const parsed: { positionId: number; shiftCode: string; quota: number | null }[] = [];
        for (const row of quotas ?? []) {
            const positionId = Number(row.staff_position_id);
            const shiftCode = String(row.shift_code ?? '').trim();

            if (!validPositions.has(positionId)) {
                set.status = 400;
                return { success: false, message: `ไม่พบกลุ่มตำแหน่งรหัส ${row.staff_position_id}` };
            }
            if (!validShifts.has(shiftCode)) {
                set.status = 400;
                return { success: false, message: `ไม่พบรหัสเวร ${shiftCode || '(ว่าง)'} หรือเป็นเวรที่จัดกำลังคนไม่ได้` };
            }

            if (row.quota === null || row.quota === undefined) {
                parsed.push({ positionId, shiftCode, quota: null });
                continue;
            }

            const quota = Number(row.quota);
            // จำนวนคนต้องเป็นจำนวนเต็มบวก เศษส่วนแปลว่าหน้าจอส่งค่าผิดชนิดมา
            if (!Number.isInteger(quota) || quota < 0 || quota > 999) {
                set.status = 400;
                return { success: false, message: `จำนวนคนของเวร ${shiftCode} ไม่ถูกต้อง` };
            }
            parsed.push({ positionId, shiftCode, quota });
        }

        const actor = await resolveActor(user);
        const updatedBy = actor?.username ?? null;

        const toSave = parsed.filter(p => p.quota !== null);
        const toRemove = parsed.filter(p => p.quota === null);

        await nurse.begin(async sql => {
            for (const row of toRemove) {
                await sql`
                    DELETE FROM ward_shift_quotas
                    WHERE ward = ${wardId} AND staff_position_id = ${row.positionId} AND shift_code = ${row.shiftCode}
                `;
            }
            for (const row of toSave) {
                await sql`
                    INSERT INTO ward_shift_quotas (ward, staff_position_id, shift_code, quota, updated_at, updated_by)
                    VALUES (${wardId}, ${row.positionId}, ${row.shiftCode}, ${row.quota}, NOW(), ${updatedBy})
                    ON CONFLICT (ward, staff_position_id, shift_code)
                    DO UPDATE SET quota = EXCLUDED.quota, updated_at = NOW(), updated_by = EXCLUDED.updated_by
                `;
            }
        });

        return {
            success: true,
            message: `บันทึกอัตรากำลังแล้ว ${toSave.length} รายการ` +
                (toRemove.length > 0 ? ` และล้างค่า ${toRemove.length} รายการ` : ''),
            saved: toSave.length,
            removed: toRemove.length,
        };
    } catch (error) {
        console.error('Save ward quotas error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ล้างโควตาทั้งหมดของหอผู้ป่วยหนึ่ง */
export const clearWardQuotas = async ({ params, set }: Context) => {
    const ward = Number((params as { ward: string }).ward);
    if (!Number.isInteger(ward)) {
        set.status = 400;
        return { success: false, message: 'รหัสหอผู้ป่วยไม่ถูกต้อง' };
    }

    try {
        const removed = await nurse`
            DELETE FROM ward_shift_quotas WHERE ward = ${ward} RETURNING ward_shift_quota_id
        `;
        return { success: true, message: `ล้างอัตรากำลังแล้ว ${removed.length} รายการ`, removed: removed.length };
    } catch (error) {
        console.error('Clear ward quotas error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
