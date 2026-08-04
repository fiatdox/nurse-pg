/**
 * NEWS2 (National Early Warning Score 2, RCP 2017) และช่วงค่าปกติตามอายุ
 *
 * ฝั่ง frontend มีสำเนาไว้ที่ app/lib/news2.ts เพื่อแสดงคะแนนสดขณะพิมพ์เท่านั้น
 * ค่าที่บันทึกลงฐานข้อมูลใช้ผลจากไฟล์นี้เสมอ — client แก้คะแนนเองไม่ได้
 * ถ้าแก้เกณฑ์ที่นี่ ต้องแก้อีกฝั่งให้ตรงกันด้วย
 */

export type Avpu = 'A' | 'C' | 'V' | 'P' | 'U';

export interface News2Input {
    resp_rate?: number | null;
    spo2?: number | null;
    on_oxygen?: boolean;
    temperature?: number | null;
    systolic_bp?: number | null;
    pulse?: number | null;
    avpu?: Avpu | null;
    /** Scale 2 ใช้กับผู้ป่วยที่มีเป้าหมาย SpO2 88–92% เช่น COPD ที่คั่ง CO2 */
    scale?: 1 | 2;
}

export interface News2Param {
    key: string;
    label: string;
    value: number | string | null;
    score: number | null;
}

export interface News2Result {
    score: number | null;
    /** พารามิเตอร์ที่ได้ 3 คะแนนเดี่ยว ต้องเร่งดูแม้คะแนนรวมจะต่ำ */
    hasSingleThree: boolean;
    risk: 'low' | 'low_medium' | 'medium' | 'high' | null;
    monitorFreq: string | null;
    response: string | null;
    params: News2Param[];
    /** พารามิเตอร์ที่ครบสำหรับให้คะแนน (เต็ม 7) — ต่ำกว่านี้คะแนนรวมยังตีความไม่ได้ */
    completeness: number;
}

const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const scoreResp = (v: number): number =>
    v <= 8 ? 3 : v <= 11 ? 1 : v <= 20 ? 0 : v <= 24 ? 2 : 3;

const scoreSpo2Scale1 = (v: number): number =>
    v <= 91 ? 3 : v <= 93 ? 2 : v <= 95 ? 1 : 0;

/** Scale 2 ให้คะแนนต่างกันเมื่ออยู่บนออกซิเจน เพราะค่าสูงเกินเป้าหมายถือว่าอันตราย */
const scoreSpo2Scale2 = (v: number, onOxygen: boolean): number => {
    if (v <= 83) return 3;
    if (v <= 85) return 2;
    if (v <= 87) return 1;
    if (v <= 92) return 0;
    if (!onOxygen) return 0;
    return v <= 94 ? 1 : v <= 96 ? 2 : 3;
};

const scoreTemp = (v: number): number =>
    v <= 35.0 ? 3 : v <= 36.0 ? 1 : v <= 38.0 ? 0 : v <= 39.0 ? 1 : 2;

const scoreSbp = (v: number): number =>
    v <= 90 ? 3 : v <= 100 ? 2 : v <= 110 ? 1 : v <= 219 ? 0 : 3;

const scorePulse = (v: number): number =>
    v <= 40 ? 3 : v <= 50 ? 1 : v <= 90 ? 0 : v <= 110 ? 1 : v <= 130 ? 2 : 3;

const scoreAvpu = (v: Avpu): number => (v === 'A' ? 0 : 3);

/** NEWS2 ใช้ได้กับอายุ 16 ปีขึ้นไปเท่านั้น เด็กต้องใช้ PEWS ซึ่งมีเกณฑ์คนละชุด */
export const NEWS2_MIN_AGE = 16;

export const calcNews2 = (input: News2Input): News2Result => {
    const scale: 1 | 2 = input.scale === 2 ? 2 : 1;
    const onOxygen = input.on_oxygen === true;

    const rr = num(input.resp_rate);
    const spo2 = num(input.spo2);
    const temp = num(input.temperature);
    const sbp = num(input.systolic_bp);
    const pulse = num(input.pulse);
    const avpu = input.avpu ?? null;

    const params: News2Param[] = [
        { key: 'resp_rate', label: 'อัตราการหายใจ', value: rr, score: rr === null ? null : scoreResp(rr) },
        {
            key: 'spo2',
            label: `SpO₂ (Scale ${scale})`,
            value: spo2,
            score: spo2 === null ? null : scale === 2 ? scoreSpo2Scale2(spo2, onOxygen) : scoreSpo2Scale1(spo2),
        },
        { key: 'oxygen', label: 'ได้รับออกซิเจน', value: onOxygen ? 'ใช่' : 'ไม่ (room air)', score: onOxygen ? 2 : 0 },
        { key: 'systolic_bp', label: 'ความดันตัวบน', value: sbp, score: sbp === null ? null : scoreSbp(sbp) },
        { key: 'pulse', label: 'ชีพจร', value: pulse, score: pulse === null ? null : scorePulse(pulse) },
        { key: 'temperature', label: 'อุณหภูมิ', value: temp, score: temp === null ? null : scoreTemp(temp) },
        { key: 'avpu', label: 'ระดับความรู้สึกตัว', value: avpu, score: avpu === null ? null : scoreAvpu(avpu) },
    ];

    const scored = params.filter(p => p.score !== null);
    const completeness = scored.length;

    // ต้องมีครบทั้ง 7 ตัวจึงจะตีความคะแนนรวมได้ตามมาตรฐาน
    if (completeness < params.length) {
        return {
            score: null, hasSingleThree: false, risk: null,
            monitorFreq: null, response: null, params, completeness,
        };
    }

    const score = scored.reduce((sum, p) => sum + (p.score as number), 0);
    const hasSingleThree = scored.some(p => p.score === 3);

    let risk: News2Result['risk'];
    let monitorFreq: string;
    let response: string;

    if (score >= 7) {
        risk = 'high';
        monitorFreq = 'เฝ้าระวังต่อเนื่อง (continuous)';
        response = 'ตามทีมฉุกเฉิน/ICU ทันที ประเมินโดยแพทย์ที่มีทักษะเวชบำบัดวิกฤต';
    } else if (score >= 5) {
        risk = 'medium';
        monitorFreq = 'ทุก 1 ชั่วโมง';
        response = 'รายงานแพทย์เจ้าของไข้ทันที ประเมินซ้ำโดยทีมที่ดูแลผู้ป่วยเฉียบพลัน';
    } else if (hasSingleThree) {
        risk = 'low_medium';
        monitorFreq = 'อย่างน้อยทุก 1 ชั่วโมง';
        response = 'รายงานพยาบาลหัวหน้าเวร ให้แพทย์ประจำหอผู้ป่วยประเมินโดยเร็ว';
    } else if (score >= 1) {
        risk = 'low';
        monitorFreq = 'ทุก 4–6 ชั่วโมง';
        response = 'พยาบาลวิชาชีพประเมินซ้ำ พิจารณาเพิ่มความถี่การวัด';
    } else {
        risk = 'low';
        monitorFreq = 'ทุก 12 ชั่วโมง';
        response = 'เฝ้าระวังตามปกติ';
    }

    return { score, hasSingleThree, risk, monitorFreq, response, params, completeness };
};

// ---------- ช่วงค่าปกติตามอายุ ----------

export type AgeGroup =
    | 'neonate' | 'infant' | 'toddler' | 'preschool'
    | 'school' | 'adolescent' | 'adult' | 'elderly';

export const ageGroupOf = (years: number | null): AgeGroup | null => {
    if (years === null || !Number.isFinite(years) || years < 0) return null;
    if (years < 1 / 12) return 'neonate';
    if (years < 1) return 'infant';
    if (years < 3) return 'toddler';
    if (years < 6) return 'preschool';
    if (years < 12) return 'school';
    if (years < 18) return 'adolescent';
    if (years < 65) return 'adult';
    return 'elderly';
};

/** [min, max] ของค่าปกติ ใช้ไฮไลต์ค่าผิดปกติ ไม่ใช่เกณฑ์ให้คะแนน */
export const REFERENCE_RANGE: Record<AgeGroup, {
    pulse: [number, number];
    resp: [number, number];
    sbp: [number, number];
    spo2: [number, number];
}> = {
    neonate:    { pulse: [100, 180], resp: [30, 60], sbp: [60, 90],   spo2: [95, 100] },
    infant:     { pulse: [100, 160], resp: [30, 53], sbp: [72, 104],  spo2: [95, 100] },
    toddler:    { pulse: [90, 150],  resp: [22, 37], sbp: [86, 106],  spo2: [95, 100] },
    preschool:  { pulse: [80, 140],  resp: [20, 28], sbp: [89, 112],  spo2: [95, 100] },
    school:     { pulse: [70, 120],  resp: [18, 25], sbp: [97, 115],  spo2: [95, 100] },
    adolescent: { pulse: [60, 100],  resp: [12, 20], sbp: [110, 131], spo2: [95, 100] },
    adult:      { pulse: [60, 100],  resp: [12, 20], sbp: [90, 140],  spo2: [95, 100] },
    elderly:    { pulse: [60, 100],  resp: [12, 20], sbp: [90, 150],  spo2: [94, 100] },
};

/** ค่าปกติของอุณหภูมิขึ้นกับวิธีวัด ไม่ใช่อายุ */
export const TEMP_RANGE: Record<string, [number, number]> = {
    oral:     [36.5, 37.5],
    axillary: [36.5, 37.3],
    tympanic: [36.8, 37.8],
    rectal:   [37.0, 38.0],
    temporal: [36.4, 37.6],
};

export const ageYearsFrom = (birthday: unknown): number | null => {
    if (!birthday) return null;
    const d = birthday instanceof Date ? birthday : new Date(String(birthday));
    if (isNaN(d.getTime())) return null;
    const ms = Date.now() - d.getTime();
    if (ms < 0) return null;
    const years = ms / (365.2425 * 24 * 60 * 60 * 1000);
    return years > 130 ? null : years;
};
