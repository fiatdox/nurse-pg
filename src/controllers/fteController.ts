import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { wardGroupOf, groupInfo } from '../utils/wardGroup';
import { workdaysBetween, monthBounds } from '../utils/workdays';
import {
    HOURS_PER_SHIFT, MONTHLY_FTE_WEIGHT, MONTHLY_PRODUCT_WEIGHT, FTE_HEADCOUNT_HOURS,
    emptyStaff, addStaff, regularCount, totalCount, round2, pct,
    workload, fteOf, productOf, productByTypeOf, safeDiv,
    type ShiftStaff, type Params,
} from '../utils/fte';

/**
 * ภาระงานและ FTE รายวัน ตามแบบฟอร์ม "การคิด FTE รายวัน" ของฝ่ายการพยาบาล
 *
 * สูตรทั้งหมดอยู่ใน utils/fte.ts ไฟล์นี้ทำหน้าที่ดึงข้อมูลและประกอบรายงานเท่านั้น
 * คิดฝั่งเซิร์ฟเวอร์ให้เสร็จ ไม่ส่งตัวเลขดิบไปให้หน้าจอคำนวณเอง
 * เพราะถ้ากระจายสูตรไว้ในหน้าจอ วันหนึ่งจะมีหน้าที่คิดไม่เหมือนกันโดยไม่มีใครรู้
 */

const isMonth = (v: unknown) => /^\d{4}-\d{2}$/.test(String(v ?? ''));

export const getFTEByWard = async (
    { body, set }: { body: { ward: string; month: string }; set: any }
) => {
    const { ward, month } = body ?? {};

    if (!ward || !isMonth(month)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward และ month (รูปแบบ YYYY-MM)' };
    }

    try {
        /*
          หอที่นับรวมเป็นหน่วยเดียวกัน (เช่น Nursery + NICU) คิดเป็นรายงานเดียว
          เลือกหอไหนในหน่วยก็ได้ผลเดียวกัน ผู้ป่วยและคนขึ้นเวรนับจากทุกหอในหน่วย
          ค่าน้ำหนักทั่วไป/วิกฤตใช้ของหอหลัก
        */
        const group = await wardGroupOf(ward);

        if (!group) {
            set.status = 404;
            return { success: false, message: 'ไม่พบหอผู้ป่วยที่ระบุ' };
        }

        const shifts = await nurse`
            SELECT admission_change_shift_type_id AS id, shift_name, weight
            FROM admission_change_shift_types
            ORDER BY admission_change_shift_type_id`;

        const levels = await nurse`
            SELECT severity_level_id, severity_level_name, care_hours
            FROM admission_severity_level ORDER BY severity_level_id`;

        const params: Params = {
            general: group.primary.general,
            crisis: group.primary.crisis,
            careHours: Object.fromEntries(
                levels.map(l => [Number(l.severity_level_id), Number(l.care_hours ?? 0)])
            ),
        };

        /*
          ยอดผู้ป่วยรายวัน x เวร

          ใช้ generate_series ไขว้กับประเภทเวร เพื่อให้ได้ครบทุกช่องของเดือน
          วันที่ไม่มีใครบันทึกต้องปรากฏเป็นแถวศูนย์ ไม่ใช่หายไปจากตาราง
          ไม่งั้นคนอ่านจะแยกไม่ออกว่า "ไม่มีผู้ป่วย" กับ "ลืมบันทึก"
        */
        const patientRows = await nurse`
            WITH date_series AS (
                SELECT generate_series(
                    DATE_TRUNC('month', (${month} || '-01')::date),
                    DATE_TRUNC('month', (${month} || '-01')::date) + INTERVAL '1 month' - INTERVAL '1 day',
                    INTERVAL '1 day'
                )::date AS record_date
            ),
            shift_series AS (
                SELECT admission_change_shift_type_id AS shift_type_id
                FROM admission_change_shift_types
            )
            SELECT
                 TO_CHAR(ds.record_date, 'YYYY-MM-DD') AS record_date
                ,ss.shift_type_id
                ,COUNT(CASE WHEN a.admission_shift_care_level_id = 1 THEN 1 END)::int AS pt_normal
                ,COUNT(CASE WHEN a.admission_shift_care_level_id = 2 THEN 1 END)::int AS pt_o2
                ,COUNT(CASE WHEN a.admission_shift_care_level_id = 3 THEN 1 END)::int AS pt_hfnc
                ,COUNT(CASE WHEN a.admission_shift_care_level_id = 4 THEN 1 END)::int AS pt_vent
                ,COUNT(CASE WHEN a.severity_level_id = 1 THEN 1 END)::int AS t1
                ,COUNT(CASE WHEN a.severity_level_id = 2 THEN 1 END)::int AS t2
                ,COUNT(CASE WHEN a.severity_level_id = 3 THEN 1 END)::int AS t3
                ,COUNT(CASE WHEN a.severity_level_id = 4 THEN 1 END)::int AS t4
                ,COUNT(CASE WHEN a.severity_level_id = 5 THEN 1 END)::int AS t5
            FROM date_series ds
            CROSS JOIN shift_series ss
            LEFT JOIN admission_shift_daily_record a
                   ON a.record_date = ds.record_date
                  AND a.shift_type_id = ss.shift_type_id
                  AND a.deleted_at IS NULL
            LEFT JOIN admission_list al
                   ON al.admission_list_id = a.admission_list_id
                  AND al.ward IN ${nurse(group.codes)}
            WHERE a.admission_shift_daily_record IS NULL OR al.admission_list_id IS NOT NULL
            GROUP BY ds.record_date, ss.shift_type_id
            ORDER BY ds.record_date, ss.shift_type_id`;

        /*
          จำนวนเจ้าหน้าที่ที่ขึ้นเวร

          แตกเป็นแถวย่อยตาม เวร x ตำแหน่ง x ชนิด OT แล้วค่อยประกอบใน TypeScript
          ดีกว่าเขียน COUNT CASE ยี่สิบเจ็ดคอลัมน์แบบเดิมซึ่งอ่านไม่ออกและแก้ยาก
          ชนิดเวรอ้างจาก nurse_shift_types ไม่ได้ฝังเลข id ไว้ในคิวรี
        */
        const staffRows = await nurse`
            SELECT
                 TO_CHAR(a.shift_date, 'YYYY-MM-DD') AS record_date
                ,nst.admission_change_shift_type_id  AS shift_type_id
                ,sp.code                             AS position_code
                ,CASE
                     WHEN nst.code LIKE '%\\_OT4' THEN 'ot4'
                     WHEN nst.code LIKE '%\\_OT'  THEN 'ot8'
                     ELSE 'regular'
                 END                                 AS ot_kind
                -- นับหัวคน คนเดียวกันที่ลงเวรไว้ทั้งสองหอในหน่วยต้องไม่กลายเป็นสองคน
                ,COUNT(DISTINCT a.staff_id)::int     AS n
            FROM nurse_shift_assignments a
            JOIN nurse_shift_types nst ON nst.nurse_shift_type_id = a.nurse_shift_type_id
            JOIN staffs s              ON s.staff_id = a.staff_id
            JOIN staff_position sp     ON sp.staff_position_id = s.staff_position_id
            WHERE a.ward IN ${nurse(group.codes)}
              AND nst.admission_change_shift_type_id <> 0
              AND a.shift_date >= DATE_TRUNC('month', (${month} || '-01')::date)
              AND a.shift_date <  DATE_TRUNC('month', (${month} || '-01')::date) + INTERVAL '1 month'
            GROUP BY 1, 2, 3, 4`;

        const staffByKey = new Map<string, ShiftStaff>();
        for (const r of staffRows) {
            const key = `${r.record_date}|${r.shift_type_id}`;
            const cur = staffByKey.get(key) ?? emptyStaff();
            const pos = String(r.position_code).toLowerCase() as 'rn' | 'tn' | 'pn';
            const field = r.ot_kind === 'regular' ? pos : (`${r.ot_kind}_${pos}` as keyof ShiftStaff);
            cur[field] = (cur[field] ?? 0) + Number(r.n);
            staffByKey.set(key, cur);
        }

        const weightOf = new Map(shifts.map(s => [Number(s.id), Number(s.weight) / 100]));
        const nameOf = new Map(shifts.map(s => [Number(s.id), String(s.shift_name)]));

        const rows = patientRows.map(r => {
            const shiftId = Number(r.shift_type_id);
            const weight = weightOf.get(shiftId) ?? 0;
            const staff = staffByKey.get(`${r.record_date}|${shiftId}`) ?? emptyStaff();

            const ptGeneral = Number(r.pt_normal) + Number(r.pt_o2) + Number(r.pt_hfnc);
            const ptCrisis = Number(r.pt_vent);
            const types = [Number(r.t1), Number(r.t2), Number(r.t3), Number(r.t4), Number(r.t5)];
            const typeTotal = types.reduce((a, b) => a + b, 0);

            const fte = fteOf(ptGeneral, ptCrisis, weight, params);

            return {
                record_date: r.record_date,
                shift_type_id: shiftId,
                shift_name: nameOf.get(shiftId) ?? '',
                pt_normal: Number(r.pt_normal),
                pt_o2: Number(r.pt_o2),
                pt_hfnc: Number(r.pt_hfnc),
                pt_vent: ptCrisis,
                pt_general: ptGeneral,
                fte: round2(fte),
                staff,
                staff_regular: regularCount(staff),
                staff_total: totalCount(staff),
                // คอลัมน์ M — กำลังปกติเทียบกับที่ควรมี ติดลบคือขาด
                diff: round2(regularCount(staff) - fte),
                product: pct(productOf(ptGeneral, ptCrisis, weight, staff, params)),
                types,
                type_total: typeTotal,
                product_type: pct(productByTypeOf(types, staff, params)),
                /*
                  คอลัมน์ V — ยอดผู้ป่วยต้องเท่ากับผลรวมประเภท 1-5
                  คู่มือในไฟล์ต้นฉบับกำกับไว้ว่า "ยอดผู้ป่วย กับ ยอดรวมแต่ละประเภท ต้องเท่ากัน"
                  ไม่เท่ากันแปลว่าลงประเภทผู้ป่วยไม่ครบ ต้องเห็นทันที ไม่ใช่ไปเจอตอนสรุปเดือน
                */
                check_diff: ptGeneral + ptCrisis - typeTotal,
            };
        });

        // ───── รวมทั้งเดือน แยกตามเวร (แถว 103-105 ในไฟล์ต้นฉบับ) ─────
        const byShift = shifts.map(s => {
            const id = Number(s.id);
            const mine = rows.filter(r => r.shift_type_id === id);

            const ptGeneral = mine.reduce((a, r) => a + r.pt_general, 0);
            const ptCrisis = mine.reduce((a, r) => a + r.pt_vent, 0);
            const staff = mine.reduce((a, r) => addStaff(a, r.staff), emptyStaff());
            const types = [0, 1, 2, 3, 4].map(i => mine.reduce((a, r) => a + r.types[i], 0));
            const typeTotal = types.reduce((a, b) => a + b, 0);

            /*
              แถวรวมใช้สัดส่วนของเวรตัวเอง ผลจึงเท่ากับผลบวกของคอลัมน์ที่อยู่เหนือมันพอดี

              ไฟล์ต้นฉบับใช้ 0.35 กับทั้งสามเวรในแถวนี้ (E103-E105 อ้าง $M$4)
              ถ้าทำตามนั้น แถวรวมจะไม่เท่ากับผลบวกของตัวเองซึ่งคนอ่านจับได้ทันที
              จึงคิดแบบสอดคล้องกัน แล้วแนบค่าแบบไฟล์เดิมไปใน fte_excel/product_excel
              ให้หน้าจอแสดงเป็นบรรทัดรองไว้เทียบกับรายงานเก่าได้
            */
            const weight = weightOf.get(id) ?? 0;
            const fte = fteOf(ptGeneral, ptCrisis, weight, params);

            return {
                shift_type_id: id,
                shift_name: String(s.shift_name),
                pt_normal: mine.reduce((a, r) => a + r.pt_normal, 0),
                pt_o2: mine.reduce((a, r) => a + r.pt_o2, 0),
                pt_hfnc: mine.reduce((a, r) => a + r.pt_hfnc, 0),
                pt_vent: ptCrisis,
                pt_general: ptGeneral,
                fte: round2(fte),
                staff,
                staff_regular: regularCount(staff),
                staff_total: totalCount(staff),
                diff: round2(regularCount(staff) - fte),
                product: pct(productOf(ptGeneral, ptCrisis, weight, staff, params)),
                types,
                type_total: typeTotal,
                product_type: pct(productByTypeOf(types, staff, params)),
                check_diff: ptGeneral + ptCrisis - typeTotal,
                // ค่าตามสูตรในไฟล์ต้นฉบับ เก็บไว้เทียบกับรายงานที่เคยส่งไปแล้ว
                fte_excel: round2(fteOf(ptGeneral, ptCrisis, MONTHLY_FTE_WEIGHT, params)),
                product_excel: pct(productOf(ptGeneral, ptCrisis, MONTHLY_PRODUCT_WEIGHT, staff, params)),
            };
        });

        /*
          แถวเฉลี่ย (แถว 106)

          ยอดผู้ป่วยและประเภทหารสาม (เฉลี่ยต่อเวร) แต่จำนวนเจ้าหน้าที่เป็นผลรวมทั้งเดือน
          หน่วยไม่ตรงกัน ค่า product ตามประเภทของแถวนี้จึงต่ำกว่ารายวันมาก
          เป็นแบบนี้ในไฟล์ต้นฉบับ และผู้ใช้เลือกให้คงไว้ตามเดิม
        */
        const shiftCount = byShift.length || 1;
        const avgGeneral = byShift.reduce((a, s) => a + s.pt_general, 0) / shiftCount;
        const avgCrisis = byShift.reduce((a, s) => a + s.pt_vent, 0) / shiftCount;
        const avgTypes = [0, 1, 2, 3, 4].map(i => byShift.reduce((a, s) => a + s.types[i], 0) / shiftCount);
        const totalStaff = byShift.reduce((a, s) => addStaff(a, s.staff), emptyStaff());

        const average = {
            pt_general: round2(avgGeneral),
            pt_vent: round2(avgCrisis),
            staff: totalStaff,
            staff_regular: regularCount(totalStaff),
            staff_total: totalCount(totalStaff),
            types: avgTypes.map(round2),
            type_total: round2(avgTypes.reduce((a, b) => a + b, 0)),
            product_type: pct(productByTypeOf(avgTypes, totalStaff, params)),
        };

        // ───── หัวตาราง (แถว 3-6) ─────

        /*
          จำนวนพยาบาลมีจริงเดือนนี้ — นับจากตารางเวร ไม่ใช่จากทะเบียนประจำหอ

          คู่มือในไฟล์ต้นฉบับระบุให้ "ยกเว้นผู้ที่ลาคลอดหรือเรียนต่อที่ไม่มาทำงานทั้งเดือน"
          คนกลุ่มนั้นจะไม่มีเวรสักเวรในเดือนนั้นอยู่แล้ว การนับจากตารางเวรจึงตัดออกให้เอง
          โดยไม่ต้องให้ใครมาคอยกรอกตัวเลขเอง
        */
        const [onDuty] = await nurse`
            SELECT COUNT(DISTINCT a.staff_id)::int AS n
            FROM nurse_shift_assignments a
            JOIN nurse_shift_types nst ON nst.nurse_shift_type_id = a.nurse_shift_type_id
            WHERE a.ward IN ${nurse(group.codes)}
              AND nst.admission_change_shift_type_id <> 0
              AND a.shift_date >= DATE_TRUNC('month', (${month} || '-01')::date)
              AND a.shift_date <  DATE_TRUNC('month', (${month} || '-01')::date) + INTERVAL '1 month'`;

        const bounds = monthBounds(month);
        const { workdays, public_holidays: publicHolidays } = await workdaysBetween(bounds.first, bounds.last);

        /*
          จำนวนพยาบาลตาม FTE (C6) — ตามไฟล์ต้นฉบับซึ่งใช้ตัวคูณ 12 กับผู้ป่วยทั้งสองกลุ่ม
          ไม่ใช่ค่าของหอ ดูหมายเหตุที่ FTE_HEADCOUNT_HOURS
        */
        const nursesByFte = workdays === 0
            ? null
            : round2(((avgGeneral * FTE_HEADCOUNT_HOURS) + (avgCrisis * FTE_HEADCOUNT_HOURS))
                / (workdays * HOURS_PER_SHIFT));

        // product ทั้งเดือน (N6) — ใช้ค่าของหอกับกลุ่มทั่วไป ต่างจาก C6 ข้างบน
        const productMonth = pct(safeDiv(
            workload(avgGeneral, avgCrisis, params),
            totalCount(totalStaff) * HOURS_PER_SHIFT));

        /*
          ค่าเวรและค่า OT อ่านจาก staff_position_rates ไม่ฝังตัวเลขไว้ในโค้ด

          ไฟล์ต้นฉบับฝังไว้ (RN เวรละ 240 / TN 180 / OT RN 660 / OT TN 530) และนับเฉพาะ
          เวรดึกกับบ่าย ส่วนตารางในฐานข้อมูลมีอัตราครบทุกเวรทุกตำแหน่งและเป็นค่าปัจจุบัน
          ยอดที่ได้จึงต่างจากไฟล์เดิม แต่แก้อัตราได้จากหน้าจอโดยไม่ต้องแก้โปรแกรม
        */
        const rateRows = await nurse`
            SELECT r.users_position_id AS position_id, r.shift_code, r.amount
            FROM staff_position_rates r`;

        const rateOf = new Map(
            rateRows.map(r => [`${r.position_id}|${r.shift_code}`, Number(r.amount)])
        );

        const POSITION_ID: Record<string, number> = { rn: 1, tn: 2, pn: 3 };
        const SHIFT_CODE: Record<number, string> = { 1: 'N', 2: 'M', 3: 'A' };

        let shiftPay = 0;
        let otPay = 0;
        for (const s of byShift) {
            const code = SHIFT_CODE[s.shift_type_id];
            if (!code) continue;
            for (const pos of ['rn', 'tn', 'pn'] as const) {
                const id = POSITION_ID[pos];
                shiftPay += s.staff[pos] * (rateOf.get(`${id}|${code}`) ?? 0);
                otPay += s.staff[`ot8_${pos}`] * (rateOf.get(`${id}|${code}_OT`) ?? 0);
                otPay += s.staff[`ot4_${pos}`] * (rateOf.get(`${id}|${code}_OT4`) ?? 0);
            }
        }

        return {
            success: true,
            data: {
                ward,
                ward_name: sanitizeHTML(group.label),
                group: groupInfo(group),
                month,
                params: {
                    general: params.general,
                    crisis: params.crisis,
                    shift_weights: shifts.map(s => ({
                        shift_type_id: Number(s.id),
                        shift_name: String(s.shift_name),
                        weight: Number(s.weight),
                    })),
                    care_hours: levels.map(l => ({
                        severity_level_id: Number(l.severity_level_id),
                        severity_level_name: sanitizeHTML(l.severity_level_name),
                        care_hours: Number(l.care_hours ?? 0),
                    })),
                    hours_per_shift: HOURS_PER_SHIFT,
                },
                header: {
                    nurses_on_duty: Number(onDuty?.n ?? 0),
                    workdays,
                    public_holidays: publicHolidays,
                    nurses_by_fte: nursesByFte,
                    over_under: nursesByFte === null ? null : round2(Number(onDuty?.n ?? 0) - nursesByFte),
                    product_month: productMonth,
                    product_type_month: average.product_type,
                    shift_pay: round2(shiftPay),
                    ot_pay: round2(otPay),
                },
                rows,
                monthly: { by_shift: byShift, average },
                // แถวที่ลงประเภทผู้ป่วยไม่ครบ ให้หน้าจอเตือนได้โดยไม่ต้องไล่เอง
                incomplete_rows: rows.filter(r => r.check_diff !== 0).length,
            },
        };
    } catch (error) {
        console.error('Get FTE by ward error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
