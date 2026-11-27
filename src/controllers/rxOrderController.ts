import { findActiveRejectCategory } from './rxRejectCategoryController';
import { Context } from 'elysia';
import { createHash, randomUUID } from 'crypto';
import { join, extname } from 'path';
import { mkdir, unlink } from 'fs/promises';
import { nurse, his } from '../db';
import type { RowDataPacket } from 'mysql2';
import { resolveActor } from '../utils/nursingRecord';
import { sanitizeHTML } from '../utils/sanitize';
import { padHn, HN_LENGTH } from '../utils/hn';
import { admissionsOf, hisWardCode } from './rxHnReaderController';
import { retentionDays } from './rxRetentionController';
import { emitRxOrder, type RxStatus } from '../realtime';
import { isAdmin } from './systemSettingsController';
import { resolveGroups } from '../utils/userGroup';

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

/* ───────────────────────── ตรวจว่าผู้ป่วยอยู่ตึกนี้ ───────────────────────── */

type WardCheck =
    | { ok: true; verified: true; ptname: string; an: string | null }
    /* HIS ล่ม: ยอมให้ผ่านเหมือนเดิม ยาต้องถึงผู้ป่วย ห้องยาจะเห็นว่ายังไม่ได้ยืนยัน */
    | { ok: true; verified: false; ptname: ''; an: null }
    | { ok: false; status: number; message: string };

/**
 * HN นี้ส่งใบจากตึกนี้ได้ไหม
 *
 * พบว่ามีการใส่ HN มั่ว (เช่นศูนย์ล้วน หรือเลขของคนอื่น) เพื่อให้ผ่านช่องบังคับ HN
 * จึงยอมรับเฉพาะผู้ป่วยที่นอนอยู่ตึกที่เลือก หรือเพิ่งจำหน่ายจากตึกนี้ (ยากลับบ้าน)
 * HN ที่ไม่มีในทะเบียนเลย ไม่ได้นอน หรือนอนตึกอื่น ปฏิเสธทั้งหมด
 */
const checkPatientInWard = async (hn: string, ward: number): Promise<WardCheck> => {
    if (/^0+$/.test(hn)) return { ok: false, status: 400, message: 'HN ไม่ถูกต้อง' };
    const wardCode = await hisWardCode(ward);
    if (!wardCode) {
        return { ok: false, status: 400, message: 'ตึกนี้ยังไม่ได้ผูกรหัสตึกกับ HIS ตรวจผู้ป่วยไม่ได้ กรุณาแจ้งผู้ดูแลระบบ' };
    }
    let adm: Awaited<ReturnType<typeof admissionsOf>>;
    let name: string | undefined;
    try {
        const [a, [rows]] = await Promise.all([
            admissionsOf([hn], wardCode),
            his.execute<RowDataPacket[]>(
                `SELECT CONCAT(pname, fname, ' ', lname) AS ptname FROM patient WHERE hn = ? LIMIT 1`, [hn]),
        ]);
        adm = a;
        name = rows[0] ? (sanitizeHTML(String(rows[0].ptname ?? '')) ?? '').trim() : undefined;
    } catch (error) {
        console.error('HIS ward check failed:', error);
        return { ok: true, verified: false, ptname: '', an: null };
    }
    const a = adm.get(hn);
    if (a?.in_ward) return { ok: true, verified: true, ptname: name ?? '', an: a.an };

    const why = !a && name === undefined ? `ไม่พบ HN ${hn} ใน HIS`
        : a?.admission === 'admitted' ? `HN ${hn} นอนอยู่ที่${a.ward_name ? ` ${a.ward_name}` : 'ตึกอื่น'} ไม่ใช่ตึกที่เลือก`
        : a?.admission === 'admitted_here' ? `HN ${hn} ไม่ได้นอนอยู่ที่ตึกนี้`
        : a?.admission === 'discharged' ? `HN ${hn} จำหน่ายแล้ว (${a.discharged_at ?? '-'}) หรือไม่ได้จำหน่ายจากตึกนี้`
        : `HN ${hn} ไม่ได้นอนโรงพยาบาลอยู่`;
    return { ok: false, status: 400, message: `${why} · ส่งได้เฉพาะผู้ป่วยที่นอนอยู่ตึกที่เลือกเท่านั้น` };
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
                bedno: a?.bedno ?? null,
                ward_name: a?.ward_name ?? null,
                admission: a?.admission ?? 'none',
                discharged_at: a?.discharged_at ?? null,
                in_ward: a?.in_ward ?? false,
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
    /*
      ทุกใบต้องมี HN — หน้าจอบังคับไว้แล้ว ตรวจซ้ำที่นี่เพราะเรียก API ตรงได้
      ใบที่ไม่มี HN ห้องยาต้องอ่านเลขจากภาพเอง ซึ่งเป็นจุดที่จ่ายยาผิดคนได้ง่ายที่สุด
      HIS ล่มยังส่งได้ (พิมพ์ HN เอง) แค่ his_verified เป็น false
    */
    if (!new RegExp(`^\\d{${HN_LENGTH}}$`).test(hn)) {
        set.status = 400;
        return { success: false, message: `กรุณาระบุ HN ของใบสั่งยา (ตัวเลขไม่เกิน ${HN_LENGTH} หลัก)` };
    }
    const check = await checkPatientInWard(hn, ward);
    if (!check.ok) {
        set.status = check.status;
        return { success: false, message: check.message };
    }
    /* AN จาก HIS ชนะ AN ที่หน้าจอส่งมา ยกเว้นตอน HIS ล่มซึ่งไม่มีอะไรให้เทียบ */
    const an = (check.verified ? check.an ?? '' : String(b.an ?? '')).trim();
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
    const patientName = check.verified
        ? check.ptname
        : (sanitizeHTML(String(b.patient_name ?? '').trim()) ?? '').slice(0, 200);
    const hisVerified = check.verified;

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
                    ${(sanitizeHTML(String(b.note ?? '').trim()) ?? '').slice(0, 300) || null},
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
/**
 * เติมเตียงปัจจุบันจาก HIS (iptadm.bedno ตาม AN) ให้รายการใบสั่งยา
 * ไม่เก็บเตียงไว้กับใบ เพราะผู้ป่วยย้ายเตียงได้ คนเดินไปส่งยา/รับยาต้องรู้เตียงที่นอนอยู่ตอนนี้
 * ถามครั้งเดียวต่อหนึ่งรายการ (AN ไม่ซ้ำ ไม่เกิน 500) · HIS ล่มก็คืนรายการได้ตามปกติ แค่ไม่มีเตียง
 */
const withBeds = async <T extends Record<string, unknown>>(rows: T[]): Promise<(T & { bedno: string | null })[]> => {
    const ans = [...new Set(rows.map(r => r.an).filter((a): a is string => typeof a === 'string' && a.length > 0))];
    const beds = new Map<string, string>();
    if (ans.length > 0) {
        try {
            const [bedRows] = await his.execute<RowDataPacket[]>(
                `SELECT an, bedno FROM iptadm WHERE an IN (${ans.map(() => '?').join(',')})`, ans);
            for (const r of bedRows) {
                const bed = r.bedno ? (sanitizeHTML(String(r.bedno)) ?? '').trim() : '';
                if (bed) beds.set(String(r.an), bed);
            }
        } catch (error) {
            console.error('Rx order beds lookup failed:', error);
        }
    }
    return rows.map(r => ({ ...r, bedno: typeof r.an === 'string' ? beds.get(r.an) ?? null : null }));
};

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
                   o.hn_source, o.his_verified, o.priority, o.status, o.note, o.reject_reason, o.reject_category, rc.label AS reject_category_label,
                   o.submitted_by_name, TO_CHAR(o.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at,
                   o.ack_by_name,       TO_CHAR(o.ack_at,       'YYYY-MM-DD HH24:MI') AS ack_at,
                   o.completed_by_name, TO_CHAR(o.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at,
                   o.prepared_by_name,  TO_CHAR(o.prepared_at,  'YYYY-MM-DD HH24:MI') AS prepared_at,
                   TO_CHAR(o.pickup_from, 'YYYY-MM-DD HH24:MI') AS pickup_from,
                   TO_CHAR(o.pickup_to,   'YYYY-MM-DD HH24:MI') AS pickup_to,
                   o.closed_by_name,    TO_CHAR(o.closed_at,    'YYYY-MM-DD HH24:MI') AS closed_at,
                   o.resend_of, o.tube_feed,
                   o.rejected_by_name,  TO_CHAR(o.rejected_at,  'YYYY-MM-DD HH24:MI') AS rejected_at,
                   (SELECT COUNT(*)::int FROM rx_order_files f WHERE f.rx_order_id = o.rx_order_id) AS file_count,
                   /* ไฟล์ภาพถูกลบตามกำหนดแล้วทุกไฟล์ หน้าจอใช้ติดป้ายบอกก่อนเปิดใบ */
                   NOT EXISTS (SELECT 1 FROM rx_order_files f
                               WHERE f.rx_order_id = o.rx_order_id AND f.purged_at IS NULL) AS files_purged,
                   EXTRACT(EPOCH FROM (now() - o.submitted_at))::int AS waiting_seconds,
                   /* การปรึกษาแพทย์ครั้งล่าสุด ให้ทั้งหอและห้องยาเห็นจากรายการโดยไม่ต้องเปิดใบ */
                   c.consult_at, c.consult_note, c.consult_by_name, COALESCE(c.consult_count, 0) AS consult_count,
                   /*
                     หอย้ายตึกของใบหลังส่ง (ครั้งล่าสุด) — ห้องยาเห็นป้าย "ย้ายจาก ..." จะได้จัดยาเข้าช่องของตึกใหม่
                     ward_move_pending = ห้องยายังไม่กดรับทราบการย้ายครั้งนี้ (ack_ward หลังเวลาย้าย)
                   */
                   mv.d ->> 'from_name' AS moved_from_name,
                   mv.d ->> 'note'      AS moved_note,
                   mv.actor_name        AS moved_by_name,
                   TO_CHAR(mv.at, 'YYYY-MM-DD HH24:MI') AS moved_at,
                   (mv.at IS NOT NULL AND NOT mv.acked) AS ward_move_pending,
                   mv.ack_by_name       AS ward_ack_by_name
            FROM rx_orders o
            LEFT JOIN ward w ON w.ward = o.ward
            LEFT JOIN rx_reject_categories rc ON rc.code = o.reject_category
            LEFT JOIN LATERAL (
                SELECT d.detail ->> 'consulted_at' AS consult_at,
                       d.detail ->> 'note'         AS consult_note,
                       d.actor_name                AS consult_by_name,
                       COUNT(*) OVER ()::int       AS consult_count
                FROM (
                    /* logEvent เก็บเป็นสตริง JSON ซ้อนใน jsonb แกะออกก่อนอ่านฟิลด์ */
                    SELECT e.at, e.actor_name,
                           CASE WHEN jsonb_typeof(e.detail) = 'string' THEN (e.detail #>> '{}')::jsonb
                                ELSE e.detail END AS detail
                    FROM rx_order_events e
                    WHERE e.rx_order_id = o.rx_order_id AND e.action = 'consult'
                ) d
                ORDER BY d.detail ->> 'consulted_at' DESC, d.at DESC
                LIMIT 1
            ) c ON true
            LEFT JOIN LATERAL (
                SELECT CASE WHEN jsonb_typeof(e.detail) = 'string' THEN (e.detail #>> '{}')::jsonb
                            ELSE e.detail END AS d,
                       e.at, e.actor_name, a.actor_name AS ack_by_name, a.at IS NOT NULL AS acked
                FROM rx_order_events e
                LEFT JOIN LATERAL (
                    SELECT x.actor_name, x.at FROM rx_order_events x
                    WHERE x.rx_order_id = o.rx_order_id AND x.action = 'ack_ward' AND x.at >= e.at
                    ORDER BY x.at LIMIT 1
                ) a ON true
                WHERE e.rx_order_id = o.rx_order_id AND e.action = 'change_ward'
                ORDER BY e.at DESC LIMIT 1
            ) mv ON true
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
        return { success: true, data: await withBeds(rows as Record<string, unknown>[]) };
    } catch (error) {
        console.error('List rx orders error:', error);
        set.status = 500;
        return { success: false, message: 'ดึงรายการไม่สำเร็จ' };
    }
};

/**
 * ประวัติแพ้ยาจาก HIS (opd_allergy) ของ HN นี้ — ห้องยาต้องเห็นก่อนจัดยา
 *
 * อ่านอย่างเดียว ค้นด้วย hn (คีย์หลักของตาราง)
 * HIS ล่ม/ค้นไม่ได้ คืน error: true ไม่ใช่รายการว่าง
 * "ไม่มีประวัติแพ้ยา" กับ "ตรวจสอบไม่ได้" ต้องไม่ดูเหมือนกัน — ถ้าดูเหมือนกัน ห้องยาจะเข้าใจว่าไม่แพ้แล้วจ่ายยาที่แพ้
 */
const allergiesOf = async (hn: string | null) => {
    if (!hn) return { list: [], error: false };
    try {
        const [rows] = await his.execute<RowDataPacket[]>(
            `SELECT oa.agent, oa.symptom, oa.note, DATE_FORMAT(oa.report_date, '%Y-%m-%d') AS report_date,
                    s.seiousness_name AS seriousness
             FROM opd_allergy oa
             LEFT JOIN allergy_seriousness s ON s.seriousness_id = oa.seriousness_id
             WHERE oa.hn = ?
             ORDER BY oa.display_order IS NULL, oa.display_order, oa.report_date DESC`,
            [hn],
        );
        const clean = (v: unknown) => (v === null || v === undefined ? null
            : (sanitizeHTML(String(v)) ?? '').trim() || null);
        return {
            list: rows
                .map(r => ({
                    agent: clean(r.agent) ?? '',
                    symptom: clean(r.symptom),
                    seriousness: clean(r.seriousness),
                    note: clean(r.note),
                    report_date: r.report_date ? String(r.report_date) : null,
                }))
                .filter(a => a.agent),
            error: false,
        };
    } catch (error) {
        console.error('Rx allergy lookup failed:', error);
        return { list: [], error: true };
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
            SELECT o.*, w.ward_name, orc.label AS reject_category_label,
                   TO_CHAR(o.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at_text,
                   /* ใบก่อนหน้าถูกตีกลับเพราะอะไร ห้องยาต้องรู้เพื่อจะได้ตรวจจุดนั้นก่อน */
                   prev.reject_reason AS prev_reject_reason,
                   prev.reject_category AS prev_reject_category,
                   prc.label AS prev_reject_category_label,
                   TO_CHAR(prev.rejected_at, 'DD/MM/YYYY HH24:MI') AS prev_rejected_at
            FROM rx_orders o
            LEFT JOIN ward w ON w.ward = o.ward
            LEFT JOIN rx_orders prev ON prev.rx_order_id = o.resend_of
            LEFT JOIN rx_reject_categories prc ON prc.code = prev.reject_category
            LEFT JOIN rx_reject_categories orc ON orc.code = o.reject_category
            WHERE o.rx_order_id = ${id}
        `;
        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบใบสั่งยานี้' };
        }

        const files = await nurse`
            SELECT rx_file_id, file_no, original_name, mime_type, byte_size,
                   TO_CHAR(purged_at, 'YYYY-MM-DD HH24:MI') AS purged_at
            FROM rx_order_files WHERE rx_order_id = ${id} ORDER BY file_no
        `;
        const events = await nurse`
            SELECT action, actor_name, TO_CHAR(at, 'DD/MM/YYYY HH24:MI') AS at,
                   /* logEvent เก็บเป็นสตริง JSON ซ้อนใน jsonb แกะออกให้หน้าจอได้อ็อบเจ็กต์ */
                   CASE WHEN jsonb_typeof(detail) = 'string' THEN (detail #>> '{}')::jsonb ELSE detail END AS detail
            FROM rx_order_events WHERE rx_order_id = ${id} ORDER BY at
        `;

        const allergy = await allergiesOf(rows[0].hn ? String(rows[0].hn) : null);

        return {
            success: true,
            data: {
                ...rows[0], files, events, file_retention_days: await retentionDays(),
                allergies: allergy.list,
                /* true = ถาม HIS ไม่ได้ ต่างจากรายการว่าง (ไม่มีประวัติแพ้) */
                allergy_error: allergy.error,
            },
        };
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
            SELECT stored_path, mime_type, original_name,
                   /* ปี พ.ศ. ให้ตรงกับวันที่ที่ผู้ใช้เห็นในหน้าจออื่น */
                   TO_CHAR(purged_at, 'DD/MM/') || (EXTRACT(YEAR FROM purged_at)::int + 543) AS purged_on
            FROM rx_order_files WHERE rx_file_id = ${fileId} AND rx_order_id = ${id}
        `;
        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบไฟล์' };
        }

        /*
          410 ไม่ใช่ 404: ไฟล์เคยมีจริงและถูกลบโดยตั้งใจ หน้าจอจะได้บอกผู้ใช้ตามนั้น
          ไม่ต้องบันทึกการเปิดดู เพราะไม่มีข้อมูลผู้ป่วยถูกส่งออกไป
        */
        if (rows[0].purged_on) {
            set.status = 410;
            return {
                success: false,
                purged: true,
                message: `ไฟล์นี้ถูกลบออกจากระบบแล้วเมื่อ ${rows[0].purged_on} `
                    + `ตามระยะเวลาจัดเก็บไฟล์ ${await retentionDays()} วัน`,
            };
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
    const meta = await nurse`
        SELECT ward, priority, status,
               TO_CHAR(pickup_from, 'YYYY-MM-DD HH24:MI') AS pickup_from,
               TO_CHAR(pickup_to,   'YYYY-MM-DD HH24:MI') AS pickup_to
        FROM rx_orders WHERE rx_order_id = ${id}`;
    if (meta[0]) {
        emitRxOrder('order:status', {
            rx_order_id: String(id),
            ward: Number(meta[0].ward),
            status: String(meta[0].status) as RxStatus,
            priority: String(meta[0].priority) as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname,
            at: new Date().toISOString(),
            /* ส่งกลับ: หอเห็น "[กลุ่ม] ข้อความ" ในแจ้งเตือน · ไม่ได้พิมพ์เพิ่ม ข้อความคือชื่อกลุ่มอยู่แล้ว ไม่ซ้ำ */
            reason: typeof detail?.reason === 'string'
                ? (typeof detail.category_label === 'string' && detail.reason !== detail.category_label
                    ? `[${detail.category_label}] ${detail.reason}`
                    : detail.reason)
                : undefined,
            /* เปลี่ยนรอบของใบที่จัดเสร็จแล้ว — หอแสดงเป็น "เปลี่ยนรอบรับยา" ไม่ใช่ "ยาพร้อมแล้ว" ซ้ำ */
            ...(action === 'set_pickup_slot' ? { slot_changed: true } : {}),
            ...(meta[0].status === 'prepared' && meta[0].pickup_from
                ? { pickup_from: String(meta[0].pickup_from), pickup_to: String(meta[0].pickup_to) }
                : {}),
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
/** slot รับยายาว 1 ชั่วโมง เริ่มตรงชั่วโมงเท่านั้น เช่น 11:00–12:00 */
const PICKUP_SLOT_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):00$/;

/**
 * อ่านรอบรับยาจาก body: 'YYYY-MM-DD HH:00' หรือ null = ยังไม่เลือกรอบ
 * ไม่ส่งฟิลด์มาเลยเป็น error กันลืมเลือก · รอบต้องอยู่ตั้งแต่ชั่วโมงที่หอส่งใบ ถึงภายใน 24 ชม. ข้างหน้า
 */
const parsePickupSlot = async (body: unknown, id: number): Promise<{ slot: string | null } | { error: string }> => {
    const raw = (body as { pickup_from?: unknown } | undefined)?.pickup_from;
    if (raw === null) return { slot: null };
    const slot = String(raw ?? '').trim();
    if (!PICKUP_SLOT_RE.test(slot)) {
        return { error: 'กรุณาเลือกช่วงเวลาให้ตึกมารับยา (เริ่มตรงชั่วโมง เช่น 11:00) หรือเลือก "ยังไม่เลือกรอบ"' };
    }
    /*
      ย้อนหลังได้ถึงชั่วโมงที่หอส่งใบ: ห้องยาจัดเสร็จแล้วลืมกด พอกลับมากดตอนบ่ายต้องบันทึกรอบจริงที่ตึกมารับ (เช่น 11:00) ได้
      ข้างหน้าไม่เกิน 24 ชั่วโมงจากตอนนี้ · ใบไม่พบ = ไม่ผ่าน (transition ตอบ 404 ให้อีกชั้น)
    */
    const [win] = await nurse`
        SELECT ${slot}::text::timestamp >= date_trunc('hour', o.submitted_at)
           AND ${slot}::text::timestamp <  LOCALTIMESTAMP + interval '24 hours' AS ok
        FROM rx_orders o WHERE o.rx_order_id = ${id}`;
    if (!win?.ok) return { error: 'ช่วงเวลารับยาต้องไม่ก่อนเวลาที่หอส่งใบ และไม่เกิน 24 ชั่วโมงข้างหน้า' };
    return { slot };
};

export const prepareRxOrder = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    /*
      ต้องบอกตึกว่ามารับได้ช่วงไหน ไม่งั้นตึกเดินมาตอนห้องยายังไม่ว่างส่งมอบ หรือรอโดยไม่รู้ว่าเมื่อไหร่
      รับเป็นเวลาท้องถิ่น 'YYYY-MM-DD HH:00' (คอลัมน์เวลาของ rx_orders เป็น timestamp ไม่มี timezone)
    */
    const parsed = await parsePickupSlot(body, id);
    if ('error' in parsed) { set.status = 400; return { success: false, message: parsed.error }; }
    const slot = parsed.slot;

    try {
        return await transition(id, ['acknowledged', 'completed'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'prepared', prepared_by = ${actor.username},
                prepared_by_name = ${actor.fullname}, prepared_at = now(),
                pickup_from = ${slot}::text::timestamp, pickup_to = ${slot}::text::timestamp + interval '1 hour'  -- null = ยังไม่เลือกรอบ
            WHERE rx_order_id = ${id} AND status IN ('acknowledged', 'completed')
            RETURNING rx_order_id, status, prepared_by_name,
                      TO_CHAR(pickup_from, 'YYYY-MM-DD HH24:MI') AS pickup_from,
                      TO_CHAR(pickup_to,   'YYYY-MM-DD HH24:MI') AS pickup_to
        ` as unknown as Promise<Record<string, unknown>[]>, 'prepare', { pickup_from: slot });
    } catch (error) {
        console.error('Prepare rx order error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกว่าจัดยาเสร็จไม่สำเร็จ' };
    }
};

/**
 * กำหนด / เปลี่ยน / ล้างรอบรับยา ของใบที่จัดยาเสร็จแล้วแต่ตึกยังไม่มารับ
 * เช่น ตอนจัดเสร็จยังไม่เลือกรอบ หรือตึกขอเลื่อน · body { pickup_from: 'YYYY-MM-DD HH:00' | null }
 * สถานะคงเป็น prepared · ตึกได้สัญญาณพร้อมรอบใหม่ทันที
 */
export const setRxPickupSlot = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const parsed = await parsePickupSlot(body, id);
    if ('error' in parsed) { set.status = 400; return { success: false, message: parsed.error }; }
    const slot = parsed.slot;

    try {
        const [prev] = await nurse`SELECT TO_CHAR(pickup_from, 'YYYY-MM-DD HH24:MI') AS pickup_from FROM rx_orders WHERE rx_order_id = ${id}`;
        return await transition(id, ['prepared'], set, actor, () => nurse`
            UPDATE rx_orders
            SET pickup_from = ${slot}::text::timestamp, pickup_to = ${slot}::text::timestamp + interval '1 hour'
            WHERE rx_order_id = ${id} AND status = 'prepared'
            RETURNING rx_order_id, status,
                      TO_CHAR(pickup_from, 'YYYY-MM-DD HH24:MI') AS pickup_from,
                      TO_CHAR(pickup_to,   'YYYY-MM-DD HH24:MI') AS pickup_to
        ` as unknown as Promise<Record<string, unknown>[]>, 'set_pickup_slot',
            { pickup_from: slot, previous: prev?.pickup_from ?? null });
    } catch (error) {
        console.error('Set rx pickup slot error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกรอบรับยาไม่สำเร็จ' };
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
        /*
          รับยาตามรอบ: ใบที่มีรอบกดรับก่อนรอบเริ่มไม่ได้ (ทั้งหอและห้องยา)
          ตึกมาก่อนรอบจริง ให้ห้องยาเปลี่ยนรอบเป็นรอบปัจจุบันก่อน ประวัติจะได้บอกว่าเลื่อนรอบ
          ใบที่ไม่มีรอบ (ยังไม่เลือก / ใบเก่า) รับได้ทันที
        */
        const [cur] = await nurse`
            SELECT status, TO_CHAR(pickup_from, 'HH24:MI') AS f, TO_CHAR(pickup_to, 'HH24:MI') AS t,
                   TO_CHAR(pickup_from, 'YYYY-MM-DD') AS d, TO_CHAR(LOCALTIMESTAMP, 'YYYY-MM-DD') AS today,
                   pickup_from IS NOT NULL AND LOCALTIMESTAMP < pickup_from AS too_early
            FROM rx_orders WHERE rx_order_id = ${id}`;
        if (cur?.status === 'prepared' && cur.too_early) {
            set.status = 409;
            const day = cur.d === cur.today ? '' : `วันที่ ${cur.d} `;
            return {
                success: false,
                code: 'BEFORE_SLOT',
                message: `ยังไม่ถึงรอบรับยา (${day}${cur.f}–${cur.t} น.) กดรับได้เมื่อถึงรอบ · ถ้าตึกมาก่อนให้ห้องยาเปลี่ยนรอบก่อน`,
            };
        }
        /* เงื่อนไขรอบอยู่ใน WHERE ด้วย กันกรณีห้องยาเลื่อนรอบออกไประหว่างที่อีกฝั่งกด */
        return await transition(id, ['prepared'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'picked_up', closed_by = ${actor.username},
                closed_by_name = ${actor.fullname}, closed_at = now()
            WHERE rx_order_id = ${id} AND status = 'prepared'
              AND (pickup_from IS NULL OR LOCALTIMESTAMP >= pickup_from)
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

/**
 * แก้ประเภทแล้วส่งใหม่ — ห้องยาตีกลับเพราะหอเลือกประเภทผิด (ปกติ / กลับบ้าน / STAT, NG-Tube)
 *
 * ไม่ต้องสแกนใหม่: สร้างใบใหม่จากใบเดิม (HN ผู้ป่วย ไฟล์เดิม) ด้วยประเภทที่แก้แล้ว
 * ใบใหม่เริ่มนับเวลาใหม่ตั้งแต่ตอนนี้ (submitted_at = ตอนกด) ห้องยาเห็นเป็นใบเข้าใหม่ มีเสียงตามความด่วนใหม่
 * ใบเดิมถูกปิด (closed) และใบใหม่ชี้กลับด้วย resend_of เหมือนการส่งฉบับแก้ สถิติการส่งกลับจึงยังอยู่ครบ
 *
 * ไฟล์ถูกคัดลอกเป็นไฟล์ใหม่ ไม่ใช้ path ร่วมกับใบเดิม เพราะระบบลบไฟล์ตามอายุนับแยกรายใบ
 * body { priority, tube_feed?, note? } · ต้องเปลี่ยนอย่างน้อยหนึ่งอย่าง กันกดส่งของเดิมซ้ำโดยไม่ได้แก้
 */
export const resubmitRxOrder = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const b = (body ?? {}) as { priority?: string; tube_feed?: boolean; note?: string };
    if (!['routine', 'discharge', 'stat'].includes(String(b.priority))) {
        set.status = 400;
        return { success: false, message: 'กรุณาเลือกประเภท (ปกติ / ยากลับบ้าน / STAT)' };
    }
    const priority = String(b.priority) as 'routine' | 'discharge' | 'stat';

    const copied: string[] = [];
    try {
        const [old] = await nurse`
            SELECT rx_order_id, ward, hn, an, hn_source, patient_name, his_verified, priority, note, tube_feed, status
            FROM rx_orders WHERE rx_order_id = ${id}`;
        if (!old) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
        if (old.status !== 'rejected') {
            set.status = 409;
            return { success: false, message: 'แก้แล้วส่งใหม่ได้เฉพาะใบที่ห้องยาส่งกลับ และยังไม่ได้ปิดเรื่อง' };
        }
        const tubeFeed = typeof b.tube_feed === 'boolean' ? b.tube_feed : Boolean(old.tube_feed);
        if (priority === old.priority && tubeFeed === Boolean(old.tube_feed)) {
            set.status = 400;
            return { success: false, message: 'ประเภทยังเหมือนเดิม — ถ้าต้องแก้อย่างอื่น (ภาพ / HN) ให้สแกนแล้วส่งอีกครั้ง' };
        }
        const note = b.note === undefined
            ? (old.note as string | null)
            : (sanitizeHTML(String(b.note).trim()) ?? '').slice(0, 300) || null;

        const files = await nurse`
            SELECT file_no, original_name, stored_path, mime_type, byte_size, sha256
            FROM rx_order_files WHERE rx_order_id = ${id} AND purged_at IS NULL ORDER BY file_no`;
        if (files.length === 0) {
            set.status = 409;
            return { success: false, message: 'ไฟล์ของใบเดิมถูกลบตามระยะเวลาจัดเก็บแล้ว ต้องสแกนแล้วส่งอีกครั้ง' };
        }

        /* คัดลอกไฟล์ก่อนเขียนฐานข้อมูล ไฟล์หายจากดิสก์ = หยุดตรงนี้ ไม่สร้างใบที่เปิดดูภาพไม่ได้ */
        await mkdir(UPLOAD_ROOT, { recursive: true });
        const newFiles: { f: Record<string, unknown>; path: string }[] = [];
        for (const f of files) {
            const src = Bun.file(String(f.stored_path));
            if (!(await src.exists())) {
                set.status = 409;
                return { success: false, message: 'ไม่พบไฟล์ภาพของใบเดิมบนเครื่อง ต้องสแกนแล้วส่งอีกครั้ง' };
            }
            const path = join(UPLOAD_ROOT, `${randomUUID()}${extname(String(f.stored_path)) || '.bin'}`);
            await Bun.write(path, src);
            copied.push(path);
            newFiles.push({ f, path });
        }

        const newId = await nurse.begin(async tx => {
            /* ปิดใบเดิมก่อน ถ้าอีกเครื่องปิด/ส่งซ้ำไปแล้วจะไม่ได้แถว แล้วยกเลิกทั้งหมด ไม่เกิดใบซ้ำ */
            const closed = await tx`
                UPDATE rx_orders SET status = 'closed', closed_by = ${actor.username},
                    closed_by_name = ${actor.fullname}, closed_at = now()
                WHERE rx_order_id = ${id} AND status = 'rejected' RETURNING rx_order_id`;
            if (closed.length === 0) return null;
            const [ins] = await tx`
                INSERT INTO rx_orders (ward, hn, an, hn_source, patient_name, his_verified,
                                       priority, note, submitted_by, submitted_by_name, resend_of, tube_feed)
                VALUES (${old.ward}, ${old.hn}, ${old.an}, ${old.hn_source}, ${old.patient_name}, ${old.his_verified},
                        ${priority}, ${note}, ${actor.username}, ${actor.fullname}, ${id}, ${tubeFeed})
                RETURNING rx_order_id`;
            for (const { f, path } of newFiles) {
                await tx`
                    INSERT INTO rx_order_files (rx_order_id, file_no, original_name, stored_path, mime_type, byte_size, sha256)
                    VALUES (${ins.rx_order_id}, ${Number(f.file_no)}, ${String(f.original_name)}, ${path}, ${String(f.mime_type)}, ${Number(f.byte_size)}, ${String(f.sha256)})`;
            }
            return String(ins.rx_order_id);
        });
        if (!newId) {
            await Promise.all(copied.map(p => unlink(p).catch(() => {})));
            set.status = 409;
            return { success: false, message: 'ใบนี้ถูกปิดเรื่องหรือส่งใหม่ไปแล้วจากอีกเครื่อง' };
        }

        const change = { from: old.priority, to: priority, tube_feed_from: Boolean(old.tube_feed), tube_feed_to: tubeFeed };
        await logEvent(id, 'close', actor, { reason: 'แก้ประเภทแล้วส่งใหม่', new_order: newId, ...change });
        await logEvent(newId, 'submit', actor, {
            ward: Number(old.ward), files: newFiles.length, priority, resend_of: id, tube_feed: tubeFeed, resubmit: change,
        });

        const at = new Date().toISOString();
        emitRxOrder('order:status', {
            rx_order_id: String(id), ward: Number(old.ward), status: 'closed',
            priority, by_name: actor.fullname, at,
        });
        /* ใบเข้าใหม่จริง ห้องยาได้เสียงและเตือนตามความด่วนใหม่ */
        emitRxOrder('order:new', {
            rx_order_id: newId, ward: Number(old.ward), status: 'submitted', priority, by_name: actor.fullname, at,
        });
        return { success: true, data: { rx_order_id: newId }, message: 'ส่งใบใหม่ให้ห้องยาแล้ว เริ่มนับเวลาใหม่' };
    } catch (error) {
        await Promise.all(copied.map(p => unlink(p).catch(() => {})));
        console.error('Resubmit rx order error:', error);
        set.status = 500;
        return { success: false, message: 'ส่งใหม่ไม่สำเร็จ' };
    }
};

export const rejectRxOrder = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const b = body as { reason?: string; category?: string } | undefined;
    const reason = String(b?.reason ?? '').trim();
    /*
      กลุ่มเหตุผล (ใช้ทำสถิติ) บังคับเลือก · ข้อความอิสระยังเก็บไว้เป็นรายละเอียดให้หอรู้ว่าต้องแก้อะไร
      กลุ่ม "อื่น ๆ" ต้องพิมพ์เหตุผลเอง กลุ่มอื่นไม่พิมพ์ก็ได้ — ไม่พิมพ์ใช้ชื่อกลุ่มเป็นเหตุผลที่หอเห็น
    */
    const cat = await findActiveRejectCategory(b?.category);
    if (!cat) {
        set.status = 400;
        return { success: false, message: 'กรุณาเลือกกลุ่มเหตุผลที่ส่งกลับ' };
    }
    if (cat.require_note && reason.length < 3) {
        set.status = 400;
        return { success: false, message: `กลุ่ม "${cat.label}" กรุณาพิมพ์เหตุผลที่ส่งกลับ` };
    }
    const category = cat.code;
    const text = (sanitizeHTML(reason || cat.label) ?? '').slice(0, 500);

    try {
        return await transition(id, ['submitted', 'acknowledged'], set, actor, () => nurse`
            UPDATE rx_orders
            SET status = 'rejected', rejected_by = ${actor.username},
                rejected_by_name = ${actor.fullname}, rejected_at = now(),
                reject_reason = ${text}, reject_category = ${category}
            WHERE rx_order_id = ${id} AND status IN ('submitted', 'acknowledged')
            RETURNING rx_order_id, status, rejected_by_name, reject_category
        ` as unknown as Promise<Record<string, unknown>[]>, 'reject', { reason: text, category, category_label: cat.label });
    } catch (error) {
        console.error('Reject rx order error:', error);
        set.status = 500;
        return { success: false, message: 'ส่งกลับไม่สำเร็จ' };
    }
};

/* ───────────────────────── หอแก้ HN หลังส่ง ───────────────────────── */

/** สถานะที่หอยังแก้ HN ได้ — ใบที่ส่งกลับให้ส่งฉบับแก้ ใบที่รับยาไปแล้วหรือปิดแล้วจบไปแล้ว */
const HN_EDITABLE: RxStatus[] = ['submitted', 'acknowledged', 'completed', 'prepared'];

/**
 * หอแก้ HN ของใบที่ส่งไปแล้ว (ลืมใส่ หรือใส่ผิดคน)
 *
 * บังคับหมายเหตุ เพราะห้องยาอาจคีย์ลง HIS ไปแล้วในชื่อคนเดิม ต้องรู้ว่าทำไมเปลี่ยนถึงจะไปตามแก้ได้
 * HIS ล่มยังแก้ได้เหมือนตอนส่งใบ (his_verified = false) แต่ถ้า HIS ตอบว่าไม่มี HN นี้ ปฏิเสธ
 * สัญญาณที่ส่งไปไม่มี HN หรือชื่อ ห้องยาไปดึงจาก REST เองเหมือนสัญญาณอื่น
 */
export const editRxOrderHn = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);

    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const b = (body ?? {}) as { hn?: string; note?: string };
    const hn = padHn(String(b.hn ?? '').replace(/\D/g, ''));
    if (!new RegExp(`^\\d{${HN_LENGTH}}$`).test(hn) || /^0+$/.test(hn)) {
        set.status = 400;
        return { success: false, message: `HN ต้องเป็นตัวเลขไม่เกิน ${HN_LENGTH} หลัก` };
    }
    const note = (sanitizeHTML(String(b.note ?? '').trim()) ?? '').slice(0, 300);
    if (note.length < 3) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุหมายเหตุว่าแก้ HN เพราะอะไร' };
    }

    const cur = await nurse`
        SELECT hn, status, ward FROM rx_orders WHERE rx_order_id = ${id}
    `;
    if (cur.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
    const oldHn = String(cur[0].hn ?? '').trim();
    if (!HN_EDITABLE.includes(String(cur[0].status) as RxStatus)) {
        set.status = 409;
        return { success: false, message: 'ใบนี้แก้ HN ไม่ได้แล้ว (ส่งกลับ รับยาไปแล้ว หรือปิดเรื่องแล้ว)' };
    }
    if (oldHn === hn) {
        set.status = 400;
        return { success: false, message: 'HN เดิมกับ HN ใหม่เป็นเลขเดียวกัน' };
    }

    /* กฎเดียวกับตอนส่งใบ: ต้องนอนอยู่ตึกของใบนี้ HN เปลี่ยน = AN เดิมใช้ไม่ได้แล้ว จึงแทนที่เสมอ */
    const check = await checkPatientInWard(hn, Number(cur[0].ward));
    if (!check.ok) {
        set.status = check.status;
        return { success: false, message: check.message };
    }
    const patientName = check.ptname || null;
    const an = check.an;
    const hisVerified = check.verified;

    try {
        /* เงื่อนไข HN เดิมกับสถานะอยู่ใน WHERE กันอีกเครื่องแก้หรือเปลี่ยนสถานะไปก่อนระหว่างตรวจ HIS */
        const rows = await nurse`
            UPDATE rx_orders
            SET hn = ${hn}, an = ${an}, patient_name = ${patientName},
                his_verified = ${hisVerified}, hn_source = 'manual'
            WHERE rx_order_id = ${id}
              AND COALESCE(btrim(hn), '') = ${oldHn}
              AND status IN ${nurse(HN_EDITABLE)}
            RETURNING ward, priority, status
        `;
        if (rows.length === 0) {
            set.status = 409;
            return { success: false, message: 'ใบนี้ถูกแก้หรือเปลี่ยนสถานะไปก่อนแล้ว กรุณาเปิดดูใหม่' };
        }
        await logEvent(id, 'edit_hn', actor, { from: oldHn || null, to: hn, note });
        emitRxOrder('order:hn', {
            rx_order_id: String(id),
            ward: Number(rows[0].ward),
            status: String(rows[0].status) as RxStatus,
            priority: String(rows[0].priority) as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname,
            at: new Date().toISOString(),
            reason: note,
        });
        return {
            success: true,
            data: { rx_order_id: id, hn, an, patient_name: patientName, his_verified: hisVerified },
        };
    } catch (error) {
        console.error('Edit rx hn error:', error);
        set.status = 500;
        return { success: false, message: 'แก้ HN ไม่สำเร็จ' };
    }
};

/* ───────────────────────── หอย้ายตึกของใบ ───────────────────────── */

/**
 * หอย้ายตึกของใบที่ส่งไปแล้ว — ผู้ป่วยย้ายตึก (เช่น ออกจาก ICU) ระหว่างรอยา
 *
 * ฝั่งพยาบาลเท่านั้น: กลุ่มงานพยาบาล หรือแอดมินที่ไม่ได้อยู่กลุ่มห้องยา
 * ห้องยาห้ามย้ายเอง เพราะตึกเป็นคนรู้ว่าผู้ป่วยไปอยู่ไหนและใครจะมารับยา
 *
 * ตรวจกับ HIS ว่าผู้ป่วยอยู่ตึกใหม่แล้ว · HIS ยังไม่อัปเดตการย้าย (หรือตึกยังไม่ผูกรหัส HIS)
 * ได้ 409 NOT_IN_WARD ให้หน้าจอถามยืนยัน แล้วส่ง force มาอีกครั้ง (บันทึกไว้ว่า HIS ไม่ยืนยัน)
 * บังคับหมายเหตุ · ใช้กับใบที่ยังไม่จบ (รอรับ → ยาพร้อมรอมารับ) รอบรับยาเดิมยังอยู่
 */
export const changeRxOrderWard = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const info = await resolveGroups(user);
    const allowed = !!info && !info.groups.includes('pharmacy') && (info.groups.includes('nursing') || info.isAdmin);
    if (!allowed) {
        set.status = 403;
        return { success: false, message: 'ย้ายตึกได้เฉพาะฝั่งพยาบาล (ห้องยาย้ายตึกเองไม่ได้ ให้แจ้งหอผู้ป่วย)' };
    }

    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }
    const b = (body ?? {}) as { ward?: number | string; note?: string; force?: boolean };
    const toWard = Number(b.ward);
    if (!Number.isInteger(toWard) || toWard <= 0) { set.status = 400; return { success: false, message: 'กรุณาเลือกตึกใหม่' }; }
    const note = (sanitizeHTML(String(b.note ?? '').trim()) ?? '').slice(0, 300);
    if (note.length < 3) { set.status = 400; return { success: false, message: 'กรุณาระบุหมายเหตุ เช่น ย้ายจาก ICU ไปตึกอายุรกรรม' }; }

    try {
        const [cur] = await nurse`
            SELECT o.ward, o.hn, o.status, w.ward_name FROM rx_orders o
            LEFT JOIN ward w ON w.ward = o.ward WHERE o.rx_order_id = ${id}`;
        if (!cur) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
        if (!HN_EDITABLE.includes(String(cur.status) as RxStatus)) {
            set.status = 409;
            return { success: false, message: 'ใบนี้ย้ายตึกไม่ได้แล้ว (ส่งกลับ รับยาไปแล้ว หรือปิดเรื่องแล้ว)' };
        }
        const fromWard = Number(cur.ward);
        if (fromWard === toWard) { set.status = 400; return { success: false, message: 'ตึกใหม่เป็นตึกเดิม' }; }
        const [to] = await nurse`SELECT ward, ward_name FROM ward WHERE ward = ${toWard} AND is_active = 'Y'`;
        if (!to) { set.status = 400; return { success: false, message: 'ไม่พบตึกนี้ หรือตึกถูกปิดใช้งานแล้ว' }; }

        /* ผู้ป่วยอยู่ตึกใหม่จริงไหม · HIS ล่ม = ผ่าน (เหมือนตอนส่งใบ) · ไม่อยู่ = ถามยืนยันก่อน */
        let hisOk: boolean | null = null;
        const hn = String(cur.hn ?? '').trim();
        if (hn) {
            const check = await checkPatientInWard(hn, toWard);
            hisOk = check.ok ? (check.verified ? true : null) : false;
            if (!check.ok && !b.force) {
                set.status = 409;
                return { success: false, code: 'NOT_IN_WARD', message: `${check.message.replace(/ · ส่งได้.*$/, '')} · ถ้าเพิ่งย้ายและ HIS ยังไม่อัปเดต กดยืนยันเพื่อย้ายต่อ` };
            }
        }

        /* ตึกเดิมกับสถานะอยู่ใน WHERE กันอีกเครื่องย้าย/เปลี่ยนสถานะไปก่อนระหว่างตรวจ HIS */
        const rows = await nurse`
            UPDATE rx_orders SET ward = ${toWard}
            WHERE rx_order_id = ${id} AND ward = ${fromWard} AND status IN ${nurse(HN_EDITABLE)}
            RETURNING priority, status`;
        if (rows.length === 0) {
            set.status = 409;
            return { success: false, message: 'ใบนี้ถูกย้ายหรือเปลี่ยนสถานะไปก่อนแล้ว กรุณาเปิดดูใหม่' };
        }
        const fromName = String(cur.ward_name ?? `ตึก ${fromWard}`);
        const toName = String(to.ward_name ?? `ตึก ${toWard}`);
        await logEvent(id, 'change_ward', actor, { from: fromWard, to: toWard, from_name: fromName, to_name: toName, note, his_ok: hisOk });
        emitRxOrder('order:ward', {
            rx_order_id: String(id), ward: toWard, ward_name: toName, from_ward: fromWard, from_ward_name: fromName,
            status: String(rows[0].status) as RxStatus,
            priority: String(rows[0].priority) as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname, at: new Date().toISOString(), reason: note,
        });
        return { success: true, data: { rx_order_id: id, ward: toWard, ward_name: toName, from_ward: fromWard, his_ok: hisOk } };
    } catch (error) {
        console.error('Change rx ward error:', error);
        set.status = 500;
        return { success: false, message: 'ย้ายตึกไม่สำเร็จ' };
    }
};

/**
 * ห้องยารับทราบการย้ายตึก (ย้ายยาไปช่องรับของตึกใหม่แล้ว) — กดจากการ์ด
 * ใบเดินขั้นตอนต่อตามเดิม ไม่ได้เริ่มใหม่ · นี่คือการยืนยันว่าเห็นแล้ว ป้ายเตือนบนการ์ดจะหายไป
 * กลุ่มห้องยาหรือแอดมินเท่านั้น · กดซ้ำได้ 409 (ไม่มีการย้ายที่รอรับทราบ)
 */
export const ackRxOrderWard = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    const info = await resolveGroups(user);
    if (!info || !(info.groups.includes('pharmacy') || info.isAdmin)) {
        set.status = 403;
        return { success: false, message: 'รับทราบการย้ายตึกได้เฉพาะห้องยา' };
    }
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    try {
        /* ล็อกแถวใบก่อนตรวจ กันสองเครื่องกดพร้อมกันแล้วได้ ack ซ้ำ */
        const res = await nurse.begin(async tx => {
            const [o] = await tx`SELECT ward, priority, status FROM rx_orders WHERE rx_order_id = ${id} FOR UPDATE`;
            if (!o) return { code: 404 as const };
            const [p] = await tx`
                SELECT e.at FROM rx_order_events e
                WHERE e.rx_order_id = ${id} AND e.action = 'change_ward'
                  AND NOT EXISTS (SELECT 1 FROM rx_order_events x
                                  WHERE x.rx_order_id = ${id} AND x.action = 'ack_ward' AND x.at >= e.at)
                ORDER BY e.at DESC LIMIT 1`;
            if (!p) return { code: 409 as const };
            await tx`
                INSERT INTO rx_order_events (rx_order_id, action, actor, actor_name, detail)
                VALUES (${id}, 'ack_ward', ${actor.username}, ${actor.fullname}, ${JSON.stringify({ ward: Number(o.ward) })})`;
            return { code: 200 as const, o };
        });
        if (res.code === 404) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
        if (res.code === 409) { set.status = 409; return { success: false, message: 'ไม่มีการย้ายตึกที่รอรับทราบ (อาจมีคนกดรับทราบไปแล้ว)' }; }
        const [w] = await nurse`SELECT ward_name FROM ward WHERE ward = ${res.o.ward}`;
        emitRxOrder('order:ward', {
            rx_order_id: String(id), ward: Number(res.o.ward), ward_name: String(w?.ward_name ?? ''),
            status: String(res.o.status) as RxStatus,
            priority: String(res.o.priority) as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname, at: new Date().toISOString(), ward_ack: true,
        });
        return { success: true };
    } catch (error) {
        console.error('Ack rx ward error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกการรับทราบไม่สำเร็จ' };
    }
};

/* ───────────────────────── แอดมิน: ใส่ HN ย้อนหลัง ───────────────────────── */

const forbidden = (set: Context['set']) => {
    set.status = 403;
    return { success: false, message: 'เฉพาะผู้ดูแลระบบ' };
};

/**
 * ใบที่ส่งมาโดยไม่มี HN
 *
 * มาจากช่วงก่อนที่หน้าจอและเซิร์ฟเวอร์จะบังคับใส่ HN ทุกใบ
 * ใบพวกนี้ค้นด้วย HN ไม่เจอ และห้องยาต้องอ่านเลขจากภาพเอง จึงให้แอดมินดูภาพแล้วใส่ให้
 */
export const listRxMissingHn = async ({ user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    if (!(await isAdmin(actor.username))) return forbidden(set);

    try {
        const rows = await nurse`
            SELECT o.rx_order_id::int AS rx_order_id, o.ward, w.ward_name, o.status, o.priority, o.note,
                   o.submitted_by_name,
                   TO_CHAR(o.submitted_at, 'YYYY-MM-DD HH24:MI') AS submitted_at_text,
                   COALESCE((
                       SELECT json_agg(json_build_object(
                                  'rx_file_id', f.rx_file_id, 'file_no', f.file_no,
                                  'original_name', f.original_name, 'mime_type', f.mime_type,
                                  'byte_size', f.byte_size,
                                  'purged_at', TO_CHAR(f.purged_at, 'YYYY-MM-DD HH24:MI'))
                              ORDER BY f.file_no)
                       FROM rx_order_files f WHERE f.rx_order_id = o.rx_order_id
                   ), '[]'::json) AS files
            FROM rx_orders o
            LEFT JOIN ward w ON w.ward = o.ward
            WHERE o.hn IS NULL OR btrim(o.hn) = ''
            ORDER BY o.submitted_at DESC
        `;
        return { success: true, data: rows, file_retention_days: await retentionDays() };
    } catch (error) {
        console.error('List rx missing hn error:', error);
        set.status = 500;
        return { success: false, message: 'ดึงรายการไม่สำเร็จ' };
    }
};

/**
 * แอดมินใส่ HN ให้ใบที่ไม่มี HN
 *
 * ต่างจากตอนหอส่งใบตรงที่ HIS ต้องยืนยันได้เท่านั้น ตอนส่งใบยอมให้ HIS ล่มได้เพราะยาต้องถึงผู้ป่วย
 * แต่การใส่ย้อนหลังไม่มีอะไรเร่ง รอ HIS กลับมาได้ ไม่มีเหตุให้บันทึกเลขที่ไม่มีใครยืนยัน
 * แก้ได้เฉพาะใบที่ยังไม่มี HN การเปลี่ยน HN ที่ใส่ไว้แล้วเป็นอีกเรื่องหนึ่ง ไม่ให้ทำผ่านทางนี้
 */
export const setRxOrderHn = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);
    if (!(await isAdmin(actor.username))) return forbidden(set);

    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const b = (body ?? {}) as { hn?: string; note?: string };
    const hn = padHn(String(b.hn ?? '').replace(/\D/g, ''));
    /* ศูนย์ล้วนผ่านรูปแบบเก้าหลักได้ แต่ไม่ใช่ HN ของใคร */
    if (!new RegExp(`^\\d{${HN_LENGTH}}$`).test(hn) || /^0+$/.test(hn)) {
        set.status = 400;
        return { success: false, message: `HN ต้องเป็นตัวเลขไม่เกิน ${HN_LENGTH} หลัก` };
    }
    const note = (sanitizeHTML(String(b.note ?? '').trim()) ?? '').slice(0, 300);

    const cur = await nurse`
        SELECT hn, TO_CHAR(submitted_at, 'YYYY-MM-DD') AS day FROM rx_orders WHERE rx_order_id = ${id}
    `;
    if (cur.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
    if (String(cur[0].hn ?? '').trim()) {
        set.status = 409;
        return { success: false, message: `ใบนี้มี HN แล้ว (${cur[0].hn})` };
    }

    /*
      AN เอาเฉพาะการนอนที่ครอบวันที่ส่งใบ ไม่ใช่การนอนล่าสุด
      ผู้ป่วยที่จำหน่ายแล้วกลับมานอนใหม่ ใบเก่าต้องผูกกับการนอนครั้งเก่า
    */
    let patientName = '';
    let an: string | null = null;
    try {
        const [[p], [a]] = await Promise.all([
            his.execute<RowDataPacket[]>(
                `SELECT CONCAT(pname, fname, ' ', lname) AS ptname FROM patient WHERE hn = ? LIMIT 1`, [hn]),
            his.execute<RowDataPacket[]>(
                `SELECT an FROM ipt WHERE hn = ? AND regdate <= ? AND (dchdate IS NULL OR dchdate >= ?)
                 ORDER BY regdate DESC, regtime DESC LIMIT 1`, [hn, cur[0].day, cur[0].day]),
        ]);
        if (!p[0]) {
            set.status = 404;
            return { success: false, message: `ไม่พบ HN ${hn} ใน HIS` };
        }
        patientName = (sanitizeHTML(String(p[0].ptname ?? '')) ?? '').trim();
        an = a[0]?.an ? String(a[0].an) : null;
    } catch (error) {
        console.error('HIS verify on set hn failed:', error);
        set.status = 503;
        return { success: false, message: 'ตรวจกับ HIS ไม่ได้ตอนนี้ กรุณาลองใหม่ภายหลัง' };
    }

    try {
        const rows = await nurse`
            UPDATE rx_orders
            SET hn = ${hn}, an = COALESCE(NULLIF(btrim(an), ''), ${an}),
                patient_name = ${patientName}, his_verified = true, hn_source = 'manual'
            WHERE rx_order_id = ${id} AND (hn IS NULL OR btrim(hn) = '')
            RETURNING ward, priority, status, an
        `;
        /* อีกเครื่องใส่ไปก่อนระหว่างที่ตรวจ HIS อยู่ */
        if (rows.length === 0) {
            set.status = 409;
            return { success: false, message: 'ใบนี้ถูกใส่ HN ไปแล้ว' };
        }
        await logEvent(id, 'set_hn', actor, { hn, ...(note ? { note } : {}) });
        emitRxOrder('order:status', {
            rx_order_id: String(id),
            ward: Number(rows[0].ward),
            status: String(rows[0].status) as RxStatus,
            priority: String(rows[0].priority) as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname,
            at: new Date().toISOString(),
        });
        return { success: true, data: { rx_order_id: id, hn, an: rows[0].an ?? null, patient_name: patientName } };
    } catch (error) {
        console.error('Set rx hn error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึก HN ไม่สำเร็จ' };
    }
};

/* ───────────────────────── บันทึกการปรึกษาแพทย์ ───────────────────────── */

/**
 * บันทึกว่าโทรปรึกษาแพทย์เรื่องใบนี้แล้ว (เวลาไหน คุยว่าอะไร)
 *
 * ทั้งหอและห้องยาบันทึกได้ และเห็นของกันและกัน เพื่อไม่ให้สองฝั่งโทรตามแพทย์คนเดียวกันซ้ำ
 * หรือรอกันโดยไม่รู้ว่าอีกฝั่งคุยไปแล้ว
 *
 * เก็บเป็นเหตุการณ์ใน rx_order_events (action = consult) ไม่เพิ่มคอลัมน์
 * เพราะหนึ่งใบโทรได้หลายครั้ง และประวัติต้องอยู่ครบ ไม่ใช่เขียนทับครั้งก่อน
 *
 * เวลาปรึกษาแยกจากเวลาที่กดบันทึก คนมักโทรก่อนแล้วค่อยมาบันทึกทีหลัง
 * รับเป็นเวลาท้องถิ่น YYYY-MM-DD HH:mm ไม่ส่งมา = ตอนนี้ · ห้ามเป็นเวลาในอนาคต
 */
export const consultRxOrder = async ({ params, body, user, set }: Context & { user?: unknown }) => {
    const actor = await getActor(user);
    if (!actor) return unauthorized(set);

    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const b = (body ?? {}) as { note?: string; consulted_at?: string };
    const note = (sanitizeHTML(String(b.note ?? '').trim()) ?? '').slice(0, 500);
    if (note.length < 3) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุว่าคุยกับแพทย์ท่านใด และได้ข้อสรุปว่าอย่างไร' };
    }

    const raw = String(b.consulted_at ?? '').trim().replace('T', ' ');
    let consultedAt: string | null = null;
    if (raw) {
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) {
            set.status = 400;
            return { success: false, message: 'รูปแบบเวลาไม่ถูกต้อง' };
        }
        consultedAt = raw;
    }

    try {
        /*
          ให้ PG ตรวจเวลาเอง (เวลาท้องถิ่นของฐานเดียวกับ submitted_at) และคืนค่าเวลาที่ใช้จริง
          เผื่อนาฬิกาเครื่องลูกช้า/เร็วได้ 5 นาที แต่ย้อนหลังได้ไม่เกิน 7 วัน
        */
        const rows = await nurse`
            SELECT o.ward, o.priority, o.status,
                   TO_CHAR(COALESCE(${consultedAt}::text::timestamp, date_trunc('minute', now()::timestamp)),
                           'YYYY-MM-DD HH24:MI') AS consulted_at,
                   COALESCE(${consultedAt}::text::timestamp, now()::timestamp) <= now()::timestamp + interval '5 minutes'
                       AS not_future,
                   COALESCE(${consultedAt}::text::timestamp, now()::timestamp) >= now()::timestamp - interval '7 days'
                       AS recent
            FROM rx_orders o WHERE o.rx_order_id = ${id}
        `;
        if (rows.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
        const r = rows[0];
        if (!r.not_future) { set.status = 400; return { success: false, message: 'เวลาปรึกษาต้องไม่เป็นเวลาในอนาคต' }; }
        if (!r.recent) { set.status = 400; return { success: false, message: 'บันทึกย้อนหลังได้ไม่เกิน 7 วัน' }; }

        const at = String(r.consulted_at);
        await logEvent(id, 'consult', actor, { consulted_at: at, note });
        emitRxOrder('order:consult', {
            rx_order_id: String(id),
            ward: Number(r.ward),
            status: String(r.status) as RxStatus,
            priority: String(r.priority) as 'routine' | 'discharge' | 'stat',
            by_name: actor.fullname,
            at: new Date().toISOString(),
            reason: note,
        });
        return { success: true, data: { rx_order_id: id, consulted_at: at, note, by_name: actor.fullname } };
    } catch (error) {
        console.error('Consult rx order error:', error);
        set.status = 500;
        return { success: false, message: 'บันทึกการปรึกษาแพทย์ไม่สำเร็จ' };
    }
};
