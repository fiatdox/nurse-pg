import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { isAdmin } from './systemSettingsController';
import { resolveActor } from '../utils/nursingRecord';
import {
    PiiKeyMissingError, encryptPii, normalizeNationalId, isValidThaiNationalId,
    nationalIdHash, maskNationalId, newTempPassword,
} from '../utils/vendorIdentity';
import { clientInfo, logVendorEvent } from './vendorAuthController';

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
                 , first_name, last_name, job_title, phone, national_id_last4
                 , identity_verified_by_name
                 , TO_CHAR(identity_verified_at, 'YYYY-MM-DD HH24:MI') AS identity_verified_at
                 , must_change_password
                 , TO_CHAR(temp_password_expires_at, 'YYYY-MM-DD HH24:MI') AS temp_password_expires_at
                 , (temp_password_expires_at < NOW()) AS temp_expired
                 , (session_id IS NOT NULL) AS has_session
                 , TO_CHAR(session_started_at, 'YYYY-MM-DD HH24:MI') AS session_started_at
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
                        first_name: a.first_name ? sanitizeHTML(a.first_name) : null,
                        last_name: a.last_name ? sanitizeHTML(a.last_name) : null,
                        job_title: a.job_title ? sanitizeHTML(a.job_title) : null,
                        phone: a.phone,
                        // ไม่ส่งเลขบัตรเต็มออกไปเลย แม้แต่ให้ผู้ดูแล — แสดงแค่สี่ตัวท้ายไว้เทียบกับบัตร
                        national_id_masked: maskNationalId(a.national_id_last4),
                        identity_verified: Boolean(a.identity_verified_at),
                        identity_verified_at: a.identity_verified_at,
                        identity_verified_by_name: a.identity_verified_by_name ? sanitizeHTML(a.identity_verified_by_name) : null,
                        must_change_password: a.must_change_password,
                        temp_password_expires_at: a.must_change_password ? a.temp_password_expires_at : null,
                        temp_expired: Boolean(a.must_change_password && a.temp_expired),
                        has_session: a.has_session,
                        session_started_at: a.has_session ? a.session_started_at : null,
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

// ───── บัญชีรายบุคคล ─────

/** อายุของรหัสผ่านชั่วคราว ต้องเข้าครั้งแรกและตั้งรหัสเองภายในเวลานี้ */
const TEMP_PASSWORD_HOURS = 72;

const piiFail = (set: any, error: unknown) => {
    if (error instanceof PiiKeyMissingError) {
        console.error(error.message);
        set.status = 503;
        return { success: false, message: error.message };
    }
    return null;
};

/**
 * ตรวจและแปลงข้อมูลบุคคลจากฟอร์ม คืนข้อความปัญหาถ้าไม่ผ่าน
 * national_id ไม่บังคับตอนแก้ไข (ไม่ส่งมา = ไม่เปลี่ยน) แต่บังคับตอนเปิดบัญชี
 */
const readPerson = (body: any, requireId: boolean) => {
    const first = String(body?.first_name ?? '').trim();
    const last = String(body?.last_name ?? '').trim();
    const phone = String(body?.phone ?? '').replace(/[^\d+]/g, '');
    const job = String(body?.job_title ?? '').trim();
    const rawId = body?.national_id === undefined || body?.national_id === '' ? null : normalizeNationalId(body.national_id);

    if (!first || !last) return { error: 'กรุณากรอกชื่อและนามสกุลตามบัตรประชาชน' };
    if (phone.length < 9) return { error: 'กรุณากรอกเบอร์โทรศัพท์ที่ติดต่อได้' };
    if (requireId && !rawId) return { error: 'กรุณากรอกเลขบัตรประชาชน' };
    if (rawId && !isValidThaiNationalId(rawId)) return { error: 'เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจอีกครั้ง' };
    /*
      ต้องยืนยันว่าเห็นบัตรตัวจริงทุกครั้งที่บันทึกข้อมูลบุคคล
      ชื่อผู้ตรวจและเวลาถูกเก็บไว้ เป็นหลักฐานว่าใครรับรองว่าบัญชีนี้เป็นของคนนี้
    */
    if (body?.identity_checked !== true) return { error: 'กรุณาตรวจบัตรประชาชนตัวจริงและติ๊กยืนยันก่อนบันทึก' };

    return {
        fields: {
            first_name: first.slice(0, 100),
            last_name: last.slice(0, 100),
            display_name: `${first} ${last}`.slice(0, 150),
            phone: phone.slice(0, 20),
            job_title: job.slice(0, 100) || null,
        },
        nationalId: rawId,
    };
};

/** เลขบัตรนี้มีบัญชีอยู่แล้วไหม — หนึ่งคนหนึ่งบัญชี ข้ามทุกบริษัท */
const findByNationalId = async (hash: string, exceptId: number | null) => {
    const rows = await nurse`
        SELECT va.vendor_account_id, va.username, v.vendor_name
        FROM vendor_accounts va JOIN vendors v ON v.vendor_id = va.vendor_id
        WHERE va.national_id_hash = ${hash}
          AND (${exceptId}::int IS NULL OR va.vendor_account_id <> ${exceptId}::int)
        LIMIT 1`;
    return rows[0] ?? null;
};

const duplicateMessage = (d: Record<string, any>) =>
    `บุคคลนี้มีบัญชีอยู่แล้ว (${d.vendor_name} · ชื่อผู้ใช้ ${d.username}) หนึ่งคนมีได้บัญชีเดียว`
    + ' ถ้าย้ายบริษัท ให้ปิดบัญชีเดิมแล้วแก้บริษัทของบัญชีนั้นแทนการเปิดใหม่';

/** เปิดบัญชีให้บุคคลหนึ่งคน — ได้รหัสผ่านชั่วคราวกลับไปครั้งเดียว ดูย้อนหลังไม่ได้ */
export const createVendorAccount = async (
    ctx: { body: any; set: any; user?: unknown; request: Request }
) => {
    const { body, set, user } = ctx;
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const vendorId = Number(body?.vendor_id);
    const username = String(body?.username ?? '').trim().toLowerCase();

    if (!Number.isInteger(vendorId) || vendorId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบริษัทที่ระบุ' };
    }
    if (!RE_USERNAME.test(username)) {
        set.status = 400;
        return { success: false, message: 'ชื่อผู้ใช้ต้องยาว 4-64 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -' };
    }
    const person = readPerson(body, true);
    if ('error' in person) { set.status = 400; return { success: false, message: person.error }; }

    try {
        const dupUser = await nurse`SELECT 1 FROM vendor_accounts WHERE username = ${username} LIMIT 1`;
        if (dupUser.length > 0) {
            set.status = 409;
            return { success: false, message: 'ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว' };
        }

        const nid = person.nationalId!;
        const hash = nationalIdHash(nid);
        const dup = await findByNationalId(hash, null);
        if (dup) { set.status = 409; return { success: false, message: duplicateMessage(dup) }; }

        const actor = await resolveActor(user);
        const temp = newTempPassword();

        const [created] = await nurse`
            INSERT INTO vendor_accounts ${nurse({
                vendor_id: vendorId,
                username,
                password: await Bun.password.hash(temp, 'argon2id'),
                ...person.fields,
                national_id_enc: encryptPii(nid),
                national_id_hash: hash,
                national_id_last4: nid.slice(-4),
                identity_verified_at: new Date(),
                identity_verified_by: actor?.userId ? Number(actor.userId) : null,
                identity_verified_by_name: actor?.fullname ?? null,
                must_change_password: true,
                temp_password_expires_at: new Date(Date.now() + TEMP_PASSWORD_HOURS * 3600_000),
                created_by: actor?.userId ? Number(actor.userId) : null,
                created_by_name: actor?.fullname ?? null,
            })}
            RETURNING vendor_account_id, TO_CHAR(temp_password_expires_at, 'YYYY-MM-DD HH24:MI') AS expires`;

        const id = Number(created.vendor_account_id);
        await logVendorEvent({ vendor_account_id: id, event: 'account_created', actor_name: actor?.fullname, ...clientInfo(ctx) });

        return {
            success: true,
            data: { vendor_account_id: id, username, temp_password: temp, temp_password_expires_at: created.expires },
        };
    } catch (error) {
        const pii = piiFail(set, error);
        if (pii) return pii;
        // สองคนกดเปิดบัญชีให้คนเดียวกันพร้อมกัน ดัชนี UNIQUE จะกันไว้ให้
        if ((error as { code?: string })?.code === '23505') {
            set.status = 409;
            return { success: false, message: 'ชื่อผู้ใช้หรือเลขบัตรประชาชนนี้มีบัญชีอยู่แล้ว' };
        }
        console.error('Create vendor account error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * แก้ข้อมูลบุคคล หรือกรอกให้บัญชีเดิมที่ยังไม่มี — บันทึกแล้วถือว่ายืนยันตัวตนโดยผู้ที่กด
 *
 * เปลี่ยนเลขบัตรคือเปลี่ยนเจ้าของบัญชี session เดิมและแอปยืนยันตัวตนเดิมต้องถูกยกเลิก
 * และต้องตั้งรหัสใหม่ ไม่งั้นคนเดิมยังเข้าได้ในนามคนใหม่
 */
export const updateVendorIdentity = async (
    ctx: { body: any; set: any; user?: unknown; request: Request }
) => {
    const { body, set, user } = ctx;
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const accountId = Number(body?.vendor_account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบัญชีที่ระบุ' };
    }

    try {
        const [acc] = await nurse`
            SELECT national_id_hash FROM vendor_accounts WHERE vendor_account_id = ${accountId}`;
        if (!acc) { set.status = 404; return { success: false, message: 'ไม่พบบัญชีที่ต้องการแก้ไข' }; }

        // บัญชีที่ยังไม่มีเลขบัตร (บัญชีเดิมก่อนแบบรายบุคคล) ต้องกรอกเลขบัตร
        const person = readPerson(body, !acc.national_id_hash);
        if ('error' in person) { set.status = 400; return { success: false, message: person.error }; }

        const actor = await resolveActor(user);
        const fields: Record<string, unknown> = {
            ...person.fields,
            identity_verified_at: new Date(),
            identity_verified_by: actor?.userId ? Number(actor.userId) : null,
            identity_verified_by_name: actor?.fullname ?? null,
        };

        let ownerChanged = false;
        let temp: string | null = null;
        if (person.nationalId) {
            const hash = nationalIdHash(person.nationalId);
            const dup = await findByNationalId(hash, accountId);
            if (dup) { set.status = 409; return { success: false, message: duplicateMessage(dup) }; }

            if (acc.national_id_hash && acc.national_id_hash !== hash) {
                ownerChanged = true;
                temp = newTempPassword();
                Object.assign(fields, {
                    password: await Bun.password.hash(temp, 'argon2id'),
                    must_change_password: true,
                    temp_password_expires_at: new Date(Date.now() + TEMP_PASSWORD_HOURS * 3600_000),
                    otp_hash: null, otp_expires_at: null,
                    session_id: null, pending_nonce: null,
                });
            }
            Object.assign(fields, {
                national_id_enc: encryptPii(person.nationalId),
                national_id_hash: hash,
                national_id_last4: person.nationalId.slice(-4),
            });
        }

        await nurse`UPDATE vendor_accounts SET ${nurse(fields)} WHERE vendor_account_id = ${accountId}`;
        await logVendorEvent({
            vendor_account_id: accountId,
            event: ownerChanged ? 'identity_owner_changed' : 'identity_verified',
            actor_name: actor?.fullname, ...clientInfo(ctx),
        });

        return { success: true, data: { vendor_account_id: accountId, owner_changed: ownerChanged, temp_password: temp } };
    } catch (error) {
        const pii = piiFail(set, error);
        if (pii) return pii;
        if ((error as { code?: string })?.code === '23505') {
            set.status = 409;
            return { success: false, message: 'เลขบัตรประชาชนนี้มีบัญชีอยู่แล้ว' };
        }
        console.error('Update vendor identity error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * ออกรหัสผ่านชั่วคราวใหม่ (ลืมรหัส) และเลือกรีเซ็ตแอปยืนยันตัวตนได้ (เปลี่ยนมือถือ/มือถือหาย)
 *
 * ผู้ดูแลตั้งรหัสจริงให้ไม่ได้ ได้แค่รหัสชั่วคราวที่ต้องเปลี่ยนตอนเข้าครั้งแรก
 * ผู้ดูแลจึงไม่เคยรู้รหัสจริงของใคร สิ่งที่ทำในนามบัญชีนั้นจึงเป็นของเจ้าของบัญชีจริงๆ
 * session ที่ใช้อยู่ถูกตัดทันที
 */
export const resetVendorCredentials = async (
    ctx: { body: any; set: any; user?: unknown; request: Request }
) => {
    const { body, set, user } = ctx;
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const accountId = Number(body?.vendor_account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบัญชีที่ระบุ' };
    }

    try {
        const temp = newTempPassword();
        const done = await nurse`
            UPDATE vendor_accounts SET
                password = ${await Bun.password.hash(temp, 'argon2id')}
              , must_change_password = true
              , temp_password_expires_at = NOW() + make_interval(hours => ${TEMP_PASSWORD_HOURS})
              , failed_count = 0, locked_until = NULL
              , session_id = NULL, pending_nonce = NULL
              , otp_hash = NULL, otp_expires_at = NULL
            WHERE vendor_account_id = ${accountId}
            RETURNING username, TO_CHAR(temp_password_expires_at, 'YYYY-MM-DD HH24:MI') AS expires`;
        if (done.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบบัญชีที่ระบุ' }; }

        const actor = await resolveActor(user);
        await logVendorEvent({
            vendor_account_id: accountId,
            event: 'reset_password',
            actor_name: actor?.fullname, ...clientInfo(ctx),
        });

        return {
            success: true,
            data: { username: done[0].username, temp_password: temp, temp_password_expires_at: done[0].expires },
        };
    } catch (error) {
        console.error('Reset vendor credentials error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** เปิด/ปิดบัญชี ปลดล็อก หรือตัดการเข้าใช้ที่ค้างอยู่ */
export const updateVendorAccount = async (
    ctx: { body: any; set: any; user?: unknown; request: Request }
) => {
    const { body, set, user } = ctx;
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const accountId = Number(body?.vendor_account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบัญชีที่ระบุ' };
    }

    const fields: Record<string, unknown> = {};
    const events: string[] = [];
    if (typeof body?.is_active === 'boolean') {
        fields.is_active = body.is_active;
        // ปิดบัญชีแล้วต้องตัด session ด้วย ไม่งั้นเปิดกลับมาแล้ว token เดิมใช้ต่อได้
        if (!body.is_active) fields.session_id = null;
        events.push(body.is_active ? 'account_enabled' : 'account_disabled');
    }
    if (body?.unlock === true) {
        fields.failed_count = 0;
        fields.locked_until = null;
        events.push('unlocked');
    }
    if (body?.revoke_session === true) {
        fields.session_id = null;
        fields.pending_nonce = null;
        events.push('session_revoked');
    }

    if (Object.keys(fields).length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่มีข้อมูลที่ต้องแก้ไข' };
    }

    try {
        const done = await nurse`
            UPDATE vendor_accounts SET ${nurse(fields)}
            WHERE vendor_account_id = ${accountId}
            RETURNING vendor_account_id`;
        if (done.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบบัญชีที่ต้องการแก้ไข' }; }

        const actor = await resolveActor(user);
        for (const event of events) {
            await logVendorEvent({ vendor_account_id: accountId, event, actor_name: actor?.fullname, ...clientInfo(ctx) });
        }
        return { success: true, data: { vendor_account_id: accountId } };
    } catch (error) {
        console.error('Update vendor account error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ประวัติของบัญชีหนึ่ง — การเข้าระบบ การจัดการบัญชี และการเรียกใช้ล่าสุด */
export const getVendorAccountHistory = async (
    { query, set, user }: { query: any; set: any; user?: unknown }
) => {
    if (await denyUnlessAdmin(user, set)) return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้น' };

    const accountId = Number(query?.vendor_account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบบัญชีที่ระบุ' };
    }

    try {
        const [events, access] = await Promise.all([
            nurse`
                SELECT event, detail, ip, user_agent, actor_name,
                       TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at
                FROM vendor_auth_events
                WHERE vendor_account_id = ${accountId}
                ORDER BY created_at DESC LIMIT 200`,
            nurse`
                SELECT method, path, ip, LEFT(session_id::text, 8) AS session,
                       TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at
                FROM vendor_access_log
                WHERE vendor_account_id = ${accountId}
                ORDER BY created_at DESC LIMIT 300`,
        ]);
        return {
            success: true,
            data: {
                events: events.map(e => ({ ...e, actor_name: e.actor_name ? sanitizeHTML(e.actor_name) : null, user_agent: e.user_agent ? sanitizeHTML(e.user_agent) : null })),
                access,
            },
        };
    } catch (error) {
        console.error('Vendor account history error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
