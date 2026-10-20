import { Context } from 'elysia';
import { nurse } from '../db';
import { isAdmin } from './systemSettingsController';
import { resolveGroups, GROUP_KEYS, GROUP_LABEL, type StaffGroup } from '../utils/userGroup';

/**
 * สิทธิ์การมองเห็นเมนู
 *
 * เซิร์ฟเวอร์เป็นคนบอกว่าผู้ใช้อยู่กลุ่มไหน (หน้าจอบอกเองไม่ได้ ไม่งั้นแก้ค่าในเบราว์เซอร์ก็เปลี่ยนกลุ่มได้)
 * แต่ "เมนูมีอะไรบ้าง" กับ "ค่าเริ่มต้นของแต่ละเมนู" อยู่ฝั่งหน้าจอ เพราะเมนูเกิดพร้อมหน้าจอ
 * ตารางนี้เก็บเฉพาะข้อยกเว้นที่ผู้ดูแลระบบกดเปลี่ยน
 *
 * และย้ำอีกครั้งว่านี่คือการซ่อนเมนู ไม่ใช่การกันข้อมูล
 * การกันจริงอยู่ที่แต่ละ endpoint ซึ่งตรวจผู้ใช้ของตัวเองอยู่แล้ว
 */

const isGroup = (v: unknown): v is StaffGroup =>
    typeof v === 'string' && (GROUP_KEYS as string[]).includes(v);

/** รหัสเมนูมาจากหน้าจอ รับเฉพาะรูปแบบที่คาดไว้ กันค่าขยะลงตาราง */
const cleanKey = (v: unknown): string | null => {
    const s = String(v ?? '').trim();
    return /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(s) ? s : null;
};

/** กลุ่มของฉัน พร้อมข้อยกเว้นเฉพาะกลุ่มของฉัน — หน้าจอเอาไปรวมกับค่าเริ่มต้นเอง */
export const getMyMenuAccess = async ({ user, set }: Context & { user?: unknown }) => {
    const info = await resolveGroups(user);
    if (!info) {
        set.status = 401;
        return { success: false, message: 'ไม่พบข้อมูลผู้ใช้' };
    }

    try {
        const rows = await nurse`
            SELECT menu_key, visible FROM menu_access
            WHERE group_key = ANY(${info.groups}::varchar[])
        `;

        /*
          อยู่หลายกลุ่มแล้วค่าขัดกัน ให้ "เห็น" ชนะ
          เพราะคนที่เป็นทั้งพยาบาลและแอดมิน ต้องทำงานทั้งสองอย่างได้ในบัญชีเดียว
        */
        const overrides: Record<string, boolean> = {};
        for (const r of rows as unknown as { menu_key: string; visible: boolean }[]) {
            overrides[r.menu_key] = overrides[r.menu_key] || r.visible;
        }

        return {
            success: true,
            data: {
                username: info.username,
                fullname: info.fullname,
                major_name: info.majorName,
                groups: info.groups,
                group_labels: info.groups.map(g => GROUP_LABEL[g]),
                is_admin: info.isAdmin,
                overrides,
            },
        };
    } catch (error) {
        console.error('Get my menu access error:', error);
        set.status = 500;
        return { success: false, message: 'อ่านสิทธิ์เมนูไม่สำเร็จ' };
    }
};

/**
 * ข้อยกเว้นของกลุ่มบริษัททำอาหาร
 * ใช้ token คนละชนิดกับเจ้าหน้าที่ จึงแยก endpoint ไว้ใต้ /api/v1/vendor
 * และตรึงกลุ่มไว้เป็น vendor เสมอ ไม่ให้ระบุกลุ่มมาเองได้
 */
export const getVendorMenuAccess = async ({ set }: Context) => {
    try {
        const rows = await nurse`
            SELECT menu_key, visible FROM menu_access WHERE group_key = 'vendor'
        `;
        const overrides: Record<string, boolean> = {};
        for (const r of rows as unknown as { menu_key: string; visible: boolean }[]) {
            overrides[r.menu_key] = r.visible;
        }
        return { success: true, data: { groups: ['vendor'], is_admin: false, overrides } };
    } catch (error) {
        console.error('Get vendor menu access error:', error);
        set.status = 500;
        return { success: false, message: 'อ่านสิทธิ์เมนูไม่สำเร็จ' };
    }
};

/** ตารางข้อยกเว้นทั้งหมด สำหรับหน้าจัดการของผู้ดูแลระบบ */
export const getMenuMatrix = async ({ user, set }: Context & { user?: unknown }) => {
    if (!await isAdmin(user)) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบ' };
    }

    try {
        const rows = await nurse`
            SELECT menu_key, group_key, visible, updated_by_name,
                   TO_CHAR(updated_at, 'DD/MM/YYYY HH24:MI') AS updated_at
            FROM menu_access ORDER BY menu_key, group_key
        `;
        return { success: true, data: { groups: GROUP_KEYS, labels: GROUP_LABEL, rows } };
    } catch (error) {
        console.error('Get menu matrix error:', error);
        set.status = 500;
        return { success: false, message: 'อ่านตารางสิทธิ์ไม่สำเร็จ' };
    }
};

/**
 * บันทึกข้อยกเว้น
 *
 * ส่งมาทีละรายการที่เปลี่ยน ไม่ใช่ทั้งตาราง เพราะสองคนเปิดหน้านี้พร้อมกันได้
 * ถ้าเขียนทับทั้งตาราง คนที่กดบันทึกทีหลังจะลบงานของคนแรกโดยไม่มีใครเห็น
 */
export const saveMenuAccess = async ({ body, user, set }: Context & { user?: unknown }) => {
    if (!await isAdmin(user)) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบ' };
    }
    const info = await resolveGroups(user);

    const list = (body as { items?: unknown }).items;
    if (!Array.isArray(list) || list.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่มีรายการที่จะบันทึก' };
    }
    if (list.length > 500) {
        set.status = 400;
        return { success: false, message: 'ส่งมามากเกินไปในครั้งเดียว' };
    }

    const items: { key: string; group: StaffGroup; visible: boolean }[] = [];
    for (const raw of list) {
        const r = raw as { menu_key?: unknown; group_key?: unknown; visible?: unknown };
        const key = cleanKey(r.menu_key);
        if (!key || !isGroup(r.group_key)) {
            set.status = 400;
            return { success: false, message: 'รหัสเมนูหรือกลุ่มไม่ถูกต้อง' };
        }
        items.push({ key, group: r.group_key, visible: r.visible === true });
    }

    try {
        await nurse.begin(async (tx) => {
            for (const it of items) {
                await tx`
                    INSERT INTO menu_access (menu_key, group_key, visible, updated_by, updated_by_name)
                    VALUES (${it.key}, ${it.group}, ${it.visible},
                            ${info?.username ?? null}, ${info?.fullname ?? null})
                    ON CONFLICT (menu_key, group_key) DO UPDATE
                    SET visible = EXCLUDED.visible,
                        updated_by = EXCLUDED.updated_by,
                        updated_by_name = EXCLUDED.updated_by_name,
                        updated_at = now()
                `;
            }
        });
        return { success: true, message: `บันทึกแล้ว ${items.length} รายการ` };
    } catch (error) {
        console.error('Save menu access error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกไม่สำเร็จ' };
    }
};

/**
 * คืนค่าเริ่มต้น = ลบข้อยกเว้นทิ้ง
 * ลบแล้วเมนูกลับไปใช้ค่าที่ฝังในโค้ด ไม่ใช่ "ปิด" ซึ่งเป็นคนละเรื่องกัน
 */
export const resetMenuAccess = async ({ body, user, set }: Context & { user?: unknown }) => {
    if (!await isAdmin(user)) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบ' };
    }

    const key = cleanKey((body as { menu_key?: unknown })?.menu_key);
    try {
        if (key) await nurse`DELETE FROM menu_access WHERE menu_key = ${key}`;
        else await nurse`DELETE FROM menu_access`;
        return { success: true, message: key ? 'คืนค่าเริ่มต้นของเมนูนี้แล้ว' : 'คืนค่าเริ่มต้นทั้งหมดแล้ว' };
    } catch (error) {
        console.error('Reset menu access error:', error);
        set.status = 500;
        return { success: false, message: 'คืนค่าเริ่มต้นไม่สำเร็จ' };
    }
};
