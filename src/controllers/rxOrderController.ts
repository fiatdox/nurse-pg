import { Context } from 'elysia';
import { createHash, randomUUID } from 'crypto';
import { join, extname } from 'path';
import { mkdir } from 'fs/promises';
import { nurse, his } from '../db';
import type { RowDataPacket } from 'mysql2';
import { resolveActor } from '../utils/nursingRecord';
import { sanitizeHTML } from '../utils/sanitize';
import { padHn } from '../utils/hn';
import { admissionsOf, hisWardCode } from './rxHnReaderController';
import { emitRxOrder, type RxStatus } from '../realtime';

/**
 * ระบบส่งใบสั่งยาจากหอผู้ป่วยไปห้องยา
 *
 * แทนการส่งแฟกซ์ หอสแกนใบ order แล้วอัปโหลด ห้องยาเปิดดูภาพแล้วคีย์ลง HIS
 * ทุกการเปลี่ยนสถานะบันทึกว่าใครทำเมื่อไร และการเปิดดูไฟล์ก็ถูกบันทึกด้วย
 */

/** ชนิดไฟล์ที่รับ อย่างอื่นปฏิเสธตั้งแต่ต้น ไม่ใช่ไปตายตอนเปิดดู */
const ALLOWED_MIME: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
};

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;

/**
 * โฟลเดอร์เก็บไฟล์ อยู่นอกโค้ดเสมอ
 *
 * ตั้งผ่าน RX_UPLOAD_DIR ได้ เพราะบนเครื่องจริงดิสก์ที่สำรองข้อมูลมักเป็นคนละลูก
 * กับที่วางโค้ดไว้ ถ้าฝังเส้นทางไว้ในโค้ด ไฟล์ผู้ป่วยจะไปอยู่ในที่ที่ไม่มีใครสำรอง
 */
const UPLOAD_ROOT = process.env.RX_UPLOAD_DIR || join(process.cwd(), 'uploads', 'rx');

type Actor = { username: string; fullname: string };

const getActor = async (user: unknown): Promise<Actor | null> => {
    const a = await resolveActor(user);
    return a ? { username: a.username, fullname: a.fullname } : null;
};

const unauthorized = (set: Context['set']) => {
    set.status = 401;
    return { success: false, message: 'ไม่พบข้อมูลผู้ใช้' };
};

/** บันทึกประวัติ แยกฟังก์ชันเพื่อให้ไม่มีทางลืมใส่ชื่อผู้ทำ */
const logEvent = async (
    orderId: number | string,
    action: string,
    actor: Actor | null,
    detail?: Record<string, unknown>,
) => {
    await nurse`
        INSERT INTO rx_order_events (rx_order_id, action, actor, actor_name, detail)
        VALUES (${orderId}, ${action}, ${actor?.username ?? null}, ${actor?.fullname ?? null},
                ${detail ? JSON.stringify(detail) : null})
    `;
};

/* ───────────────────────── ฝั่งหอผู้ป่วย ───────────────────────── */

/**
 * ค้นผู้ป่วยจาก HIS เพื่อยืนยันว่า HN ที่กรอกมีตัวตนจริง
 *
 * อ่านอย่างเดียว และไม่บล็อกการส่งใบสั่งยาถ้า HIS ล่ม
 * ยาต้องถึงผู้ป่วยแม้ระบบค้นชื่อจะใช้ไม่ได้ชั่วคราว
 */
export const lookupRxPatient = async ({ query, set }: Context) => {
    /* เติมศูนย์หน้าให้ครบเก้าหลักก่อนค้น พยาบาลพิมพ์ 635972 ต้องเจอ 000635972 */
    const q = (query ?? {}) as { hn?: string; ward?: string };
    const hn = padHn(String(q.hn ?? ''));
    if (!/^\d{1,20}$/.test(hn)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ HN เป็นตัวเลข' };
    }

    try {
        /*
          ดูการนอนก่อน แล้วค่อยหาชื่อ ใช้กติกาเดียวกับตอนอ่านเลขจากภาพ
          พิมพ์ผิดหนึ่งหลักแทบทุกครั้งจะไปตรงกับคนไข้จริงคนอื่น (เลข HN เรียงแน่นเกือบเต็ม)
          สิ่งที่บอกได้ว่าผิดคือคนนั้นไม่ได้นอนอยู่ หน้าจอจึงต้องได้สถานะการนอนไปเตือน
        */
        const wardCode = await hisWardCode(Number(q.ward));
        const [adm, [rows]] = await Promise.all([
            admissionsOf([hn], wardCode),
            his.execute<RowDataPacket[]>(
                `SELECT hn, CONCAT(pname, fname, ' ', lname) AS ptname FROM patient WHERE hn = ? LIMIT 1`,
                [hn],
            ),
        ]);
        const row = rows[0];
        const a = adm.get(hn);
        if (!row && !a) return { success: true, found: false, data: null };

        return {
            success: true,
            found: true,
            data: {
                hn,
                ptname: row ? sanitizeHTML(String(row.ptname ?? '')) : '',
                an: a?.an ?? null,
                ward_name: a?.ward_name ?? null,
                admission: a?.admission ?? 'none',
                discharged_at: a?.discharged_at ?? null,
            },
        };
    } catch (error) {
        console.error('Lookup rx patient error:', error);
        // ไม่คืน 500 เพราะหน้าจอต้องส่งใบต่อได้ แค่ไม่มีชื่อมาช่วยยืนยัน
        return { success: true, found: false, data: null, his_down: true };
    }
};

/** หอผู้ป่วยส่งใบสั่งยา — รับไฟล์แบบ multipart */
export const createRxOrder = async ({ body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);

    const b = body as {
        ward?: string | number;
        hn?: string;
        an?: string;
        patient_name?: string;
        hn_source?: string;
        priority?: string;
        note?: string;
        /** เลขใบเดิมที่ถูกส่งกลับ มีเมื่อหอกด "ส่งอีกครั้ง" */
        resend_of?: string;
        /** 'true' = ผู้ป่วยได้รับอาหารทางสายยาง */
        tube_feed?: string;
        files?: File | File[];
    };

    const ward = Number(b.ward);
    if (!Number.isInteger(ward) || ward <= 0) {
        set.status = 400;
        return { success: false, message: 'กรุณาเลือกหอผู้ป่วย' };
    }

    const wardRows = await nurse`SELECT ward FROM ward WHERE ward = ${ward} AND is_active = 'Y'`;
    if (wardRows.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบหอผู้ป่วยนี้ หรือหอถูกปิดใช้งานแล้ว' };
    }

    const files = (Array.isArray(b.files) ? b.files : b.files ? [b.files] : [])
        .filter((f): f is File => !!f && typeof f === 'object' && 'arrayBuffer' in f);

    if (files.length === 0) {
        set.status = 400;
        return { success: false, message: 'กรุณาแนบไฟล์ใบสั่งยาอย่างน้อยหนึ่งไฟล์' };
    }
    if (files.length > MAX_FILES) {
        set.status = 400;
        return { success: false, message: `แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์ต่อหนึ่งใบ` };
    }

    for (const f of files) {
        if (!ALLOWED_MIME[f.type]) {
            set.status = 400;
            return { success: false, message: `ไฟล์ ${f.name} เป็นชนิดที่ไม่รองรับ (รับเฉพาะ PDF, JPG, PNG)` };
        }
        if (f.size > MAX_BYTES) {
            set.status = 400;
            return { success: false, message: `ไฟล์ ${f.name} ใหญ่เกิน 20 MB` };
        }
    }

    const hn = padHn(String(b.hn ?? ''));
    const an = String(b.an ?? '').trim();
    const hnSource = ['barcode', 'pdf_text', 'ocr', 'manual'].includes(String(b.hn_source))
        ? String(b.hn_source) : 'manual';
    /* ค่าที่ไม่รู้จักถือเป็นใบปกติ ไม่ใช่ปัดตก ใบต้องถึงห้องยาแม้หน้าจอส่งค่าแปลก ๆ มา */
    const priority = ['stat', 'discharge'].includes(String(b.priority))
        ? String(b.priority) : 'routine';
    /* รับเฉพาะ 'true' ที่ตั้งใจส่งมา ค่าอื่นทั้งหมดถือว่าไม่ได้ติ๊ก (multipart ส่งทุกอย่างมาเป็นข้อความ) */
    const tubeFeed = String(b.tube_feed ?? '') === 'true';

    /*
      ค้น HIS ซ้ำที่ฝั่งเซิร์ฟเวอร์ ไม่เชื่อชื่อผู้ป่วยที่ส่งมาจากหน้าเว็บ
      เพราะชื่อที่ติดไปกับใบสั่งยาคือสิ่งที่ห้องยาใช้ตรวจว่าจ่ายยาให้ถูกคน
    */
    let patientName = String(b.patient_name ?? '').trim();
    let hisVerified = false;
    if (/^\d{1,20}$/.test(hn)) {
        try {
            const [rows] = await his.execute<RowDataPacket[]>(
                `SELECT CONCAT(pname, fname, ' ', lname) AS ptname FROM patient WHERE hn = ? LIMIT 1`,
                [hn],
            );
            if (rows[0]) {
                patientName = (sanitizeHTML(String(rows[0].ptname ?? '')) ?? '').trim();
                hisVerified = true;
            }
        } catch (error) {
            // HIS ล่มไม่ใช่เหตุให้ยาไปไม่ถึงผู้ป่วย บันทึกไว้ว่ายืนยันไม่ได้แล้วไปต่อ
            console.error('HIS verify on submit failed:', error);
        }
    }

    /*
      ส่งซ้ำหลังถูกส่งกลับ

      ตรวจที่เซิร์ฟเวอร์ว่าใบเดิมมีจริง เป็นใบที่ถูกส่งกลับ และเป็นของหอเดียวกัน
      ไม่เชื่อเลขที่ส่งมาจากหน้าจอ เพราะเลขใบเดาได้ ถ้าไม่ตรวจ หอหนึ่งจะปิดใบของอีกหอได้
      เงื่อนไขไม่ผ่าน = ไม่ปัดใบทิ้ง แต่รับเป็นใบใหม่ธรรมดา ยาต้องถึงห้องยาไว้ก่อนเสมอ
    */
    const resendRaw = Number(String(b.resend_of ?? '').trim());
    let resendOf: number | null = null;
    if (Number.isInteger(resendRaw) && resendRaw > 0) {
        const prev = await nurse`
            SELECT rx_order_id FROM rx_orders
            WHERE rx_order_id = ${resendRaw} AND ward = ${ward} AND status = 'rejected'
            LIMIT 1
        `;
        if (prev.length > 0) resendOf = resendRaw;
    }

    try {
        await mkdir(UPLOAD_ROOT, { recursive: true });

        const inserted = await nurse`
            INSERT INTO rx_orders (ward, hn, an, hn_source, patient_name, his_verified,
                                   priority, note, submitted_by, submitted_by_name, resend_of, tube_feed)
            VALUES (${ward}, ${hn || null}, ${an || null}, ${hnSource},
                    ${patientName || null}, ${hisVerified}, ${priority},
                    ${String(b.note ?? '').trim() || null},
                    ${actor.username}, ${actor.fullname}, ${resendOf}, ${tubeFeed})
            RETURNING rx_order_id
        `;
        const orderId = inserted[0].rx_order_id as string;

        /* เตือนเมื่อไฟล์เดิมถูกส่งมาแล้วภายในหนึ่งวัน ไม่บล็อก เพราะบางครั้งต้องส่งซ้ำจริง */
        const duplicates: string[] = [];
        let fileNo = 0;

        for (const f of files) {
            fileNo += 1;
            const buf = Buffer.from(await f.arrayBuffer());
            const sha = createHash('sha256').update(buf).digest('hex');

            const dup = await nurse`
                SELECT rx_order_id FROM rx_order_files
                WHERE sha256 = ${sha} AND uploaded_at > now() - interval '24 hours'
                LIMIT 1
            `;
            if (dup.length > 0) duplicates.push(f.name);

            const ext = ALLOWED_MIME[f.type] || extname(f.name) || '.bin';
            /*
              ตั้งชื่อไฟล์เป็น uuid ไม่ใช้ชื่อเดิมของผู้ใช้หรือเลขใบ
              ชื่อเดิมซ้ำกันได้ง่ายมาก เครื่องสแกนตั้งชื่อตามวันที่เหมือนกันทุกเครื่อง
              และถ้าเอาฐานข้อมูลจากที่อื่นมาคืนทับ เลขใบจะชนกันจนไฟล์ทับกันเงียบ ๆ
              ชื่อจริงของไฟล์ยังเก็บไว้ในคอลัมน์ original_name ไม่ได้หายไปไหน
            */
            const stored = join(UPLOAD_ROOT, `${randomUUID()}${ext}`);
            await Bun.write(stored, buf);

            await nurse`
                INSERT INTO rx_order_files (rx_order_id, file_no, original_name, stored_path,
                                            mime_type, byte_size, sha256)
                VALUES (${orderId}, ${fileNo}, ${(sanitizeHTML(f.name) ?? '').slice(0, 255)}, ${stored},
                        ${f.type}, ${buf.length}, ${sha})
            `;
        }

        await logEvent(orderId, 'submit', actor, {
            ward, files: fileNo, priority, resend_of: resendOf, tube_feed: tubeFeed,
        });

        /*
          ส่งฉบับแก้แล้ว ใบเดิมก็หมดหน้าที่ ปิดให้เองตรงนี้
          ถ้าให้คนไปกดปิดเองอีกทีหนึ่ง ใบที่ถูกตีกลับจะค้างบนจอห้องยาจนกว่าจะมีคนนึกได้
          ซึ่งแปลว่าห้องยาเห็นใบเดิมกับฉบับแก้พร้อมกัน แล้วต้องมานั่งเดาว่าอันไหนของจริง
        */
        if (resendOf !== null) {
            const closed = await nurse`
                UPDATE rx_orders
                SET status = 'closed', closed_by = ${actor.username},
                    closed_by_name = ${actor.fullname}, closed_at = now()
                WHERE rx_order_id = ${resendOf} AND status = 'rejected'
                RETURNING ward
            `;
            if (closed.length > 0) {
                await logEvent(resendOf, 'close', actor, { reason: 'ส่งฉบับแก้แล้ว', new_order: orderId });
                emitRxOrder('order:status', {
                    rx_order_id: String(resendOf), ward: Number(closed[0].ward), status: 'closed',
                    priority: priority as 'routine' | 'discharge' | 'stat',
                    by_name: actor.fullname, at: new Date().toISOString(),
                });
            }
        }

        /* สะกิดห้องยาทันที หน้าจอจะไปดึงรายการจริงผ่าน REST เอง */
        emitRxOrder('order:new', {
            rx_order_id: String(orderId), ward, status: 'submitted',
            priority: priority as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname, at: new Date().toISOString(),
        });

        return {
            success: true,
            data: { rx_order_id: orderId, duplicates },
            message: duplicates.length > 0
                ? `ส่งแล้ว แต่พบว่าไฟล์ ${duplicates.join(', ')} เคยถูกส่งภายใน 24 ชั่วโมงที่ผ่านมา`
                : 'ส่งใบสั่งยาให้ห้องยาแล้ว',
        };
    } catch (error) {
        console.error('Create rx order error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกใบสั่งยาไม่สำเร็จ' };
    }
};

/* ───────────────────────── รายการ / รายละเอียด ───────────────────────── */

/**
 * รายการใบสั่งยา
 *
 * ฝั่งหอส่ง ward มาเพื่อดูของตัวเอง ฝั่งห้องยาไม่ส่ง ward จะได้เห็นทุกหอ
 * เรียง stat ขึ้นก่อนเสมอ แล้วค่อยเรียงตามเวลาที่ส่ง
 */
export const listRxOrders = async ({ query, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);

    const q = query as {
        ward?: string; wards?: string; status?: string; date?: string; from?: string; to?: string;
        hn?: string; priorities?: string;
    } | undefined;
    const ward = q?.ward ? Number(q.ward) : null;
    /*
      ห้องยาแบ่งกันรับตามตึก เครื่องหนึ่งจึงต้องเลือกได้หลายตึกพร้อมกัน
      ส่งมาเป็นเลขคั่นจุลภาค ไม่ส่งมาเลย = เห็นทุกตึก
      กรองค่าที่ไม่ใช่จำนวนเต็มทิ้ง ไม่ปล่อยให้ค่าขยะกลายเป็นส่วนหนึ่งของคิวรี
    */
    const wards = String(q?.wards ?? '')
        .split(',')
        .map(v => Number(v.trim()))
        .filter(v => Number.isInteger(v) && v > 0);
    const wardArr = wards.length > 0 ? wards : null;
    const status = q?.status
        && ['submitted', 'acknowledged', 'completed', 'prepared',
            'picked_up', 'rejected', 'closed'].includes(q.status)
        ? q.status : null;

    /*
      เครื่องห้องยาแบ่งงานตามความด่วนได้ด้วย ไม่ใช่แค่ตามตึก
      เช่น เครื่องหนึ่งรับเฉพาะ STAT อีกเครื่องรับเฉพาะยากลับบ้าน
      กรองที่ฐานข้อมูลไม่ใช่ที่หน้าจอ ใบของคนอื่นจะได้ไม่ต้องเดินทางมาถึงเครื่องนี้เลย
    */
    const prios = String(q?.priorities ?? '')
        .split(',')
        .map(v => v.trim())
        .filter(v => ['routine', 'discharge', 'stat'].includes(v));
    const prioArr = prios.length > 0 && prios.length < 3 ? prios : null;

    /*
      ค้นด้วย HN เอาเฉพาะตัวเลข คนพิมพ์ขีดหรือเว้นวรรคมาก็ยังหาเจอ
      ใช้ LIKE ครอบหัวท้าย เพราะ HN ในฐานเก็บเต็ม 9 หลัก แต่คนพิมพ์เลขที่เห็นบนใบ
      ซึ่งมักไม่มีศูนย์นำหน้า (635972 ต้องหา 000635972 เจอ)
    */
    const hnDigits = String(q?.hn ?? '').replace(/\D/g, '').slice(0, 20);
    const hnLike = hnDigits.length >= 3 ? `%${hnDigits}%` : null;

    const date = q?.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null;

    /*
      ช่วงเวลาที่ส่งใบ ใช้ดูย้อนหลังทีละเวร
      รับเป็นเวลาท้องถิ่นตรง ๆ ไม่แปลงเขตเวลา เพราะ submitted_at เก็บเป็นเวลาท้องถิ่นอยู่แล้ว
      ถ้าแปลงเป็น UTC ตรงนี้ เวรดึกจะข้ามไปคนละวันทันที
    */
    const stamp = (v?: string): string | null => {
        const raw = String(v ?? '').trim().replace('T', ' ');
        return /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(raw) ? raw : null;
    };
    const from = stamp(q?.from);
    const to = stamp(q?.to);

    /*
      ต่อเงื่อนไขเฉพาะตอนมีค่า ไม่ใช้ทรง (${x} IS NULL OR ...) เหมือนตัวกรองอื่นข้างล่าง
      เพราะพารามิเตอร์ที่เป็น null ในตำแหน่งนี้ทำให้ PG หาชนิดข้อมูลไม่เจอ
      (could not determine data type of parameter) ไม่ส่งพารามิเตอร์ไปเลยจึงไม่มีอะไรให้เดา

      และต้องแปลงผ่าน ::text ก่อนเสมอ ถ้าเขียน ${from}::timestamp ตรง ๆ
      ค่าจะถูกเลื่อนไป 7 ชั่วโมงตามเขตเวลา (ตรวจแล้ว: ส่ง 08:00 เข้าไป PG ได้ 01:00)
      เพราะไดรเวอร์ประกาศชนิดพารามิเตอร์เป็นชนิดที่มีเขตเวลา แล้ว PG แปลงให้อีกชั้น
      การบังคับเป็น text ก่อนทำให้ PG อ่านเป็นเวลาหน้าปัดตรง ๆ ไม่คิดเขตเวลา
    */
    /*
      ค้น HN แล้วข้ามตัวกรองวันและเวรทิ้งทั้งหมด

      คนที่พิมพ์ HN คือคนที่กำลังตอบคำถาม "ใบของคนนี้ไปถึงไหนแล้ว"
      ซึ่งคำตอบมักอยู่คนละเวรกับที่เปิดค้างไว้ ถ้ายังกรองวันอยู่จะได้ตารางว่าง
      แล้วคนจะเชื่อว่าไม่เคยส่งใบนั้น ทั้งที่ใบอยู่ในระบบ
    */
    const fromCond = from && !hnLike ? nurse`AND o.submitted_at >= ${from}::text::timestamp` : nurse``;
    /* ขอบบนไม่รวม ส่งช่วง 08:00-16:00 ต่อกับ 16:00-24:00 แล้วใบเวลา 16:00 ต้องไม่นับสองรอบ */
    const toCond = to && !hnLike ? nurse`AND o.submitted_at < ${to}::text::timestamp` : nurse``;
    const dateCond = date && !hnLike ? nurse`AND o.submitted_at::date = ${date}::date` : nurse``;
    const hnCond = hnLike ? nurse`AND o.hn LIKE ${hnLike}` : nurse``;
    const prioCond = prioArr ? nurse`AND o.priority = ANY(${prioArr}::varchar[])` : nurse``;

    try {
        const rows = await nurse`
            SELECT o.rx_order_id, o.ward, w.ward_name, o.hn, o.an, o.patient_name,
                   o.hn_source, o.his_verified, o.priority, o.status, o.note, o.reject_reason,
                   o.submitted_by_name, TO_CHAR(o.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at,
                   o.ack_by_name,       TO_CHAR(o.ack_at,       'YYYY-MM-DD HH24:MI') AS ack_at,
                   o.completed_by_name, TO_CHAR(o.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at,
                   o.prepared_by_name,  TO_CHAR(o.prepared_at,  'YYYY-MM-DD HH24:MI') AS prepared_at,
                   o.closed_by_name,    TO_CHAR(o.closed_at,    'YYYY-MM-DD HH24:MI') AS closed_at,
                   o.resend_of, o.tube_feed,
                   o.rejected_by_name,  TO_CHAR(o.rejected_at,  'YYYY-MM-DD HH24:MI') AS rejected_at,
                   (SELECT COUNT(*)::int FROM rx_order_files f WHERE f.rx_order_id = o.rx_order_id) AS file_count,
                   EXTRACT(EPOCH FROM (now() - o.submitted_at))::int AS waiting_seconds
            FROM rx_orders o
            LEFT JOIN ward w ON w.ward = o.ward
            WHERE (${ward}::smallint IS NULL OR o.ward = ${ward})
              AND (${wardArr}::smallint[] IS NULL OR o.ward = ANY(${wardArr}::smallint[]))
              AND (${status}::varchar IS NULL OR o.status = ${status})
              ${dateCond}
              ${fromCond}
              ${toCond}
              ${hnCond}
              ${prioCond}
            ORDER BY
                /* ยังไม่ปิดงานอยู่บนสุด ตามด้วยด่วน แล้วค่อยเก่าก่อน */
                CASE WHEN o.status IN ('submitted', 'acknowledged') THEN 0 ELSE 1 END,
                /* ฉุกเฉินก่อน แล้วยากลับบ้านที่มีคนนั่งรออยู่ แล้วค่อยใบปกติ */
                CASE o.priority WHEN 'stat' THEN 0 WHEN 'discharge' THEN 1 ELSE 2 END,
                o.submitted_at ASC
            LIMIT 500
        `;
        return { success: true, data: rows };
    } catch (error) {
        console.error('List rx orders error:', error);
        set.status = 500;
        return { success: false, message: 'ดึงรายการไม่สำเร็จ' };
    }
};

export const getRxOrder = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);

    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) {
        set.status = 400;
        return { success: false, message: 'เลขที่ใบสั่งยาไม่ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT o.*, w.ward_name,
                   TO_CHAR(o.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at_text,
                   /* ใบก่อนหน้าถูกตีกลับเพราะอะไร ห้องยาต้องรู้เพื่อจะได้ตรวจจุดนั้นก่อน */
                   prev.reject_reason AS prev_reject_reason,
                   TO_CHAR(prev.rejected_at, 'DD/MM/YYYY HH24:MI') AS prev_rejected_at
            FROM rx_orders o
            LEFT JOIN ward w ON w.ward = o.ward
            LEFT JOIN rx_orders prev ON prev.rx_order_id = o.resend_of
            WHERE o.rx_order_id = ${id}
        `;
        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบใบสั่งยานี้' };
        }

        const files = await nurse`
            SELECT rx_file_id, file_no, original_name, mime_type, byte_size
            FROM rx_order_files WHERE rx_order_id = ${id} ORDER BY file_no
        `;
        const events = await nurse`
            SELECT action, actor_name, TO_CHAR(at, 'DD/MM/YYYY HH24:MI') AS at, detail
            FROM rx_order_events WHERE rx_order_id = ${id} ORDER BY at
        `;

        return { success: true, data: { ...rows[0], files, events } };
    } catch (error) {
        console.error('Get rx order error:', error);
        set.status = 500;
        return { success: false, message: 'ดึงข้อมูลไม่สำเร็จ' };
    }
};

/** ส่งไฟล์ให้ผู้ใช้ดู พร้อมบันทึกว่าใครเปิดดู */
export const getRxOrderFile = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);

    const p = params as { id?: string; fileId?: string };
    const id = Number(p.id);
    const fileId = Number(p.fileId);
    if (!Number.isInteger(id) || !Number.isInteger(fileId)) {
        set.status = 400;
        return { success: false, message: 'พารามิเตอร์ไม่ถูกต้อง' };
    }

    try {
        /* ผูกกับ rx_order_id ด้วย ไม่ให้เดาเลขไฟล์แล้วดึงไฟล์ของใบอื่นได้ */
        const rows = await nurse`
            SELECT stored_path, mime_type, original_name
            FROM rx_order_files WHERE rx_file_id = ${fileId} AND rx_order_id = ${id}
        `;
        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบไฟล์' };
        }

        const f = Bun.file(String(rows[0].stored_path));
        if (!(await f.exists())) {
            set.status = 404;
            return { success: false, message: 'ไฟล์หายไปจากที่จัดเก็บ' };
        }

        await logEvent(id, 'view_file', actor, { rx_file_id: fileId });

        set.headers['Content-Type'] = String(rows[0].mime_type);
        /* inline เพื่อให้เปิดดูในหน้าเว็บได้เลย ห้องยาไม่ต้องดาวน์โหลดไฟล์ผู้ป่วยลงเครื่อง */
        set.headers['Content-Disposition'] = 'inline';
        set.headers['Cache-Control'] = 'private, no-store';
        return f;
    } catch (error) {
        console.error('Get rx order file error:', error);
        set.status = 500;
        return { success: false, message: 'เปิดไฟล์ไม่สำเร็จ' };
    }
};

/* ───────────────────────── ฝั่งห้องยา ───────────────────────── */

/**
 * เปลี่ยนสถานะแบบกันทำซ้ำ
 *
 * เงื่อนไข status เดิมอยู่ใน WHERE ของ UPDATE ไม่ใช่อ่านมาตรวจแล้วค่อยเขียน
 * เพราะสองเครื่องกดพร้อมกันได้ ถ้าตรวจแยกจากเขียน ทั้งคู่จะผ่านการตรวจแล้วเขียนทับกัน
 * แบบนี้ฐานข้อมูลเป็นคนตัดสิน คนที่สองจะไม่ได้แถวกลับมาแล้วได้ 409
 */
const transition = async (
    id: number,
    from: string[],
    set: Context['set'],
    actor: Actor,
    apply: () => Promise<Record<string, unknown>[]>,
    action: string,
    detail?: Record<string, unknown>,
) => {
    const rows = await apply();
    if (rows.length === 0) {
        const cur = await nurse`SELECT status, ack_by_name FROM rx_orders WHERE rx_order_id = ${id}`;
        set.status = cur.length === 0 ? 404 : 409;
        return {
            success: false,
            message: cur.length === 0
                ? 'ไม่พบใบสั่งยานี้'
                : `ใบนี้ถูกดำเนินการไปแล้ว (สถานะปัจจุบัน: ${cur[0].status}` +
                  (cur[0].ack_by_name ? ` โดย ${cur[0].ack_by_name}` : '') + ')',
            current_status: cur[0]?.status ?? null,
        };
    }
    await logEvent(id, action, actor, detail);

    /*
      อ่านตึกกับความด่วนกลับมาเพื่อส่งไปกับสัญญาณ
      ต้องรู้ตึกถึงจะส่งเข้าห้องของหอที่ส่งใบมาได้ ไม่งั้นหอจะไม่รู้ว่าใบตัวเองถูกรับแล้ว
    */
    const meta = await nurse`SELECT ward, priority, status FROM rx_orders WHERE rx_order_id = ${id}`;
    if (meta[0]) {
        emitRxOrder('order:status', {
            rx_order_id: String(id),
            ward: Number(meta[0].ward),
            status: String(meta[0].status) as RxStatus,
            priority: String(meta[0].priority) as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname,
            at: new Date().toISOString(),
            reason: typeof detail?.reason === 'string' ? detail.reason : undefined,
        });
    }

    return { success: true, data: rows[0] };
};

export const ackRxOrder = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    try {
        return await transition(id, ['submitted'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'acknowledged', ack_by = ${actor.username},
                ack_by_name = ${actor.fullname}, ack_at = now()
            WHERE rx_order_id = ${id} AND status = 'submitted'
            RETURNING rx_order_id, status, ack_by_name
        ` as unknown as Promise<Record<string, unknown>[]>, 'ack');
    } catch (error) {
        console.error('Ack rx order error:', error);
        set.status = 500;
        return { success: false, message: 'รับใบสั่งยาไม่สำเร็จ' };
    }
};

export const completeRxOrder = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    try {
        return await transition(id, ['acknowledged'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'completed', completed_by = ${actor.username},
                completed_by_name = ${actor.fullname}, completed_at = now()
            WHERE rx_order_id = ${id} AND status = 'acknowledged'
            RETURNING rx_order_id, status, completed_by_name
        ` as unknown as Promise<Record<string, unknown>[]>, 'complete');
    } catch (error) {
        console.error('Complete rx order error:', error);
        set.status = 500;
        return { success: false, message: 'ปิดงานไม่สำเร็จ' };
    }
};

/**
 * จัดยาเสร็จ พร้อมให้หอมารับ
 *
 * รับได้ทั้งจาก 'acknowledged' และ 'completed' ไม่บังคับให้กดคีย์เสร็จก่อน
 * เพราะลำดับจริงที่หน้าเคาน์เตอร์สลับกันได้ บางใบจัดยาก่อนแล้วค่อยคีย์
 * ถ้าบังคับลำดับ คนจะกดคีย์เสร็จทั้งที่ยังไม่ได้คีย์ เพื่อให้กดปุ่มถัดไปได้
 * แล้วสถานะ "คีย์เสร็จ" จะเชื่อไม่ได้อีกเลย
 */
export const prepareRxOrder = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    try {
        return await transition(id, ['acknowledged', 'completed'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'prepared', prepared_by = ${actor.username},
                prepared_by_name = ${actor.fullname}, prepared_at = now()
            WHERE rx_order_id = ${id} AND status IN ('acknowledged', 'completed')
            RETURNING rx_order_id, status, prepared_by_name
        ` as unknown as Promise<Record<string, unknown>[]>, 'prepare');
    } catch (error) {
        console.error('Prepare rx order error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกว่าจัดยาเสร็จไม่สำเร็จ' };
    }
};

/**
 * ตึกมารับยาแล้ว = ส่งมอบเสร็จ ใบออกจากหน้าจอ
 *
 * กดได้จาก 'prepared' เท่านั้น ใบที่ยังไม่จัดยาเสร็จจะมารับไม่ได้อยู่แล้ว
 * ถ้าปล่อยให้กดข้ามขั้นได้ สถานะ "จัดยาเสร็จ" จะหายไปจากประวัติของใบที่ส่งมอบเร็ว
 * แล้วจะตอบไม่ได้ว่ายาใบนั้นถูกจัดเมื่อไหร่
 */
export const pickupRxOrder = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    try {
        return await transition(id, ['prepared'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'picked_up', closed_by = ${actor.username},
                closed_by_name = ${actor.fullname}, closed_at = now()
            WHERE rx_order_id = ${id} AND status = 'prepared'
            RETURNING rx_order_id, status, closed_by_name
        ` as unknown as Promise<Record<string, unknown>[]>, 'pickup');
    } catch (error) {
        console.error('Pickup rx order error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกการรับยาไม่สำเร็จ' };
    }
};

/**
 * ปิดเรื่องใบที่ส่งกลับ
 *
 * ใบที่ส่งกลับไม่มีขั้นต่อในระบบ เพราะหอแก้แล้วส่งมาเป็นใบใหม่
 * ใบเดิมจึงค้างบนจอทั้งสองฝั่งโดยไม่มีใครต้องทำอะไรกับมันอีก
 * ปุ่มนี้คือการบอกว่า "จัดการแล้ว" ให้มันออกจากคิวไป ไม่ได้ลบ ยังค้นเจอด้วย HN
 * ทั้งห้องยาและหอกดได้ เพราะรู้พร้อมกันทั้งคู่ว่าเรื่องจบแล้ว
 */
export const closeRxOrder = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    try {
        return await transition(id, ['rejected'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'closed', closed_by = ${actor.username},
                closed_by_name = ${actor.fullname}, closed_at = now()
            WHERE rx_order_id = ${id} AND status = 'rejected'
            RETURNING rx_order_id, status, closed_by_name
        ` as unknown as Promise<Record<string, unknown>[]>, 'close');
    } catch (error) {
        console.error('Close rx order error:', error);
        set.status = 500;
        return { success: false, message: 'ปิดเรื่องไม่สำเร็จ' };
    }
};

export const rejectRxOrder = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const reason = String((body as { reason?: string } | undefined)?.reason ?? '').trim();
    /* บังคับเหตุผล เพราะหอต้องรู้ว่าต้องแก้อะไรถึงจะส่งใหม่ได้ ไม่ใช่เดาเอง */
    if (reason.length < 3) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุเหตุผลที่ส่งกลับ' };
    }

    try {
        return await transition(id, ['submitted', 'acknowledged'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'rejected', rejected_by = ${actor.username},
                rejected_by_name = ${actor.fullname}, rejected_at = now(),
                reject_reason = ${(sanitizeHTML(reason) ?? '').slice(0, 500)}
            WHERE rx_order_id = ${id} AND status IN ('submitted', 'acknowledged')
            RETURNING rx_order_id, status, rejected_by_name
        ` as unknown as Promise<Record<string, unknown>[]>, 'reject', { reason });
    } catch (error) {
        console.error('Reject rx order error:', error);
        set.status = 500;
        return { success: false, message: 'ส่งกลับไม่สำเร็จ' };
    }
};
