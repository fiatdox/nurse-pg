import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * ตัวช่วยยืนยันตัวตนบัญชีบริษัทผู้รับจ้าง
 *
 * - เข้ารหัสข้อมูลส่วนบุคคล (เลขบัตรประชาชน)
 * - ตรวจเลขบัตรประชาชน
 * - OTP ที่ส่งทาง LINE OA หมอพร้อม (การส่งจริงอยู่ที่ utils/mophPromptOtp.ts)
 * - สร้างรหัสผ่านชั่วคราว
 *
 * เขียนเองบน node:crypto ไม่เพิ่ม dependency เพราะทั้งหมดเป็นมาตรฐานสั้นๆ
 * และโค้ดส่วนนี้คือด่านยืนยันตัวตน ควรอ่านได้ครบในไฟล์เดียว
 */

/**
 * กุญแจเข้ารหัสอยู่ใน .env (VENDOR_PII_KEY) ไม่อยู่ในฐาน
 * ฐานหลุดออกไปอย่างเดียวจึงอ่านเลขบัตรหรือ secret ไม่ได้
 *
 * ไม่ throw ตอนโหลดไฟล์ เพราะถ้ายังไม่ได้ตั้ง ระบบส่วนอื่นทั้งหมดต้องยังทำงานได้
 * เฉพาะการเปิดบัญชีและการเข้าระบบของบริษัทที่ใช้ไม่ได้ พร้อมข้อความบอกสาเหตุ
 */
export class PiiKeyMissingError extends Error {
    constructor() {
        super('ยังไม่ได้ตั้งค่า VENDOR_PII_KEY ใน .env ของเซิร์ฟเวอร์ (base64 ยาว 32 ไบต์)');
    }
}

const piiKey = (): Buffer => {
    const raw = process.env.VENDOR_PII_KEY ?? '';
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new PiiKeyMissingError();
    return key;
};

if (Buffer.from(process.env.VENDOR_PII_KEY ?? '', 'base64').length !== 32) {
    console.warn('[vendor] VENDOR_PII_KEY ไม่ได้ตั้งหรือยาวไม่ถึง 32 ไบต์ — บริษัทผู้รับจ้างจะเข้าระบบไม่ได้');
}

/** AES-256-GCM → "iv.tag.ciphertext" (base64url) */
export const encryptPii = (plain: string): string => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', piiKey(), iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
};

export const decryptPii = (packed: string): string => {
    const [iv, tag, ct] = packed.split('.').map(s => Buffer.from(s, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', piiKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
};

// ───── เลขบัตรประชาชน ─────

export const normalizeNationalId = (v: unknown) => String(v ?? '').replace(/[\s-]/g, '');

/** เลข 13 หลักพร้อมหลักตรวจสอบ กันพิมพ์ผิดหนึ่งหลักแล้วกลายเป็นคนละคน */
export const isValidThaiNationalId = (id: string): boolean => {
    if (!/^\d{13}$/.test(id)) return false;
    const sum = [...id.slice(0, 12)].reduce((a, d, i) => a + Number(d) * (13 - i), 0);
    return (11 - (sum % 11)) % 10 === Number(id[12]);
};

/**
 * HMAC ของเลขบัตร ใช้กับดัชนี UNIQUE บังคับหนึ่งคนหนึ่งบัญชี
 * ใช้ HMAC ไม่ใช่ SHA ธรรมดา เพราะเลขบัตรมีแค่ 10^13 แบบ ไล่แฮชครบได้ถ้าไม่มีกุญแจ
 */
export const nationalIdHash = (id: string) =>
    createHmac('sha256', piiKey()).update(`national-id:${id}`).digest('hex');

export const maskNationalId = (last4: string | null) =>
    last4 ? `x-xxxx-xxxx${last4[0]}-${last4.slice(1, 3)}-${last4[3]}` : null;

// ───── OTP ที่ส่งทาง LINE OA หมอพร้อม ─────

/** รหัส 6 หลัก สุ่มด้วย crypto — ไม่ใช้ Math.random ซึ่งเดาได้ */
export const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * เก็บแค่ HMAC ของ OTP ผูกกับเลขบัญชี ไม่เก็บตัวเลขจริง
 * ใส่เลขบัญชีเข้าไปด้วย OTP ของบัญชีหนึ่งจึงเอาไปใช้กับอีกบัญชีไม่ได้แม้ตัวเลขตรงกัน
 */
export const otpHash = (accountId: number, code: string) =>
    createHmac('sha256', piiKey()).update(`otp:${accountId}:${code}`).digest('hex');

export const otpMatches = (accountId: number, code: string, storedHash: string) => {
    if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
    return timingSafeEqual(Buffer.from(otpHash(accountId, code), 'hex'), Buffer.from(storedHash, 'hex'));
};

// ───── รหัสผ่านชั่วคราว ─────

/** ตัดตัวที่อ่านสับสนออก (0/O, 1/l/I) เพราะต้องอ่านให้บริษัทฟังหรือพิมพ์ตามกระดาษ */
const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export const newTempPassword = (length = 12) =>
    Array.from({ length }, () => TEMP_CHARS[randomInt(TEMP_CHARS.length)]).join('');
