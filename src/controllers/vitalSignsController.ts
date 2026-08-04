import type { Context } from 'elysia';
import { nurse, his } from '../db';
import type { RowDataPacket } from 'mysql2';
import { sanitizeHTML } from '../utils/sanitize';
import { toLocalDate, shiftOfTime, resolveActor } from '../utils/nursingRecord';
import { calcNews2, ageGroupOf, ageYearsFrom, NEWS2_MIN_AGE, type Avpu } from '../utils/news2';

/**
 * คอลัมน์ที่รับจาก client
 * ไม่มี map_value / pulse_pressure / gcs_total เพราะเป็น GENERATED column
 * และไม่มี news2_* เพราะคำนวณที่ server เท่านั้น
 */
const VITAL_FIELDS = [
    // ไม่มี nurse_name / staff_id — ผู้บันทึกมาจาก token เท่านั้น ไม่รับจาก client
    // ไม่มี shift — เวรเป็นผลของ record_datetime ไม่ใช่ค่าที่เลือกเอง จะได้ไม่ขัดกัน
    'ward_code', 'ward_name', 'record_datetime',
    // core five
    'vital_t', 'temp_route',
    'vital_p', 'pulse_rhythm', 'pulse_site',
    'vital_r', 'resp_pattern',
    'vital_bp_s', 'vital_bp_d', 'bp_position', 'bp_site', 'bp_cuff_size', 'bp_method',
    'vital_o2sat', 'o2_therapy', 'o2_device', 'o2_flow', 'fio2',
    // สัญญาณชีพที่ 6
    'pain_score', 'pain_scale', 'avpu', 'consciousness',
    'gcs_e', 'gcs_v', 'gcs_m',
    'blood_glucose', 'glucose_timing', 'urine_output_ml',
    // metadata
    'entry_method', 'device_id', 'late_entry_reason', 'news2_scale',
] as const;

const VITAL_TEXT_FIELDS = ['ward_name', 'nurse_name', 'device_id', 'late_entry_reason'];

/** เกินเท่านี้ถือว่าบันทึกย้อนหลัง ต้องแสดงให้ผู้ตรวจสอบเห็น */
const LATE_ENTRY_MINUTES = 60;
/** ย้อนหลังเกินเท่านี้ต้องระบุเหตุผล */
const REASON_REQUIRED_HOURS = 24;

const minutesBetween = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60000;

const sanitizeRow = (row: Record<string, unknown>) => {
    const out = { ...row };
    for (const f of VITAL_TEXT_FIELDS) {
        if (typeof out[f] === 'string') out[f] = sanitizeHTML(out[f] as string);
    }
    const measured = out.record_datetime instanceof Date ? out.record_datetime : null;
    const entered = out.entered_at instanceof Date ? out.entered_at : null;
    out.is_late_entry =
        measured !== null && entered !== null && minutesBetween(measured, entered) > LATE_ENTRY_MINUTES;
    return out;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ช่วงค่าที่ยอมรับ ให้ตรงกับ CHECK constraint เพื่อคืน 400 แทนที่จะพังเป็น 500 */
const RANGES: Record<string, [number, number, boolean]> = {
    // [min, max, ต้องเป็นจำนวนเต็ม]
    vital_t: [30, 45, false],
    vital_p: [20, 300, true],
    vital_r: [5, 60, true],
    vital_bp_s: [50, 300, true],
    vital_bp_d: [20, 200, true],
    vital_o2sat: [0, 100, true],
    o2_flow: [0, 80, false],
    fio2: [21, 100, true],
    pain_score: [0, 10, true],
    gcs_e: [1, 4, true],
    gcs_v: [1, 5, true],
    gcs_m: [1, 6, true],
    blood_glucose: [10, 900, false],
    urine_output_ml: [0, 20000, true],
};

/**
 * ค่าที่ยอมรับของแต่ละคอลัมน์ ต้องตรงกับ CHECK constraint ในฐานข้อมูล
 * ถ้าไม่ดักตรงนี้ ค่าผิดจะไปพังที่ Postgres แล้วกลายเป็น 500 ซึ่งบอกไม่ได้ว่าผิดที่ฟิลด์ไหน
 */
const ENUMS: Record<string, string[]> = {
    temp_route: ['oral', 'axillary', 'tympanic', 'rectal', 'temporal'],
    pulse_rhythm: ['regular', 'irregular'],
    pulse_site: ['radial', 'apical', 'carotid', 'brachial', 'monitor'],
    resp_pattern: ['regular', 'shallow', 'labored', 'apnea', 'cheyne_stokes', 'kussmaul'],
    bp_position: ['supine', 'sitting', 'standing'],
    bp_site: ['left_arm', 'right_arm', 'left_leg', 'right_leg'],
    bp_cuff_size: ['child', 'small_adult', 'adult', 'large_adult', 'thigh'],
    bp_method: ['manual', 'automatic', 'arterial_line'],
    o2_therapy: ['room_air', 'on_oxygen'],
    o2_device: ['cannula', 'simple_mask', 'mask_with_bag', 'venturi', 'hfnc', 'cpap', 'bipap', 'ventilator', 't_piece'],
    pain_scale: ['NRS', 'VAS', 'Wong-Baker', 'FLACC', 'BPS', 'CRIES'],
    avpu: ['A', 'C', 'V', 'P', 'U'],
    glucose_timing: ['fasting', 'pre_meal', 'post_meal', 'random', 'bedtime'],
    consciousness: ['Alert', 'Drowsy', 'Stupor', 'Coma'],
};

/** ความยาวสูงสุดตามชนิดคอลัมน์ กันข้อความยาวเกินไปทำให้ INSERT พัง */
const MAX_LENGTH: Record<string, number> = {
    an: 20, ward_code: 20, ward_name: 100, device_id: 50, late_entry_reason: 2000,
};

const LABELS: Record<string, string> = {
    vital_t: 'อุณหภูมิ', vital_p: 'ชีพจร', vital_r: 'อัตราการหายใจ',
    vital_bp_s: 'ความดันตัวบน', vital_bp_d: 'ความดันตัวล่าง', vital_o2sat: 'SpO₂',
    o2_flow: 'อัตราไหลออกซิเจน', fio2: 'FiO₂', pain_score: 'คะแนนความปวด',
    gcs_e: 'GCS Eye', gcs_v: 'GCS Verbal', gcs_m: 'GCS Motor',
    blood_glucose: 'ระดับน้ำตาล', urine_output_ml: 'ปัสสาวะ',
    temp_route: 'วิธีวัดอุณหภูมิ', pulse_rhythm: 'จังหวะชีพจร', pulse_site: 'ตำแหน่งคลำชีพจร',
    resp_pattern: 'ลักษณะการหายใจ', bp_position: 'ท่าวัดความดัน', bp_site: 'ตำแหน่งวัดความดัน',
    bp_cuff_size: 'ขนาด cuff', bp_method: 'วิธีวัดความดัน',
    o2_therapy: 'สภาวะขณะวัด SpO₂', o2_device: 'อุปกรณ์ให้ออกซิเจน',
    pain_scale: 'เครื่องมือประเมินความปวด', avpu: 'ระดับความรู้สึกตัว',
    glucose_timing: 'ช่วงเวลาที่เจาะน้ำตาล', consciousness: 'ระดับความรู้สึกตัว',
    an: 'AN', ward_code: 'รหัสหอผู้ป่วย', ward_name: 'ชื่อหอผู้ป่วย',
    device_id: 'รหัสเครื่อง', late_entry_reason: 'เหตุผลที่บันทึกย้อนหลัง',
};

/** อายุจริงจาก HIS — ไม่รับจาก client เพราะช่วงค่าปกติและการใช้ NEWS2 ขึ้นกับอายุ */
const fetchAgeYears = async (an: string): Promise<number | null> => {
    try {
        const [rows] = await his.execute<RowDataPacket[]>(
            `SELECT p.birthday FROM ipt i LEFT JOIN patient p ON p.hn = i.hn WHERE i.an = ? LIMIT 1`,
            [an]
        );
        return ageYearsFrom(rows[0]?.birthday);
    } catch (error) {
        console.error('Fetch patient age error:', error);
        return null;
    }
};

// ---------- ดึงสัญญาณชีพตาม AN ----------
export const getVitalRecordsByAN = async ({ params, query, set }: Context) => {
    const { an } = params as { an: string };
    const { limit } = (query ?? {}) as { limit?: string };

    if (!an?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    const take = Math.min(Math.max(Number(limit) || 300, 1), 1000);

    try {
        const rows = await nurse`
            SELECT *
            FROM nursing_vital_records
            WHERE an = ${an.trim()}
              AND is_deleted IS NOT TRUE
            ORDER BY record_datetime DESC, id DESC
            LIMIT ${take}
        `;

        const ageYears = await fetchAgeYears(an.trim());

        return {
            success: true,
            data: rows.map(r => sanitizeRow(r as Record<string, unknown>)),
            patient: {
                age_years: ageYears === null ? null : Math.floor(ageYears),
                age_group: ageGroupOf(ageYears),
                // แยก "ไม่รู้อายุ" ออกจาก "เป็นเด็ก" เพราะทั้งคู่ไม่คิด NEWS2 เหมือนกัน
                // แต่คนละเหตุผล และ HIS มีผู้ป่วยที่ไม่มีวันเกิดอยู่จำนวนมาก
                age_known: ageYears !== null,
                news2_applicable: ageYears !== null && ageYears >= NEWS2_MIN_AGE,
            },
        };
    } catch (error) {
        console.error('Get vital records error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- บันทึกสัญญาณชีพ ----------
export const saveVitalRecord = async ({ body, set, user }: Context & { user: any }) => {
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

    // กุญแจกันส่งซ้ำจากหน้าจอ: ส่ง payload เดิมกี่รอบก็ได้แถวเดียว
    // ครอบคลุมทั้งกดปุ่มรัว เน็ตค้างแล้ว retry และกด back แล้วส่งใหม่
    const requestId =
        typeof payload.request_id === 'string' && UUID_RE.test(payload.request_id)
            ? payload.request_id
            : null;

    if (requestId) {
        const seen = await nurse`
            SELECT * FROM nursing_vital_records WHERE request_id = ${requestId} LIMIT 1
        `;
        if (seen.length > 0) {
            // ไม่ใช่ error — คำขอเดิมสำเร็จไปแล้ว คืนผลเดิมกลับไปให้เหมือนกัน
            return {
                success: true,
                duplicate: true,
                message: 'บันทึกนี้ถูกบันทึกไว้แล้ว ระบบไม่ได้บันทึกซ้ำ',
                data: sanitizeRow(seen[0] as Record<string, unknown>),
            };
        }
    }

    // ชื่อผู้บันทึกมาจากบัญชีที่เข้าสู่ระบบ ไม่ใช่จากฟอร์ม
    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    // รับเฉพาะคอลัมน์ที่รู้จัก ค่าว่างเป็น null ให้ตรงกับชนิดคอลัมน์
    const values: Record<string, unknown> = {};
    for (const f of VITAL_FIELDS) {
        const v = payload[f];
        values[f] = v === undefined || v === '' ? null : v;
    }

    // ตรวจช่วงค่าก่อนถึงฐานข้อมูล เพื่อบอกได้ว่าฟิลด์ไหนผิด
    for (const [field, [min, max, mustBeInt]] of Object.entries(RANGES)) {
        const raw = values[field];
        if (raw === null) continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < min || n > max || (mustBeInt && !Number.isInteger(n))) {
            set.status = 400;
            const kind = mustBeInt ? 'จำนวนเต็ม' : 'ตัวเลข';
            return { success: false, message: `${LABELS[field] ?? field} ต้องเป็น${kind} ${min}–${max}` };
        }
        values[field] = n;
    }

    // ค่า enum ต้องตรงกับที่ฐานข้อมูลยอมรับ
    for (const [field, allowed] of Object.entries(ENUMS)) {
        const raw = values[field];
        if (raw === null) continue;
        if (!allowed.includes(String(raw))) {
            set.status = 400;
            return { success: false, message: `${LABELS[field] ?? field} มีค่าไม่ถูกต้อง` };
        }
    }

    // ความยาวข้อความต้องไม่เกินขนาดคอลัมน์
    for (const [field, max] of Object.entries(MAX_LENGTH)) {
        const raw = field === 'an' ? an : values[field];
        if (raw === null || raw === undefined) continue;
        if (String(raw).length > max) {
            set.status = 400;
            return { success: false, message: `${LABELS[field] ?? field} ยาวเกิน ${max} ตัวอักษร` };
        }
    }

    const sbp = values.vital_bp_s as number | null;
    const dbp = values.vital_bp_d as number | null;
    if (sbp !== null && dbp !== null && dbp >= sbp) {
        set.status = 400;
        return { success: false, message: 'ความดันตัวล่างต้องน้อยกว่าตัวบน' };
    }
    if ((sbp === null) !== (dbp === null)) {
        set.status = 400;
        return { success: false, message: 'กรุณากรอกความดันทั้งตัวบนและตัวล่าง' };
    }

    // ให้ออกซิเจนแล้วต้องรู้ว่าอุปกรณ์อะไร ไม่งั้นค่า SpO₂ ตีความไม่ได้
    const onOxygen = values.o2_therapy === 'on_oxygen';
    if (onOxygen && !values.o2_device) {
        set.status = 400;
        return { success: false, message: 'ระบุออกซิเจนแล้ว กรุณาเลือกอุปกรณ์ที่ใช้' };
    }
    if (!onOxygen) {
        values.o2_device = null;
        values.o2_flow = null;
        values.fio2 = null;
    }

    const now = new Date();
    const recordDatetime = toLocalDate(values.record_datetime) ?? now;

    // เวลาวัดล่วงหน้าเป็นไปไม่ได้ กันพิมพ์วันที่ผิด
    if (recordDatetime.getTime() - now.getTime() > 5 * 60 * 1000) {
        set.status = 400;
        return { success: false, message: 'เวลาที่วัดต้องไม่เป็นเวลาในอนาคต' };
    }

    const backdatedHours = (now.getTime() - recordDatetime.getTime()) / 3600000;
    const reason = String(values.late_entry_reason ?? '').trim();
    if (backdatedHours > REASON_REQUIRED_HOURS && reason.length < 5) {
        set.status = 400;
        return {
            success: false,
            message: `บันทึกย้อนหลังเกิน ${REASON_REQUIRED_HOURS} ชั่วโมง กรุณาระบุเหตุผล`,
        };
    }

    // ผู้ป่วยหนึ่งคนมีสัญญาณชีพของเวลาเดียวกันได้ครั้งเดียว
    // ดักไว้ก่อนเพื่อบอกได้ว่าใครบันทึกไว้ ไม่ปล่อยให้ไปชน unique index แล้วได้ข้อความดิบ
    const clash = await nurse`
        SELECT * FROM nursing_vital_records
        WHERE an = ${an} AND record_datetime = ${recordDatetime}
          AND is_deleted IS NOT TRUE
        LIMIT 1
    `;
    if (clash.length > 0) {
        const row = clash[0] as Record<string, unknown>;

        // แถวที่ชนคือคำขอเดียวกันกับที่ส่งมา แปลว่าเป็นการส่งซ้ำ ไม่ใช่การกรอกซ้ำ
        // เกิดตอนคำขอหลายอันแข่งกัน อันที่แพ้เช็ค request_id ก่อนตัวชนะจะ commit
        if (requestId && row.request_id === requestId) {
            return {
                success: true,
                duplicate: true,
                message: 'บันทึกนี้ถูกบันทึกไว้แล้ว ระบบไม่ได้บันทึกซ้ำ',
                data: sanitizeRow(row),
            };
        }

        set.status = 409;
        const by = String(row.nurse_name ?? '').trim();
        return {
            success: false,
            message: `มีบันทึกสัญญาณชีพของเวลานี้อยู่แล้ว${by ? ` (บันทึกโดย ${by})` : ''} `
                + 'หากต้องการวัดซ้ำ กรุณาแก้เวลาที่วัดให้ตรงกับความจริง',
            existing_id: row.id,
        };
    }

    const ageYears = await fetchAgeYears(an);
    const ageGroup = ageGroupOf(ageYears);

    // NEWS2 ใช้กับผู้ใหญ่เท่านั้น เด็กต้องใช้ PEWS ซึ่งเกณฑ์คนละชุด
    const news2Scale = Number(values.news2_scale) === 2 ? 2 : 1;
    const news2 =
        ageYears !== null && ageYears >= NEWS2_MIN_AGE
            ? calcNews2({
                  resp_rate: values.vital_r as number | null,
                  spo2: values.vital_o2sat as number | null,
                  on_oxygen: onOxygen,
                  temperature: values.vital_t as number | null,
                  systolic_bp: sbp,
                  pulse: values.vital_p as number | null,
                  avpu: (values.avpu as Avpu) ?? null,
                  scale: news2Scale,
              })
            : null;

    values.nurse_name = actor.fullname;
    values.staff_id = actor.userId;
    values.record_datetime = recordDatetime;
    values.shift = shiftOfTime(recordDatetime);
    values.late_entry_reason = reason || null;
    values.entry_method = values.entry_method === 'monitor_import' ? 'monitor_import' : 'manual';
    values.entered_at = now;
    values.patient_age_years = ageYears === null ? null : Math.floor(ageYears);
    values.age_group = ageGroup;
    values.news2_scale = news2 ? news2Scale : null;
    values.news2_score = news2?.score ?? null;
    values.news2_risk = news2?.risk ?? null;
    values.news2_breakdown = news2 ? nurse.json(news2 as never) : null;
    values.monitor_freq = news2?.monitorFreq ?? null;

    try {
        // ทุกครั้งที่วัดคือแถวใหม่ ต้องเห็นแนวโน้มย้อนหลังได้
        const saved = await nurse`
            INSERT INTO nursing_vital_records ${nurse({
                an,
                ...values,
                request_id: requestId,
                created_at: now,
                created_by: actor.username,
            })}
            RETURNING *
        `;

        return {
            success: true,
            message: 'บันทึกสัญญาณชีพเรียบร้อยแล้ว',
            data: sanitizeRow(saved[0] as Record<string, unknown>),
            news2,
        };
    } catch (error) {
        // สองคำขอที่เหมือนกันมาถึงพร้อมกัน ทั้งคู่ผ่านการตรวจก่อนหน้าแล้วมาชนที่ index
        // unique index คือด่านสุดท้ายที่การตรวจล่วงหน้ากันไม่ได้
        const code = (error as { code?: string })?.code;
        if (code === '23505') {
            // ถามจาก request_id เสมอ ไม่ดูว่าชนที่ index ไหน
            // คำขอที่แข่งกันอาจไปชน (an, record_datetime) ก่อนก็ได้ แต่ถ้า request_id ตรงกัน
            // แปลว่าเป็นคำขอเดิมที่สำเร็จไปแล้ว ไม่ใช่ความผิดพลาดของผู้ใช้
            if (requestId) {
                const seen = await nurse`
                    SELECT * FROM nursing_vital_records WHERE request_id = ${requestId} LIMIT 1
                `;
                if (seen.length > 0) {
                    return {
                        success: true,
                        duplicate: true,
                        message: 'บันทึกนี้ถูกบันทึกไว้แล้ว ระบบไม่ได้บันทึกซ้ำ',
                        data: sanitizeRow(seen[0] as Record<string, unknown>),
                    };
                }
            }

            set.status = 409;
            return {
                success: false,
                message: 'มีบันทึกสัญญาณชีพของเวลานี้อยู่แล้ว กรุณาแก้เวลาที่วัดให้ตรงกับความจริง',
            };
        }

        console.error('Save vital record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ลบสัญญาณชีพ (soft delete) ----------
export const deleteVitalRecord = async ({ params, set, user }: Context & { user: any }) => {
    const { id } = params as { id: string };
    const recordId = Number(id);

    if (!Number.isInteger(recordId) || recordId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const actor = String((user as { username?: unknown } | null)?.username ?? '') || null;

    try {
        // เก็บแถวไว้เสมอเพื่อการตรวจสอบย้อนหลัง
        const deleted = await nurse`
            UPDATE nursing_vital_records
            SET is_deleted = TRUE, updated_at = ${new Date()}, updated_by = ${actor}
            WHERE id = ${recordId}
              AND is_deleted IS NOT TRUE
            RETURNING id
        `;

        if (deleted.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบรายการที่ต้องการลบ' };
        }

        return { success: true, message: 'ลบรายการเรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Delete vital record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
