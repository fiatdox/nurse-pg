import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { isAdmin } from './systemSettingsController';
import { resolveActor } from '../utils/nursingRecord';

/**
 * จัดการบริษัทผู้รับจ้างทำอาหารและบัญชีเข้าระบบของบริษัท
 *
 * เฉพาะผู้ดูแลระบบเท่านั้น ไม่ใช่งานโภชนาการ
 *
 * งานโภชนาการเป็นคู่สัญญาฝั่งปฏิบัติกับบริษัทโดยตรง ถ้าให้ตั้งรหัสผ่าน
 * ให้คู่สัญญาของตัวเองได้ ก็แปลว่าเข้าไปดูและออกรายงานแทนบริษัทได้ด้วย
 * การแบ่งหน้าที่ตรงนี้มีไว้ให้ตรวจสอบย้อนหลังได้ว่าใครเปิดบัญชีให้ใคร
 */

const RE_USERNAME = /^[a-zA-Z0-9._-]{4,64}$/;
const MIN_PASSWORD = 10;

const denyUnlessAdmin = async (user: unknown, set: any): Promise<boolean> => {
    if (await isAdmin(user)) return false;
    set.status = 403;
    return true;
};

/** รายชื่อบริษัทพร้อมบัญชีและประเภทอาหารที่ผูกไว้ */
export const listVendors = async ({ set, user }: { set: any; user?: unknown }) => {
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    try {
        const vendors = await nurse`
            SELECT vendor_id, vendor_name, tax_id, contact_name, contact_tel, is_active
            FROM vendors ORDER BY vendor_id`;

        const accounts = await nurse`
            SELECT vendor_account_id, vendor_id, username, display_name, is_active
                 , failed_count
                 , TO_CHAR(locked_until,  'YYYY-MM-DD HH24:MI') AS locked_until
                 , TO_CHAR(last_login_at, 'YYYY-MM-DD HH24:MI') AS last_login_at
            FROM vendor_accounts ORDER BY vendor_id, username`;

        const types = await nurse`
            SELECT vft.vendor_id, vft.food_type_id, ft.food_type_name
            FROM vendor_food_types vft
            LEFT JOIN food_types ft ON ft.food_type_id = vft.food_type_id
            ORDER BY vft.vendor_id, vft.food_type_id`;

        return {
            success: true,
            data: vendors.map(v => ({
                vendor_id: Number(v.vendor_id),
                vendor_name: sanitizeHTML(v.vendor_name),
                tax_id: v.tax_id,
                contact_name: v.contact_name ? sanitizeHTML(v.contact_name) : null,
                contact_tel: v.contact_tel,
                is_active: v.is_active,
                accounts: accounts
                    .filter(a => Number(a.vendor_id) === Number(v.vendor_id))
                    .map(a => ({
                        vendor_account_id: Number(a.vendor_account_id),
                        username: a.username,
                        display_name: sanitizeHTML(a.display_name),
                        is_active: a.is_active,
                        // ถูกล็อกอยู่จริงไหม ไม่ใช่แค่เคยถูกล็อก
                        locked: Boolean(a.locked_until && new Date(a.locked_until) > new Date()),
                        locked_until: a.locked_until,
                        failed_count: Number(a.failed_count),
                        last_login_at: a.last_login_at,
                    })),
                food_types: types
                    .filter(t => Number(t.vendor_id) === Number(v.vendor_id))
                    .map(t => ({
                        food_type_id: Number(t.food_type_id),
                        food_type_name: sanitizeHTML(t.food_type_name ?? ''),
                    })),
            })),
        };
    } catch (error) {
        console.error('List vendors error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** เพิ่มหรือแก้ไขบริษัท */
export const saveVendor = async (
    { body, set, user }: { body: any; set: any; user?: unknown }
) => {
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const vendorId = body?.vendor_id ? Number(body.vendor_id) : null;
    const name = String(body?.vendor_name ?? '').trim();
    if (!name) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุชื่อบริษัท' };
    }

    const fields = {
        vendor_name: name.slice(0, 255),
        tax_id: String(body?.tax_id ?? '').trim().slice(0, 20) || null,
        contact_name: String(body?.contact_name ?? '').trim().slice(0, 150) || null,
        contact_tel: String(body?.contact_tel ?? '').trim().slice(0, 50) || null,
        is_active: body?.is_active !== false,
    };

    try {
        if (vendorId) {
            const done = await nurse`
                UPDATE vendors SET ${nurse(fields)} WHERE vendor_id = ${vendorId}
                RETURNING vendor_id`;
            if (done.length === 0) {
                set.status = 404;
                return { success: false, message: 'ไม่พบบริษัทที่ต้องการแก้ไข' };
            }
            return { success: true, data: { vendor_id: vendorId } };
        }

        const created = await nurse`
            INSERT INTO vendors ${nurse(fields)} RETURNING vendor_id`;
        return { success: true, data: { vendor_id: Number(created[0].vendor_id) } };
    } catch (error) {
        console.error('Save vendor error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ผูกประเภทอาหารที่บริษัทรับผิดชอบ ส่งมาทั้งชุด ไม่ใช่ทีละรายการ */
export const setVendorFoodTypes = async (
    { body, set, user }: { body: any; set: any; user?: unknown }
) => {
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const vendorId = Number(body?.vendor_id);
    const ids: number[] = Array.isArray(body?.food_type_ids)
        ? body.food_type_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
        : [];

    if (!Number.isInteger(vendorId) || vendorId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบริษัทที่ระบุ' };
    }

    try {
        /*
          ลบทิ้งแล้วใส่ใหม่ทั้งชุดในทรานแซกชันเดียว

          ถ้าแยกเป็นเพิ่ม/ลบทีละรายการ จะมีจังหวะกลางที่บริษัทเห็นประเภทที่ไม่ควรเห็น
          หรือมองไม่เห็นประเภทของตัวเอง ตารางนี้เป็นตัวกำหนดขอบเขตการมองเห็น
          จึงต้องเปลี่ยนทีเดียวจบ
        */
        await nurse.begin(async sql => {
            await sql`DELETE FROM vendor_food_types WHERE vendor_id = ${vendorId}`;
            if (ids.length > 0) {
                await sql`
                    INSERT INTO vendor_food_types ${sql(
                        ids.map(id => ({ vendor_id: vendorId, food_type_id: id }))
                    )}`;
            }
        });

        return { success: true, data: { vendor_id: vendorId, food_type_ids: ids } };
    } catch (error) {
        console.error('Set vendor food types error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** เพิ่มบัญชีเข้าระบบให้บริษัท */
export const createVendorAccount = async (
    { body, set, user }: { body: any; set: any; user?: unknown }
) => {
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const vendorId = Number(body?.vendor_id);
    const username = String(body?.username ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    const displayName = String(body?.display_name ?? '').trim();

    if (!Number.isInteger(vendorId) || vendorId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบริษัทที่ระบุ' };
    }
    if (!RE_USERNAME.test(username)) {
        set.status = 400;
        return { success: false, message: 'ชื่อผู้ใช้ต้องยาว 4-64 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -' };
    }
    /*
      บังคับยาวกว่าของเจ้าหน้าที่ เพราะบัญชีนี้เข้าได้จากนอกโรงพยาบาล
      และจะถูกใช้ร่วมกันหลายคนในบริษัท จึงเปลี่ยนรหัสผ่านไม่บ่อย
    */
    if (password.length < MIN_PASSWORD) {
        set.status = 400;
        return { success: false, message: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร` };
    }
    if (!displayName) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุชื่อที่ใช้แสดง' };
    }

    try {
        const dup = await nurse`SELECT 1 FROM vendor_accounts WHERE username = ${username} LIMIT 1`;
        if (dup.length > 0) {
            set.status = 409;
            return { success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว' };
        }

        const actor = await resolveActor(user);
        const hash = await Bun.password.hash(password, 'argon2id');

        const created = await nurse`
            INSERT INTO vendor_accounts
                (vendor_id, username, password, display_name, created_by, created_by_name)
            VALUES (${vendorId}, ${username}, ${hash}, ${displayName.slice(0, 150)},
                    ${actor?.userId ? Number(actor.userId) : null}, ${actor?.fullname ?? null})
            RETURNING vendor_account_id`;

        return { success: true, data: { vendor_account_id: Number(created[0].vendor_account_id) } };
    } catch (error) {
        console.error('Create vendor account error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ตั้งรหัสผ่านใหม่ เปิด/ปิดบัญชี หรือปลดล็อก */
export const updateVendorAccount = async (
    { body, set, user }: { body: any; set: any; user?: unknown }
) => {
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const accountId = Number(body?.vendor_account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบัญชีที่ระบุ' };
    }

    const password = body?.password === undefined ? null : String(body.password);
    if (password !== null && password.length < MIN_PASSWORD) {
        set.status = 400;
        return { success: false, message: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร` };
    }

    try {
        const fields: Record<string, unknown> = {};
        if (password !== null) {
            fields.password = await Bun.password.hash(password, 'argon2id');
            // ตั้งรหัสผ่านใหม่แล้วต้องปลดล็อกให้ด้วย ไม่งั้นบริษัทยังเข้าไม่ได้อยู่ดี
            fields.failed_count = 0;
            fields.locked_until = null;
        }
        if (typeof body?.is_active === 'boolean') fields.is_active = body.is_active;
        if (body?.unlock === true) {
            fields.failed_count = 0;
            fields.locked_until = null;
        }
        if (typeof body?.display_name === 'string' && body.display_name.trim()) {
            fields.display_name = body.display_name.trim().slice(0, 150);
        }

        if (Object.keys(fields).length === 0) {
            set.status = 400;
            return { success: false, message: 'ไม่มีข้อมูลที่ต้องแก้ไข' };
        }

        const done = await nurse`
            UPDATE vendor_accounts SET ${nurse(fields)}
            WHERE vendor_account_id = ${accountId}
            RETURNING vendor_account_id`;

        if (done.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบบัญชีที่ต้องการแก้ไข' };
        }

        return { success: true, data: { vendor_account_id: accountId } };
    } catch (error) {
        console.error('Update vendor account error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
