import { Context } from 'elysia';
import { nurse } from '../db';
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
        const rows = await nurse`
            SELECT ws.staff_id, ws.ward, s.fullname, sp.position_name
            FROM ward_staffs ws
            JOIN staffs s ON ws.staff_id = s.staff_id
            LEFT JOIN staff_position sp ON s.staff_position_id = sp.staff_position_id
            WHERE ws.ward = ${id} AND s.is_active = 'Y'
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
export const addWardStaffs = async ({ body, set }: Context) => {
    const payload = body as { staff_id: string | number; ward: string | number }[];

    if (!Array.isArray(payload) || payload.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบข้อมูลที่ต้องการบันทึก หรือรูปแบบข้อมูลไม่ถูกต้อง' };
    }

    const uniqueWards = [...new Set(payload.map(item => String(item.ward)))];
    const values = payload.map(item => ({
        staff_id: Number(item.staff_id),
        ward: String(item.ward)
    }));

    try {
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

