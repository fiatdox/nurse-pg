import { Context } from 'elysia';
import { join } from 'path';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { his, nurse } from '../db';
import type { RowDataPacket } from 'mysql2';
import { sanitizeHTML } from '../utils/sanitize';
import { HN_LENGTH, padHn } from '../utils/hn';

/**
 * อ่านเลข HN จากภาพใบสั่งยา
 *
 * **ไม่เก็บอะไรลงดิสก์และไม่บันทึกลงฐานข้อมูล** ภาพที่ส่งมาที่นี่คือภาพที่พยาบาล
 * กำลังจะส่งอยู่แล้ว ใช้อ่านแล้วทิ้งทันที ตัวใบจริงถูกเก็บตอนกดส่งผ่าน /orders
 *
 * ผลลัพธ์เป็น "ข้อเสนอ" ไม่ใช่คำตอบ คนที่ถือกระดาษต้นฉบับอยู่ในมือเป็นคนยืนยัน
 * เลขที่อ่านพลาดหนึ่งหลักแล้วผ่านเข้าไปเงียบ ๆ คือยาไปผิดคน
 * ชั้นนี้จึงคืนได้หลายคำตอบ และไม่เลือกให้เองเมื่อมีมากกว่าหนึ่ง
 *
 * **การเจอในตารางทะเบียนผู้ป่วยไม่ได้ยืนยันอะไร** เลข HN ของที่นี่เรียงกันแน่น
 * ช่วง 000100000-000199999 มีเจ้าของจริงอยู่ 93,976 เลข คือเกือบทุกเลขเป็นคนไข้จริง
 * ตัวเลขอะไรก็ตามที่อยู่บนใบ order จึงไปตรงกับคนไข้จริงคนหนึ่งได้เกือบทุกครั้ง
 * เช่น 251068 ที่พยาบาลเขียนวันที่ไว้มุมใบ ก็เป็น HN ของคนไข้จริงอีกคนหนึ่ง
 * สิ่งที่ยืนยันได้จริงคือคนนั้นกำลังนอนอยู่หรือไม่ ซึ่งเหลือราว 360 คนจากเกือบเจ็ดแสนเลข
 * จึงเรียงคำตอบตามสถานะการนอน และติดป้ายบอกเมื่อเลขนั้นไม่ใช่ผู้ป่วยในช่วงนี้
 */

/** โมเดลภาษาอังกฤษของ tesseract ต้องวางไว้ในเครื่อง เครือข่ายโรงพยาบาลออกอินเทอร์เน็ตไม่ได้ */
const TESSDATA_DIR = process.env.TESSDATA_DIR || join(process.cwd(), 'assets', 'tessdata');

/** ยิง HIS ทีเดียวได้เท่านี้ กันการเดาเลขรัวจนกลายเป็นการกวาดฐานข้อมูลผู้ป่วย */
const MAX_CANDIDATES = 8;

/** อ่านภาพนานกว่านี้ถือว่าไม่สำเร็จ ปล่อยให้พยาบาลพิมพ์เองดีกว่าให้รอค้าง */
const OCR_TIMEOUT_MS = 20000;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

type Source = 'pdf_text' | 'barcode' | 'ocr';

/**
 * สถานะการนอนของเลขที่อ่านได้ ใช้เรียงคำตอบจากน่าเชื่อถือมากไปน้อย
 *
 * admitted_here = นอนอยู่ที่หอที่กำลังส่งใบนี้ · admitted = นอนอยู่ที่หออื่น
 * discharged = จำหน่ายไปไม่นาน (ยากลับบ้านตามมาทีหลังได้) · none = ไม่ใช่ผู้ป่วยในช่วงนี้
 */
export type Admission = 'admitted_here' | 'admitted' | 'discharged' | 'none';

const ADMISSION_RANK: Record<Admission, number> = {
    admitted_here: 0, admitted: 1, discharged: 2, none: 3,
};

/** ลำดับที่มาของเลข ใช้ตัดสินเฉพาะตอนสถานะการนอนเท่ากัน ไม่เอามาแซงสถานะการนอน */
const SOURCE_RANK: Record<Source, number> = { pdf_text: 0, barcode: 0, ocr: 1 };

/**
 * จำหน่ายไปไม่เกินกี่วันยังนับว่าใบนี้เป็นของการนอนครั้งนั้น
 * ใบยากลับบ้านถูกสแกนส่งตามมาหลังผู้ป่วยออกจากหอได้ ตัดที่วันจำหน่ายพอดีจะตกไปทั้งหมด
 */
const DISCHARGE_GRACE_DAYS = 7;

/** การนอนครั้งล่าสุดของเลขหนึ่ง */
interface AdmissionInfo {
    an: string | null;
    ward_name: string | null;
    admission: Admission;
    /** วันจำหน่าย รูปแบบ YYYY-MM-DD ว่าง = ยังนอนอยู่ */
    discharged_at: string | null;
}

let workerPromise: Promise<Worker> | null = null;

const getWorker = (): Promise<Worker> => {
    if (!workerPromise) {
        workerPromise = (async () => {
            const worker = await createWorker('eng', OEM.LSTM_ONLY, {
                langPath: TESSDATA_DIR,
                gzip: true,
                /* อ่านจากไฟล์ในเครื่องตรง ๆ ไม่ต้องมีที่เก็บชั่วคราวให้ดูแลอีกที่ */
                cacheMethod: 'none',
            });
            await worker.setParameters({
                /*
                  จำกัดให้รู้จักแค่ตัวเลข ไม่ให้เดาเป็นตัวอักษร
                  บนใบที่มีภาษาไทยปนอยู่ การปล่อยให้อ่านทุกอักขระทำให้เลขเพี้ยนบ่อยกว่ามาก
                */
                tessedit_char_whitelist: '0123456789',
                /* ใบสั่งยาไม่ใช่หน้าหนังสือ ตัวเลขกระจายอยู่คนละมุม ต้องใช้โหมดข้อความกระจาย */
                tessedit_pageseg_mode: PSM.SPARSE_TEXT,
            });
            return worker;
        })().catch(err => {
            // ล้มเหลวแล้วต้องล้างทิ้ง ไม่งั้นจะติด promise ที่ reject ไว้ตลอดอายุโปรเซส
            workerPromise = null;
            throw err;
        });
    }
    return workerPromise;
};

/*
  worker ตัวเดียวทำได้ทีละงาน ถ้าสองหอกดพร้อมกันแล้วยิงเข้าไปซ้อน ผลจะปนกัน
  จึงต่อคิวไว้ งานที่สองรอให้งานแรกจบก่อนเสมอ
*/
let queue: Promise<unknown> = Promise.resolve();
const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
};

/**
 * แปลงข้อความที่อ่านได้เป็นเลข HN ที่เป็นไปได้
 * เลขสั้นกว่าเก้าหลักเติมศูนย์หน้าให้ เลขยาวกว่าลองทั้งหัวและท้าย
 * (ตัวเลขสองก้อนที่อยู่ติดกันมักถูกอ่านรวมเป็นก้อนเดียว)
 */
export const hnCandidatesFrom = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(/\d{4,14}/g)) {
        const run = m[0];
        if (run.length <= HN_LENGTH) out.push(padHn(run));
        else {
            out.push(run.slice(0, HN_LENGTH));
            out.push(run.slice(-HN_LENGTH));
        }
    }
    /* เลขศูนย์ล้วนมาจากขอบกระดาษที่อ่านเพี้ยน ไม่ใช่ HN */
    return [...new Set(out)].filter(hn => !/^0+$/.test(hn)).slice(0, MAX_CANDIDATES);
};

/**
 * แปลงรหัสหอของระบบพยาบาลเป็นรหัสหอฝั่ง HIS
 * สองฝั่งใช้คนละชุดเลข คอลัมน์ his_code เป็นสะพานเดียวที่เทียบกันได้
 * แปลงไม่ได้ก็ยังอ่านเลขได้ตามปกติ แค่ไม่รู้ว่านอนอยู่หอนี้หรือหออื่น
 */
export const hisWardCode = async (ward: number): Promise<string | null> => {
    if (!Number.isInteger(ward) || ward <= 0) return null;
    try {
        const rows = await nurse`SELECT his_code FROM ward WHERE ward = ${ward} LIMIT 1`;
        const code = (rows[0] as { his_code?: string } | undefined)?.his_code;
        return code ? String(code) : null;
    } catch (error) {
        console.error('Ward his_code lookup failed:', error);
        return null;
    }
};

/**
 * การนอนครั้งล่าสุดของแต่ละเลข จากตารางผู้ป่วยใน
 *
 * เอาครั้งล่าสุดตามวันรับไว้ ไม่ใช่หยิบแถวที่ยังไม่จำหน่ายขึ้นมาก่อน
 * เพราะในข้อมูลจริงมีการนอนเก่าที่ลืมปิดค้างอยู่ ถ้าให้แถวที่ยังเปิดอยู่ชนะ
 * คนที่จำหน่ายไปเมื่อวานจะถูกรายงานว่ายังนอนอยู่ ซึ่งผิดไปอีกทางหนึ่ง
 */
export const admissionsOf = async (candidates: string[], wardCode: string | null) => {
    const out = new Map<string, AdmissionInfo>();
    const marks = candidates.map(() => '?').join(', ');
    const [rows] = await his.execute<RowDataPacket[]>(
        `SELECT i.hn, i.an, i.ward, w.name AS ward_name, i.dchstts,
                DATE_FORMAT(i.dchdate, '%Y-%m-%d') AS dchdate_text,
                DATEDIFF(CURDATE(), i.dchdate) AS days_out
         FROM ipt i
         LEFT JOIN ward w ON w.ward = i.ward
         WHERE i.hn IN (${marks})
         ORDER BY i.regdate IS NULL, i.regdate DESC, i.regtime DESC`,
        candidates,
    );
    for (const row of rows) {
        const hn = String(row.hn ?? '');
        /* แถวแรกของแต่ละเลขคือครั้งล่าสุดอยู่แล้ว ครั้งก่อน ๆ ไม่ได้บอกอะไรเพิ่ม */
        if (!hn || out.has(hn)) continue;
        const open = row.dchstts === null || row.dchstts === undefined;
        const daysOut = row.days_out === null || row.days_out === undefined
            ? null : Number(row.days_out);
        const admission: Admission = open
            ? (wardCode && String(row.ward ?? '') === wardCode ? 'admitted_here' : 'admitted')
            : (daysOut !== null && daysOut >= 0 && daysOut <= DISCHARGE_GRACE_DAYS
                ? 'discharged' : 'none');
        /*
          การนอนที่จบไปนานแล้วไม่ส่ง AN กับหอกลับไป
          หน้าจอเอา AN ของคำตอบที่พยาบาลกดเลือกไปติดกับใบ ถ้าส่งไป ใบวันนี้จะได้ AN ของปีก่อน
        */
        if (admission === 'none') {
            out.set(hn, { an: null, ward_name: null, admission, discharged_at: null });
            continue;
        }
        out.set(hn, {
            an: row.an ? String(row.an) : null,
            ward_name: row.ward_name ? (sanitizeHTML(String(row.ward_name)) ?? '') : null,
            admission,
            discharged_at: open || !row.dchdate_text ? null : String(row.dchdate_text),
        });
    }
    return out;
};

/** ชื่อผู้ป่วย อยู่ในตารางทะเบียน ไม่ได้อยู่ในตารางผู้ป่วยใน จึงต้องถามอีกที่หนึ่ง */
const namesOf = async (candidates: string[]) => {
    const marks = candidates.map(() => '?').join(', ');
    const [rows] = await his.execute<RowDataPacket[]>(
        `SELECT hn, CONCAT(pname, fname, ' ', lname) AS ptname
         FROM patient WHERE hn IN (${marks})`,
        candidates,
    );
    const out = new Map<string, string>();
    for (const row of rows) {
        out.set(String(row.hn ?? ''), (sanitizeHTML(String(row.ptname ?? '')) ?? '').trim());
    }
    return out;
};

/**
 * ยืนยันกับ HIS หนึ่งรอบต่อหนึ่งครั้งที่พยาบาลแนบไฟล์
 *
 * ยิงสองคำขอ ไม่รวมเป็น JOIN เดียว เพราะต้องการการนอน "ครั้งล่าสุด" ของแต่ละเลข
 * ซึ่งต้องเลือกจากหลายแถวต่อหนึ่งเลข รวมเป็น JOIN เดียวแล้วจะได้การนอนเก่ามาปนด้วย
 * ทั้งสองคำขอค้นด้วยคอลัมน์ที่มี index และมีเลขไม่เกินแปดตัว
 */
const verifyAgainstHis = async (candidates: string[], wardCode: string | null) => {
    const empty = {
        adm: new Map<string, AdmissionInfo>(),
        names: new Map<string, string>(),
    };
    if (candidates.length === 0) return { ...empty, down: false };
    try {
        const [adm, names] = await Promise.all([
            admissionsOf(candidates, wardCode),
            namesOf(candidates),
        ]);
        return { adm, names, down: false };
    } catch (error) {
        console.error('Verify HN candidates error:', error);
        // HIS ล่มไม่ใช่เหตุให้ส่งใบไม่ได้ แค่ไม่มีชื่อมาช่วยยืนยันว่าอ่านถูก
        return { ...empty, down: true };
    }
};

export const readRxHn = async ({ body, set }: Context) => {
    const b = (body ?? {}) as { file?: File; candidates?: string; source?: string; ward?: string };

    /* เลขที่ฝั่งหน้าจออ่านมาได้เองจากชั้นข้อความใน PDF หรือจากบาร์โค้ด — แม่นกว่า OCR */
    const given = String(b.candidates ?? '')
        .split(',')
        .map(v => v.trim())
        .filter(v => /^\d{4,14}$/.test(v));
    const givenSource: Source = b.source === 'pdf_text' || b.source === 'barcode' ? b.source : 'ocr';

    let ocrText = '';
    let ocrFailed = false;
    let ocrUnavailable = false;

    if (b.file instanceof File) {
        if (b.file.size > MAX_IMAGE_BYTES) {
            set.status = 413;
            return { success: false, message: 'ภาพใหญ่เกินกว่าที่อ่านได้' };
        }
        try {
            const buf = Buffer.from(await b.file.arrayBuffer());
            ocrText = await serialize(async () => {
                const worker = await getWorker();
                const result = await Promise.race([
                    worker.recognize(buf),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('OCR timeout')), OCR_TIMEOUT_MS)),
                ]);
                return result.data.text;
            });
        } catch (error) {
            const msg = String(error);
            /* ไม่มีไฟล์โมเดล = ยังไม่ได้ติดตั้ง ต่างจากอ่านแล้วไม่เจอ ต้องบอกให้ต่างกัน */
            ocrUnavailable = msg.includes('ENOENT') || msg.includes('traineddata');
            ocrFailed = true;
            console.error('Read rx HN error:', error);
        }
    }

    const fromOcr = hnCandidatesFrom(ocrText);
    const fromGiven = hnCandidatesFrom(given.join(' '));
    const sourceOf = new Map<string, Source>();
    for (const hn of fromOcr) sourceOf.set(hn, 'ocr');
    // เลขจากบาร์โค้ด/ชั้นข้อความทับของ OCR เสมอ เพราะไม่ได้มาจากการเดารูปตัวอักษร
    for (const hn of fromGiven) sourceOf.set(hn, givenSource);

    const candidates = [...sourceOf.keys()].slice(0, MAX_CANDIDATES);
    const wardCode = await hisWardCode(Number(b.ward));
    const { adm, names, down } = await verifyAgainstHis(candidates, wardCode);

    /*
      เลขที่มีในตารางผู้ป่วยในแต่ไม่มีในทะเบียน ยังคืนไปด้วยแม้ไม่มีชื่อ
      การนอนอยู่จริงเป็นหลักฐานที่แข็งกว่าการมีชื่อ ตัดทิ้งเพราะหาชื่อไม่เจอคือทิ้งคำตอบที่ถูก

      ไม่ตัดเลขที่ไม่ใช่ผู้ป่วยในทิ้ง แค่เรียงไว้ท้ายและติดป้าย
      ถ้าตัดทิ้ง ใบของคนที่เพิ่งรับเข้ามาแต่ HIS ยังไม่ลงการนอน จะขึ้นว่าไม่พบผู้ป่วย
      แล้วพยาบาลต้องพิมพ์เอง ซึ่งเป็นทางที่พิมพ์ผิดได้มากกว่า
    */
    const matches = candidates
        .filter(hn => adm.has(hn) || names.has(hn))
        .map(hn => {
            const a = adm.get(hn);
            const source = sourceOf.get(hn) ?? 'ocr';
            return {
                hn,
                ptname: names.get(hn) ?? '',
                an: a?.an ?? null,
                ward_name: a?.ward_name ?? null,
                admission: a?.admission ?? 'none',
                discharged_at: a?.discharged_at ?? null,
                source,
            };
        })
        .sort((x, y) => ADMISSION_RANK[x.admission] - ADMISSION_RANK[y.admission]
            || SOURCE_RANK[x.source] - SOURCE_RANK[y.source]);

    return {
        success: true,
        /* ทุกเลขที่อ่านได้ ส่งกลับไปให้เห็นด้วย เวลาอ่านผิดจะได้รู้ว่าผิดเป็นอะไร */
        read: candidates,
        matches,
        his_down: down,
        ocr_failed: ocrFailed,
        ocr_unavailable: ocrUnavailable,
    };
};
