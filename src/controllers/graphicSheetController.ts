import type { Context } from 'elysia';
import { nurse } from '../db';
import { resolveActor } from '../utils/nursingRecord';

/**
 * ฟอร์มปรอท (graphic sheet) — ใบสรุปสัญญาณชีพ ความปวด ยา และสารน้ำเข้า-ออก ทีละ 7 วัน
 *
 * ไม่บันทึกสัญญาณชีพซ้ำ ดึงจากบันทึกสัญญาณชีพและ MAR ที่มีอยู่ หน้าฟอร์มปรอทเป็นแค่อีกมุมมองของข้อมูลเดิม
 * ส่วนที่ไม่มีที่อื่นเก็บ (I/O รายเวร, stool/urine, ประเภทผู้ป่วย, Wt/Ht/Diet, วันผ่าตัด) เก็บในสองตารางของฟอร์มนี้
 * ผู้บันทึกมาจาก token เสมอ ไม่รับชื่อจากหน้าจอ
 */

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const SHIFTS = ['ดึก', 'เช้า', 'บ่าย'];
const PATIENT_TYPES = ['CI', 'SI', 'MI', 'CL'];

/** ตารางของฟอร์มยังไม่ถูกสร้าง (ยังไม่รัน SQL) — หน้าจอยังแสดงส่วนสัญญาณชีพได้ แค่บอกว่ายังบันทึกส่วนอื่นไม่ได้ */
const missingTable = (e: unknown) => (e as { code?: string })?.code === '42P01';

/** ตัวเลขจำนวนเต็มในช่วง หรือ null (ช่องว่าง = ไม่ได้บันทึก ไม่ใช่ 0) */
const intOrNull = (v: unknown, max: number) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : NaN;
};
const decOrNull = (v: unknown, max: number) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 10) / 10 : NaN;
};
const textOrNull = (v: unknown, max: number) => {
    const s = String(v ?? '').replace(/[<>]/g, '').trim();
    return s ? s.slice(0, max) : null;
};

export const getGraphicSheet = async ({ params, query, set }: Context) => {
    const an = String((params as { an?: string }).an ?? '').trim();
    const from = (query as { from?: string })?.from;
    if (!an || !isDay(from)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ AN และวันเริ่ม (YYYY-MM-DD)' };
    }
    const start = `${from} 00:00:00`;

    try {
        /* หนึ่งใบ = 7 วัน · ช่วงเวลาเหตุการณ์ ไม่ใช่เวลาที่กดบันทึก */
        const vitals = await nurse`
            SELECT TO_CHAR(record_datetime, 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
                   vital_t::float8 AS t, vital_p AS p, vital_r AS r, vital_bp_s AS bp_s, vital_bp_d AS bp_d,
                   vital_o2sat AS spo2, o2_therapy, o2_device, o2_flow::float8 AS o2_flow,
                   pain_score, news2_score
            FROM nursing_vital_records
            WHERE an = ${an} AND is_deleted IS NOT TRUE
              AND record_datetime >= ${start}::text::timestamp
              AND record_datetime < ${start}::text::timestamp + INTERVAL '7 days'
            ORDER BY record_datetime`;
        const meds = await nurse`
            SELECT TO_CHAR(a.admin_datetime, 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
                   a.medication_name, COALESCE(o.prn, FALSE) AS prn, a.dose_given
            FROM nursing_medication_admins a
            LEFT JOIN nursing_medication_orders o ON o.id = a.order_id
            WHERE a.an = ${an} AND a.is_deleted IS NOT TRUE AND a.status = 'given'
              AND a.admin_datetime >= ${start}::text::timestamp
              AND a.admin_datetime < ${start}::text::timestamp + INTERVAL '7 days'
            ORDER BY a.admin_datetime`;
        /* ความปวดจากหน้าแบบประเมินความปวด (ลงรายละเอียด) — วาดรวมกับคะแนนจากสัญญาณชีพ */
        const pains = await nurse`
            SELECT TO_CHAR(record_datetime, 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
                   pain_score, reassess_score, location, assessment_tool
            FROM nursing_pain_records
            WHERE an = ${an} AND is_deleted IS NOT TRUE AND pain_score IS NOT NULL
              AND record_datetime >= ${start}::text::timestamp
              AND record_datetime < ${start}::text::timestamp + INTERVAL '7 days'
            ORDER BY record_datetime`;

        /* ความเสี่ยงพลัดตกหกล้ม (Morse) วันละครั้ง — แถวสุดท้ายของใบ · ยังไม่มีตารางก็แสดงใบได้ตามปกติ */
        let falls: Record<string, unknown>[] = [];
        try {
            falls = await nurse`
                SELECT TO_CHAR(record_datetime, 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
                       total_score, risk_level, nurse_name
                FROM nursing_assessments
                WHERE an = ${an} AND assessment_type = 'fall_risk' AND is_deleted IS NOT TRUE
                  AND record_datetime >= ${start}::text::timestamp
                  AND record_datetime < ${start}::text::timestamp + INTERVAL '7 days'
                ORDER BY record_datetime`;
        } catch (e) {
            if (!missingTable(e)) throw e;
        }

        let shifts: Record<string, unknown>[] = [];
        let daily: Record<string, unknown>[] = [];
        let opDates: string[] = [];
        let storageReady = true;
        try {
            shifts = await nurse`
                SELECT TO_CHAR(record_date, 'YYYY-MM-DD') AS record_date, shift,
                       oral_ml, parenteral_ml, intake_other1_label, intake_other1_ml, intake_other2_label, intake_other2_ml,
                       urine_ml, drainage_ml, output_other1_label, output_other1_ml, output_other2_label, output_other2_ml,
                       updated_by_name, TO_CHAR(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
                FROM nursing_graphic_shift
                WHERE an = ${an} AND record_date >= ${from}::date AND record_date < ${from}::date + 7`;
            daily = await nurse`
                SELECT TO_CHAR(record_date, 'YYYY-MM-DD') AS record_date, stool_count, urine_count, patient_type,
                       weight_kg::float8 AS weight_kg, height_cm::float8 AS height_cm, diet, is_operation_day, note,
                       updated_by_name, TO_CHAR(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
                FROM nursing_graphic_daily
                WHERE an = ${an} AND record_date >= ${from}::date AND record_date < ${from}::date + 7`;
            /* วันผ่าตัดก่อนหน้าใบนี้ก็ต้องรู้ ไม่งั้นนับ "Day after operation" ของใบที่สองไม่ได้ */
            const ops = await nurse`
                SELECT TO_CHAR(record_date, 'YYYY-MM-DD') AS d FROM nursing_graphic_daily
                WHERE an = ${an} AND is_operation_day AND record_date < ${from}::date + 7
                ORDER BY record_date`;
            opDates = ops.map(r => String(r.d));
        } catch (e) {
            if (!missingTable(e)) throw e;
            storageReady = false;
        }

        return {
            success: true,
            data: { from, vitals, meds, pains, falls, shifts, daily, op_dates: opDates, storage_ready: storageReady },
        };
    } catch (error) {
        console.error('Get graphic sheet error:', error);
        set.status = 500;
        return { success: false, message: 'โหลดฟอร์มปรอทไม่สำเร็จ' };
    }
};

/** บันทึก/แก้ I/O ของหนึ่งเวร — หนึ่งเวรมีแถวเดียว บันทึกซ้ำคือแก้ค่าเดิม */
export const saveGraphicShift = async ({ body, set, user }: Context & { user?: unknown }) => {
    const actor = await resolveActor(user);
    if (!actor) { set.status = 401; return { success: false, message: 'ไม่พบบัญชีผู้ใช้ กรุณาเข้าสู่ระบบใหม่' }; }
    const b = (body ?? {}) as Record<string, unknown>;
    const an = String(b.an ?? '').trim();
    if (!an || !isDay(b.record_date) || !SHIFTS.includes(String(b.shift))) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ AN วันที่ และเวร' };
    }
    const nums = ['oral_ml', 'parenteral_ml', 'intake_other1_ml', 'intake_other2_ml',
        'urine_ml', 'drainage_ml', 'output_other1_ml', 'output_other2_ml'] as const;
    const v: Record<string, number | string | null> = {};
    for (const k of nums) {
        const n = intOrNull(b[k], 20000);
        if (Number.isNaN(n)) { set.status = 400; return { success: false, message: `ค่าปริมาตรไม่ถูกต้อง (${k})` }; }
        v[k] = n;
    }
    for (const k of ['intake_other1_label', 'intake_other2_label', 'output_other1_label', 'output_other2_label']) {
        v[k] = textOrNull(b[k], 60);
    }

    try {
        await nurse`
            INSERT INTO nursing_graphic_shift (
                an, ward_code, ward_name, record_date, shift,
                oral_ml, parenteral_ml, intake_other1_label, intake_other1_ml, intake_other2_label, intake_other2_ml,
                urine_ml, drainage_ml, output_other1_label, output_other1_ml, output_other2_label, output_other2_ml,
                created_by, created_by_name, updated_by, updated_by_name)
            VALUES (
                ${an}, ${textOrNull(b.ward_code, 20)}, ${textOrNull(b.ward_name, 200)}, ${String(b.record_date)}::date, ${String(b.shift)},
                ${v.oral_ml}, ${v.parenteral_ml}, ${v.intake_other1_label}, ${v.intake_other1_ml}, ${v.intake_other2_label}, ${v.intake_other2_ml},
                ${v.urine_ml}, ${v.drainage_ml}, ${v.output_other1_label}, ${v.output_other1_ml}, ${v.output_other2_label}, ${v.output_other2_ml},
                ${actor.username}, ${actor.fullname}, ${actor.username}, ${actor.fullname})
            ON CONFLICT (an, record_date, shift) DO UPDATE SET
                oral_ml = EXCLUDED.oral_ml, parenteral_ml = EXCLUDED.parenteral_ml,
                intake_other1_label = EXCLUDED.intake_other1_label, intake_other1_ml = EXCLUDED.intake_other1_ml,
                intake_other2_label = EXCLUDED.intake_other2_label, intake_other2_ml = EXCLUDED.intake_other2_ml,
                urine_ml = EXCLUDED.urine_ml, drainage_ml = EXCLUDED.drainage_ml,
                output_other1_label = EXCLUDED.output_other1_label, output_other1_ml = EXCLUDED.output_other1_ml,
                output_other2_label = EXCLUDED.output_other2_label, output_other2_ml = EXCLUDED.output_other2_ml,
                ward_code = COALESCE(EXCLUDED.ward_code, nursing_graphic_shift.ward_code),
                ward_name = COALESCE(EXCLUDED.ward_name, nursing_graphic_shift.ward_name),
                updated_at = now(), updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name`;
        return { success: true };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return { success: false, message: 'ยังไม่ได้สร้างตารางของฟอร์มปรอท (ต้องรัน SQL ก่อน)' }; }
        console.error('Save graphic shift error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกไม่สำเร็จ' };
    }
};

/** บันทึก/แก้ข้อมูลรายวัน — หนึ่งวันมีแถวเดียว */
export const saveGraphicDaily = async ({ body, set, user }: Context & { user?: unknown }) => {
    const actor = await resolveActor(user);
    if (!actor) { set.status = 401; return { success: false, message: 'ไม่พบบัญชีผู้ใช้ กรุณาเข้าสู่ระบบใหม่' }; }
    const b = (body ?? {}) as Record<string, unknown>;
    const an = String(b.an ?? '').trim();
    if (!an || !isDay(b.record_date)) { set.status = 400; return { success: false, message: 'กรุณาระบุ AN และวันที่' }; }
    const stool = intOrNull(b.stool_count, 50);
    const urine = intOrNull(b.urine_count, 50);
    const wt = decOrNull(b.weight_kg, 400);
    const ht = decOrNull(b.height_cm, 250);
    if ([stool, urine, wt, ht].some(n => Number.isNaN(n))) { set.status = 400; return { success: false, message: 'ค่าตัวเลขไม่ถูกต้อง' }; }
    const type = b.patient_type ? String(b.patient_type) : null;
    if (type && !PATIENT_TYPES.includes(type)) { set.status = 400; return { success: false, message: 'ประเภทผู้ป่วยไม่ถูกต้อง' }; }

    try {
        await nurse`
            INSERT INTO nursing_graphic_daily (
                an, ward_code, ward_name, record_date, stool_count, urine_count, patient_type,
                weight_kg, height_cm, diet, is_operation_day, note,
                created_by, created_by_name, updated_by, updated_by_name)
            VALUES (
                ${an}, ${textOrNull(b.ward_code, 20)}, ${textOrNull(b.ward_name, 200)}, ${String(b.record_date)}::date,
                ${stool}, ${urine}, ${type}, ${wt}, ${ht}, ${textOrNull(b.diet, 100)}, ${b.is_operation_day === true}, ${textOrNull(b.note, 200)},
                ${actor.username}, ${actor.fullname}, ${actor.username}, ${actor.fullname})
            ON CONFLICT (an, record_date) DO UPDATE SET
                stool_count = EXCLUDED.stool_count, urine_count = EXCLUDED.urine_count, patient_type = EXCLUDED.patient_type,
                weight_kg = EXCLUDED.weight_kg, height_cm = EXCLUDED.height_cm, diet = EXCLUDED.diet,
                is_operation_day = EXCLUDED.is_operation_day, note = EXCLUDED.note,
                ward_code = COALESCE(EXCLUDED.ward_code, nursing_graphic_daily.ward_code),
                ward_name = COALESCE(EXCLUDED.ward_name, nursing_graphic_daily.ward_name),
                updated_at = now(), updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name`;
        return { success: true };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return { success: false, message: 'ยังไม่ได้สร้างตารางของฟอร์มปรอท (ต้องรัน SQL ก่อน)' }; }
        console.error('Save graphic daily error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกไม่สำเร็จ' };
    }
};
