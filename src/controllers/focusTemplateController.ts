import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor, type Actor } from '../utils/nursingRecord';
import { isAdmin } from './systemSettingsController';
import { normalizeTemplateBody, type TemplateBody } from '../utils/focusTemplate';

/**
 * แม่แบบแผนการพยาบาลแบบ Focus list (CNPG)
 *
 * เนื้อหาเขียนไว้ล่วงหน้าโดยหอผู้ป่วยเจ้าของ พยาบาลหน้างานไม่ได้พิมพ์เอง
 * จึงต้องคุมเหมือนเอกสารวิชาการ: มีสถานะ มีเลขรุ่น และเก็บประวัติการแก้ทุกครั้ง
 *
 * แก้ได้เฉพาะผู้ดูแลระบบ แต่ "อ่าน" ได้ทุกคน เพราะหอไหนก็หยิบไปใช้ได้
 */

const VALID_STATUS = ['draft', 'published', 'retired'];

/** postgres.js รับเฉพาะ JSONValue ที่มี index signature ตัวช่วยนี้ทำให้ส่ง interface ปกติได้ */
const asJson = (v: unknown) => nurse.json(v as never);

const MAX_LENGTH: Record<string, number> = {
    code: 40, owner_ward_code: 20, owner_ward_name: 100,
    title: 200, objective: 2000,
};

const LENGTH_LABELS: Record<string, string> = {
    code: 'รหัสแม่แบบ', owner_ward_code: 'รหัสหอผู้ป่วย', owner_ward_name: 'ชื่อหอผู้ป่วย',
    title: 'ชื่อ Focus', objective: 'วัตถุประสงค์',
};

const tooLong = (values: Record<string, unknown>): string | null => {
    for (const [field, max] of Object.entries(MAX_LENGTH)) {
        const v = values[field];
        if (v === null || v === undefined) continue;
        if (String(v).length > max) return `${LENGTH_LABELS[field] ?? field} ยาวเกิน ${max} ตัวอักษร`;
    }
    return null;
};

/** ล้างแท็กออกจากข้อความทุกจุดที่คนพิมพ์เอง รวมถึงข้อความที่ฝังอยู่ใน jsonb */
const cleanBody = (body: TemplateBody): TemplateBody => ({
    sections: body.sections.map(s => ({
        ...s,
        title: sanitizeHTML(s.title) ?? '',
        activities: s.activities.map(a => sanitizeHTML(a) ?? ''),
        evaluations: s.evaluations.map(e => ({
            ...e,
            label: sanitizeHTML(e.label) ?? '',
            unit: e.unit ? sanitizeHTML(e.unit) : e.unit,
            options: e.options?.map(o => sanitizeHTML(o) ?? ''),
        })),
    })),
});

const sanitizeRow = (row: Record<string, unknown>) => ({
    ...row,
    title: typeof row.title === 'string' ? sanitizeHTML(row.title) : row.title,
    objective: typeof row.objective === 'string' ? sanitizeHTML(row.objective) : row.objective,
    owner_ward_name: typeof row.owner_ward_name === 'string' ? sanitizeHTML(row.owner_ward_name) : row.owner_ward_name,
});

/** ชื่อหอผู้ป่วยยึดตามทะเบียนหอ ไม่รับจากฟอร์ม จะได้ไม่มีชื่อเรียกคนละอย่างของหอเดียวกัน */
const wardNameOf = async (code: string): Promise<string | null> => {
    try {
        const rows = await nurse`SELECT ward_name FROM ward WHERE ward = ${code} LIMIT 1`;
        return String(rows[0]?.ward_name ?? '').trim() || null;
    } catch (error) {
        console.error('Ward name lookup error:', error);
        return null;
    }
};

const recordRevision = async (
    templateId: number, version: number, snapshot: unknown,
    action: string, reason: string | null, by: Actor
) => {
    try {
        await nurse`
            INSERT INTO care_plan_template_revisions ${nurse({
                template_id: templateId,
                version,
                snapshot: asJson(snapshot),
                action,
                reason,
                changed_by: by.username,
                changed_by_name: by.fullname,
                changed_at: new Date(),
            })}
        `;
    } catch (error) {
        // ประวัติเสียไม่ควรทำให้การบันทึกล้ม แต่ต้องเห็นใน log ว่ามีที่หายไป
        console.error('Record template revision error:', error);
    }
};

const requireAdmin = async (user: unknown, set: Context['set']) => {
    if (await isAdmin(user)) return null;
    set.status = 403;
    return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่จัดการแม่แบบได้' };
};

// ---------- รายการแม่แบบ ----------
/**
 * ปกติคืนเฉพาะที่เผยแพร่แล้ว เพราะพยาบาลหน้างานต้องไม่เห็นฉบับร่าง
 * หน้าจัดการของผู้ดูแลระบบส่ง status=all มาเพื่อเห็นทั้งหมด
 */
export const listFocusTemplates = async ({ query, set, user }: Context & { user: any }) => {
    const { ward_code, status, q } = (query ?? {}) as {
        ward_code?: string; status?: string; q?: string;
    };

    const wanted = String(status ?? 'published').trim();
    if (wanted !== 'all' && !VALID_STATUS.includes(wanted)) {
        set.status = 400;
        return { success: false, message: 'สถานะที่ใช้กรองไม่ถูกต้อง (draft / published / retired / all)' };
    }

    const canManage = await isAdmin(user);
    // เห็นฉบับร่างได้เฉพาะผู้ดูแลระบบ ต่อให้ยิง status=draft ตรงๆ ก็ไม่ได้
    if (wanted !== 'published' && !canManage) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่ดูแม่แบบฉบับร่างได้' };
    }

    const ward = String(ward_code ?? '').trim();
    const keyword = String(q ?? '').trim();

    try {
        const rows = await nurse`
            SELECT id, code, title, objective, owner_ward_code, owner_ward_name,
                   version, status, updated_at, updated_by, updated_by_name,
                   created_at, created_by, created_by_name,
                   jsonb_array_length(body->'sections') AS section_count
            FROM care_plan_templates
            WHERE is_deleted IS NOT TRUE
              ${wanted === 'all' ? nurse`` : nurse`AND status = ${wanted}`}
              ${ward ? nurse`AND owner_ward_code = ${ward}` : nurse``}
              ${keyword ? nurse`AND (title ILIKE ${'%' + keyword + '%'} OR code ILIKE ${'%' + keyword + '%'})` : nurse``}
            ORDER BY owner_ward_name NULLS LAST, title
        `;

        return {
            success: true,
            can_manage: canManage,
            total: rows.length,
            data: rows.map(r => sanitizeRow(r as Record<string, unknown>)),
        };
    } catch (error) {
        console.error('List focus templates error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แม่แบบหนึ่งใบพร้อมเนื้อหา ----------
export const getFocusTemplate = async ({ params, set, user }: Context & { user: any }) => {
    const templateId = Number((params as { id: string }).id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT * FROM care_plan_templates WHERE id = ${templateId} AND is_deleted IS NOT TRUE
        `;
        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบแม่แบบที่ต้องการ' };
        }

        const row = rows[0] as Record<string, unknown>;
        const canManage = await isAdmin(user);
        if (row.status !== 'published' && !canManage) {
            set.status = 403;
            return { success: false, message: 'แม่แบบนี้ยังไม่เผยแพร่' };
        }

        return { success: true, can_manage: canManage, data: sanitizeRow(row) };
    } catch (error) {
        console.error('Get focus template error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- สร้างแม่แบบใหม่ ----------
export const saveFocusTemplate = async ({ body, set, user }: Context & { user: any }) => {
    const denied = await requireAdmin(user, set);
    if (denied) return denied;

    const payload = (body ?? {}) as Record<string, unknown>;
    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    const code = String(payload.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
        set.status = 400;
        return { success: false, message: 'รหัสแม่แบบต้องยาว 2-40 ตัว ใช้ A-Z 0-9 _ - เท่านั้น' };
    }

    const title = String(payload.title ?? '').trim();
    if (title.length < 3) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุชื่อ Focus อย่างน้อย 3 ตัวอักษร' };
    }

    const wardCode = String(payload.owner_ward_code ?? '').trim();
    if (!wardCode) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุหอผู้ป่วยเจ้าของแม่แบบ' };
    }

    const built = normalizeTemplateBody(payload.body);
    if ('error' in built) {
        set.status = 400;
        return { success: false, message: built.error };
    }

    const values = {
        code,
        title,
        objective: String(payload.objective ?? '').trim() || null,
        owner_ward_code: wardCode,
        owner_ward_name: await wardNameOf(wardCode),
        body: cleanBody(built.body),
        version: 1,
        // สร้างมาเป็นร่างเสมอ ต้องกดเผยแพร่อีกครั้งจึงจะมีคนหยิบไปใช้ได้
        status: 'draft',
    };

    const lengthError = tooLong(values);
    if (lengthError) {
        set.status = 400;
        return { success: false, message: lengthError };
    }

    try {
        const saved = await nurse`
            INSERT INTO care_plan_templates ${nurse({
                ...values,
                body: asJson(values.body),
                created_at: new Date(),
                created_by: actor.username,
                created_by_name: actor.fullname,
            })}
            RETURNING *
        `;
        const row = saved[0] as Record<string, unknown>;

        await recordRevision(Number(row.id), 1, row, 'create', null, actor);

        return {
            success: true,
            message: 'สร้างแม่แบบเรียบร้อยแล้ว (ยังเป็นฉบับร่าง กดเผยแพร่เพื่อให้หอผู้ป่วยใช้งาน)',
            data: sanitizeRow(row),
        };
    } catch (error) {
        if ((error as { code?: string })?.code === '23505') {
            set.status = 409;
            return { success: false, message: `รหัสแม่แบบ "${code}" ถูกใช้ไปแล้ว` };
        }
        console.error('Save focus template error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แก้ไขแม่แบบ ----------
export const updateFocusTemplate = async ({ params, body, set, user }: Context & { user: any }) => {
    const denied = await requireAdmin(user, set);
    if (denied) return denied;

    const templateId = Number((params as { id: string }).id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
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
            SELECT * FROM care_plan_templates WHERE id = ${templateId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบแม่แบบที่ต้องการแก้ไข' };
        }
        const prev = current[0] as Record<string, unknown>;

        const values: Record<string, unknown> = {};

        if (payload.title !== undefined) {
            const title = String(payload.title).trim();
            if (title.length < 3) {
                set.status = 400;
                return { success: false, message: 'กรุณาระบุชื่อ Focus อย่างน้อย 3 ตัวอักษร' };
            }
            values.title = title;
        }

        if (payload.objective !== undefined) {
            values.objective = String(payload.objective).trim() || null;
        }

        if (payload.owner_ward_code !== undefined) {
            const wardCode = String(payload.owner_ward_code).trim();
            if (!wardCode) {
                set.status = 400;
                return { success: false, message: 'กรุณาระบุหอผู้ป่วยเจ้าของแม่แบบ' };
            }
            values.owner_ward_code = wardCode;
            values.owner_ward_name = await wardNameOf(wardCode);
        }

        let bodyChanged = false;
        if (payload.body !== undefined) {
            const built = normalizeTemplateBody(payload.body);
            if ('error' in built) {
                set.status = 400;
                return { success: false, message: built.error };
            }
            const cleaned = cleanBody(built.body);
            bodyChanged = JSON.stringify(cleaned) !== JSON.stringify(prev.body);
            if (bodyChanged) values.body = asJson(cleaned);
        }

        if (Object.keys(values).length === 0) {
            return { success: true, message: 'ไม่มีการเปลี่ยนแปลง', data: sanitizeRow(prev) };
        }

        const lengthError = tooLong({ ...prev, ...values });
        if (lengthError) {
            set.status = 400;
            return { success: false, message: lengthError };
        }

        // เลขรุ่นขยับเมื่อเนื้อหาเปลี่ยนเท่านั้น การแก้ชื่อหรือเจ้าของไม่ทำให้บันทึกเก่าอ่านต่างไป
        const nextVersion = bodyChanged ? Number(prev.version) + 1 : Number(prev.version);
        if (bodyChanged) values.version = nextVersion;

        const saved = await nurse`
            UPDATE care_plan_templates
            SET ${nurse({
                ...values,
                updated_at: new Date(),
                updated_by: actor.username,
                updated_by_name: actor.fullname,
            })}
            WHERE id = ${templateId}
            RETURNING *
        `;
        const row = saved[0] as Record<string, unknown>;

        await recordRevision(
            templateId, nextVersion, row, 'update',
            String(payload.reason ?? '').trim().slice(0, 500) || null, actor
        );

        return {
            success: true,
            message: bodyChanged
                ? `แก้ไขแม่แบบเรียบร้อยแล้ว (เป็นรุ่นที่ ${nextVersion})`
                : 'แก้ไขแม่แบบเรียบร้อยแล้ว',
            data: sanitizeRow(row),
        };
    } catch (error) {
        console.error('Update focus template error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- เปลี่ยนสถานะ (เผยแพร่ / เลิกใช้ / กลับเป็นร่าง) ----------
export const setFocusTemplateStatus = async ({ params, body, set, user }: Context & { user: any }) => {
    const denied = await requireAdmin(user, set);
    if (denied) return denied;

    const templateId = Number((params as { id: string }).id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const payload = (body ?? {}) as Record<string, unknown>;
    const status = String(payload.status ?? '').trim();
    if (!VALID_STATUS.includes(status)) {
        set.status = 400;
        return { success: false, message: 'สถานะไม่ถูกต้อง (draft / published / retired)' };
    }

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    try {
        const current = await nurse`
            SELECT * FROM care_plan_templates WHERE id = ${templateId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบแม่แบบที่ต้องการ' };
        }
        const prev = current[0] as Record<string, unknown>;

        // แม่แบบเปล่าเผยแพร่ไม่ได้ ไม่งั้นพยาบาลเลือกไปแล้วได้ใบว่าง
        if (status === 'published') {
            const sections = (prev.body as { sections?: unknown[] } | null)?.sections ?? [];
            if (!Array.isArray(sections) || sections.length === 0) {
                set.status = 400;
                return { success: false, message: 'แม่แบบยังไม่มีเนื้อหา เผยแพร่ไม่ได้' };
            }
        }

        const saved = await nurse`
            UPDATE care_plan_templates
            SET status = ${status}, updated_at = ${new Date()},
                updated_by = ${actor.username}, updated_by_name = ${actor.fullname}
            WHERE id = ${templateId}
            RETURNING *
        `;
        const row = saved[0] as Record<string, unknown>;

        await recordRevision(
            templateId, Number(row.version), row,
            status === 'published' ? 'publish' : status === 'retired' ? 'retire' : 'unpublish',
            String(payload.reason ?? '').trim().slice(0, 500) || null, actor
        );

        const message = status === 'published'
            ? 'เผยแพร่แม่แบบแล้ว หอผู้ป่วยเลือกใช้ได้ทันที'
            : status === 'retired'
                ? 'เลิกใช้แม่แบบแล้ว บันทึกเดิมยังอ่านได้ตามปกติ'
                : 'เปลี่ยนกลับเป็นฉบับร่างแล้ว จะไม่ขึ้นให้เลือกจนกว่าจะเผยแพร่อีกครั้ง';

        return { success: true, message, data: sanitizeRow(row) };
    } catch (error) {
        console.error('Set focus template status error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ประวัติการแก้ไข ----------
export const getFocusTemplateRevisions = async ({ params, set, user }: Context & { user: any }) => {
    const denied = await requireAdmin(user, set);
    if (denied) return denied;

    const templateId = Number((params as { id: string }).id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT id, version, action, reason, changed_by, changed_by_name, changed_at
            FROM care_plan_template_revisions
            WHERE template_id = ${templateId}
            ORDER BY changed_at DESC, id DESC
        `;
        return { success: true, total: rows.length, data: rows };
    } catch (error) {
        console.error('Get focus template revisions error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ลบแม่แบบ ----------
export const deleteFocusTemplate = async ({ params, set, user }: Context & { user: any }) => {
    const denied = await requireAdmin(user, set);
    if (denied) return denied;

    const templateId = Number((params as { id: string }).id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
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
            SELECT * FROM care_plan_templates WHERE id = ${templateId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบแม่แบบที่ต้องการลบ' };
        }

        // แม่แบบที่ถูกใช้ไปแล้วลบไม่ได้ ให้เลิกใช้แทน
        // บันทึกเก่ามีสำเนาโครงของตัวเองอยู่แล้วก็จริง แต่ยังอ้าง template_id เป็น foreign key
        const used = await nurse`
            SELECT count(*)::int AS n FROM nursing_focus_records
            WHERE template_id = ${templateId} AND is_deleted IS NOT TRUE
        `;
        const n = Number((used[0] as { n: number }).n);
        if (n > 0) {
            set.status = 409;
            return {
                success: false,
                message: `แม่แบบนี้ถูกใช้บันทึกไปแล้ว ${n} ใบ ลบไม่ได้ กรุณาเปลี่ยนสถานะเป็น "เลิกใช้" แทน`,
            };
        }

        await nurse`
            UPDATE care_plan_templates
            SET is_deleted = TRUE, updated_at = ${new Date()},
                updated_by = ${actor.username}, updated_by_name = ${actor.fullname}
            WHERE id = ${templateId}
        `;
        await recordRevision(
            templateId, Number((current[0] as Record<string, unknown>).version),
            current[0], 'delete', null, actor
        );

        return { success: true, message: 'ลบแม่แบบเรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Delete focus template error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
