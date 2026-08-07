/**
 * โครงสร้างแม่แบบแผนการพยาบาลแบบ Focus list
 *
 * แม่แบบหนึ่งใบ = หลายระยะ (section) แต่ละระยะมีสองคอลัมน์
 *   ซ้าย  activities  — กิจกรรมการพยาบาล เป็นข้อความสำเร็จรูป พยาบาลไม่แก้
 *   ขวา   evaluations — รายการประเมินผลที่ต้องติ๊กหรือเติมค่า
 *
 * ตัวตรวจในไฟล์นี้ใช้สองที่: ตอน admin บันทึกแม่แบบ และตอนพยาบาลส่งคำตอบ
 * เขียนไว้ที่เดียวเพื่อไม่ให้กติกาสองฝั่งเพี้ยนจากกัน
 */

export type EvalKind = 'check' | 'choice' | 'number' | 'text' | 'time';

export const EVAL_KINDS: EvalKind[] = ['check', 'choice', 'number', 'text', 'time'];

export interface EvalItem {
    id: string;
    kind: EvalKind;
    label: string;
    /** number — หน่วยที่แสดงต่อท้ายช่อง เช่น % / มม.ปรอท / ครั้งต่อนาที */
    unit?: string | null;
    min?: number | null;
    max?: number | null;
    /** choice — ตัวเลือกที่กำหนดไว้ เช่น ["ใช่","ไม่ใช่"] หรือ ["พบ","ไม่พบ"] */
    options?: string[];
    /** choice — ให้พิมพ์คำตอบนอกตัวเลือกได้ (ช่อง "…(ระบุ)" ในฟอร์มกระดาษ) */
    allow_other?: boolean;
}

export interface Section {
    id: string;
    title: string;
    activities: string[];
    evaluations: EvalItem[];
}

export interface TemplateBody {
    sections: Section[];
}

const MAX = {
    sections: 20,
    activities: 40,
    evaluations: 40,
    label: 300,
    activity: 1000,
    title: 200,
    options: 20,
    option: 100,
    unit: 30,
    id: 40,
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** รหัสรายการต้องเป็นตัวอักษร/ตัวเลข/ขีด เพราะถูกใช้เป็นคีย์ใน jsonb และเป็นชื่อฟิลด์ฝั่งหน้าจอ */
const validId = (v: string): boolean => /^[A-Za-z0-9_-]{1,40}$/.test(v);

/**
 * ตรวจและทำความสะอาดโครงแม่แบบ
 * คืน error เป็นข้อความไทยที่บอกตำแหน่งได้ เพราะ admin เป็นคนกรอกเองไม่ใช่โปรแกรม
 */
export const normalizeTemplateBody = (
    raw: unknown
): { error: string } | { body: TemplateBody } => {
    const input = (raw ?? {}) as { sections?: unknown };
    const sections = Array.isArray(input.sections) ? input.sections : null;

    if (!sections) return { error: 'โครงแม่แบบต้องมี sections เป็นรายการ' };
    if (sections.length === 0) return { error: 'แม่แบบต้องมีอย่างน้อย 1 ระยะ' };
    if (sections.length > MAX.sections) return { error: `ระยะได้ไม่เกิน ${MAX.sections} ระยะ` };

    const seenSection = new Set<string>();
    const seenItem = new Set<string>();
    const out: Section[] = [];

    for (let s = 0; s < sections.length; s++) {
        const src = (sections[s] ?? {}) as Record<string, unknown>;
        const where = `ระยะที่ ${s + 1}`;

        const id = str(src.id);
        if (!validId(id)) return { error: `${where}: รหัสระยะไม่ถูกต้อง (ใช้ A-Z a-z 0-9 _ - เท่านั้น)` };
        if (seenSection.has(id)) return { error: `${where}: รหัสระยะ "${id}" ซ้ำกับระยะอื่น` };
        seenSection.add(id);

        const title = str(src.title);
        if (!title) return { error: `${where}: กรุณาระบุชื่อระยะ` };
        if (title.length > MAX.title) return { error: `${where}: ชื่อระยะยาวเกิน ${MAX.title} ตัวอักษร` };

        const rawActivities = Array.isArray(src.activities) ? src.activities : [];
        if (rawActivities.length > MAX.activities) {
            return { error: `${where}: กิจกรรมได้ไม่เกิน ${MAX.activities} ข้อ` };
        }
        const activities: string[] = [];
        for (const a of rawActivities) {
            const text = str(a);
            if (!text) continue; // บรรทัดว่างจากการกด "เพิ่มข้อ" แล้วไม่พิมพ์ ตัดทิ้งเงียบๆ ได้
            if (text.length > MAX.activity) {
                return { error: `${where}: กิจกรรมข้อหนึ่งยาวเกิน ${MAX.activity} ตัวอักษร` };
            }
            activities.push(text);
        }

        const rawEvals = Array.isArray(src.evaluations) ? src.evaluations : [];
        if (rawEvals.length > MAX.evaluations) {
            return { error: `${where}: รายการประเมินผลได้ไม่เกิน ${MAX.evaluations} รายการ` };
        }

        const evaluations: EvalItem[] = [];
        for (let e = 0; e < rawEvals.length; e++) {
            const item = (rawEvals[e] ?? {}) as Record<string, unknown>;
            const at = `${where} รายการประเมินที่ ${e + 1}`;

            const itemId = str(item.id);
            if (!validId(itemId)) return { error: `${at}: รหัสรายการไม่ถูกต้อง (ใช้ A-Z a-z 0-9 _ - เท่านั้น)` };
            // ต้องไม่ซ้ำทั้งใบ ไม่ใช่แค่ในระยะ เพราะคำตอบเก็บแบนเป็น { itemId: value }
            if (seenItem.has(itemId)) return { error: `${at}: รหัสรายการ "${itemId}" ซ้ำกับรายการอื่นในแม่แบบ` };
            seenItem.add(itemId);

            const kind = str(item.kind) as EvalKind;
            if (!EVAL_KINDS.includes(kind)) {
                return { error: `${at}: ชนิดรายการไม่ถูกต้อง (${EVAL_KINDS.join(' / ')})` };
            }

            const label = str(item.label);
            if (!label) return { error: `${at}: กรุณาระบุข้อความของรายการ` };
            if (label.length > MAX.label) return { error: `${at}: ข้อความยาวเกิน ${MAX.label} ตัวอักษร` };

            const next: EvalItem = { id: itemId, kind, label };

            if (kind === 'number') {
                const unit = str(item.unit);
                if (unit.length > MAX.unit) return { error: `${at}: หน่วยยาวเกิน ${MAX.unit} ตัวอักษร` };
                next.unit = unit || null;

                const min = item.min === null || item.min === undefined || item.min === '' ? null : Number(item.min);
                const max = item.max === null || item.max === undefined || item.max === '' ? null : Number(item.max);
                if (min !== null && !Number.isFinite(min)) return { error: `${at}: ค่าต่ำสุดไม่ใช่ตัวเลข` };
                if (max !== null && !Number.isFinite(max)) return { error: `${at}: ค่าสูงสุดไม่ใช่ตัวเลข` };
                if (min !== null && max !== null && min > max) {
                    return { error: `${at}: ค่าต่ำสุดมากกว่าค่าสูงสุด` };
                }
                next.min = min;
                next.max = max;
            }

            if (kind === 'choice') {
                const rawOptions = Array.isArray(item.options) ? item.options : [];
                const options: string[] = [];
                for (const o of rawOptions) {
                    const text = str(o);
                    if (!text) continue;
                    if (text.length > MAX.option) return { error: `${at}: ตัวเลือกยาวเกิน ${MAX.option} ตัวอักษร` };
                    if (options.includes(text)) return { error: `${at}: ตัวเลือก "${text}" ซ้ำ` };
                    options.push(text);
                }
                const allowOther = item.allow_other === true;
                // ตัวเลือกเดียวใช้ได้เมื่อเปิดช่อง "…(ระบุ)" ไว้ ซึ่งเป็นรูปแบบที่ฟอร์มกระดาษใช้จริง
                // เช่น EKG ❑ normal sinus rhythm หรือ ❑………(ระบุ)
                const minOptions = allowOther ? 1 : 2;
                if (options.length < minOptions) {
                    return {
                        error: allowOther
                            ? `${at}: ต้องมีตัวเลือกอย่างน้อย 1 ตัว`
                            : `${at}: ต้องมีตัวเลือกอย่างน้อย 2 ตัว หรือเปิดให้พิมพ์คำตอบเองได้`,
                    };
                }
                if (options.length > MAX.options) return { error: `${at}: ตัวเลือกได้ไม่เกิน ${MAX.options} ตัว` };
                next.options = options;
                next.allow_other = allowOther;
            }

            evaluations.push(next);
        }

        if (activities.length === 0 && evaluations.length === 0) {
            return { error: `${where}: ต้องมีกิจกรรมหรือรายการประเมินผลอย่างน้อยอย่างละหนึ่ง` };
        }

        out.push({ id, title, activities, evaluations });
    }

    return { body: { sections: out } };
};

/** รายการประเมินผลทั้งใบ แผ่เป็นตารางค้นด้วยรหัส */
export const evalItemsOf = (body: unknown): Map<string, EvalItem> => {
    const map = new Map<string, EvalItem>();
    const sections = (body as TemplateBody | null)?.sections;
    if (!Array.isArray(sections)) return map;
    for (const section of sections) {
        for (const item of section.evaluations ?? []) {
            if (item?.id) map.set(item.id, item);
        }
    }
    return map;
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TEXT_ANSWER = 500;

/**
 * ตรวจคำตอบของพยาบาลกับโครงที่ติดมากับบันทึกใบนั้น
 *
 * ตรวจกับสำเนาโครงในบันทึก ไม่ใช่แม่แบบปัจจุบัน เพราะแม่แบบอาจถูกแก้ไปแล้ว
 * และคีย์ที่ไม่มีในโครงถูกปฏิเสธ ไม่ใช่ตัดทิ้งเงียบๆ — พยาบาลจะได้รู้ว่าบางค่าไม่ถูกเก็บ
 */
export const validateAnswers = (
    structure: unknown,
    raw: unknown
): { error: string } | { answers: Record<string, boolean | number | string> } => {
    const items = evalItemsOf(structure);
    const input = (raw ?? {}) as Record<string, unknown>;

    if (typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'ผลการประเมินต้องเป็นชุดข้อมูลแบบคีย์-ค่า' };
    }

    const answers: Record<string, boolean | number | string> = {};

    for (const [key, value] of Object.entries(input)) {
        const item = items.get(key);
        if (!item) return { error: `ไม่พบรายการประเมิน "${key}" ในแม่แบบของบันทึกนี้` };

        // ยังไม่ตอบ = ไม่ต้องเก็บ ต่างจากตอบว่า "ไม่" ซึ่งเก็บเป็น false
        if (value === null || value === undefined || value === '') continue;

        const at = `"${item.label}"`;

        switch (item.kind) {
            case 'check': {
                if (typeof value !== 'boolean') return { error: `${at}: ต้องเป็นค่าติ๊กหรือไม่ติ๊ก` };
                answers[key] = value;
                break;
            }
            case 'number': {
                const n = Number(value);
                if (!Number.isFinite(n)) return { error: `${at}: ต้องเป็นตัวเลข` };
                if (item.min !== null && item.min !== undefined && n < item.min) {
                    return { error: `${at}: ต้องไม่น้อยกว่า ${item.min}` };
                }
                if (item.max !== null && item.max !== undefined && n > item.max) {
                    return { error: `${at}: ต้องไม่เกิน ${item.max}` };
                }
                answers[key] = n;
                break;
            }
            case 'choice': {
                const text = String(value).trim();
                if (!text) continue;
                const known = (item.options ?? []).includes(text);
                if (!known && !item.allow_other) {
                    return { error: `${at}: "${text}" ไม่อยู่ในตัวเลือกที่กำหนด` };
                }
                if (text.length > MAX_TEXT_ANSWER) {
                    return { error: `${at}: ข้อความยาวเกิน ${MAX_TEXT_ANSWER} ตัวอักษร` };
                }
                answers[key] = text;
                break;
            }
            case 'time': {
                const text = String(value).trim();
                if (!TIME_RE.test(text)) return { error: `${at}: เวลาต้องอยู่ในรูปแบบ ชช:นน (00:00-23:59)` };
                answers[key] = text;
                break;
            }
            case 'text': {
                const text = String(value).trim();
                if (!text) continue;
                if (text.length > MAX_TEXT_ANSWER) {
                    return { error: `${at}: ข้อความยาวเกิน ${MAX_TEXT_ANSWER} ตัวอักษร` };
                }
                answers[key] = text;
                break;
            }
        }
    }

    return { answers };
};

/** จำนวนรายการประเมินผลที่ตอบแล้ว ใช้แสดงความคืบหน้าและใช้ตัดสินว่าปิดใบได้หรือยัง */
export const answeredCount = (structure: unknown, answers: unknown): { answered: number; total: number } => {
    const items = evalItemsOf(structure);
    const given = (answers ?? {}) as Record<string, unknown>;
    let answered = 0;
    for (const key of items.keys()) {
        const v = given[key];
        if (v === null || v === undefined || v === '') continue;
        answered += 1;
    }
    return { answered, total: items.size };
};
