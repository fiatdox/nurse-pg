import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { wardUnits, groupInfo, type WardGroup } from '../utils/wardGroup';
import {
    HOURS_PER_SHIFT, emptyStaff, regularCount, totalCount, workload, fteOf, typeWorkload,
    type ShiftStaff, type Params,
} from '../utils/fte';
import { careLevelFlow } from './dashboardController';

/*
  วิเคราะห์อัตรากำลังพยาบาลหลายหอ หลายเวร ตามช่วงวันที่ (ปีงบหรือช่วงที่เลือก)

  หน่วยที่วัดคือ "เวร" = หน่วยงาน × วัน × เวร (ดึก/เช้า/บ่าย)
  ทุกเวรคิดด้วยสูตรเดียวกับหน้า FTE (utils/fte.ts) แล้วค่อยรวมขึ้นไป
  ค่าร้อยละรวมเป็น "ผลรวมตัวตั้ง ÷ ผลรวมตัวหาร" ไม่ใช่ค่าเฉลี่ยของร้อยละ
  เวรที่มีคนสองคนกับเวรที่มีสิบคนจึงมีน้ำหนักตามจริง

  หอที่รวมเป็นหน่วยเดียวกัน (เช่น Nursery + NICU) นับเป็นหน่วยเดียว ค่าน้ำหนักใช้ของหอหลัก
*/

/**
 * ช่วง productivity ที่ถือว่ากำลังพอดีกับภาระงาน (ร้อยละ)
 * ต่ำกว่าช่วง = กำลังเกินภาระงาน · สูงกว่าช่วง = ภาระงานเกินกำลัง (ขาดคน)
 * ใช้ 90–110 ตามที่งานบริหารการพยาบาลใช้กันทั่วไป ปรับที่นี่ที่เดียว หน้าจออ่านค่าจาก API
 */
const PRODUCTIVITY_LOW = 90;
const PRODUCTIVITY_HIGH = 110;

/** ขอบช่องของกราฟการกระจาย productivity รายเวร */
const HIST_EDGES = [70, PRODUCTIVITY_LOW, PRODUCTIVITY_HIGH, 130, 150, Infinity];

/**
 * ช่องของเวรหนึ่งในกราฟการกระจาย — ช่วงเหมาะสมรวมขอบทั้งสองข้าง (90 และ 110 ยังเหมาะสม)
 * ต้องตรงกับการนับ under/over/ok ด้านล่าง ไม่งั้นเวร 110% จะเป็น "เหมาะสม" ในตัวเลขแต่ไปอยู่ช่องแดงในกราฟ
 */
const histIdx = (prod: number) => {
    const e = HIST_EDGES;
    if (prod > PRODUCTIVITY_HIGH) return prod < e[3] ? 3 : prod < e[4] ? 4 : 5;
    if (prod >= PRODUCTIVITY_LOW) return 2;
    return prod < e[0] ? 0 : 1;
};

/** ชั่วโมงขึ้นเวรต่อคน (08-16 / 16-24 / 00-08) และ OT ครึ่งเวร — ใช้กับตารางชั่วโมงรายบุคคล */
const SHIFT_HOURS = 8;
const OT4_HOURS = 4;
/** มาตรฐานชั่วโมงทำงานต่อเดือน (~22 วัน × 8 ชม.) เท่ากับที่หน้าเดิมใช้ */
const MONTHLY_HOURS_STANDARD = 176;
const DAYS_PER_MONTH = 365.25 / 12;

const MAX_DAYS = 366;
const MAX_WARDS = 100;
const ALL_SHIFTS = [1, 2, 3];

/* ───────────────────────── วันที่ ───────────────────────── */

const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(String(v)));
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;
const isoOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
/** จันทร์ = 1 … อาทิตย์ = 7 */
const isoDow = (s: string) => ((new Date(dayNum(s) * 86_400_000).getUTCDay() + 6) % 7) + 1;

type Grain = 'day' | 'week' | 'month';

/** ช่วงสั้นดูรายวัน ช่วงกลางรายสัปดาห์ (เริ่มวันจันทร์) ช่วงยาวรายเดือน */
const grainOf = (days: number): Grain => (days <= 45 ? 'day' : days <= 120 ? 'week' : 'month');

const bucketOf = (d: string, grain: Grain) =>
    grain === 'day' ? d : grain === 'month' ? d.slice(0, 7) : isoOf(dayNum(d) - (isoDow(d) - 1));

/* ───────────────────────── ตัวสะสม ───────────────────────── */

interface Cell {
    d: string;
    unit: number;
    shift: number;
    general: number;
    crisis: number;
    types: number[];
    care: number[];
    census: number;
    staff: ShiftStaff;
}

const newAcc = () => ({
    /** เวรทั้งหมดที่มีผู้ป่วยหรือมีคนขึ้น */
    shifts: 0,
    /** เวรที่เทียบกำลังได้ (ลงระดับการดูแลแล้ว หรือไม่มีผู้ป่วยจริง) */
    recorded: 0,
    /** เวรที่คิด productivity ได้ (เทียบได้ และมีคนขึ้น) */
    measured: 0,
    /** มีผู้ป่วยนอนอยู่แต่ไม่ได้ลงระดับการดูแลเลย — วัดภาระงานไม่ได้ */
    unrecorded: 0,
    /** มีผู้ป่วยแต่ไม่มีใครขึ้นเวร — ตารางเวรไม่ครบหรือไม่ได้ลง */
    noStaff: 0,
    /** ยอดผู้ป่วยไม่เท่าผลรวมประเภท 1-5 (เหมือนช่องตรวจยอดของหน้า FTE) */
    typeMismatch: 0,
    census: 0, patients: 0, crisis: 0,
    types: [0, 0, 0, 0, 0], care: [0, 0, 0, 0],
    // คนขึ้นเวร ทุกเวร
    staffTotal: 0, staffRn: 0, ot8: 0, ot4: 0,
    // เฉพาะเวรที่เทียบได้
    required: 0, regular: 0, total: 0,
    shortfall: 0, uncovered: 0, excess: 0,
    // ตัวตั้ง/ตัวหารของ productivity
    need: 0, needType: 0, have: 0,
    under: 0, over: 0, ok: 0,
    hist: HIST_EDGES.map(() => 0),
});
type Acc = ReturnType<typeof newAcc>;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

const addCell = (a: Acc, c: Cell, p: Params, weight: number) => {
    const patients = c.general + c.crisis;
    const total = totalCount(c.staff);
    const regular = regularCount(c.staff);
    const ot8 = c.staff.ot8_rn + c.staff.ot8_tn + c.staff.ot8_pn;
    const ot4 = c.staff.ot4_rn + c.staff.ot4_tn + c.staff.ot4_pn;

    a.shifts++;
    a.census += c.census;
    a.patients += patients;
    a.crisis += c.crisis;
    c.types.forEach((n, i) => { a.types[i] += n; });
    c.care.forEach((n, i) => { a.care[i] += n; });
    a.staffTotal += total;
    a.staffRn += c.staff.rn + c.staff.ot8_rn + c.staff.ot4_rn;
    a.ot8 += ot8;
    a.ot4 += ot4;
    if (patients !== c.types.reduce((s, n) => s + n, 0)) a.typeMismatch++;

    if (patients === 0 && c.census > 0) { a.unrecorded++; return; }

    const fte = fteOf(c.general, c.crisis, weight, p);
    a.recorded++;
    a.required += fte;
    a.regular += regular;
    a.total += total;
    a.shortfall += Math.max(0, fte - regular);
    a.uncovered += Math.max(0, fte - total);
    a.excess += Math.max(0, regular - fte);

    if (total === 0) { a.noStaff++; return; }

    const need = workload(c.general, c.crisis, p) * weight;
    const have = total * HOURS_PER_SHIFT;
    a.measured++;
    a.need += need;
    a.needType += typeWorkload(c.types, p);
    a.have += have;

    const prod = (need / have) * 100;
    if (prod > PRODUCTIVITY_HIGH) a.under++;
    else if (prod < PRODUCTIVITY_LOW) a.over++;
    else a.ok++;
    a.hist[histIdx(prod)]++;
};

const summarize = (a: Acc) => {
    const prod = ratio(a.need, a.have);
    const prodType = ratio(a.needType, a.have);
    const completeness = ratio(a.patients, a.census);
    const rec = (n: number) => (a.recorded > 0 ? r2(n / a.recorded) : null);
    return {
        shifts: a.shifts,
        recorded: a.recorded,
        measured: a.measured,
        unrecorded: a.unrecorded,
        no_staff: a.noStaff,
        type_mismatch: a.typeMismatch,
        productivity: prod === null ? null : r1(prod * 100),
        product_type: prodType === null ? null : r1(prodType * 100),
        required: r1(a.required),
        regular: a.regular,
        total: a.total,
        required_per_shift: rec(a.required),
        regular_per_shift: rec(a.regular),
        total_per_shift: rec(a.total),
        shortfall: r1(a.shortfall),
        uncovered: r1(a.uncovered),
        excess: r1(a.excess),
        under: a.under,
        over: a.over,
        ok: a.ok,
        patients: a.patients,
        crisis: a.crisis,
        census: a.census,
        types: a.types,
        care: a.care,
        completeness: completeness === null ? null : r2(Math.min(1, completeness)),
        patients_per_nurse: a.total > 0 ? r2(a.patients / a.total) : null,
        staff_shifts: a.staffTotal,
        ot_shifts: a.ot8 + a.ot4,
        ot_hours: a.ot8 * SHIFT_HOURS + a.ot4 * OT4_HOURS,
        ot_share: a.staffTotal > 0 ? r2((a.ot8 + a.ot4) / a.staffTotal) : null,
        rn_share: a.staffTotal > 0 ? r2(a.staffRn / a.staffTotal) : null,
    };
};

/* ───────────────────────── คิวรี ───────────────────────── */

/** ผู้ป่วยที่ลงระดับการดูแล/ประเภทแล้ว ราย วัน × เวร × หน่วย */
const loadPatients = (codes: string[], from: string, to: string, shifts: number[]) => nurse`
    SELECT
         TO_CHAR(a.record_date, 'YYYY-MM-DD')                                 AS d
        ,a.shift_type_id                                                       AS shift
        ,COALESCE(w.fte_group, w.ward)                                         AS unit
        ,COUNT(*) FILTER (WHERE a.admission_shift_care_level_id IN (1, 2, 3))::int AS general
        ,COUNT(*) FILTER (WHERE a.admission_shift_care_level_id = 4)::int      AS crisis
        ,COUNT(*) FILTER (WHERE a.admission_shift_care_level_id = 1)::int      AS c1
        ,COUNT(*) FILTER (WHERE a.admission_shift_care_level_id = 2)::int      AS c2
        ,COUNT(*) FILTER (WHERE a.admission_shift_care_level_id = 3)::int      AS c3
        ,COUNT(*) FILTER (WHERE a.admission_shift_care_level_id = 4)::int      AS c4
        ,COUNT(*) FILTER (WHERE a.severity_level_id = 1)::int                  AS t1
        ,COUNT(*) FILTER (WHERE a.severity_level_id = 2)::int                  AS t2
        ,COUNT(*) FILTER (WHERE a.severity_level_id = 3)::int                  AS t3
        ,COUNT(*) FILTER (WHERE a.severity_level_id = 4)::int                  AS t4
        ,COUNT(*) FILTER (WHERE a.severity_level_id = 5)::int                  AS t5
    FROM admission_shift_daily_record a
    JOIN admission_list al ON al.admission_list_id = a.admission_list_id
    JOIN ward w            ON w.his_code = al.ward
    WHERE a.deleted_at IS NULL
      AND a.record_date BETWEEN ${from}::date AND ${to}::date
      AND a.shift_type_id IN ${nurse(shifts)}
      AND al.ward IN ${nurse(codes)}
    GROUP BY 1, 2, 3
`;

/**
 * คนขึ้นเวร ราย วัน × เวร × หน่วย แยกตำแหน่งกับชนิด OT
 * นับหัวคนแบบไม่ซ้ำภายในหน่วย คนที่ลงเวรไว้ทั้งสองหอของหน่วยเดียวกันต้องไม่กลายเป็นสองคน (เหมือนหน้า FTE)
 * ตำแหน่งอื่นนอกจาก RN/TN/PN ไม่นับ เหมือนหน้า FTE
 */
const loadStaff = (codes: string[], from: string, to: string, shifts: number[]) => nurse`
    WITH x AS (
        SELECT
             a.shift_date
            ,nst.admission_change_shift_type_id AS shift
            ,COALESCE(w.fte_group, w.ward)      AS unit
            ,a.staff_id
            ,LOWER(sp.code)                     AS pos
            ,CASE
                 WHEN nst.code LIKE '%\\_OT4' THEN 'ot4'
                 WHEN nst.code LIKE '%\\_OT'  THEN 'ot8'
                 ELSE 'regular'
             END                                AS kind
        FROM nurse_shift_assignments a
        JOIN nurse_shift_types nst ON nst.nurse_shift_type_id = a.nurse_shift_type_id
        JOIN staffs s              ON s.staff_id = a.staff_id
        JOIN staff_position sp     ON sp.staff_position_id = s.staff_position_id
        JOIN ward w                ON w.his_code = a.ward
        WHERE a.ward IN ${nurse(codes)}
          AND a.shift_date BETWEEN ${from}::date AND ${to}::date
          AND nst.admission_change_shift_type_id IN ${nurse(shifts)}
    )
    SELECT
         TO_CHAR(shift_date, 'YYYY-MM-DD')                                              AS d
        ,shift
        ,unit
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'regular' AND pos = 'rn')::int  AS rn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'regular' AND pos = 'tn')::int  AS tn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'regular' AND pos = 'pn')::int  AS pn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'ot8' AND pos = 'rn')::int      AS ot8_rn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'ot8' AND pos = 'tn')::int      AS ot8_tn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'ot8' AND pos = 'pn')::int      AS ot8_pn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'ot4' AND pos = 'rn')::int      AS ot4_rn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'ot4' AND pos = 'tn')::int      AS ot4_tn
        ,COUNT(DISTINCT staff_id) FILTER (WHERE kind = 'ot4' AND pos = 'pn')::int      AS ot4_pn
    FROM x
    GROUP BY 1, 2, 3
`;

/** ผู้ป่วยนอนอยู่ ณ แต่ละวัน ราย หน่วย — นิยามเดียวกับกราฟสถิติรายวันเดิม */
const loadCensus = (codes: string[], from: string, to: string) => nurse`
    SELECT
         TO_CHAR(ds.d, 'YYYY-MM-DD')   AS d
        ,COALESCE(w.fte_group, w.ward) AS unit
        ,COUNT(*)::int                 AS census
    FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') AS ds(d)
    JOIN admission_list al
      ON al.reg_datetime::date <= ds.d
     AND (al.discharge_datetime IS NULL OR al.discharge_datetime::date > ds.d)
    JOIN ward w ON w.his_code = al.ward
    WHERE al.ward IN ${nurse(codes)}
      AND al.reg_datetime::date <= ${to}::date
      AND (al.discharge_datetime IS NULL OR al.discharge_datetime::date > ${from}::date)
    GROUP BY 1, 2
`;

/** รับใหม่ / รับย้าย / จำหน่าย รายวัน ราย หน่วย */
const loadMovement = (codes: string[], from: string, to: string) => nurse`
    SELECT TO_CHAR(al.reg_datetime::date, 'YYYY-MM-DD') AS d
          ,CASE al.admission_type_id WHEN 1 THEN 'new' WHEN 2 THEN 'transfer' ELSE 'other' END AS kind
          ,COUNT(*)::int AS n
    FROM admission_list al
    WHERE al.ward IN ${nurse(codes)}
      AND al.reg_datetime::date BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1, 2
    UNION ALL
    SELECT TO_CHAR(al.discharge_datetime::date, 'YYYY-MM-DD'), 'discharge', COUNT(*)::int
    FROM admission_list al
    WHERE al.ward IN ${nurse(codes)}
      AND al.discharge_datetime::date BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1
`;

/** ชั่วโมงขึ้นเวรรายบุคคล — นับเฉพาะเวรที่เลือก */
const loadPeople = (codes: string[], from: string, to: string, shifts: number[]) => nurse`
    SELECT
         s.staff_id
        ,s.fullname
        ,COALESCE(sp.code, '-')                                                     AS position
        ,ARRAY_AGG(DISTINCT COALESCE(w.fte_group, w.ward))                          AS units
        ,COUNT(*) FILTER (WHERE nst.admission_change_shift_type_id = 2 AND nst.code NOT LIKE '%\\_OT%')::int AS morning
        ,COUNT(*) FILTER (WHERE nst.admission_change_shift_type_id = 3 AND nst.code NOT LIKE '%\\_OT%')::int AS afternoon
        ,COUNT(*) FILTER (WHERE nst.admission_change_shift_type_id = 1 AND nst.code NOT LIKE '%\\_OT%')::int AS night
        ,COUNT(*) FILTER (WHERE nst.code LIKE '%\\_OT')::int                         AS ot8
        ,COUNT(*) FILTER (WHERE nst.code LIKE '%\\_OT4')::int                        AS ot4
    FROM nurse_shift_assignments a
    JOIN nurse_shift_types nst ON nst.nurse_shift_type_id = a.nurse_shift_type_id
    JOIN staffs s              ON s.staff_id = a.staff_id
    LEFT JOIN staff_position sp ON sp.staff_position_id = s.staff_position_id
    JOIN ward w                ON w.his_code = a.ward
    WHERE a.ward IN ${nurse(codes)}
      AND a.shift_date BETWEEN ${from}::date AND ${to}::date
      AND nst.admission_change_shift_type_id IN ${nurse(shifts)}
    GROUP BY s.staff_id, s.fullname, sp.code
`;

/* ───────────────────────── endpoint ───────────────────────── */

interface StaffingBody { date_from?: string; date_to?: string; wards?: string[]; shifts?: number[] }

/** วันนี้ตามเวลาเครื่อง ไม่ใช้ toISOString ซึ่งเป็น UTC (ตีหนึ่งถึงเจ็ดโมงเช้าจะได้วันของเมื่อวาน) */
const todayLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const getStaffingAnalytics = async ({ body, set }: { body: StaffingBody; set: { status?: number | string } }) => {
    const from = String(body?.date_from ?? '');
    let to = String(body?.date_to ?? '');
    if (!isDate(from) || !isDate(to)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }
    /*
      ตัดปลายช่วงไว้ที่วันนี้ ผู้ป่วยที่ยังไม่จำหน่ายถูกนับว่านอนอยู่ทุกวันข้างหน้า
      ถ้าปล่อยวันในอนาคตเข้ามา ยอดผู้ป่วยและเวรที่ "ไม่ได้ลงประเภท" จะพองขึ้นเอง
    */
    const today = todayLocal();
    if (from > today) {
        set.status = 400;
        return { success: false, message: 'ยังไม่ถึงวันที่เลือก' };
    }
    if (to > today) to = today;
    if (from > to) {
        set.status = 400;
        return { success: false, message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' };
    }
    const days = dayNum(to) - dayNum(from) + 1;
    if (days > MAX_DAYS) {
        set.status = 400;
        return { success: false, message: `เลือกช่วงได้ไม่เกิน ${MAX_DAYS} วัน (หนึ่งปีงบ)` };
    }
    const wardCodes = (body?.wards ?? []).map(w => String(w).trim()).filter(Boolean);
    if (wardCodes.length > MAX_WARDS) {
        set.status = 400;
        return { success: false, message: `เลือกได้ไม่เกิน ${MAX_WARDS} หอ` };
    }
    const shifts = [...new Set((body?.shifts ?? []).map(Number))].filter(s => ALL_SHIFTS.includes(s)).sort();
    const shiftList = shifts.length ? shifts : ALL_SHIFTS;

    try {
        const units = await wardUnits(wardCodes.length ? wardCodes : null);
        if (units.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบหอผู้ป่วยที่เลือก' };
        }
        const codes = units.flatMap(u => u.codes);
        const unitById = new Map<number, WardGroup>(units.map(u => [u.primary.ward, u]));

        const [shiftRows, levelRows, careRows, patientRows, staffRows, censusRows, moveRows, peopleRows, flow] = await Promise.all([
            nurse`SELECT admission_change_shift_type_id AS id, shift_name, weight
                  FROM admission_change_shift_types
                  WHERE admission_change_shift_type_id IN ${nurse(shiftList)}
                  ORDER BY admission_change_shift_type_id`,
            nurse`SELECT severity_level_id, severity_level_name, care_hours FROM admission_severity_level ORDER BY severity_level_id`,
            nurse`SELECT admission_shift_care_level_id AS id, name FROM admission_shift_care_levels ORDER BY 1`,
            loadPatients(codes, from, to, shiftList),
            loadStaff(codes, from, to, shiftList),
            loadCensus(codes, from, to),
            loadMovement(codes, from, to),
            loadPeople(codes, from, to, shiftList),
            careLevelFlow(codes, from, to, shiftList),
        ]);

        const careHours = Object.fromEntries(levelRows.map(l => [Number(l.severity_level_id), Number(l.care_hours ?? 0)]));
        const paramsOf = new Map<number, Params>(units.map(u => [u.primary.ward, {
            general: u.primary.general, crisis: u.primary.crisis, careHours,
        }]));
        const weightOf = new Map(shiftRows.map(s => [Number(s.id), Number(s.weight) / 100]));

        /* ── ประกอบเวร: เริ่มจากวันที่มีผู้ป่วยนอนอยู่ แล้วเติมผู้ป่วยที่ลงประเภทกับคนขึ้นเวร ── */
        const cells = new Map<string, Cell>();
        const cellOf = (d: string, unit: number, shift: number) => {
            const k = `${d}|${unit}|${shift}`;
            let c = cells.get(k);
            if (!c) {
                c = { d, unit, shift, general: 0, crisis: 0, types: [0, 0, 0, 0, 0], care: [0, 0, 0, 0], census: 0, staff: emptyStaff() };
                cells.set(k, c);
            }
            return c;
        };
        const censusByDayUnit = new Map<string, number>();
        for (const r of censusRows) {
            censusByDayUnit.set(`${r.d}|${r.unit}`, Number(r.census));
            for (const s of shiftList) cellOf(String(r.d), Number(r.unit), s).census = Number(r.census);
        }
        for (const r of patientRows) {
            const c = cellOf(String(r.d), Number(r.unit), Number(r.shift));
            c.general = Number(r.general);
            c.crisis = Number(r.crisis);
            c.types = [r.t1, r.t2, r.t3, r.t4, r.t5].map(Number);
            c.care = [r.c1, r.c2, r.c3, r.c4].map(Number);
        }
        for (const r of staffRows) {
            const c = cellOf(String(r.d), Number(r.unit), Number(r.shift));
            c.staff = {
                rn: Number(r.rn), tn: Number(r.tn), pn: Number(r.pn),
                ot8_rn: Number(r.ot8_rn), ot8_tn: Number(r.ot8_tn), ot8_pn: Number(r.ot8_pn),
                ot4_rn: Number(r.ot4_rn), ot4_tn: Number(r.ot4_tn), ot4_pn: Number(r.ot4_pn),
            };
        }

        /* ── รวมขึ้นไปทุกมุม ── */
        const grain = grainOf(days);
        const buckets: { key: string; start: string; end: string; days: number }[] = [];
        for (let n = dayNum(from); n <= dayNum(to); n++) {
            const d = isoOf(n);
            const key = bucketOf(d, grain);
            const last = buckets[buckets.length - 1];
            if (last?.key === key) { last.end = d; last.days++; } else buckets.push({ key, start: d, end: d, days: 1 });
        }

        const total = newAcc();
        const byBucket = new Map(buckets.map(b => [b.key, newAcc()]));
        const byShift = new Map(shiftList.map(s => [s, newAcc()]));
        const byUnit = new Map(units.map(u => [u.primary.ward, newAcc()]));
        const byUnitBucket = new Map<string, Acc>();
        const byDowShift = new Map<string, Acc>();
        const take = (m: Map<string, Acc>, k: string) => {
            let a = m.get(k);
            if (!a) { a = newAcc(); m.set(k, a); }
            return a;
        };

        for (const c of cells.values()) {
            const p = paramsOf.get(c.unit);
            if (!p) continue;
            const w = weightOf.get(c.shift) ?? 0;
            const b = bucketOf(c.d, grain);
            for (const a of [
                total, byBucket.get(b)!, byShift.get(c.shift)!, byUnit.get(c.unit)!,
                take(byUnitBucket, `${c.unit}|${b}`), take(byDowShift, `${isoDow(c.d)}|${c.shift}`),
            ]) addCell(a, c, p, w);
        }

        /* ── รับเข้า/จำหน่าย และผู้ป่วยเฉลี่ยต่อวัน รายช่วง ── */
        const move = new Map(buckets.map(b => [b.key, { new_admit: 0, transfer_in: 0, discharge: 0, census: 0 }]));
        for (const r of moveRows) {
            const m = move.get(bucketOf(String(r.d), grain));
            if (!m) continue;
            if (r.kind === 'new') m.new_admit += Number(r.n);
            else if (r.kind === 'transfer') m.transfer_in += Number(r.n);
            else if (r.kind === 'discharge') m.discharge += Number(r.n);
        }
        const censusByUnit = new Map<number, number>();
        for (const r of censusRows) {
            move.get(bucketOf(String(r.d), grain))!.census += Number(r.census);
            censusByUnit.set(Number(r.unit), (censusByUnit.get(Number(r.unit)) ?? 0) + Number(r.census));
        }

        /* ── รายบุคคล ── */
        const people = peopleRows.map(r => {
            const regularShifts = Number(r.morning) + Number(r.afternoon) + Number(r.night);
            const hours = regularShifts * SHIFT_HOURS + Number(r.ot8) * SHIFT_HOURS + Number(r.ot4) * OT4_HOURS;
            const unitIds = (r.units as number[]).map(Number);
            return {
                staff_id: Number(r.staff_id),
                name: sanitizeHTML(String(r.fullname ?? '')) ?? '',
                position: String(r.position),
                units: unitIds.map(id => sanitizeHTML(unitById.get(id)?.label ?? '') ?? '').filter(Boolean),
                unit_ids: unitIds,
                morning: Number(r.morning),
                afternoon: Number(r.afternoon),
                night: Number(r.night),
                ot8: Number(r.ot8),
                ot4: Number(r.ot4),
                hours,
                // ชั่วโมงต่อเดือนเทียบได้เมื่อช่วงยาวพอ ช่วงสั้นกว่า 28 วันเทียบไม่ได้ จึงเป็น null
                hours_per_month: days >= 28 ? r1(hours / (days / DAYS_PER_MONTH)) : null,
                night_share: regularShifts > 0 ? r2(Number(r.night) / regularShifts) : null,
            };
        }).sort((a, b) => b.hours - a.hours);

        const headcountOf = (unit: number) => people.filter(p => p.unit_ids.includes(unit)).length;

        const byUnitOut = units
            .map(u => {
                const s = summarize(byUnit.get(u.primary.ward)!);
                const avgCensus = (censusByUnit.get(u.primary.ward) ?? 0) / days;
                return {
                    unit: u.primary.ward,
                    ...groupInfo(u),
                    beds: u.bed,
                    avg_census: r1(avgCensus),
                    occupancy: u.bed ? r2(avgCensus / u.bed) : null,
                    headcount: headcountOf(u.primary.ward),
                    ...s,
                };
            })
            // หน่วยที่ไม่มีทั้งผู้ป่วยและคนขึ้นเวรในช่วงนี้ ไม่ต้องแสดง
            .filter(u => u.shifts > 0);

        const shiftName = new Map(shiftRows.map(s => [Number(s.id), sanitizeHTML(String(s.shift_name)) ?? '']));

        return {
            success: true,
            data: {
                range: { from, to, days, grain },
                shifts: shiftRows.map(s => ({ id: Number(s.id), name: shiftName.get(Number(s.id)), weight: Number(s.weight) })),
                units: units.map(u => ({ unit: u.primary.ward, ...groupInfo(u) })),
                definitions: {
                    productivity_low: PRODUCTIVITY_LOW,
                    productivity_high: PRODUCTIVITY_HIGH,
                    hours_per_shift: HOURS_PER_SHIFT,
                    shift_hours: SHIFT_HOURS,
                    monthly_hours_standard: MONTHLY_HOURS_STANDARD,
                    hist_edges: HIST_EDGES.slice(0, -1),
                    severity_levels: levelRows.map(l => ({
                        id: Number(l.severity_level_id),
                        name: sanitizeHTML(String(l.severity_level_name)) ?? '',
                        care_hours: Number(l.care_hours ?? 0),
                    })),
                    care_levels: careRows.map(c => ({ id: Number(c.id), name: sanitizeHTML(String(c.name)) ?? '' })),
                },
                summary: {
                    ...summarize(total),
                    histogram: total.hist,
                    headcount: people.length,
                    avg_census: r1(censusRows.reduce((a, r) => a + Number(r.census), 0) / days),
                },
                by_bucket: buckets.map(b => ({
                    key: b.key, start: b.start, end: b.end, days: b.days,
                    ...summarize(byBucket.get(b.key)!),
                    ...(() => {
                        const m = move.get(b.key)!;
                        return { new_admit: m.new_admit, transfer_in: m.transfer_in, discharge: m.discharge, avg_census: r1(m.census / b.days) };
                    })(),
                })),
                by_shift: shiftList.map(s => ({ shift: s, name: shiftName.get(s) ?? '', ...summarize(byShift.get(s)!) })),
                by_unit: byUnitOut,
                unit_bucket: [...byUnitBucket.entries()].map(([k, a]) => {
                    const [unit, bucket] = k.split('|');
                    const s = summarize(a);
                    return {
                        unit: Number(unit), bucket, productivity: s.productivity, measured: s.measured,
                        under: s.under, over: s.over, required_per_shift: s.required_per_shift, total_per_shift: s.total_per_shift,
                    };
                }),
                dow_shift: [...byDowShift.entries()].map(([k, a]) => {
                    const [dow, shift] = k.split('|').map(Number);
                    const s = summarize(a);
                    return { dow, shift, productivity: s.productivity, measured: s.measured, under: s.under, over: s.over, ot_shifts: s.ot_shifts };
                }),
                people,
                care_flow: flow,
            },
        };
    } catch (error) {
        console.error('Get staffing analytics error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
