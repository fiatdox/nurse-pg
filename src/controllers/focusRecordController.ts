import type { Context } from 'elysia';
import type { RowDataPacket } from 'mysql2';
import { nurse, his } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor, toLocalDate, shiftOfTime, type Actor } from '../utils/nursingRecord';
import { validateAnswers, answeredCount, evalItemsOf } from '../utils/focusTemplate';

/**
 * บันทึกแผนการพยาบาลแบบ Focus list รายผู้ป่วย
 *
 * พยาบาลเลือก Focus จากแม่แบบที่หอผู้ป่วยเขียนไว้ กิจกรรมการพยาบาลมาสำเร็จรูป
 * สิ่งที่พยาบาลกรอกคือคอลัมน์ขวา — ติ๊กและเติมค่า ซึ่งเป็นข้อมูลที่นับเป็นตัวชี้วัดได้
 *
 * ใบหนึ่งมีสามสถานะ
 *   draft     — หัตถการยังไม่จบ แก้ได้อิสระ ยังไม่ถือเป็นเวชระเบียน (ลบแล้วหายไปได้)
 *   final     — ปิดใบแล้ว แก้ต้องมีเหตุผลและเก็บฉบับเดิมไว้ทุกครั้ง
 *   cancelled — ยกเลิกหลังเข้าเวชระเบียนแล้ว ยังแสดงในประวัติพร้อมเหตุผล แก้ต่อไม่ได้
 */

const MAX_NOTE = 2000;
const MAX_LATE_REASON = 2000;
/** ตรงกับความยาวคอลัมน์ cancel_reason */
const MAX_CANCEL_REASON = 500;

/** cancelled = ยกเลิกหลังเข้าเวชระเบียนแล้ว ยังแสดงในประวัติแต่ไม่นับเป็นผลงาน */
const VALID_STATUS = ['draft', 'final', 'cancelled'];

/** เกินเท่านี้ถือว่าลงย้อนหลัง ติดป้ายให้ผู้ตรวจสอบเห็น */
const LATE_ENTRY_MINUTES = 60;
/** ย้อนหลังเกินเท่านี้ต้องระบุเหตุผล — ตัวเลขเดียวกับสัญญาณชีพ */
const REASON_REQUIRED_HOURS = 24;
/** เผื่อนาฬิกาเครื่องผู้ใช้คลาดจากเซิร์ฟเวอร์เล็กน้อย */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** postgres.js รับเฉพาะ JSONValue ที่มี index signature ตัวช่วยนี้ทำให้ส่ง interface ปกติได้ */
const asJson = (v: unknown) => nurse.json(v as never);

const minutesBetween = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60000;

const sanitizeRow = (row: Record<string, unknown>) => {
    const out = { ...row };
    for (const f of ['ward_name', 'nurse_name', 'nurse_major', 'updated_by_name', 'template_title', 'note', 'late_entry_reason', 'cancel_reason', 'cancelled_by_name']) {
        if (typeof out[f] === 'string') out[f] = sanitizeHTML(out[f] as string);
    }
    // เวลาเหตุการณ์กับเวลาที่นั่งพิมพ์ห่างกันมาก = ลงย้อนหลัง หน้าจอเอาไปติดป้ายได้เลย
    const happened = out.record_datetime instanceof Date ? out.record_datetime : null;
    const entered = out.entered_at instanceof Date ? out.entered_at : null;
    out.is_late_entry =
        happened !== null && entered !== null && minutesBetween(happened, entered) > LATE_ENTRY_MINUTES;
    return out;
};

/**
 * ตรวจเวลาที่เหตุการณ์เกิดจริง
 *
 * ใช้ร่วมกันทั้งตอนเปิดใบและตอนแก้เวลาของร่าง กติกาต้องเหมือนกัน
 * ไม่งั้นจะเลี่ยงข้อบังคับได้ด้วยการเปิดใบวันนี้แล้วค่อยแก้วันย้อนหลัง
 */
const checkRecordTime = (
    value: unknown, reason: string
): { error: string } | { at: Date; backdatedHours: number } => {
    const now = new Date();
    const at = toLocalDate(value) ?? now;

    if (at.getTime() - now.getTime() > FUTURE_TOLERANCE_MS) {
        return { error: 'วันเวลาที่บันทึกต้องไม่เป็นเวลาในอนาคต' };
    }

    const backdatedHours = (now.getTime() - at.getTime()) / 3600000;
    if (backdatedHours > REASON_REQUIRED_HOURS && reason.trim().length < 5) {
        return {
            error: `บันทึกย้อนหลังเกิน ${REASON_REQUIRED_HOURS} ชั่วโมง กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษร`,
        };
    }
    if (reason.length > MAX_LATE_REASON) {
        return { error: `เหตุผลการบันทึกย้อนหลังยาวเกิน ${MAX_LATE_REASON} ตัวอักษร` };
    }

    return { at, backdatedHours };
};

/** เติมความคืบหน้าให้หน้าจอไม่ต้องนับเอง และให้หน้ารวมงานใช้ค่าเดียวกัน */
const withProgress = (row: Record<string, unknown>) => {
    const { answered, total } = answeredCount(row.structure, row.answers);
    return { ...sanitizeRow(row), answered, total_items: total };
};

/**
 * หอผู้ป่วยที่แท้จริงของ AN นี้จากทะเบียนรับไว้ใน HIS
 * เหมือน carePlanController — ward_code เป็นคีย์ที่หน้ารวมงานระดับหอใช้กรอง
 * ถ้าเชื่อค่าจากหน้าจอแล้วผิด บันทึกจะหายไปจากมุมมองของหอที่ดูแลจริง
 */
const fetchWardOfAN = async (an: string): Promise<{ code: string; name: string | null } | null> => {
    try {
        const [rows] = await his.execute<RowDataPacket[]>(
            `SELECT i.ward, w.name AS ward_name
             FROM ipt i LEFT JOIN ward w ON w.ward = i.ward
             WHERE i.an = ? LIMIT 1`,
            [an]
        );
        const code = String(rows[0]?.ward ?? '').trim();
        if (!code) return null;
        return { code, name: String(rows[0]?.ward_name ?? '').trim() || null };
    } catch (error) {
        console.error('Fetch ward of AN error:', error);
        return null;
    }
};

const recordRevision = async (
    recordId: number, revisionNo: number, snapshot: unknown,
    action: string, reason: string | null, by: Actor
) => {
    try {
        await nurse`
            INSERT INTO nursing_focus_record_revisions ${nurse({
                record_id: recordId,
                revision_no: revisionNo,
                snapshot: asJson(snapshot),
                action,
                reason,
                changed_by: by.username,
                changed_by_name: by.fullname,
                changed_at: new Date(),
            })}
        `;
    } catch (error) {
        console.error('Record focus revision error:', error);
    }
};

// ---------- บันทึก Focus ของผู้ป่วยหนึ่งราย ----------
export const getFocusRecordsByAN = async ({ params, query, set }: Context) => {
    const { an } = params as { an: string };
    const { status } = (query ?? {}) as { status?: string };

    if (!an?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    const onlyStatus = String(status ?? '').trim();
    if (onlyStatus && !VALID_STATUS.includes(onlyStatus)) {
        set.status = 400;
        return { success: false, message: 'สถานะที่ใช้กรองไม่ถูกต้อง (draft / final / cancelled)' };
    }

    try {
        const rows = await nurse`
            SELECT * FROM nursing_focus_records
            WHERE an = ${an.trim()} AND is_deleted IS NOT TRUE
              ${onlyStatus ? nurse`AND status = ${onlyStatus}` : nurse``}
            ORDER BY record_datetime DESC, id DESC
        `;
        return { success: true, total: rows.length, data: rows.map(r => withProgress(r as Record<string, unknown>)) };
    } catch (error) {
        console.error('Get focus records error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- บันทึก Focus ทั้งหอผู้ป่วย ----------
/**
 * มุมมองระดับหอ ใช้ดูว่าใบไหนยังค้างเป็นร่างและใบไหนปิดแล้ว
 * ตัดคอลัมน์ structure ออกเพราะหนักและหน้ารวมงานไม่ได้ใช้ ต้องเปิดใบถึงจะดึงเต็ม
 */
export const getFocusRecordsByWard = async ({ query, set }: Context) => {
    const { ward_code, status, template_code, from, to, limit } = (query ?? {}) as Record<string, string | undefined>;

    if (!ward_code?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward_code' };
    }

    const onlyStatus = String(status ?? 'all').trim();
    if (onlyStatus !== 'all' && !VALID_STATUS.includes(onlyStatus)) {
        set.status = 400;
        return { success: false, message: 'สถานะที่ใช้กรองไม่ถูกต้อง (draft / final / cancelled / all)' };
    }

    const fromDate = toLocalDate(from);
    const toDate = toLocalDate(to);
    const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);

    try {
        const rows = await nurse`
            SELECT id, an, ward_code, ward_name, nurse_name, nurse_major, template_id, template_code,
                   template_title, template_version, answers, structure,
                   record_datetime, shift, status, completed_at, revision_no,
                   entered_at, late_entry_reason, cancelled_at, cancelled_by, cancelled_by_name, cancel_reason,
                   created_at, created_by, updated_at, updated_by, updated_by_name
            FROM nursing_focus_records
            WHERE ward_code = ${ward_code.trim()} AND is_deleted IS NOT TRUE
              ${onlyStatus === 'all' ? nurse`` : nurse`AND status = ${onlyStatus}`}
              ${template_code ? nurse`AND template_code = ${template_code.trim()}` : nurse``}
              ${fromDate ? nurse`AND record_datetime >= ${fromDate}` : nurse``}
              ${toDate ? nurse`AND record_datetime < ${new Date(toDate.getTime() + 86_400_000)}` : nurse``}
            ORDER BY record_datetime DESC, id DESC
            LIMIT ${take}
        `;

        const data = rows.map(r => {
            const row = withProgress(r as Record<string, unknown>);
            // structure หนัก ส่งกลับแค่ที่ใช้คำนวณ progress แล้วตัดทิ้ง
            const { structure: _drop, ...rest } = row as Record<string, unknown>;
            return rest;
        });

        return {
            success: true,
            ward_code: ward_code.trim(),
            total: data.length,
            drafts: data.filter(d => d.status === 'draft').length,
            data,
        };
    } catch (error) {
        console.error('Get focus records by ward error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- เปิดใบใหม่จากแม่แบบ ----------
export const saveFocusRecord = async ({ body, set, user }: Context & { user: any }) => {
    const payload = (body ?? {}) as Record<string, unknown>;
    const an = String(payload.an ?? '').trim();
    const templateId = Number(payload.template_id);

    if (!an) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }
    if (!Number.isInteger(templateId) || templateId <= 0) {
        set.status = 400;
        return { success: false, message: 'กรุณาเลือก Focus จากแม่แบบ' };
    }

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    try {
        const found = await nurse`
            SELECT id, code, title, version, body, status
            FROM care_plan_templates
            WHERE id = ${templateId} AND is_deleted IS NOT TRUE
        `;
        if (found.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบแม่แบบที่เลือก' };
        }
        const template = found[0] as Record<string, unknown>;

        // เปิดใบใหม่ได้เฉพาะแม่แบบที่เผยแพร่อยู่ ใบเก่าที่ใช้แม่แบบซึ่งเลิกใช้ไปแล้วยังแก้ต่อได้
        if (template.status !== 'published') {
            set.status = 400;
            return {
                success: false,
                message: template.status === 'retired'
                    ? 'แม่แบบนี้เลิกใช้แล้ว เปิดใบใหม่ไม่ได้'
                    : 'แม่แบบนี้ยังเป็นฉบับร่าง ยังใช้บันทึกไม่ได้',
            };
        }

        const structure = template.body;
        const checked = validateAnswers(structure, payload.answers ?? {});
        if ('error' in checked) {
            set.status = 400;
            return { success: false, message: checked.error };
        }

        // พยาบาลกลับมาลงข้อมูลย้อนหลังได้ แต่ต้องบอกเวลาที่เหตุการณ์เกิดจริง
        // และถ้าย้อนไกลต้องบอกเหตุผลด้วย เวลาที่นั่งพิมพ์เก็บไว้ที่ entered_at เสมอ
        const lateReason = String(payload.late_entry_reason ?? '').trim();
        const timing = checkRecordTime(payload.record_datetime, lateReason);
        if ('error' in timing) {
            set.status = 400;
            return { success: false, message: timing.error };
        }
        const recordAt = timing.at;

        const note = String(payload.note ?? '').trim();
        if (note.length > MAX_NOTE) {
            set.status = 400;
            return { success: false, message: `หมายเหตุยาวเกิน ${MAX_NOTE} ตัวอักษร` };
        }

        const ward = await fetchWardOfAN(an);

        const saved = await nurse`
            INSERT INTO nursing_focus_records ${nurse({
                an,
                ward_code: ward?.code ?? (String(payload.ward_code ?? '').trim() || null),
                ward_name: ward?.name ?? (String(payload.ward_name ?? '').trim() || null),
                staff_id: actor.userId,
                nurse_name: actor.fullname,
                nurse_major: actor.majorName || null,
                template_id: templateId,
                template_code: String(template.code),
                template_title: String(template.title),
                template_version: Number(template.version),
                structure: asJson(structure),
                answers: asJson(checked.answers),
                record_datetime: recordAt,
                shift: shiftOfTime(recordAt),
                // เวลาที่นั่งพิมพ์ ไม่ใช่เวลาที่เหตุการณ์เกิด — ผู้ตรวจสอบต้องแยกออกจากกัน
                entered_at: new Date(),
                late_entry_reason: lateReason || null,
                status: 'draft',
                note: note || null,
                request_id: String(payload.request_id ?? '').trim() || null,
                created_at: new Date(),
                created_by: actor.username,
            })}
            RETURNING *
        `;

        return {
            success: true,
            message: 'เปิดใบบันทึกเรียบร้อยแล้ว (ยังเป็นร่าง กดปิดใบเมื่อทำครบทุกระยะ)',
            data: withProgress(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        // กดปุ่มรัวจนสองคำขอมาถึงพร้อมกัน ตัวที่แพ้ชนที่ unique index ของ request_id
        if ((error as { code?: string })?.code === '23505') {
            const existing = await nurse`
                SELECT * FROM nursing_focus_records
                WHERE request_id = ${String(payload.request_id ?? '')} LIMIT 1
            `;
            if (existing.length > 0) {
                return {
                    success: true,
                    message: 'บันทึกนี้ถูกบันทึกไปแล้ว',
                    data: withProgress(existing[0] as Record<string, unknown>),
                };
            }
        }
        console.error('Save focus record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แก้ไขผลการประเมิน ----------
export const updateFocusRecord = async ({ params, body, set, user }: Context & { user: any }) => {
    const recordId = Number((params as { id: string }).id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const payload = (body ?? {}) as Record<string, unknown>;
    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    try {
        const current = await nurse`
            SELECT * FROM nursing_focus_records WHERE id = ${recordId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบใบบันทึกที่ต้องการแก้ไข' };
        }
        const prev = current[0] as Record<string, unknown>;

        // ใบที่ยกเลิกแล้วเป็นหลักฐานว่าเคยมีอะไรเกิดขึ้นและถูกเพิกถอน แก้เนื้อหาต่อไม่ได้
        if (prev.status === 'cancelled') {
            set.status = 409;
            return { success: false, message: 'ใบนี้ถูกยกเลิกไปแล้ว แก้ไขไม่ได้ กรุณาเปิดใบใหม่แทน' };
        }

        const amendReason = String(payload.amend_reason ?? '').trim();
        // ปิดใบแล้วคือเวชระเบียน แก้ได้แต่ต้องบอกเหตุผลและเก็บฉบับเดิมไว้เสมอ
        if (prev.status === 'final' && amendReason.length < 5) {
            set.status = 400;
            return {
                success: false,
                message: 'ใบนี้ปิดแล้วและเข้าเวชระเบียนไปแล้ว การแก้ไขต้องระบุเหตุผลอย่างน้อย 5 ตัวอักษร',
            };
        }

        // ตรวจกับสำเนาโครงในใบนี้ ไม่ใช่แม่แบบปัจจุบัน แม่แบบอาจถูกแก้ไปแล้ว
        const merged = { ...(prev.answers as Record<string, unknown>), ...((payload.answers ?? {}) as Record<string, unknown>) };
        const checked = validateAnswers(prev.structure, merged);
        if ('error' in checked) {
            set.status = 400;
            return { success: false, message: checked.error };
        }

        const values: Record<string, unknown> = { answers: asJson(checked.answers) };

        if (payload.note !== undefined) {
            const note = String(payload.note).trim();
            if (note.length > MAX_NOTE) {
                set.status = 400;
                return { success: false, message: `หมายเหตุยาวเกิน ${MAX_NOTE} ตัวอักษร` };
            }
            values.note = note || null;
        }

        // เวลาที่บันทึกแก้ได้เฉพาะตอนยังเป็นร่าง ไม่งั้นย้อนเวลาในเวชระเบียนได้
        if (payload.record_datetime !== undefined && prev.status === 'draft') {
            // ใช้กติกาเดียวกับตอนเปิดใบ ไม่งั้นเลี่ยงได้ด้วยการเปิดใบวันนี้แล้วค่อยแก้เป็นวันย้อนหลัง
            const lateReason = String(
                payload.late_entry_reason ?? prev.late_entry_reason ?? ''
            ).trim();
            const timing = checkRecordTime(payload.record_datetime, lateReason);
            if ('error' in timing) {
                set.status = 400;
                return { success: false, message: timing.error };
            }
            values.record_datetime = timing.at;
            values.shift = shiftOfTime(timing.at);
            values.late_entry_reason = lateReason || null;
        }

        const nextRevision = prev.status === 'final' ? Number(prev.revision_no ?? 0) + 1 : Number(prev.revision_no ?? 0);
        if (prev.status === 'final') {
            await recordRevision(recordId, nextRevision, prev, 'amend', amendReason, actor);
            values.revision_no = nextRevision;
        }

        const saved = await nurse`
            UPDATE nursing_focus_records
            SET ${nurse({
                ...values,
                updated_at: new Date(),
                updated_by: actor.username,
                updated_by_name: actor.fullname,
            })}
            WHERE id = ${recordId}
            RETURNING *
        `;

        return {
            success: true,
            message: prev.status === 'final'
                ? `แก้ไขเรียบร้อยแล้ว เก็บฉบับเดิมไว้เป็นรุ่นที่ ${nextRevision}`
                : 'บันทึกผลการประเมินเรียบร้อยแล้ว',
            data: withProgress(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        console.error('Update focus record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ปิดใบ ----------
/**
 * ปิดใบแล้วถือว่าเข้าเวชระเบียน จึงต้องกรอกครบก่อน
 * ไม่บังคับ 100% เพราะบางรายการเป็นทางเลือกที่ไม่ได้เกิดขึ้นจริง (เช่นช่องใส่ท่อซ้ำ)
 * แต่ต้องมีคำตอบอย่างน้อยหนึ่งรายการในทุกระยะ ไม่งั้นแปลว่าข้ามระยะไปเลย
 */
export const completeFocusRecord = async ({ params, set, user }: Context & { user: any }) => {
    const recordId = Number((params as { id: string }).id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    try {
        const current = await nurse`
            SELECT * FROM nursing_focus_records WHERE id = ${recordId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบใบบันทึกที่ต้องการปิด' };
        }
        const prev = current[0] as Record<string, unknown>;

        if (prev.status === 'final') {
            set.status = 409;
            return { success: false, message: 'ใบนี้ปิดไปแล้ว' };
        }
        if (prev.status === 'cancelled') {
            set.status = 409;
            return { success: false, message: 'ใบนี้ถูกยกเลิกไปแล้ว ปิดใบไม่ได้' };
        }

        const answers = (prev.answers ?? {}) as Record<string, unknown>;
        const sections = ((prev.structure as { sections?: unknown[] } | null)?.sections ?? []) as {
            title: string; evaluations?: { id: string }[];
        }[];

        const untouched = sections
            .filter(s => (s.evaluations?.length ?? 0) > 0)
            .filter(s => !s.evaluations!.some(e => {
                const v = answers[e.id];
                return v !== null && v !== undefined && v !== '';
            }))
            .map(s => s.title);

        if (untouched.length > 0) {
            set.status = 400;
            return {
                success: false,
                message: `ยังไม่ได้บันทึกผลการประเมินของ: ${untouched.join(' · ')}`,
                sections_missing: untouched,
            };
        }

        const now = new Date();
        const saved = await nurse`
            UPDATE nursing_focus_records
            SET status = 'final', completed_at = ${now}, updated_at = ${now},
                updated_by = ${actor.username}, updated_by_name = ${actor.fullname}
            WHERE id = ${recordId}
            RETURNING *
        `;

        await recordRevision(recordId, Number(prev.revision_no ?? 0), saved[0], 'complete', null, actor);

        return {
            success: true,
            message: 'ปิดใบเรียบร้อยแล้ว บันทึกเข้าเวชระเบียนแล้ว',
            data: withProgress(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        console.error('Complete focus record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ยกเลิกใบ ----------
export const deleteFocusRecord = async ({ params, query, set, user }: Context & { user: any }) => {
    const recordId = Number((params as { id: string }).id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const reason = String((query as { reason?: string })?.reason ?? '').trim();

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    try {
        const current = await nurse`
            SELECT * FROM nursing_focus_records WHERE id = ${recordId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบใบบันทึกที่ต้องการยกเลิก' };
        }
        const prev = current[0] as Record<string, unknown>;

        if (prev.status === 'cancelled') {
            set.status = 409;
            return { success: false, message: 'ใบนี้ถูกยกเลิกไปแล้ว' };
        }

        // ใบที่ปิดแล้วยกเลิกต้องมีเหตุผล เหมือนบันทึกทางการพยาบาล
        if (prev.status === 'final' && reason.length < 5) {
            set.status = 400;
            return {
                success: false,
                message: 'ใบนี้เข้าเวชระเบียนแล้ว การยกเลิกต้องระบุเหตุผลอย่างน้อย 5 ตัวอักษร',
            };
        }
        if (reason.length > MAX_CANCEL_REASON) {
            set.status = 400;
            return { success: false, message: `เหตุผลการยกเลิกยาวเกิน ${MAX_CANCEL_REASON} ตัวอักษร` };
        }

        await recordRevision(
            recordId, Number(prev.revision_no ?? 0), prev, 'cancel', reason || null, actor
        );

        const now = new Date();

        /**
         * ร่างกับใบที่เข้าเวชระเบียนแล้ว ยกเลิกคนละความหมาย
         *
         * ร่าง — ยังไม่เคยเป็นเวชระเบียน หายไปจากสายตาได้ (แถวยังอยู่ในฐานเพื่อการตรวจสอบ)
         * ปิดใบแล้ว — เคยเป็นเวชระเบียนไปแล้ว ต้องคงอยู่ในรายการพร้อมตราประทับว่ายกเลิก
         *   ถ้าซ่อนทิ้ง คนอ่านย้อนหลังจะไม่รู้เลยว่าเคยมีใบนี้ ซึ่งเท่ากับลบร่องรอยการรักษา
         */
        if (prev.status === 'final') {
            const saved = await nurse`
                UPDATE nursing_focus_records
                SET status = 'cancelled', cancelled_at = ${now}, cancelled_by = ${actor.username},
                    cancelled_by_name = ${actor.fullname},
                    cancel_reason = ${reason}, updated_at = ${now},
                    updated_by = ${actor.username}, updated_by_name = ${actor.fullname}
                WHERE id = ${recordId}
                RETURNING *
            `;
            return {
                success: true,
                message: 'ยกเลิกใบบันทึกแล้ว ใบยังคงแสดงในประวัติพร้อมเหตุผลการยกเลิก',
                data: withProgress(saved[0] as Record<string, unknown>),
            };
        }

        await nurse`
            UPDATE nursing_focus_records
            SET is_deleted = TRUE, cancelled_at = ${now}, cancelled_by = ${actor.username},
                cancelled_by_name = ${actor.fullname},
                cancel_reason = ${reason || null}, updated_at = ${now},
                updated_by = ${actor.username}, updated_by_name = ${actor.fullname}
            WHERE id = ${recordId}
        `;

        return { success: true, message: 'ลบร่างเรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Delete focus record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ประวัติการแก้ไข ----------
export const getFocusRecordRevisions = async ({ params, set }: Context) => {
    const recordId = Number((params as { id: string }).id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT id, revision_no, action, reason, changed_by, changed_by_name, changed_at
            FROM nursing_focus_record_revisions
            WHERE record_id = ${recordId}
            ORDER BY changed_at DESC, id DESC
        `;
        return { success: true, total: rows.length, data: rows };
    } catch (error) {
        console.error('Get focus record revisions error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- สรุปตัวชี้วัด ----------
/**
 * เหตุผลหลักที่ผลการประเมินเป็นช่องติ๊กแทนข้อความ — นับได้
 * เช่น "อัตราการใส่ท่อช่วยหายใจซ้ำ" มาจากการนับรายการ check ที่ติ๊กจริง
 * นับเฉพาะใบที่ปิดแล้ว เพราะร่างยังไม่ใช่ข้อมูลที่ยืนยัน
 */
export const getFocusIndicators = async ({ query, set }: Context) => {
    const { ward_code, template_code, from, to } = (query ?? {}) as Record<string, string | undefined>;

    if (!template_code?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ template_code' };
    }

    const fromDate = toLocalDate(from);
    const toDate = toLocalDate(to);

    try {
        const rows = await nurse`
            SELECT structure, answers FROM nursing_focus_records
            WHERE template_code = ${template_code.trim()}
              AND status = 'final' AND is_deleted IS NOT TRUE
              ${ward_code ? nurse`AND ward_code = ${ward_code.trim()}` : nurse``}
              ${fromDate ? nurse`AND record_datetime >= ${fromDate}` : nurse``}
              ${toDate ? nurse`AND record_datetime < ${new Date(toDate.getTime() + 86_400_000)}` : nurse``}
        `;

        if (rows.length === 0) {
            return { success: true, total: 0, data: [] };
        }

        // ใช้โครงของใบล่าสุดเป็นรายการตั้งต้น ใบเก่าที่ใช้แม่แบบรุ่นก่อนอาจมีรายการไม่ครบ
        // ตรงนั้นจะนับเป็น answered ที่น้อยลงเอง ไม่ได้ทำให้ตัวหารเพี้ยน
        const labels = new Map<string, { label: string; kind: string }>();
        for (const r of rows) {
            for (const [id, item] of evalItemsOf((r as Record<string, unknown>).structure)) {
                if (!labels.has(id)) labels.set(id, { label: item.label, kind: item.kind });
            }
        }

        const stats = new Map<string, { id: string; label: string; kind: string; answered: number; yes: number; values: number[] }>();
        for (const [id, meta] of labels) {
            stats.set(id, { id, label: meta.label, kind: meta.kind, answered: 0, yes: 0, values: [] });
        }

        for (const r of rows) {
            const answers = ((r as Record<string, unknown>).answers ?? {}) as Record<string, unknown>;
            for (const [id, value] of Object.entries(answers)) {
                const bucket = stats.get(id);
                if (!bucket) continue;
                if (value === null || value === undefined || value === '') continue;
                bucket.answered += 1;
                if (value === true) bucket.yes += 1;
                if (typeof value === 'number') bucket.values.push(value);
            }
        }

        const data = Array.from(stats.values()).map(s => ({
            id: s.id,
            label: s.label,
            kind: s.kind,
            answered: s.answered,
            // ติ๊ก — จำนวนใบที่ติ๊กจริง คิดเป็นร้อยละของใบทั้งหมดในช่วง
            yes: s.kind === 'check' ? s.yes : null,
            percent: s.kind === 'check' && rows.length > 0
                ? Math.round((s.yes / rows.length) * 1000) / 10
                : null,
            // ตัวเลข — ค่าเฉลี่ยกับช่วง เอาไว้ดูว่าค่าที่วัดกระจายอย่างไร
            avg: s.values.length > 0
                ? Math.round((s.values.reduce((a, b) => a + b, 0) / s.values.length) * 10) / 10
                : null,
            min: s.values.length > 0 ? Math.min(...s.values) : null,
            max: s.values.length > 0 ? Math.max(...s.values) : null,
        }));

        return { success: true, template_code: template_code.trim(), total: rows.length, data };
    } catch (error) {
        console.error('Get focus indicators error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
