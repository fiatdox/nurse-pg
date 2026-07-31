import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';

/** คอลัมน์ที่รับบันทึกได้จาก client — ฟิลด์นอกรายการนี้จะถูกตัดทิ้ง */
const PAIN_FIELDS = [
    'ward_code', 'ward_name', 'staff_id', 'nurse_name', 'record_datetime',
    'shift', 'assessment_tool', 'pain_score',
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

/**
 * ตีความ 'YYYY-MM-DD HH:mm:ss' ว่าเป็นเวลาท้องถิ่นตามที่ผู้ใช้กรอก
 * ถ้าส่งเป็นข้อความตรงๆ driver จะมองว่าเป็น UTC ทำให้เวลาเพี้ยนไปเท่ากับ offset ของเครื่อง
 */
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

/** ระดับความปวดตาม Numeric Rating Scale — คำนวณที่ server เพื่อให้ตรงกับคะแนนเสมอ */
const levelOfScore = (score: number): string => {
    if (score === 0) return 'no_pain';
    if (score <= 3) return 'mild';
    if (score <= 6) return 'moderate';
    if (score <= 9) return 'severe';
    return 'worst';
};

/** เวรตามเวลาที่ประเมิน ใช้เมื่อผู้ใช้ไม่ได้เลือกเอง (คอลัมน์ shift เป็น NOT NULL) */
const shiftOfTime = (d: Date): string => {
    const h = d.getHours();
    if (h < 8) return 'ดึก';
    if (h < 16) return 'เช้า';
    return 'บ่าย';
};

const VALID_SHIFTS = ['ดึก', 'เช้า', 'บ่าย'];
const VALID_TOOLS = ['NRS', 'VAS', 'Wong-Baker', 'FLACC', 'BPS'];

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

    const score = Number(payload.pain_score);
    if (!Number.isInteger(score) || score < 0 || score > 10) {
        set.status = 400;
        return { success: false, message: 'คะแนนความปวดต้องเป็นจำนวนเต็ม 0–10' };
    }

    const reassess = payload.reassess_score;
    const reassessScore =
        reassess === null || reassess === undefined || reassess === '' ? null : Number(reassess);
    if (reassessScore !== null && (!Number.isInteger(reassessScore) || reassessScore < 0 || reassessScore > 10)) {
        set.status = 400;
        return { success: false, message: 'คะแนนหลังประเมินซ้ำต้องเป็นจำนวนเต็ม 0–10' };
    }

    const tool = String(payload.assessment_tool ?? 'NRS').trim() || 'NRS';
    if (!VALID_TOOLS.includes(tool)) {
        set.status = 400;
        return { success: false, message: 'เครื่องมือประเมินไม่ถูกต้อง' };
    }

    const recordDatetime = toLocalDate(payload.record_datetime) ?? new Date();
    const shiftInput = String(payload.shift ?? '').trim();
    const shift = VALID_SHIFTS.includes(shiftInput) ? shiftInput : shiftOfTime(recordDatetime);

    const actor = String(user?.loginname ?? payload.staff_id ?? '') || null;

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
    values.pain_level = levelOfScore(score);
    values.reassess_score = reassessScore;

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

    const actor = String(user?.loginname ?? '') || null;

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
