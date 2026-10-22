import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor } from '../utils/nursingRecord';
import { wardGroupOf } from '../utils/wardGroup';
import { workdaysBetween, monthBounds } from '../utils/workdays';
import { itemHours, fteOfHours, productOfHours, round2, pct, safeDiv, HOURS_PER_SHIFT } from '../utils/fte';

/**
 * FTE และ product ของหน่วยงานที่ไม่ใช่หอผู้ป่วย — ER · ห้องผ่าตัด · วิสัญญี · ห้องคลอด · OPD
 *
 * ที่มาคือไฟล์ FTE ของแต่ละงานใน docs/ ซึ่งแกะแล้วใช้สูตรรูปเดียวกันหมด (ดู utils/fte.ts)
 * ต่างกันแค่รายการที่นับกับชั่วโมงต่อราย ซึ่งอยู่ในตาราง work_unit_items
 * คิดจบฝั่งเซิร์ฟเวอร์เหมือนหน้า FTE ของหอผู้ป่วย หน้าจอไม่ต้องรู้สูตร
 *
 * ช่องขาด/เกินคิดจากคนขึ้นเวรปกติ ไม่นับ OT ทุกหน่วย แบบเดียวกับหอผู้ป่วย
 * ไฟล์ต้นฉบับแต่ละงานเขียนช่องนี้ไม่เหมือนกัน (บางไฟล์รวม OT บางไฟล์กลับเครื่องหมาย)
 * ถ้าทำตามทีละไฟล์ ตัวเลขขาด/เกินจะเทียบข้ามหน่วยไม่ได้ และหน่วยที่เรียก OT ทุกวันจะดูเหมือนกำลังพอ
 */

const isMonth = (v: unknown) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v ?? ''));
const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(String(v)));
const clean = (v: unknown) => sanitizeHTML(String(v ?? '').trim()) ?? '';

/** ดึก · เช้า · บ่าย ตาม admission_change_shift_types — ลำดับเดียวกับแบบฟอร์ม (N D E) */
const SHIFTS = [1, 2, 3] as const;
/** หน่วยรายเดือนเก็บที่เวร 0 */
const MONTH_SHIFT = 0;

const MAX_ENTRIES = 3000;
const MAX_QTY = 99_999;
const MAX_STAFF = 9_999;

interface Item { id: number; code: string; name: string; hours: number }

interface Unit {
    id: number;
    code: string;
    name: string;
    period: 'shift' | 'month';
    group: string | null;
    /** สัดส่วนของเวร (0-1) ตาม shift_type_id — null = ไม่ถ่วง */
    weights: Record<number, number> | null;
    /** รหัสหอที่ใช้นับคนจากตารางเวร — null = กรอกจำนวนคนเอง */
    staffWard: string | null;
    items: Item[];
}

const loadUnits = async (): Promise<Unit[]> => {
    const [units, items] = await Promise.all([
        nurse`
            SELECT work_unit_id, code, name, period, unit_group, weight_n, weight_d, weight_e, staff_ward
            FROM work_units
            WHERE is_active
            ORDER BY display_order, work_unit_id`,
        nurse`
            SELECT item_id, work_unit_id, code, name, care_hours
            FROM work_unit_items
            WHERE is_active
            ORDER BY display_order, item_id`,
    ]);

    return units.map(u => ({
        id: Number(u.work_unit_id),
        code: clean(u.code),
        name: clean(u.name),
        period: u.period === 'month' ? 'month' : 'shift',
        group: u.unit_group ? clean(u.unit_group) : null,
        weights: u.weight_n === null ? null : {
            1: Number(u.weight_n) / 100,
            2: Number(u.weight_d) / 100,
            3: Number(u.weight_e) / 100,
        },
        staffWard: u.staff_ward ? String(u.staff_ward) : null,
        items: items
            .filter(i => Number(i.work_unit_id) === Number(u.work_unit_id))
            .map(i => ({ id: Number(i.item_id), code: clean(i.code), name: clean(i.name), hours: Number(i.care_hours) })),
    }));
};

const unitInfo = (u: Unit) => ({
    work_unit_id: u.id,
    code: u.code,
    name: u.name,
    period: u.period,
    group: u.group,
    shift_weights: u.weights ? SHIFTS.map(s => ({ shift_type_id: s, weight: round2(u.weights![s] * 100) })) : null,
    staff_from_schedule: u.staffWard !== null,
    items: u.items.map(i => ({ item_id: i.id, code: i.code, name: i.name, care_hours: i.hours })),
});

/** GET /work-units — หน่วยงานทั้งหมดพร้อมรายการที่นับ ให้หน้าจอสร้างตารางกรอกได้ */
export const getWorkUnits = async ({ set }: { set: { status?: number | string } }) => {
    try {
        return { success: true, data: (await loadUnits()).map(unitInfo) };
    } catch (error) {
        console.error('Get work units error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/* ───────────────────────── คนขึ้นเวร ───────────────────────── */

interface Staff { regular: number; ot: number }

/**
 * คนขึ้นเวรรายวันรายเวร และจำนวนคนที่มีจริงในช่วงนั้น
 *
 * หน่วยที่จัดเวรในระบบแล้ว (ห้องคลอด) นับจากตารางเวร แบบเดียวกับหน้า FTE ของหอผู้ป่วย
 * นับหัวคนไม่ซ้ำ OT 8 และ OT 4 นับเป็นหนึ่งคนเท่ากัน (ตัวหารของ product ในแบบฟอร์มนับหัว)
 * หน่วยที่ยังไม่ได้จัดเวรในระบบอ่านจากที่กรอกไว้
 */
const loadStaff = async (unit: Unit, from: string, to: string) => {
    const byKey = new Map<string, Staff>();
    let headcount: number | null = null;

    if (unit.staffWard) {
        const codes = (await wardGroupOf(unit.staffWard))?.codes ?? [unit.staffWard];
        const rows = await nurse`
            SELECT TO_CHAR(a.shift_date, 'YYYY-MM-DD')        AS d
                 , nst.admission_change_shift_type_id         AS s
                 , (nst.code LIKE '%\\_OT%')                  AS is_ot
                 , COUNT(DISTINCT a.staff_id)::int            AS n
            FROM nurse_shift_assignments a
            JOIN nurse_shift_types nst ON nst.nurse_shift_type_id = a.nurse_shift_type_id
            WHERE a.ward IN ${nurse(codes)}
              AND nst.admission_change_shift_type_id <> 0
              AND a.shift_date BETWEEN ${from}::date AND ${to}::date
            GROUP BY 1, 2, 3`;
        for (const r of rows) {
            const k = `${r.d}|${r.s}`;
            const cur = byKey.get(k) ?? { regular: 0, ot: 0 };
            if (r.is_ot) cur.ot += Number(r.n); else cur.regular += Number(r.n);
            byKey.set(k, cur);
        }
        // คนที่ลาทั้งเดือนจะไม่มีเวรสักเวร จึงหลุดจากการนับเอง ตรงตามคู่มือของแบบฟอร์ม
        const [hc] = await nurse`
            SELECT COUNT(DISTINCT a.staff_id)::int AS n
            FROM nurse_shift_assignments a
            JOIN nurse_shift_types nst ON nst.nurse_shift_type_id = a.nurse_shift_type_id
            WHERE a.ward IN ${nurse(codes)}
              AND nst.admission_change_shift_type_id <> 0
              AND a.shift_date BETWEEN ${from}::date AND ${to}::date`;
        headcount = Number(hc?.n ?? 0);
    } else {
        const rows = await nurse`
            SELECT TO_CHAR(record_date, 'YYYY-MM-DD') AS d, shift_type_id AS s, regular, ot
            FROM work_unit_staff
            WHERE work_unit_id = ${unit.id}
              AND record_date BETWEEN ${from}::date AND ${to}::date`;
        for (const r of rows) byKey.set(`${r.d}|${r.s}`, { regular: Number(r.regular), ot: Number(r.ot) });

        // ช่วงหลายเดือนใช้ค่าของเดือนล่าสุดที่กรอกไว้ — คนในหน่วยไม่ได้บวกกันข้ามเดือน
        const [hc] = await nurse`
            SELECT nurses FROM work_unit_headcount
            WHERE work_unit_id = ${unit.id}
              AND month BETWEEN DATE_TRUNC('month', ${from}::date) AND ${to}::date
            ORDER BY month DESC LIMIT 1`;
        headcount = hc ? Number(hc.nurses) : null;
    }

    return { byKey, headcount };
};

const loadCounts = async (unitIds: number[], from: string, to: string) => {
    if (unitIds.length === 0) return [];
    return nurse`
        SELECT work_unit_id AS u, TO_CHAR(record_date, 'YYYY-MM-DD') AS d, shift_type_id AS s, item_id, qty
        FROM work_unit_counts
        WHERE work_unit_id IN ${nurse(unitIds)}
          AND record_date BETWEEN ${from}::date AND ${to}::date`;
};

/* ───────────────────────── รายงานรายเวร ───────────────────────── */

/**
 * POST /work-units/report — แบบฟอร์ม "การคิด FTE รายวัน" ของหน่วยที่นับรายเวร
 *
 * ทุกวันทุกเวรของเดือนปรากฏในผลลัพธ์ วันที่ยังไม่กรอกเป็นแถวว่าง (entered = false)
 * ไม่ใช่หายไป คนอ่านจะได้แยกออกว่า "ไม่มีงาน" กับ "ยังไม่ได้กรอก"
 */
export const getWorkUnitReport = async (
    { body, set }: { body: { work_unit_id: number; month: string }; set: { status?: number | string } }
) => {
    const { work_unit_id, month } = body ?? {};
    if (!Number.isInteger(Number(work_unit_id)) || !isMonth(month)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ work_unit_id และ month (รูปแบบ YYYY-MM)' };
    }

    try {
        const unit = (await loadUnits()).find(u => u.id === Number(work_unit_id));
        if (!unit) {
            set.status = 404;
            return { success: false, message: 'ไม่พบหน่วยงานที่ระบุ' };
        }
        if (unit.period !== 'shift') {
            set.status = 400;
            return { success: false, message: 'หน่วยนี้นับรายเดือน ใช้รายงานรวมของกลุ่มแทน' };
        }

        const { first, last, days } = monthBounds(month);
        const hours = unit.items.map(i => i.hours);
        const itemIndex = new Map(unit.items.map((i, idx) => [i.id, idx]));

        const [counts, staff, wd] = await Promise.all([
            loadCounts([unit.id], first, last),
            loadStaff(unit, first, last),
            workdaysBetween(first, last),
        ]);

        const qtyByKey = new Map<string, number[]>();
        for (const c of counts) {
            const idx = itemIndex.get(Number(c.item_id));
            if (idx === undefined) continue; // รายการที่ปิดใช้งานแล้ว ไม่นับ
            const k = `${c.d}|${c.s}`;
            const q = qtyByKey.get(k) ?? unit.items.map(() => 0);
            q[idx] = Number(c.qty);
            qtyByKey.set(k, q);
        }

        const weightOf = (s: number) => unit.weights?.[s] ?? 1;

        const rows: {
            record_date: string; shift_type_id: number; entered: boolean; qty: number[];
            hours: number; fte: number; staff: Staff & { total: number }; diff: number; product: number | null;
        }[] = [];
        for (let day = 1; day <= days; day++) {
            const d = `${month}-${String(day).padStart(2, '0')}`;
            for (const s of SHIFTS) {
                const k = `${d}|${s}`;
                const qty = qtyByKey.get(k) ?? unit.items.map(() => 0);
                const st = staff.byKey.get(k) ?? { regular: 0, ot: 0 };
                const h = itemHours(qty, hours);
                const w = weightOf(s);
                const fte = fteOfHours(h, w);
                rows.push({
                    record_date: d,
                    shift_type_id: s,
                    entered: qtyByKey.has(k) || (!unit.staffWard && staff.byKey.has(k)),
                    qty,
                    hours: round2(h * w),
                    fte: round2(fte),
                    staff: { regular: st.regular, ot: st.ot, total: st.regular + st.ot },
                    diff: round2(st.regular - fte),
                    product: pct(productOfHours(h, w, st.regular + st.ot)),
                });
            }
        }

        // ───── รวมทั้งเดือน แยกเวร และรวมทั้งหมด (แถว 102-105 ของแบบฟอร์ม) ─────
        const sum = (list: typeof rows) => {
            const qty = unit.items.map((_, i) => list.reduce((a, r) => a + r.qty[i], 0));
            const regular = list.reduce((a, r) => a + r.staff.regular, 0);
            const ot = list.reduce((a, r) => a + r.staff.ot, 0);
            // ชั่วโมงถ่วงแล้วของแต่ละแถว บวกกันได้ตรง ต่างเวรถ่วงต่างกันก็ไม่เพี้ยน
            const weighted = list.reduce((a, r) => a + itemHours(r.qty, hours) * weightOf(r.shift_type_id), 0);
            const fte = weighted / HOURS_PER_SHIFT;
            return {
                qty,
                hours: round2(weighted),
                fte: round2(fte),
                staff: { regular, ot, total: regular + ot },
                diff: round2(regular - fte),
                product: pct(safeDiv(weighted, (regular + ot) * HOURS_PER_SHIFT)),
            };
        };

        const byShift = SHIFTS.map(s => ({ shift_type_id: s, ...sum(rows.filter(r => r.shift_type_id === s)) }));
        const total = sum(rows);

        // จำนวนพยาบาลตาม FTE (C6) = ชั่วโมงภาระงานทั้งเดือน ÷ (วันราชการ × 7)
        const nursesByFte = wd.workdays === 0 ? null : round2(total.hours / (wd.workdays * HOURS_PER_SHIFT));

        return {
            success: true,
            data: {
                unit: unitInfo(unit),
                month,
                rows,
                monthly: { by_shift: byShift, total },
                header: {
                    nurses: staff.headcount,
                    workdays: wd.workdays,
                    public_holidays: wd.public_holidays,
                    nurses_by_fte: nursesByFte,
                    over_under: staff.headcount === null || nursesByFte === null ? null : round2(staff.headcount - nursesByFte),
                    product_month: total.product,
                },
                // เวรที่มีงานแต่ไม่มีคนขึ้น — product หารไม่ได้ ต้องเตือนให้เห็น ไม่ใช่แสดงขีดเงียบๆ
                no_staff_rows: rows.filter(r => r.hours > 0 && r.staff.total === 0).length,
                entered_rows: rows.filter(r => r.entered).length,
            },
        };
    } catch (error) {
        console.error('Get work unit report error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/* ───────────────────────── รายงานรวมกลุ่ม (OPD) ───────────────────────── */

/**
 * POST /work-units/group-report — สรุปหน่วยรายเดือนทั้งกลุ่ม (ชีต "สรุปรวม" ของ OPD)
 *
 * เลือกช่วงหลายเดือนได้ (เช่น ทั้งปีงบ) ผลรวมของห้องตรวจแต่ละห้องบวกจากทุกเดือนในช่วง
 * product รวมทั้งกลุ่มคิดจาก ผลรวมชั่วโมง ÷ ผลรวมชั่วโมงทำงาน ไม่ใช่ค่าเฉลี่ยของร้อยละแต่ละห้อง
 * ไฟล์เดิมเฉลี่ยร้อยละ (L22 = SUM(L4:L18)/18) ทำให้ห้องที่มีพยาบาลคนเดียวมีน้ำหนักเท่าห้องที่มีสิบคน
 */
export const getWorkUnitGroupReport = async (
    { body, set }: { body: { group: string; month_from: string; month_to: string }; set: { status?: number | string } }
) => {
    const { group, month_from, month_to } = body ?? {};
    if (!group || !isMonth(month_from) || !isMonth(month_to) || month_from > month_to) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ group และช่วงเดือน (YYYY-MM) ให้ถูกต้อง' };
    }

    try {
        const units = (await loadUnits()).filter(u => u.group === group && u.period === 'month');
        if (units.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบกลุ่มหน่วยงานที่ระบุ' };
        }

        const from = monthBounds(month_from).first;
        const to = monthBounds(month_to).last;
        const ids = units.map(u => u.id);

        const [counts, staffRows, headRows, wd] = await Promise.all([
            loadCounts(ids, from, to),
            nurse`
                SELECT work_unit_id AS u, TO_CHAR(record_date, 'YYYY-MM') AS m, regular, ot
                FROM work_unit_staff
                WHERE work_unit_id IN ${nurse(ids)} AND shift_type_id = ${MONTH_SHIFT}
                  AND record_date BETWEEN ${from}::date AND ${to}::date`,
            nurse`
                SELECT DISTINCT ON (work_unit_id) work_unit_id AS u, nurses
                FROM work_unit_headcount
                WHERE work_unit_id IN ${nurse(ids)} AND month BETWEEN ${from}::date AND ${to}::date
                ORDER BY work_unit_id, month DESC`,
            workdaysBetween(from, to),
        ]);

        const headOf = new Map(headRows.map(r => [Number(r.u), Number(r.nurses)]));

        const rows = units.map(u => {
            const hoursOfItem = new Map(u.items.map(i => [i.id, i.hours]));
            const mine = counts.filter(c => Number(c.u) === u.id && hoursOfItem.has(Number(c.item_id)));
            const qty = u.items.map(i => mine.filter(c => Number(c.item_id) === i.id).reduce((a, c) => a + Number(c.qty), 0));
            const h = itemHours(qty, u.items.map(i => i.hours));
            const st = staffRows.filter(r => Number(r.u) === u.id);
            const regular = st.reduce((a, r) => a + Number(r.regular), 0);
            const ot = st.reduce((a, r) => a + Number(r.ot), 0);
            // FTE ของ OPD นับเป็น "วันทำงาน" (ชั่วโมง ÷ 7) เทียบกับวันทำงานที่กรอก
            const fteDays = fteOfHours(h, 1);
            const ftePersons = wd.workdays === 0 ? null : h / (wd.workdays * HOURS_PER_SHIFT);
            const nurses = headOf.get(u.id) ?? null;
            const months = [...new Set([...mine.map(c => String(c.d).slice(0, 7)), ...st.map(r => String(r.m))])].sort();

            return {
                work_unit_id: u.id,
                code: u.code,
                name: u.name,
                qty,
                hours: round2(h),
                staff: { regular, ot, total: regular + ot },
                fte_days: round2(fteDays),
                diff_days: round2(regular - fteDays),
                fte_persons: ftePersons === null ? null : round2(ftePersons),
                nurses,
                over_under: nurses === null || ftePersons === null ? null : round2(nurses - ftePersons),
                product: pct(productOfHours(h, 1, regular + ot)),
                months_entered: months.length,
            };
        });

        const hTotal = rows.reduce((a, r) => a + r.hours, 0);
        const regular = rows.reduce((a, r) => a + r.staff.regular, 0);
        const ot = rows.reduce((a, r) => a + r.staff.ot, 0);
        const fteDays = hTotal / HOURS_PER_SHIFT;
        const ftePersons = wd.workdays === 0 ? null : hTotal / (wd.workdays * HOURS_PER_SHIFT);
        const nursesKnown = rows.filter(r => r.nurses !== null);
        const nurses = nursesKnown.length ? nursesKnown.reduce((a, r) => a + (r.nurses ?? 0), 0) : null;

        return {
            success: true,
            data: {
                group,
                month_from,
                month_to,
                workdays: wd.workdays,
                public_holidays: wd.public_holidays,
                items: units[0].items.map(i => ({ item_id: i.id, code: i.code, name: i.name, care_hours: i.hours })),
                rows,
                total: {
                    qty: units[0].items.map((_, i) => rows.reduce((a, r) => a + (r.qty[i] ?? 0), 0)),
                    hours: round2(hTotal),
                    staff: { regular, ot, total: regular + ot },
                    fte_days: round2(fteDays),
                    diff_days: round2(regular - fteDays),
                    fte_persons: ftePersons === null ? null : round2(ftePersons),
                    nurses,
                    over_under: nurses === null || ftePersons === null ? null : round2(nurses - ftePersons),
                    product: pct(safeDiv(hTotal, (regular + ot) * HOURS_PER_SHIFT)),
                },
            },
        };
    } catch (error) {
        console.error('Get work unit group report error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/* ───────────────────────── บันทึกยอด ───────────────────────── */

interface EntryBody {
    month: string;
    entries: {
        work_unit_id: number;
        record_date: string;
        shift_type_id: number;
        qty: { item_id: number; qty: number | null }[];
        regular?: number | null;
        ot?: number | null;
    }[];
    headcount?: { work_unit_id: number; nurses: number | null }[];
}

/** จำนวนคน/วันทำงาน ทศนิยมได้ 2 ตำแหน่ง (OPD กรอกเป็นวันทำงานซึ่งมีเศษวัน เช่น 103.24) */
const isStaffValue = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_STAFF && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;

/**
 * PUT /work-units/entries — บันทึกยอดงานและคนขึ้นเวรของเดือนหนึ่ง (หลายหน่วยได้ในครั้งเดียว)
 *
 * ช่องที่ส่ง null มา = ลบค่าที่เคยกรอก (กลับเป็น "ยังไม่ได้กรอก") ไม่ได้เก็บเป็นศูนย์
 * เพราะศูนย์แปลว่า "ไม่มีงาน" ซึ่งต่างจาก "ยังไม่ได้กรอก"
 * ทั้งชุดอยู่ใน transaction เดียว พังกลางทางต้องไม่เหลือครึ่งเดือนที่บันทึกแล้วครึ่งที่ไม่ได้บันทึก
 */
export const saveWorkUnitEntries = async (
    { body, set, user }: { body: EntryBody; set: { status?: number | string }; user: unknown }
) => {
    const { month, entries = [], headcount = [] } = body ?? ({} as EntryBody);
    if (!isMonth(month)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ month (รูปแบบ YYYY-MM)' };
    }
    if (entries.length > MAX_ENTRIES) {
        set.status = 400;
        return { success: false, message: `ส่งได้ไม่เกิน ${MAX_ENTRIES} แถวต่อครั้ง` };
    }

    const bad = (message: string) => {
        set.status = 400;
        return { success: false, message };
    };

    try {
        const units = new Map((await loadUnits()).map(u => [u.id, u]));
        const { first, last } = monthBounds(month);

        const countRows: { u: number; d: string; s: number; item: number; qty: number | null }[] = [];
        const staffRows: { u: number; d: string; s: number; regular: number | null; ot: number | null }[] = [];

        for (const e of entries) {
            const unit = units.get(Number(e.work_unit_id));
            if (!unit) return bad(`ไม่พบหน่วยงานรหัส ${e.work_unit_id}`);

            const d = String(e.record_date ?? '');
            const s = Number(e.shift_type_id);
            if (unit.period === 'month') {
                if (d !== first || s !== MONTH_SHIFT) return bad(`${unit.name} นับรายเดือน ต้องบันทึกที่วันที่ ${first} เวร 0`);
            } else if (!isDate(d) || d < first || d > last || !SHIFTS.includes(s as 1 | 2 | 3)) {
                return bad(`วันที่หรือเวรของ ${unit.name} ไม่อยู่ในเดือน ${month}`);
            }

            const itemIds = new Set(unit.items.map(i => i.id));
            for (const q of e.qty ?? []) {
                if (!itemIds.has(Number(q.item_id))) return bad(`รายการ ${q.item_id} ไม่ใช่ของ ${unit.name}`);
                const v = q.qty;
                if (v !== null && (!Number.isInteger(v) || v < 0 || v > MAX_QTY)) {
                    return bad(`จำนวนของ ${unit.name} วันที่ ${d} ต้องเป็นจำนวนเต็ม 0-${MAX_QTY}`);
                }
                countRows.push({ u: unit.id, d, s, item: Number(q.item_id), qty: v });
            }

            const hasStaff = e.regular !== undefined || e.ot !== undefined;
            if (hasStaff) {
                // หน่วยที่จัดเวรในระบบแล้วนับคนจากตารางเวร ไม่รับตัวเลขกรอกเอง ไม่งั้นจะมีสองแหล่งที่ไม่ตรงกัน
                if (unit.staffWard) return bad(`${unit.name} นับคนขึ้นเวรจากตารางเวร กรอกจำนวนคนเองไม่ได้`);
                const regular = e.regular ?? null;
                const ot = e.ot ?? null;
                if ((regular !== null && !isStaffValue(regular)) || (ot !== null && !isStaffValue(ot))) {
                    return bad(`จำนวนคนของ ${unit.name} วันที่ ${d} ต้องเป็นตัวเลข 0-${MAX_STAFF} (ทศนิยมได้ 2 ตำแหน่ง)`);
                }
                staffRows.push({ u: unit.id, d, s, regular, ot });
            }
        }

        const headRows: { u: number; nurses: number | null }[] = [];
        for (const h of headcount) {
            const unit = units.get(Number(h.work_unit_id));
            if (!unit) return bad(`ไม่พบหน่วยงานรหัส ${h.work_unit_id}`);
            if (unit.staffWard) return bad(`${unit.name} นับจำนวนพยาบาลจากตารางเวร กรอกเองไม่ได้`);
            const n = h.nurses;
            if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999)) return bad(`จำนวนพยาบาลของ ${unit.name} ไม่ถูกต้อง`);
            headRows.push({ u: unit.id, nurses: n });
        }

        const actor = await resolveActor(user);
        const by = actor?.username ?? null;

        await nurse.begin(async sql => {
            for (const r of countRows) {
                if (r.qty === null) {
                    await sql`
                        DELETE FROM work_unit_counts
                        WHERE work_unit_id = ${r.u} AND record_date = ${r.d} AND shift_type_id = ${r.s} AND item_id = ${r.item}`;
                } else {
                    await sql`
                        INSERT INTO work_unit_counts (work_unit_id, record_date, shift_type_id, item_id, qty, updated_by, updated_at)
                        VALUES (${r.u}, ${r.d}, ${r.s}, ${r.item}, ${r.qty}, ${by}, now())
                        ON CONFLICT (work_unit_id, record_date, shift_type_id, item_id)
                        DO UPDATE SET qty = EXCLUDED.qty, updated_by = EXCLUDED.updated_by, updated_at = now()
                        WHERE work_unit_counts.qty IS DISTINCT FROM EXCLUDED.qty`;
                }
            }
            for (const r of staffRows) {
                if (r.regular === null && r.ot === null) {
                    await sql`
                        DELETE FROM work_unit_staff
                        WHERE work_unit_id = ${r.u} AND record_date = ${r.d} AND shift_type_id = ${r.s}`;
                } else {
                    await sql`
                        INSERT INTO work_unit_staff (work_unit_id, record_date, shift_type_id, regular, ot, updated_by, updated_at)
                        VALUES (${r.u}, ${r.d}, ${r.s}, ${r.regular ?? 0}, ${r.ot ?? 0}, ${by}, now())
                        ON CONFLICT (work_unit_id, record_date, shift_type_id)
                        DO UPDATE SET regular = EXCLUDED.regular, ot = EXCLUDED.ot, updated_by = EXCLUDED.updated_by, updated_at = now()
                        WHERE (work_unit_staff.regular, work_unit_staff.ot) IS DISTINCT FROM (EXCLUDED.regular, EXCLUDED.ot)`;
                }
            }
            for (const r of headRows) {
                if (r.nurses === null) {
                    await sql`DELETE FROM work_unit_headcount WHERE work_unit_id = ${r.u} AND month = ${first}`;
                } else {
                    await sql`
                        INSERT INTO work_unit_headcount (work_unit_id, month, nurses, updated_by, updated_at)
                        VALUES (${r.u}, ${first}, ${r.nurses}, ${by}, now())
                        ON CONFLICT (work_unit_id, month)
                        DO UPDATE SET nurses = EXCLUDED.nurses, updated_by = EXCLUDED.updated_by, updated_at = now()`;
                }
            }
        });

        return { success: true, message: 'บันทึกแล้ว' };
    } catch (error) {
        console.error('Save work unit entries error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
