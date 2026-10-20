import { Context } from 'elysia';
import { nurse } from '../db';
import { VENDOR_TOKEN } from '../middlewares/authMiddleware';
import type { VendorContext } from '../middlewares/vendorMiddleware';

/**
 * เข้าระบบสำหรับบริษัทผู้รับจ้างทำอาหาร
 *
 * บัญชีอยู่ในฐาน nurse ไม่ใช่ core_kon ซึ่งเป็นฐานบุคลากรของโรงพยาบาล
 * เหตุผลอยู่ในหัวไฟล์ sql/2026-09-12_vendor_accounts.sql
 */

/** ผิดกี่ครั้งถึงล็อก และล็อกนานเท่าไหร่ */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const vendorLogin = async ({ body, set, jwt }: Context & { jwt: any }) => {
    const { username, password } = body as { username: string; password: string };
    const name = String(username ?? '').trim();

    /*
      ข้อความเดียวกันทุกกรณีที่เข้าไม่ได้ ไม่บอกว่าผิดที่ชื่อผู้ใช้หรือรหัสผ่าน

      ถ้าแยกข้อความ คนนอกจะไล่หาได้ว่าชื่อผู้ใช้ไหนมีอยู่จริงในระบบ
      ยกเว้นกรณีถูกล็อก ซึ่งต้องบอกตรงๆ ไม่งั้นคนใช้จะกรอกซ้ำไปเรื่อยๆ
      แล้วล็อกยาวขึ้นโดยไม่รู้ตัว
    */
    const deny = () => {
        set.status = 401;
        return { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    };

    if (!name || !password) return deny();

    try {
        const rows = await nurse`
            SELECT va.vendor_account_id, va.vendor_id, va.username, va.password,
                   va.display_name, va.failed_count, va.locked_until,
                   v.vendor_name
            FROM vendor_accounts va
            JOIN vendors v ON v.vendor_id = va.vendor_id
            WHERE va.username = ${name} AND va.is_active AND v.is_active
            LIMIT 1`;

        const acc = rows[0];

        /*
          ยังต้องตรวจรหัสผ่านถึงจะไม่เจอบัญชี เพื่อให้เวลาที่ใช้ตอบใกล้เคียงกัน
          ถ้าไม่เจอแล้วตอบทันที คนนอกจับเวลาก็รู้ได้ว่าชื่อผู้ใช้ไหนมีอยู่จริง
        */
        if (!acc) {
            await Bun.password.verify(password, '$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'argon2id').catch(() => false);
            return deny();
        }

        if (acc.locked_until && new Date(acc.locked_until) > new Date()) {
            set.status = 423;
            return {
                success: false,
                message: `บัญชีถูกล็อกชั่วคราวเนื่องจากกรอกรหัสผ่านผิดหลายครั้ง กรุณารออีก ${LOCK_MINUTES} นาที`
            };
        }

        const ok = await Bun.password.verify(password, String(acc.password), 'argon2id').catch(() => false);

        if (!ok) {
            const failed = Number(acc.failed_count) + 1;
            await nurse`
                UPDATE vendor_accounts
                SET failed_count = ${failed}
                  , locked_until = ${failed >= MAX_FAILED
                    ? new Date(Date.now() + LOCK_MINUTES * 60_000)
                    : null}
                WHERE vendor_account_id = ${acc.vendor_account_id}`;
            return deny();
        }

        await nurse`
            UPDATE vendor_accounts
            SET failed_count = 0, locked_until = NULL, last_login_at = NOW()
            WHERE vendor_account_id = ${acc.vendor_account_id}`;

        /*
          ใส่แค่เลขบัญชีกับชนิดลงใน token ไม่ใส่ชื่อหรือสิทธิ์

          สิทธิ์ต้องอ่านจากฐานทุกครั้งที่เรียก (ดู vendorMiddleware)
          ไม่งั้นการปิดบัญชีจะไม่มีผลจนกว่า token จะหมดอายุ
        */
        const token = await jwt.sign({
            vendor_account_id: Number(acc.vendor_account_id),
            typ: VENDOR_TOKEN,
        });

        return {
            success: true,
            token,
            data: {
                vendor_id: Number(acc.vendor_id),
                vendor_name: acc.vendor_name,
                display_name: acc.display_name,
            },
        };
    } catch (error) {
        console.error('Vendor login error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ข้อมูลผู้ใช้ที่กำลังเข้าระบบอยู่ หน้าจอใช้แสดงหัวเรื่องและตรวจว่า token ยังใช้ได้ */
export const vendorProfile = async (
    { set, vendor }: { set: any; vendor: VendorContext | null }
) => {
    if (!vendor) { set.status = 401; return { success: false, message: 'Unauthorized' }; }
    return {
        success: true,
        data: {
            vendor_id: vendor.vendor_id,
            vendor_name: vendor.vendor_name,
            display_name: vendor.display_name,
            food_type_ids: vendor.food_type_ids,
        },
    };
};
