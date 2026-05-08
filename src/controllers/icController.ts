import { Context } from 'elysia';
import { his } from '../db';
import { RowDataPacket } from 'mysql2';
import { sanitizeHTML } from '../utils/sanitize';

// ฟังก์ชันสำหรับดึงประวัติผู้ป่วยติดเชื้อดื้อยา
export const getIpdPatientHistoryDaily = async ({ body, set }: Context) => {
    try {
        const sql = `
            SELECT 
                a.an,
                a.hn,
                CONCAT(b.pname, b.fname, ' ', b.lname) AS ptname,
                c.bedno,
                d.name AS incdoctor,
                w.name AS wname,
                DATEDIFF(CURDATE(), a.regdate) + 1 AS ds,
                -- CRE
                cre_data.ResultValue AS cre,
                cre_data.ConfirmDate AS cre_date,
                cre_data.Hospital_LabNumber AS cre_labno,
                -- VRE
                vre_data.ResultValue AS vre,
                vre_data.ConfirmDate AS vre_date,
                vre_data.Hospital_LabNumber AS vre_labno,
                -- MRSA
                mrsa_data.ResultValue AS mrsa,
                mrsa_data.ConfirmDate AS mrsa_date,
                mrsa_data.Hospital_LabNumber AS mrsa_labno,
                -- ESCR
                escr_data.ResultValue AS escr,
                escr_data.ConfirmDate AS escr_date,
                escr_data.Hospital_LabNumber AS escr_labno,
                -- MDR
                mdr_data.ResultValue AS mdr,
                mdr_data.ConfirmDate AS mdr_date,
                mdr_data.Hospital_LabNumber AS mdr_labno
            FROM 
                ipt a
            LEFT JOIN 
                patient b ON b.hn = a.hn
            LEFT JOIN 
                iptadm c ON c.an = a.an
            LEFT JOIN 
                doctor d ON d.code = a.incharge_doctor
            LEFT JOIN 
                ward w ON w.ward = a.ward
            -- CRE Join
            LEFT JOIN (
                SELECT 
                    hn, 
                    ResultValue, 
                    ConfirmDate, 
                    Hospital_LabNumber,
                    ROW_NUMBER() OVER (PARTITION BY hn ORDER BY ConfirmDate DESC) AS rn
                FROM 
                    t_interface_result_bacteria
                WHERE 
                    ResultValue LIKE '%cre%' 
                    AND ConfirmDate >= DATE_ADD(CURDATE(), INTERVAL -90 DAY)
            ) cre_data ON cre_data.hn = a.hn AND cre_data.rn = 1
            -- VRE Join
            LEFT JOIN (
                SELECT 
                    hn, 
                    ResultValue, 
                    ConfirmDate, 
                    Hospital_LabNumber,
                    ROW_NUMBER() OVER (PARTITION BY hn ORDER BY ConfirmDate DESC) AS rn
                FROM 
                    t_interface_result_bacteria
                WHERE 
                    ResultValue LIKE '%vre%' 
                    AND ConfirmDate >= DATE_ADD(CURDATE(), INTERVAL -90 DAY)
            ) vre_data ON vre_data.hn = a.hn AND vre_data.rn = 1
            -- MRSA Join
            LEFT JOIN (
                SELECT 
                    hn, 
                    ResultValue, 
                    ConfirmDate, 
                    Hospital_LabNumber,
                    ROW_NUMBER() OVER (PARTITION BY hn ORDER BY ConfirmDate DESC) AS rn
                FROM 
                    t_interface_result_bacteria
                WHERE 
                    ResultValue LIKE '%mrsa%' 
                    AND ConfirmDate >= DATE_ADD(CURDATE(), INTERVAL -90 DAY)
            ) mrsa_data ON mrsa_data.hn = a.hn AND mrsa_data.rn = 1
            -- ESCR Join
            LEFT JOIN (
                SELECT 
                    hn, 
                    ResultValue, 
                    ConfirmDate, 
                    Hospital_LabNumber,
                    ROW_NUMBER() OVER (PARTITION BY hn ORDER BY ConfirmDate DESC) AS rn
                FROM 
                    t_interface_result_bacteria
                WHERE 
                    ResultValue LIKE '%escr%' 
                    AND ConfirmDate >= DATE_ADD(CURDATE(), INTERVAL -90 DAY)
            ) escr_data ON escr_data.hn = a.hn AND escr_data.rn = 1
            -- MDR Join
            LEFT JOIN (
                SELECT 
                    hn, 
                    ResultValue, 
                    ConfirmDate, 
                    Hospital_LabNumber,
                    ROW_NUMBER() OVER (PARTITION BY hn ORDER BY ConfirmDate DESC) AS rn
                FROM 
                    t_interface_result_bacteria
                WHERE 
                    ResultValue LIKE '%mdr%' 
                    AND ConfirmDate >= DATE_ADD(CURDATE(), INTERVAL -90 DAY)
            ) mdr_data ON mdr_data.hn = a.hn AND mdr_data.rn = 1
            WHERE 
                a.dchtype IS NULL
                AND (cre_data.ResultValue IS NOT NULL 
                     OR vre_data.ResultValue IS NOT NULL 
                     OR mrsa_data.ResultValue IS NOT NULL 
                     OR escr_data.ResultValue IS NOT NULL 
                     OR mdr_data.ResultValue IS NOT NULL)
            ORDER BY 
                a.ward ASC, c.bedno ASC
        `;

        const [rows] = await his.execute<RowDataPacket[]>(sql);

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                ptname: sanitizeHTML(row.ptname),
                incdoctor: sanitizeHTML(row.incdoctor),
                wname: sanitizeHTML(row.wname)
            }))
        };
    } catch (error) {
        console.error('Get ipd patient history daily error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลรายละเอียด Lab (RTF) ตาม lab_order_number
export const getLabno = async ({ params, set }: Context) => {
    const { id } = params as { id: string };

    try {
        const sql = `SELECT lab_order_number, result_rtf FROM lab_head WHERE lab_order_number = ?`;
        const [rows] = await his.execute<RowDataPacket[]>(sql, [id]);

        return {
            success: true,
            data: rows
        };
    } catch (error) {
        console.error('Get labno error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลการติดตามผู้ป่วยหลังผ่าตัด (Operation Followup)
export const operationFollowup = async ({ body, set }: Context) => {
    const { date1, date2 } = body as { date1: string; date2: string };

    try {
        const sql = `
            WITH OPD_Ops AS (
                SELECT
                    hn,
                    MIN(operation_date) AS opd_operation_date,
                    SUBSTRING_INDEX(GROUP_CONCAT(operation_name ORDER BY operation_date ASC), ',', 1) AS opd_operation_name
                FROM operation_list
                WHERE patient_department = 'OPD'
                GROUP BY hn
            ),
            IPD_Ops AS (
                SELECT
                    hn,
                    MIN(operation_date) AS ipd_operation_date,
                    SUBSTRING_INDEX(GROUP_CONCAT(operation_name ORDER BY operation_date ASC), ',', 1) AS ipd_operation_name
                FROM operation_list
                WHERE patient_department = 'IPD'
                GROUP BY hn
            )
            SELECT
                CONCAT(c.pname, c.fname, " ", c.lname) AS ptname,
                b.hn,
                a.icd10,
                a.diagtype,
                d.cc,
                b.vstdate,
                OPD_Ops.opd_operation_date AS opd_operation,
                OPD_Ops.opd_operation_name AS opd_operation_name,
                DATEDIFF(b.vstdate, OPD_Ops.opd_operation_date) AS dd,
                IPD_Ops.ipd_operation_date AS ipd_operation,
                IPD_Ops.ipd_operation_name AS ipd_operation_name,
                DATEDIFF(b.vstdate, IPD_Ops.ipd_operation_date) AS dd1,
                a.vn
            FROM ovstdiag a
            LEFT JOIN ovst b ON b.vn = a.vn
            LEFT JOIN patient c ON c.hn = b.hn
            LEFT JOIN opdscreen d ON d.vn = a.vn
            LEFT JOIN OPD_Ops ON b.hn = OPD_Ops.hn
            LEFT JOIN IPD_Ops ON b.hn = IPD_Ops.hn
            WHERE a.icd10 IN ('t814', 'a499')
              AND b.vstdate BETWEEN ? AND ?
              AND (DATEDIFF(b.vstdate, OPD_Ops.opd_operation_date) <= 45 OR DATEDIFF(b.vstdate, IPD_Ops.ipd_operation_date) <= 45);
        `;

        const [rows] = await his.execute<RowDataPacket[]>(sql, [date1, date2]);

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                ptname: row.ptname ? sanitizeHTML(row.ptname) : null,
                cc: row.cc ? sanitizeHTML(row.cc) : null,
                opd_operation_name: row.opd_operation_name ? sanitizeHTML(row.opd_operation_name) : null,
                ipd_operation_name: row.ipd_operation_name ? sanitizeHTML(row.ipd_operation_name) : null
            }))
        };
    } catch (error) {
        console.error('Get operation followup error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลสรุปจำนวนผู้ป่วยติดเชื้อดื้อยาแยกตามแผนกในปีงบประมาณปัจจุบัน
export const getResultDepInFiscalYear = async ({ set }: Context) => {
    try {
        const sql = `
            SELECT 
                c.department, 
                COUNT(*) AS cc
            FROM t_interface_result_bacteria a
            LEFT OUTER JOIN lab_head b ON b.lab_order_number = a.Hospital_LabNumber
            LEFT OUTER JOIN kskdepartment c ON c.depcode = b.order_department
            WHERE a.ResultName LIKE 'or%'
              AND (
                a.ResultValue LIKE '%MDR%' OR 
                a.ResultValue LIKE '%CRE%' OR 
                a.ResultValue LIKE '%ESCR%' OR 
                a.ResultValue LIKE '%VRE%' OR 
                a.ResultValue LIKE '%MRSA%'
              )
              AND c.department IS NOT NULL
              -- กรองตามปีงบประมาณไทย (เริ่ม 1 ต.ค. ของปีงบประมาณนั้น)
              AND a.ConfirmDate BETWEEN 
                (CASE 
                    WHEN MONTH(CURDATE()) >= 10 THEN CONCAT(YEAR(CURDATE()), '-10-01')
                    ELSE CONCAT(YEAR(CURDATE()) - 1, '-10-01')
                END)
                AND CURDATE()
            GROUP BY c.department
            ORDER BY cc DESC;
        `;

        const [rows] = await his.execute<RowDataPacket[]>(sql);

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                department: row.department ? sanitizeHTML(row.department) : null
            }))
        };
    } catch (error) {
        console.error('Get result dep in fiscal year error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลสรุปจำนวนผู้ป่วยติดเชื้อดื้อยาในปีงบประมาณปัจจุบัน
export const getResultInFiscalYear = async ({ set }: Context) => {
    try {
        const sql = `
            SELECT
                x.ResultValue,
                COUNT(*) AS cc,
                x.fiscal_month_order,
                x.monthName
            FROM (
                SELECT
                    a.ResultValue,
                    a.ConfirmDate,
                    b.order_date,
                    -- Fiscal month order for correct sorting: Oct=1, Nov=2, ..., Sep=12
                    CASE
                        WHEN MONTH(b.order_date) >= 10 THEN MONTH(b.order_date) - 9
                        ELSE MONTH(b.order_date) + 3
                    END AS fiscal_month_order,
                    MONTHNAME(b.order_date) AS monthName
                FROM
                    t_interface_result_bacteria a
                LEFT OUTER JOIN lab_head b ON b.lab_order_number = a.Hospital_LabNumber
                LEFT OUTER JOIN kskdepartment c ON c.depcode = b.order_department
                WHERE
                    a.ResultName LIKE 'or%'
                    AND (a.ResultValue LIKE '%MDR%' OR a.ResultValue LIKE '%CRE%' OR a.ResultValue LIKE '%ESCR%' OR a.ResultValue LIKE '%VRE%' OR a.ResultValue LIKE '%MRSA%' OR a.ResultValue LIKE '%CRE,ESCR%')
                    -- Dynamic date filter for current Thai Fiscal Year based on ConfirmDate
                    AND a.ConfirmDate BETWEEN 
                        -- Start Date: Oct 1st of the previous calendar year if current month < 10, else current calendar year
                        DATE_FORMAT(IF(MONTH(CURDATE()) >= 10, CURDATE(), DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), '%Y-10-01')
                        AND 
                        -- End Date: Sep 30th of the current calendar year if current month < 10, else next calendar year
                        DATE_FORMAT(IF(MONTH(CURDATE()) >= 10, DATE_ADD(CURDATE(), INTERVAL 1 YEAR), CURDATE()), '%Y-09-30')
            ) AS x
            GROUP BY
                x.ResultValue, x.fiscal_month_order, x.monthName
            ORDER BY
                x.fiscal_month_order asc, x.ResultValue;
        `;

        const [rows] = await his.execute<RowDataPacket[]>(sql);

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                ResultValue: row.ResultValue ? sanitizeHTML(row.ResultValue) : null,
                monthName: row.monthName ? sanitizeHTML(row.monthName) : null
            }))
        };
    } catch (error) {
        console.error('Get result in fiscal year error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับดึงประวัติผู้ป่วยนอก (OPD) ติดเชื้อดื้อยา
export const getOpdPatientHistoryDaily = async ({ set }: Context) => {
    try {
        const sql = `
            SELECT * FROM (
                SELECT 
                    a.vn,
                    a.hn,
                    a.vstdate,
                    CONCAT(b.pname, b.fname, ' ', b.lname) AS ptname,
                    a.main_dep,
                    c.department,
                    d.name AS spcname,
                    a.spclty,
                    hometel,
                    informtel,
                    worktel,
                    (SELECT t1.ResultValue FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%cre%' LIMIT 1) AS cre,
                    (SELECT t1.ConfirmDate FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%cre%' LIMIT 1) AS cre_date,
                    (SELECT t1.Hospital_LabNumber FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%cre%' LIMIT 1) AS labno_cre,
                    (SELECT t1.ResultValue FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%vre%' LIMIT 1) AS vre,
                    (SELECT t1.ConfirmDate FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%vre%' LIMIT 1) AS vre_date,
                    (SELECT t1.Hospital_LabNumber FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%vre%' LIMIT 1) AS labno_vre,
                    (SELECT t1.ResultValue FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%mrsa%' LIMIT 1) AS mrsa,
                    (SELECT t1.ConfirmDate FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%mrsa%' LIMIT 1) AS mrsa_date,
                    (SELECT t1.Hospital_LabNumber FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%mrsa%' LIMIT 1) AS labno_mrsa,
                    (SELECT t1.ResultValue FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%escr%' LIMIT 1) AS escr,
                    (SELECT t1.ConfirmDate FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%escr%' LIMIT 1) AS escr_date,
                    (SELECT t1.Hospital_LabNumber FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%escr%' LIMIT 1) AS labno_escr,
                    (SELECT t1.ResultValue FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%mdr%' LIMIT 1) AS mdr,
                    (SELECT t1.ConfirmDate FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%mdr%' LIMIT 1) AS mdr_date,
                    (SELECT t1.Hospital_LabNumber FROM t_interface_result_bacteria t1 WHERE t1.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t1.hn = a.hn AND t1.ResultValue LIKE '%mdr%' LIMIT 1) AS labno_mdr
                FROM ovst a  
                LEFT JOIN patient b ON b.hn = a.hn
                LEFT JOIN kskdepartment c ON c.depcode = a.main_dep
                LEFT JOIN spclty d ON d.spclty = a.spclty
                WHERE a.vstdate = CURDATE()
                AND a.hn IN (SELECT t.HN FROM t_interface_result_bacteria t WHERE t.ConfirmDate >= DATE_ADD(a.vstdate, INTERVAL -90 DAY) AND t.hn = a.hn)
                ORDER BY a.vstdate, a.main_dep ASC
            ) AS x 
            WHERE (x.cre <> '' OR x.vre <> '' OR x.mrsa <> '' OR x.escr <> '' OR x.mdr <> '')
        `;

        const [rows] = await his.execute<RowDataPacket[]>(sql);

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                ptname: sanitizeHTML(row.ptname),
                department: sanitizeHTML(row.department),
                spcname: sanitizeHTML(row.spcname),
                // ตรวจสอบและจัดการ null ให้เป็น string เปล่าก่อน Sanitize เพื่อความปลอดภัย
                hometel: row.hometel ? sanitizeHTML(row.hometel) : null,
                informtel: row.informtel ? sanitizeHTML(row.informtel) : null,
                worktel: row.worktel ? sanitizeHTML(row.worktel) : null
            }))
        };
    } catch (error) {
        console.error('Get opd patient history daily error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};