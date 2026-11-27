import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { toLocalDate, shiftOfTime } from '../utils/nursingRecord';

/**
 * แบบประเมินความเสี่ยงพลัดตกหกล้ม (Morse Fall Scale) — เก็บในตารางรวม nursing_assessments (assessment_type = 'fall_risk')
 * คะแนนรายข้อใน items · คะแนนรวมและระดับคำนวณที่ server จากรายข้อ ไม่เชื่อค่าที่ส่งมา
 * หนึ่งวันต่อหนึ่งการประเมิน (แสดงในฟอร์มปรอททีละวัน) — วันเดิมให้แก้รายการเดิม
 */
const TYPE = 'fall_risk';

/** ค่าที่ยอมรับของแต่ละข้อ (Morse Fall Scale) */
const MORSE: Record<string, number[]> = {
    history_of_falling: [0, 25],
    secondary_diagnosis: [0, 15],
    ambulatory_aid: [0, 15, 30],
    iv_heparin_lock: [0, 20],
    gait: [0, 10, 20],
    mental_status: [0, 15],
};
const MORSE_KEYS = Object.keys(MORSE);

/** 0-24 low · 25-44 moderate · ≥45 high */
const riskOf = (score: number) => (score <= 24 ? 'low' : score <= 44 ? 'moderate' : 'high');

const missingTable = (e: unknown) => (e as { code?: string })?.code === '42P01';
const NOT_READY = { success: false, message: 'ยังไม่ได้สร้างตาราง nursing_assessments (ต้องรัน sql/2026-11-26_nursing_assessments_merge.sql)' };

/** แถวในฐานข้อมูล → รูปแบบที่หน้าจอใช้ (รายข้อแตกออกจาก items) */
const toRecord = (r: Record<string, unknown>) => {
    const items = (r.items ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {
        id: Number(r.id), an: r.an, record_datetime: r.record_datetime, shift: r.shift,
        total_score: r.total_score, risk_level: r.risk_level,
        interventions: typeof r.interventions === 'string' ? sanitizeHTML(r.interventions) : null,
        nurse_name: typeof r.nurse_name === 'string' ? sanitizeHTML(r.nurse_name) : null,
        ward_code: r.ward_code, updated_at: r.updated_at,
    };
    for (const k of MORSE_KEYS) out[k] = Number(items[k] ?? 0);
    return out;
};

const SELECT_COLS = nurse`
    id, an, ward_code, TO_CHAR(record_datetime, 'YYYY-MM-DD HH24:MI:SS') AS record_datetime, shift,
    items, total_score, risk_level, interventions, nurse_name, TO_CHAR(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at`;

/** ตรวจค่าจากฟอร์ม คืน string = ข้อความผิดพลาด (400) */
const buildValues = (p: Record<string, unknown>) => {
    if (!String(p.ward_code ?? '').trim()) return 'กรุณาระบุ ward_code';
    const items: Record<string, number> = {};
    let total = 0;
    for (const k of MORSE_KEYS) {
        const n = Number(p[k]);
        if (p[k] === null || p[k] === undefined || p[k] === '' || !MORSE[k].includes(n)) {
            return 'ต้องตอบ Morse Fall Scale ให้ครบทั้ง 6 ข้อ ด้วยคะแนนที่กำหนด';
        }
        items[k] = n;
        total += n;
    }
    const at = toLocalDate(p.record_datetime) ?? new Date();
    if (at.getTime() - Date.now() > 5 * 60 * 1000) return 'เวลาที่ประเมินต้องไม่เป็นเวลาในอนาคต';
    const nurseName = String(p.nurse_name ?? '').trim();
    if (!nurseName) return 'กรุณาระบุชื่อพยาบาลผู้ประเมิน';
    const text = (v: unknown, max: number) => {
        const s = String(v ?? '').trim();
        return s ? s.slice(0, max) : null;
    };
    return {
        at,
        values: {
            ward_code: String(p.ward_code).trim().slice(0, 20),
            ward_name: text(p.ward_name, 200),
            record_datetime: at,
            shift: shiftOfTime(at),
            items: nurse.json(items as never),
            total_score: total,
            risk_level: riskOf(total),
            interventions: text(p.interventions, 4000),
            staff_id: text(p.staff_id, 50),
            nurse_name: nurseName.slice(0, 200),
        } as Record<string, unknown>,
    };
};

/** วันตามเวลาท้องถิ่น (YYYY-MM-DD) — ไม่ส่ง Date ไปเทียบเพราะจะถูกแปลงเป็น UTC แล้ววันเลื่อนได้ */
const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** วันเดียวกันของ AN นี้มีการประเมินแล้วหรือยัง (ไม่นับแถว exceptId) */
const sameDay = async (an: string, at: Date, exceptId = 0) => nurse`
    SELECT id, nurse_name FROM nursing_assessments
    WHERE an = ${an} AND assessment_type = ${TYPE} AND is_deleted IS NOT TRUE
      AND record_datetime::date = ${localDay(at)}::date AND id <> ${exceptId}
    LIMIT 1`;

// ---------- ดึงตาม AN ----------
export const getFallRiskByAN = async ({ params, set }: Context) => {
    const an = String((params as { an: string }).an ?? '').trim();
    if (!an) { set.status = 400; return { success: false, message: 'กรุณาระบุ an' }; }
    try {
        const rows = await nurse`
            SELECT ${SELECT_COLS} FROM nursing_assessments
            WHERE an = ${an} AND assessment_type = ${TYPE} AND is_deleted IS NOT TRUE
            ORDER BY record_datetime DESC, id DESC LIMIT 500`;
        return { success: true, data: rows.map(r => toRecord(r as Record<string, unknown>)) };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return NOT_READY; }
        console.error('Get fall risk error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- บันทึกใหม่ ----------
export const saveFallRisk = async ({ body, set, user }: Context & { user: any }) => {
    const p = (body ?? {}) as Record<string, unknown>;
    const an = String(p.an ?? '').trim();
    if (!an || an.length > 20) { set.status = 400; return { success: false, message: 'กรุณาระบุ an' }; }
    const built = buildValues(p);
    if (typeof built === 'string') { set.status = 400; return { success: false, message: built }; }
    const actor = String(user?.username ?? '') || null;
    try {
        const dup = await sameDay(an, built.at);
        if (dup.length > 0) {
            set.status = 409;
            return {
                success: false,
                message: 'วันนี้มีการประเมินความเสี่ยงพลัดตกหกล้มแล้ว (วันละ 1 ครั้ง) กรุณาแก้รายการเดิม',
                existing_id: Number(dup[0].id),
            };
        }
        const saved = await nurse`
            INSERT INTO nursing_assessments ${nurse({
                an, assessment_type: TYPE, ...built.values,
                created_at: new Date(), created_by: actor, updated_at: new Date(), updated_by: actor,
            })}
            RETURNING ${SELECT_COLS}`;
        return { success: true, message: 'บันทึกการประเมินเรียบร้อยแล้ว', data: toRecord(saved[0] as Record<string, unknown>) };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return NOT_READY; }
        console.error('Save fall risk error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แก้ไข (แถวเดิม ต้องตรง an) ----------
export const updateFallRisk = async ({ params, body, set, user }: Context & { user: any }) => {
    const id = Number((params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) { set.status = 400; return { success: false, message: 'id ไม่ถูกต้อง' }; }
    const p = (body ?? {}) as Record<string, unknown>;
    const an = String(p.an ?? '').trim();
    if (!an) { set.status = 400; return { success: false, message: 'กรุณาระบุ an' }; }
    const built = buildValues(p);
    if (typeof built === 'string') { set.status = 400; return { success: false, message: built }; }
    const actor = String(user?.username ?? '') || null;
    try {
        const dup = await sameDay(an, built.at, id);
        if (dup.length > 0) {
            set.status = 409;
            return { success: false, message: 'วันที่เลือกมีการประเมินอื่นอยู่แล้ว (วันละ 1 ครั้ง)', existing_id: Number(dup[0].id) };
        }
        const saved = await nurse`
            UPDATE nursing_assessments
            SET ${nurse({ ...built.values, updated_at: new Date(), updated_by: actor })}
            WHERE id = ${id} AND an = ${an} AND assessment_type = ${TYPE} AND is_deleted IS NOT TRUE
            RETURNING ${SELECT_COLS}`;
        if (saved.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบรายการที่ต้องการแก้ไข (อาจถูกลบไปแล้ว)' }; }
        return { success: true, message: 'แก้ไขการประเมินเรียบร้อยแล้ว', data: toRecord(saved[0] as Record<string, unknown>) };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return NOT_READY; }
        console.error('Update fall risk error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ลบ (soft delete) ----------
export const deleteFallRisk = async ({ params, set, user }: Context & { user: any }) => {
    const id = Number((params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) { set.status = 400; return { success: false, message: 'id ไม่ถูกต้อง' }; }
    const actor = String(user?.username ?? '') || null;
    try {
        const r = await nurse`
            UPDATE nursing_assessments SET is_deleted = TRUE, updated_at = ${new Date()}, updated_by = ${actor}
            WHERE id = ${id} AND assessment_type = ${TYPE} AND is_deleted IS NOT TRUE
            RETURNING id`;
        if (r.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบรายการที่ต้องการลบ' }; }
        return { success: true, message: 'ลบรายการเรียบร้อยแล้ว' };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return NOT_READY; }
        console.error('Delete fall risk error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
