import { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { wardGroupOf } from '../utils/wardGroup';

/**
 * รหัส HIS ของทุกหอในหน่วยเดียวกัน — หน่วยที่รวมหลายหอ (เช่น Nursery + NICU) ใช้ตารางเวรชุดเดียว
 * จัดที่หอหลัก แต่เวรเก่าที่เคยลงไว้ที่หอรองต้องเห็นและแก้ได้จากที่เดียวกัน ไม่งั้นนับซ้ำโดยไม่มีใครรู้
 */
const unitCodes = async (ward: string) => (await wardGroupOf(ward))?.codes ?? [ward];

// ฟังก์ชั่นบันทึกตารางพยาบาลและเจ้าหน้าที่
export const addNurseSchedule = async ({ body, set }: Context) => {
    const schedules = body as any[];

    if (!Array.isArray(schedules) || schedules.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบข้อมูลตารางการทำงานที่ต้องการบันทึก' };
    }

    try {
        let inserted = 0;
        let updated = 0;

        const codesOf = new Map<string, string[]>();
        for (const w of new Set(schedules.map(s => String(s.ward)))) codesOf.set(w, await unitCodes(w));

        // จัดกลุ่ม base codes ที่ส่งมาแต่ละ (staff_id, shift_date, ward)
        // เพื่อลบ record ที่ไม่ได้ส่งมาใน scope นั้น — scope ครอบทุกหอในหน่วย
        const scopeMap = new Map<string, string[]>();
        for (const s of schedules) {
            const baseCode = s.shift_code.split('_')[0];
            const key = `${s.staff_id}|${s.shift_date}|${s.ward}`;
            if (!scopeMap.has(key)) scopeMap.set(key, []);
            const bases = scopeMap.get(key)!;
            if (!bases.includes(baseCode)) bases.push(baseCode);
        }

        await nurse.begin(async sql => {
            for (const [key, baseCodes] of scopeMap) {
                const [staffId, shiftDate, ward] = key.split('|');
                const likePatterns = baseCodes.map(b => `${b}\\_%`);
                // ลบ record ที่ base code ไม่อยู่ใน payload
                await sql`
                    DELETE FROM nurse_shift_assignments
                    WHERE staff_id = ${staffId}
                      AND shift_date = ${shiftDate}
                      AND ward IN ${sql(codesOf.get(ward)!)}
                      AND NOT (shift_code = ANY(${baseCodes}) OR shift_code LIKE ANY(${likePatterns}))
                `;
            }

            for (const s of schedules) {
                // base shift = ส่วนก่อน '_' เช่น A_OT → A, N_OT4 → N, M → M
                const baseCode = s.shift_code.split('_')[0];
                const likePattern = `${baseCode}\\_%`;

                // แถวของหอที่ส่งมาก่อน แล้วค่อยแถวที่ค้างอยู่ที่หออื่นในหน่วย
                const existing = await sql`
                    SELECT shift_assignment_id, ward FROM nurse_shift_assignments
                    WHERE staff_id = ${s.staff_id}
                      AND shift_date = ${s.shift_date}
                      AND ward IN ${sql(codesOf.get(String(s.ward))!)}
                      AND (shift_code = ${baseCode} OR shift_code LIKE ${likePattern})
                    ORDER BY (ward = ${s.ward}) DESC, shift_assignment_id
                `;

                if (existing.length > 0) {
                    await sql`
                        UPDATE nurse_shift_assignments SET
                            shift_code = ${s.shift_code},
                            nurse_shift_type_id = ${s.nurse_shift_type_id ?? null},
                            updated_at = NOW(),
                            updated_by = ${s.updated_by || s.created_by || null}
                        WHERE shift_assignment_id = ${existing[0].shift_assignment_id}
                    `;
                    // เวรเดียวกันของคนเดียวกันที่ลงไว้อีกหอในหน่วย = ขึ้นเวรเดียวแต่ถูกนับสองครั้ง
                    const stray = existing.slice(1).filter(r => r.ward !== s.ward).map(r => r.shift_assignment_id);
                    if (stray.length > 0) {
                        await sql`DELETE FROM nurse_shift_assignments WHERE shift_assignment_id IN ${sql(stray)}`;
                    }
                    updated++;
                } else {
                    await sql`
                        INSERT INTO nurse_shift_assignments
                            (staff_id, shift_date, shift_code, ward, nurse_shift_type_id, created_at, created_by)
                        VALUES
                            (${s.staff_id}, ${s.shift_date}, ${s.shift_code}, ${s.ward}, ${s.nurse_shift_type_id ?? null}, NOW(), ${s.created_by || s.updated_by || null})
                    `;
                    inserted++;
                }
            }
        });

        return {
            success: true,
            message: `บันทึกเรียบร้อยแล้ว (เพิ่มใหม่ ${inserted} รายการ, อัพเดท ${updated} รายการ)`
        };
    } catch (error) {
        console.error('Error saving nurse schedule:', error);
        set.status = 500;
        return {
            success: false,
            message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล',
            error: String(error)
        };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลตารางเวรตาม ward, shift_date และ staff_id
export const getNurseScheduleDetail = async ({ body, set }: Context) => {
    const { ward, shift_date, staff_id, shift_code } = body as { ward: string, shift_date: string, staff_id: number, shift_code?: string };

    if (!ward || !shift_date || !staff_id) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, shift_date และ staff_id ให้ครบถ้วน' };
    }

    try {
        const codes = await unitCodes(ward);
        const rows = shift_code
            ? await nurse`
                SELECT
                    sa.shift_assignment_id,
                    sa.staff_id,
                    s.fullname,
                    sa.shift_date,
                    sa.shift_code,
                    sa.ward,
                    sa.created_at,
                    sa.created_by,
                    sa.updated_at,
                    sa.updated_by
                FROM nurse_shift_assignments sa
                LEFT JOIN staffs s ON sa.staff_id = s.staff_id
                WHERE sa.ward IN ${nurse(codes)}
                  AND sa.shift_date = ${shift_date}
                  AND sa.staff_id = ${staff_id}
                  AND sa.shift_code = ${shift_code}
            `
            : await nurse`
                SELECT
                    sa.shift_assignment_id,
                    sa.staff_id,
                    s.fullname,
                    sa.shift_date,
                    sa.shift_code,
                    sa.ward,
                    sa.created_at,
                    sa.created_by,
                    sa.updated_at,
                    sa.updated_by
                FROM nurse_shift_assignments sa
                LEFT JOIN staffs s ON sa.staff_id = s.staff_id
                WHERE sa.ward IN ${nurse(codes)}
                  AND sa.shift_date = ${shift_date}
                  AND sa.staff_id = ${staff_id}
            `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                fullname: row.fullname ? sanitizeHTML(row.fullname) : null
            }))
        };
    } catch (error) {
        console.error('Get nurse schedule detail error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับลบตารางเวรบางรายการ (รับ id เป็น Array)
export const deleteNurseSchedule = async ({ body, set }: Context) => {
    const schedules = body as any[];

    if (!Array.isArray(schedules) || schedules.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบรายการที่ต้องการลบ' };
    }

    try {
        // รองรับทั้งการส่ง Array ของ Object [{ shift_assignment_id: 1 }] หรือ Array ของ Number [1, 2]
        const ids = schedules.map(s => typeof s === 'object' ? s.shift_assignment_id : s);

        const result = await nurse`
            DELETE FROM nurse_shift_assignments WHERE shift_assignment_id IN ${nurse(ids)}
        `;

        return {
            success: true,
            message: `ลบตารางเวรเรียบร้อยแล้ว จำนวน ${result.count} รายการ`
        };
    } catch (error) {
        console.error('Delete nurse schedule error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลตารางเวรของพยาบาลตาม ward และเดือน
export const getNurseSchedule = async ({ query, set }: Context) => {
    // รับค่า ward และ month ผ่าน Query String (เช่น ?ward=00&month=2026-03)
    const { ward, month } = query as Record<string, string>;

    if (!ward || !month) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward และ month (รูปแบบ YYYY-MM เช่น 2026-03)' };
    }

    try {
        const rows = await nurse`
            SELECT
                sa.shift_assignment_id,
                sa.staff_id,
                s.fullname,
                sa.shift_date,
                sa.shift_code,
                sa.ward
            FROM nurse_shift_assignments sa
            LEFT JOIN staffs s ON sa.staff_id = s.staff_id
            WHERE sa.ward = ${ward} AND TO_CHAR(sa.shift_date, 'YYYY-MM') = ${month}
            ORDER BY sa.shift_date ASC, sa.staff_id ASC
        `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                fullname: row.fullname ? sanitizeHTML(row.fullname) : null
            }))
        };
    } catch (error) {
        console.error('Get nurse schedule error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงประเภทเวรของเจ้าหน้าที่ เรียงตาม display_order
export const getNurseShiftTypes = async ({ set }: Context) => {
    try {
        const rows = await nurse`
            SELECT nurse_shift_type_id, code, name, admission_change_shift_type_id, display_order, description
            FROM nurse_shift_types
            ORDER BY display_order ASC
        `;

        return { success: true, data: rows };
    } catch (error) {
        console.error('Get nurse shift types error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลตารางเวรตาม ward และ date (รองรับทั้ง YYYY-MM และ YYYY-MM-DD)
export const getNurseScheduleByDate = async ({ body, set }: Context) => {
    const { ward, date } = body as { ward: string, date: string };

    if (!ward || !date) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward และ date' };
    }

    try {
        // ตรวจสอบว่าส่งมาแค่เดือน (ยาว 7 ตัว เช่น 2026-03) หรือส่งมาเต็มวัน (ยาว 10 ตัว เช่น 2026-03-01)
        const isMonthOnly = date.length === 7;
        const codes = await unitCodes(ward);

        const rows = isMonthOnly
            ? await nurse`
                SELECT
                    sa.shift_assignment_id,
                    sa.staff_id,
                    s.fullname,
                    sa.shift_date,
                    sa.shift_code,
                    sa.ward
                FROM nurse_shift_assignments sa
                LEFT JOIN staffs s ON sa.staff_id = s.staff_id
                WHERE sa.ward IN ${nurse(codes)} AND TO_CHAR(sa.shift_date, 'YYYY-MM') = ${date}
                ORDER BY sa.shift_date ASC, sa.shift_code ASC, sa.staff_id ASC
            `
            : await nurse`
                SELECT
                    sa.shift_assignment_id,
                    sa.staff_id,
                    s.fullname,
                    sa.shift_date,
                    sa.shift_code,
                    sa.ward
                FROM nurse_shift_assignments sa
                LEFT JOIN staffs s ON sa.staff_id = s.staff_id
                WHERE sa.ward IN ${nurse(codes)} AND sa.shift_date = ${date}
                ORDER BY sa.shift_date ASC, sa.shift_code ASC, sa.staff_id ASC
            `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                fullname: row.fullname ? sanitizeHTML(row.fullname) : null
            }))
        };
    } catch (error) {
        console.error('Get nurse schedule by date error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * สรุปจำนวนบุคลากรที่ขึ้นเวร แยกตามตำแหน่ง สำหรับหอผู้ป่วยและวันที่ที่เลือก
 *
 * ใช้คู่กับ FTE ในหน้ารายงานประจำวัน — FTE บอกว่า "ควรมีกี่คน" ตามภาระงาน
 * ส่วนตัวเลขนี้บอกว่า "มีจริงกี่คน" หัวหน้าเวรจึงเห็นส่วนต่างได้ทันทีในหน้าเดียว
 *
 * นับหัวคนไม่ใช่นับเวร เพราะคนหนึ่งลงได้ทั้ง M และ M_OT ในวันเดียวกัน
 * (ขึ้นเวรเช้าแล้วอยู่ OT ต่อ) ถ้านับทุกแถวจะกลายเป็นสองคนซึ่งไม่จริง
 * ส่วน OT แยกรายงานไว้ต่างหาก เพราะเป็นสัญญาณว่ากำลังคนปกติไม่พอ
 */
export const getStaffOnDutyByDate = async ({ body, set }: Context) => {
    const { ward, date } = body as { ward: string; date: string };

    if (!ward?.trim() || !date?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward และ date' };
    }

    // แปลง DD/MM/YYYY → YYYY-MM-DD
    const parsedDate = date.includes('/') ? date.split('/').reverse().join('-') : date;

    try {
        // หน่วยที่รวมหลายหอ (เช่น Nursery + NICU) จัดเวรรวมกัน นับคนจากทุกหอในหน่วย
        const codes = await unitCodes(ward);

        const rows = await nurse`
            SELECT
                 nst.admission_change_shift_type_id       AS shift_type_id
                ,acst.shift_name
                ,COALESCE(sp.code, 'OTHER')               AS position_code
                ,COALESCE(sp.position_name, 'ไม่ระบุตำแหน่ง') AS position_name
                ,COUNT(DISTINCT sa.staff_id)::int         AS staff_count
                ,COUNT(DISTINCT sa.staff_id) FILTER (WHERE nst.code LIKE '%\_OT%')::int AS ot_count
            FROM nurse_shift_assignments sa
            JOIN nurse_shift_types nst ON nst.code = sa.shift_code
            JOIN admission_change_shift_types acst
              ON acst.admission_change_shift_type_id = nst.admission_change_shift_type_id
            LEFT JOIN staffs s ON s.staff_id = sa.staff_id
            LEFT JOIN staff_position sp ON sp.staff_position_id = s.staff_position_id
            WHERE sa.ward IN ${nurse(codes)}
              AND sa.shift_date = ${parsedDate}
              -- OFF ผูกกับ shift type 0 ซึ่งไม่ใช่เวรจริง ต้องไม่นับเป็นคนขึ้นเวร
              AND nst.admission_change_shift_type_id > 0
            GROUP BY nst.admission_change_shift_type_id, acst.shift_name, sp.code, sp.position_name
            ORDER BY nst.admission_change_shift_type_id, sp.code
        `;

        return { success: true, data: rows };
    } catch (error) {
        console.error('Get staff on duty by date error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
