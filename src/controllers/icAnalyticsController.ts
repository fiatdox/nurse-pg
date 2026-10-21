import { Context } from 'elysia';
import { his } from '../db';
import { RowDataPacket } from 'mysql2';
import { sanitizeHTML } from '../utils/sanitize';
import { fiscalRange, cleanDepartment } from './icController';

/*
  วิเคราะห์เชื้อดื้อยาเชิงลึกสำหรับหน้า /ic/dashboard

  นิยาม "ผลเพาะเชื้อดื้อยา" ใช้ตัวเดียวกับ Sankey และรายงาน AMR
  คือแถวเชื้อ (ResultName 'or%') ที่มีวงเล็บกลุ่มการดื้อยาต่อท้าย เช่น "Klebsiella pneumoniae(CRE,ESCR)"
  เลือกช่วงและแบ่งเดือนตามวันที่ยืนยันผล เหมือนกราฟอื่นในหน้าเดียวกัน ยอดรวมจึงตรงกันทุกกราฟ

  ส่งกลับเฉพาะยอดรวม ไม่มี HN / AN / ชื่อผู้ป่วยออกไปจากเซิร์ฟเวอร์
*/

/**
 * กลุ่มการดื้อยา เรียงตามความเร่งด่วนทางระบาดวิทยา
 * ผลที่มีหลายกลุ่ม ("CRE,ESCR") นับเป็นกลุ่มแรกที่เจอในลำดับนี้กลุ่มเดียว
 * ถ้านับทุกกลุ่ม ยอดในกราฟแท่งซ้อนจะเกินจำนวนผลเพาะเชื้อจริง
 * ใช้ regex ชุดเดียวกับป้ายสีในหน้าอื่นของงาน IC (app/components/ic/resistance.ts)
 */
const RESISTANCE_GROUPS = [
    { key: 'CRE', match: /CRE/ },
    { key: 'CRAB', match: /CRAB/ },
    { key: 'CRPA', match: /CRPA/ },
    { key: 'VRE', match: /VRE/ },
    { key: 'MRSA', match: /MRSA/ },
    { key: 'ESCR', match: /ESCR/ },
    { key: 'MDR', match: /MDR/ },
] as const;

type GroupKey = (typeof RESISTANCE_GROUPS)[number]['key'] | 'OTHER';
const GROUP_KEYS: GroupKey[] = [...RESISTANCE_GROUPS.map(g => g.key), 'OTHER'];

/** กลุ่มที่ต้องแยกผู้ป่วยทันทีเมื่อพบ */
const CRITICAL: GroupKey[] = ['CRE', 'CRAB', 'CRPA', 'VRE'];

export const groupOf = (resistance: string): GroupKey =>
    RESISTANCE_GROUPS.find(g => g.match.test(resistance.toUpperCase()))?.key ?? 'OTHER';

/**
 * ติดเชื้อในโรงพยาบาล (hospital-onset) = เก็บสิ่งส่งตรวจตั้งแต่วันนอนที่ 4 ขึ้นไป
 * วันรับเข้าคือวันที่ 1 ตามนิยาม LabID ของ NHSN
 */
const HO_DAY = 4;

/** สัญญาณกลุ่มก้อน: หน่วยงานเดียวกัน เชื้อและกลุ่มดื้อยาเดียวกัน ห่างกันไม่เกินกี่วัน และกี่คนขึ้นไป */
const CLUSTER_WINDOW_DAYS = 14;
const CLUSTER_MIN_PATIENTS = 2;

/**
 * ทะเบียนนอนที่ไม่มีวันจำหน่ายและรับเข้าก่อนช่วงนี้ ถือเป็นข้อมูลค้าง ไม่นับวันนอน
 * ไม่งั้นทะเบียนเก่าที่ลืมจำหน่ายเพียงไม่กี่ใบจะเพิ่มวันนอนหลายพันวันจนอัตราติดเชื้อต่ำผิดจริง
 */
const ADMIT_LOOKBACK_DAYS = 365;

const TOP_ROWS = 10;
const CACHE_TTL_MS = 10 * 60_000;

/* ───────────────────────── วันที่ ─────────────────────────
   ทำงานกับสตริง YYYY-MM-DD ตลอด ไม่ผ่าน Date ของเครื่อง จะได้ไม่เลื่อนวันตามเขตเวลา */

const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;

/** ต.ค. = 0 … ก.ย. = 11 */
const fiscalIdx = (s: string) => (Number(s.slice(5, 7)) + 2) % 12;

/** วันเดียวกันของปีก่อน (29 ก.พ. → 28 ก.พ.) */
const lastYear = (s: string) => {
    const md = s.slice(5) === '02-29' ? '02-28' : s.slice(5);
    return `${Number(s.slice(0, 4)) - 1}-${md}`;
};

/** percentile แบบเดียวกับ percentile_cont (ประมาณค่าระหว่างจุด) */
const pct = (values: number[], p: number) => {
    if (!values.length) return null;
    const v = [...values].sort((a, b) => a - b);
    const k = (v.length - 1) * p;
    const f = Math.floor(k);
    const c = Math.ceil(k);
    return v[f] + (v[c] - v[f]) * (k - f);
};

const rate = (n: number, patientDays: number) => (patientDays > 0 ? (n / patientDays) * 1000 : null);

const emptyGroups = () => Object.fromEntries(GROUP_KEYS.map(g => [g, 0])) as Record<GroupKey, number>;

const topOf = (counts: Map<string, number>) => {
    let best: { name: string; n: number } | null = null;
    for (const [name, n] of counts) if (!best || n > best.n) best = { name, n };
    return best;
};

const bump = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

/* ───────────────────────── ข้อมูลจาก HIS ───────────────────────── */

interface Isolate {
    hn: string;
    confirm: string;
    /** วันเก็บสิ่งส่งตรวจ (วันสั่งตรวจ) ถ้าหาใบสั่งไม่เจอใช้วันยืนยันผลแทน */
    spec: string;
    hasOrder: boolean;
    specimen: string;
    organism: string;
    group: GroupKey;
    unit: string;
    sex: string | null;
    age: number | null;
    an: string | null;
    /** วันนอนที่เก็บสิ่งส่งตรวจ (วันรับเข้า = 1) ไม่ได้นอนโรงพยาบาล = null */
    hospDay: number | null;
    onset: 'opd' | 'co' | 'ho';
}

/**
 * ผลเพาะเชื้อดื้อยาตั้งแต่ต้นปีงบก่อนหน้าถึงวันสุดท้ายที่นับ ในการสแกนตารางรอบเดียว
 * t_interface_result_bacteria ไม่มีดัชนีที่ ConfirmDate (627,118 แถว) อ่านสองช่วงแยกกันคือสแกนสองรอบ
 *
 * หาทะเบียนนอนด้วยวันเก็บสิ่งส่งตรวจ ไม่ใช่วันยืนยันผล เพราะผลออกหลังเก็บหลายวัน
 * คนที่เก็บเชื้อวันสุดท้ายแล้วกลับบ้านก่อนผลออกยังเป็นผู้ป่วยในของครั้งนั้น
 * ทำเฉพาะแถวของปีงบที่เลือก (CASE) ปีก่อนใช้แค่ยอดเทียบ ไม่ต้องรู้ทะเบียนนอน
 *
 * ใช้คิวรีย่อยหยิบทะเบียนเดียวแบบรายงาน AMR เพราะทะเบียนนอนซ้อนกันได้ แล้ว join จะแตกแถว
 * และแปลงชุดอักขระฝั่ง a.HN (utf8mb3 → tis620) เพื่อให้ดัชนีของ ipt.hn / patient.hn ใช้ได้
 */
const loadIsolates = async (prevStart: string, start: string, until: string) => {
    const sql = `
        SELECT x.*, DATE_FORMAT(i.regdate, '%Y-%m-%d') AS regdate
        FROM (
            SELECT
                 a.HN                                                                     AS hn
                ,DATE_FORMAT(a.ConfirmDate, '%Y-%m-%d')                                   AS confirm_date
                ,DATE_FORMAT(COALESCE(b.order_date, a.ConfirmDate), '%Y-%m-%d')           AS spec_date
                ,(b.order_date IS NOT NULL)                                               AS has_order
                ,a.Specimen                                                               AS specimen
                ,TRIM(SUBSTRING_INDEX(a.ResultValue, '(', 1))                             AS organism
                ,TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(a.ResultValue, '(', -1), ')', 1))   AS resistance
                ,c.department                                                             AS department
                ,p.sex                                                                    AS sex
                ,TIMESTAMPDIFF(YEAR, p.birthday, COALESCE(b.order_date, a.ConfirmDate))   AS age
                ,CASE WHEN a.ConfirmDate >= ? THEN (
                    SELECT i2.an FROM ipt i2
                     WHERE i2.hn = CONVERT(a.HN USING tis620)
                       AND i2.regdate <= DATE(COALESCE(b.order_date, a.ConfirmDate))
                       AND (i2.dchdate IS NULL OR i2.dchdate >= DATE(COALESCE(b.order_date, a.ConfirmDate)))
                     ORDER BY i2.regdate DESC LIMIT 1
                 ) END                                                                    AS an
            FROM t_interface_result_bacteria a
            LEFT JOIN lab_head b      ON b.lab_order_number = a.Hospital_LabNumber
            LEFT JOIN kskdepartment c ON c.depcode = b.order_department
            LEFT JOIN patient p       ON p.hn = CONVERT(a.HN USING tis620)
            WHERE a.ResultName LIKE 'or%'
              AND a.ResultValue LIKE '%(%)%'
              AND a.ConfirmDate >= ?
              AND a.ConfirmDate < DATE_ADD(?, INTERVAL 1 DAY)
        ) x
        LEFT JOIN ipt i ON i.an = x.an
    `;
    const [rows] = await his.execute<RowDataPacket[]>(sql, [start, prevStart, until]);

    const current: Isolate[] = [];
    const prior: { hn: string; confirm: string; group: GroupKey }[] = [];

    for (const r of rows) {
        const confirm = String(r.confirm_date);
        const group = groupOf(String(r.resistance ?? ''));
        const hn = String(r.hn ?? '');
        if (confirm < start) {
            prior.push({ hn, confirm, group });
            continue;
        }
        const spec = String(r.spec_date ?? confirm);
        const regdate = r.regdate ? String(r.regdate) : null;
        const hospDay = r.an && regdate ? dayNum(spec) - dayNum(regdate) + 1 : null;
        current.push({
            hn,
            confirm,
            spec,
            hasOrder: Number(r.has_order) === 1,
            specimen: sanitizeHTML(String(r.specimen ?? '').trim()) || 'ไม่ระบุ',
            organism: sanitizeHTML(String(r.organism ?? '').trim()) || 'ไม่ระบุเชื้อ',
            group,
            unit: sanitizeHTML(cleanDepartment(String(r.department ?? ''))) || 'ไม่ระบุหน่วยงาน',
            sex: r.sex === '1' ? 'male' : r.sex === '2' ? 'female' : null,
            age: r.age === null || r.age === undefined ? null : Number(r.age),
            an: r.an ? String(r.an) : null,
            hospDay,
            onset: hospDay === null ? 'opd' : hospDay >= HO_DAY ? 'ho' : 'co',
        });
    }
    return { current, prior };
};

/**
 * วันนอนรวมรายเดือน (นับคืน: รับเข้าวันนี้ จำหน่ายพรุ่งนี้ = 1 วัน) ตัวหารของอัตราต่อ 1,000 วันนอน
 * รวมตามคู่วันรับ-วันจำหน่ายในฐานก่อน แถวที่ส่งกลับจึงเป็นแค่วันที่กับจำนวน ไม่มีตัวผู้ป่วย
 */
const loadPatientDays = async (start: string, until: string) => {
    const [rows] = await his.execute<RowDataPacket[]>(`
        SELECT DATE_FORMAT(i.regdate, '%Y-%m-%d') AS regdate
              ,DATE_FORMAT(i.dchdate, '%Y-%m-%d') AS dchdate
              ,COUNT(*)                           AS n
        FROM ipt i
        WHERE i.regdate <= ?
          AND i.regdate >= DATE_SUB(?, INTERVAL ${ADMIT_LOOKBACK_DAYS} DAY)
          AND (i.dchdate IS NULL OR i.dchdate > ?)
        GROUP BY i.regdate, i.dchdate
    `, [until, start, start]);

    // ขอบของแต่ละเดือนแบบปลายเปิด เดือนปัจจุบันตัดที่คืนของวันสุดท้ายที่นับ
    const endExclusive = dayNum(until) + 1;
    const bounds = Array.from({ length: 12 }, (_, i) => {
        const y = Number(start.slice(0, 4)) + (i >= 3 ? 1 : 0);
        const m = ((9 + i) % 12) + 1;
        const ms = Date.UTC(y, m - 1, 1) / 86_400_000;
        const me = Math.min(Date.UTC(y, m, 1) / 86_400_000, endExclusive);
        return [ms, me] as const;
    });

    const days = new Array(12).fill(0) as number[];
    for (const r of rows) {
        const s = dayNum(String(r.regdate));
        const e = r.dchdate ? dayNum(String(r.dchdate)) : endExclusive;
        const n = Number(r.n) || 0;
        bounds.forEach(([ms, me], i) => {
            const nights = Math.min(e, me) - Math.max(s, ms);
            if (nights > 0) days[i] += nights * n;
        });
    }
    return days;
};

/* ───────────────────────── รวมยอด ───────────────────────── */

const AGE_BANDS = [
    { label: '0–14', max: 14 },
    { label: '15–44', max: 44 },
    { label: '45–59', max: 59 },
    { label: '60–74', max: 74 },
    { label: '75+', max: Infinity },
];

/** ช่วงวันนอนที่พบเชื้อ ช่องแรกคือ 3 วันแรก (ติดมาจากข้างนอก) ที่เหลือคือติดในโรงพยาบาล */
const HOSP_DAY_BUCKETS = [
    { label: '1–3', max: HO_DAY - 1 },
    { label: '4–7', max: 7 },
    { label: '8–14', max: 14 },
    { label: '15–30', max: 30 },
    { label: '31–60', max: 60 },
    { label: '> 60', max: Infinity },
];

const buildAnalytics = async (fyRaw: unknown) => {
    const range = fiscalRange(fyRaw);
    const startYear = Number(range.start.slice(0, 4));
    const prevStart = `${startYear - 1}-10-01`;
    const prevEnd = `${startYear}-09-30`;
    const prevSameUntil = lastYear(range.until);

    const [{ current, prior }, patientDays] = await Promise.all([
        loadIsolates(prevStart, range.start, range.until),
        loadPatientDays(range.start, range.until),
    ]);

    const lastIdx = fiscalIdx(range.until);
    const isFuture = (i: number) => range.fy === range.current && i > lastIdx;

    /*
      เหตุการณ์ = ผู้ป่วยหนึ่งคน ในการนอนครั้งเดียว กับเชื้อและกลุ่มดื้อยาเดียวกัน นับครั้งเดียว (ครั้งแรกที่พบ)
      เพาะเชื้อซ้ำเพื่อติดตามจะได้ไม่นับเป็นการติดเชื้อใหม่ ใช้เป็นตัวตั้งของอัตราต่อวันนอน
    */
    const events = new Map<string, Isolate>();
    for (const r of current) {
        if (!r.an) continue;
        const key = `${r.an}|${r.organism}|${r.group}`;
        const seen = events.get(key);
        if (!seen || r.spec < seen.spec) events.set(key, r);
    }
    const inpatientEvents = [...events.values()];
    const hoEvents = inpatientEvents.filter(e => e.onset === 'ho');

    /* รายเดือน */
    const monthly = Array.from({ length: 12 }, (_, i) => {
        const y = startYear + (i >= 3 ? 1 : 0);
        const m = ((9 + i) % 12) + 1;
        return {
            month: `${y}-${String(m).padStart(2, '0')}`,
            future: isFuture(i),
            isolates: 0,
            patients: new Set<string>(),
            groups: emptyGroups(),
            critical: 0,
            prior_isolates: 0,
            ho_events: 0,
            inpatient_events: 0,
            patient_days: patientDays[i],
            tat: [] as number[],
        };
    });
    for (const r of current) {
        const mo = monthly[fiscalIdx(r.confirm)];
        mo.isolates++;
        mo.patients.add(r.hn);
        mo.groups[r.group]++;
        if (CRITICAL.includes(r.group)) mo.critical++;
        if (r.hasOrder) {
            const d = dayNum(r.confirm) - dayNum(r.spec);
            if (d >= 0) mo.tat.push(d);
        }
    }
    for (const r of prior) monthly[fiscalIdx(r.confirm)].prior_isolates++;
    for (const e of inpatientEvents) {
        const mo = monthly[fiscalIdx(e.confirm)];
        mo.inpatient_events++;
        if (e.onset === 'ho') mo.ho_events++;
    }

    /* แยกกลุ่มดื้อยา */
    const byGroup = GROUP_KEYS.map(g => {
        const rows = current.filter(r => r.group === g);
        const orgs = new Map<string, number>();
        rows.forEach(r => bump(orgs, r.organism));
        return {
            group: g,
            isolates: rows.length,
            patients: new Set(rows.map(r => r.hn)).size,
            opd: rows.filter(r => r.onset === 'opd').length,
            co: rows.filter(r => r.onset === 'co').length,
            ho: rows.filter(r => r.onset === 'ho').length,
            ho_events: hoEvents.filter(e => e.group === g).length,
            top_organism: topOf(orgs),
        };
    }).filter(g => g.isolates > 0);

    /* ตาราง เชื้อ × กลุ่ม และ สิ่งส่งตรวจ × กลุ่ม */
    const matrix = (key: 'organism' | 'specimen') => {
        const rows = new Map<string, Record<GroupKey, number>>();
        const totals = new Map<string, number>();
        for (const r of current) {
            if (!rows.has(r[key])) rows.set(r[key], emptyGroups());
            rows.get(r[key])![r.group]++;
            bump(totals, r[key]);
        }
        const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
        return {
            rows: ranked.slice(0, TOP_ROWS).map(([name, total]) => ({ name, total, counts: rows.get(name)! })),
            other_rows: Math.max(0, ranked.length - TOP_ROWS),
            other_total: ranked.slice(TOP_ROWS).reduce((s, [, n]) => s + n, 0),
        };
    };

    /* รายหน่วยงานที่ส่งตรวจ */
    const units = new Map<string, {
        isolates: number; patients: Set<string>; ho_events: number; inpatient: number; critical: number;
        groups: Map<string, number>; organisms: Map<string, number>;
    }>();
    for (const r of current) {
        if (!units.has(r.unit)) {
            units.set(r.unit, { isolates: 0, patients: new Set(), ho_events: 0, inpatient: 0, critical: 0, groups: new Map(), organisms: new Map() });
        }
        const u = units.get(r.unit)!;
        u.isolates++;
        u.patients.add(r.hn);
        if (r.onset !== 'opd') u.inpatient++;
        if (CRITICAL.includes(r.group)) u.critical++;
        bump(u.groups, r.group);
        bump(u.organisms, r.organism);
    }
    for (const e of hoEvents) units.get(e.unit)!.ho_events++;
    const byUnit = [...units.entries()]
        .map(([unit, u]) => ({
            unit,
            isolates: u.isolates,
            patients: u.patients.size,
            inpatient_isolates: u.inpatient,
            ho_events: u.ho_events,
            critical: u.critical,
            top_group: topOf(u.groups),
            top_organism: topOf(u.organisms),
        }))
        .sort((a, b) => b.isolates - a.isolates);

    /* วันนอนที่พบเชื้อ */
    const hospDays = HOSP_DAY_BUCKETS.map(b => ({ label: b.label, ho: b.max >= HO_DAY, events: 0 }));
    for (const e of inpatientEvents) {
        const i = HOSP_DAY_BUCKETS.findIndex(b => (e.hospDay ?? 0) <= b.max);
        hospDays[i].events++;
    }

    /* อายุและเพศ นับเป็นคน ใช้อายุ ณ ผลแรกของปี */
    const firstByHn = new Map<string, Isolate>();
    for (const r of current) {
        const seen = firstByHn.get(r.hn);
        if (!seen || r.spec < seen.spec) firstByHn.set(r.hn, r);
    }
    const ageBands = [...AGE_BANDS, { label: 'ไม่ทราบอายุ', max: NaN }].map(b => ({ label: b.label, patients: 0, male: 0, female: 0 }));
    for (const r of firstByHn.values()) {
        const i = r.age === null || r.age < 0 ? AGE_BANDS.length : AGE_BANDS.findIndex(b => r.age! <= b.max);
        ageBands[i].patients++;
        if (r.sex === 'male') ageBands[i].male++;
        if (r.sex === 'female') ageBands[i].female++;
    }

    /*
      สัญญาณกลุ่มก้อน — ติดในโรงพยาบาล หน่วยงานเดียวกัน เชื้อเดียวกัน กลุ่มดื้อยาเดียวกัน
      ต่อกันเป็นสายถ้าแต่ละรายห่างจากรายก่อนไม่เกิน 14 วัน แล้วเก็บสายที่มีตั้งแต่ 2 คนขึ้นไป
      เป็นตัวชี้ให้ไปดู ไม่ใช่คำยืนยันว่ามีการระบาด (ต้องดูผลความไวยาและประวัติการย้ายเตียงประกอบ)
    */
    const chains = new Map<string, Isolate[]>();
    for (const e of [...hoEvents].sort((a, b) => a.spec.localeCompare(b.spec))) {
        const key = `${e.unit}|${e.organism}|${e.group}`;
        if (!chains.has(key)) chains.set(key, []);
        chains.get(key)!.push(e);
    }
    const untilDay = dayNum(range.until);
    const clusters: {
        unit: string; organism: string; group: GroupKey; patients: number; events: number;
        first: string; last: string; active: boolean;
    }[] = [];
    for (const list of chains.values()) {
        let run: Isolate[] = [];
        const flush = () => {
            const pts = new Set(run.map(r => r.hn)).size;
            if (pts >= CLUSTER_MIN_PATIENTS) {
                const last = run[run.length - 1].spec;
                clusters.push({
                    unit: run[0].unit, organism: run[0].organism, group: run[0].group,
                    patients: pts, events: run.length, first: run[0].spec, last,
                    active: untilDay - dayNum(last) <= CLUSTER_WINDOW_DAYS,
                });
            }
        };
        for (const e of list) {
            if (run.length && dayNum(e.spec) - dayNum(run[run.length - 1].spec) > CLUSTER_WINDOW_DAYS) {
                flush();
                run = [];
            }
            run.push(e);
        }
        if (run.length) flush();
    }
    clusters.sort((a, b) => Number(b.active) - Number(a.active) || b.patients - a.patients || b.last.localeCompare(a.last));

    /* ตัวเลขหลัก */
    const tatAll = monthly.flatMap(m => m.tat);
    const isoPerHn = new Map<string, number>();
    current.forEach(r => bump(isoPerHn, r.hn));
    const priorSame = prior.filter(r => r.confirm <= prevSameUntil);
    const totalPatientDays = patientDays.reduce((s, n) => s + n, 0);

    const summary = {
        isolates: current.length,
        patients: isoPerHn.size,
        critical: current.filter(r => CRITICAL.includes(r.group)).length,
        critical_patients: new Set(current.filter(r => CRITICAL.includes(r.group)).map(r => r.hn)).size,
        opd_isolates: current.filter(r => r.onset === 'opd').length,
        co_isolates: current.filter(r => r.onset === 'co').length,
        ho_isolates: current.filter(r => r.onset === 'ho').length,
        inpatient_events: inpatientEvents.length,
        ho_events: hoEvents.length,
        patient_days: totalPatientDays,
        ho_rate: rate(hoEvents.length, totalPatientDays),
        inpatient_rate: rate(inpatientEvents.length, totalPatientDays),
        repeat_patients: [...isoPerHn.values()].filter(n => n > 1).length,
        units: units.size,
        organisms: new Set(current.map(r => r.organism)).size,
        tat_p50: pct(tatAll, 0.5),
        tat_p90: pct(tatAll, 0.9),
        tat_n: tatAll.length,
        clusters: clusters.length,
        active_clusters: clusters.filter(c => c.active).length,
        prior_same_period: {
            isolates: priorSame.length,
            patients: new Set(priorSame.map(r => r.hn)).size,
            critical: priorSame.filter(r => CRITICAL.includes(r.group)).length,
        },
        prior_full_year: { isolates: prior.length },
    };

    return {
        fiscal_year: range.fy,
        current_fiscal_year: range.current,
        start_date: range.start,
        end_date: range.end,
        until_date: range.until,
        prior: { fiscal_year: range.fy - 1, start_date: prevStart, end_date: prevEnd, same_until: prevSameUntil },
        definitions: {
            groups: GROUP_KEYS,
            critical_groups: CRITICAL,
            ho_day: HO_DAY,
            cluster_window_days: CLUSTER_WINDOW_DAYS,
            cluster_min_patients: CLUSTER_MIN_PATIENTS,
        },
        summary,
        monthly: monthly.map(m => ({
            month: m.month,
            future: m.future,
            isolates: m.isolates,
            patients: m.patients.size,
            groups: m.groups,
            critical: m.critical,
            prior_isolates: m.prior_isolates,
            ho_events: m.ho_events,
            inpatient_events: m.inpatient_events,
            patient_days: m.patient_days,
            ho_rate: m.future ? null : rate(m.ho_events, m.patient_days),
            inpatient_rate: m.future ? null : rate(m.inpatient_events, m.patient_days),
            tat_p50: pct(m.tat, 0.5),
            tat_p90: pct(m.tat, 0.9),
        })),
        by_group: byGroup,
        hosp_days: hospDays,
        organism_matrix: matrix('organism'),
        specimen_matrix: matrix('specimen'),
        by_unit: byUnit,
        age_bands: ageBands.filter(b => b.label !== 'ไม่ทราบอายุ' || b.patients > 0),
        clusters,
        generated_at: new Date().toISOString(),
    };
};

/*
  ผลรวมทั้งปีงบต้องสแกนตารางผลเพาะเชื้อทั้งตาราง (ไม่มีดัชนีที่ ConfirmDate) บนฐาน HIS ที่ใช้งานจริง
  เก็บผลไว้ 10 นาทีต่อปีงบ และให้คำขอที่เข้ามาพร้อมกันรอผลก้อนเดียวกัน ไม่ยิงซ้ำ
*/
const cache = new Map<number, { at: number; promise: Promise<Awaited<ReturnType<typeof buildAnalytics>>> }>();

const analyticsFor = (fyRaw: unknown) => {
    const fy = fiscalRange(fyRaw).fy;
    const hit = cache.get(fy);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
    const promise = buildAnalytics(fy);
    cache.set(fy, { at: Date.now(), promise });
    promise.catch(() => cache.delete(fy));
    return promise;
};

export const getIcAnalytics = async ({ query, set }: Context) => {
    try {
        const data = await analyticsFor((query as { fy?: string } | undefined)?.fy);
        return { success: true, data };
    } catch (error) {
        console.error('Get IC analytics error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
