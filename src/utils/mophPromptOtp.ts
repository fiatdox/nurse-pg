/**
 * ส่ง OTP ของบัญชีบริษัทผู้รับจ้าง ไปที่ LINE OA หมอพร้อม ของเจ้าของเลขบัตร
 *
 * หมอพร้อมผูกบัญชี LINE กับเลขบัตรประชาชนที่ยืนยันตัวตนแล้ว
 * ส่งตามเลขบัตรจึงถึงเจ้าของเลขบัตรตัวจริงเท่านั้น ไม่ต้องเก็บเบอร์หรือ LINE ID ของบริษัทเอง
 *
 * ช่องทางเลือกด้วย VENDOR_OTP_TRANSPORT
 *   mophprompt (ค่าเริ่มต้น) — ส่งผ่าน API หมอพร้อม ใช้ MOPHPROMPT_CLIENT_ID / MOPHPROMPT_CLIENT_SECRET
 *   console                 — พิมพ์ OTP ลง log ของเซิร์ฟเวอร์ ใช้ทดสอบบนเครื่อง dev เท่านั้น
 *                             ถ้า NODE_ENV=production จะไม่ยอมทำงาน
 */

export class OtpSendError extends Error {}

export interface OtpDelivery {
    /** เลขบัตรประชาชน 13 หลัก (ถอดรหัสแล้ว) — ห้ามลง log */
    cid: string;
    code: string;
    /** อายุของ OTP เป็นนาที ใส่ในข้อความให้ผู้รับรู้ */
    minutes: number;
    username: string;
}

/** ข้อความที่ผู้รับเห็นใน LINE — บอกว่ามาจากไหน ใช้ทำอะไร และห้ามบอกใคร */
export const otpMessage = (d: OtpDelivery) =>
    `รหัส OTP เข้าระบบรายงานผู้รับจ้างทำอาหาร คือ ${d.code} (บัญชี ${d.username}) `
    + `ใช้ได้ ${d.minutes} นาที ห้ามบอกรหัสนี้กับผู้อื่น รวมถึงเจ้าหน้าที่โรงพยาบาล `
    + `หากคุณไม่ได้กำลังเข้าระบบ กรุณาแจ้งงานโภชนาการทันที`;

const transport = () => (process.env.VENDOR_OTP_TRANSPORT || 'mophprompt').trim().toLowerCase();

/** ใช้ตรวจตอนเปิดบัญชี/เข้าระบบ ว่าเซิร์ฟเวอร์ตั้งค่าส่ง OTP ไว้แล้ว ให้ข้อความผิดพลาดที่อ่านเข้าใจ */
export const otpTransportProblem = (): string | null => {
    const t = transport();
    if (t === 'console') {
        return process.env.NODE_ENV === 'production'
            ? 'VENDOR_OTP_TRANSPORT=console ใช้บนเครื่องจริงไม่ได้'
            : null;
    }
    if (t === 'mophprompt') {
        if (!process.env.MOPHPROMPT_CLIENT_ID || !process.env.MOPHPROMPT_CLIENT_SECRET) {
            return 'ยังไม่ได้ตั้ง MOPHPROMPT_CLIENT_ID / MOPHPROMPT_CLIENT_SECRET ใน .env';
        }
        return null;
    }
    return `ไม่รู้จัก VENDOR_OTP_TRANSPORT=${t}`;
};

export const sendVendorOtp = async (d: OtpDelivery): Promise<void> => {
    const problem = otpTransportProblem();
    if (problem) throw new OtpSendError(problem);

    if (transport() === 'console') {
        // ไม่พิมพ์เลขบัตร — แค่ OTP กับชื่อผู้ใช้ก็พอสำหรับทดสอบ
        console.warn(`[vendor OTP · console · ห้ามใช้บนเครื่องจริง] ${d.username}: ${d.code}`);
        return;
    }

    await sendViaMophPrompt(d);
};

/**
 * ส่งข้อความผ่าน API หมอพร้อม
 *
 * ⚠ ยังไม่ได้เชื่อม — รอเอกสาร API จากผู้ใช้ (endpoint, วิธีขอ token ด้วย client ID/secret,
 *   รูปแบบ body ที่ระบุเลขบัตรผู้รับและข้อความ, และรูปแบบคำตอบเมื่อส่งไม่ได้
 *   เช่น เลขบัตรนี้ไม่ได้ผูก LINE หมอพร้อม)
 *
 *   ไม่เดา URL หรือรูปแบบข้อมูลเอง เพราะถ้าเดาผิด ระบบจะดูเหมือนส่งสำเร็จ
 *   แต่ OTP ไม่ถึงใคร หรือแย่กว่านั้นคือส่งเลขบัตรไปที่ปลายทางที่ไม่ใช่ของกระทรวง
 */
const sendViaMophPrompt = async (_d: OtpDelivery): Promise<void> => {
    throw new OtpSendError('ยังไม่ได้เชื่อม API หมอพร้อมสำหรับส่ง OTP');
};
