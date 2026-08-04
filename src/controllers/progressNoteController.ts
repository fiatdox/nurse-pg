import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import {
    toLocalDate, shiftOfTime, resolveActor, canCosign,
    type Actor, type RoleClass,
} from '../utils/nursingRecord';

/** คอลัมน์ที่รับบันทึกได้จาก client — ฟิลด์นอกรายการนี้จะถูกตัดทิ้ง */
const NOTE_FIELDS = [
    // ไม่มี nurse_name / staff_id — ผู้บันทึกมาจาก token เท่านั้น
    // ไม่มี shift — เวรเป็นผลของ record_datetime ไม่ใช่ค่าที่เลือกเอง จะได้ไม่ขัดกัน
    // ไม่มี author_role — มาจากตำแหน่งจริงในระบบบุคลากร ไม่ใช่ที่ผู้ใช้เลือกเอง
    // ไม่มี status — เป็นผลของว่าใครกรอกและใครอนุมัติ
    'ward_code', 'ward_name', 'record_datetime',
    'entered_by_trainee', 'trainee_institute',
    'focus', 'note_type', 'care_plan_id',
    'nanda_code', 'nanda_label', 'nic_codes', 'noc_codes',
    'subjective', 'objective', 'assessment', 'intervention', 'plan', 'evaluation',
] as const;

/** ฟิลด์ข้อความที่พยาบาลพิมพ์เอง ต้องล้างแท็กก่อนส่งออก */
const NOTE_TEXT_FIELDS = [
    'ward_name', 'nurse_name', 'shift', 'focus', 'note_type', 'nanda_label',
    'nic_codes', 'noc_codes', 'cosigned_by', 'entered_by_trainee', 'trainee_institute',
    'subjective', 'objective', 'assessment', 'intervention', 'plan', 'evaluation',
];

const VALID_TYPES = ['DAR', 'FOCUS', 'SOAP', 'SOAPIE', 'PIE'];

/**
 * บันทึกที่ต้องผ่านการอนุมัติจากพยาบาลวิชาชีพก่อนจึงจะเป็นเวชระเบียน
 *
 * 1) นักศึกษาเป็นคนกรอก — นักศึกษาไม่มีบัญชีของตัวเอง จึงกรอกผ่านบัญชีพยาบาลที่ควบคุมอยู่
 *    พยาบาลเจ้าของบัญชีต้องอ่านแล้วกดอนุมัติ เทียบเท่านักศึกษาเขียนแล้วพยาบาลเซ็นกำกับในกระดาษ
 * 2) ผู้ช่วยพยาบาลบันทึกเอง — ต้องมีพยาบาลวิชาชีพรับรอง
 */
const needsApproval = (traineeName: string | null, roleClass: RoleClass): boolean =>
    traineeName !== null || roleClass === 'assistant' || roleClass === 'other';

/** ช่องเนื้อหาที่แต่ละกรอบการบันทึกใช้จริง — server ใช้ตรวจว่ากรอกครบตามกรอบที่เลือก */
const FRAMEWORK_FIELDS: Record<string, string[]> = {
    DAR: ['subjective', 'objective', 'intervention', 'evaluation'],
    FOCUS: ['subjective', 'objective', 'intervention', 'evaluation'],
    SOAP: ['subjective', 'objective', 'assessment', 'plan'],
    SOAPIE: ['subjective', 'objective', 'assessment', 'plan', 'intervention', 'evaluation'],
    PIE: ['assessment', 'intervention', 'evaluation'],
};

/** บันทึกที่เกิน 24 ชม.หลังเวลาเหตุการณ์ ถือเป็นการบันทึกย้อนหลัง ต้องแสดงให้ผู้ตรวจเห็น */
const LATE_ENTRY_HOURS = 24;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * เพดานความยาวของคอลัมน์ที่ยังเป็น varchar
 * ช่องข้อความอิสระ (focus, nanda_label, nic_codes, noc_codes และเนื้อหาทั้งหก)
 * เปลี่ยนเป็น text แล้ว พยาบาลเขียนได้ยาวเท่าที่ต้องเขียนจริง
 * ที่เหลือเป็นรหัสและชื่อซึ่งยาวเกินนี้ไม่ได้อยู่แล้ว ต้องคืน 400 ไม่ใช่ปล่อยไปพังเป็น 500
 */
const MAX_LENGTH: Record<string, number> = {
    an: 20, ward_code: 20, ward_name: 100, shift: 10,
    note_type: 10, nanda_code: 10, author_role: 30, cosigned_by: 100,
};

const LENGTH_LABELS: Record<string, string> = {
    an: 'AN', ward_code: 'รหัสหอผู้ป่วย', ward_name: 'ชื่อหอผู้ป่วย', shift: 'เวร',
    note_type: 'กรอบการบันทึก', nanda_code: 'รหัส NANDA',
    author_role: 'ระดับผู้บันทึก', cosigned_by: 'ผู้ลงนามกำกับ',
};

/** คืนข้อความบอกฟิลด์ที่ยาวเกิน หรือ null เมื่อผ่านทั้งหมด */
const tooLong = (values: Record<string, unknown>): string | null => {
    for (const [field, max] of Object.entries(MAX_LENGTH)) {
        const v = values[field];
        if (v === null || v === undefined) continue;
        if (String(v).length > max) {
            return `${LENGTH_LABELS[field] ?? field} ยาวเกิน ${max} ตัวอักษร`;
        }
    }
    return null;
};

const sanitizeRow = (row: Record<string, unknown>) => {
    const out = { ...row };
    for (const f of NOTE_TEXT_FIELDS) {
        if (typeof out[f] === 'string') out[f] = sanitizeHTML(out[f] as string);
    }
    // คำนวณตอนอ่าน ไม่เก็บเป็นคอลัมน์ เพราะเป็นผลลัพธ์ของสองเวลาที่มีอยู่แล้ว
    const at = out.record_datetime ? new Date(String(out.record_datetime)).getTime() : NaN;
    const wrote = out.created_at ? new Date(String(out.created_at)).getTime() : NaN;
    out.is_late_entry =
        Number.isFinite(at) && Number.isFinite(wrote) && wrote - at > LATE_ENTRY_HOURS * 3600_000;
    out.is_draft = out.status === 'draft';
    // นักศึกษากรอก = ต้องอ่านทวนก่อนอนุมัติ แสดงให้ผู้ตรวจเห็นชัดว่าใครเป็นคนพิมพ์
    out.by_trainee = Boolean(out.entered_by_trainee);
    return out;
};

/**
 * ตรวจและแปลงค่าที่รับมาให้พร้อมเขียนลงตาราง
 * ใช้ร่วมกันทั้งตอนสร้างใหม่และตอนแก้ไข เพื่อให้กติกาเหมือนกันทั้งสองทาง
 */
const buildValues = (payload: Record<string, unknown>, actor: Actor) => {
    const noteType = String(payload.note_type ?? 'DAR').trim() || 'DAR';
    if (!VALID_TYPES.includes(noteType)) return { error: 'กรอบการบันทึกไม่ถูกต้อง' };

    // ต้องกรอกอย่างน้อยหนึ่งช่องของกรอบที่เลือก ไม่ใช่ช่องไหนก็ได้
    // ไม่งั้นเลือก SOAP แล้วกรอกแต่ช่องของ DAR จะผ่าน ทั้งที่บันทึกไม่ตรงกรอบ
    const inFramework = FRAMEWORK_FIELDS[noteType] ?? [];
    const filled = inFramework.filter(f => String(payload[f] ?? '').trim() !== '');
    if (filled.length === 0) {
        return { error: `กรุณาบันทึกเนื้อหาอย่างน้อยหนึ่งช่องตามกรอบ ${noteType}` };
    }

    const recordDatetime = toLocalDate(payload.record_datetime) ?? new Date();

    const values: Record<string, unknown> = {};
    for (const f of NOTE_FIELDS) {
        const v = payload[f];
        values[f] = v === undefined || v === '' ? null : v;
    }
    // ผู้บันทึกมาจากบัญชีที่เข้าสู่ระบบ ไม่ใช่จากฟอร์ม — เป็นข้อมูลที่ใช้อ้างอิงว่าใครลงบันทึก
    values.staff_id = actor.userId;
    values.nurse_name = actor.fullname;
    // ตำแหน่งจริงในระบบบุคลากร ไม่ใช่ที่ผู้ใช้เลือก ไม่งั้นผู้ช่วยพยาบาลเลือกเป็นวิชาชีพแล้วเลี่ยงการตรวจสอบได้
    values.author_role = actor.roleClass;
    values.note_type = noteType;
    values.record_datetime = recordDatetime;
    values.shift = shiftOfTime(recordDatetime);

    const trainee = String(payload.entered_by_trainee ?? '').trim();
    if (trainee && trainee.length < 3) {
        return { error: 'กรุณาระบุชื่อนักศึกษาผู้กรอกข้อมูลให้ครบถ้วน' };
    }
    values.entered_by_trainee = trainee || null;
    values.trainee_institute = trainee ? String(payload.trainee_institute ?? '').trim() || null : null;
    // ร่างยังไม่เป็นเวชระเบียน จนกว่าพยาบาลวิชาชีพจะอ่านแล้วอนุมัติ
    values.status = needsApproval(values.entered_by_trainee as string | null, actor.roleClass)
        ? 'draft'
        : 'approved';
    values.care_plan_id =
        payload.care_plan_id === null || payload.care_plan_id === undefined || payload.care_plan_id === ''
            ? null
            : Number(payload.care_plan_id);

    const lengthError = tooLong({ ...values, an: payload.an });
    if (lengthError) return { error: lengthError };

    return { values };
};

// ---------- ดึงบันทึกทางการพยาบาลตาม AN ----------
export const getProgressNotesByAN = async ({ params, query, set }: Context) => {
    const { an } = params as { an: string };
    const { limit, status } = (query ?? {}) as { limit?: string; status?: string };

    if (!an?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
    // status=approved ใช้เวลาออกเวชระเบียน/รายงาน ร่างต้องไม่ติดไปด้วย
    // ไม่ส่งมา = เอาทั้งหมด เพราะหน้าจอพยาบาลต้องเห็นร่างเพื่อแก้และอนุมัติ
    const onlyApproved = String(status ?? '').trim() === 'approved';

    try {
        // ดึงชื่อข้อวินิจฉัยจากแผนการพยาบาลมาด้วย จะได้ไม่ต้องยิงซ้ำทีละรายการ
        const rows = await nurse`
            SELECT n.*, cp.nursing_diagnosis AS care_plan_diagnosis
            FROM nursing_progress_notes n
            LEFT JOIN nursing_care_plans cp ON cp.id = n.care_plan_id
            WHERE n.an = ${an.trim()}
              AND n.is_deleted IS NOT TRUE
              ${onlyApproved ? nurse`AND n.status = 'approved'` : nurse``}
            ORDER BY n.record_datetime DESC, n.id DESC
            LIMIT ${take}
        `;

        return { success: true, data: rows.map(r => sanitizeRow(r as Record<string, unknown>)) };
    } catch (error) {
        console.error('Get progress notes error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- บันทึกใหม่ ----------
export const saveProgressNote = async ({ body, set, user }: Context & { user: any }) => {
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

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    // กุญแจกันส่งซ้ำ: ส่ง payload เดิมกี่รอบก็ได้บันทึกเดียว
    const requestId =
        typeof payload.request_id === 'string' && UUID_RE.test(payload.request_id)
            ? payload.request_id
            : null;

    if (requestId) {
        const seen = await nurse`
            SELECT * FROM nursing_progress_notes WHERE request_id = ${requestId} LIMIT 1
        `;
        if (seen.length > 0) {
            // คำขอเดิมสำเร็จไปแล้ว ไม่ใช่ความผิดพลาด
            return {
                success: true,
                duplicate: true,
                message: 'บันทึกนี้ถูกบันทึกไว้แล้ว ระบบไม่ได้บันทึกซ้ำ',
                data: sanitizeRow(seen[0] as Record<string, unknown>),
            };
        }
    }

    const built = buildValues(payload, actor);
    if (built.error) {
        set.status = 400;
        return { success: false, message: built.error };
    }

    try {
        const saved = await nurse`
            INSERT INTO nursing_progress_notes ${nurse({
                an,
                ...built.values!,
                request_id: requestId,
                revision_no: 0,
                created_at: new Date(),
                created_by: actor.username,
            })}
            RETURNING *
        `;

        return {
            success: true,
            message: 'บันทึกทางการพยาบาลเรียบร้อยแล้ว',
            data: sanitizeRow(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        // สองคำขอที่เหมือนกันมาถึงพร้อมกัน ตัวที่แพ้มาชนที่ unique index
        if ((error as { code?: string })?.code === '23505' && requestId) {
            const seen = await nurse`
                SELECT * FROM nursing_progress_notes WHERE request_id = ${requestId} LIMIT 1
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
        console.error('Save progress note error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แก้ไขบันทึกเดิม ----------
export const updateProgressNote = async ({ params, body, set, user }: Context & { user: any }) => {
    const { id } = params as { id: string };
    const noteId = Number(id);
    const payload = (body ?? {}) as Record<string, unknown>;

    if (!Number.isInteger(noteId) || noteId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const reason = String(payload.amend_reason ?? '').trim();

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    const built = buildValues(payload, actor);
    if (built.error) {
        set.status = 400;
        return { success: false, message: built.error };
    }

    try {
        const current = await nurse`
            SELECT * FROM nursing_progress_notes
            WHERE id = ${noteId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบบันทึกที่ต้องการแก้ไข' };
        }

        const prev = current[0] as Record<string, unknown>;
        const isDraft = prev.status === 'draft';

        // ร่างยังไม่เป็นเวชระเบียน แก้ได้เลยโดยไม่ต้องมีเหตุผลและไม่เก็บประวัติ
        // แต่พออนุมัติแล้วจะเป็นเอกสารทางกฎหมาย การแก้ต้องมีเหตุผลกำกับเทียบเท่าการขีดฆ่าแล้วเซ็นในกระดาษ
        if (!isDraft && reason.length < 5) {
            set.status = 400;
            return { success: false, message: 'กรุณาระบุเหตุผลในการแก้ไข อย่างน้อย 5 ตัวอักษร' };
        }

        // ร่างของใครคนนั้นแก้ได้ คนอื่นแก้ไม่ได้ (พยาบาลผู้ตรวจใช้วิธีส่งกลับ ไม่ใช่แก้แทน)
        if (isDraft && String(prev.staff_id ?? '') !== actor.userId) {
            set.status = 403;
            return { success: false, message: 'แก้ไขร่างของผู้อื่นไม่ได้ ร่างนี้เป็นของ ' + String(prev.nurse_name ?? '-') };
        }

        const nextRevision = Number(prev.revision_no ?? 0) + 1;

        // ไม่ให้แก้ an เพื่อกันบันทึกย้ายข้ามผู้ป่วยโดยไม่ตั้งใจ
        const { an: _ignored, ...values } = built.values!;

        // ถ้าไม่ได้ส่งเวลามาด้วย ให้คงเวลาเดิมไว้ ไม่ใช่เขียนทับเป็นเวลาที่กดแก้ไข
        // เวลาในบันทึกทางการพยาบาลคือเวลาที่เกิดเหตุการณ์ ไม่ใช่เวลาที่พิมพ์
        if (!payload.record_datetime) {
            delete values.record_datetime;
            delete values.shift;
        }

        if (isDraft) {
            // แก้ร่าง ไม่เก็บ revision และคงสถานะร่างไว้ให้รออนุมัติเหมือนเดิม
            const saved = await nurse`
                UPDATE nursing_progress_notes
                SET ${nurse({ ...values, updated_at: new Date(), updated_by: actor.username })}
                WHERE id = ${noteId}
                RETURNING *
            `;
            return {
                success: true,
                message: 'แก้ไขร่างเรียบร้อยแล้ว (ยังรอพยาบาลวิชาชีพอนุมัติ)',
                data: sanitizeRow(saved[0] as Record<string, unknown>),
            };
        }

        // เก็บฉบับเดิมไว้ก่อนทับ แล้วค่อยอัปเดต — สองคำสั่งนี้ต้องสำเร็จหรือล้มเหลวพร้อมกัน
        const updated = await nurse.begin(async tx => {
            await tx`
                INSERT INTO nursing_progress_note_revisions ${tx({
                    note_id: noteId,
                    revision_no: nextRevision,
                    // ต้องใช้ tx.json ไม่ใช่ JSON.stringify ไม่งั้นคอลัมน์ jsonb
                    // จะเก็บเป็น "สตริงที่หน้าตาเหมือน JSON" แล้วอ่านกลับเป็น object ไม่ได้
                    snapshot: tx.json(prev as never),
                    action: 'update',
                    reason,
                    changed_by: actor.username,
                    changed_at: new Date(),
                })}
            `;
            return tx`
                UPDATE nursing_progress_notes
                SET ${tx({ ...values, revision_no: nextRevision, updated_at: new Date(), updated_by: actor.username })}
                WHERE id = ${noteId}
                RETURNING *
            `;
        });

        return {
            success: true,
            message: `แก้ไขเรียบร้อยแล้ว (ฉบับแก้ไขครั้งที่ ${nextRevision} — เก็บฉบับเดิมไว้แล้ว)`,
            data: sanitizeRow((updated as unknown as Record<string, unknown>[])[0]),
        };
    } catch (error) {
        console.error('Update progress note error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ลบ (soft delete พร้อมเก็บเหตุผล) ----------
export const deleteProgressNote = async ({ params, body, query, set, user }: Context & { user: any }) => {
    const { id } = params as { id: string };
    const noteId = Number(id);

    if (!Number.isInteger(noteId) || noteId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    // axios.delete ส่ง body ยาก จึงรับเหตุผลจาก query string ได้ด้วย
    const payload = (body ?? {}) as Record<string, unknown>;
    const q = (query ?? {}) as Record<string, unknown>;
    const reason = String(payload.reason ?? q.reason ?? '').trim();
    if (reason.length < 5) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุเหตุผลในการยกเลิกบันทึก อย่างน้อย 5 ตัวอักษร' };
    }

    const actor = String(user?.username ?? '') || null;

    try {
        const current = await nurse`
            SELECT * FROM nursing_progress_notes
            WHERE id = ${noteId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบบันทึกที่ต้องการยกเลิก' };
        }

        const prev = current[0] as Record<string, unknown>;

        await nurse.begin(async tx => {
            await tx`
                INSERT INTO nursing_progress_note_revisions ${tx({
                    note_id: noteId,
                    revision_no: Number(prev.revision_no ?? 0) + 1,
                    // ต้องใช้ tx.json ไม่ใช่ JSON.stringify ไม่งั้นคอลัมน์ jsonb
                    // จะเก็บเป็น "สตริงที่หน้าตาเหมือน JSON" แล้วอ่านกลับเป็น object ไม่ได้
                    snapshot: tx.json(prev as never),
                    action: 'delete',
                    reason,
                    changed_by: actor,
                    changed_at: new Date(),
                })}
            `;
            // เก็บแถวไว้เสมอ แค่ทำเครื่องหมายว่ายกเลิก เพื่อการตรวจสอบย้อนหลัง
            await tx`
                UPDATE nursing_progress_notes
                SET is_deleted = TRUE, updated_at = ${new Date()}, updated_by = ${actor}
                WHERE id = ${noteId}
            `;
        });

        return { success: true, message: 'ยกเลิกบันทึกเรียบร้อยแล้ว (เก็บไว้ในประวัติการแก้ไข)' };
    } catch (error) {
        console.error('Delete progress note error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ประวัติการแก้ไขของบันทึกหนึ่งฉบับ ----------
export const getProgressNoteRevisions = async ({ params, set }: Context) => {
    const { id } = params as { id: string };
    const noteId = Number(id);

    if (!Number.isInteger(noteId) || noteId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT id, note_id, revision_no, action, reason, changed_by, changed_at, snapshot
            FROM nursing_progress_note_revisions
            WHERE note_id = ${noteId}
            ORDER BY revision_no DESC
        `;
        return { success: true, data: rows };
    } catch (error) {
        console.error('Get note revisions error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- พยาบาลวิชาชีพอนุมัติร่าง ----------
export const approveProgressNote = async ({ params, set, user }: Context & { user: any }) => {
    const { id } = params as { id: string };
    const noteId = Number(id);

    if (!Number.isInteger(noteId) || noteId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    // ลายเซ็นต้องเป็นของคนที่เซ็นจริง จึงมาจากบัญชีที่เข้าสู่ระบบเท่านั้น
    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    // การอนุมัติคือการรับรองโดยผู้มีคุณวุฒิ ตำแหน่งจริงในระบบบุคลากรเท่านั้นที่บอกได้
    if (!canCosign(actor)) {
        set.status = 403;
        return {
            success: false,
            message: `เฉพาะพยาบาลวิชาชีพเท่านั้นที่อนุมัติได้ (บัญชีนี้เป็น${actor.positionName || 'ตำแหน่งที่ไม่ระบุ'})`,
        };
    }

    try {
        const current = await nurse`
            SELECT id, staff_id, nurse_name, status, entered_by_trainee
            FROM nursing_progress_notes
            WHERE id = ${noteId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบบันทึกที่ต้องการอนุมัติ' };
        }

        const note = current[0] as Record<string, unknown>;

        if (note.status !== 'draft') {
            set.status = 409;
            return { success: false, message: 'บันทึกนี้ได้รับการอนุมัติแล้ว' };
        }

        /*
         * รับรองงานของตัวเองไม่ได้ — แต่กรณี "นักศึกษากรอกผ่านบัญชีพยาบาล" ต่างออกไป
         * เจ้าของบัญชีคือพยาบาลผู้ควบคุมที่ต้องอ่านทวนสิ่งที่นักศึกษาพิมพ์แล้วรับรอง
         * ตรงกับกระดาษที่นักศึกษาเขียนแล้วพยาบาลอ่านและเซ็นกำกับ จึงอนุญาตเฉพาะกรณีนี้
         */
        const isOwn = String(note.staff_id ?? '') === actor.userId;
        if (isOwn && !note.entered_by_trainee) {
            set.status = 403;
            return {
                success: false,
                message: 'อนุมัติบันทึกที่ตัวเองเขียนเองไม่ได้ ต้องให้พยาบาลวิชาชีพท่านอื่นตรวจสอบ',
            };
        }

        const updated = await nurse`
            UPDATE nursing_progress_notes
            SET status = 'approved',
                cosigned_by = ${actor.fullname}, cosigned_at = ${new Date()},
                updated_at = ${new Date()}, updated_by = ${actor.username}
            WHERE id = ${noteId} AND status = 'draft' AND is_deleted IS NOT TRUE
            RETURNING *
        `;

        if (updated.length === 0) {
            set.status = 409;
            return { success: false, message: 'บันทึกนี้เพิ่งถูกอนุมัติโดยผู้อื่น' };
        }

        return {
            success: true,
            message: note.entered_by_trainee
                ? `อนุมัติเรียบร้อย บันทึกที่ ${String(note.entered_by_trainee)} กรอกเข้าเวชระเบียนแล้ว`
                : 'อนุมัติเรียบร้อยแล้ว บันทึกเข้าเวชระเบียนแล้ว',
            data: sanitizeRow(updated[0] as Record<string, unknown>),
        };
    } catch (error) {
        console.error('Approve progress note error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ร่างที่รออนุมัติของหอผู้ป่วย (คิวงานของพยาบาลผู้ตรวจ) ----------
export const getPendingApprovals = async ({ query, set }: Context) => {
    const { ward_code } = (query ?? {}) as { ward_code?: string };

    if (!ward_code?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward_code' };
    }

    try {
        const rows = await nurse`
            SELECT * FROM nursing_progress_notes
            WHERE ward_code = ${ward_code.trim()}
              AND status = 'draft'
              AND is_deleted IS NOT TRUE
            ORDER BY record_datetime DESC, id DESC
            LIMIT 200
        `;
        return { success: true, data: rows.map(r => sanitizeRow(r as Record<string, unknown>)) };
    } catch (error) {
        console.error('Get pending approvals error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ตารางอ้างอิงภาษามาตรฐานทางการพยาบาล ----------
export const getNursingTerminology = async ({ set }: Context) => {
    try {
        const [nanda, nic, noc] = await Promise.all([
            nurse`SELECT code, domain, label_en, label_th FROM ref_nanda_diagnoses
                  WHERE is_active ORDER BY domain, sort_order`,
            nurse`SELECT code, domain, label_en, label_th FROM ref_nic_interventions
                  WHERE is_active ORDER BY domain, sort_order`,
            nurse`SELECT code, domain, label_en, label_th FROM ref_noc_outcomes
                  WHERE is_active ORDER BY domain, sort_order`,
        ]);
        return { success: true, data: { nanda, nic, noc } };
    } catch (error) {
        console.error('Get nursing terminology error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แผนการพยาบาลที่ยังใช้อยู่ของผู้ป่วย (ให้ note ผูกกลับได้) ----------
export const getActiveCarePlansByAN = async ({ params, set }: Context) => {
    const { an } = params as { an: string };

    if (!an?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    try {
        const rows = await nurse`
            SELECT id, nursing_diagnosis, goal, priority, status, start_date
            FROM nursing_care_plans
            WHERE an = ${an.trim()}
              AND is_deleted IS NOT TRUE
            ORDER BY start_date DESC NULLS LAST, id DESC
        `;
        return {
            success: true,
            data: rows.map(r => ({
                ...r,
                nursing_diagnosis: sanitizeHTML(String(r.nursing_diagnosis ?? '')),
                goal: sanitizeHTML(String(r.goal ?? '')),
            })),
        };
    } catch (error) {
        console.error('Get care plans error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
