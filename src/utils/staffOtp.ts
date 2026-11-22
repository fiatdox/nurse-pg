import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { nurse } from '../db';
import { readSetting } from '../controllers/systemSettingsController';

/**
 * MFA ของเจ้าหน้าที่: OTP ทาง LINE OA หมอพร้อม
 *
 * เปิด/ปิดได้จากหน้าตั้งค่าของผู้ดูแลระบบ (system_settings.key = 'staff_login_otp')
 * และมีสวิตช์ฉุกเฉินใน .env: STAFF_OTP_FORCE_OFF=true ปิดทับค่าในฐานเสมอ
 * ใช้ตอนหมอพร้อมล่ม หรือส่ง OTP ไม่ได้จนไม่มีใครเข้าระบบ (รวมผู้ดูแล) ได้เลย
 */

export const STAFF_OTP_KEY = 'staff_login_otp';

/** อายุของขั้นกลาง (หลังรหัสผ่านถูก ก่อนกรอก OTP เสร็จ) */
export const CHALLENGE_MINUTES = 10;
/** อายุ OTP / ผิดได้กี่ครั้งต่อหนึ่งรหัส / ผิดรวมกี่ครั้งต่อ challenge */
export const OTP_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 3;
export const CHALLENGE_MAX_FAILED = 6;
/** ขอใหม่ได้เมื่อไหร่ / ส่งได้กี่ครั้งต่อ challenge */
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_SENDS = 5;
/** เริ่มเข้าระบบ (รหัสผ่านถูก) ได้กี่ครั้งต่อผู้ใช้ในช่วงเวลา — กันยิง OTP ใส่ LINE ของเจ้าของบัญชีรัว ๆ */
export const START_MAX_PER_WINDOW = 6;
export const START_WINDOW_MINUTES = 15;

/** ชนิดของ token ขั้นกลาง authMiddleware รับเฉพาะ typ = staff จึงเอาตัวนี้ไปเรียก API อื่นไม่ได้ */
export const STAFF_OTP_PENDING = 'staff_otp_pending';

export const forceOff = () => String(process.env.STAFF_OTP_FORCE_OFF ?? '').trim().toLowerCase() === 'true';

/** ค่าที่ผู้ดูแลตั้งไว้ในฐาน (ไม่นับสวิตช์ฉุกเฉิน) */
export const staffOtpSetting = async (): Promise<boolean> => {
    const v = await readSetting<{ enabled?: boolean }>(STAFF_OTP_KEY, { enabled: false });
    return v?.enabled === true;
};

/** ต้องใช้ OTP ตอนเข้าระบบไหม — อ่านค่าไม่ได้ = ไม่บังคับ (readSetting คืนค่าเริ่มต้นเมื่อฐานมีปัญหา) */
export const staffOtpRequired = async (): Promise<boolean> => !forceOff() && (await staffOtpSetting());

/** รหัส 6 หลัก สุ่มด้วย crypto */
export const newStaffOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * HMAC ของ OTP ผูกกับ challenge — กุญแจคือ JWT_SECRET ที่ระบบต้องมีอยู่แล้ว
 * ใส่ challenge id เข้าไปด้วย OTP ของการเข้าระบบรอบหนึ่งจึงเอาไปใช้กับอีกรอบไม่ได้
 */
const key = () => {
    const k = process.env.JWT_SECRET;
    if (!k) throw new Error('JWT_SECRET is not set');
    return k;
};
export const staffOtpHash = (challengeId: string, code: string) =>
    createHmac('sha256', key()).update(`staff-otp:${challengeId}:${code}`).digest('hex');

export const staffOtpMatches = (challengeId: string, code: string, stored: string | null) => {
    if (!stored || !/^\d{6}$/.test(code) || !/^[0-9a-f]{64}$/.test(stored)) return false;
    return timingSafeEqual(Buffer.from(staffOtpHash(challengeId, code), 'hex'), Buffer.from(stored, 'hex'));
};

/** เลขบัตรประชาชนไทย 13 หลักที่ผ่าน check digit — ไม่ผ่าน = หมอพร้อมส่งไม่ถึงแน่นอน ไม่ต้องลองส่ง */
export const validCid = (raw: unknown): string | null => {
    const cid = String(raw ?? '').replace(/\D/g, '');
    if (!/^\d{13}$/.test(cid)) return null;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(cid[i]) * (13 - i);
    return (11 - (sum % 11)) % 10 === Number(cid[12]) ? cid : null;
};

export const logStaffAuth = async (e: {
    username?: string | null; event: string; detail?: string | null; ip?: string | null; user_agent?: string | null;
}) => {
    try {
        await nurse`
            INSERT INTO staff_auth_events (username, event, detail, ip, user_agent)
            VALUES (${e.username?.slice(0, 100) ?? null}, ${e.event}, ${e.detail?.slice(0, 255) ?? null},
                    ${e.ip ?? null}, ${e.user_agent ?? null})`;
    } catch (error) {
        // ประวัติบันทึกไม่ได้ต้องไม่ทำให้การเข้าระบบพัง แต่ต้องเห็นใน log
        console.error('Staff auth event log failed:', error);
    }
};

/** ตารางของโหมด OTP มีในฐานแล้วหรือยัง (ยังไม่ได้รัน migration = ห้ามเปิดโหมด) */
export const staffOtpTablesReady = async (): Promise<boolean> => {
    try {
        const r = await nurse`SELECT to_regclass('staff_login_otp') IS NOT NULL AND to_regclass('staff_auth_events') IS NOT NULL AS ok`;
        return r[0]?.ok === true;
    } catch {
        return false;
    }
};
