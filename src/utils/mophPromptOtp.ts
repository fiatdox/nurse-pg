/**
 * ส่ง OTP ของบัญชีบริษัทผู้รับจ้าง ไปที่ LINE OA หมอพร้อม ของเจ้าของเลขบัตร
 *
 * หมอพร้อมผูกบัญชี LINE กับเลขบัตรประชาชนที่ยืนยันตัวตนแล้ว
 * ส่งตามเลขบัตรจึงถึงเจ้าของเลขบัตรตัวจริงเท่านั้น ไม่ต้องเก็บเบอร์หรือ LINE ID ของบริษัทเอง
 *
 * ช่องทางเลือกด้วย VENDOR_OTP_TRANSPORT
 *   mophprompt (ค่าเริ่มต้น) — ส่งผ่าน MOPH Alert ใช้ MOPH_ALERT_BASE_URL / _PATH / _CLIENT_ID / _SECRET_ID
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
    `รหัส OTP เข้าระบบรายงานผู้รับจ้างทำอาหาร คือ ${d.code} `
    + `ใช้ได้ ${d.minutes} นาที ห้ามบอกรหัสนี้กับผู้อื่น รวมถึงเจ้าหน้าที่โรงพยาบาล `
    + `หากคุณไม่ได้กำลังเข้าระบบ กรุณาแจ้งงานโภชนาการทันที`;

/** ช่องทางเดียวกันทั้ง OTP ของเจ้าหน้าที่และของบริษัท · OTP_TRANSPORT ใหม่ ส่วน VENDOR_OTP_TRANSPORT คงไว้ให้ .env เดิมใช้ต่อได้ */
const transport = () =>
    (process.env.OTP_TRANSPORT || process.env.VENDOR_OTP_TRANSPORT || 'mophprompt').trim().toLowerCase();

/**
 * เชื่อม API หมอพร้อมแล้วหรือยัง — เปลี่ยนเป็น true พร้อมกับตอนเขียน sendViaMophPrompt จริง
 * ใช้กันไม่ให้ผู้ดูแลเปิดโหมด OTP ของเจ้าหน้าที่ ทั้งที่ยังส่ง OTP ไม่ได้ ซึ่งจะทำให้ทุกคนเข้าระบบไม่ได้
 */
const MOPHPROMPT_CONNECTED = true;

/** ค่าที่ต้องมีใน .env เพื่อส่งผ่าน MOPH Alert (URL เต็ม = BASE_URL + PATH) — CLIENT_ID / SECRET_ID ห้ามลง log */
const MOPH_ALERT_ENV = ['MOPH_ALERT_BASE_URL', 'MOPH_ALERT_PATH', 'MOPH_ALERT_CLIENT_ID', 'MOPH_ALERT_SECRET_ID'] as const;

/** ใช้ตรวจตอนเปิดบัญชี/เข้าระบบ ว่าเซิร์ฟเวอร์ตั้งค่าส่ง OTP ไว้แล้ว ให้ข้อความผิดพลาดที่อ่านเข้าใจ */
export const otpTransportProblem = (): string | null => {
    const t = transport();
    if (t === 'console') {
        return process.env.NODE_ENV === 'production'
            ? 'OTP_TRANSPORT=console ใช้บนเครื่องจริงไม่ได้'
            : null;
    }
    if (t === 'mophprompt') {
        const missing = MOPH_ALERT_ENV.filter(k => !process.env[k]?.trim());
        if (missing.length) return `ยังไม่ได้ตั้ง ${missing.join(' / ')} ใน .env`;
        return null;
    }
    return `ไม่รู้จัก OTP_TRANSPORT=${t}`;
};

/**
 * ส่ง OTP ได้จริงตอนนี้ไหม — เข้มกว่า otpTransportProblem ตรงที่นับว่า API หมอพร้อมยังไม่ได้เชื่อมด้วย
 * คืนข้อความสาเหตุ หรือ null ถ้าพร้อม
 */
export const otpReadyProblem = (): string | null => {
    const p = otpTransportProblem();
    if (p) return p;
    if (transport() === 'mophprompt' && !MOPHPROMPT_CONNECTED) {
        return 'ยังไม่ได้เชื่อม API หมอพร้อมสำหรับส่ง OTP (รอเอกสาร API)';
    }
    return null;
};

/** ช่องทางที่ใช้อยู่ ให้หน้าตั้งค่าแสดงว่าเป็นโหมดทดสอบหรือของจริง */
export const otpTransportName = () => transport();

/**
 * ส่ง OTP ของเจ้าหน้าที่ (เข้าระบบหลัก) ไป LINE OA หมอพร้อมตามเลขบัตรใน core_kon.users
 * ข้อความต่างจากของบริษัท ผู้รับต้องรู้ว่ารหัสนี้เป็นของระบบไหน
 */
export const sendStaffOtp = async (d: OtpDelivery): Promise<void> => {
    const problem = otpTransportProblem();
    if (problem) throw new OtpSendError(problem);
    if (transport() === 'console') {
        console.warn(`[staff OTP · console · ห้ามใช้บนเครื่องจริง] ${d.username}: ${d.code}`);
        return;
    }
    await sendViaMophPrompt(d, staffOtpMessage(d), OTP_CARD.staff);
};

export const staffOtpMessage = (d: OtpDelivery) =>
    `รหัส OTP เข้าระบบสารสนเทศทางการพยาบาล คือ ${d.code} `
    + `ใช้ได้ ${d.minutes} นาที ห้ามบอกรหัสนี้กับผู้อื่น `
    + `หากคุณไม่ได้กำลังเข้าระบบ กรุณาเปลี่ยนรหัสผ่านและแจ้งผู้ดูแลระบบทันที`;

export const sendVendorOtp = async (d: OtpDelivery): Promise<void> => {
    const problem = otpTransportProblem();
    if (problem) throw new OtpSendError(problem);

    if (transport() === 'console') {
        // ไม่พิมพ์เลขบัตร — แค่ OTP กับชื่อผู้ใช้ก็พอสำหรับทดสอบ
        console.warn(`[vendor OTP · console · ห้ามใช้บนเครื่องจริง] ${d.username}: ${d.code}`);
        return;
    }

    await sendViaMophPrompt(d, otpMessage(d), OTP_CARD.vendor);
};

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * ส่งข้อความผ่าน MOPH Alert v3.1 (Free Form JSON) เข้า LINE OA หมอพร้อมตามเลขบัตร
 *
 * รูปแบบเดียวกับที่ระบบ ERP และระบบแจ้งนัดของโรงพยาบาลใช้งานอยู่จริง
 *   POST {MOPH_ALERT_BASE_URL}{MOPH_ALERT_PATH}
 *   header client-key / secret-key
 *   body { cid: [เลขบัตร], message_title, message_html, message_text, message_type, messages: [flex] }
 *   สำเร็จ = message_code 200 (หรือไม่มี message_code แต่ HTTP 200)
 *   "CID Not found" = เลขบัตรนี้ยังไม่ผูก LINE หมอพร้อม
 *
 * ห้ามลง log เลขบัตร รหัส OTP หรือ client-key / secret-key
 */
/*
 * หน้าตาการ์ด OTP ชุดเดียวกับระบบ DUE ของโรงพยาบาล ผู้ใช้เห็นแล้วรู้ว่าเป็นข้อความของ รพ. จริง
 * หัวสี teal ชื่อ รพ. + ชื่อระบบ · กล่องรหัสพื้นอ่อนตัวใหญ่กลางการ์ด · คำเตือนสีแดงท้ายการ์ด
 */
const TEAL = '#0f766e';
const TEAL_DARK = '#134e4a';
const TEAL_LIGHT = '#f0fdfa';
const HOSPITAL = 'โรงพยาบาลพะเยา';

interface OtpCard { title: string; system: string; warn: string }
const OTP_CARD = {
    staff: {
        title: 'รหัส OTP เข้าระบบสารสนเทศทางการพยาบาล',
        system: 'ระบบสารสนเทศทางการพยาบาล',
        warn: 'ห้ามบอกรหัสนี้กับผู้อื่น เจ้าหน้าที่จะไม่ขอรหัสนี้จากท่าน หากไม่ได้กำลังเข้าระบบ กรุณาเปลี่ยนรหัสผ่านและแจ้งผู้ดูแลระบบทันที',
    },
    vendor: {
        title: 'รหัส OTP เข้าระบบรายงานผู้รับจ้างทำอาหาร',
        system: 'ระบบรายงานผู้รับจ้างทำอาหาร',
        warn: 'ห้ามบอกรหัสนี้กับผู้อื่น รวมถึงเจ้าหน้าที่โรงพยาบาล หากไม่ได้กำลังเข้าระบบ กรุณาแจ้งงานโภชนาการทันที',
    },
} satisfies Record<string, OtpCard>;

const sendViaMophPrompt = async (d: OtpDelivery, text: string, card: OtpCard): Promise<void> => {
    const env = (k: (typeof MOPH_ALERT_ENV)[number]) => process.env[k]!.trim();
    const url = env('MOPH_ALERT_BASE_URL').replace(/\/+$/, '') + '/' + env('MOPH_ALERT_PATH').replace(/^\/+/, '');
    /* ไม่ใส่ชื่อผู้ใช้ในข้อความ — ใครเห็นแจ้งเตือนก็ไม่ได้ชื่อผู้ใช้ไปด้วย */
    const sub = `ใช้ได้ ${d.minutes} นาที`;

    const payload = {
        cid: [d.cid],
        message_title: card.title,
        message_html:
            `<div><p><strong>${escHtml(card.title)}</strong></p>`
            + `<p style="font-size:24px;letter-spacing:6px;"><b>${d.code}</b></p>`
            + `<p>${escHtml(sub)}</p>`
            + `<p style="color:#cc0000;">${escHtml(card.warn)}</p></div>`,
        message_text: text,
        message_type: 'HPT',
        messages: [{
            type: 'flex',
            /* ข้อความแจ้งเตือนบนหน้าจอล็อก — ไม่ใส่รหัส ต้องเปิด LINE ถึงจะเห็น (DUE ใส่ แต่เราไม่ใส่) */
            altText: card.title,
            contents: {
                type: 'bubble',
                header: {
                    type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: TEAL,
                    contents: [
                        { type: 'text', text: HOSPITAL, weight: 'bold', size: 'lg', color: '#ffffff' },
                        { type: 'text', text: card.system, size: 'xs', color: TEAL_LIGHT, margin: 'xs', wrap: true },
                    ],
                },
                body: {
                    type: 'box', layout: 'vertical', paddingAll: '20px',
                    contents: [
                        { type: 'text', text: 'รหัสยืนยันตัวตน (OTP)', weight: 'bold', size: 'md', color: TEAL_DARK },
                        {
                            type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '16px', cornerRadius: 'md', backgroundColor: TEAL_LIGHT,
                            contents: [
                                { type: 'text', text: d.code, size: 'xxl', weight: 'bold', color: TEAL, align: 'center' },
                                { type: 'text', text: sub, size: 'xs', color: '#6b7280', align: 'center', margin: 'sm', wrap: true },
                            ],
                        },
                        { type: 'text', text: card.warn, size: 'sm', color: '#cc0000', wrap: true, margin: 'lg' },
                    ],
                },
            },
        }],
    };

    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'client-key': env('MOPH_ALERT_CLIENT_ID'),
                'secret-key': env('MOPH_ALERT_SECRET_ID'),
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        console.error('[MOPH Alert] เชื่อมต่อไม่ได้:', (err as Error)?.name ?? err);
        throw new OtpSendError('เชื่อมต่อหมอพร้อมไม่ได้ กรุณาลองใหม่อีกครั้ง');
    }

    const raw = await res.text().catch(() => '');
    let parsed: { message?: unknown; message_code?: unknown } = {};
    try { parsed = JSON.parse(raw); } catch { /* ไม่ใช่ JSON */ }
    const code = Number(parsed.message_code ?? 0);
    const msg = String(parsed.message ?? '');

    if (code === 200 || (code === 0 && res.status === 200)) return;

    /* log แค่สถานะกับข้อความจากหมอพร้อม ไม่ลง body ทั้งก้อน (อาจสะท้อนเลขบัตรกลับมา) */
    console.error('[MOPH Alert] ส่ง OTP ไม่สำเร็จ:', res.status, code, msg.slice(0, 200));
    if (msg.toLowerCase().includes('cid not found')) {
        throw new OtpSendError('เลขบัตรประชาชนของบัญชีนี้ยังไม่ได้ผูก LINE หมอพร้อม กรุณาเพิ่มเพื่อน LINE หมอพร้อมและยืนยันตัวตนก่อน');
    }
    throw new OtpSendError('หมอพร้อมไม่รับคำขอส่ง OTP กรุณาลองใหม่ หรือแจ้งผู้ดูแลระบบ');
};
