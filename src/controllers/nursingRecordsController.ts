import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';

/** คอลัมน์ที่รับบันทึกได้จาก client — ฟิลด์นอกรายการนี้จะถูกตัดทิ้ง */
const ADMIT_FIELDS = [
    'ward_code', 'ward_name', 'staff_id', 'nurse_name', 'record_datetime',
    'admit_from', 'admit_method', 'admit_reason',
    'chief_complaint', 'present_illness', 'past_illness',
    'allergies', 'current_medications',
    'general_appearance', 'skin_condition', 'mobility',
    // สภาพร่างกายแรกรับตามแบบฟอร์มบันทึกทางการพยาบาล
    'breathing', 'breathing_other', 'circulation', 'edema', 'edema_site',
    'hearing', 'hearing_aid', 'vision', 'eyeglasses', 'speech', 'speech_other',
    'vital_t', 'vital_p', 'vital_r', 'vital_bp', 'vital_o2sat',
    'consciousness', 'pain_score', 'nutrition_screening',
    'weight', 'height', 'bmi',
    'diagnosis_summary', 'treatment_summary',
    'caregiver_name', 'caregiver_relation', 'caregiver_phone',
    'nursing_diagnosis', 'nursing_plan',
    // ประเมินแรกรับเพิ่มเติม
    'smoking', 'alcohol', 'fall_risk_screen', 'pressure_sore_screen',
    'devices', 'valuables', 'orientation_given',
    // แรกรับผู้คลอด — เกณฑ์ข้อ 1 (ประวัติทางสูติกรรม / ANC / ความเสี่ยง / ตรวจร่างกาย)
    'is_maternity',
    'gravida', 'parity', 'abortion', 'living_children',
    'lmp', 'edc', 'ga_weeks', 'ga_days',
    'anc_place', 'anc_visits', 'previous_delivery',
    'risk_factors', 'pregnancy_complication',
    'fundal_height', 'fetal_presentation', 'physical_exam_by', 'physical_exam_note',
    // แรกรับผู้คลอด — เกณฑ์ข้อ 2 (ประเมินระยะรอคลอด ณ แรกรับ)
    'labour_assess_datetime',
    'uc_interval', 'uc_duration', 'uc_intensity',
    'cervical_dilation', 'cervical_effacement',
    'membrane_status', 'membrane_rupture_datetime', 'amniotic_fluid',
    'fetal_heart_sound', 'fhs_regularity', 'fetal_station',
    'labour_complication',
    // หัวข้อตามเกณฑ์ตรวจประเมินคุณภาพการบันทึกทางการพยาบาล
    'emotional_state', 'emotional_note', 'adl_level', 'isolation_precaution',
    'informed_consent', 'patient_identified',
    'discharge_plan_topics', 'discharge_plan_note', 'expected_los',
    'reviewed_by', 'reviewed_at',
    // marital_status, religion, occupation, education_level, payment_scheme, communication
    // มีคอลัมน์อยู่ในตารางแต่ไม่รับค่าจากหน้าจอ — ทะเบียนผู้ป่วยใน HIS เป็นต้นทางของข้อมูลชุดนี้
    // ใบบันทึกการรวบรวมข้อมูลแรกรับ (SD-IM-003.019) — ส่วนหัว
    'readmit_28_days', 'refer_from', 'initial_symptoms',
    // ประวัติการเจ็บป่วยในอดีต
    'allergy_status', 'surgery_status', 'surgery_detail',
    'substance_status', 'substance_detail',
    'chronic_status', 'chronic_diseases', 'chronic_other',
    'treatment_status', 'treatment_detail',
    // ข้อมูลทั่วไป / สถานภาพทางสังคม
    'social_role', 'dependents_count', 'social_other',
    'family_housing', 'caregiver_status',
    'disability_status', 'disability_detail',
    'environment_status', 'environment_detail',
    'economic_status', 'economic_detail',
    'spiritual_belief', 'contact_address', 'contact_phone',
] as const;

/** ฟิลด์ข้อความอิสระที่ผู้ใช้พิมพ์เอง ต้องล้างแท็กก่อนส่งออก */
const ADMIT_TEXT_FIELDS = [
    'ward_name', 'nurse_name', 'admit_from', 'admit_method', 'admit_reason',
    'chief_complaint', 'present_illness', 'past_illness',
    'allergies', 'current_medications',
    'general_appearance', 'skin_condition', 'mobility',
    'breathing', 'breathing_other', 'circulation', 'edema', 'edema_site',
    'hearing', 'hearing_aid', 'vision', 'eyeglasses', 'speech', 'speech_other',
    'vital_bp', 'consciousness', 'nutrition_screening',
    'diagnosis_summary', 'treatment_summary',
    'caregiver_name', 'caregiver_relation', 'caregiver_phone',
    'nursing_diagnosis', 'nursing_plan',
    'smoking', 'alcohol', 'fall_risk_screen', 'pressure_sore_screen',
    'devices', 'valuables', 'orientation_given',
    'anc_place', 'previous_delivery', 'risk_factors', 'pregnancy_complication',
    'fetal_presentation', 'physical_exam_by', 'physical_exam_note',
    'uc_interval', 'uc_intensity', 'membrane_status', 'amniotic_fluid',
    'fhs_regularity', 'labour_complication',
    'emotional_state', 'emotional_note', 'adl_level', 'isolation_precaution',
    'informed_consent', 'patient_identified',
    'discharge_plan_topics', 'discharge_plan_note', 'reviewed_by',
    'readmit_28_days', 'refer_from', 'initial_symptoms',
    'allergy_status', 'surgery_status', 'surgery_detail',
    'substance_status', 'substance_detail',
    'chronic_status', 'chronic_diseases', 'chronic_other',
    'treatment_status', 'treatment_detail',
    'social_role', 'social_other', 'family_housing', 'caregiver_status',
    'disability_status', 'disability_detail',
    'environment_status', 'environment_detail',
    'economic_status', 'economic_detail',
    'spiritual_belief', 'contact_address', 'contact_phone',
];

/**
 * คอลัมน์ชนิด date / timestamp
 * ต้องส่งเป็น Date object ไม่ใช่ข้อความ เพราะ driver แปลงข้อความว่าเป็น UTC
 * ทำให้เวลาที่บันทึกเพี้ยนไปเท่ากับ offset ของเครื่อง (ไทย = ช้าไป 7 ชั่วโมง)
 */
const ADMIT_DATE_FIELDS = [
    'record_datetime', 'reviewed_at',
    'lmp', 'edc', 'labour_assess_datetime', 'membrane_rupture_datetime',
];

/** ตีความ 'YYYY-MM-DD' และ 'YYYY-MM-DD HH:mm:ss' ว่าเป็นเวลาท้องถิ่นตามที่ผู้ใช้กรอก */
const toLocalDate = (v: unknown): Date | null => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
        return new Date(
            Number(m[1]), Number(m[2]) - 1, Number(m[3]),
            Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)
        );
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
};

const sanitizeRow = (row: Record<string, unknown>) => {
    const out = { ...row };
    for (const f of ADMIT_TEXT_FIELDS) {
        if (typeof out[f] === 'string') out[f] = sanitizeHTML(out[f] as string);
    }
    return out;
};

// ---------- ดึงบันทึกแรกรับตาม AN ----------
export const getAdmitRecordByAN = async ({ params, set }: Context) => {
    const { an } = params as { an: string };

    if (!an?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    try {
        const rows = await nurse`
            SELECT *
            FROM nursing_admit_records
            WHERE an = ${an.trim()}
              AND is_deleted IS NOT TRUE
            ORDER BY record_datetime DESC, id DESC
            LIMIT 1
        `;

        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบบันทึกแรกรับของผู้ป่วยรายนี้' };
        }

        return { success: true, data: sanitizeRow(rows[0] as Record<string, unknown>) };
    } catch (error) {
        console.error('Get admit record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- บันทึก / แก้ไขบันทึกแรกรับ ----------
export const saveAdmitRecord = async ({ body, set, user }: Context & { user: any }) => {
    const payload = (body ?? {}) as Record<string, unknown>;
    const an = String(payload.an ?? '').trim();

    if (!an) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }
    if (!String(payload.ward_code ?? '').trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward_code' };
    }

    const actor = String(user?.username ?? payload.staff_id ?? '') || null;

    // รับเฉพาะคอลัมน์ที่รู้จัก และแปลงค่าว่างเป็น null ให้ตรงกับชนิดคอลัมน์
    const values: Record<string, unknown> = {};
    for (const f of ADMIT_FIELDS) {
        const v = payload[f];
        values[f] = v === undefined || v === '' ? null : v;
    }
    for (const f of ADMIT_DATE_FIELDS) values[f] = toLocalDate(values[f]);

    values.staff_id = String(payload.staff_id ?? '') || '';
    values.record_datetime = values.record_datetime ?? new Date();

    try {
        const existing = await nurse`
            SELECT id FROM nursing_admit_records
            WHERE an = ${an} AND is_deleted IS NOT TRUE
            ORDER BY id DESC
            LIMIT 1
        `;

        // หนึ่ง AN มีบันทึกแรกรับใบเดียว เปิดหน้าซ้ำแล้วบันทึกจึงเป็นการแก้ไขใบเดิม
        const saved = existing.length > 0
            ? await nurse`
                UPDATE nursing_admit_records
                SET ${nurse({ ...values, updated_at: new Date(), updated_by: actor })}
                WHERE id = ${existing[0].id}
                RETURNING *
              `
            : await nurse`
                INSERT INTO nursing_admit_records ${nurse({
                    an,
                    ...values,
                    created_at: new Date(),
                    created_by: actor,
                })}
                RETURNING *
              `;

        return {
            success: true,
            message: existing.length > 0 ? 'แก้ไขบันทึกแรกรับเรียบร้อยแล้ว' : 'บันทึกแรกรับเรียบร้อยแล้ว',
            data: sanitizeRow(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        console.error('Save admit record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
