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
 *
 * บัญชีเป็นรายบุคคล ใช้ได้ทีละเครื่อง token ต้องมี sid ตรงกับ session_id ในฐาน
 * token ขั้นกลางของการเข้าระบบ (ยังไม่ผ่าน OTP) ไม่มี sid จึงเข้าไม่ได้
 */
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required for authentication');
}

export interface VendorContext {
    vendor_id: number;
    vendor_account_id: number;
    session_id: string;
    vendor_name: string;
    display_name: string;
    /** ประเภทอาหารที่บริษัทนี้เห็นได้ ว่างแปลว่ายังไม่ผูกประเภทใดเลย */
    food_type_ids: number[];
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ทำไม token ใช้ไม่ได้ — หน้าจอใช้เลือกข้อความ เช่น "เข้าระบบจากเครื่องอื่นแล้ว" */
type DenyCode = 'NO_TOKEN' | 'SESSION_REPLACED' | 'SESSION_ENDED';

export const vendorMiddleware = (app: Elysia) =>
    app.use(
        jwt({
            name: 'jwt',
            secret: process.env.JWT_SECRET!,
            exp: '8h'
        })
    )
    .derive(async ({ jwt, headers, request, server }) => {
        const none = (code: DenyCode) => ({ vendor: null as VendorContext | null, denyCode: code });

        const auth = headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) return none('NO_TOKEN');

        const payload = await jwt.verify(auth.slice(7)).catch(() => null) as
            { typ?: string; vendor_account_id?: unknown; sid?: unknown } | null;
        if (!payload || payload.typ !== VENDOR_TOKEN) return none('NO_TOKEN');

        const accountId = Number(payload.vendor_account_id);
        const sid = String(payload.sid ?? '');
        if (!Number.isInteger(accountId) || accountId <= 0 || !RE_UUID.test(sid)) return none('NO_TOKEN');

        /*
          อ่านตัวตนจากฐานทุกครั้ง ไม่เชื่อค่าใน token นอกจากเลขบัญชีกับเลข session

          ถ้าอ่าน vendor_id จาก token ตรงๆ แล้ววันหนึ่งปิดบัญชีบริษัท
          token ที่ออกไปแล้วจะยังใช้ได้ต่ออีก 8 ชั่วโมง ซึ่งนานเกินไป
          สำหรับบัญชีของคนนอก การถอนสิทธิ์ต้องมีผลทันที

          ตรวจเงื่อนไขการยืนยันตัวตนซ้ำที่นี่ด้วย ไม่เชื่อว่าผ่านมาแล้วตอนเข้าระบบ
          ผู้ดูแลออกรหัสชั่วคราวใหม่หรือแก้เลขบัตร ก็ต้องหลุดทันทีเช่นกัน
        */
        const rows = await nurse`
            SELECT va.vendor_account_id, va.vendor_id, va.display_name, va.first_name, va.last_name,
                   va.session_id::text AS session_id, v.vendor_name
            FROM vendor_accounts va
            JOIN vendors v ON v.vendor_id = va.vendor_id
            WHERE va.vendor_account_id = ${accountId}
              AND va.is_active AND v.is_active
              AND va.identity_verified_at IS NOT NULL
              AND NOT va.must_change_password
            LIMIT 1`;
        const row = rows[0];
        if (!row) return none('SESSION_ENDED');
        if (row.session_id !== sid) return none(row.session_id ? 'SESSION_REPLACED' : 'SESSION_ENDED');

        const types = await nurse`
            SELECT food_type_id FROM vendor_food_types WHERE vendor_id = ${row.vendor_id}`;

        /*
          บันทึกการเรียกใช้ทุกครั้ง ตอบได้ว่าใครเปิดรายงานหรือพิมพ์ใบติดถาดเมื่อไหร่
          ไม่รอให้บันทึกเสร็จ และบันทึกพลาดต้องไม่ทำให้หน้ารายงานพัง
        */
        const url = new URL(request.url);
        const ip = (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || server?.requestIP(request)?.address || null)?.slice(0, 64) ?? null;
        nurse`
            INSERT INTO vendor_access_log (vendor_account_id, session_id, method, path, ip)
            VALUES (${accountId}, ${sid}::uuid, ${request.method.slice(0, 10)},
                    ${(url.pathname + url.search).slice(0, 255)}, ${ip})`
            .catch(error => console.error('Vendor access log failed:', error));

        return {
            vendor: {
                vendor_id: Number(row.vendor_id),
                vendor_account_id: Number(row.vendor_account_id),
                session_id: sid,
                vendor_name: String(row.vendor_name),
                display_name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || String(row.display_name),
                food_type_ids: types.map(t => Number(t.food_type_id)),
            } as VendorContext | null,
            denyCode: null as DenyCode | null,
        };
    })
    .onBeforeHandle(({ vendor, denyCode, set }) => {
        if (!vendor) {
            set.status = 401;
            return {
                success: false,
                code: denyCode,
                message: denyCode === 'SESSION_REPLACED'
                    ? 'บัญชีนี้เข้าระบบจากเครื่องอื่นแล้ว หากไม่ใช่คุณ กรุณาแจ้งงานโภชนาการทันที'
                    : 'Unauthorized',
            };
        }
    });
