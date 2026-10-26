import type { PendingQuery, Row } from 'postgres';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor, toLocalDate, shiftOfTime, type Actor } from '../utils/nursingRecord';

/**
 * บันทึกการให้ยา (MAR) แบบมีโครงสร้าง — ดู sql/2026-10-22_mar_structured.sql
 *
 * หลักของไฟล์นี้: ทุกอย่างที่จะเอาไปวิเคราะห์ต้องเป็นค่าที่นับได้ ไม่ใช่ข้อความ
 *   คำสั่งยา  → มีมื้อที่ต้องให้ (schedule_times) จึงรู้ว่าวันหนึ่ง "ควร" มีกี่มื้อ เวลาไหน
 *   การให้ยา → ผูกกับมื้อ (scheduled_at) จึงวัดความตรงเวลาและหามื้อที่ไม่มีบันทึกได้
 *   เหตุผลงดยา → เป็นรหัส · ยาความเสี่ยงสูง → มีผู้ตรวจซ้ำ · PRN → มีคะแนนก่อน/หลัง
 *
 * ผู้บันทึก ผู้ตรวจทาน ผู้ตรวจซ้ำ มาจากบัญชีในระบบเสมอ ไม่รับชื่อจาก client
 * เพราะเป็นเวชระเบียนที่ใช้อ้างอิงทางกฎหมายว่าใครเป็นคนให้ยา
 */

/* ───────────────────────── รหัสมาตรฐาน ───────────────────────── */

export const ROUTES = ['PO', 'SL', 'IV', 'IM', 'SC', 'ID', 'PR', 'INH', 'NEB', 'TOP', 'EYE', 'EAR', 'NASAL', 'NG', 'PV', 'OTHER'];

/** จำนวนมื้อต่อวันของแต่ละความถี่ — null = ไม่มีมื้อประจำ (ครั้งเดียว / เมื่อมีอาการ) */
const DOSES_PER_DAY: Record<string, number | null> = {
    OD: 1, BID: 2, TID: 3, QID: 4, Q4H: 6, Q6H: 4, Q8H: 3, Q12H: 2, HS: 1,
    STAT: null, ONCE: null, PRN: null,
};

export const DRUG_CLASSES = [
    'ANTIBIOTIC', 'OPIOID', 'ANALGESIC', 'ANTICOAGULANT', 'INSULIN', 'ORAL_HYPOGLYCEMIC',
    'CARDIOVASCULAR', 'CONC_ELECTROLYTE', 'SEDATIVE', 'ANTICONVULSANT', 'GI', 'RESPIRATORY',
    'STEROID', 'CHEMOTHERAPY', 'VITAMIN', 'OTHER',
];

/**
 * กลุ่มที่เป็นยาความเสี่ยงสูงเสมอ (ISMP high-alert) — server ตั้งธงให้เอง ปลดไม่ได้
 * ถ้าปล่อยให้เลือกเอง วันที่ลืมติ๊กคือวันที่ insulin ถูกให้โดยไม่มีใครตรวจซ้ำ
 */
const HIGH_ALERT_CLASSES = ['OPIOID', 'ANTICOAGULANT', 'INSULIN', 'CONC_ELECTROLYTE', 'SEDATIVE', 'CHEMOTHERAPY'];

const REASON_CODES = [
    'NPO', 'PATIENT_REFUSED', 'DRUG_UNAVAILABLE', 'HOLD_PARAMETER', 'PATIENT_AWAY',
    'DOCTOR_HOLD', 'ADVERSE_REACTION', 'VOMITING', 'OTHER',
];
const ADMIN_STATUSES = ['given', 'held', 'refused', 'omitted'];

/** ช่วงที่ถือว่าตรงเวลา (นาที) — ยาที่ต้องตรงเวลาเข้ม ±30 · ยาทั่วไป ±60 ตามแนวทาง ISMP */
const windowOf = (timeCritical: boolean) => (timeCritical ? 30 : 60);

const MAX_RANGE_DAYS = 366;

/* ───────────────────────── ตัวช่วย ───────────────────────── */

/**
 * ข้อความอิสระ: ตัดแท็ก HTML ทิ้ง แต่เก็บเป็นข้อความธรรมดา
 *
 * sanitize-html แปลง < > & เป็น entity ด้วย ถ้าเก็บแบบนั้น ข้อความทางคลินิกอย่าง "pain >= 5"
 * จะขึ้นจอเป็น "pain &gt;= 5" (React escape ข้อความให้เองอยู่แล้ว ไม่ต้องเข้ารหัสซ้ำ)
 */
const plain = (v: unknown): string | null => {
    const s = sanitizeHTML(String(v ?? ''));
    if (s === null) return null;
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
};
const clean = (v: unknown, max = 500) => {
    const s = plain(String(v ?? '').trim()) ?? '';
    return s ? s.slice(0, max) : null;
};
const pad = (n: number) => String(n).padStart(2, '0');
/**
 * เวลาท้องถิ่นเป็นข้อความ ส่งเข้าคอลัมน์ timestamp (ไม่มีโซนเวลา) ตรงๆ
 *
 * ทุกที่ที่ส่งค่านี้เข้า SQL ต้องเขียน ${x}::text::timestamp ไม่ใช่ ${x}::timestamp
 * เพราะเมื่อพารามิเตอร์มีชนิด timestamp/date postgres.js จะแปลงข้อความผ่าน new Date(x).toISOString()
 * ซึ่งเป็น UTC เวลาที่บันทึกจะเร็วไป 7 ชั่วโมงทุกแถว (เจอตอนทดสอบ: มื้อ 21:00 กลายเป็น 14:00)
 */
const localStr = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const isDay = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(String(v)));
const isTime = (v: unknown) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? ''));

const bad = (set: { status?: number | string }, message: string, status = 400) => {
    set.status = status;
    return { success: false, message };
};

const fail = (set: { status?: number | string }, where: string, error: unknown) => {
    console.error(`MAR ${where} error:`, error);
    set.status = 500;
    return { success: false, message: 'Internal Server Error' };
};

type Set = { status?: number | string };

/** ข้อความแสดงผลที่ server ประกอบให้ ช่อง dose/frequency เดิมจึงอ่านได้เหมือนเดิม */
const doseText = (value: number, unit: string) => `${Number(value)} ${unit}`.trim();
const freqText = (code: string, times: string[] | null) => (times?.length ? `${code} ${times.join(', ')}` : code);

const orderCols = () => nurse`
    id::int AS id, an, hn, ward_code, ward_name, medication_name, generic_name,
    dose, dose_value::float8 AS dose_value, dose_unit, route, frequency, frequency_code,
    ARRAY(SELECT TO_CHAR(t, 'HH24:MI') FROM unnest(schedule_times) t ORDER BY t) AS schedule_times,
    TO_CHAR(COALESCE(start_datetime, start_date::timestamp), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_datetime,
    TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date,
    prn, prn_reason, prn_min_interval_hours::float8 AS prn_min_interval_hours, prn_max_per_day,
    time_critical, high_alert, drug_class, status, doctor_name, note,
    created_by, created_by_name, TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
    verified_by, verified_by_name, TO_CHAR(verified_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS verified_at,
    TO_CHAR(discontinued_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS discontinued_at, discontinued_by, discontinue_reason`;

const adminCols = () => nurse`
    a.id::int AS id, a.order_id::int AS order_id, a.an, a.ward_code, a.ward_name, a.staff_id, a.nurse_name,
    TO_CHAR(a.admin_datetime, 'YYYY-MM-DD"T"HH24:MI:SS') AS admin_datetime,
    TO_CHAR(a.scheduled_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS scheduled_at,
    a.shift, a.medication_name, a.dose_given, a.dose_value::float8 AS dose_value, a.dose_unit, a.route, a.site,
    a.status, a.reason_code, a.held_reason, a.double_checked_by, a.double_checked_by_name,
    a.prn_indication, a.pre_score, a.post_score, TO_CHAR(a.reassessed_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS reassessed_at,
    a.adverse_reaction, a.adverse_note, a.note`;

const TEXT_FIELDS = ['ward_name', 'medication_name', 'generic_name', 'dose', 'frequency', 'prn_reason', 'doctor_name',
    'note', 'created_by_name', 'verified_by_name', 'discontinue_reason', 'nurse_name', 'dose_given', 'site',
    'held_reason', 'double_checked_by_name', 'prn_indication', 'adverse_note'];

const sanitizeRow = <T extends Record<string, unknown>>(row: T): T => {
    const out: Record<string, unknown> = { ...row };
    for (const f of TEXT_FIELDS) if (typeof out[f] === 'string') out[f] = plain(out[f]);
    return out as T;
};

const requireActor = async (user: unknown, set: Set): Promise<Actor | { error: ReturnType<typeof bad> }> => {
    const actor = await resolveActor(user);
    if (!actor) return { error: bad(set, 'ไม่พบข้อมูลผู้ใช้ในระบบบุคลากร', 401) };
    return actor;
};

/* ───────────────────────── มื้อที่ควรให้ ───────────────────────── */

interface Slot {
    order_id: number;
    an: string;
    ward_code: string;
    ward_name: string | null;
    medication_name: string;
    drug_class: string | null;
    high_alert: boolean;
    time_critical: boolean;
    verified: boolean;
    scheduled_at: string;
    admin_id: number | null;
    admin_status: string | null;
    admin_datetime: string | null;
    reason_code: string | null;
    double_checked: boolean;
}

/**
 * ขยายคำสั่งยาเป็นมื้อที่ควรให้ในช่วงเวลา แล้วจับคู่กับบันทึกการให้ยาของมื้อนั้น
 *
 * มื้อประจำ = ทุกวันในช่วงของคำสั่ง × เวลาใน schedule_times · STAT/ONCE = หนึ่งมื้อที่เวลาเริ่มคำสั่ง
 * ตัดมื้อก่อนเวลาเริ่มคำสั่ง และมื้อตั้งแต่เวลาที่หยุดยา (discontinue) ออก
 * PRN ไม่มีมื้อ จึงไม่อยู่ในนี้ (วัดแยกด้วยคะแนนก่อน/หลัง)
 */
const loadSlots = async (filter: PendingQuery<Row[]>, from: string, to: string): Promise<Slot[]> => {
    const rows = await nurse`
        WITH o AS (
            SELECT id, an, ward_code, ward_name, medication_name, drug_class, high_alert, time_critical,
                   verified_by IS NOT NULL AS verified, frequency_code, schedule_times, start_date, end_date,
                   COALESCE(start_datetime, start_date::timestamp) AS start_at, discontinued_at
            FROM nursing_medication_orders
            WHERE is_deleted IS NOT TRUE
              AND frequency_code IS NOT NULL AND frequency_code <> 'PRN'
              AND ${filter}
        ), s AS (
            SELECT o.*, (d::date + t)::timestamp AS scheduled_at
            FROM o
            CROSS JOIN LATERAL unnest(o.schedule_times) AS t
            CROSS JOIN LATERAL generate_series(
                GREATEST(o.start_date, ${from}::text::date),
                LEAST(COALESCE(o.end_date, ${to}::text::date), ${to}::text::date),
                INTERVAL '1 day') AS d
            WHERE o.schedule_times IS NOT NULL
            UNION ALL
            SELECT o.*, o.start_at FROM o WHERE o.frequency_code IN ('STAT', 'ONCE')
        )
        SELECT s.id AS order_id, s.an, s.ward_code, s.ward_name, s.medication_name, s.drug_class,
               s.high_alert, s.time_critical, s.verified,
               TO_CHAR(s.scheduled_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS scheduled_at,
               a.id AS admin_id, a.status AS admin_status,
               TO_CHAR(a.admin_datetime, 'YYYY-MM-DD"T"HH24:MI:SS') AS admin_datetime,
               a.reason_code, (a.double_checked_by IS NOT NULL) AS double_checked
        FROM s
        LEFT JOIN nursing_medication_admins a
               ON a.order_id = s.id AND a.scheduled_at = s.scheduled_at AND a.is_deleted IS NOT TRUE
        WHERE s.scheduled_at >= s.start_at
          AND (s.discontinued_at IS NULL OR s.scheduled_at < s.discontinued_at)
          AND s.scheduled_at BETWEEN ${from}::text::timestamp AND ${to}::text::timestamp
        ORDER BY s.scheduled_at, s.id`;
    return rows.map(r => ({
        order_id: Number(r.order_id),
        an: String(r.an),
        ward_code: String(r.ward_code),
        ward_name: r.ward_name ? plain(r.ward_name) : null,
        medication_name: plain(r.medication_name) ?? '',
        drug_class: r.drug_class ? String(r.drug_class) : null,
        high_alert: Boolean(r.high_alert),
        time_critical: Boolean(r.time_critical),
        verified: Boolean(r.verified),
        scheduled_at: String(r.scheduled_at),
        admin_id: r.admin_id === null ? null : Number(r.admin_id),
        admin_status: r.admin_status ? String(r.admin_status) : null,
        admin_datetime: r.admin_datetime ? String(r.admin_datetime) : null,
        reason_code: r.reason_code ? String(r.reason_code) : null,
        double_checked: Boolean(r.double_checked),
    }));
};

type SlotState = 'on_time' | 'late' | 'early' | 'not_given' | 'missed' | 'due' | 'upcoming';

/**
 * สถานะของมื้อหนึ่ง
 *   มีบันทึก "ให้แล้ว" → ตรงเวลา / ช้า / เร็ว ตามช่วงของยานั้น
 *   มีบันทึก "ไม่ได้ให้" (held/refused/omitted) → not_given (มีเหตุผล ไม่ใช่ความคลาดเคลื่อน)
 *   ไม่มีบันทึก: ยังไม่ถึงช่วง = upcoming · อยู่ในช่วง = due · เลยช่วงแล้ว = missed
 */
const stateOf = (s: Slot, now: Date): { state: SlotState; delay: number | null } => {
    const due = toLocalDate(s.scheduled_at)!;
    const w = windowOf(s.time_critical);
    if (s.admin_status) {
        if (s.admin_status !== 'given') return { state: 'not_given', delay: null };
        const delay = Math.round((toLocalDate(s.admin_datetime)!.getTime() - due.getTime()) / 60000);
        return { state: Math.abs(delay) <= w ? 'on_time' : delay > 0 ? 'late' : 'early', delay };
    }
    const diff = (now.getTime() - due.getTime()) / 60000;
    if (diff < -w) return { state: 'upcoming', delay: null };
    if (diff <= w) return { state: 'due', delay: null };
    return { state: 'missed', delay: null };
};

/* ───────────────────────── คำสั่งยา ───────────────────────── */

export const getMarOrders = async ({ params, set }: { params: { an: string }; set: Set }) => {
    const an = String(params.an ?? '').trim();
    if (!an) return bad(set, 'กรุณาระบุ an');
    try {
        const rows = await nurse`
            SELECT ${orderCols()}
            FROM nursing_medication_orders
            WHERE an = ${an} AND is_deleted IS NOT TRUE
            ORDER BY (discontinued_at IS NULL) DESC, COALESCE(start_datetime, start_date::timestamp) DESC, id DESC`;
        return { success: true, data: rows.map(r => sanitizeRow(r)) };
    } catch (error) {
        return fail(set, 'get orders', error);
    }
};

interface OrderBody {
    an: string; hn?: string; ward_code: string; ward_name?: string;
    medication_name: string; generic_name?: string;
    dose_value: number; dose_unit: string; route: string;
    frequency_code: string; schedule_times?: string[] | null;
    start_datetime: string; end_date?: string | null;
    prn_reason?: string; prn_min_interval_hours?: number | null; prn_max_per_day?: number | null;
    time_critical?: boolean; high_alert?: boolean; drug_class?: string;
    doctor_name?: string; note?: string;
}

/** ตรวจและแปลงคำสั่งยา คืนข้อความผิดพลาด หรือค่าที่พร้อมบันทึก */
const parseOrder = (b: OrderBody) => {
    const name = clean(b.medication_name, 200);
    if (!name) return 'กรุณาระบุชื่อยา';
    const dose = Number(b.dose_value);
    if (!Number.isFinite(dose) || dose <= 0 || dose > 1_000_000) return 'ขนาดยาต้องเป็นตัวเลขมากกว่า 0';
    const unit = clean(b.dose_unit, 20);
    if (!unit) return 'กรุณาระบุหน่วยของขนาดยา';
    if (!ROUTES.includes(b.route)) return 'ทางให้ยาไม่ถูกต้อง';
    const code = String(b.frequency_code ?? '');
    if (!(code in DOSES_PER_DAY)) return 'ความถี่ไม่ถูกต้อง';

    const perDay = DOSES_PER_DAY[code];
    let times: string[] | null = null;
    if (perDay !== null) {
        const list = [...new Set((b.schedule_times ?? []).map(String))].sort();
        if (!list.every(isTime)) return 'เวลาให้ยาต้องอยู่ในรูปแบบ HH:mm';
        // จำนวนมื้อต้องตรงกับความถี่ ไม่งั้น BID ที่ใส่เวลาเดียวจะทำให้ทุกวันขาดหายไปหนึ่งมื้อโดยไม่มีใครเห็น
        if (list.length !== perDay) return `${code} ต้องมีเวลาให้ยา ${perDay} เวลาต่อวัน`;
        times = list;
    }

    const start = toLocalDate(b.start_datetime);
    if (!start) return 'กรุณาระบุวันเวลาเริ่มให้ยา';
    let end: string | null = null;
    if (b.end_date) {
        if (!isDay(b.end_date)) return 'วันสิ้นสุดไม่ถูกต้อง';
        if (b.end_date < localStr(start).slice(0, 10)) return 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม';
        end = b.end_date;
    }

    const prn = code === 'PRN';
    const prnReason = clean(b.prn_reason, 200);
    if (prn && !prnReason) return 'ยา PRN ต้องระบุข้อบ่งชี้ (ให้เมื่อ...)';
    const interval = b.prn_min_interval_hours === null || b.prn_min_interval_hours === undefined ? null : Number(b.prn_min_interval_hours);
    if (interval !== null && (!Number.isFinite(interval) || interval <= 0 || interval > 72)) return 'ระยะห่างขั้นต่ำของยา PRN ไม่ถูกต้อง';
    const maxDay = b.prn_max_per_day === null || b.prn_max_per_day === undefined ? null : Number(b.prn_max_per_day);
    if (maxDay !== null && (!Number.isInteger(maxDay) || maxDay <= 0 || maxDay > 48)) return 'จำนวนครั้งสูงสุดต่อวันไม่ถูกต้อง';

    const cls = b.drug_class ? String(b.drug_class) : 'OTHER';
    if (!DRUG_CLASSES.includes(cls)) return 'กลุ่มยาไม่ถูกต้อง';

    return {
        medication_name: name,
        generic_name: clean(b.generic_name, 200),
        dose_value: dose,
        dose_unit: unit,
        dose: doseText(dose, unit),
        route: b.route,
        frequency_code: code,
        frequency: freqText(code, times),
        schedule_times: times,
        start_datetime: localStr(start),
        start_date: localStr(start).slice(0, 10),
        end_date: end,
        prn,
        prn_reason: prn ? prnReason : null,
        prn_min_interval_hours: prn ? interval : null,
        prn_max_per_day: prn ? maxDay : null,
        time_critical: Boolean(b.time_critical),
        high_alert: Boolean(b.high_alert) || HIGH_ALERT_CLASSES.includes(cls),
        drug_class: cls,
        doctor_name: clean(b.doctor_name, 100),
        note: clean(b.note, 500),
    };
};

export const createMarOrder = async ({ body, set, user }: { body: OrderBody; set: Set; user: unknown }) => {
    const an = String(body?.an ?? '').trim();
    const ward = String(body?.ward_code ?? '').trim();
    if (!an || !ward) return bad(set, 'กรุณาระบุ an และ ward_code');
    const parsed = parseOrder(body);
    if (typeof parsed === 'string') return bad(set, parsed);

    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;

    try {
        const [row] = await nurse`
            INSERT INTO nursing_medication_orders (
                an, hn, ward_code, ward_name, order_datetime, medication_name, generic_name,
                dose, dose_value, dose_unit, route, frequency, frequency_code, schedule_times,
                prn, prn_reason, prn_min_interval_hours, prn_max_per_day,
                start_date, start_datetime, end_date, status, time_critical, high_alert, drug_class,
                doctor_name, note, created_at, created_by, created_by_name)
            VALUES (
                ${an}, ${clean(body.hn, 9)}, ${ward}, ${clean(body.ward_name, 100)}, ${parsed.start_datetime}::text::timestamp,
                ${parsed.medication_name}, ${parsed.generic_name},
                ${parsed.dose}, ${parsed.dose_value}, ${parsed.dose_unit}, ${parsed.route}, ${parsed.frequency},
                ${parsed.frequency_code}, ${parsed.schedule_times}::time[],
                ${parsed.prn}, ${parsed.prn_reason}, ${parsed.prn_min_interval_hours}, ${parsed.prn_max_per_day},
                ${parsed.start_date}::text::date, ${parsed.start_datetime}::text::timestamp, ${parsed.end_date}::text::date, 'active',
                ${parsed.time_critical}, ${parsed.high_alert}, ${parsed.drug_class},
                ${parsed.doctor_name}, ${parsed.note}, ${localStr(new Date())}::text::timestamp, ${actor.username}, ${actor.fullname})
            RETURNING id`;
        return { success: true, message: 'บันทึกคำสั่งยาแล้ว — รอพยาบาลอีกคนตรวจทาน', data: { id: Number(row.id) } };
    } catch (error) {
        return fail(set, 'create order', error);
    }
};

/**
 * แก้คำสั่งยาได้เฉพาะก่อนตรวจทาน
 * หลังตรวจทานแล้วต้องหยุดยาแล้วสั่งใหม่ ประวัติการให้ยาของคำสั่งเดิมจะได้ไม่เปลี่ยนความหมายย้อนหลัง
 */
export const updateMarOrder = async ({ params, body, set, user }: { params: { id: string }; body: OrderBody; set: Set; user: unknown }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return bad(set, 'id ไม่ถูกต้อง');
    const parsed = parseOrder(body);
    if (typeof parsed === 'string') return bad(set, parsed);
    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;

    try {
        const rows = await nurse`
            UPDATE nursing_medication_orders SET
                medication_name = ${parsed.medication_name}, generic_name = ${parsed.generic_name},
                dose = ${parsed.dose}, dose_value = ${parsed.dose_value}, dose_unit = ${parsed.dose_unit},
                route = ${parsed.route}, frequency = ${parsed.frequency}, frequency_code = ${parsed.frequency_code},
                schedule_times = ${parsed.schedule_times}::time[],
                prn = ${parsed.prn}, prn_reason = ${parsed.prn_reason},
                prn_min_interval_hours = ${parsed.prn_min_interval_hours}, prn_max_per_day = ${parsed.prn_max_per_day},
                start_date = ${parsed.start_date}::text::date, start_datetime = ${parsed.start_datetime}::text::timestamp,
                order_datetime = ${parsed.start_datetime}::text::timestamp, end_date = ${parsed.end_date}::text::date,
                time_critical = ${parsed.time_critical}, high_alert = ${parsed.high_alert}, drug_class = ${parsed.drug_class},
                doctor_name = ${parsed.doctor_name}, note = ${parsed.note},
                updated_at = ${localStr(new Date())}::text::timestamp, updated_by = ${actor.username}
            WHERE id = ${id} AND is_deleted IS NOT TRUE AND verified_by IS NULL AND discontinued_at IS NULL
            RETURNING id`;
        if (rows.length === 0) return bad(set, 'แก้ได้เฉพาะคำสั่งที่ยังไม่ได้ตรวจทานและยังไม่หยุดยา — ถ้าตรวจทานแล้วให้หยุดยาแล้วสั่งใหม่', 409);
        return { success: true, message: 'แก้ไขคำสั่งยาแล้ว' };
    } catch (error) {
        return fail(set, 'update order', error);
    }
};

/** พยาบาลวิชาชีพอีกคนตรวจทานคำสั่งที่คัดลอกมา — ผู้คัดลอกตรวจทานของตัวเองไม่ได้ */
export const verifyMarOrder = async ({ params, set, user }: { params: { id: string }; set: Set; user: unknown }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return bad(set, 'id ไม่ถูกต้อง');
    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;
    if (actor.roleClass !== 'professional_nurse') return bad(set, 'ผู้ตรวจทานคำสั่งยาต้องเป็นพยาบาลวิชาชีพ', 403);

    try {
        const [order] = await nurse`SELECT created_by, verified_by FROM nursing_medication_orders WHERE id = ${id} AND is_deleted IS NOT TRUE`;
        if (!order) return bad(set, 'ไม่พบคำสั่งยา', 404);
        if (order.verified_by) return bad(set, 'คำสั่งนี้ตรวจทานแล้ว', 409);
        if (order.created_by === actor.username) return bad(set, 'ผู้คัดลอกคำสั่งตรวจทานคำสั่งของตัวเองไม่ได้ ต้องเป็นพยาบาลอีกคน', 403);
        await nurse`
            UPDATE nursing_medication_orders
            SET verified_by = ${actor.username}, verified_by_name = ${actor.fullname}, verified_at = ${localStr(new Date())}::text::timestamp
            WHERE id = ${id} AND verified_by IS NULL`;
        return { success: true, message: 'ตรวจทานคำสั่งยาแล้ว' };
    } catch (error) {
        return fail(set, 'verify order', error);
    }
};

/** หยุดยา — มื้อหลังเวลาหยุดจะไม่ถูกนับว่าควรให้อีก */
export const discontinueMarOrder = async (
    { params, body, set, user }: { params: { id: string }; body: { reason: string; at?: string }; set: Set; user: unknown }
) => {
    const id = Number(params.id);
    const reason = clean(body?.reason, 300);
    if (!Number.isInteger(id) || id <= 0) return bad(set, 'id ไม่ถูกต้อง');
    if (!reason) return bad(set, 'กรุณาระบุเหตุผลที่หยุดยา');
    const at = toLocalDate(body?.at) ?? new Date();
    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;

    try {
        const rows = await nurse`
            UPDATE nursing_medication_orders
            SET discontinued_at = ${localStr(at)}::text::timestamp, discontinued_by = ${actor.username},
                discontinue_reason = ${reason}, status = 'discontinued',
                updated_at = ${localStr(new Date())}::text::timestamp, updated_by = ${actor.username}
            WHERE id = ${id} AND is_deleted IS NOT TRUE AND discontinued_at IS NULL
            RETURNING id`;
        if (rows.length === 0) return bad(set, 'ไม่พบคำสั่งยา หรือหยุดยาไปแล้ว', 404);
        return { success: true, message: 'หยุดยาแล้ว' };
    } catch (error) {
        return fail(set, 'discontinue order', error);
    }
};

/** ลบคำสั่งที่บันทึกผิด — ทำได้เฉพาะคำสั่งที่ยังไม่มีการให้ยา ถ้ามีแล้วต้องหยุดยาแทน */
export const deleteMarOrder = async (
    { params, body, set, user }: { params: { id: string }; body: { reason: string }; set: Set; user: unknown }
) => {
    const id = Number(params.id);
    const reason = clean(body?.reason, 300);
    if (!Number.isInteger(id) || id <= 0) return bad(set, 'id ไม่ถูกต้อง');
    if (!reason) return bad(set, 'กรุณาระบุเหตุผลที่ลบ');
    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;

    try {
        const [used] = await nurse`SELECT COUNT(*)::int AS n FROM nursing_medication_admins WHERE order_id = ${id} AND is_deleted IS NOT TRUE`;
        if (used.n > 0) return bad(set, 'คำสั่งนี้มีบันทึกการให้ยาแล้ว ลบไม่ได้ ให้ใช้การหยุดยาแทน', 409);
        const rows = await nurse`
            UPDATE nursing_medication_orders
            SET is_deleted = TRUE, deleted_by = ${actor.username}, delete_reason = ${reason},
                updated_at = ${localStr(new Date())}::text::timestamp, updated_by = ${actor.username}
            WHERE id = ${id} AND is_deleted IS NOT TRUE
            RETURNING id`;
        if (rows.length === 0) return bad(set, 'ไม่พบคำสั่งยา', 404);
        return { success: true, message: 'ลบคำสั่งยาแล้ว' };
    } catch (error) {
        return fail(set, 'delete order', error);
    }
};

/* ───────────────────────── การให้ยา ───────────────────────── */

export const getMarAdmins = async ({ params, query, set }: { params: { an: string }; query: { limit?: string }; set: Set }) => {
    const an = String(params.an ?? '').trim();
    if (!an) return bad(set, 'กรุณาระบุ an');
    const take = Math.min(Math.max(Number(query?.limit) || 300, 1), 1000);
    try {
        const rows = await nurse`
            SELECT ${adminCols()}
            FROM nursing_medication_admins a
            WHERE a.an = ${an} AND a.is_deleted IS NOT TRUE
            ORDER BY a.admin_datetime DESC, a.id DESC
            LIMIT ${take}`;
        return { success: true, data: rows.map(r => sanitizeRow(r)) };
    } catch (error) {
        return fail(set, 'get admins', error);
    }
};

/** ตาราง MAR ของผู้ป่วยหนึ่งวัน — มื้อของทุกคำสั่งพร้อมสถานะ ให้หน้าจอวาดช่องตามเวลาได้ทันที */
export const getMarSchedule = async ({ params, query, set }: { params: { an: string }; query: { date?: string }; set: Set }) => {
    const an = String(params.an ?? '').trim();
    const date = query?.date && isDay(query.date) ? query.date : localStr(new Date()).slice(0, 10);
    if (!an) return bad(set, 'กรุณาระบุ an');
    try {
        const slots = await loadSlots(nurse`an = ${an}`, `${date} 00:00:00`, `${date} 23:59:59`);
        const now = new Date();
        return {
            success: true,
            data: {
                date,
                slots: slots.map(s => ({
                    order_id: s.order_id,
                    scheduled_at: s.scheduled_at,
                    window_minutes: windowOf(s.time_critical),
                    admin_id: s.admin_id,
                    admin_status: s.admin_status,
                    admin_datetime: s.admin_datetime,
                    reason_code: s.reason_code,
                    ...stateOf(s, now),
                })),
            },
        };
    } catch (error) {
        return fail(set, 'schedule', error);
    }
};

interface AdminBody {
    order_id: number;
    an: string;
    ward_code: string;
    ward_name?: string;
    scheduled_at?: string | null;
    admin_datetime?: string;
    dose_value?: number | null;
    route?: string;
    site?: string;
    status: string;
    reason_code?: string | null;
    held_reason?: string;
    double_checked_by?: string | null;
    prn_indication?: string;
    pre_score?: number | null;
    post_score?: number | null;
    reassessed_at?: string | null;
    adverse_reaction?: boolean;
    adverse_note?: string;
    note?: string;
}

const scoreOf = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const validScore = (v: number | null) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10);

/**
 * บันทึกการให้ยาหนึ่งครั้ง
 *
 * มื้อประจำต้องระบุมื้อ (scheduled_at) ที่ตรงกับเวลาในคำสั่ง หนึ่งมื้อบันทึกได้ครั้งเดียว
 * ยาความเสี่ยงสูงที่ "ให้แล้ว" ต้องมีพยาบาลวิชาชีพอีกคนตรวจซ้ำ (ระบุบัญชีผู้ใช้ ระบบตรวจว่ามีตัวตนจริง)
 * ไม่ได้ให้ยาต้องมีรหัสเหตุผล · PRN ต้องมีข้อบ่งชี้
 */
export const saveMarAdmin = async ({ body, set, user }: { body: AdminBody; set: Set; user: unknown }) => {
    const orderId = Number(body?.order_id);
    const an = String(body?.an ?? '').trim();
    const ward = String(body?.ward_code ?? '').trim();
    if (!Number.isInteger(orderId) || !an || !ward) return bad(set, 'กรุณาระบุ order_id, an และ ward_code');
    if (!ADMIN_STATUSES.includes(body.status)) return bad(set, 'สถานะการให้ยาไม่ถูกต้อง');

    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;

    try {
        const [order] = await nurse`
            SELECT id, an, medication_name, dose_value::float8 AS dose_value, dose_unit, route, frequency_code,
                   ARRAY(SELECT TO_CHAR(t, 'HH24:MI') FROM unnest(schedule_times) t) AS times,
                   TO_CHAR(COALESCE(start_datetime, start_date::timestamp), 'YYYY-MM-DD HH24:MI:SS') AS start_at,
                   TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date,
                   TO_CHAR(discontinued_at, 'YYYY-MM-DD HH24:MI:SS') AS discontinued_at,
                   prn, high_alert
            FROM nursing_medication_orders WHERE id = ${orderId} AND is_deleted IS NOT TRUE`;
        if (!order) return bad(set, 'ไม่พบคำสั่งยา', 404);
        if (order.an !== an) return bad(set, 'คำสั่งยานี้ไม่ใช่ของผู้ป่วยรายนี้');

        const adminAt = toLocalDate(body.admin_datetime) ?? new Date();
        // บันทึกล่วงหน้าไม่ได้ เวลาที่ให้ยาต้องเป็นเหตุการณ์ที่เกิดขึ้นแล้ว (เผื่อนาฬิกาเครื่องคลาดเคลื่อน 5 นาที)
        if (adminAt.getTime() > Date.now() + 5 * 60_000) return bad(set, 'เวลาให้ยาต้องไม่อยู่ในอนาคต');
        if (order.discontinued_at && localStr(adminAt) >= order.discontinued_at && body.status === 'given') {
            return bad(set, 'คำสั่งนี้หยุดยาไปแล้ว บันทึกการให้ยาหลังเวลาหยุดไม่ได้');
        }

        // มื้อที่บันทึกนี้ตอบ
        let scheduledAt: string | null = null;
        if (order.prn) {
            if (body.scheduled_at) return bad(set, 'ยา PRN ไม่มีมื้อประจำ');
        } else {
            const slot = toLocalDate(body.scheduled_at);
            if (!slot) return bad(set, 'กรุณาเลือกมื้อที่ให้ยา');
            const s = localStr(slot);
            const isOnce = order.frequency_code === 'STAT' || order.frequency_code === 'ONCE';
            const validSlot = isOnce
                ? s === order.start_at
                : (order.times as string[]).includes(s.slice(11, 16))
                  && s >= order.start_at
                  && (!order.end_date || s.slice(0, 10) <= order.end_date)
                  && (!order.discontinued_at || s < order.discontinued_at);
            if (!validSlot) return bad(set, 'มื้อที่เลือกไม่ตรงกับเวลาในคำสั่งยา');
            scheduledAt = s;
        }

        const given = body.status === 'given';
        const reason = given ? null : String(body.reason_code ?? '');
        if (!given && !REASON_CODES.includes(reason!)) return bad(set, 'ไม่ได้ให้ยาต้องเลือกเหตุผล');

        const dose = body.dose_value === null || body.dose_value === undefined ? null : Number(body.dose_value);
        if (given && (dose === null || !Number.isFinite(dose) || dose <= 0)) return bad(set, 'กรุณาระบุขนาดยาที่ให้');
        const route = body.route && ROUTES.includes(body.route) ? body.route : order.route;

        let checker: Actor | null = null;
        const checkerName = String(body.double_checked_by ?? '').trim();
        if (order.high_alert && given) {
            if (!checkerName) return bad(set, 'ยาความเสี่ยงสูงต้องมีพยาบาลอีกคนตรวจซ้ำก่อนให้');
            checker = await resolveActor({ username: checkerName });
            if (!checker) return bad(set, 'ไม่พบบัญชีผู้ตรวจซ้ำในระบบบุคลากร');
            if (checker.username === actor.username) return bad(set, 'ผู้ตรวจซ้ำต้องเป็นคนละคนกับผู้ให้ยา');
            if (checker.roleClass !== 'professional_nurse') return bad(set, 'ผู้ตรวจซ้ำยาความเสี่ยงสูงต้องเป็นพยาบาลวิชาชีพ');
        }

        const pre = scoreOf(body.pre_score);
        const post = scoreOf(body.post_score);
        if (!validScore(pre) || !validScore(post)) return bad(set, 'คะแนนอาการต้องเป็นจำนวนเต็ม 0–10');
        const indication = clean(body.prn_indication, 200);
        if (order.prn && given && !indication) return bad(set, 'ยา PRN ต้องระบุอาการที่ให้ยา');
        const reassessed = post === null ? null : toLocalDate(body.reassessed_at) ?? new Date();

        const [row] = await nurse`
            INSERT INTO nursing_medication_admins (
                order_id, an, ward_code, ward_name, staff_id, nurse_name, admin_datetime, scheduled_at, shift,
                medication_name, dose_given, dose_value, dose_unit, route, site, status, reason_code, held_reason,
                double_checked_by, double_checked_by_name, prn_indication, pre_score, post_score, reassessed_at,
                adverse_reaction, adverse_note, note, created_at, created_by)
            VALUES (
                ${orderId}, ${an}, ${ward}, ${clean(body.ward_name, 100)}, ${actor.username}, ${actor.fullname},
                ${localStr(adminAt)}::text::timestamp, ${scheduledAt}::text::timestamp, ${shiftOfTime(adminAt)},
                ${order.medication_name}, ${dose === null ? '-' : doseText(dose, order.dose_unit ?? '')}, ${dose}, ${order.dose_unit},
                ${route}, ${clean(body.site, 50)}, ${body.status}, ${reason}, ${clean(body.held_reason, 500)},
                ${checker?.username ?? null}, ${checker?.fullname ?? null},
                ${order.prn ? indication : null}, ${pre}, ${post}, ${reassessed ? localStr(reassessed) : null}::text::timestamp,
                ${Boolean(body.adverse_reaction)}, ${body.adverse_reaction ? clean(body.adverse_note, 500) : null},
                ${clean(body.note, 500)}, ${localStr(new Date())}::text::timestamp, ${actor.username})
            RETURNING id`;
        return { success: true, message: 'บันทึกการให้ยาแล้ว', data: { id: Number(row.id) } };
    } catch (error) {
        if ((error as { code?: string }).code === '23505') return bad(set, 'มื้อนี้มีบันทึกแล้ว ถ้าบันทึกผิดให้ลบรายการเดิมก่อน', 409);
        return fail(set, 'save admin', error);
    }
};

/** ประเมินผลยา PRN ภายหลัง — ใส่คะแนนหลังให้ยาเมื่อกลับไปดูผู้ป่วย */
export const reassessMarAdmin = async (
    { params, body, set, user }: { params: { id: string }; body: { post_score: number; reassessed_at?: string }; set: Set; user: unknown }
) => {
    const id = Number(params.id);
    const post = scoreOf(body?.post_score);
    if (!Number.isInteger(id) || id <= 0) return bad(set, 'id ไม่ถูกต้อง');
    if (post === null || !validScore(post)) return bad(set, 'คะแนนหลังให้ยาต้องเป็นจำนวนเต็ม 0–10');
    const at = toLocalDate(body?.reassessed_at) ?? new Date();
    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;
    try {
        const rows = await nurse`
            UPDATE nursing_medication_admins
            SET post_score = ${post}, reassessed_at = ${localStr(at)}::text::timestamp,
                updated_at = ${localStr(new Date())}::text::timestamp, updated_by = ${actor.username}
            WHERE id = ${id} AND is_deleted IS NOT TRUE AND status = 'given' AND admin_datetime <= ${localStr(at)}::text::timestamp
            RETURNING id`;
        if (rows.length === 0) return bad(set, 'ไม่พบรายการ หรือเวลาประเมินอยู่ก่อนเวลาให้ยา', 404);
        return { success: true, message: 'บันทึกการประเมินซ้ำแล้ว' };
    } catch (error) {
        return fail(set, 'reassess', error);
    }
};

/** ลบบันทึกที่ผิด (soft delete พร้อมเหตุผล) — เวชระเบียนการให้ยาต้องย้อนดูได้เสมอว่าใครลบเพราะอะไร */
export const deleteMarAdmin = async (
    { params, body, set, user }: { params: { id: string }; body: { reason: string }; set: Set; user: unknown }
) => {
    const id = Number(params.id);
    const reason = clean(body?.reason, 300);
    if (!Number.isInteger(id) || id <= 0) return bad(set, 'id ไม่ถูกต้อง');
    if (!reason) return bad(set, 'กรุณาระบุเหตุผลที่ลบ');
    const actor = await requireActor(user, set);
    if ('error' in actor) return actor.error;
    try {
        const rows = await nurse`
            UPDATE nursing_medication_admins
            SET is_deleted = TRUE, deleted_by = ${actor.username}, delete_reason = ${reason},
                updated_at = ${localStr(new Date())}::text::timestamp, updated_by = ${actor.username}
            WHERE id = ${id} AND is_deleted IS NOT TRUE
            RETURNING id`;
        if (rows.length === 0) return bad(set, 'ไม่พบรายการที่ต้องการลบ', 404);
        return { success: true, message: 'ลบรายการแล้ว' };
    } catch (error) {
        return fail(set, 'delete admin', error);
    }
};

/* ───────────────────────── วิเคราะห์ ───────────────────────── */

interface Bucket {
    due: number; on_time: number; late: number; early: number; not_given: number; missed: number;
}
const newBucket = (): Bucket => ({ due: 0, on_time: 0, late: 0, early: 0, not_given: 0, missed: 0 });
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** สรุปของกลุ่มหนึ่ง: อัตราตรงเวลาคิดจากมื้อที่ให้แล้ว · อัตราบันทึกครบคิดจากมื้อที่ถึงกำหนดแล้วทั้งหมด */
const summarize = (b: Bucket) => {
    const given = b.on_time + b.late + b.early;
    return {
        ...b,
        given,
        on_time_rate: pctOf(b.on_time, given),
        documented_rate: pctOf(b.due - b.missed, b.due),
        missed_rate: pctOf(b.missed, b.due),
    };
};

const minDay = (a: string, b: string) => (a < b ? a : b);
const daysBetween = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = toLocalDate(from)!; localStr(d).slice(0, 10) <= to; d.setDate(d.getDate() + 1)) out.push(localStr(d).slice(0, 10));
    return out;
};

const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const percentile = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/**
 * POST /mar/analytics — ตัวชี้วัดการบริหารยาตามช่วงวันที่ หลายหอได้
 *
 * นับเฉพาะมื้อที่ "เลยช่วงเวลาไปแล้ว" — มื้อที่ยังอยู่ในช่วงให้ยาหรือยังไม่ถึงไม่นับเป็นขาด
 * หอของมื้อใช้หอที่คำสั่งยาถูกบันทึก (ผู้ป่วยย้ายหอระหว่างคำสั่งจะนับอยู่หอเดิมจนกว่าจะสั่งใหม่)
 */
export const getMarAnalytics = async (
    { body, set }: { body: { date_from: string; date_to: string; wards?: string[] }; set: Set }
) => {
    const { date_from, date_to } = body ?? {};
    if (!isDay(date_from) || !isDay(date_to) || date_from > date_to) return bad(set, 'กรุณาระบุช่วงวันที่ (YYYY-MM-DD) ให้ถูกต้อง');
    const days = (Date.parse(date_to) - Date.parse(date_from)) / 86_400_000 + 1;
    if (days > MAX_RANGE_DAYS) return bad(set, `เลือกช่วงได้ไม่เกิน ${MAX_RANGE_DAYS} วัน`);
    const wards = (body.wards ?? []).map(String).filter(Boolean).slice(0, 100);
    const wardFilter = wards.length ? nurse`ward_code IN ${nurse(wards)}` : nurse`TRUE`;
    const from = `${date_from} 00:00:00`;
    const to = `${date_to} 23:59:59`;

    try {
        const now = new Date();
        const slots = await loadSlots(wardFilter, from, to);

        const total = newBucket();
        const byWard = new Map<string, Bucket & { name: string }>();
        const byShift = new Map<string, Bucket>();
        const byClass = new Map<string, Bucket>();
        const byHour = Array.from({ length: 24 }, newBucket);
        const byDay = new Map<string, Bucket>();
        const missedDrugs = new Map<string, number>();
        const lateness: number[] = [];
        let highAlertGiven = 0, highAlertChecked = 0, givenUnverified = 0;

        for (const s of slots) {
            const { state, delay } = stateOf(s, now);
            if (state === 'due' || state === 'upcoming') continue;
            const at = toLocalDate(s.scheduled_at)!;
            const shift = shiftOfTime(at);
            const cls = s.drug_class ?? 'OTHER';
            const day = s.scheduled_at.slice(0, 10);
            const ward = byWard.get(s.ward_code) ?? { ...newBucket(), name: s.ward_name ?? s.ward_code };
            const buckets = [
                total, ward,
                byShift.get(shift) ?? newBucket(),
                byClass.get(cls) ?? newBucket(),
                byHour[at.getHours()],
                byDay.get(day) ?? newBucket(),
            ];
            for (const b of buckets) { b.due++; b[state]++; }
            byWard.set(s.ward_code, ward);
            byShift.set(shift, buckets[2]);
            byClass.set(cls, buckets[3]);
            byDay.set(day, buckets[5]);

            if (state === 'missed') missedDrugs.set(s.medication_name, (missedDrugs.get(s.medication_name) ?? 0) + 1);
            if (delay !== null && delay > 0) lateness.push(delay);
            if (s.admin_status === 'given') {
                if (s.high_alert) { highAlertGiven++; if (s.double_checked) highAlertChecked++; }
                if (!s.verified) givenUnverified++;
            }
        }

        // ───── จากบันทึกการให้ยาโดยตรง (รวม PRN) ─────
        const [admin] = await nurse`
            SELECT
                COUNT(*) FILTER (WHERE o.prn AND a.status = 'given')::int AS prn_given,
                COUNT(*) FILTER (WHERE o.prn AND a.status = 'given' AND a.pre_score IS NOT NULL)::int AS prn_with_pre,
                COUNT(*) FILTER (WHERE o.prn AND a.status = 'given' AND a.post_score IS NOT NULL)::int AS prn_reassessed,
                COUNT(*) FILTER (WHERE o.prn AND a.status = 'given' AND a.post_score IS NOT NULL
                                 AND a.reassessed_at <= a.admin_datetime + INTERVAL '60 minutes')::int AS prn_reassessed_1h,
                AVG(a.pre_score - a.post_score) FILTER (WHERE o.prn AND a.pre_score IS NOT NULL AND a.post_score IS NOT NULL)::float8 AS prn_mean_reduction,
                COUNT(*) FILTER (WHERE o.prn AND a.status = 'given' AND a.pre_score IS NOT NULL AND a.post_score IS NOT NULL
                                 AND a.post_score <= a.pre_score - 2)::int AS prn_effective,
                COUNT(*) FILTER (WHERE o.prn AND o.high_alert AND a.status = 'given')::int AS prn_high_alert_given,
                COUNT(*) FILTER (WHERE o.prn AND o.high_alert AND a.status = 'given' AND a.double_checked_by IS NOT NULL)::int AS prn_high_alert_checked,
                COUNT(*) FILTER (WHERE o.prn AND a.status = 'given' AND o.verified_by IS NULL)::int AS prn_given_unverified,
                COUNT(*) FILTER (WHERE a.adverse_reaction)::int AS adverse
            FROM nursing_medication_admins a
            JOIN nursing_medication_orders o ON o.id = a.order_id
            WHERE a.is_deleted IS NOT TRUE
              AND a.admin_datetime BETWEEN ${from}::text::timestamp AND ${to}::text::timestamp
              AND ${wards.length ? nurse`a.ward_code IN ${nurse(wards)}` : nurse`TRUE`}`;

        /* PRN ที่ให้ถี่กว่าระยะห่างขั้นต่ำในคำสั่ง — ไม่ได้ห้ามตอนบันทึก (อาจมีคำสั่งแพทย์เพิ่ม) แต่ต้องเห็นในรายงาน */
        const [interval] = await nurse`
            SELECT COUNT(*)::int AS n FROM (
                SELECT a.admin_datetime, o.prn_min_interval_hours,
                       LAG(a.admin_datetime) OVER (PARTITION BY a.order_id ORDER BY a.admin_datetime) AS prev
                FROM nursing_medication_admins a
                JOIN nursing_medication_orders o ON o.id = a.order_id
                WHERE o.prn AND a.status = 'given' AND a.is_deleted IS NOT TRUE
                  AND a.admin_datetime BETWEEN (${from}::text::timestamp - INTERVAL '3 days') AND ${to}::text::timestamp
                  AND ${wards.length ? nurse`a.ward_code IN ${nurse(wards)}` : nurse`TRUE`}
            ) x
            WHERE x.prn_min_interval_hours IS NOT NULL AND x.prev IS NOT NULL
              AND x.admin_datetime >= ${from}::text::timestamp
              AND x.admin_datetime < x.prev + (x.prn_min_interval_hours * INTERVAL '1 hour')`;

        const reasons = await nurse`
            SELECT a.reason_code, a.status, COUNT(*)::int AS n
            FROM nursing_medication_admins a
            WHERE a.is_deleted IS NOT TRUE AND a.status <> 'given'
              AND a.admin_datetime BETWEEN ${from}::text::timestamp AND ${to}::text::timestamp
              AND ${wards.length ? nurse`a.ward_code IN ${nurse(wards)}` : nurse`TRUE`}
            GROUP BY 1, 2 ORDER BY 3 DESC`;

        const [orders] = await nurse`
            SELECT COUNT(*)::int AS created,
                   COUNT(*) FILTER (WHERE verified_by IS NOT NULL)::int AS verified,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM verified_at - created_at) / 60)
                       FILTER (WHERE verified_at IS NOT NULL)::float8 AS median_verify_minutes,
                   COUNT(*) FILTER (WHERE high_alert)::int AS high_alert
            FROM nursing_medication_orders
            WHERE is_deleted IS NOT TRUE
              AND created_at BETWEEN ${from}::text::timestamp AND ${to}::text::timestamp
              AND ${wardFilter}`;
        const [pending] = await nurse`
            SELECT COUNT(*)::int AS n FROM nursing_medication_orders
            WHERE is_deleted IS NOT TRUE AND verified_by IS NULL AND discontinued_at IS NULL
              AND (end_date IS NULL OR end_date >= CURRENT_DATE)
              AND ${wardFilter}`;

        const hag = highAlertGiven + Number(admin.prn_high_alert_given);
        const hac = highAlertChecked + Number(admin.prn_high_alert_checked);

        return {
            success: true,
            data: {
                date_from, date_to,
                windows: { standard_minutes: windowOf(false), time_critical_minutes: windowOf(true) },
                scheduled: {
                    ...summarize(total),
                    median_late_minutes: median(lateness),
                    p90_late_minutes: percentile(lateness, 90),
                },
                high_alert: { given: hag, double_checked: hac, rate: pctOf(hac, hag) },
                given_on_unverified_order: givenUnverified + Number(admin.prn_given_unverified),
                prn: {
                    given: Number(admin.prn_given),
                    with_pre_score: Number(admin.prn_with_pre),
                    reassessed: Number(admin.prn_reassessed),
                    reassessed_rate: pctOf(Number(admin.prn_reassessed), Number(admin.prn_given)),
                    reassessed_within_1h: Number(admin.prn_reassessed_1h),
                    mean_reduction: admin.prn_mean_reduction === null ? null : Math.round(Number(admin.prn_mean_reduction) * 10) / 10,
                    effective: Number(admin.prn_effective),
                    interval_violations: Number(interval.n),
                },
                adverse_reactions: Number(admin.adverse),
                orders: {
                    created: Number(orders.created),
                    verified: Number(orders.verified),
                    verified_rate: pctOf(Number(orders.verified), Number(orders.created)),
                    median_verify_minutes: orders.median_verify_minutes === null ? null : Math.round(Number(orders.median_verify_minutes)),
                    high_alert: Number(orders.high_alert),
                    pending_verification_now: Number(pending.n),
                },
                not_given_reasons: reasons.map(r => ({ reason_code: String(r.reason_code), status: String(r.status), count: Number(r.n) })),
                by_ward: [...byWard.entries()].map(([code, b]) => ({ ward_code: code, ward_name: b.name, ...summarize(b) }))
                    .sort((a, b) => b.due - a.due),
                by_shift: ['ดึก', 'เช้า', 'บ่าย'].map(s => ({ shift: s, ...summarize(byShift.get(s) ?? newBucket()) })),
                by_drug_class: [...byClass.entries()].map(([cls, b]) => ({ drug_class: cls, ...summarize(b) }))
                    .sort((a, b) => b.due - a.due),
                by_hour: byHour.map((b, hour) => ({ hour, ...summarize(b) })),
                // ทุกวันในช่วง (ถึงวันนี้) วันที่ไม่มีมื้อเป็นศูนย์ ไม่หายไปจากแกน ไม่งั้นกราฟจะดูต่อเนื่องทั้งที่มีช่องว่าง
                daily: daysBetween(date_from, minDay(date_to, localStr(now).slice(0, 10)))
                    .map(date => ({ date, ...summarize(byDay.get(date) ?? newBucket()) })),
                top_missed_drugs: [...missedDrugs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                    .map(([name, count]) => ({ medication_name: name, count })),
            },
        };
    } catch (error) {
        return fail(set, 'analytics', error);
    }
};

/** รหัสทั้งหมดให้หน้าจอสร้างตัวเลือก — ที่เดียวกับที่ server ใช้ตรวจ จะได้ไม่มีตัวเลือกที่บันทึกไม่ผ่าน */
export const getMarCodes = () => ({
    success: true,
    data: {
        routes: ROUTES,
        frequencies: Object.entries(DOSES_PER_DAY).map(([code, per_day]) => ({ code, per_day })),
        drug_classes: DRUG_CLASSES.map(code => ({ code, high_alert: HIGH_ALERT_CLASSES.includes(code) })),
        reason_codes: REASON_CODES,
        windows: { standard_minutes: windowOf(false), time_critical_minutes: windowOf(true) },
    },
});
