import { Context } from 'elysia';
import { nurse } from '../db';
import { VENDOR_TOKEN } from '../middlewares/authMiddleware';
import type { VendorContext } from '../middlewares/vendorMiddleware';
import {
    PiiKeyMissingError, decryptPii, newOtp, otpHash, otpMatches, maskNationalId,
} from '../utils/vendorIdentity';
import { sendVendorOtp, OtpSendError } from '../utils/mophPromptOtp';

/**
 * เข้าระบบสำหรับบริษัทผู้รับจ้างทำอาหาร — บัญชีรายบุคคล ยืนยันตัวตนสองขั้น
 *
 * บัญชีอยู่ในฐาน nurse ไม่ใช่ core_kon ซึ่งเป็นฐานบุคลากรของโรงพยาบาล
 * เหตุผลอยู่ในหัวไฟล์ sql/2026-09-12_vendor_accounts.sql
 * ส่วนเหตุผลของแบบรายบุคคลอยู่ใน sql/2026-10-20_vendor_accounts_personal.sql
 *
 * ขั้นตอน
 *   1. POST /login            ชื่อผู้ใช้ + รหัสผ่าน → ได้ pending_token (ใช้ได้ 10 นาที ครั้งเดียว)
 *   2. POST /login/password   ครั้งแรก หรือหลังได้รหัสชั่วคราว ต้องตั้งรหัสผ่านเอง
 *   3. POST /login/otp/send   ส่ง OTP ไปที่ LINE OA หมอพร้อม ของเจ้าของเลขบัตร
 *   4. POST /login/otp        OTP 6 หลัก → ได้ token จริง พร้อม session ใหม่
 *
 * OTP ไปถึงเฉพาะคนที่หมอพร้อมยืนยันว่าเป็นเจ้าของเลขบัตร
 * การเข้าระบบทุกครั้งจึงพิสูจน์ตัวตนซ้ำ ไม่ใช่แค่ตอนผู้ดูแลตรวจบัตรวันเปิดบัญชี
 *
 * session มีได้ตัวเดียวต่อบัญชี ขั้นที่ 4 ออก session ใหม่ทับของเดิม เครื่องเก่าจึงหลุด
 */

/** ผิดกี่ครั้งถึงล็อก และล็อกนานเท่าไหร่ — นับรวมทั้งรหัสผ่านและ OTP */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
/** อายุของขั้นกลาง ระหว่างรหัสผ่านถูกกับกรอก OTP */
const PENDING_MINUTES = 10;
/** อายุ OTP / ผิดได้กี่ครั้งต่อหนึ่งรหัส / ขอใหม่ได้เมื่อไหร่ / ขอได้กี่ครั้งต่อช่วง */
const OTP_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 3;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_PER_WINDOW = 5;
const OTP_WINDOW_MINUTES = 15;
export const MIN_PASSWORD = 10;

type Ctx = Context & { jwt: any; server?: { requestIP?: (r: Request) => { address: string } | null } | null };

/**
 * IP และเบราว์เซอร์ของคนที่เรียก เก็บไว้ในประวัติ
 * frontend ส่งต่อคำขอผ่าน rewrite ของ Next ซึ่งใส่ x-forwarded-for ให้ จึงอ่านตัวนั้นก่อน
 */
export const clientInfo = ({ request, server }: { request: Request; server?: Ctx['server'] }) => ({
    ip: (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || server?.requestIP?.(request)?.address
        || null)?.slice(0, 64) ?? null,
    user_agent: request.headers.get('user-agent')?.slice(0, 255) ?? null,
});

export const logVendorEvent = async (e: {
    vendor_account_id?: number | null;
    username_tried?: string | null;
    event: string;
    detail?: string | null;
    ip?: string | null;
    user_agent?: string | null;
    actor_name?: string | null;
}) => {
    try {
        await nurse`
            INSERT INTO vendor_auth_events
                (vendor_account_id, username_tried, event, detail, ip, user_agent, actor_name)
            VALUES (${e.vendor_account_id ?? null}, ${e.username_tried?.slice(0, 64) ?? null}, ${e.event},
                    ${e.detail?.slice(0, 255) ?? null}, ${e.ip ?? null}, ${e.user_agent ?? null},
                    ${e.actor_name?.slice(0, 150) ?? null})`;
    } catch (error) {
        // บันทึกประวัติไม่สำเร็จต้องไม่ทำให้การเข้าระบบพัง แต่ต้องเห็นใน log
        console.error('Vendor auth event log failed:', error);
    }
};

/*
  ข้อความเดียวกันทุกกรณีที่รหัสผ่านไม่ผ่าน ไม่บอกว่าผิดที่ชื่อผู้ใช้หรือรหัสผ่าน
  ถ้าแยกข้อความ คนนอกจะไล่หาได้ว่าชื่อผู้ใช้ไหนมีอยู่จริงในระบบ
*/
const DENY = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';

const lockedMessage = () =>
    `บัญชีถูกล็อกชั่วคราวเนื่องจากกรอกรหัสผิดหลายครั้ง กรุณารอ ${LOCK_MINUTES} นาที หรือติดต่องานโภชนาการ`;

const isLocked = (acc: Record<string, any>) =>
    Boolean(acc.locked_until && new Date(acc.locked_until as string) > new Date());

/** นับครั้งที่ผิด ครบแล้วล็อก — ใช้ร่วมกันทั้งรหัสผ่านและ OTP */
const countFailure = async (accountId: number, failedCount: number) => {
    const failed = failedCount + 1;
    const lock = failed >= MAX_FAILED;
    await nurse`
        UPDATE vendor_accounts
        SET failed_count = ${failed}
          , locked_until = ${lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null}
          -- ล็อกแล้วขั้นกลางที่ค้างอยู่ใช้ต่อไม่ได้ ต้องเริ่มจากรหัสผ่านใหม่หลังปลดล็อก
          , pending_nonce = CASE WHEN ${lock} THEN NULL ELSE pending_nonce END
        WHERE vendor_account_id = ${accountId}`;
    return lock;
};

const piiError = (set: any, error: unknown) => {
    if (error instanceof PiiKeyMissingError) {
        console.error(error.message);
        set.status = 503;
        return { success: false, message: 'ระบบยืนยันตัวตนยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ' };
    }
    return null;
};

/** ขั้นถัดไปของบัญชีนี้ ตามสถานะที่อยู่ในฐาน ไม่ใช่ตามที่หน้าจอบอกมา */
const nextStep = (acc: Record<string, any>) =>
    acc.must_change_password ? 'change_password' : 'otp';

const issuePending = async (jwt: any, accountId: number) => {
    const [row] = await nurse`
        UPDATE vendor_accounts
        SET pending_nonce = gen_random_uuid()
          , pending_until = NOW() + make_interval(mins => ${PENDING_MINUTES})
        WHERE vendor_account_id = ${accountId}
        RETURNING pending_nonce`;
    /*
      typ เป็น vendor เหมือน token จริง authMiddleware ของเจ้าหน้าที่จึงปฏิเสธ
      และไม่มี sid vendorMiddleware ก็ปฏิเสธ ใช้ได้เฉพาะ endpoint ขั้นกลางของการเข้าระบบ
    */
    return jwt.sign({ vendor_account_id: accountId, nonce: String(row.pending_nonce), typ: VENDOR_TOKEN, stage: 'pending' });
};

/**
 * อ่านบัญชีจาก pending_token — ต้องตรงกับ nonce ในฐานและยังไม่หมดอายุ
 * ถ้าไม่ตรงคือหมดอายุ ถูกใช้ไปแล้ว หรือมีการเข้าระบบรอบใหม่ทับ
 */
const loadPending = async (jwt: any, token: unknown) => {
    const p = await jwt.verify(String(token ?? '')).catch(() => null) as
        { vendor_account_id?: number; nonce?: string; typ?: string; stage?: string } | null;
    if (!p || p.typ !== VENDOR_TOKEN || p.stage !== 'pending' || !p.nonce) return null;

    const rows = await nurse`
        SELECT va.*, v.vendor_name
        FROM vendor_accounts va
        JOIN vendors v ON v.vendor_id = va.vendor_id
        WHERE va.vendor_account_id = ${Number(p.vendor_account_id)}
          AND va.pending_nonce = ${p.nonce}::uuid
          AND va.pending_until > NOW()
          AND va.is_active AND v.is_active
          AND va.identity_verified_at IS NOT NULL
        LIMIT 1`;
    return rows[0] ?? null;
};

const PENDING_EXPIRED = { success: false, code: 'PENDING_EXPIRED', message: 'ขั้นตอนเข้าระบบหมดเวลา กรุณาเริ่มใหม่' };

// ───── 1. ชื่อผู้ใช้ + รหัสผ่าน ─────

export const vendorLogin = async (ctx: Ctx) => {
    const { body, set, jwt } = ctx;
    const { username, password } = body as { username: string; password: string };
    const name = String(username ?? '').trim().toLowerCase();
    const info = clientInfo(ctx);

    const deny = () => { set.status = 401; return { success: false, message: DENY }; };
    if (!name || !password) return deny();

    try {
        const rows = await nurse`
            SELECT va.*, v.vendor_name
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
            await logVendorEvent({ username_tried: name, event: 'login_unknown_user', ...info });
            return deny();
        }

        const id = Number(acc.vendor_account_id);

        // ล็อกต้องบอกตรงๆ ไม่งั้นคนใช้จะกรอกซ้ำไปเรื่อยๆ แล้วล็อกยาวขึ้นโดยไม่รู้ตัว
        if (isLocked(acc)) {
            await logVendorEvent({ vendor_account_id: id, event: 'login_locked', ...info });
            set.status = 423;
            return { success: false, message: lockedMessage() };
        }

        const ok = await Bun.password.verify(password, String(acc.password), 'argon2id').catch(() => false);
        if (!ok) {
            const locked = await countFailure(id, Number(acc.failed_count));
            await logVendorEvent({ vendor_account_id: id, event: locked ? 'password_fail_locked' : 'password_fail', ...info });
            return deny();
        }

        /*
          ข้อความสองกรณีข้างล่างบอกสถานะบัญชีได้ แต่ตอบหลังรหัสผ่านถูกแล้วเท่านั้น
          คนที่รู้รหัสผ่านคือเจ้าของบัญชี ต้องรู้ว่าติดอะไรถึงจะไปติดต่อได้ถูกเรื่อง
        */
        if (!acc.identity_verified_at) {
            await logVendorEvent({ vendor_account_id: id, event: 'login_unverified', ...info });
            set.status = 403;
            return {
                success: false,
                message: 'บัญชีนี้ยังไม่ได้ยืนยันตัวตน กรุณานำบัตรประชาชนไปยืนยันที่งานโภชนาการของโรงพยาบาล',
            };
        }
        if (acc.must_change_password && acc.temp_password_expires_at
            && new Date(acc.temp_password_expires_at) < new Date()) {
            await logVendorEvent({ vendor_account_id: id, event: 'temp_password_expired', ...info });
            set.status = 403;
            return { success: false, message: 'รหัสผ่านชั่วคราวหมดอายุแล้ว กรุณาขอรหัสใหม่จากงานโภชนาการ' };
        }

        await logVendorEvent({ vendor_account_id: id, event: 'password_ok', ...info });
        return {
            success: true,
            next: nextStep(acc),
            pending_token: await issuePending(jwt, id),
            display_name: `${acc.first_name ?? ''} ${acc.last_name ?? ''}`.trim() || acc.display_name,
        };
    } catch (error) {
        console.error('Vendor login error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ───── 2. ตั้งรหัสผ่านเอง ─────

export const vendorSetPassword = async (ctx: Ctx) => {
    const { body, set, jwt } = ctx;
    const { pending_token, new_password } = body as { pending_token: string; new_password: string };
    const info = clientInfo(ctx);

    try {
        const acc = await loadPending(jwt, pending_token);
        if (!acc) { set.status = 401; return PENDING_EXPIRED; }

        const pw = String(new_password ?? '');
        const problem = passwordProblem(pw, acc);
        if (problem) { set.status = 400; return { success: false, message: problem }; }

        // ห้ามใช้รหัสชั่วคราวที่ได้มาเป็นรหัสจริง ไม่งั้นผู้ดูแลที่ออกรหัสจะรู้รหัสจริงไปด้วย
        if (await Bun.password.verify(pw, String(acc.password), 'argon2id').catch(() => false)) {
            set.status = 400;
            return { success: false, message: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสที่ได้รับจากโรงพยาบาล' };
        }

        const hash = await Bun.password.hash(pw, 'argon2id');
        const [row] = await nurse`
            UPDATE vendor_accounts
            SET password = ${hash}
              , must_change_password = false
              , temp_password_expires_at = NULL
              , password_changed_at = NOW()
            WHERE vendor_account_id = ${acc.vendor_account_id}
            RETURNING must_change_password`;

        await logVendorEvent({ vendor_account_id: Number(acc.vendor_account_id), event: 'password_changed', ...info });
        return { success: true, next: nextStep(row), pending_token: await issuePending(jwt, Number(acc.vendor_account_id)) };
    } catch (error) {
        console.error('Vendor set password error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** กติการหัสผ่าน — คืนข้อความปัญหา หรือ null ถ้าผ่าน */
export const passwordProblem = (pw: string, acc: { username?: string; phone?: string | null }) => {
    if (pw.length < MIN_PASSWORD) return `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`;
    if (pw.length > 200) return 'รหัสผ่านยาวเกินไป';
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข';
    const lower = pw.toLowerCase();
    if (acc.username && lower.includes(String(acc.username).toLowerCase())) return 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น';
    const phone = String(acc.phone ?? '').replace(/\D/g, '');
    if (phone.length >= 6 && pw.includes(phone)) return 'รหัสผ่านต้องไม่มีเบอร์โทรศัพท์อยู่ในนั้น';
    return null;
};

// ───── 3. ส่ง OTP ไป LINE OA หมอพร้อม ─────

/**
 * ส่ง OTP ใหม่ทุกครั้งที่เรียก ตัวเก่าใช้ไม่ได้ทันที
 * กันกดรัว: ห่างกันอย่างน้อย OTP_RESEND_SECONDS และไม่เกิน OTP_MAX_PER_WINDOW ครั้งใน OTP_WINDOW_MINUTES
 */
export const vendorOtpSend = async (ctx: Ctx) => {
    const { body, set, jwt } = ctx;
    const { pending_token } = body as { pending_token: string };
    const info = clientInfo(ctx);

    try {
        const acc = await loadPending(jwt, pending_token);
        if (!acc) { set.status = 401; return PENDING_EXPIRED; }
        const id = Number(acc.vendor_account_id);

        if (acc.must_change_password) {
            set.status = 409;
            return { success: false, message: 'กรุณาตั้งรหัสผ่านก่อน' };
        }
        if (!acc.national_id_enc) {
            set.status = 409;
            return { success: false, message: 'บัญชีนี้ยังไม่มีเลขบัตรประชาชน กรุณาติดต่องานโภชนาการ' };
        }

        const now = Date.now();
        const sentAt = acc.otp_sent_at ? new Date(acc.otp_sent_at).getTime() : 0;
        const wait = Math.ceil((sentAt + OTP_RESEND_SECONDS * 1000 - now) / 1000);
        if (wait > 0) {
            set.status = 429;
            return { success: false, code: 'OTP_COOLDOWN', retry_after: wait, message: `กรุณารออีก ${wait} วินาทีก่อนขอรหัสใหม่` };
        }

        const windowStart = acc.otp_window_start ? new Date(acc.otp_window_start).getTime() : 0;
        const inWindow = now - windowStart < OTP_WINDOW_MINUTES * 60_000;
        const count = inWindow ? Number(acc.otp_window_count) : 0;
        if (count >= OTP_MAX_PER_WINDOW) {
            set.status = 429;
            return { success: false, code: 'OTP_LIMIT', message: `ขอรหัสครบ ${OTP_MAX_PER_WINDOW} ครั้งแล้ว กรุณารอ ${OTP_WINDOW_MINUTES} นาที` };
        }

        const code = newOtp();

        /*
          ส่งก่อนแล้วค่อยบันทึก ถ้าส่งไม่สำเร็จ OTP เดิม (ถ้ามี) ยังใช้ได้อยู่
          แต่นับครั้งเสมอ ไม่งั้นปลายทางที่ล่มจะทำให้กดส่งได้ไม่จำกัด
        */
        await nurse`
            UPDATE vendor_accounts
            SET otp_sent_at = NOW()
              , otp_window_start = ${inWindow ? new Date(windowStart) : new Date(now)}
              , otp_window_count = ${count + 1}
            WHERE vendor_account_id = ${id}`;

        try {
            await sendVendorOtp({
                cid: decryptPii(String(acc.national_id_enc)),
                code,
                minutes: OTP_MINUTES,
                username: String(acc.username),
            });
        } catch (error) {
            const reason = error instanceof OtpSendError ? error.message : 'ส่งไม่สำเร็จ';
            console.error('Vendor OTP send failed:', reason);
            await logVendorEvent({ vendor_account_id: id, event: 'otp_send_failed', detail: reason, ...info });
            set.status = 502;
            return {
                success: false,
                message: 'ส่งรหัส OTP ไปที่หมอพร้อมไม่สำเร็จ กรุณาตรวจว่าเพิ่มเพื่อน LINE หมอพร้อมและยืนยันตัวตนแล้ว หรือติดต่องานโภชนาการ',
            };
        }

        await nurse`
            UPDATE vendor_accounts
            SET otp_hash = ${otpHash(id, code)}
              , otp_expires_at = NOW() + make_interval(mins => ${OTP_MINUTES})
              , otp_attempts = 0
            WHERE vendor_account_id = ${id}`;
        await logVendorEvent({ vendor_account_id: id, event: 'otp_sent', ...info });

        return {
            success: true,
            // บอกปลายทางแบบปิดบัง ให้ผู้ใช้รู้ว่าส่งไปเลขบัตรไหน ไม่เปิดเผยเลขเต็ม
            sent_to: maskNationalId(acc.national_id_last4),
            expires_in: OTP_MINUTES * 60,
            resend_after: OTP_RESEND_SECONDS,
        };
    } catch (error) {
        const pii = piiError(set, error);
        if (pii) return pii;
        console.error('Vendor OTP send error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ───── 4. ตรวจ OTP → session ─────

export const vendorOtpVerify = async (ctx: Ctx) => {
    const { body, set, jwt } = ctx;
    const { pending_token, code } = body as { pending_token: string; code: string };
    const info = clientInfo(ctx);

    try {
        const acc = await loadPending(jwt, pending_token);
        if (!acc) { set.status = 401; return PENDING_EXPIRED; }
        const id = Number(acc.vendor_account_id);

        if (isLocked(acc)) { set.status = 423; return { success: false, message: lockedMessage() }; }
        if (acc.must_change_password) {
            set.status = 409;
            return { success: false, message: 'ขั้นตอนไม่ครบ กรุณาเริ่มเข้าระบบใหม่' };
        }
        if (!acc.otp_hash || !acc.otp_expires_at || new Date(acc.otp_expires_at) < new Date()) {
            set.status = 401;
            return { success: false, code: 'OTP_EXPIRED', message: 'รหัส OTP หมดอายุหรือยังไม่ได้ขอ กรุณากดขอรหัสใหม่' };
        }

        if (!otpMatches(id, String(code ?? '').trim(), String(acc.otp_hash))) {
            /*
              นับสองชั้น: ครั้งที่ผิดของ OTP ตัวนี้ (ครบแล้วทิ้ง OTP ต้องขอใหม่)
              และครั้งที่ผิดของบัญชี (ครบแล้วล็อก) ซึ่งนับรวมกับรหัสผ่าน
            */
            const attempts = Number(acc.otp_attempts) + 1;
            await nurse`
                UPDATE vendor_accounts
                SET otp_attempts = ${attempts}
                  , otp_hash = CASE WHEN ${attempts >= OTP_MAX_ATTEMPTS} THEN NULL ELSE otp_hash END
                WHERE vendor_account_id = ${id}`;
            const locked = await countFailure(id, Number(acc.failed_count));
            await logVendorEvent({ vendor_account_id: id, event: locked ? 'otp_fail_locked' : 'otp_fail', ...info });
            set.status = locked ? 423 : 401;
            return {
                success: false,
                code: attempts >= OTP_MAX_ATTEMPTS ? 'OTP_EXPIRED' : 'OTP_WRONG',
                message: locked ? lockedMessage()
                    : attempts >= OTP_MAX_ATTEMPTS ? 'กรอกผิดหลายครั้ง รหัสนี้ใช้ไม่ได้แล้ว กรุณากดขอรหัสใหม่'
                    : 'รหัส OTP ไม่ถูกต้อง',
            };
        }

        const replaced = Boolean(acc.session_id);

        /*
          ออก session ใหม่ทับของเดิม — บัญชีหนึ่งใช้ได้ทีละเครื่อง
          ถ้ามีคนอื่นถือบัญชีนี้อยู่ เขาจะหลุดทันทีและเห็นข้อความว่าเข้าจากเครื่องอื่น
          OTP ถูกล้างทิ้ง ใช้ซ้ำไม่ได้
        */
        const [row] = await nurse`
            UPDATE vendor_accounts
            SET otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0
              , failed_count = 0, locked_until = NULL
              , pending_nonce = NULL, pending_until = NULL
              , session_id = gen_random_uuid(), session_started_at = NOW()
              , last_login_at = NOW()
            WHERE vendor_account_id = ${id}
            RETURNING session_id`;

        if (replaced) await logVendorEvent({ vendor_account_id: id, event: 'session_replaced', ...info });
        await logVendorEvent({ vendor_account_id: id, event: 'login_ok', ...info });

        /*
          token มีแค่เลขบัญชี เลข session และชนิด ไม่ใส่ชื่อหรือสิทธิ์
          สิทธิ์อ่านจากฐานทุกครั้ง (ดู vendorMiddleware) ปิดบัญชีหรือตัด session จึงมีผลทันที
        */
        const token = await jwt.sign({ vendor_account_id: id, sid: String(row.session_id), typ: VENDOR_TOKEN });

        return {
            success: true,
            token,
            data: {
                vendor_id: Number(acc.vendor_id),
                vendor_name: acc.vendor_name,
                display_name: `${acc.first_name ?? ''} ${acc.last_name ?? ''}`.trim() || acc.display_name,
            },
        };
    } catch (error) {
        const pii = piiError(set, error);
        if (pii) return pii;
        console.error('Vendor OTP verify error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ───── หลังเข้าระบบ ─────

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

/** ออกจากระบบ — ปิด session ฝั่งเซิร์ฟเวอร์ด้วย token เดิมจะใช้ต่อไม่ได้แม้ยังไม่หมดอายุ */
export const vendorLogout = async (
    ctx: { set: any; vendor: VendorContext | null; request: Request; server?: Ctx['server'] }
) => {
    const { set, vendor } = ctx;
    if (!vendor) { set.status = 401; return { success: false, message: 'Unauthorized' }; }
    await nurse`
        UPDATE vendor_accounts SET session_id = NULL
        WHERE vendor_account_id = ${vendor.vendor_account_id} AND session_id = ${vendor.session_id}::uuid`;
    await logVendorEvent({ vendor_account_id: vendor.vendor_account_id, event: 'logout', ...clientInfo(ctx) });
    return { success: true };
};
