import { Context } from 'elysia';
import { join } from 'path';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { his, nurse } from '../db';
import type { RowDataPacket } from 'mysql2';
import { sanitizeHTML } from '../utils/sanitize';
import { HN_LENGTH, padHn } from '../utils/hn';
import { paddleRecognize } from '../utils/paddleOcr';
import { rxOcrEngine, type OcrEngine } from './systemSettingsController';

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
    /** เตียงของการนอนครั้งนี้ (iptadm.bedno) ว่าง = ไม่รู้ / จำหน่ายนานแล้ว */
    bedno: string | null;
    ward_name: string | null;
    admission: Admission;
    /** วันจำหน่าย รูปแบบ YYYY-MM-DD ว่าง = ยังนอนอยู่ */
    discharged_at: string | null;
    /**
     * ส่งใบสั่งยาจากหอนี้ได้หรือไม่ — นอนอยู่หอนี้ หรือเพิ่งจำหน่ายจากหอนี้ไม่เกิน SUBMIT_DISCHARGE_DAYS
     * เซิร์ฟเวอร์ใช้ค่านี้ปฏิเสธใบ หน้าจอใช้ค่าเดียวกันห้ามกดส่ง กฎจะได้ตรงกันที่เดียว
     */
    in_ward: boolean;
}

/**
 * จำหน่ายจากหอนี้ไปไม่เกินกี่วันยังส่งใบได้ (0 = วันนี้ · 1 = ถึงเมื่อวาน)
 * แคบกว่า DISCHARGE_GRACE_DAYS ที่ใช้แค่ติดป้ายบอก เพราะตัวนี้คือสิทธิ์ส่งใบ
 * ใบยากลับบ้านตามมาไม่เกินวันรุ่งขึ้น ถ้าเปิดกว้างเท่าป้าย หอจะเอา HN ของคนที่ออกไปเป็นสัปดาห์มาใส่แทนได้
 */
export const SUBMIT_DISCHARGE_DAYS = 1;

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

/** อ่านนานเกินกำหนดถือว่าไม่สำเร็จ ใช้กับทั้งสองเครื่องมือ */
const withTimeout = <T>(p: Promise<T>): Promise<T> => Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), OCR_TIMEOUT_MS)),
]);

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
/**
 * เลขที่ตามหลังคำว่า HN บนใบ (HN 000123456 / HN: 123456 / H.N. 000123456)
 * ใบส่วนใหญ่ของที่นี่พิมพ์ HN แบบนี้ เป็นหลักฐานที่ชัดที่สุดว่าเลขไหนคือ HN
 * เห็นได้เฉพาะ PaddleOCR — tesseract ตั้งให้อ่านแค่ตัวเลข จึงไม่เห็นคำว่า HN (ใช้รูปแบบ 000XXXXXX ข้างล่างแทน)
 * OCR มักอ่านศูนย์เป็นตัว O จึงแปลง O/o ในเลขหลังคำว่า HN เป็น 0
 */
const HN_LABEL = /(?<![A-Za-z])H\.?\s?N\.?\s*(?:[:#-]\s*)?([0-9Oo]{4,14})(?![0-9])/gi;
export const labeledHnsFrom = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(HN_LABEL)) {
        const raw = m[1] ?? '';
        /* ต้องมีตัวเลขจริงอย่างน้อย 3 ตัว กันคำที่ขึ้นต้นด้วย O ต่อท้าย HN */
        if ((raw.match(/\d/g) ?? []).length < 3) continue;
        const run = raw.replace(/[Oo]/g, '0');
        /* ยาวเกิน = OCR ต่อเลขถัดไปเข้ามา เลขที่ติดคำว่า HN คือส่วนหัว */
        out.push(run.length <= HN_LENGTH ? padHn(run) : run.slice(0, HN_LENGTH));
    }
    return [...new Set(out)].filter(hn => !/^0+$/.test(hn));
};

/**
 * HN เต็มรูปแบบที่พิมพ์บนใบ: 000 ตามด้วยเลขหกหลัก (000123456)
 * วันที่ ขนาดยา เลขเตียง ไม่ขึ้นต้นด้วย 000 และยาวเก้าหลักพอดี จึงเชื่อได้กว่าเลขลอย ๆ มาก
 * ใช้ได้กับ OCR ทั้งสองตัว (tesseract ที่อ่านแค่ตัวเลขก็เห็น)
 */
const FULL_HN = /(?<!\d)000\d{6}(?!\d)/g;

/** เลขที่น่าจะเป็น HN จริง (ติดคำว่า HN หรือเป็นรูปแบบ 000XXXXXX) — ได้ที่นั่งก่อนและชนะเมื่อสถานะการนอนเท่ากัน */
export const strongHnsFrom = (text: string): string[] =>
    [...new Set([...labeledHnsFrom(text), ...[...text.matchAll(FULL_HN)].map(m => m[0])])];

export const hnCandidatesFrom = (text: string): string[] => {
    /* เลขที่น่าจะเป็น HN จริงขึ้นก่อน ไม่ตกเพดาน MAX_CANDIDATES เพราะมีเลขอื่นบนใบมาก่อน */
    const out: string[] = strongHnsFrom(text);
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
        `SELECT i.hn, i.an, i.ward, w.name AS ward_name, i.dchstts, ad.bedno,
                DATE_FORMAT(i.dchdate, '%Y-%m-%d') AS dchdate_text,
                DATEDIFF(CURDATE(), i.dchdate) AS days_out
         FROM ipt i
         LEFT JOIN ward w ON w.ward = i.ward
         LEFT JOIN iptadm ad ON ad.an = i.an
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
        const here = !!wardCode && String(row.ward ?? '') === wardCode;
        const admission: Admission = open
            ? (here ? 'admitted_here' : 'admitted')
            : (daysOut !== null && daysOut >= 0 && daysOut <= DISCHARGE_GRACE_DAYS
                ? 'discharged' : 'none');
        /*
          การนอนที่จบไปนานแล้วไม่ส่ง AN กับหอกลับไป
          หน้าจอเอา AN ของคำตอบที่พยาบาลกดเลือกไปติดกับใบ ถ้าส่งไป ใบวันนี้จะได้ AN ของปีก่อน
        */
        if (admission === 'none') {
            out.set(hn, { an: null, bedno: null, ward_name: null, admission, discharged_at: null, in_ward: false });
            continue;
        }
        out.set(hn, {
            an: row.an ? String(row.an) : null,
            bedno: row.bedno ? (sanitizeHTML(String(row.bedno)) ?? '').trim() || null : null,
            ward_name: row.ward_name ? (sanitizeHTML(String(row.ward_name)) ?? '') : null,
            admission,
            discharged_at: open || !row.dchdate_text ? null : String(row.dchdate_text),
            in_ward: here && (open || (daysOut !== null && daysOut >= 0 && daysOut <= SUBMIT_DISCHARGE_DAYS)),
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
    const b = (body ?? {}) as { file?: File; roi?: File; candidates?: string; source?: string; ward?: string };

    /* เลขที่ฝั่งหน้าจออ่านมาได้เองจากชั้นข้อความใน PDF หรือจากบาร์โค้ด — แม่นกว่า OCR */
    const given = String(b.candidates ?? '')
        .split(',')
        .map(v => v.trim())
        .filter(v => /^\d{4,14}$/.test(v));
    const givenSource: Source = b.source === 'pdf_text' || b.source === 'barcode' ? b.source : 'ocr';

    let ocrText = '';
    let ocrFailed = false;
    let ocrUnavailable = false;
    /** เครื่องมือที่ใช้อ่านจริงในคำขอนี้ (paddle ล้มแล้วถอยมา tesseract จะเป็น tesseract) */
    let engine: OcrEngine | null = null;

    if (b.file instanceof File && b.file.size > MAX_IMAGE_BYTES) {
        set.status = 413;
        return { success: false, message: 'ภาพใหญ่เกินกว่าที่อ่านได้' };
    }
    const roiFile = b.roi instanceof File && b.roi.size <= MAX_IMAGE_BYTES ? b.roi : null;

    /*
      PaddleOCR ตามที่แอดมินตั้งไว้ ถ้าโหลดไม่ขึ้นหรืออ่านพัง ถอยไปใช้ tesseract ในคำขอเดียวกัน
      พยาบาลไม่ควรต้องพิมพ์ HN เองเพียงเพราะเครื่องมือตัวที่สองมีปัญหา
    */
    const ocr = async (file: File): Promise<string> => {
        const buf = Buffer.from(await file.arrayBuffer());
        const tesseract = () => serialize(async () => {
            const worker = await getWorker();
            const result = await withTimeout(worker.recognize(buf));
            return result.data.text;
        });
        if (engine === null) engine = await rxOcrEngine();
        try {
            if (engine === 'paddle') {
                try {
                    return await serialize(() => withTimeout(paddleRecognize(buf)));
                } catch (error) {
                    /* ข้อความ error ของไลบรารีพ่นซอร์สทั้งไฟล์ออกมา ตัดเหลือบรรทัดที่บอกสาเหตุ */
                    const m = error instanceof Error ? error.message : String(error);
                    console.error('PaddleOCR failed, falling back to tesseract:', m.split('\n').slice(-3).join(' ').slice(0, 300));
                    engine = 'tesseract';
                }
            }
            return await tesseract();
        } catch (error) {
            const msg = String(error);
            /* ไม่มีไฟล์โมเดล = ยังไม่ได้ติดตั้ง ต่างจากอ่านแล้วไม่เจอ ต้องบอกให้ต่างกัน */
            ocrUnavailable = msg.includes('ENOENT') || msg.includes('traineddata');
            ocrFailed = true;
            console.error('Read rx HN error:', error);
            return '';
        }
    };

    const fromGiven = hnCandidatesFrom(given.join(' '));
    const wardCode = await hisWardCode(Number(b.ward));

    /*
      อ่านบริเวณที่ HN มักอยู่ก่อน (แถบล่างสุด + แถบบนสุดของใบ เต็มความกว้าง ต่อกันเป็นภาพเดียว — หน้าจอตัดภาพส่งมาเป็น roi)
      ภาพที่ตัดแล้วมีตัวเลขอื่น (วันที่ ขนาดยา เลขเตียง) ปนน้อยกว่าทั้งหน้ามาก
      และสำคัญกว่านั้น: อ่านทั้งหน้า OCR เรียงเลขจากบนลงล่าง HN ที่อยู่ท้ายใบจึงมักตกเพดาน MAX_CANDIDATES
      เลขจาก roi ได้ที่นั่งก่อนและชนะเมื่อสถานะการนอนเท่ากัน
      ถ้า roi เจอคนที่ส่งใบจากหอนี้ได้แล้ว ไม่ต้องอ่านทั้งหน้าซ้ำ เร็วขึ้นด้วย
      ไม่เจอ (ใบรูปแบบอื่น สแกนกลับหัว) ค่อยอ่านทั้งหน้าเหมือนเดิม
    */
    const roiHits = new Set<string>();
    /* เลขที่ติดคำว่า HN หรือเป็นรูปแบบ 000XXXXXX */
    const strongHits = new Set<string>();
    let region: 'roi' | 'full' | null = null;
    const sourceOf = new Map<string, Source>();
    let candidates: string[] = [];
    let verified = await verifyAgainstHis([], wardCode);

    const settle = async (ocrHns: string[]) => {
        sourceOf.clear();
        /* กันที่ให้เลขจากบาร์โค้ด/ชั้นข้อความเสมอ ไม่ให้เลขจาก OCR เบียดตกเพดาน */
        const keep = Math.max(0, MAX_CANDIDATES - fromGiven.length);
        for (const hn of ocrHns.filter(h => !fromGiven.includes(h)).slice(0, keep)) sourceOf.set(hn, 'ocr');
        // เลขจากบาร์โค้ด/ชั้นข้อความทับของ OCR เสมอ เพราะไม่ได้มาจากการเดารูปตัวอักษร
        for (const hn of fromGiven) sourceOf.set(hn, givenSource);
        candidates = [...sourceOf.keys()].slice(0, MAX_CANDIDATES);
        verified = await verifyAgainstHis(candidates, wardCode);
    };

    /*
      ใบที่มีบาร์โค้ด หน้าจอส่งทั้งเลขจากบาร์โค้ดและภาพมาด้วยกัน
      บาร์โค้ดบนใบหลายแบบไม่ใช่ HN (เช่นเลขใบสั่ง 12 หลัก) ถ้าหยุดที่บาร์โค้ดจะไม่เคยได้อ่าน "HN 000XXXXXX" บนใบเลย
      จึงเช็กเลขบาร์โค้ดกับ HIS ก่อน: เป็นผู้ป่วยหอนี้แล้วจบเลย (เร็วเหมือนเดิม) ไม่ใช่ค่อยอ่านภาพต่อ
    */
    const givenInWard = async () => {
        await settle([]);
        return candidates.some(hn => verified.adm.get(hn)?.in_ward);
    };

    if (fromGiven.length > 0 && b.file instanceof File && await givenInWard()) {
        /* เลขจากบาร์โค้ด/ชั้นข้อความเป็นผู้ป่วยหอนี้ ไม่ต้อง OCR */
    } else if (roiFile && b.file instanceof File) {
        region = 'roi';
        const roiText = await ocr(roiFile);
        const fromRoi = hnCandidatesFrom(roiText);
        for (const hn of fromRoi) roiHits.add(hn);
        for (const hn of strongHnsFrom(roiText)) strongHits.add(hn);
        await settle(fromRoi);
        const found = candidates.some(hn => roiHits.has(hn) && verified.adm.get(hn)?.in_ward);
        if (!found && !ocrUnavailable) {
            region = 'full';
            /* roi อ่านพังแต่ทั้งหน้าอ่านได้ ไม่นับว่าล้มเหลว */
            ocrFailed = false;
            ocrText = await ocr(b.file);
            for (const hn of strongHnsFrom(ocrText)) strongHits.add(hn);
            /* เลขจาก roi นำหน้า แล้วต่อด้วยเลขจากทั้งหน้าที่ยังไม่ซ้ำ */
            await settle([...new Set([...fromRoi, ...hnCandidatesFrom(ocrText)])]);
        }
    } else if (b.file instanceof File) {
        region = 'full';
        ocrText = await ocr(b.file);
        for (const hn of strongHnsFrom(ocrText)) strongHits.add(hn);
        await settle(hnCandidatesFrom(ocrText));
    } else {
        await settle([]);
    }
    const { adm, names, down } = verified;

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
                /*
                  ส่งชื่อกลับเฉพาะคนที่ส่งใบจากหอนี้ได้ (in_ward)
                  เลขที่อ่านได้มักเป็นเลขหลง (วันที่ เลขใบสั่ง) ซึ่งตรงกับคนไข้จริงคนอื่นเกือบทุกครั้ง
                  ไม่ควรเปิดชื่อคนไข้ที่ไม่ได้อยู่ในความดูแลของหอนี้ให้เห็น
                */
                ptname: a?.in_ward ? names.get(hn) ?? '' : '',
                bedno: a?.in_ward ? a.bedno : null,
                an: a?.an ?? null,
                ward_name: a?.ward_name ?? null,
                admission: a?.admission ?? 'none',
                discharged_at: a?.discharged_at ?? null,
                in_ward: a?.in_ward ?? false,
                source,
            };
        })
        .sort((x, y) => ADMISSION_RANK[x.admission] - ADMISSION_RANK[y.admission]
            || SOURCE_RANK[x.source] - SOURCE_RANK[y.source]
            /* สถานะเท่ากัน เลขที่ติดคำว่า HN / รูปแบบ 000XXXXXX น่าเชื่อกว่าเลขอื่น */
            || Number(!strongHits.has(x.hn)) - Number(!strongHits.has(y.hn))
            /* สถานะเท่ากัน เลขที่อยู่ตรงตำแหน่ง HN ของใบน่าเชื่อกว่าเลขที่อยู่กลางใบ */
            || Number(!roiHits.has(x.hn)) - Number(!roiHits.has(y.hn)));

    return {
        success: true,
        /* ทุกเลขที่อ่านได้ ส่งกลับไปให้เห็นด้วย เวลาอ่านผิดจะได้รู้ว่าผิดเป็นอะไร */
        read: candidates,
        matches,
        his_down: down,
        ocr_failed: ocrFailed,
        ocr_unavailable: ocrUnavailable,
        ocr_engine: engine,
        /* อ่านจบที่บริเวณ HN (roi) หรือต้องอ่านทั้งหน้า — ไว้ดูว่าการตัดภาพช่วยได้กี่ใบ */
        ocr_region: region,
    };
};

/**
 * ผู้ป่วยที่ส่งใบจากตึกนี้ได้ ให้พยาบาลกดเลือกแทนการพิมพ์ HN
 *
 * ใช้ admissionsOf ตัดสินซ้ำ ไม่เชื่อแถวที่ยังเปิดอยู่ตรง ๆ
 * เพราะมีการนอนเก่าที่ลืมปิดค้างอยู่ คนที่ย้ายไปตึกอื่นแล้วจะโผล่มาในรายการถ้าไม่ตรวจซ้ำ
 * รายการนี้จึงตรงกับกฎที่เซิร์ฟเวอร์ใช้รับใบเสมอ เลือกจากรายการแล้วส่งไม่ผ่านไม่ได้
 */
export const listWardPatients = async ({ query, set }: Context) => {
    const ward = Number((query as { ward?: string } | undefined)?.ward);
    const wardCode = await hisWardCode(ward);
    if (!wardCode) {
        set.status = 400;
        return { success: false, message: 'ตึกนี้ยังไม่ได้ผูกรหัสตึกกับ HIS' };
    }
    try {
        const [rows] = await his.execute<RowDataPacket[]>(
            `SELECT DISTINCT hn FROM ipt
             WHERE ward = ? AND (dchstts IS NULL OR dchdate >= CURDATE() - INTERVAL ? DAY)
             LIMIT 400`,
            [wardCode, SUBMIT_DISCHARGE_DAYS],
        );
        const hns = rows.map(r => String(r.hn ?? '')).filter(Boolean);
        if (hns.length === 0) return { success: true, data: [] };
        const [adm, names] = await Promise.all([admissionsOf(hns, wardCode), namesOf(hns)]);
        /* เตียงมากับ admissionsOf (iptadm) แล้ว — พยาบาลจำผู้ป่วยตามเตียงได้เร็วกว่าชื่อ */
        const data = hns
            .filter(hn => adm.get(hn)?.in_ward)
            .map(hn => {
                const a = adm.get(hn)!;
                return {
                    hn, ptname: names.get(hn) ?? '', an: a.an, ward_name: a.ward_name,
                    bedno: a.bedno,
                    admission: a.admission, discharged_at: a.discharged_at, in_ward: true,
                };
            })
            /* เรียงตามเตียง น้อยไปมาก (เลขในชื่อเตียงเทียบเป็นตัวเลข 2 มาก่อน 10) · ไม่มีเตียงไว้ท้าย */
            .sort((x, y) => (x.bedno === null ? 1 : 0) - (y.bedno === null ? 1 : 0)
                || (x.bedno ?? '').localeCompare(y.bedno ?? '', 'th', { numeric: true })
                || x.ptname.localeCompare(y.ptname, 'th'));
        return { success: true, data };
    } catch (error) {
        console.error('List ward patients error:', error);
        return { success: true, data: [], his_down: true };
    }
};
