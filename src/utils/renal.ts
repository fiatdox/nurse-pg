/**
 * การทำงานของไต — สูตรเดียวกับระบบ DUE (pyhos-due: app/lib/renal.ts)
 * ใช้สูตรตรงกันทั้งสองระบบ เภสัชที่เปิดดูสองที่จะได้ค่าเท่ากัน ไม่ต้องสงสัยว่าอันไหนถูก
 *
 * เพศใช้รหัสของ HOSxP: "1" = ชาย, "2" = หญิง
 */

export type Sex = '1' | '2';

const round2 = (value: number) => Math.round(value * 100) / 100;

/** eGFR สูตร CKD-EPI 2009 (ไม่มีตัวแปรเชื้อชาติ) — mL/min/1.73m² */
export const egfrCkdEpi = (scr: number, age: number, sex: Sex): number | null => {
    if (!(scr > 0) || !(age >= 0)) return null;
    const [k, alpha, base] = sex === '2'
        ? [0.7, scr <= 0.7 ? -0.329 : -1.209, 144]
        : [0.9, scr <= 0.9 ? -0.411 : -1.209, 141];
    return round2(base * Math.pow(scr / k, alpha) * Math.pow(0.993, age));
};

/** CrCl สูตร Cockcroft-Gault — mL/min (หญิง × 0.85) */
export const crclCockcroftGault = (scr: number, age: number, weightKg: number, sex: Sex): number | null => {
    if (!(scr > 0) || !(age >= 0) || !(weightKg > 0)) return null;
    const value = ((140 - age) * weightKg) / (72 * scr);
    return round2(sex === '2' ? value * 0.85 : value);
};

/** อายุเต็มปี ณ วันที่ตรวจ — วันเกิดไม่รู้ (0000-…) คืน null */
export const ageAt = (birthday: string | null, date: string): number | null => {
    if (!birthday || birthday.startsWith('0000')) return null;
    const [by, bm, bd] = birthday.slice(0, 10).split('-').map(Number);
    const [y, m, d] = date.slice(0, 10).split('-').map(Number);
    if (![by, bm, bd, y, m, d].every(Number.isFinite)) return null;
    return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};
