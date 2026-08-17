/**
 * จัดเวรอัตโนมัติ — สร้าง "ร่าง" ตารางเวรจากอัตรากำลังที่ตั้งไว้
 *
 * ตัวนี้ไม่เขียนฐานข้อมูล คืนร่างให้หน้าจอเอาไปให้หัวหน้าเวรตรวจก่อน
 * แล้วค่อยบันทึกผ่าน /nurse-schedules เส้นทางเดิม
 * ตั้งใจแยกกัน เพราะตารางเวรกระทบรายได้และชีวิตส่วนตัวของคน
 * ไม่ควรมีอะไรเขียนลงไปโดยที่ไม่มีคนกดยืนยัน
 *
 * ข้อตกลงที่ใช้ในรุ่นนี้ (ยังไม่มีตารางกติกา จึงฝังไว้เป็นค่าคงที่ที่อ่านได้)
 *   - โควตาถือเป็น "เป้าหมาย" คือพยายามเติมให้ครบ ไม่ใช่เพดานห้ามเกิน
 *   - จัดเฉพาะเวรปกติ (M / A / N) ไม่แตะ OT เพราะ OT เป็นเงินและต้องมีคนอนุมัติ
 *   - ยังไม่ดูวันลา เพราะระบบลายังไม่มีข้อมูล — ผู้ใช้ต้องตรวจเองก่อนบันทึก
 *   - เวรที่จัดด้วยมือไว้แล้วถือว่าล็อก ตัวจัดจะเติมเฉพาะช่องที่ยังว่าง
 */

import { Context } from 'elysia';
import { nurse, core_kon } from '../db';
import { sanitizeHTML } from '../utils/sanitize';

const clean = (v: unknown) => sanitizeHTML(String(v ?? '').trim()) ?? '';

/** กติกาความปลอดภัยขั้นต่ำ — ค่าเหล่านี้ควรย้ายไปตารางตั้งค่าเมื่อมีหน้าจอจัดการ */
export const SCHEDULE_RULES = {
    /** ขึ้นเวรติดต่อกันได้ไม่เกินกี่วัน */
    maxConsecutiveDays: 6,
    /** ต้องมีวันหยุดอย่างน้อยกี่วันในหนึ่งเดือน */
    minDaysOffPerMonth: 4,
    /** ห้ามลงดึกแล้วต่อเช้าวันรุ่งขึ้น — เวลาพักไม่พอ */
    forbidNightThenMorning: true,
};

/** เวรปกติที่ตัวจัดเวรแตะได้ เรียงตามลำดับที่ควรเติมก่อน (ดึกหาคนยากสุด) */
const BASE_SHIFTS = ['N', 'M', 'A'] as const;
type BaseShift = typeof BASE_SHIFTS[number];

interface StaffRow {
    staff_id: number;
    fullname: string;
    staff_position_id: number;
    code: string;
}

interface Plan {
    /** เวรที่ลงให้แล้วในร่างนี้ คีย์ = 'YYYY-MM-DD' */
    byDay: Map<string, BaseShift>;
    total: number;
    nights: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

export const generateSchedule = async ({ body, set }: Context) => {
    const { ward, month } = body as { ward: string; month: string };

    const wardCode = clean(ward);
    if (!/^\d{4}-\d{2}$/.test(String(month ?? ''))) {
        set.status = 400;
        return { success: false, message: 'เดือนต้องอยู่ในรูปแบบ YYYY-MM' };
    }
    if (!wardCode) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุหอผู้ป่วย' };
    }

    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr);
    const daysInMonth = new Date(year, monthIndex, 0).getDate();
    const dateOf = (day: number) => `${year}-${pad(monthIndex)}-${pad(day)}`;

    // หน้าจัดเวรส่ง his_code มาเป็นข้อความ ('09') ส่วนตารางโควตาและเจ้าหน้าที่เก็บเป็นตัวเลข
    const wardNumeric = Number(wardCode);
    if (!Number.isInteger(wardNumeric)) {
        set.status = 400;
        return { success: false, message: 'รหัสหอผู้ป่วยไม่ถูกต้อง' };
    }

    try {
        const [staffRows, quotaRows, existingRows, shiftTypeRows, holidayRows] = await Promise.all([
            nurse`
                SELECT s.staff_id, s.fullname, s.staff_position_id, sp.code
                FROM ward_staffs ws
                JOIN staffs s ON s.staff_id = ws.staff_id
                LEFT JOIN staff_position sp ON sp.staff_position_id = s.staff_position_id
                WHERE ws.ward = ${wardNumeric} AND s.is_active = 'Y'
                ORDER BY s.staff_id
            `,
            nurse`
                SELECT staff_position_id, shift_code, quota
                FROM ward_shift_quotas WHERE ward = ${wardNumeric}
            `,
            nurse`
                SELECT staff_id, to_char(shift_date, 'YYYY-MM-DD') AS d, shift_code
                FROM nurse_shift_assignments
                WHERE ward = ${wardCode}
                  AND shift_date >= ${dateOf(1)}::date
                  AND shift_date <= ${dateOf(daysInMonth)}::date
            `,
            nurse`SELECT code, nurse_shift_type_id FROM nurse_shift_types`,
            core_kon`
                SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d, name_th
                FROM core_kon.hr_holidays
                WHERE is_active
                  AND holiday_date >= ${dateOf(1)}::date
                  AND holiday_date <= ${dateOf(daysInMonth)}::date
            `.catch(() => [] as unknown[]),
        ]);

        const staff: StaffRow[] = staffRows.map(r => ({
            staff_id: Number(r.staff_id),
            fullname: clean(r.fullname),
            staff_position_id: Number(r.staff_position_id),
            code: clean(r.code) || 'OTHER',
        }));

        if (staff.length === 0) {
            set.status = 400;
            return { success: false, message: 'หอผู้ป่วยนี้ยังไม่มีเจ้าหน้าที่ กรุณาตั้งค่าที่หน้าหอผู้ป่วยปฏิบัติงานก่อน' };
        }

        // โควตาเฉพาะเวรปกติ — รหัสที่มี '_' คือ OT ซึ่งรุ่นนี้ไม่แตะ
        const quota = new Map<string, number>();   // 'positionId|shift' → จำนวน
        for (const q of quotaRows) {
            const code = clean(q.shift_code);
            if (code.includes('_')) continue;
            if (!BASE_SHIFTS.includes(code as BaseShift)) continue;
            quota.set(`${Number(q.staff_position_id)}|${code}`, Number(q.quota));
        }

        if (quota.size === 0) {
            set.status = 400;
            return {
                success: false,
                message: 'หอผู้ป่วยนี้ยังไม่ได้ตั้งอัตรากำลังต่อเวร กรุณาตั้งค่าที่หน้าตั้งค่าหอผู้ป่วยก่อน',
            };
        }

        const shiftTypeId = new Map<string, number>(
            shiftTypeRows.map(r => [clean(r.code), Number(r.nurse_shift_type_id)])
        );
        const holidays = new Map<string, string>(
            (holidayRows as { d: string; name_th: string }[]).map(h => [String(h.d), clean(h.name_th)])
        );

        // เวรที่จัดไว้แล้วถือว่าล็อก ตัวจัดเวรจะไม่ทับและไม่ลบ
        const locked = new Map<number, Map<string, string>>();
        for (const r of existingRows) {
            const id = Number(r.staff_id);
            if (!locked.has(id)) locked.set(id, new Map());
            locked.get(id)!.set(String(r.d), clean(r.shift_code));
        }

        const plans = new Map<number, Plan>();
        for (const s of staff) {
            const plan: Plan = { byDay: new Map(), total: 0, nights: 0 };
            // นับเวรที่ล็อกไว้เข้าไปด้วย ไม่งั้นคนที่ถูกจัดมือไว้เยอะจะโดนจัดเพิ่มอีก
            for (const [d, code] of locked.get(s.staff_id) ?? []) {
                const base = code.split('_')[0];
                if (BASE_SHIFTS.includes(base as BaseShift)) {
                    plan.byDay.set(d, base as BaseShift);
                    plan.total += 1;
                    if (base === 'N') plan.nights += 1;
                }
            }
            plans.set(s.staff_id, plan);
        }

        const maxShifts = daysInMonth - SCHEDULE_RULES.minDaysOffPerMonth;

        /** ทำงานติดต่อกันกี่วันแล้วถ้านับย้อนจากวันก่อนหน้า */
        const consecutiveBefore = (plan: Plan, day: number) => {
            let n = 0;
            for (let d = day - 1; d >= 1; d--) {
                if (plan.byDay.has(dateOf(d))) n += 1;
                else break;
            }
            return n;
        };

        const canTake = (s: StaffRow, day: number, shift: BaseShift): boolean => {
            const plan = plans.get(s.staff_id)!;
            const date = dateOf(day);

            // ลงเวรอื่นในวันนี้ไปแล้ว หรือถูกกำหนดเป็น OFF ด้วยมือ
            if (plan.byDay.has(date)) return false;
            if ((locked.get(s.staff_id)?.get(date) ?? '') === 'OFF') return false;

            if (plan.total >= maxShifts) return false;

            if (SCHEDULE_RULES.forbidNightThenMorning && shift === 'M' && day > 1) {
                if (plan.byDay.get(dateOf(day - 1)) === 'N') return false;
            }
            if (SCHEDULE_RULES.forbidNightThenMorning && shift === 'N' && day < daysInMonth) {
                // ถ้าพรุ่งนี้ถูกจัดมือให้ขึ้นเช้าไว้แล้ว ลงดึกคืนนี้ไม่ได้
                const tomorrow = locked.get(s.staff_id)?.get(dateOf(day + 1)) ?? '';
                if (tomorrow.split('_')[0] === 'M') return false;
            }

            if (consecutiveBefore(plan, day) >= SCHEDULE_RULES.maxConsecutiveDays) return false;

            return true;
        };

        const assignments: { staff_id: number; shift_date: string; shift_code: string; nurse_shift_type_id: number | null }[] = [];
        const gaps: { date: string; shift: BaseShift; position: string; missing: number }[] = [];

        const positionsInQuota = [...new Set([...quota.keys()].map(k => Number(k.split('|')[0])))];

        for (let day = 1; day <= daysInMonth; day++) {
            const date = dateOf(day);
            for (const shift of BASE_SHIFTS) {
                for (const positionId of positionsInQuota) {
                    const need = quota.get(`${positionId}|${shift}`) ?? 0;
                    if (need <= 0) continue;

                    const pool = staff.filter(s => s.staff_position_id === positionId);

                    // นับคนที่ถูกจัดมือไว้แล้วในเวรนี้ ถือว่าเติมโควตาไปแล้วส่วนหนึ่ง
                    const already = pool.filter(s => plans.get(s.staff_id)!.byDay.get(date) === shift).length;
                    let remaining = need - already;
                    if (remaining <= 0) continue;

                    /*
                      เลือกคนที่ทำงานน้อยที่สุดก่อน เพื่อกระจายภาระให้เท่ากัน
                      เวรดึกนับแยก เพราะเป็นเวรที่หนักที่สุดและคนรู้สึกไวกับความไม่เท่าเทียม
                      ตัวสุดท้ายเรียงด้วย staff_id เพื่อให้ผลลัพธ์เหมือนเดิมทุกครั้งที่กด
                    */
                    const candidates = pool
                        .filter(s => canTake(s, day, shift))
                        .sort((a, b) => {
                            const pa = plans.get(a.staff_id)!;
                            const pb = plans.get(b.staff_id)!;
                            if (shift === 'N' && pa.nights !== pb.nights) return pa.nights - pb.nights;
                            if (pa.total !== pb.total) return pa.total - pb.total;
                            return a.staff_id - b.staff_id;
                        });

                    for (const s of candidates) {
                        if (remaining <= 0) break;
                        const plan = plans.get(s.staff_id)!;
                        plan.byDay.set(date, shift);
                        plan.total += 1;
                        if (shift === 'N') plan.nights += 1;
                        assignments.push({
                            staff_id: s.staff_id,
                            shift_date: date,
                            shift_code: shift,
                            nurse_shift_type_id: shiftTypeId.get(shift) ?? null,
                        });
                        remaining -= 1;
                    }

                    if (remaining > 0) {
                        const label = pool[0]?.code ?? `ตำแหน่ง ${positionId}`;
                        gaps.push({ date, shift, position: label, missing: remaining });
                    }
                }
            }
        }

        // สรุปรายคน ใช้ตรวจความเป็นธรรมก่อนกดบันทึก
        const perStaff = staff.map(s => {
            const plan = plans.get(s.staff_id)!;
            return {
                staff_id: s.staff_id,
                fullname: s.fullname,
                code: s.code,
                total: plan.total,
                nights: plan.nights,
                days_off: daysInMonth - plan.total,
            };
        }).sort((a, b) => b.total - a.total);

        // ตำแหน่งที่โควตาขอไว้แต่ไม่มีคนในหอเลย — บอกแยกเพราะแก้ด้วยการจัดเวรไม่ได้
        const impossible = positionsInQuota
            .filter(pid => !staff.some(s => s.staff_position_id === pid))
            .map(pid => {
                const codes = [...quota.entries()]
                    .filter(([k]) => Number(k.split('|')[0]) === pid)
                    .reduce((sum, [, v]) => sum + v, 0);
                return { staff_position_id: pid, shifts_per_day: codes };
            });

        const totalNeeded = [...quota.values()].reduce((a, b) => a + b, 0) * daysInMonth;

        return {
            success: true,
            message: gaps.length === 0
                ? 'จัดเวรครบตามอัตรากำลังที่ตั้งไว้'
                : `จัดเวรแล้ว แต่ยังมีช่องที่เติมไม่ได้ ${gaps.reduce((a, g) => a + g.missing, 0)} เวร`,
            data: {
                ward: wardCode,
                month,
                days_in_month: daysInMonth,
                // ร่างนี้ยังไม่ได้บันทึก หน้าจอต้องให้คนตรวจแล้วกดยืนยันเอง
                assignments,
                summary: {
                    assigned: assignments.length,
                    needed: totalNeeded,
                    locked: existingRows.length,
                    gap_shifts: gaps.reduce((a, g) => a + g.missing, 0),
                },
                gaps: gaps.slice(0, 200),
                impossible_positions: impossible,
                per_staff: perStaff,
                holidays: [...holidays.entries()].map(([d, name]) => ({ date: d, name })),
                rules: SCHEDULE_RULES,
                notes: [
                    'ร่างนี้ยังไม่ได้บันทึก ต้องกดยืนยันก่อน',
                    'ยังไม่ได้ตรวจวันลา เพราะระบบลายังไม่มีข้อมูล กรุณาตรวจก่อนบันทึก',
                    'จัดเฉพาะเวรปกติ ไม่รวม OT',
                    'เวรที่จัดด้วยมือไว้แล้วถูกคงไว้ ตัวจัดเวรเติมเฉพาะช่องว่าง',
                ],
            },
        };
    } catch (error) {
        console.error('Generate schedule error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
