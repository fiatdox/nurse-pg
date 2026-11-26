import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { toLocalDate, shiftOfTime } from '../utils/nursingRecord';

/** คอลัมน์ที่รับบันทึกได้จาก client — ฟิลด์นอกรายการนี้จะถูกตัดทิ้ง */
const PAIN_FIELDS = [
    'ward_code', 'ward_name', 'staff_id', 'nurse_name', 'record_datetime',
    // ไม่มี shift — เวรเป็นผลของ record_datetime ไม่ใช่ค่าที่เลือกเอง
    'assessment_tool', 'pain_score',
    'location', 'character', 'onset', 'duration',
    'aggravating', 'alleviating', 'intervention',
    'reassess_score', 'reassess_time',
] as const;

/** ฟิลด์ข้อความอิสระที่ผู้ใช้พิมพ์เอง ต้องล้างแท็กก่อนส่งออก */
const PAIN_TEXT_FIELDS = [
    'ward_name', 'nurse_name', 'shift', 'assessment_tool',
    'location', 'character', 'onset', 'duration',
    'aggravating', 'alleviating', 'intervention', 'reassess_time',
];

const sanitizeRow = (row: Record<string, unknown>) => {
    const out = { ...row };
    for (const f of PAIN_TEXT_FIELDS) {
        if (typeof out[f] === 'string') out[f] = sanitizeHTML(out[f] as string);
    }
    return out;
};

/** ระดับความปวดตาม Numeric Rating Scale — คำนวณที่ server เพื่อให้ตรงกับคะแนนเสมอ */
const levelOfScore = (score: number): string => {
    if (score === 0) return 'no_pain';
    if (score <= 3) return 'mild';
    if (score <= 6) return 'moderate';
    if (score <= 9) return 'severe';
    return 'worst';
};

const VALID_TOOLS = ['NRS', 'VAS', 'Wong-Baker', 'FLACC', 'BPS', 'CPOT'];

/**
 * CPOT (Critical-Care Pain Observation Tool) ฉบับภาษาไทย — สำหรับผู้ป่วยที่บอกคะแนนความปวดเองไม่ได้
 * 4 ด้าน ด้านละ 0-2 รวม 0-8 · 0-2 mild · 3-5 moderate · >5 severe (ศิริราช 2564)
 * ด้านที่ 4 เลือกตามการใส่ท่อช่วยหายใจ: การยอมตามเครื่อง (ventilator) หรือการออกเสียง (vocal)
 */
const CPOT_KEYS = ['facial', 'body', 'muscle', 'airway'] as const;
const cpotLevel = (total: number): string => (total <= 2 ? 'mild' : total <= 5 ? 'moderate' : 'severe');
const parseCpot = (raw: unknown): { items: Record<string, unknown>; total: number } | string => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const mode = String(o.airway_mode ?? '');
    if (mode !== 'ventilator' && mode !== 'vocal') return 'กรุณาเลือกว่าผู้ป่วยใส่ท่อช่วยหายใจหรือไม่ (ด้านที่ 4)';
    const items: Record<string, unknown> = { airway_mode: mode };
    let total = 0;
    for (const k of CPOT_KEYS) {
        const n = Number(o[k]);
        if (o[k] === null || o[k] === undefined || o[k] === '' || !Number.isInteger(n) || n < 0 || n > 2) {
            return 'CPOT ต้องให้คะแนนครบทั้ง 4 ด้าน ด้านละ 0-2';
        }
        items[k] = n;
        total += n;
    }
    return { items, total };
};

// ---------- ดึงรายการประเมินความปวดตาม AN ----------
export const getPainRecordsByAN = async ({ params, query, set }: Context) => {
    const { an } = params as { an: string };
    const { limit } = (query ?? {}) as { limit?: string };

    if (!an?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    // จำกัดเพดานไว้กันดึงทั้งตารางเมื่อผู้ป่วยนอนนาน
    const take = Math.min(Math.max(Number(limit) || 200, 1), 500);

    try {
        const rows = await nurse`
            SELECT *
            FROM nursing_pain_records
            WHERE an = ${an.trim()}
              AND is_deleted IS NOT TRUE
            ORDER BY record_datetime DESC, id DESC
            LIMIT ${take}
        `;

        return {
            success: true,
            data: rows.map(r => sanitizeRow(r as Record<string, unknown>)),
        };
    } catch (error) {
        console.error('Get pain records error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- บันทึกการประเมินความปวด ----------
export const savePainRecord = async ({ body, set, user }: Context & { user: any }) => {
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

    const nurseName = String(payload.nurse_name ?? '').trim();
    if (!nurseName) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุชื่อพยาบาลผู้ประเมิน' };
    }

    const tool = String(payload.assessment_tool ?? 'NRS').trim() || 'NRS';
    if (!VALID_TOOLS.includes(tool)) {
        set.status = 400;
        return { success: false, message: 'เครื่องมือประเมินไม่ถูกต้อง' };
    }

    // CPOT: คะแนนรวมคำนวณที่ server จากรายด้าน ไม่เชื่อ pain_score ที่ส่งมา
    let cpot: { items: Record<string, unknown>; total: number } | null = null;
    if (tool === 'CPOT') {
        const r = parseCpot(payload.tool_items);
        if (typeof r === 'string') {
            set.status = 400;
            return { success: false, message: r };
        }
        cpot = r;
    }
    const maxScore = cpot ? 8 : 10;

    const score = cpot ? cpot.total : Number(payload.pain_score);
    if (!Number.isInteger(score) || score < 0 || score > maxScore) {
        set.status = 400;
        return { success: false, message: `คะแนนความปวดต้องเป็นจำนวนเต็ม 0–${maxScore}` };
    }

    const reassess = payload.reassess_score;
    const reassessScore =
        reassess === null || reassess === undefined || reassess === '' ? null : Number(reassess);
    if (reassessScore !== null && (!Number.isInteger(reassessScore) || reassessScore < 0 || reassessScore > maxScore)) {
        set.status = 400;
        return { success: false, message: `คะแนนหลังประเมินซ้ำต้องเป็นจำนวนเต็ม 0–${maxScore}` };
    }

    const recordDatetime = toLocalDate(payload.record_datetime) ?? new Date();
    const shift = shiftOfTime(recordDatetime);

    const actor = String(user?.username ?? payload.staff_id ?? '') || null;

    // รับเฉพาะคอลัมน์ที่รู้จัก และแปลงค่าว่างเป็น null ให้ตรงกับชนิดคอลัมน์
    const values: Record<string, unknown> = {};
    for (const f of PAIN_FIELDS) {
        const v = payload[f];
        values[f] = v === undefined || v === '' ? null : v;
    }
    values.staff_id = String(payload.staff_id ?? '') || '';
    values.nurse_name = nurseName;
    values.record_datetime = recordDatetime;
    values.shift = shift;
    values.assessment_tool = tool;
    values.pain_score = score;
    values.pain_level = cpot ? cpotLevel(score) : levelOfScore(score);
    values.reassess_score = reassessScore;
    // ใส่คอลัมน์นี้เฉพาะ CPOT — เครื่องมืออื่นยังบันทึกได้แม้ยังไม่ได้รัน sql เพิ่มคอลัมน์
    if (cpot) values.tool_items = nurse.json(cpot.items as never);

    try {
        // ทุกครั้งที่ประเมินคือแถวใหม่ ประวัติความปวดต้องเห็นแนวโน้มย้อนหลังได้
        const saved = await nurse`
            INSERT INTO nursing_pain_records ${nurse({
                an,
                ...values,
                created_at: new Date(),
                created_by: actor,
            })}
            RETURNING *
        `;

        return {
            success: true,
            message: 'บันทึกการประเมินความปวดเรียบร้อยแล้ว',
            data: sanitizeRow(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        // ยังไม่ได้รัน sql/2026-11-26_pain_cpot.sql: ไม่มีคอลัมน์ tool_items หรือ CHECK ยังไม่รับ CPOT
        const code = (error as { code?: string })?.code;
        if (cpot && (code === '42703' || code === '23514')) {
            set.status = 503;
            return { success: false, message: 'ฐานข้อมูลยังไม่รองรับ CPOT (ต้องรัน sql/2026-11-26_pain_cpot.sql)' };
        }
        console.error('Save pain record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ลบการประเมินความปวด (soft delete) ----------
export const deletePainRecord = async ({ params, set, user }: Context & { user: any }) => {
    const { id } = params as { id: string };
    const recordId = Number(id);

    if (!Number.isInteger(recordId) || recordId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const actor = String(user?.username ?? '') || null;

    try {
        // เก็บแถวไว้เพื่อการตรวจสอบย้อนหลัง แค่ทำเครื่องหมายว่าลบแล้ว
        const deleted = await nurse`
            UPDATE nursing_pain_records
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
        console.error('Delete pain record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
