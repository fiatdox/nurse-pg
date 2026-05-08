import { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';

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

        // จัดกลุ่ม base codes ที่ส่งมาแต่ละ (staff_id, shift_date, ward)
        // เพื่อลบ record ที่ไม่ได้ส่งมาใน scope นั้น
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
                      AND ward = ${ward}
                      AND NOT (shift_code = ANY(${baseCodes}) OR shift_code LIKE ANY(${likePatterns}))
                `;
            }

            for (const s of schedules) {
                // base shift = ส่วนก่อน '_' เช่น A_OT → A, N_OT4 → N, M → M
                const baseCode = s.shift_code.split('_')[0];
                const likePattern = `${baseCode}\\_%`;

                const existing = await sql`
                    SELECT shift_assignment_id FROM nurse_shift_assignments
                    WHERE staff_id = ${s.staff_id}
                      AND shift_date = ${s.shift_date}
                      AND ward = ${s.ward}
                      AND (shift_code = ${baseCode} OR shift_code LIKE ${likePattern})
                    LIMIT 1
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
                WHERE sa.ward = ${ward}
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
                WHERE sa.ward = ${ward}
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

// ฟังก์ชันสำหรับคำนวณ FTE ตาม ward และเดือน
export const getFTEByWard = async ({ body, set }: { body: { ward: string, month: string }, set: any }) => {
    const { ward, month } = body;

    if (!ward || !month) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward และ month (รูปแบบ YYYY-MM)' };
    }

    try {
        const rows = await nurse`
            WITH date_series AS (
                SELECT generate_series(
                    DATE_TRUNC('month', (${month} || '-01')::date),
                    DATE_TRUNC('month', (${month} || '-01')::date) + INTERVAL '1 month' - INTERVAL '1 day',
                    INTERVAL '1 day'
                )::date AS record_date
            ),
            shift_series AS (
                SELECT admission_change_shift_type_id, shift_name, weight
                FROM admission_change_shift_types
            ),
            ward_info AS (
                SELECT his_code, general, crisis
                FROM ward
                WHERE his_code = ${ward}
            ),
            base AS (
                SELECT
                    ds.record_date,
                    ss.admission_change_shift_type_id AS shift_type_id,
                    ss.shift_name,
                    ss.weight,
                    wi.general AS general_score,
                    wi.crisis  AS crisis_score,
                    COUNT(a.admission_shift_daily_record) AS total,
                    COUNT(CASE WHEN a.admission_shift_care_level_id = 1 THEN 1 END) AS Normal,
                    COUNT(CASE WHEN a.admission_shift_care_level_id = 2 THEN 1 END) AS O2,
                    COUNT(CASE WHEN a.admission_shift_care_level_id = 3 THEN 1 END) AS HFNC,
                    COUNT(CASE WHEN a.admission_shift_care_level_id = 4 THEN 1 END) AS Vent_CS,
                    COUNT(CASE WHEN a.severity_level_id = 1 THEN 1 END) AS severity_level_1,
                    COUNT(CASE WHEN a.severity_level_id = 2 THEN 1 END) AS severity_level_2,
                    COUNT(CASE WHEN a.severity_level_id = 3 THEN 1 END) AS severity_level_3,
                    COUNT(CASE WHEN a.severity_level_id = 4 THEN 1 END) AS severity_level_4,
                    COUNT(CASE WHEN a.severity_level_id = 5 THEN 1 END) AS severity_level_5
                FROM date_series ds
                CROSS JOIN shift_series ss
                CROSS JOIN ward_info wi
                LEFT JOIN public.admission_shift_daily_record a
                    ON a.record_date = ds.record_date
                    AND a.shift_type_id = ss.admission_change_shift_type_id
                LEFT JOIN admission_list al
                    ON al.admission_list_id = a.admission_list_id
                WHERE al.ward = ${ward} OR al.ward IS NULL
                GROUP BY ds.record_date, ss.admission_change_shift_type_id, ss.shift_name, ss.weight,
                         wi.general, wi.crisis
            ),
            scored AS (
                SELECT *,
                    (general_score * (Normal + O2 + HFNC)) AS normal_sum_score,
                    (crisis_score  * Vent_CS)               AS vent_sum_score
                FROM base
            ),
            total_scored AS (
                SELECT *,
                    normal_sum_score + vent_sum_score AS total_score
                FROM scored
            ),
            nurse_counts AS (
                SELECT
                    a.shift_date,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 1 THEN 1 END) AS RN_A,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 2 THEN 1 END) AS RN_A_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 3 THEN 1 END) AS RN_A_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 1 THEN 1 END) AS RT_A,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 2 THEN 1 END) AS RT_A_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 3 THEN 1 END) AS RT_A_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 1 THEN 1 END) AS PN_A,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 2 THEN 1 END) AS PN_A_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 3 THEN 1 END) AS PN_A_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 4 THEN 1 END) AS RN_M,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 5 THEN 1 END) AS RN_M_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 6 THEN 1 END) AS RN_M_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 4 THEN 1 END) AS RT_M,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 5 THEN 1 END) AS RT_M_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 6 THEN 1 END) AS RT_M_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 4 THEN 1 END) AS PN_M,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 5 THEN 1 END) AS PN_M_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 6 THEN 1 END) AS PN_M_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 7 THEN 1 END) AS RN_N,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 8 THEN 1 END) AS RN_N_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 1 AND a.nurse_shift_type_id = 9 THEN 1 END) AS RN_N_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 7 THEN 1 END) AS RT_N,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 8 THEN 1 END) AS RT_N_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 2 AND a.nurse_shift_type_id = 9 THEN 1 END) AS RT_N_OT4,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 7 THEN 1 END) AS PN_N,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 8 THEN 1 END) AS PN_N_OT8,
                    COUNT(CASE WHEN b.staff_position_id = 3 AND a.nurse_shift_type_id = 9 THEN 1 END) AS PN_N_OT4
                FROM nurse_shift_assignments a
                LEFT JOIN public.staffs b ON b.staff_id = a.staff_id
                WHERE a.ward = ${ward}
                  AND a.shift_date BETWEEN
                      DATE_TRUNC('month', (${month} || '-01')::date)
                      AND DATE_TRUNC('month', (${month} || '-01')::date) + INTERVAL '1 month' - INTERVAL '1 day'
                GROUP BY a.shift_date
            )
            SELECT
                ts.*,
                ROUND((ts.total_score * (ts.weight / 100.0)) / 7.0, 2) AS final_score,
                COALESCE(nc.RN_A,     0) AS RN_A,
                COALESCE(nc.RN_A_OT8, 0) AS RN_A_OT8,
                COALESCE(nc.RN_A_OT4, 0) AS RN_A_OT4,
                COALESCE(nc.RT_A,     0) AS RT_A,
                COALESCE(nc.RT_A_OT8, 0) AS RT_A_OT8,
                COALESCE(nc.RT_A_OT4, 0) AS RT_A_OT4,
                COALESCE(nc.PN_A,     0) AS PN_A,
                COALESCE(nc.PN_A_OT8, 0) AS PN_A_OT8,
                COALESCE(nc.PN_A_OT4, 0) AS PN_A_OT4,
                COALESCE(nc.RN_M,     0) AS RN_M,
                COALESCE(nc.RN_M_OT8, 0) AS RN_M_OT8,
                COALESCE(nc.RN_M_OT4, 0) AS RN_M_OT4,
                COALESCE(nc.RT_M,     0) AS RT_M,
                COALESCE(nc.RT_M_OT8, 0) AS RT_M_OT8,
                COALESCE(nc.RT_M_OT4, 0) AS RT_M_OT4,
                COALESCE(nc.PN_M,     0) AS PN_M,
                COALESCE(nc.PN_M_OT8, 0) AS PN_M_OT8,
                COALESCE(nc.PN_M_OT4, 0) AS PN_M_OT4,
                COALESCE(nc.RN_N,     0) AS RN_N,
                COALESCE(nc.RN_N_OT8, 0) AS RN_N_OT8,
                COALESCE(nc.RN_N_OT4, 0) AS RN_N_OT4,
                COALESCE(nc.RT_N,     0) AS RT_N,
                COALESCE(nc.RT_N_OT8, 0) AS RT_N_OT8,
                COALESCE(nc.RT_N_OT4, 0) AS RT_N_OT4,
                COALESCE(nc.PN_N,     0) AS PN_N,
                COALESCE(nc.PN_N_OT8, 0) AS PN_N_OT8,
                COALESCE(nc.PN_N_OT4, 0) AS PN_N_OT4
            FROM total_scored ts
            LEFT JOIN nurse_counts nc ON nc.shift_date = ts.record_date
            ORDER BY ts.record_date ASC, ts.shift_type_id ASC
        `;

        return { success: true, data: rows };
    } catch (error) {
        console.error('Get FTE by ward error:', error);
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
                WHERE sa.ward = ${ward} AND TO_CHAR(sa.shift_date, 'YYYY-MM') = ${date}
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
                WHERE sa.ward = ${ward} AND sa.shift_date = ${date}
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
