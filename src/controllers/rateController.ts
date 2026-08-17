/**
 * อัตราค่าตอบแทนต่อเวร แยกตามกลุ่มตำแหน่ง (RN / TN / PN)
 *
 * ตารางที่ใช้คือ staff_position_rates ซึ่งมีอยู่ก่อนแล้วแต่ยังว่างเปล่า
 * ดูคำอธิบายความหมายของคอลัมน์ที่ sql/2026-08-10_staff_position_rates_audit.sql
 *
 * รหัสเวรใช้ชุดเดียวกับ nurse_shift_types ที่หน้าจัดเวรบันทึกไว้
 * ตอนคิดเงินจึงต่อจาก nurse_shift_assignments ได้ตรงๆ
 * เวร OFF ไม่มีอัตรา เพราะไม่ใช่เวรจริง (admission_change_shift_type_id = 0)
 */

import { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor } from '../utils/nursingRecord';

const clean = (v: unknown) => sanitizeHTML(String(v ?? '').trim()) ?? '';

const payablePositions = () => nurse`SELECT staff_position_id FROM staff_position`;

/** เวรที่คิดค่าตอบแทนได้ — ตัด OFF ออกตั้งแต่ต้นทาง */
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

/**
 * ตารางอัตราทั้งผืน — กลุ่มตำแหน่ง × รหัสเวร
 *
 * ส่งทั้งสามอย่างไปพร้อมกัน (กลุ่ม เวร อัตรา) เพราะหน้าจอเป็นตารางกริด
 * ถ้าให้ client ไปประกอบเองจากหลาย endpoint จะเสี่ยงวาดช่องไม่ครบเวลาข้อมูลมาไม่พร้อมกัน
 */
export const getRateMatrix = async ({ set }: Context) => {
    try {
        const [positions, shifts, rates] = await Promise.all([
            nurse`
                SELECT staff_position_id, position_name, code
                FROM staff_position
                ORDER BY staff_position_id
            `,
            payableShifts(),
            nurse`
                SELECT users_position_id AS staff_position_id, shift_code, amount, updated_at, updated_by
                FROM staff_position_rates
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
                rates: rates.map(r => ({
                    staff_position_id: Number(r.staff_position_id),
                    shift_code: clean(r.shift_code),
                    amount: Number(r.amount),
                    updated_at: r.updated_at,
                    updated_by: clean(r.updated_by) || null,
                })),
            },
        };
    } catch (error) {
        console.error('Get rate matrix error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * บันทึกอัตราทั้งชุดที่หน้าจอส่งมา
 *
 * ช่องที่เว้นว่าง (amount เป็น null) แปลว่า "ยังไม่กำหนด" จึงลบแถวทิ้ง
 * ไม่เก็บเป็น 0 เพราะสองอย่างนี้ต่างกัน — 0 คือขึ้นเวรนี้แล้วไม่ได้เงิน
 * ส่วนไม่มีแถวคือยังไม่เคยตั้งค่า ซึ่งควรทักผู้ใช้ตอนคิดเงิน
 */
export const saveRates = async ({ body, set, user }: Context & { user: any }) => {
    const { rates } = body as {
        rates: { staff_position_id: number; shift_code: string; amount: number | null }[];
    };

    const incoming = rates ?? [];

    try {
        const [positions, shifts] = await Promise.all([payablePositions(), payableShifts()]);
        const validPositions = new Set(positions.map(p => Number(p.staff_position_id)));
        const validShifts = new Set(shifts.map(s => String(s.code)));

        const parsed: { positionId: number; shiftCode: string; amount: number | null }[] = [];
        for (const row of incoming) {
            const positionId = Number(row.staff_position_id);
            const shiftCode = String(row.shift_code ?? '').trim();

            if (!validPositions.has(positionId)) {
                set.status = 400;
                return { success: false, message: `ไม่พบกลุ่มตำแหน่งรหัส ${row.staff_position_id}` };
            }
            // รหัสเวรต้องมีจริงในตารางประเภทเวร ไม่งั้นอัตราที่บันทึกไว้จะไม่มีวันถูกใช้
            if (!validShifts.has(shiftCode)) {
                set.status = 400;
                return { success: false, message: `ไม่พบรหัสเวร ${shiftCode || '(ว่าง)'} หรือเป็นเวรที่ไม่คิดค่าตอบแทน` };
            }

            const raw = row.amount;
            if (raw === null || raw === undefined || raw === ('' as unknown)) {
                parsed.push({ positionId, shiftCode, amount: null });
                continue;
            }

            const amount = Number(raw);
            if (!Number.isFinite(amount) || amount < 0) {
                set.status = 400;
                return { success: false, message: `จำนวนเงินของเวร ${shiftCode} ไม่ถูกต้อง` };
            }
            parsed.push({ positionId, shiftCode, amount: Math.round(amount * 100) / 100 });
        }

        const actor = await resolveActor(user);
        const updatedBy = actor?.username ?? null;

        const toSave = parsed.filter(p => p.amount !== null);
        const toRemove = parsed.filter(p => p.amount === null);

        await nurse.begin(async sql => {
            for (const row of toRemove) {
                await sql`
                    DELETE FROM staff_position_rates
                    WHERE users_position_id = ${row.positionId} AND shift_code = ${row.shiftCode}
                `;
            }
            for (const row of toSave) {
                await sql`
                    INSERT INTO staff_position_rates (users_position_id, shift_code, amount, updated_at, updated_by)
                    VALUES (${row.positionId}, ${row.shiftCode}, ${row.amount}, NOW(), ${updatedBy})
                    ON CONFLICT (users_position_id, shift_code)
                    DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW(), updated_by = EXCLUDED.updated_by
                `;
            }
        });

        return {
            success: true,
            message: `บันทึกอัตราค่าตอบแทนแล้ว ${toSave.length} รายการ` +
                (toRemove.length > 0 ? ` และล้างค่า ${toRemove.length} รายการ` : ''),
            saved: toSave.length,
            removed: toRemove.length,
        };
    } catch (error) {
        console.error('Save rates error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ล้างอัตราทั้งหมดของกลุ่มตำแหน่งหนึ่ง */
export const clearRates = async ({ params, set }: Context) => {
    const positionId = Number((params as { id: string }).id);
    if (!Number.isInteger(positionId)) {
        set.status = 400;
        return { success: false, message: 'staff_position_id ไม่ถูกต้อง' };
    }

    try {
        const removed = await nurse`
            DELETE FROM staff_position_rates WHERE users_position_id = ${positionId}
            RETURNING staff_position_rate_id
        `;
        return { success: true, message: `ล้างอัตราเรียบร้อยแล้ว ${removed.length} รายการ`, removed: removed.length };
    } catch (error) {
        console.error('Clear rates error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
