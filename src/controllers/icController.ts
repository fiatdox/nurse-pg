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
        /*
          ของเดิมรวมยอด operation_list ทั้งตาราง (201,568 แถว / 97,792 HN) สองรอบ
          รอบละหนึ่งแผนก โดยไม่สนช่วงวันที่ที่ผู้ใช้เลือกเลย เวลาจึงคงที่ 3.3 วินาที
          ไม่ว่าจะขอครึ่งเดือนหรือทั้งปี

          เปลี่ยนเป็นหาใบตรวจที่เข้าเงื่อนไขก่อน แล้วค่อยรวมยอดการผ่าตัด
          เฉพาะ HN ที่โผล่ในชุดนั้น (ราว 400 คน) เหลือสแกนรอบเดียว
        */
        const sql = `
            WITH visits AS (
                SELECT a.vn, a.icd10, a.diagtype, b.hn, b.vstdate
                FROM ovstdiag a
                JOIN ovst b ON b.vn = a.vn
                WHERE a.icd10 IN ('t814', 'a499')
                  AND b.vstdate BETWEEN ? AND ?
            ),
            ops AS (
                SELECT
                    o.hn,
                    o.patient_department AS dept,
                    MIN(o.operation_date) AS op_date,
                    -- ใส่ operation_id เป็นตัวตัดสินตอนผ่าตัดหลายรายการวันเดียวกัน
                    -- ไม่งั้นชื่อที่ได้จะสลับไปมาในแต่ละครั้งที่รัน
                    SUBSTRING_INDEX(
                        GROUP_CONCAT(o.operation_name ORDER BY o.operation_date ASC, o.operation_id ASC), ',', 1
                    ) AS op_name
                FROM operation_list o
                WHERE o.patient_department IN ('OPD', 'IPD')
                  AND o.hn IN (SELECT hn FROM visits)
                GROUP BY o.hn, o.patient_department
            )
            SELECT
                CONCAT(c.pname, c.fname, " ", c.lname) AS ptname,
                v.hn,
                v.icd10,
                v.diagtype,
                d.cc,
                v.vstdate,
                od.op_date AS opd_operation,
                od.op_name AS opd_operation_name,
                DATEDIFF(v.vstdate, od.op_date) AS dd,
                ip.op_date AS ipd_operation,
                ip.op_name AS ipd_operation_name,
                DATEDIFF(v.vstdate, ip.op_date) AS dd1,
                v.vn
            FROM visits v
            LEFT JOIN patient c   ON c.hn = v.hn
            LEFT JOIN opdscreen d ON d.vn = v.vn
            LEFT JOIN ops od      ON od.hn = v.hn AND od.dept = 'OPD'
            LEFT JOIN ops ip      ON ip.hn = v.hn AND ip.dept = 'IPD'
            WHERE (DATEDIFF(v.vstdate, od.op_date) <= 45 OR DATEDIFF(v.vstdate, ip.op_date) <= 45)
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

/**
 * รายชื่อผู้ป่วยที่ตรวจพบเชื้อดื้อยา ตามช่วงวันที่ที่เลือก
 *
 * หนึ่งแถวคือหนึ่งผลเพาะเชื้อ ไม่ใช่หนึ่งคน เพราะผู้ป่วยรายเดียวอาจพบเชื้อหลายชนิด
 * หรือพบซ้ำหลายครั้ง ซึ่งงาน IC ต้องเห็นแยกกันเพื่อไล่ทีละเหตุการณ์
 */
export const getAmrPatientReport = async (
    { body, set }: { body: { date1: string, date2: string }, set: any }
) => {
    const { date1, date2 } = body ?? {};
    const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

    if (!isDate(date1) || !isDate(date2)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }
    if (date1 > date2) {
        set.status = 400;
        return { success: false, message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' };
    }

    // กันช่วงกว้างเกินจนดึงทั้งฐาน รายงานนี้เป็นรายบรรทัด ไม่ใช่ยอดรวม
    const days = Math.floor((Date.parse(date2) - Date.parse(date1)) / 86400000) + 1;
    if (days > 400) {
        set.status = 400;
        return { success: false, message: 'เลือกช่วงได้ไม่เกิน 400 วันต่อครั้ง' };
    }

    try {
        const sql = `
            SELECT
                 -- คีย์แถวสำหรับหน้าจอ ข้อมูลต้นทางมีบางใบที่ interface ส่งซ้ำ
                 -- เลข lab กับชื่อเชื้อจึงไม่พอจะแยกแถว ต้องใช้คีย์หลักของตาราง
                 a.InterfaceResultID                                                      AS id
                ,DATE_FORMAT(a.ConfirmDate, '%Y-%m-%d')                                   AS confirm_date
                ,DATE_FORMAT(b.order_date, '%Y-%m-%d')                                    AS order_date
                ,a.Hospital_LabNumber                                                     AS lab_no
                ,a.HN                                                                     AS hn
                ,CONCAT(IFNULL(p.pname,''), IFNULL(p.fname,''), ' ', IFNULL(p.lname,''))   AS ptname
                ,p.sex                                                                    AS sex
                ,TIMESTAMPDIFF(YEAR, p.birthday, a.ConfirmDate)                           AS age
                /*
                  ผูก AN ด้วยช่วงวันนอน เพราะใบ lab เก็บ vn ไม่ได้เก็บ an ไว้ตรงๆ

                  ใช้คิวรีย่อยที่หยิบมาใบเดียว ไม่ใช่ LEFT JOIN เพราะผู้ป่วยบางรายมีทะเบียน
                  นอนซ้อนกัน (จำหน่ายแล้วรับใหม่วันเดียวกัน) แล้ว join จะแตกผลเพาะเชื้อ
                  หนึ่งครั้งออกเป็นสองบรรทัด ทำให้ยอดในรายงานเกินจริง

                  แปลงชุดอักขระที่ฝั่ง a ซึ่งไม่มีดัชนี ไม่ใช่ปล่อยให้ตัวจัดการแปลงเอง
                  และเทียบ dchdate ด้วย IS NULL แทนการครอบ IFNULL เพราะฟังก์ชันที่ครอบ
                  คอลัมน์จะทำให้ดัชนีของคอลัมน์นั้นใช้ไม่ได้
                */
                ,(SELECT i.an FROM ipt i
                   WHERE i.hn = CONVERT(a.HN USING tis620)
                     AND a.ConfirmDate >= i.regdate
                     AND (i.dchdate IS NULL OR a.ConfirmDate <= i.dchdate)
                   ORDER BY i.regdate DESC LIMIT 1)                                       AS an
                ,(SELECT w.name FROM ipt i JOIN ward w ON w.ward = i.ward
                   WHERE i.hn = CONVERT(a.HN USING tis620)
                     AND a.ConfirmDate >= i.regdate
                     AND (i.dchdate IS NULL OR a.ConfirmDate <= i.dchdate)
                   ORDER BY i.regdate DESC LIMIT 1)                                       AS ward_name
                ,c.department                                                             AS department
                ,a.Specimen                                                               AS specimen
                ,TRIM(SUBSTRING_INDEX(a.ResultValue, '(', 1))                             AS organism
                ,TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(a.ResultValue, '(', -1), ')', 1))   AS resistance
                ,a.ResultValue                                                            AS result_value
            FROM t_interface_result_bacteria a
            LEFT JOIN lab_head b      ON b.lab_order_number = a.Hospital_LabNumber
            LEFT JOIN kskdepartment c ON c.depcode = b.order_department
            /*
              ต้องแปลงชุดอักขระที่ฝั่ง a ซึ่งไม่มีดัชนี ไม่ใช่ปล่อยให้ MariaDB แปลงเอง

              t_interface_result_bacteria.HN เป็น utf8mb3 ส่วน patient.hn กับ ipt.hn เป็น tis620
              ถ้าเขียน p.hn = a.HN เฉยๆ ตัวจัดการจะแปลงคอลัมน์ที่มีดัชนี (tis620) ขึ้นเป็น utf8mb3
              แล้วดัชนีใช้ไม่ได้ กลายเป็นอ่านทั้งตาราง 627,118 แถว
              ของเดิมช่วง 1 เดือนใช้เวลา 22 วินาที พอย้ายฝั่งที่แปลงเหลือ 0.24 วินาที
            */
            LEFT JOIN patient p       ON p.hn = CONVERT(a.HN USING tis620)
            WHERE a.ResultName LIKE 'or%'
              AND a.ResultValue LIKE '%(%)%'
              AND a.ConfirmDate BETWEEN ? AND ?
            ORDER BY a.ConfirmDate DESC, a.Hospital_LabNumber
        `;

        const [rows] = await his.execute<RowDataPacket[]>(sql, [date1, date2]);

        const data = rows.map(row => ({
            id: Number(row.id),
            confirm_date: row.confirm_date,
            order_date: row.order_date,
            lab_no: row.lab_no,
            hn: row.hn,
            ptname: sanitizeHTML(String(row.ptname ?? '').trim()) || null,
            sex: row.sex === '1' ? 'ชาย' : row.sex === '2' ? 'หญิง' : null,
            age: row.age === null ? null : Number(row.age),
            an: row.an ?? null,
            ward_name: row.ward_name ? sanitizeHTML(row.ward_name) : null,
            department: row.department ? sanitizeHTML(cleanDepartment(String(row.department))) : null,
            specimen: row.specimen ? sanitizeHTML(row.specimen) : null,
            organism: sanitizeHTML(String(row.organism ?? '').trim()),
            resistance: sanitizeHTML(String(row.resistance ?? '').trim()),
        }));

        // สรุปหัวรายงาน ให้ตรวจได้ทันทีว่าช่วงที่เลือกมีอะไรบ้าง โดยไม่ต้องไล่นับเอง
        const distinct = <T>(arr: T[]) => new Set(arr.filter(Boolean)).size;
        const byGroup = new Map<string, number>();
        for (const r of data) {
            const g = r.resistance || 'ไม่ระบุกลุ่ม';
            byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
        }

        return {
            success: true,
            data,
            summary: {
                total: data.length,
                patients: distinct(data.map(r => r.hn)),
                organisms: distinct(data.map(r => r.organism)),
                admitted: data.filter(r => r.an).length,
                by_resistance: [...byGroup.entries()]
                    .map(([name, count]) => ({ name, count }))
                    .sort((a, b) => b.count - a.count),
            },
        };
    } catch (error) {
        console.error('Get AMR patient report error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ชื่อหน่วยงานใน HIS มีรหัสต่อท้ายแบบ "หอผู้ป่วยอายุรกรรม 2 [1560,1535]" ซึ่งไม่ต้องแสดง */
const cleanDepartment = (name: string) => name.replace(/\s*\[[^\]]*\]\s*$/, '').trim();

const TOP_DEPARTMENTS = 10;
const TOP_ORGANISMS = 8;

// ป้ายของแต่ละคอลัมน์ต้องไม่ซ้ำกัน เพราะ echarts ใช้ชื่อ node เป็นคีย์เชื่อมเส้น
// ถ้าใช้คำว่า "อื่นๆ" เหมือนกันทั้งสองคอลัมน์ เส้นจะวิ่งไปผิดที่
const OTHER_DEPT = 'หน่วยงานอื่นๆ';
const OTHER_ORG = 'เชื้ออื่นๆ';
const LINK_SEP = '|::|';

/**
 * เส้นทางของเชื้อดื้อยาในปีงบประมาณปัจจุบัน สำหรับวาดกราฟ Sankey
 *
 * ไล่จาก หน่วยงานที่ส่งตรวจ → เชื้อก่อโรค → กลุ่มการดื้อยา
 * เพื่อให้เห็นว่าเชื้อกลุ่มไหนกำลังมาจากหน่วยงานใด ไม่ใช่แค่ยอดรวมทั้งโรงพยาบาล
 *
 * รวมยอดและยุบกลุ่มย่อยฝั่งเซิร์ฟเวอร์ เพราะกฎการรวมเป็น "อื่นๆ" มีผลต่อตัวเลข
 * ที่คนอ่านเอาไปใช้ ต้องอยู่ที่เดียวและทดสอบได้ ไม่ใช่กระจายอยู่ในโค้ดหน้าจอ
 */
export const getMdroSankeyFiscalYear = async ({ set }: Context) => {
    try {
        /*
          ResultValue เก็บชื่อเชื้อพร้อมวงเล็บบอกการดื้อยา เช่น "Klebsiella pneumoniae(CRE,ESCR)"
          จึงตัดเป็นสองส่วนตรงวงเล็บ ส่วนแถวที่ไม่มีวงเล็บคือเชื้อที่ยังไม่ดื้อยา ไม่นับมา

          นับทั้งวงเล็บเป็นกลุ่มเดียว ไม่แยก CRE ออกจาก ESCR
          เพราะ Sankey ต้องรักษายอดให้เท่ากันทุกคอลัมน์ ถ้าแยกหนึ่งเชื้อเป็นสองเส้น
          ยอดคอลัมน์สุดท้ายจะบวมเกินจริง แล้วความกว้างของเส้นจะโกหกคนอ่าน
        */
        const sql = `
            SELECT
                 c.department
                ,TRIM(SUBSTRING_INDEX(a.ResultValue, '(', 1))                            AS organism
                ,TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(a.ResultValue, '(', -1), ')', 1))  AS resistance
                ,COUNT(*) AS cc
            FROM t_interface_result_bacteria a
            JOIN lab_head b      ON b.lab_order_number = a.Hospital_LabNumber
            JOIN kskdepartment c ON c.depcode = b.order_department
            WHERE a.ResultName LIKE 'or%'
              AND a.ResultValue LIKE '%(%)%'
              AND c.department IS NOT NULL
              -- ปีงบประมาณไทยเริ่ม 1 ต.ค. ถ้ายังไม่ถึงเดือน 10 แปลว่าอยู่ในปีงบที่เริ่มเมื่อปีที่แล้ว
              AND a.ConfirmDate >= DATE_FORMAT(
                    IF(MONTH(CURDATE()) >= 10, CURDATE(), DATE_SUB(CURDATE(), INTERVAL 1 YEAR)), '%Y-10-01')
              AND a.ConfirmDate <= CURDATE()
            GROUP BY c.department, organism, resistance
        `;

        const [rows] = await his.execute<RowDataPacket[]>(sql);

        const records = rows.map(r => ({
            department: cleanDepartment(String(r.department ?? '')) || 'ไม่ระบุหน่วยงาน',
            organism: String(r.organism ?? '').trim() || 'ไม่ระบุเชื้อ',
            resistance: String(r.resistance ?? '').trim() || 'ไม่ระบุกลุ่ม',
            count: Number(r.cc) || 0,
        }));

        const total = records.reduce((s, r) => s + r.count, 0);

        // เอาเฉพาะรายการที่ยอดสูงสุด ที่เหลือยุบเป็น "อื่นๆ" ไม่งั้นกราฟจะมีเส้นบางจนอ่านไม่ออก
        const rankOf = (key: 'department' | 'organism') => {
            const sum = new Map<string, number>();
            for (const r of records) sum.set(r[key], (sum.get(r[key]) ?? 0) + r.count);
            return [...sum.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
        };

        const deptRank = rankOf('department');
        const orgRank = rankOf('organism');
        const keepDept = new Set(deptRank.slice(0, TOP_DEPARTMENTS));
        const keepOrg = new Set(orgRank.slice(0, TOP_ORGANISMS));

        const depthOf = new Map<string, number>();
        const nodeTotal = new Map<string, number>();
        const linkTotal = new Map<string, number>();

        const addNode = (name: string, depth: number, value: number) => {
            depthOf.set(name, depth);
            nodeTotal.set(name, (nodeTotal.get(name) ?? 0) + value);
        };
        const addLink = (source: string, target: string, value: number) => {
            const key = source + LINK_SEP + target;
            linkTotal.set(key, (linkTotal.get(key) ?? 0) + value);
        };

        for (const r of records) {
            const dept = keepDept.has(r.department) ? r.department : OTHER_DEPT;
            const org = keepOrg.has(r.organism) ? r.organism : OTHER_ORG;

            // node ของคอลัมน์กลางถูกนับสองครั้งไม่ได้ ยอดขาเข้ากับขาออกเท่ากันอยู่แล้ว
            addNode(dept, 0, r.count);
            addNode(org, 1, r.count);
            addNode(r.resistance, 2, r.count);
            addLink(dept, org, r.count);
            addLink(org, r.resistance, r.count);
        }

        const nodes = [...depthOf.entries()]
            .map(([name, depth]) => ({ name: sanitizeHTML(name), depth, value: nodeTotal.get(name) ?? 0 }))
            .sort((a, b) => a.depth - b.depth || b.value - a.value);

        const links = [...linkTotal.entries()]
            .map(([key, value]) => {
                const [source, target] = key.split(LINK_SEP);
                return { source: sanitizeHTML(source), target: sanitizeHTML(target), value };
            })
            .sort((a, b) => b.value - a.value);

        // ปีงบ 2569 คือ 1 ต.ค. 2568 ถึง 30 ก.ย. 2569 จึงบวก 1 ปีจากปีที่เริ่มก่อนแปลงเป็น พ.ศ.
        const now = new Date();
        const startYear = now.getMonth() + 1 >= 10 ? now.getFullYear() : now.getFullYear() - 1;

        return {
            success: true,
            data: {
                fiscal_year: startYear + 1 + 543,
                start_date: `${startYear}-10-01`,
                end_date: `${startYear + 1}-09-30`,
                total,
                department_count: deptRank.length,
                organism_count: orgRank.length,
                nodes,
                links,
            },
        };
    } catch (error) {
        console.error('Get MDRO sankey fiscal year error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};