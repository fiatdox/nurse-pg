import { Context } from 'elysia';
import { core_kon, nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';


// ฟังก์ชั่นแสดงรายชื่อเจ้าหน้าที่
export const getStaffs = async ({ query, set }: Context) => {
    const { is_active } = query as { is_active?: string };

    try {
        const rows = is_active !== undefined
            ? await nurse`SELECT staff_id, fullname, staff_position_id, is_active FROM staffs WHERE is_active = ${is_active} ORDER BY fullname ASC`
            : await nurse`SELECT staff_id, fullname, staff_position_id, is_active FROM staffs ORDER BY fullname ASC`;

        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่อเจ้าหน้าที่
            data: rows.map(row => ({
                ...row,
                fullname: row.fullname ? sanitizeHTML(row.fullname) : null
            }))
        };
    } catch (error) {
        console.error('Get staffs error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// เพิ่มเจ้าหน้าที่ใหม่
export const addStaff = async ({ body, set }: Context) => {
    const { fullname, staff_position_id, is_active } = body as {
        fullname: string;
        staff_position_id: number;
        is_active?: string;
    };

    if (!fullname || !staff_position_id) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ fullname และ staff_position_id' };
    }

    try {
        const [result] = await nurse`
            INSERT INTO staffs (fullname, staff_position_id, is_active)
            VALUES (${fullname}, ${staff_position_id}, ${is_active ?? 'Y'})
            RETURNING staff_id
        `;

        return {
            success: true,
            message: 'เพิ่มเจ้าหน้าที่เรียบร้อยแล้ว',
            staff_id: result.staff_id
        };
    } catch (error) {
        console.error('Add staff error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// แก้ไขข้อมูลเจ้าหน้าที่
export const updateStaff = async ({ params, body, set }: Context) => {
    const staff_id = Number(params.id);
    const { fullname, staff_position_id, is_active } = body as { fullname?: string; staff_position_id?: number; is_active?: string };

    if (!fullname && staff_position_id === undefined && is_active === undefined) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุข้อมูลที่ต้องการแก้ไขอย่างน้อย 1 ฟิลด์' };
    }

    try {
        const existing = await nurse`SELECT staff_id FROM staffs WHERE staff_id = ${staff_id}`;

        if (existing.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบเจ้าหน้าที่ที่ต้องการแก้ไข' };
        }

        const updates: Record<string, any> = {};
        if (fullname !== undefined) updates.fullname = fullname;
        if (staff_position_id !== undefined) updates.staff_position_id = staff_position_id;
        if (is_active !== undefined) updates.is_active = is_active;

        await nurse`UPDATE staffs SET ${nurse(updates)} WHERE staff_id = ${staff_id}`;

        return { success: true, message: 'แก้ไขข้อมูลเจ้าหน้าที่เรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Update staff error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ปิดการแสดง (ตั้ง is_active = 'N')
export const deactivateStaff = async ({ params, set }: Context) => {
    const staff_id = Number(params.id);

    try {
        const existing = await nurse`SELECT staff_id FROM staffs WHERE staff_id = ${staff_id}`;

        if (existing.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบเจ้าหน้าที่' };
        }

        await nurse`UPDATE staffs SET is_active = 'N' WHERE staff_id = ${staff_id}`;

        return { success: true, message: 'ปิดการแสดงเจ้าหน้าที่เรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Deactivate staff error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// เปิดการแสดง (ตั้ง is_active = 'Y')
export const activateStaff = async ({ params, set }: Context) => {
    const staff_id = Number(params.id);

    try {
        const existing = await nurse`SELECT staff_id FROM staffs WHERE staff_id = ${staff_id}`;

        if (existing.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบเจ้าหน้าที่' };
        }

        await nurse`UPDATE staffs SET is_active = 'Y' WHERE staff_id = ${staff_id}`;

        return { success: true, message: 'เปิดการแสดงเจ้าหน้าที่เรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Activate staff error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};


// ฟังก์ชันสำหรับดึงเจ้าหน้าที่ตามหอผู้ป่วย
export const getWardStaffByWard = async ({ params, set }: Context) => {
    const { id } = params as Record<string, string>;

    try {
        // คืน user_id มาด้วย เพราะหน้าจอเลือกคนจาก core_kon.users
        // จึงต้องใช้ user_id เป็นคีย์ในการติ๊ก ไม่ใช่ staff_id ที่เป็นเลขภายในของเรา
        const rows = await nurse`
            SELECT ws.staff_id, ws.ward, s.fullname, s.user_id,
                   sp.position_name, sp.code AS group_code
            FROM ward_staffs ws
            JOIN staffs s ON ws.staff_id = s.staff_id
            LEFT JOIN staff_position sp ON s.staff_position_id = sp.staff_position_id
            WHERE ws.ward = ${id} AND s.is_active = 'Y'
            -- เรียงตามลำดับวิชาชีพ ไม่ใช่ตามรหัส เพราะรหัสบังเอิญเรียงถูกอยู่ตอนนี้
            -- แต่ถ้ามีการเพิ่มกลุ่มใหม่ทีหลัง ลำดับจะเพี้ยนโดยไม่มีใครสังเกต
            ORDER BY CASE sp.code
                        WHEN 'RN' THEN 1
                        WHEN 'TN' THEN 2
                        WHEN 'PN' THEN 3
                        ELSE 9
                     END,
                     s.fullname
        `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                fullname: sanitizeHTML(row.fullname)
            }))
        };
    } catch (error) {
        console.error('Get ward staffs by ward error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับเคลียร์เจ้าหน้าที่ทั้งหมดออกจากหอผู้ป่วยตามรหัส
export const clearWardStaffsByWard = async ({ params, set }: Context) => {
    const { ward } = params as Record<string, string>;

    if (!ward) {
        set.status = 400;
        return {
            success: false,
            message: 'กรุณาระบุหอผู้ป่วย (ward)'
        };
    }

    try {
        const result = await nurse`DELETE FROM ward_staffs WHERE ward = ${ward}`;

        return {
            success: true,
            message: `ลบข้อมูลเจ้าหน้าที่ออกจากหอผู้ป่วยเรียบร้อยแล้ว จำนวน ${result.count} รายการ`
        };
    } catch (error) {
        console.error('Clear ward staffs error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับจัดการเจ้าหน้าที่ประจำหอผู้ป่วย (Replace All ตาม ward)
/**
 * บันทึกเจ้าหน้าที่ประจำหอผู้ป่วย (แทนที่ทั้งชุดตาม ward)
 *
 * รับได้สองแบบเพื่อไม่ให้ของเดิมพัง:
 *   user_id  — คนจาก core_kon.users (แบบใหม่ที่หน้าจอใช้)
 *   staff_id — แถวใน staffs ที่มีอยู่แล้ว (แบบเดิม)
 *
 * แบบใหม่จะ upsert แถวใน staffs ให้อัตโนมัติ เพราะ ward_staffs,
 * nurse_shift_assignments และอัตราค่าตอบแทนล้วนผูกกับ staff_id
 * ชื่อและกลุ่มตำแหน่งอ่านจากต้นทางเสมอ ไม่รับจากหน้าจอ
 * เพื่อให้ชื่อตรงกับทะเบียนบุคลากรจริงและกลุ่มตรงกับที่จับคู่ไว้
 */
export const addWardStaffs = async ({ body, set }: Context) => {
    const payload = body as { staff_id?: string | number; user_id?: string | number; ward: string | number }[];

    if (!Array.isArray(payload) || payload.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบข้อมูลที่ต้องการบันทึก หรือรูปแบบข้อมูลไม่ถูกต้อง' };
    }

    const uniqueWards = [...new Set(payload.map(item => String(item.ward)))];
    const userIds = [...new Set(
        payload.filter(i => i.user_id !== undefined && i.user_id !== null).map(i => Number(i.user_id))
    )];

    try {
        // แปลง user_id -> staff_id โดยสร้างแถวใน staffs ให้ถ้ายังไม่มี
        const staffIdByUser = new Map<number, number>();

        if (userIds.length > 0) {
            const [people, mappings] = await Promise.all([
                core_kon`
                    SELECT u.id, CONCAT(u.pname, u.fname, ' ', u.lname) AS fullname, u.user_position_id
                    FROM users u WHERE u.id IN ${core_kon(userIds)}
                `,
                nurse`SELECT user_position_id, staff_position_id FROM staff_position_mappings`,
            ]);

            const groupOf = new Map(mappings.map(m => [Number(m.user_position_id), Number(m.staff_position_id)]));
            const missing = userIds.filter(id => !people.some(p => Number(p.id) === id));
            if (missing.length > 0) {
                set.status = 400;
                return { success: false, message: `ไม่พบบุคลากรรหัส ${missing.join(', ')} ในระบบบุคลากร` };
            }

            const unmapped = people.filter(p => !groupOf.has(Number(p.user_position_id)));
            if (unmapped.length > 0) {
                set.status = 400;
                return {
                    success: false,
                    message: `ตำแหน่งของ ${unmapped.map(p => sanitizeHTML(p.fullname)).join(', ')} ยังไม่ได้จับคู่กลุ่มในหน้าจัดการตำแหน่ง`,
                };
            }

            await nurse.begin(async sql => {
                for (const p of people) {
                    const userId = Number(p.id);
                    const fullname = sanitizeHTML(String(p.fullname ?? '').trim()) ?? '';
                    const groupId = groupOf.get(Number(p.user_position_id))!;

                    const existing = await sql`SELECT staff_id FROM staffs WHERE user_id = ${userId} LIMIT 1`;
                    if (existing.length > 0) {
                        // ชื่อหรือตำแหน่งอาจเปลี่ยนที่ต้นทาง ปรับตามให้ทุกครั้งที่บันทึก
                        await sql`
                            UPDATE staffs SET fullname = ${fullname}, staff_position_id = ${groupId}, is_active = 'Y'
                            WHERE staff_id = ${existing[0].staff_id}
                        `;
                        staffIdByUser.set(userId, Number(existing[0].staff_id));
                    } else {
                        const inserted = await sql`
                            INSERT INTO staffs (fullname, staff_position_id, is_active, user_id)
                            VALUES (${fullname}, ${groupId}, 'Y', ${userId})
                            RETURNING staff_id
                        `;
                        staffIdByUser.set(userId, Number(inserted[0].staff_id));
                    }
                }
            });
        }

        const values = payload.map(item => ({
            staff_id: item.user_id !== undefined && item.user_id !== null
                ? staffIdByUser.get(Number(item.user_id))!
                : Number(item.staff_id),
            ward: String(item.ward),
        }));

        await nurse.begin(async sql => {
            for (const ward of uniqueWards) {
                await sql`DELETE FROM ward_staffs WHERE ward = ${ward}`;
            }
            await sql`INSERT INTO ward_staffs ${sql(values, 'staff_id', 'ward')}`;
        });

        return {
            success: true,
            message: `ปรับปรุงข้อมูลเรียบร้อยแล้ว จำนวน ${payload.length} รายการ`
        };
    } catch (error) {
        console.error('Add ward staffs error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

export const getAllStaff = async ({ set }: Context) => {
    try {
        const rows = await nurse`
            SELECT a.staff_id, a.fullname, sp.position_name
            FROM staffs a
            LEFT JOIN staff_position sp ON sp.staff_position_id = a.staff_position_id
            WHERE a.is_active = 'Y'
            ORDER BY a.fullname ASC
        `;
        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                fullname: sanitizeHTML(row.fullname)
            }))
        };
    } catch (error) {
        console.error('Get all staff error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

