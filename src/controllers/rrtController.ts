import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { toLocalDate, resolveActor } from '../utils/nursingRecord';

/**
 * การตามทีม RRT (Rapid Response Team) — เกณฑ์ของโรงพยาบาล: NEWS2 ≥ 5
 * ทุกครั้งที่สัญญาณชีพถึงเกณฑ์ต้องมีบันทึก: ตามแล้ว หรือไม่ได้ตามพร้อมเหตุผล
 * คัดกรอง sepsis: qSOFA ≥ 2 ร่วมกับสงสัยติดเชื้อ (qSOFA คำนวณจากสัญญาณชีพที่ถึงเกณฑ์ ไม่รับจาก client)
 */
export const RRT_NEWS2_THRESHOLD = 5;
/** สัญญาณชีพที่ถึงเกณฑ์ถือว่ามีการตอบสนองแล้ว ถ้ามีบันทึก RRT ในช่วง ±ชั่วโมงนี้ (วัดซ้ำระหว่างทีมดูแลอยู่ไม่ต้องบันทึกซ้ำ) */
const COVER_HOURS = 4;
/** ดูย้อนหลังกี่ชั่วโมงสำหรับรายการที่ถึงเกณฑ์แต่ยังไม่มีบันทึก */
const PENDING_LOOKBACK_HOURS = 72;

const OUTCOMES = ['stay_ward', 'transfer_icu', 'transfer_other', 'cpr', 'death', 'other'];
const REASONS = ['news2', 'nurse_concern', 'other'];

const missingTable = (e: unknown) => (e as { code?: string })?.code === '42P01';
const NOT_READY = { success: false, message: 'ยังไม่ได้สร้างตาราง nursing_rrt_calls (ต้องรัน sql/2026-11-26_rrt_calls.sql)' };

/** qSOFA จากสัญญาณชีพ: RR ≥ 22, SBP ≤ 100, ความรู้สึกตัวเปลี่ยน (ACVPU ไม่ใช่ A หรือ GCS < 15) — ไม่มีค่าข้อนั้น = ไม่นับ */
export const qsofaOf = (v: { vital_r?: unknown; vital_bp_s?: unknown; avpu?: unknown; gcs_total?: unknown }) => {
    const rr = v.vital_r === null || v.vital_r === undefined ? null : Number(v.vital_r);
    const sbp = v.vital_bp_s === null || v.vital_bp_s === undefined ? null : Number(v.vital_bp_s);
    const gcs = v.gcs_total === null || v.gcs_total === undefined ? null : Number(v.gcs_total);
    const avpu = v.avpu ? String(v.avpu) : null;
    const items = {
        rr: rr !== null && rr >= 22,
        sbp: sbp !== null && sbp <= 100,
        mentation: (avpu !== null && avpu !== 'A') || (gcs !== null && gcs < 15),
    };
    return { score: Number(items.rr) + Number(items.sbp) + Number(items.mentation), items };
};

const VITAL_COLS = nurse`
    id, TO_CHAR(record_datetime, 'YYYY-MM-DD HH24:MI:SS') AS record_datetime,
    news2_score, vital_r, vital_bp_s, vital_p, vital_t, vital_o2sat, avpu, gcs_total, nurse_name`;

const CALL_COLS = nurse`
    id, an, ward_code, vital_id, TO_CHAR(trigger_at, 'YYYY-MM-DD HH24:MI:SS') AS trigger_at, trigger_reason,
    news2_score, qsofa_score, suspected_infection, sepsis_screen_positive, status, not_called_reason,
    TO_CHAR(called_at, 'YYYY-MM-DD HH24:MI:SS') AS called_at, notified_to,
    TO_CHAR(team_arrived_at, 'YYYY-MM-DD HH24:MI:SS') AS team_arrived_at,
    outcome, outcome_note, note, nurse_name, TO_CHAR(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at`;

const TEXT_FIELDS = ['not_called_reason', 'notified_to', 'outcome_note', 'note', 'nurse_name'];
const clean = (r: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...r, id: Number(r.id), vital_id: r.vital_id === null ? null : Number(r.vital_id) };
    for (const f of TEXT_FIELDS) if (typeof out[f] === 'string') out[f] = sanitizeHTML(out[f] as string);
    return out;
};

// ---------- ดึงบันทึก + สัญญาณชีพที่ถึงเกณฑ์แต่ยังไม่มีบันทึก ----------
export const getRrtByAN = async ({ params, set }: Context) => {
    const an = String((params as { an: string }).an ?? '').trim();
    if (!an) { set.status = 400; return { success: false, message: 'กรุณาระบุ an' }; }
    try {
        // สัญญาณชีพที่ถึงเกณฑ์ทั้งหมดของ AN (ใช้เลือกเป็นเหตุของการตาม และหารายการค้าง)
        const triggers = await nurse`
            SELECT ${VITAL_COLS} FROM nursing_vital_records
            WHERE an = ${an} AND is_deleted IS NOT TRUE AND news2_score >= ${RRT_NEWS2_THRESHOLD}
            ORDER BY record_datetime DESC LIMIT 300`;
        let calls: Record<string, unknown>[] = [];
        let ready = true;
        try {
            calls = await nurse`
                SELECT ${CALL_COLS} FROM nursing_rrt_calls
                WHERE an = ${an} AND is_deleted IS NOT TRUE
                ORDER BY trigger_at DESC, id DESC LIMIT 300`;
        } catch (e) {
            if (!missingTable(e)) throw e;
            ready = false;
        }
        const ms = (s: unknown) => new Date(String(s).replace(' ', 'T')).getTime();
        const since = Date.now() - PENDING_LOOKBACK_HOURS * 3600_000;
        const trig = triggers.map(t => ({ ...(t as Record<string, unknown>), id: Number(t.id), record_datetime: String(t.record_datetime), qsofa: qsofaOf(t) }));
        // ค้าง = ถึงเกณฑ์ใน 72 ชม. และไม่มีบันทึกที่อ้างถึงแถวนี้ หรือบันทึกที่ถึงเกณฑ์/ตามในช่วง ±4 ชม.
        const pending = trig.filter(t => {
            const at = ms(t.record_datetime);
            if (at < since) return false;
            return !calls.some(c => Number(c.vital_id) === t.id
                || Math.abs(ms(c.trigger_at) - at) <= COVER_HOURS * 3600_000
                || (c.called_at && Math.abs(ms(c.called_at) - at) <= COVER_HOURS * 3600_000));
        });
        return {
            success: true,
            data: { calls: calls.map(clean), triggers: trig, pending, storage_ready: ready, threshold: RRT_NEWS2_THRESHOLD, cover_hours: COVER_HOURS },
        };
    } catch (error) {
        console.error('Get RRT error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ตรวจค่าจากฟอร์ม · คืน string = ข้อความผิดพลาด (400) */
const buildValues = async (an: string, p: Record<string, unknown>) => {
    const reason = String(p.trigger_reason ?? '');
    if (!REASONS.includes(reason)) return 'กรุณาเลือกเหตุที่ตาม';
    const status = String(p.status ?? '');
    if (status !== 'called' && status !== 'not_called') return 'กรุณาเลือกว่าตาม RRT หรือไม่';

    // สัญญาณชีพที่ถึงเกณฑ์: ต้องเป็นของ AN นี้ — NEWS2 และ qSOFA เอาจากแถวนั้น ไม่รับจาก client
    let vital: Record<string, unknown> | null = null;
    const vitalId = p.vital_id === null || p.vital_id === undefined || p.vital_id === '' ? null : Number(p.vital_id);
    if (vitalId !== null) {
        if (!Number.isInteger(vitalId) || vitalId <= 0) return 'สัญญาณชีพที่อ้างถึงไม่ถูกต้อง';
        const r = await nurse`
            SELECT ${VITAL_COLS} FROM nursing_vital_records
            WHERE id = ${vitalId} AND an = ${an} AND is_deleted IS NOT TRUE LIMIT 1`;
        if (r.length === 0) return 'ไม่พบสัญญาณชีพที่อ้างถึงของผู้ป่วยรายนี้';
        vital = r[0] as Record<string, unknown>;
    } else if (reason === 'news2') {
        return 'ตามเพราะ NEWS2 ต้องเลือกสัญญาณชีพที่ถึงเกณฑ์';
    }

    const now = Date.now();
    const future = (d: Date | null) => d !== null && d.getTime() - now > 5 * 60 * 1000;
    const triggerAt = vital ? toLocalDate(vital.record_datetime) : toLocalDate(p.trigger_at);
    if (!triggerAt) return 'กรุณาระบุเวลาที่ถึงเกณฑ์';
    const calledAt = toLocalDate(p.called_at);
    const arrivedAt = toLocalDate(p.team_arrived_at);
    if (future(triggerAt) || future(calledAt) || future(arrivedAt)) return 'เวลาต้องไม่เป็นเวลาในอนาคต';

    const text = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
    const notCalledReason = text(p.not_called_reason, 2000);
    if (status === 'called' && !calledAt) return 'กรุณาระบุเวลาที่ตาม RRT';
    if (status === 'not_called' && !notCalledReason) return 'ไม่ได้ตาม RRT ต้องระบุเหตุผล';
    if (arrivedAt && calledAt && arrivedAt < calledAt) return 'เวลาทีมมาถึงต้องไม่ก่อนเวลาที่ตาม';

    const outcome = p.outcome ? String(p.outcome) : null;
    if (outcome && !OUTCOMES.includes(outcome)) return 'ผลลัพธ์ไม่ถูกต้อง';

    const q = vital ? qsofaOf(vital).score : null;
    const suspected = p.suspected_infection === true;
    return {
        ward_code: text(p.ward_code, 20),
        ward_name: text(p.ward_name, 200),
        vital_id: vitalId,
        trigger_at: triggerAt,
        trigger_reason: reason,
        news2_score: vital?.news2_score ?? null,
        qsofa_score: q,
        suspected_infection: suspected,
        sepsis_screen_positive: suspected && q !== null && q >= 2,
        status,
        not_called_reason: status === 'not_called' ? notCalledReason : null,
        called_at: status === 'called' ? calledAt : null,
        notified_to: text(p.notified_to, 200),
        team_arrived_at: status === 'called' ? arrivedAt : null,
        outcome: status === 'called' ? outcome : null,
        outcome_note: text(p.outcome_note, 2000),
        note: text(p.note, 2000),
    } as Record<string, unknown>;
};

// ---------- บันทึกใหม่ ----------
export const saveRrt = async ({ body, set, user }: Context & { user: any }) => {
    const p = (body ?? {}) as Record<string, unknown>;
    const an = String(p.an ?? '').trim();
    if (!an || an.length > 20) { set.status = 400; return { success: false, message: 'กรุณาระบุ an' }; }
    const actor = await resolveActor(user);
    if (!actor) { set.status = 401; return { success: false, message: 'ไม่พบบัญชีผู้ใช้ กรุณาเข้าสู่ระบบใหม่' }; }
    try {
        const v = await buildValues(an, p);
        if (typeof v === 'string') { set.status = 400; return { success: false, message: v }; }
        if (v.vital_id !== null) {
            const dup = await nurse`
                SELECT id FROM nursing_rrt_calls WHERE vital_id = ${v.vital_id as number} AND is_deleted IS NOT TRUE LIMIT 1`;
            if (dup.length > 0) {
                set.status = 409;
                return { success: false, message: 'สัญญาณชีพครั้งนี้มีบันทึกการตาม RRT แล้ว กรุณาแก้รายการเดิม', existing_id: Number(dup[0].id) };
            }
        }
        const saved = await nurse`
            INSERT INTO nursing_rrt_calls ${nurse({
                an, ...v, staff_id: actor.userId, nurse_name: actor.fullname,
                created_at: new Date(), created_by: actor.username, updated_at: new Date(), updated_by: actor.username,
            })}
            RETURNING ${CALL_COLS}`;
        return { success: true, message: 'บันทึกการตาม RRT เรียบร้อยแล้ว', data: clean(saved[0] as Record<string, unknown>) };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return NOT_READY; }
        console.error('Save RRT error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แก้ไข (แถวเดิม ต้องตรง an) — ผู้บันทึกคงเดิม ผู้แก้เก็บที่ updated_by ----------
export const updateRrt = async ({ params, body, set, user }: Context & { user: any }) => {
    const id = Number((params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) { set.status = 400; return { success: false, message: 'id ไม่ถูกต้อง' }; }
    const p = (body ?? {}) as Record<string, unknown>;
    const an = String(p.an ?? '').trim();
    if (!an) { set.status = 400; return { success: false, message: 'กรุณาระบุ an' }; }
    const actor = await resolveActor(user);
    if (!actor) { set.status = 401; return { success: false, message: 'ไม่พบบัญชีผู้ใช้ กรุณาเข้าสู่ระบบใหม่' }; }
    try {
        const v = await buildValues(an, p);
        if (typeof v === 'string') { set.status = 400; return { success: false, message: v }; }
        if (v.vital_id !== null) {
            const dup = await nurse`
                SELECT id FROM nursing_rrt_calls
                WHERE vital_id = ${v.vital_id as number} AND id <> ${id} AND is_deleted IS NOT TRUE LIMIT 1`;
            if (dup.length > 0) { set.status = 409; return { success: false, message: 'สัญญาณชีพครั้งนี้มีบันทึกอื่นอยู่แล้ว', existing_id: Number(dup[0].id) }; }
        }
        const saved = await nurse`
            UPDATE nursing_rrt_calls SET ${nurse({ ...v, updated_at: new Date(), updated_by: actor.username })}
            WHERE id = ${id} AND an = ${an} AND is_deleted IS NOT TRUE
            RETURNING ${CALL_COLS}`;
        if (saved.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบรายการที่ต้องการแก้ไข' }; }
        return { success: true, message: 'แก้ไขบันทึกการตาม RRT เรียบร้อยแล้ว', data: clean(saved[0] as Record<string, unknown>) };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return NOT_READY; }
        console.error('Update RRT error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ลบ (soft delete) ----------
export const deleteRrt = async ({ params, set, user }: Context & { user: any }) => {
    const id = Number((params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) { set.status = 400; return { success: false, message: 'id ไม่ถูกต้อง' }; }
    const actor = String(user?.username ?? '') || null;
    try {
        const r = await nurse`
            UPDATE nursing_rrt_calls SET is_deleted = TRUE, updated_at = ${new Date()}, updated_by = ${actor}
            WHERE id = ${id} AND is_deleted IS NOT TRUE RETURNING id`;
        if (r.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบรายการที่ต้องการลบ' }; }
        return { success: true, message: 'ลบรายการเรียบร้อยแล้ว' };
    } catch (error) {
        if (missingTable(error)) { set.status = 503; return NOT_READY; }
        console.error('Delete RRT error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
