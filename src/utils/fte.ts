/**
 * สูตรคิด FTE และ product ของฝ่ายการพยาบาล
 *
 * ที่มาคือไฟล์ FTE NS ปี68.xlsx ที่ใช้กันมาก่อนมีระบบนี้ ทุกสูตรอ้างคอลัมน์ในไฟล์นั้นกำกับไว้
 * แยกออกมาเป็นฟังก์ชันล้วนที่ไม่แตะฐานข้อมูล จะได้ทดสอบเทียบกับตัวเลขในไฟล์ต้นฉบับได้ตรงๆ
 * ตัวเลขชุดนี้ถูกส่งเป็นรายงานให้ผู้บริหารและใช้เทียบข้ามหอ สูตรจึงต้องอยู่ที่เดียว
 */

/** ชั่วโมงทำงานต่อเวรของเจ้าหน้าที่หนึ่งคน — ตัวหารในทุกสูตร product */
export const HOURS_PER_SHIFT = 7;

/** จำนวนเวรต่อวัน — ใช้เฉลี่ยชั่วโมงการพยาบาลรายวันลงมาเป็นรายเวร */
const SHIFTS_PER_DAY = 3;

/**
 * สัดส่วนที่ไฟล์ต้นฉบับใช้กับ "แถวรวมทั้งเดือน"
 *
 * E103/E104/E105 อ้าง $M$4 (สัดส่วนเวรบ่าย) กับทั้งสามเวร
 * และ N103/N104/N105 อ้าง $E$4 (สัดส่วนเวรดึก) กับทั้งสามเวรเช่นกัน
 * ซึ่งไม่ตรงกับสูตรรายวันที่ใช้สัดส่วนของเวรตัวเอง
 *
 * ผู้ใช้เลือกให้ทำตามไฟล์เดิมทุกประการ เพื่อให้ตัวเลขตรงกับรายงานที่เคยส่งไปแล้ว
 * จึงคงไว้ตามนี้ และหน้าจอมีหมายเหตุกำกับว่าแถวรวมคิดคนละเกณฑ์กับรายวัน
 */
export const MONTHLY_FTE_WEIGHT = 0.35;
export const MONTHLY_PRODUCT_WEIGHT = 0.25;

/**
 * ตัวคูณที่ไฟล์ต้นฉบับฝังไว้ในช่อง "จำนวนพยาบาลตาม FTE" (C6)
 *
 * C6 ใช้ 12 กับผู้ป่วยทั้งสองกลุ่ม ทั้งที่บรรทัดถัดมา (N6) ใช้ค่าของหอกับกลุ่มทั่วไป
 * เป็นความไม่สอดคล้องในไฟล์เอง แต่ผู้ใช้เลือกให้ทำตามไฟล์
 */
export const FTE_HEADCOUNT_HOURS = 12;

export interface ShiftStaff {
    rn: number; tn: number; pn: number;
    ot8_rn: number; ot8_tn: number; ot8_pn: number;
    ot4_rn: number; ot4_tn: number; ot4_pn: number;
}

export const emptyStaff = (): ShiftStaff => ({
    rn: 0, tn: 0, pn: 0,
    ot8_rn: 0, ot8_tn: 0, ot8_pn: 0,
    ot4_rn: 0, ot4_tn: 0, ot4_pn: 0,
});

export const addStaff = (a: ShiftStaff, b: ShiftStaff): ShiftStaff => ({
    rn: a.rn + b.rn, tn: a.tn + b.tn, pn: a.pn + b.pn,
    ot8_rn: a.ot8_rn + b.ot8_rn, ot8_tn: a.ot8_tn + b.ot8_tn, ot8_pn: a.ot8_pn + b.ot8_pn,
    ot4_rn: a.ot4_rn + b.ot4_rn, ot4_tn: a.ot4_tn + b.ot4_tn, ot4_pn: a.ot4_pn + b.ot4_pn,
});

/**
 * คนที่ขึ้นเวรปกติ ไม่นับ OT — ตัวตั้งของช่องขาด/เกิน (คอลัมน์ M)
 *
 * ไม่นับ OT โดยตั้งใจ ช่องนี้วัดว่าอัตรากำลังปกติพอไหม
 * ถ้านับ OT เข้าไปด้วย หอที่ต้องเรียก OT ทุกวันจะดูเหมือนกำลังพอ
 * แล้วปัญหาขาดคนจะไม่ปรากฏในรายงาน
 */
export const regularCount = (s: ShiftStaff) => s.rn + s.tn + s.pn;

/** คนทั้งหมดรวม OT — ตัวหารของ product ทั้งสองตัว (คอลัมน์ N และ U) */
export const totalCount = (s: ShiftStaff) =>
    s.rn + s.tn + s.pn + s.ot8_rn + s.ot8_tn + s.ot8_pn + s.ot4_rn + s.ot4_tn + s.ot4_pn;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** หารแบบไม่ระเบิดเมื่อตัวหารเป็นศูนย์ — เวรที่ไม่มีใครขึ้นต้องได้ null ไม่ใช่ Infinity */
export const safeDiv = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export const pct = (v: number | null) => (v === null ? null : round2(v * 100));

export interface Params {
    general: number;
    crisis: number;
    careHours: Record<number, number>;
}

/** ภาระงานรวมของเวรหนึ่ง หน่วยเป็นชั่วโมงการพยาบาล — ตัวตั้งของสูตร FTE */
export const workload = (ptGeneral: number, ptCrisis: number, p: Params) =>
    p.general * ptGeneral + p.crisis * ptCrisis;

/** FTE จากชั่วโมงภาระงาน = ชั่วโมง × สัดส่วนของเวร ÷ ชั่วโมงต่อเวร — weight 1 คือไม่ถ่วง */
export const fteOfHours = (hours: number, weight: number) => (hours * weight) / HOURS_PER_SHIFT;

/** product จากชั่วโมงภาระงาน เทียบกับชั่วโมงของคนที่ขึ้นจริง (รวม OT) คิดเป็นสัดส่วน */
export const productOfHours = (hours: number, weight: number, staffCount: number) =>
    safeDiv(hours * weight, staffCount * HOURS_PER_SHIFT);

/** FTE = ภาระงาน × สัดส่วนของเวรนั้น ÷ ชั่วโมงต่อเวร (คอลัมน์ E) */
export const fteOf = (ptGeneral: number, ptCrisis: number, weight: number, p: Params) =>
    fteOfHours(workload(ptGeneral, ptCrisis, p), weight);

/** product = ภาระงานที่ต้องการ เทียบกับกำลังที่ใส่ลงไปจริง คิดเป็นร้อยละ (คอลัมน์ N) */
export const productOf = (ptGeneral: number, ptCrisis: number, weight: number, staff: ShiftStaff, p: Params) =>
    productOfHours(workload(ptGeneral, ptCrisis, p), weight, totalCount(staff));

/** ชั่วโมงการพยาบาลต่อเวรตามประเภทผู้ป่วย 1-5 — ตัวตั้งของ product ตามประเภท */
export const typeWorkload = (types: number[], p: Params) =>
    types.reduce((sum, count, i) => sum + count * (p.careHours[i + 1] ?? 0), 0) / SHIFTS_PER_DAY;

/** product ที่คิดจากประเภทผู้ป่วย 1-5 แทนจำนวนหัว (คอลัมน์ U) */
export const productByTypeOf = (types: number[], staff: ShiftStaff, p: Params) =>
    safeDiv(typeWorkload(types, p), totalCount(staff) * HOURS_PER_SHIFT);

/*
  ───── หน่วยงานที่ไม่ใช่หอผู้ป่วย (ER · ห้องผ่าตัด · วิสัญญี · ห้องคลอด · OPD) ─────

  ไฟล์ของแต่ละงานเขียนสูตรต่างกันที่หน้าตา แต่แกะออกมาแล้วเป็นรูปเดียวกันหมด
      ER        H9  = (R×3.2 + E×2.5 + U×1 + semi×0.5 + non×0.24) / 7
      วิสัญญี    F9  = (3.7×(GA+MAC) + recovery×0.75) / 7
      ห้องผ่าตัด E10 = 3.6×(major+minor) / 7
      ห้องคลอด  F10 = (6×คลอดปกติ + 4.5×(C/S+แทรกซ้อน)) × สัดส่วนเวร / 7
      OPD       G4  = (visit×0.2) / 7
  คือ Σ(จำนวนราย × ชั่วโมงต่อราย) แล้วเข้า fteOfHours / productOfHours ตัวเดียวกับหอผู้ป่วย
  ชั่วโมงต่อรายอยู่ในตาราง work_unit_items ไม่ได้ฝังไว้ที่นี่
*/

/** ภาระงานเป็นชั่วโมงการพยาบาล = Σ จำนวนราย × ชั่วโมงต่อราย */
export const itemHours = (qty: number[], hours: number[]) =>
    qty.reduce((sum, q, i) => sum + q * (hours[i] ?? 0), 0);

