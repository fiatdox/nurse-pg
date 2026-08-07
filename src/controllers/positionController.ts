/**
 * จัดการการจับคู่ตำแหน่งในระบบบุคลากรเข้ากับกลุ่มตำแหน่งของงานพยาบาล
 *
 * core_kon.user_positions เป็นตำแหน่งของทั้งโรงพยาบาล 100 แบบ ปนกันทุกวิชาชีพ
 * ส่วนงานพยาบาลคิดค่าตอบแทนจากกลุ่มของเราแค่ 3 กลุ่ม (RN / TN / PN)
 * ตารางกลางจึงทำหน้าที่แปลงจากตำแหน่งดิบเป็นกลุ่มที่มีอัตราค่าตอบแทนกำกับ
 *
 * หมายเหตุ: ไฟล์นี้ไม่เกี่ยวกับสิทธิ์ลงนามในบันทึกทางการพยาบาล
 * สิทธิ์นั้นยังตัดสินจาก ROLE_BY_POSITION ใน utils/nursingRecord.ts เหมือนเดิม
 * ตั้งใจแยกกัน เพราะการแก้ค่าตอบแทนไม่ควรไปเปลี่ยนว่าใครลงนามกำกับบันทึกได้
 */

import { Context } from 'elysia';
import { core_kon, nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor } from '../utils/nursingRecord';

const clean = (v: unknown) => sanitizeHTML(String(v ?? '').trim()) ?? '';

/** กลุ่มตำแหน่งของเรา — ฝั่งซ้ายของหน้าจอ */
export const getStaffPositions = async ({ set }: Context) => {
    try {
        const rows = await nurse`
            SELECT sp.staff_position_id, sp.position_name, sp.code,
                   (SELECT COUNT(*)::int FROM staff_position_mappings m
                     WHERE m.staff_position_id = sp.staff_position_id) AS mapped_count
            FROM staff_position sp
            ORDER BY sp.staff_position_id
        `;
        return {
            success: true,
            data: rows.map(r => ({ ...r, position_name: clean(r.position_name) })),
        };
    } catch (error) {
        console.error('Get staff positions error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * ตำแหน่งทั้งหมดจาก core_kon พร้อมจำนวนคนที่ถืออยู่
 *
 * แนบสถานะการจับคู่มาด้วย เพราะหน้าจอต้องกันไม่ให้ลากตำแหน่งที่กลุ่มอื่นถืออยู่แล้ว
 * ถ้าไม่บอกล่วงหน้า ผู้ใช้จะกดบันทึกแล้วเจอ error โดยไม่รู้สาเหตุ
 * (ตารางกลางกำหนดให้ตำแหน่งหนึ่งอยู่ได้กลุ่มเดียว ไม่งั้นคิดค่าตอบแทนไม่ได้)
 */
export const getCorePositions = async ({ set }: Context) => {
    try {
        const [positions, mappings] = await Promise.all([
            core_kon`
                SELECT up.user_position_id, up.position_name,
                       COUNT(u.id)::int AS user_count
                FROM user_positions up
                LEFT JOIN users u ON u.user_position_id = up.user_position_id
                GROUP BY up.user_position_id, up.position_name
                ORDER BY COUNT(u.id) DESC, up.position_name
            `,
            nurse`
                SELECT m.user_position_id, m.staff_position_id, sp.code, sp.position_name AS group_name
                FROM staff_position_mappings m
                LEFT JOIN staff_position sp ON sp.staff_position_id = m.staff_position_id
            `,
        ]);

        const byId = new Map(mappings.map(m => [Number(m.user_position_id), m]));

        return {
            success: true,
            data: positions.map(p => {
                const hit = byId.get(Number(p.user_position_id));
                return {
                    user_position_id: Number(p.user_position_id),
                    position_name: clean(p.position_name),
                    user_count: Number(p.user_count ?? 0),
                    staff_position_id: hit ? Number(hit.staff_position_id) : null,
                    group_code: hit ? clean(hit.code) : null,
                    group_name: hit ? clean(hit.group_name) : null,
                };
            }),
        };
    } catch (error) {
        console.error('Get core positions error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ตำแหน่งที่จับคู่ไว้กับกลุ่มหนึ่ง */
export const getPositionMappings = async ({ params, set }: Context) => {
    const staffPositionId = Number((params as { id: string }).id);
    if (!Number.isInteger(staffPositionId)) {
        set.status = 400;
        return { success: false, message: 'staff_position_id ไม่ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT user_position_id, position_name, staff_position_id, updated_at, updated_by
            FROM staff_position_mappings
            WHERE staff_position_id = ${staffPositionId}
            ORDER BY position_name
        `;
        return {
            success: true,
            data: rows.map(r => ({
                ...r,
                user_position_id: Number(r.user_position_id),
                position_name: clean(r.position_name),
            })),
        };
    } catch (error) {
        console.error('Get position mappings error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * บันทึกรายการตำแหน่งของกลุ่มหนึ่ง (แทนที่ของเดิมทั้งชุด)
 *
 * ทำแบบแทนที่ทั้งชุดเหมือนหน้าเจ้าหน้าที่ประจำตึก เพราะหน้าจอเป็น Transfer
 * ซึ่งส่งสถานะปลายทางมาทั้งก้อนอยู่แล้ว ไม่ได้ส่งว่าเพิ่มอะไรลบอะไร
 */
export const savePositionMappings = async ({ body, set, user }: Context & { user: any }) => {
    const { staff_position_id, user_position_ids } = body as {
        staff_position_id: number;
        user_position_ids: (number | string)[];
    };

    const groupId = Number(staff_position_id);
    if (!Number.isInteger(groupId)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุกลุ่มตำแหน่งให้ถูกต้อง' };
    }

    const ids = [...new Set((user_position_ids ?? []).map(Number).filter(Number.isInteger))];

    try {
        const group = await nurse`
            SELECT staff_position_id FROM staff_position WHERE staff_position_id = ${groupId} LIMIT 1
        `;
        if (group.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบกลุ่มตำแหน่งที่ระบุ' };
        }

        // กันไม่ให้แย่งตำแหน่งที่กลุ่มอื่นถืออยู่ ต้องเอาออกจากกลุ่มเดิมก่อน
        // ถ้าปล่อยให้ทับกันเงียบๆ อัตราค่าตอบแทนของคนกลุ่มเดิมจะเปลี่ยนโดยไม่มีใครรู้
        if (ids.length > 0) {
            const taken = await nurse`
                SELECT m.user_position_id, m.position_name, sp.position_name AS group_name
                FROM staff_position_mappings m
                LEFT JOIN staff_position sp ON sp.staff_position_id = m.staff_position_id
                WHERE m.user_position_id IN ${nurse(ids)}
                  AND m.staff_position_id <> ${groupId}
            `;
            if (taken.length > 0) {
                set.status = 409;
                return {
                    success: false,
                    message: `ตำแหน่งต่อไปนี้ถูกจับคู่ไว้กับกลุ่มอื่นแล้ว: ${taken
                        .map(t => `${clean(t.position_name)} (${clean(t.group_name)})`)
                        .join(', ')}`,
                    conflicts: taken.map(t => Number(t.user_position_id)),
                };
            }
        }

        // ชื่อตำแหน่งต้องอ่านจาก core_kon เอง ห้ามเชื่อชื่อที่ client ส่งมา
        const names =
            ids.length > 0
                ? await core_kon`
                    SELECT user_position_id, position_name FROM user_positions
                    WHERE user_position_id IN ${core_kon(ids)}
                  `
                : [];
        const nameOf = new Map(names.map(n => [Number(n.user_position_id), clean(n.position_name)]));

        const unknown = ids.filter(id => !nameOf.has(id));
        if (unknown.length > 0) {
            set.status = 400;
            return { success: false, message: `ไม่พบตำแหน่งรหัส ${unknown.join(', ')} ในระบบบุคลากร` };
        }

        const actor = await resolveActor(user);
        const updatedBy = actor?.username ?? null;

        await nurse.begin(async sql => {
            await sql`DELETE FROM staff_position_mappings WHERE staff_position_id = ${groupId}`;
            if (ids.length > 0) {
                const values = ids.map(id => ({
                    user_position_id: id,
                    position_name: nameOf.get(id) ?? '',
                    staff_position_id: groupId,
                    updated_at: new Date(),
                    updated_by: updatedBy,
                }));
                await sql`
                    INSERT INTO staff_position_mappings ${sql(
                        values,
                        'user_position_id',
                        'position_name',
                        'staff_position_id',
                        'updated_at',
                        'updated_by'
                    )}
                `;
            }
        });

        return { success: true, message: `บันทึกเรียบร้อยแล้ว จำนวน ${ids.length} ตำแหน่ง`, saved: ids.length };
    } catch (error) {
        console.error('Save position mappings error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** เอาตำแหน่งทั้งหมดออกจากกลุ่ม */
export const clearPositionMappings = async ({ params, set }: Context) => {
    const staffPositionId = Number((params as { id: string }).id);
    if (!Number.isInteger(staffPositionId)) {
        set.status = 400;
        return { success: false, message: 'staff_position_id ไม่ถูกต้อง' };
    }

    try {
        const removed = await nurse`
            DELETE FROM staff_position_mappings WHERE staff_position_id = ${staffPositionId}
            RETURNING user_position_id
        `;
        return { success: true, message: `นำออกเรียบร้อยแล้ว จำนวน ${removed.length} ตำแหน่ง`, removed: removed.length };
    } catch (error) {
        console.error('Clear position mappings error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** กลุ่มงานที่มีคนอยู่จริง — ใช้เป็นตัวกรองในหน้าเลือกเจ้าหน้าที่ */
export const getMajors = async ({ set }: Context) => {
    try {
        const rows = await core_kon`
            SELECT mj.major_id, mj."name", COUNT(u.id)::int AS user_count
            FROM majors mj
            LEFT JOIN users u ON u.major_id = mj.major_id AND u.is_active = 'Y'
            GROUP BY mj.major_id, mj."name"
            HAVING COUNT(u.id) > 0
            ORDER BY mj."name"
        `;
        return {
            success: true,
            data: rows.map(r => ({
                major_id: Number(r.major_id),
                name: clean(r.name),
                user_count: Number(r.user_count ?? 0),
            })),
        };
    } catch (error) {
        console.error('Get majors error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * บุคลากรที่เลือกเข้าหอผู้ป่วยได้ — มาจาก core_kon.users โดยตรง
 *
 * กรองด้วยตำแหน่งที่จับคู่ไว้ในหน้าจัดการตำแหน่ง ไม่ใช่รายชื่อที่พิมพ์เข้ามาเอง
 * ชื่อจึงตรงกับทะเบียนบุคลากรจริงเสมอ และได้กลุ่ม RN/TN/PN ติดมาด้วย
 * ซึ่งเป็นตัวชี้อัตราค่าตอบแทนต่อเวรในภายหลัง
 *
 * ถ้ายังไม่ได้จับคู่ตำแหน่งไว้เลย จะคืนลิสต์ว่าง ไม่ใช่คืนคนทั้งโรงพยาบาล
 * เพราะการเผลอดึงมาทั้ง 1,241 คนอันตรายกว่าการไม่เห็นใครเลย
 */
export const getEligibleStaff = async ({ query, set }: Context) => {
    const { major_id } = query as { major_id?: string };
    const majorId = major_id ? Number(major_id) : null;

    try {
        const mappings = await nurse`
            SELECT m.user_position_id, m.staff_position_id, sp.code, sp.position_name AS group_name
            FROM staff_position_mappings m
            LEFT JOIN staff_position sp ON sp.staff_position_id = m.staff_position_id
        `;
        if (mappings.length === 0) {
            return { success: true, data: [], message: 'ยังไม่ได้จับคู่ตำแหน่งใดไว้ในหน้าจัดการตำแหน่ง' };
        }

        const positionIds = mappings.map(m => Number(m.user_position_id));
        const byPosition = new Map(mappings.map(m => [Number(m.user_position_id), m]));

        const rows = await core_kon`
            SELECT u.id, CONCAT(u.pname, u.fname, ' ', u.lname) AS fullname,
                   u.user_position_id, up.position_name,
                   u.major_id, mj."name" AS major_name
            FROM users u
            LEFT JOIN user_positions up ON up.user_position_id = u.user_position_id
            LEFT JOIN majors mj ON mj.major_id = u.major_id
            WHERE u.user_position_id IN ${core_kon(positionIds)}
              AND u.is_active = 'Y'
              ${majorId ? core_kon`AND u.major_id = ${majorId}` : core_kon``}
            ORDER BY u.fname, u.lname
        `;

        return {
            success: true,
            data: rows.map(r => {
                const map = byPosition.get(Number(r.user_position_id));
                return {
                    user_id: Number(r.id),
                    fullname: clean(r.fullname),
                    position_name: clean(r.position_name),
                    major_id: r.major_id === null ? null : Number(r.major_id),
                    major_name: clean(r.major_name),
                    staff_position_id: map ? Number(map.staff_position_id) : null,
                    group_code: map ? clean(map.code) : null,
                    group_name: map ? clean(map.group_name) : null,
                };
            }),
        };
    } catch (error) {
        console.error('Get eligible staff error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
