import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { roundUpMoney } from '../utils/money';
import { NPO_FOOD_TYPE_ID } from './foodItemController';
import type { VendorContext } from '../middlewares/vendorMiddleware';

/**
 * รายงานสำหรับบริษัทผู้รับจ้างทำอาหาร
 *
 * ใช้กติกาคิดเงินเดียวกับหน้าคิดเงินของโรงพยาบาลทุกประการ
 * (นับเฉพาะมื้อที่งานโภชนาการรับมอบแล้ว · ครบ meals_per_day = วันเต็ม ·
 *  เศษมื้อคิดตามสัดส่วน · ราคาต่อวันแยกตามประเภทและช่วงสัญญา)
 * ถ้าสองฝั่งคิดคนละแบบ ตัวเลขจะไม่ตรงกันแล้วเถียงกันไม่จบ
 *
 * สิ่งที่ต่างจากรายงานฝั่งโรงพยาบาล:
 *   - จับคู่ราคาเฉพาะสัญญาที่เป็นของบริษัทนี้ มื้อที่อยู่นอกช่วงสัญญาของตัวเอง
 *     จะขึ้นว่ายังไม่มีราคา ไม่ใช่ถูกคิดด้วยราคาของบริษัทอื่นที่รับช่วงต่อ
 *   - กรองด้วย vendor_id ที่ผูกมากับ token เสมอ ไม่รับจาก body
 *   - ไม่มี HN, AN, ชื่อผู้ป่วย หรือรายการอาหารรายคน ออกไปเลยแม้แต่ฟิลด์เดียว
 *   - ไม่มียอดของประเภทอาหารที่บริษัทอื่นรับผิดชอบ
 */

const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

interface Body { date1: string; date2: string }

/*
  vendorMiddleware กันไว้แล้วว่า vendor ต้องไม่เป็น null ถึงจะมาถึงตรงนี้
  แต่ชนิดที่ derive คืนออกมาเป็นยูเนียน ตัวตรวจชนิดจึงยังไม่รู้
  ประกาศเป็น null ได้แล้วตัดจบตรงนี้ ดีกว่าใส่ any ซึ่งจะปิดตาตัวตรวจทั้งก้อน
*/
type MaybeVendor = VendorContext | null;

/** ตรวจช่วงวันที่ให้เหมือนกันทุก endpoint จะได้ไม่มีรูรั่วที่ใดที่หนึ่ง */
const checkRange = (body: Body, set: any): string | null => {
    const { date1, date2 } = body ?? {};
    if (!isDate(date1) || !isDate(date2)) {
        set.status = 400;
        return 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD';
    }
    if (date1 > date2) {
        set.status = 400;
        return 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด';
    }
    const days = Math.floor((Date.parse(date2) - Date.parse(date1)) / 86400000) + 1;
    if (days > 400) {
        set.status = 400;
        return 'เลือกช่วงได้ไม่เกิน 400 วันต่อครั้ง';
    }
    return null;
};

/**
 * ยอดรวมของบริษัท แยกตามประเภทอาหารและช่วงสัญญา
 *
 * นี่คือหน้าหลักที่บริษัทใช้เทียบกับใบวางบิลของตัวเอง
 */
export const vendorSummary = async (
    { body, set, vendor }: { body: Body; set: any; vendor: MaybeVendor }
) => {
    if (!vendor) { set.status = 401; return { success: false, message: 'Unauthorized' }; }

    const error = checkRange(body, set);
    if (error) return { success: false, message: error };

    const { date1, date2 } = body;

    /*
      บริษัทที่ยังไม่ผูกประเภทอาหาร ต้องได้รายงานเปล่า ไม่ใช่เห็นทุกประเภท

      ถ้าปล่อยให้ IN () ว่างแล้วกลายเป็นไม่กรอง บริษัทที่เพิ่งสร้างบัญชี
      แต่ยังไม่ได้ตั้งค่าจะเห็นยอดของทุกเจ้าทันที การพลาดแบบนี้เงียบมาก
      เพราะระบบยังทำงานได้ปกติ จึงต้องตัดจบตั้งแต่ก่อนยิงคิวรี
    */
    if (vendor.food_type_ids.length === 0) {
        return {
            success: true,
            data: { date1, date2, rows: [], total_amount: 0, total_meals: 0, pending_meals: 0, unpriced_meals: 0 },
        };
    }

    try {
        const rows = await nurse`
            WITH daily AS (
                SELECT fi.food_type_id, fo.order_date
                     , COUNT(*) FILTER (WHERE fo.recieve_order_status = 'Y')::int              AS meals
                     , COUNT(*) FILTER (WHERE fo.recieve_order_status IS DISTINCT FROM 'Y')::int AS pending_meals
                FROM food_orders fo
                JOIN food_items fi ON fi.food_item_id = fo.food_item_id
                WHERE fo.order_date BETWEEN ${date1} AND ${date2}
                  AND fo.cancelled_at IS NULL
                  AND fi.food_type_id <> ${NPO_FOOD_TYPE_ID}
                  -- กรองด้วยประเภทของบริษัทนี้เท่านั้น ค่ามาจาก token ไม่ใช่จาก client
                  AND fi.food_type_id IN ${nurse(vendor.food_type_ids)}
                GROUP BY 1, 2
            )
            SELECT
                 d.food_type_id
                ,ft.food_type_name
                ,p.price_per_day
                ,p.meals_per_day
                ,TO_CHAR(p.effective_from, 'YYYY-MM-DD') AS effective_from
                ,TO_CHAR(p.effective_to,   'YYYY-MM-DD') AS effective_to
                ,p.contract_note
                ,SUM(d.meals)::int         AS meals
                ,SUM(d.pending_meals)::int AS pending_meals
                ,TO_CHAR(MIN(d.order_date), 'YYYY-MM-DD') AS first_date
                ,TO_CHAR(MAX(d.order_date), 'YYYY-MM-DD') AS last_date
            FROM daily d
            LEFT JOIN food_types ft ON ft.food_type_id = d.food_type_id
            /*
              จับคู่ราคาเฉพาะสัญญาที่เป็นของบริษัทนี้

              ถ้าไม่กรอง vendor_id ตอนสัญญาเปลี่ยนมือหลังประกวดราคารอบใหม่
              บริษัทเดิมจะถูกคิดเงินในช่วงที่เป็นของเจ้าใหม่ด้วย และคิดด้วยราคาของเจ้าใหม่
              ผิดทั้งเจ้าของยอดและตัวเลข โดยไม่มีอะไรเตือน
            */
            LEFT JOIN LATERAL (
                SELECT fp.price_per_day, fp.meals_per_day, fp.effective_from,
                       fp.effective_to, fp.contract_note
                FROM food_type_prices fp
                WHERE fp.food_type_id = d.food_type_id
                  AND fp.vendor_id = ${vendor!.vendor_id}
                  AND fp.effective_from <= d.order_date
                  AND (fp.effective_to IS NULL OR fp.effective_to >= d.order_date)
                ORDER BY fp.effective_from DESC
                LIMIT 1
            ) p ON TRUE
            GROUP BY d.food_type_id, ft.food_type_name, p.price_per_day, p.meals_per_day,
                     p.effective_from, p.effective_to, p.contract_note
            ORDER BY d.food_type_id, effective_from`;

        const data = rows.map(r => {
            const meals = Number(r.meals);
            const priceDay = r.price_per_day === null ? null : Number(r.price_per_day);
            const perDay = r.meals_per_day === null ? null : Number(r.meals_per_day);
            const hasPrice = priceDay !== null && perDay !== null && perDay > 0;

            // แยกวันเต็มกับเศษมื้อให้เห็น เพราะสองส่วนนี้คิดคนละราคาตามสัญญา
            const fullDays = hasPrice ? Math.floor(meals / perDay!) : 0;
            const remainder = hasPrice ? meals % perDay! : 0;
            const pricePerMeal = hasPrice ? roundUpMoney(priceDay! / perDay!) : null;
            const dayAmount = hasPrice ? roundUpMoney(fullDays * priceDay!) : null;
            const remainderAmount = hasPrice ? roundUpMoney(remainder * pricePerMeal!) : null;

            return {
                food_type_id: Number(r.food_type_id),
                food_type_name: String(sanitizeHTML(r.food_type_name ?? '') ?? '') || 'ไม่ระบุประเภท',
                contract_note: r.contract_note ? sanitizeHTML(r.contract_note) : null,
                effective_from: r.effective_from,
                effective_to: r.effective_to,
                first_date: r.first_date,
                last_date: r.last_date,
                meals,
                pending_meals: Number(r.pending_meals),
                price_per_day: priceDay,
                meals_per_day: perDay,
                price_per_meal: pricePerMeal,
                full_days: fullDays,
                remainder_meals: remainder,
                day_amount: dayAmount,
                remainder_amount: remainderAmount,
                amount: hasPrice ? roundUpMoney(dayAmount! + remainderAmount!) : null,
                has_price: hasPrice,
            };
        });

        return {
            success: true,
            data: {
                date1,
                date2,
                rows: data,
                total_meals: data.reduce((s, r) => s + r.meals, 0),
                total_amount: roundUpMoney(data.reduce((s, r) => s + (r.amount ?? 0), 0)),
                pending_meals: data.reduce((s, r) => s + r.pending_meals, 0),
                // มื้อที่ยังตั้งราคาไม่ได้ ต้องเห็น ไม่ใช่หายไปจากยอดเงียบๆ
                unpriced_meals: data.filter(r => !r.has_price).reduce((s, r) => s + r.meals, 0),
            },
        };
    } catch (error) {
        console.error('Vendor summary error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * แจกแจงรายวัน × ประเภท สำหรับให้บริษัทไล่ตรวจว่ายอดไม่ตรงตรงวันไหน
 *
 * ไม่มียอดเงินรายวัน เพราะเงินคิดแบบครบสามมื้อเป็นวันเต็ม
 * ถ้าใส่เงินรายวันแล้วบวกเอง ผลรวมจะไม่ตรงกับยอดในหน้าสรุป
 * ด้วยเหตุผลเดียวกับที่ตารางไขว้ฝั่งโรงพยาบาลไม่มียอดเงิน
 */
export const vendorDaily = async (
    { body, set, vendor }: { body: Body; set: any; vendor: MaybeVendor }
) => {
    if (!vendor) { set.status = 401; return { success: false, message: 'Unauthorized' }; }

    const error = checkRange(body, set);
    if (error) return { success: false, message: error };

    const { date1, date2 } = body;

    if (vendor.food_type_ids.length === 0) {
        return { success: true, data: { date1, date2, rows: [] } };
    }

    try {
        const rows = await nurse`
            SELECT
                 TO_CHAR(fo.order_date, 'YYYY-MM-DD') AS order_date
                ,fi.food_type_id
                ,ft.food_type_name
                ,fo.meal
                ,COALESCE(m.name, '-') AS meal_name
                ,COUNT(*) FILTER (WHERE fo.recieve_order_status = 'Y')::int              AS meals
                ,COUNT(*) FILTER (WHERE fo.recieve_order_status IS DISTINCT FROM 'Y')::int AS pending_meals
            FROM food_orders fo
            JOIN food_items fi      ON fi.food_item_id = fo.food_item_id
            LEFT JOIN food_types ft ON ft.food_type_id = fi.food_type_id
            LEFT JOIN meal m        ON m.meal = fo.meal
            WHERE fo.order_date BETWEEN ${date1} AND ${date2}
              AND fo.cancelled_at IS NULL
              AND fi.food_type_id <> ${NPO_FOOD_TYPE_ID}
              AND fi.food_type_id IN ${nurse(vendor.food_type_ids)}
            GROUP BY 1, 2, 3, 4, 5
            ORDER BY order_date, fi.food_type_id, fo.meal`;

        return {
            success: true,
            data: {
                date1,
                date2,
                rows: rows.map(r => ({
                    order_date: r.order_date,
                    food_type_id: Number(r.food_type_id),
                    food_type_name: sanitizeHTML(r.food_type_name ?? ''),
                    meal: Number(r.meal),
                    meal_name: sanitizeHTML(r.meal_name),
                    meals: Number(r.meals),
                    pending_meals: Number(r.pending_meals),
                })),
            },
        };
    } catch (error) {
        console.error('Vendor daily error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * สัญญาราคาของบริษัทนี้ ให้เทียบได้ว่าระบบใช้ราคาอะไรอยู่
 *
 * เกณฑ์คือ "สัญญาเป็นของบริษัทนี้" ไม่ใช่ "ประเภทอาหารที่บริษัทนี้ทำ"
 * สองอย่างนี้ไม่เท่ากัน บริษัทอาจมีสัญญาที่ยังไม่เริ่มหรือหมดอายุไปแล้ว
 * ซึ่งไม่ได้ผูกอยู่ใน vendor_food_types แต่ยังต้องเห็นเพื่อสอบยันยอดย้อนหลัง
 */
export const vendorContracts = async (
    { set, vendor }: { set: any; vendor: MaybeVendor }
) => {
    if (!vendor) { set.status = 401; return { success: false, message: 'Unauthorized' }; }

    try {
        const rows = await nurse`
            SELECT p.food_type_id, ft.food_type_name, p.price_per_day, p.meals_per_day
                 , TO_CHAR(p.effective_from, 'YYYY-MM-DD') AS effective_from
                 , TO_CHAR(p.effective_to,   'YYYY-MM-DD') AS effective_to
                 , p.contract_note
            FROM food_type_prices p
            LEFT JOIN food_types ft ON ft.food_type_id = p.food_type_id
            -- เห็นเฉพาะสัญญาของบริษัทตัวเอง ไม่เห็นของรอบที่เจ้าอื่นรับช่วงต่อ
            WHERE p.vendor_id = ${vendor.vendor_id}
            ORDER BY p.food_type_id, p.effective_from DESC`;

        return {
            success: true,
            data: rows.map(r => ({
                food_type_id: Number(r.food_type_id),
                food_type_name: sanitizeHTML(r.food_type_name ?? ''),
                price_per_day: Number(r.price_per_day),
                meals_per_day: Number(r.meals_per_day),
                effective_from: r.effective_from,
                effective_to: r.effective_to,
                contract_note: r.contract_note ? sanitizeHTML(r.contract_note) : null,
            })),
        };
    } catch (error) {
        console.error('Vendor contracts error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
