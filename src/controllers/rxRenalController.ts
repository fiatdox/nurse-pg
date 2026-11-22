import { Context } from 'elysia';
import type { RowDataPacket } from 'mysql2';
import { nurse, his } from '../db';
import { resolveActor } from '../utils/nursingRecord';
import { ageAt, crclCockcroftGault, egfrCkdEpi, type Sex } from '../utils/renal';

/**
 * ค่าการทำงานของไตของผู้ป่วยในใบสั่งยา ให้เภสัชดูประกอบการปรับขนาดยา
 *
 * ดึงแบบเดียวกับหน้าประเมินการใช้ยาของ DUE: Creatinine (lab_items_code 90) 25 ครั้งล่าสุด
 * eGFR (CKD-EPI 2009) และ CrCl (Cockcroft-Gault) คำนวณด้วยอายุ ณ วันที่ตรวจ
 *
 * ผูกกับเลขใบ ไม่รับ HN ตรง ๆ — คนที่เปิดดูได้คือคนที่เห็นใบนี้อยู่แล้ว ไม่ใช่ช่องค้นผลแล็บของใครก็ได้
 * วันเกิดใช้คำนวณอายุอย่างเดียว ไม่ส่งออกไป
 */

/** รหัสรายการแล็บของ Creatinine — ตั้งเพิ่มได้ด้วย RX_SCR_LAB_CODES=90,881 (ค่าเริ่มต้นเดียวกับ DUE) */
const scrCodes = () => (process.env.RX_SCR_LAB_CODES || '90')
    .split(',').map(c => c.trim()).filter(c => /^[0-9A-Za-z]+$/.test(c));

const MAX_POINTS = 25;

export const getRxRenal = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await resolveActor(user);
    if (!actor) { set.status = 401; return { success: false, message: 'ไม่พบข้อมูลผู้ใช้' }; }

    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const rows = await nurse`SELECT hn FROM rx_orders WHERE rx_order_id = ${id}`;
    if (rows.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
    const hn = String(rows[0].hn ?? '').trim();
    if (!/^\d{9}$/.test(hn)) return { success: true, data: null, message: 'ใบนี้ไม่มี HN' };

    const codes = scrCodes();
    try {
        const [[patient], [weightRows], [scrRows]] = await Promise.all([
            his.execute<RowDataPacket[]>(
                `SELECT DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday, sex FROM patient WHERE hn = ? LIMIT 1`, [hn]),
            /* น้ำหนักล่าสุด ใช้ทุกจุดเหมือน DUE · ส่งวันที่ชั่งไปด้วย เภสัชจะรู้ว่าน้ำหนักเก่าแค่ไหน */
            his.execute<RowDataPacket[]>(
                `SELECT bw, DATE_FORMAT(vstdate, '%Y-%m-%d') AS vstdate FROM opdscreen
                 WHERE hn = ? AND bw > 0 ORDER BY vstdate DESC, vsttime DESC LIMIT 1`, [hn]),
            his.execute<RowDataPacket[]>(
                `SELECT lo.lab_order_result AS result,
                        DATE_FORMAT(lh.order_date, '%Y-%m-%d') AS order_date,
                        TIME_FORMAT(lh.order_time, '%H:%i') AS order_time
                 FROM lab_head lh
                 JOIN lab_order lo ON lo.lab_order_number = lh.lab_order_number
                 WHERE lh.hn = ?
                   AND lo.lab_items_code IN (${codes.map(() => '?').join(', ')})
                   AND lo.lab_order_result REGEXP '^[0-9]+(\\\\.[0-9]+)?$'
                 ORDER BY lh.order_date DESC, lh.lab_order_number DESC
                 LIMIT ${MAX_POINTS}`, [hn, ...codes]),
        ]);

        const birthday = patient[0]?.birthday ? String(patient[0].birthday) : null;
        const sex: Sex = String(patient[0]?.sex ?? '') === '2' ? '2' : '1';
        const weight = weightRows[0] ? Number(weightRows[0].bw) : null;

        const points = scrRows.map(r => {
            const scr = Number(r.result);
            const date = String(r.order_date);
            const age = ageAt(birthday, date);
            return {
                date,
                time: r.order_time ? String(r.order_time) : null,
                scr,
                age,
                egfr: age === null ? null : egfrCkdEpi(scr, age, sex),
                crcl: age === null || weight === null ? null : crclCockcroftGault(scr, age, weight, sex),
            };
        });

        return {
            success: true,
            data: {
                sex,
                weight,
                weight_date: weightRows[0]?.vstdate ? String(weightRows[0].vstdate) : null,
                /* ใหม่ → เก่า */
                points,
            },
        };
    } catch (error) {
        console.error('Get rx renal error:', error);
        /* HIS ล่มไม่ใช่เหตุให้หน้าคิวพัง แค่บอกว่าตอนนี้ดึงค่าไตไม่ได้ */
        return { success: true, data: null, his_down: true };
    }
};

/**
 * INR ของผู้ป่วยในใบสั่งยา ให้เภสัชดูประกอบยาต้านการแข็งตัวของเลือด (warfarin ฯลฯ)
 *
 * รหัสแล็บ 220 (INR) ตั้งเพิ่มได้ด้วย RX_INR_LAB_CODES — อย่าใส่ 218 "PT/INR" เพราะผลเป็น PT หน่วยวินาที
 * ไม่หาจากชื่อรายการ เพราะชื่อที่มีคำว่า INR บางรายการเป็นค่า PT
 * ส่งชื่อรายการกลับไปด้วย เภสัชจะเห็นว่าค่ามาจากรายการไหน
 */
const inrCodes = () => (process.env.RX_INR_LAB_CODES || '220')
    .split(',').map(c => c.trim()).filter(c => /^[0-9A-Za-z]+$/.test(c));

const MAX_INR_POINTS = 15;

export const getRxInr = async ({ params, user, set }: Context & { user?: unknown }) => {
    const actor = await resolveActor(user);
    if (!actor) { set.status = 401; return { success: false, message: 'ไม่พบข้อมูลผู้ใช้' }; }

    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id)) { set.status = 400; return { success: false, message: 'เลขที่ไม่ถูกต้อง' }; }

    const rows = await nurse`SELECT hn FROM rx_orders WHERE rx_order_id = ${id}`;
    if (rows.length === 0) { set.status = 404; return { success: false, message: 'ไม่พบใบสั่งยานี้' }; }
    const hn = String(rows[0].hn ?? '').trim();
    if (!/^\d{9}$/.test(hn)) return { success: true, data: null, message: 'ใบนี้ไม่มี HN' };

    const codes = inrCodes();
    if (codes.length === 0) return { success: true, data: { points: [] } };
    try {
        const [inrRows] = await his.execute<RowDataPacket[]>(
            `SELECT lo.lab_order_result AS result,
                    li.lab_items_name AS item_name,
                    DATE_FORMAT(lh.order_date, '%Y-%m-%d') AS order_date,
                    TIME_FORMAT(lh.order_time, '%H:%i') AS order_time
             FROM lab_head lh
             JOIN lab_order lo ON lo.lab_order_number = lh.lab_order_number
             LEFT JOIN lab_items li ON li.lab_items_code = lo.lab_items_code
             WHERE lh.hn = ?
               AND lo.lab_items_code IN (${codes.map(() => '?').join(', ')})
               AND lo.lab_order_result REGEXP '^[0-9]+(\\.[0-9]+)?$'
             ORDER BY lh.order_date DESC, lh.lab_order_number DESC
             LIMIT ${MAX_INR_POINTS}`, [hn, ...codes]);

        return {
            success: true,
            data: {
                /* ใหม่ → เก่า */
                points: inrRows.map(r => ({
                    date: String(r.order_date),
                    time: r.order_time ? String(r.order_time) : null,
                    inr: Number(r.result),
                    item: r.item_name ? String(r.item_name) : null,
                })),
            },
        };
    } catch (error) {
        console.error('Get rx INR error:', error);
        return { success: true, data: null, his_down: true };
    }
};
