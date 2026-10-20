import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import type { VendorContext } from '../middlewares/vendorMiddleware';

/**
 * ใบงานประจำวันสำหรับบริษัทผู้รับจ้างทำอาหาร
 *
 * ต่างจากรายงานยอดเงิน (vendorReportController) ตรงที่ชุดนี้นับ "ยอดที่สั่ง"
 * ไม่ใช่ยอดที่งานโภชนาการรับแล้ว เพราะบริษัทต้องเอาไปเตรียมของและจัดถาด
 * ซึ่งเกิดก่อนการรับมอบ ถ้านับยอดที่รับแล้ว ใบงานจะว่างเปล่าทุกวัน
 *
 * แต่ไม่ใช่ทุกรายการที่หอสั่ง — เห็นเฉพาะรายการที่งานโภชนาการอนุมัติแล้วเท่านั้น
 * รายการดิบยังแก้ไขได้จนถึงเวลาปิดยอด ถ้าให้บริษัทเห็นทันทีที่หอกดสั่ง
 * บริษัทจะตั้งหม้อตามยอดที่ยังไม่นิ่ง แล้วของที่ทำเกินจะไม่มีใครรับผิดชอบ
 *
 * ทุกคิวรีกรองด้วย vendor_food_types ที่ผูกมากับ token เสมอ
 * บริษัทจึงเห็นเฉพาะประเภทอาหารที่ตัวเองรับผิดชอบ ไม่เห็นของเจ้าอื่น
 */

const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

type MaybeVendor = VendorContext | null;

/** ด่านเดียวกันทุก endpoint จะได้ไม่มีรูรั่วที่ใดที่หนึ่ง */
const gate = (vendor: MaybeVendor, set: any): string | null => {
    if (!vendor) {
        set.status = 401;
        return 'Unauthorized';
    }
    return null;
};

/**
 * สรุปยอดอาหารตามช่วงวันที่ รูปแบบเดียวกับใบที่งานโภชนาการใช้
 *
 * รับช่วงวันที่แทนวันเดียว ใบรายวันคือช่วงที่วันเริ่มเท่ากับวันจบ
 * จะได้ไม่ต้องมีสองคิวรีที่ทำเรื่องเดียวกันแล้วเพี้ยนจากกันทีหลัง
 */
export const vendorFoodSummary = async (
    { body, set, vendor }: { body: { date1: string; date2: string; ward?: string | null }; set: any; vendor: MaybeVendor }
) => {
    const denied = gate(vendor, set);
    if (denied) return { success: false, message: denied };

    const { date1, date2, ward } = body ?? {};
    if (!isDate(date1) || !isDate(date2)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }
    if (date1 > date2) {
        set.status = 400;
        return { success: false, message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' };
    }

    const types = vendor!.food_type_ids;
    if (types.length === 0) {
        return { success: true, data: { date1, date2, menus: [], addons: [] } };
    }

    try {
        const menus = await nurse`
            SELECT
                 fo.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
                ,fo.meal
                ,m.name                                    AS meal_name
                ,fi.food_item_id
                ,fi.food_name
                ,fi.food_type_id
                ,ft.food_type_name
                ,COUNT(*)::int                             AS qty
                ,COUNT(*) FILTER (WHERE fo.recieve_order_status = 'Y')::int AS received
                ,COUNT(*) FILTER (WHERE NULLIF(TRIM(fo.addon), '') IS NOT NULL)::int AS with_addon
            FROM food_orders fo
            JOIN food_items fi      ON fi.food_item_id = fo.food_item_id
            LEFT JOIN food_types ft ON ft.food_type_id = fi.food_type_id
            LEFT JOIN meal m        ON m.meal = fo.meal
            LEFT JOIN ward w        ON w.his_code = fo.ward
            WHERE fo.order_date BETWEEN ${date1} AND ${date2}
              AND fo.cancelled_at IS NULL
              -- บริษัทเห็นเฉพาะที่งานโภชนาการอนุมัติแล้ว ดู approveFoodOrders
              AND fo.approved_at IS NOT NULL
              AND fi.food_type_id IN ${nurse(types)}
              ${ward ? nurse`AND fo.ward = ${ward}` : nurse``}
            GROUP BY fo.ward, w.ward_name, fo.meal, m.name,
                     fi.food_item_id, fi.food_name, fi.food_type_id, ft.food_type_name
            ORDER BY ward_name NULLS LAST, fo.meal, fi.food_name`;

        /*
          รายการที่มีของเพิ่ม ต้องบอกว่าของเพิ่มนั้นของเตียงไหน
          ครัวจัดถาดตามเตียง ถ้าบอกแค่ยอดรวมว่ามีของเพิ่มกี่ที่ จะไม่รู้ว่าใส่ถาดไหน
        */
        const addons = await nurse`
            SELECT
                 fo.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
                ,fo.meal
                ,m.name                                    AS meal_name
                ,TO_CHAR(fo.order_date, 'YYYY-MM-DD')      AS order_date
                ,al.bedno
                ,al.patient_name
                ,fi.food_name
                ,TRIM(fo.addon)                            AS addon
            FROM food_orders fo
            JOIN food_items fi ON fi.food_item_id = fo.food_item_id
            -- หยิบทะเบียนใบเดียว ผู้ป่วยบางรายมีทะเบียนนอนค้างซ้ำ ถ้า join ตรงๆ แถวจะแตก
            LEFT JOIN LATERAL (
                SELECT a.bedno, a.patient_name
                FROM admission_list a
                WHERE a.an = fo.an AND a.discharge_type_id = 0
                ORDER BY a.admission_list_id DESC
                LIMIT 1
            ) al ON TRUE
            LEFT JOIN meal m ON m.meal = fo.meal
            LEFT JOIN ward w ON w.his_code = fo.ward
            WHERE fo.order_date BETWEEN ${date1} AND ${date2}
              AND fo.cancelled_at IS NULL
              -- บริษัทเห็นเฉพาะที่งานโภชนาการอนุมัติแล้ว ดู approveFoodOrders
              AND fo.approved_at IS NOT NULL
              AND NULLIF(TRIM(fo.addon), '') IS NOT NULL
              AND fi.food_type_id IN ${nurse(types)}
              ${ward ? nurse`AND fo.ward = ${ward}` : nurse``}
            ORDER BY ward_name NULLS LAST, fo.meal, al.bedno`;

        return {
            success: true,
            data: {
                date1,
                date2,
                menus: menus.map(r => ({
                    ward: r.ward,
                    ward_name: sanitizeHTML(r.ward_name),
                    meal: Number(r.meal),
                    meal_name: sanitizeHTML(r.meal_name ?? ''),
                    food_item_id: Number(r.food_item_id),
                    food_name: sanitizeHTML(r.food_name),
                    food_type_id: Number(r.food_type_id),
                    food_type_name: sanitizeHTML(r.food_type_name ?? ''),
                    qty: Number(r.qty),
                    received: Number(r.received),
                    with_addon: Number(r.with_addon),
                })),
                addons: addons.map(r => ({
                    ward: r.ward,
                    ward_name: sanitizeHTML(r.ward_name),
                    meal: Number(r.meal),
                    meal_name: sanitizeHTML(r.meal_name ?? ''),
                    order_date: r.order_date,
                    bedno: r.bedno,
                    patient_name: sanitizeHTML(r.patient_name ?? ''),
                    food_name: sanitizeHTML(r.food_name),
                    addon: sanitizeHTML(r.addon),
                })),
            },
        };
    } catch (error) {
        console.error('Vendor food summary error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * ยอดสั่งอาหารแยกตามหอผู้ป่วย x มื้อ x ประเภท
 *
 * ใช้เป็นใบส่งของ บอกว่าต้องส่งไปหอไหนกี่ถาด แยกตามประเภทอาหาร
 */
export const vendorWardSummary = async (
    { body, set, vendor }: { body: { date1: string; date2: string }; set: any; vendor: MaybeVendor }
) => {
    const denied = gate(vendor, set);
    if (denied) return { success: false, message: denied };

    const { date1, date2 } = body ?? {};
    if (!isDate(date1) || !isDate(date2)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }
    if (date1 > date2) {
        set.status = 400;
        return { success: false, message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' };
    }

    const types = vendor!.food_type_ids;
    if (types.length === 0) {
        return { success: true, data: { date1, date2, food_types: [], rows: [] } };
    }

    try {
        const foodTypes = await nurse`
            SELECT food_type_id, food_type_name
            FROM food_types WHERE food_type_id IN ${nurse(types)}
            ORDER BY food_type_id`;

        /*
          ทุกหอที่มีการสั่ง ต้องมีครบทุกมื้อ

          มื้อที่ไม่มีคนสั่งต้องเห็นเป็นศูนย์ ไม่ใช่หายไปทั้งแถว
          ไม่งั้นคนขับรถส่งของจะไม่รู้ว่า "หอนี้มื้อนี้ไม่มี" กับ "ลืมพิมพ์" ต่างกันตรงไหน
        */
        const rows = await nurse`
            WITH src AS (
                SELECT fo.ward, fo.meal, fi.food_type_id
                FROM food_orders fo
                JOIN food_items fi ON fi.food_item_id = fo.food_item_id
                WHERE fo.order_date BETWEEN ${date1} AND ${date2}
                  AND fo.cancelled_at IS NULL
              -- บริษัทเห็นเฉพาะที่งานโภชนาการอนุมัติแล้ว ดู approveFoodOrders
              AND fo.approved_at IS NOT NULL
                  AND fi.food_type_id IN ${nurse(types)}
            ), wards AS (
                SELECT DISTINCT ward FROM src
            )
            SELECT
                 wd.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
                ,m.meal
                ,m.name                                    AS meal_name
                ,s.food_type_id
                ,COUNT(s.ward)::int                        AS qty
            FROM wards wd
            CROSS JOIN meal m
            LEFT JOIN src s  ON s.ward = wd.ward AND s.meal = m.meal
            LEFT JOIN ward w ON w.his_code = wd.ward
            GROUP BY wd.ward, w.ward_name, m.meal, m.name, s.food_type_id
            ORDER BY ward_name, m.meal, s.food_type_id`;

        /* ยุบเป็นหนึ่งแถวต่อ หอ x มื้อ แล้วกระจายประเภทเป็นคอลัมน์ ให้หน้าจอวาดตารางได้ตรงๆ */
        const byKey = new Map<string, {
            ward: string; ward_name: string; meal: number; meal_name: string;
            qty_by_type: Record<number, number>; total: number;
        }>();

        for (const r of rows) {
            const key = `${r.ward}|${r.meal}`;
            const cur = byKey.get(key) ?? {
                ward: String(r.ward),
                ward_name: String(sanitizeHTML(r.ward_name) ?? ''),
                meal: Number(r.meal),
                meal_name: String(sanitizeHTML(r.meal_name ?? '') ?? ''),
                qty_by_type: Object.fromEntries(types.map(t => [t, 0])),
                total: 0,
            };
            if (r.food_type_id !== null) {
                const id = Number(r.food_type_id);
                cur.qty_by_type[id] = (cur.qty_by_type[id] ?? 0) + Number(r.qty);
                cur.total += Number(r.qty);
            }
            byKey.set(key, cur);
        }

        const data = [...byKey.values()];

        return {
            success: true,
            data: {
                date1,
                date2,
                food_types: foodTypes.map(t => ({
                    food_type_id: Number(t.food_type_id),
                    food_type_name: sanitizeHTML(t.food_type_name),
                })),
                rows: data,
                summary: {
                    wards: new Set(data.map(r => r.ward)).size,
                    total: data.reduce((s, r) => s + r.total, 0),
                    by_type: Object.fromEntries(
                        types.map(t => [t, data.reduce((s, r) => s + (r.qty_by_type[t] ?? 0), 0)])
                    ),
                },
            },
        };
    } catch (error) {
        console.error('Vendor ward summary error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * ฉลากติดถาดอาหาร
 *
 * มีชื่อผู้ป่วยกับเตียงตามที่โรงพยาบาลกำหนด เพราะบริษัทเป็นผู้จัดถาด
 * ถ้าไม่มีชื่อ ถาดที่สลับกันจะตามกลับไม่ได้ว่าของใคร
 *
 * ส่งเฉพาะที่ปรากฏบนป้ายจริง ไม่ส่ง HN และ AN ออกไปด้วย
 * สองอันนั้นไม่ได้ถูกพิมพ์บนฉลาก การส่งออกไปจึงไม่มีประโยชน์กับงาน
 * มีแต่เพิ่มข้อมูลผู้ป่วยที่หลุดออกนอกโรงพยาบาลโดยเปล่าประโยชน์
 */
export const vendorTrayLabels = async (
    { body, set, vendor }: { body: { date: string; meal: number; ward?: string | null }; set: any; vendor: MaybeVendor }
) => {
    const denied = gate(vendor, set);
    if (denied) return { success: false, message: denied };

    const { date, meal, ward } = body ?? {};
    if (!isDate(date) || ![1, 2, 3].includes(Number(meal))) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ date (YYYY-MM-DD) และ meal (1-3) ให้ถูกต้อง' };
    }

    const types = vendor!.food_type_ids;
    if (types.length === 0) {
        return { success: true, data: [] };
    }

    try {
        const rows = await nurse`
            SELECT
                 fo.food_order_id
                ,fo.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
                ,al.bedno
                ,al.patient_name
                ,fi.food_name
                ,NULLIF(TRIM(fo.addon), '')                AS addon
                ,m.name                                    AS meal_name
            FROM food_orders fo
            JOIN LATERAL (
                SELECT a.bedno, a.patient_name
                FROM admission_list a
                WHERE a.an = fo.an AND a.discharge_type_id = 0
                ORDER BY a.admission_list_id DESC
                LIMIT 1
            ) al ON TRUE
            JOIN food_items fi ON fi.food_item_id = fo.food_item_id
            JOIN meal m        ON m.meal = fo.meal
            LEFT JOIN ward w   ON w.his_code = fo.ward
            WHERE fo.order_date = ${date}
              AND fo.meal = ${Number(meal)}
              AND fo.cancelled_at IS NULL
              -- บริษัทเห็นเฉพาะที่งานโภชนาการอนุมัติแล้ว ดู approveFoodOrders
              AND fo.approved_at IS NOT NULL
              AND fi.food_type_id IN ${nurse(types)}
              ${ward ? nurse`AND fo.ward = ${ward}` : nurse``}
            ORDER BY w.ward_name NULLS LAST, al.bedno, fo.food_order_id`;

        return {
            success: true,
            data: rows.map(r => ({
                food_order_id: Number(r.food_order_id),
                ward: r.ward,
                ward_name: sanitizeHTML(r.ward_name),
                bedno: r.bedno,
                patient_name: sanitizeHTML(r.patient_name ?? ''),
                food_name: sanitizeHTML(r.food_name),
                addon: r.addon ? sanitizeHTML(r.addon) : null,
                meal_name: sanitizeHTML(r.meal_name),
            })),
        };
    } catch (error) {
        console.error('Vendor tray labels error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** รายชื่อหอที่บริษัทนี้มีรายการส่ง ใช้เป็นตัวเลือกในหน้าจอ ไม่ใช่ทะเบียนหอทั้งโรงพยาบาล */
export const vendorWards = async (
    { body, set, vendor }: { body: { date1: string; date2: string }; set: any; vendor: MaybeVendor }
) => {
    const denied = gate(vendor, set);
    if (denied) return { success: false, message: denied };

    const { date1, date2 } = body ?? {};
    if (!isDate(date1) || !isDate(date2)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }

    const types = vendor!.food_type_ids;
    if (types.length === 0) return { success: true, data: [] };

    try {
        const rows = await nurse`
            SELECT DISTINCT fo.ward, COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
            FROM food_orders fo
            JOIN food_items fi ON fi.food_item_id = fo.food_item_id
            LEFT JOIN ward w   ON w.his_code = fo.ward
            WHERE fo.order_date BETWEEN ${date1} AND ${date2}
              AND fo.cancelled_at IS NULL
              -- บริษัทเห็นเฉพาะที่งานโภชนาการอนุมัติแล้ว ดู approveFoodOrders
              AND fo.approved_at IS NOT NULL
              AND fi.food_type_id IN ${nurse(types)}
            ORDER BY ward_name`;

        return {
            success: true,
            data: rows.map(r => ({ ward: r.ward, ward_name: sanitizeHTML(r.ward_name) })),
        };
    } catch (error) {
        console.error('Vendor wards error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
