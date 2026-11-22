import { Context } from 'elysia';
import { nurse } from '../db';
import { resolveGroups } from '../utils/userGroup';
import { sanitizeHTML } from '../utils/sanitize';

/**
 * กลุ่มเหตุผลที่ห้องยาส่งใบสั่งยากลับ (ใช้ทำสถิติ) — ตาราง rx_reject_categories
 *
 * อ่าน: เจ้าหน้าที่ทุกคน (ห้องยาใช้ตอนส่งกลับ)
 * แก้: กลุ่มงานเภสัชกรรม และแอดมิน
 * ไม่มีการลบ กลุ่มที่เลิกใช้ให้ปิด (active = false) สถิติย้อนหลังยังอ่านชื่อได้
 * รหัส (code) ตั้งครั้งเดียวตอนสร้าง ห้ามเปลี่ยน สถิติผูกกับรหัส · เปลี่ยนชื่อที่แสดงได้
 */

export interface RejectCategory { code: string; label: string; sort_order: number; active: boolean; require_note: boolean }

/** กลุ่มที่ยังเปิดใช้ ใช้ตรวจตอนส่งกลับ */
export const findActiveRejectCategory = async (code: unknown): Promise<RejectCategory | null> => {
    if (typeof code !== 'string' || !/^[a-z0-9_]{1,32}$/.test(code)) return null;
    const [row] = await nurse`
        SELECT code, label, sort_order, active, require_note
        FROM rx_reject_categories WHERE code = ${code} AND active`;
    return (row as unknown as RejectCategory) ?? null;
};

const canManage = async (user: unknown) => {
    const info = await resolveGroups(user);
    if (!info) return null;
    return { ok: info.isAdmin || info.groups.includes('pharmacy'), username: info.username };
};

const cleanLabel = (v: unknown) => (sanitizeHTML(String(v ?? '').trim()) ?? '').replace(/\s+/g, ' ').slice(0, 100);

/** GET /rx/reject-categories?all=1 — ค่าเริ่มต้นเฉพาะที่เปิดใช้ · all=1 รวมที่ปิด (หน้าตั้งค่า) */
export const listRejectCategories = async ({ query, user, set }: Context & { user?: unknown }) => {
    const who = await canManage(user);
    if (!who) { set.status = 401; return { success: false, message: 'ไม่พบข้อมูลผู้ใช้' }; }
    const all = (query as { all?: string } | undefined)?.all === '1';
    const rows = all
        ? await nurse`
            SELECT c.code, c.label, c.sort_order, c.active, c.require_note, c.updated_by,
                   TO_CHAR(c.updated_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') AS updated_at,
                   (SELECT COUNT(*)::int FROM rx_orders o WHERE o.reject_category = c.code) AS used
            FROM rx_reject_categories c ORDER BY c.sort_order, c.label`
        : await nurse`
            SELECT code, label, sort_order, active, require_note
            FROM rx_reject_categories WHERE active ORDER BY sort_order, label`;
    return { success: true, data: rows, can_manage: who.ok };
};

/** POST /rx/reject-categories { label, require_note? } — รหัสสร้างให้เอง ผู้ใช้ไม่ต้องตั้ง */
export const createRejectCategory = async ({ body, user, set }: Context & { user?: unknown }) => {
    const who = await canManage(user);
    if (!who?.ok) { set.status = 403; return { success: false, message: 'เฉพาะกลุ่มงานเภสัชกรรมหรือผู้ดูแลระบบ' }; }
    const b = body as { label?: string; require_note?: boolean };
    const label = cleanLabel(b?.label);
    if (label.length < 2) { set.status = 400; return { success: false, message: 'กรุณาพิมพ์ชื่อกลุ่ม' }; }

    const [dup] = await nurse`SELECT code FROM rx_reject_categories WHERE LOWER(label) = LOWER(${label})`;
    if (dup) { set.status = 409; return { success: false, message: 'มีกลุ่มชื่อนี้แล้ว (ถ้าปิดไว้ ให้เปิดใช้แทนการสร้างใหม่)' }; }

    const code = `c_${Date.now().toString(36)}`;
    /* ต่อท้ายก่อน "อื่น ๆ" (999) */
    const [row] = await nurse`
        INSERT INTO rx_reject_categories (code, label, sort_order, require_note, updated_by)
        VALUES (${code}, ${label},
                (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM rx_reject_categories WHERE sort_order < 999),
                ${b?.require_note === true}, ${who.username})
        RETURNING code, label, sort_order, active, require_note`;
    return { success: true, data: row };
};

/** PATCH /rx/reject-categories/:code { label?, active?, require_note? } */
export const updateRejectCategory = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const who = await canManage(user);
    if (!who?.ok) { set.status = 403; return { success: false, message: 'เฉพาะกลุ่มงานเภสัชกรรมหรือผู้ดูแลระบบ' }; }
    const code = String((params as { code?: string }).code ?? '');
    const b = (body ?? {}) as { label?: string; active?: boolean; require_note?: boolean };

    const label = b.label === undefined ? null : cleanLabel(b.label);
    if (label !== null && label.length < 2) { set.status = 400; return { success: false, message: 'ชื่อกลุ่มสั้นเกินไป' }; }
    if (label !== null) {
        const [dup] = await nurse`SELECT code FROM rx_reject_categories WHERE LOWER(label) = LOWER(${label}) AND code <> ${code}`;
        if (dup) { set.status = 409; return { success: false, message: 'มีกลุ่มชื่อนี้แล้ว' }; }
    }
    /* ต้องเหลือกลุ่มที่เปิดใช้อย่างน้อย 1 กลุ่ม ไม่งั้นห้องยาส่งกลับไม่ได้เลย */
    if (b.active === false) {
        const [{ n }] = await nurse`SELECT COUNT(*)::int AS n FROM rx_reject_categories WHERE active AND code <> ${code}`;
        if (n === 0) { set.status = 400; return { success: false, message: 'ต้องเปิดใช้อย่างน้อย 1 กลุ่ม' }; }
    }

    const [row] = await nurse`
        UPDATE rx_reject_categories SET
            label        = COALESCE(${label}::text, label),
            active       = COALESCE(${typeof b.active === 'boolean' ? b.active : null}::boolean, active),
            require_note = COALESCE(${typeof b.require_note === 'boolean' ? b.require_note : null}::boolean, require_note),
            updated_by = ${who.username}, updated_at = now()
        WHERE code = ${code}
        RETURNING code, label, sort_order, active, require_note`;
    if (!row) { set.status = 404; return { success: false, message: 'ไม่พบกลุ่มนี้' }; }
    return { success: true, data: row };
};

/** POST /rx/reject-categories/reorder { codes: [...] } — ลำดับใหม่ทั้งชุด */
export const reorderRejectCategories = async ({ body, user, set }: Context & { user?: unknown }) => {
    const who = await canManage(user);
    if (!who?.ok) { set.status = 403; return { success: false, message: 'เฉพาะกลุ่มงานเภสัชกรรมหรือผู้ดูแลระบบ' }; }
    const codes = ((body as { codes?: unknown })?.codes);
    if (!Array.isArray(codes) || codes.length === 0 || codes.length > 100 || !codes.every(c => typeof c === 'string')) {
        set.status = 400; return { success: false, message: 'ลำดับไม่ถูกต้อง' };
    }
    await nurse.begin(async tx => {
        for (let i = 0; i < codes.length; i++) {
            await tx`UPDATE rx_reject_categories SET sort_order = ${(i + 1) * 10}, updated_by = ${who.username}, updated_at = now()
                     WHERE code = ${codes[i] as string}`;
        }
    });
    return { success: true };
};
