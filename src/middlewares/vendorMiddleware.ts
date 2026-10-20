import { Elysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { nurse } from '../db';
import { VENDOR_TOKEN } from './authMiddleware';

/**
 * ประตูสำหรับบริษัทผู้รับจ้างทำอาหาร
 *
 * ตรงข้ามกับ authMiddleware ตัวนี้รับเฉพาะ token ที่ typ เป็น vendor เท่านั้น
 * token ของเจ้าหน้าที่ผ่านเข้ามาไม่ได้ ทั้งสองฝั่งจึงปิดกั้นกันและกัน
 * ไม่ใช่ฝ่ายเดียวที่กัน ซึ่งจะพลาดได้ถ้ามีใครเผลอเอา route ไปแขวนผิดตัว
 */
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required for authentication');
}

export interface VendorContext {
    vendor_id: number;
    vendor_account_id: number;
    vendor_name: string;
    display_name: string;
    /** ประเภทอาหารที่บริษัทนี้เห็นได้ ว่างแปลว่ายังไม่ผูกประเภทใดเลย */
    food_type_ids: number[];
}

export const vendorMiddleware = (app: Elysia) =>
    app.use(
        jwt({
            name: 'jwt',
            secret: process.env.JWT_SECRET!,
            exp: '8h'
        })
    )
    .derive(async ({ jwt, headers }) => {
        const auth = headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) return { vendor: null };

        const payload = await jwt.verify(auth.slice(7)).catch(() => null);
        if (!payload || (payload as { typ?: string }).typ !== VENDOR_TOKEN) {
            return { vendor: null };
        }

        const accountId = Number((payload as { vendor_account_id?: unknown }).vendor_account_id);
        if (!Number.isInteger(accountId) || accountId <= 0) return { vendor: null };

        /*
          อ่านตัวตนจากฐานทุกครั้ง ไม่เชื่อค่าใน token นอกจากเลขบัญชี

          ถ้าอ่าน vendor_id จาก token ตรงๆ แล้ววันหนึ่งปิดบัญชีบริษัท
          token ที่ออกไปแล้วจะยังใช้ได้ต่ออีก 8 ชั่วโมง ซึ่งนานเกินไป
          สำหรับบัญชีของคนนอก การถอนสิทธิ์ต้องมีผลทันที
        */
        const rows = await nurse`
            SELECT va.vendor_account_id, va.vendor_id, va.display_name, v.vendor_name
            FROM vendor_accounts va
            JOIN vendors v ON v.vendor_id = va.vendor_id
            WHERE va.vendor_account_id = ${accountId}
              AND va.is_active AND v.is_active
            LIMIT 1`;
        const row = rows[0];
        if (!row) return { vendor: null };

        const types = await nurse`
            SELECT food_type_id FROM vendor_food_types WHERE vendor_id = ${row.vendor_id}`;

        return {
            vendor: {
                vendor_id: Number(row.vendor_id),
                vendor_account_id: Number(row.vendor_account_id),
                vendor_name: String(row.vendor_name),
                display_name: String(row.display_name),
                food_type_ids: types.map(t => Number(t.food_type_id)),
            } as VendorContext
        };
    })
    .onBeforeHandle(({ vendor, set }) => {
        if (!vendor) {
            set.status = 401;
            return { success: false, message: 'Unauthorized' };
        }
    });
