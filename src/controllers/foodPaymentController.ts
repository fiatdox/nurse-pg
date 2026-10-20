import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { roundUpMoney } from '../utils/money';
import { NPO_FOOD_TYPE_ID } from './foodItemController';

/**
 * ยอดเงินที่ต้องจ่ายบริษัทผู้รับจ้างทำอาหาร
 *
 * กติกาการคิดเงินตามที่โรงพยาบาลกำหนด:
 *   ครบ meals_per_day มื้อ (ปกติ 3) = หนึ่งวันเต็ม จ่ายเต็มราคาต่อวัน
 *   มื้อที่เหลือไม่ครบวัน จ่ายตามสัดส่วน = ราคาต่อวัน ÷ จำนวนมื้อต่อวัน
 *   เช่น 5 มื้อ ราคา 140 บาท/วัน = 140 + (2 × 46.67) = 233.34 บาท
 *
 * ทุกจำนวนเงินปัดเศษขึ้นสองตำแหน่งด้วย roundUpMoney ตัวเดียวกับทั้งระบบ
 *
 * นับเฉพาะมื้อที่งานโภชนาการกดรับแล้ว (recieve_order_status = 'Y')
 *
 * การสั่งเป็นความต้องการของหอผู้ป่วย ยังไม่ใช่หลักฐานว่าอาหารออกจากครัวจริง
 * โรงพยาบาลจ่ายเงินตามของที่รับมอบแล้วเท่านั้น มื้อที่สั่งแต่ยังไม่มีใครรับ
 * จึงไม่เข้ายอดเงิน แต่ต้องแสดงแยกไว้ทุกที่ที่มีตัวเลขเงิน ไม่ใช่หายไปเงียบๆ
 * ไม่งั้นเวลายอดไม่ตรงกับที่บริษัทวางบิลมาจะไล่หาสาเหตุไม่เจอ
 */

const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

interface PaymentGroup {
    ward: string;
    ward_name: string;
    food_type_id: number | null;
    food_type_name: string | null;
    food_type_price_id: number | null;
    price_per_day: string | null;
    meals_per_day: number | null;
    effective_from: string | null;
    effective_to: string | null;
    contract_note: string | null;
    meals: number;
    pending_meals: number;
    first_date: string;
    last_date: string;
}

/**
 * ข้อมูลดิบสำหรับตารางไขว้ (pivot) ของงานโภชนาการ
 *
 * ส่งเป็นแถวย่อยที่สุดเท่าที่หน้าจอต้องใช้ คือ หอ × มื้อ × ประเภท × วัน
 * แล้วให้หน้าจอสลับแกนเอง จะได้เปลี่ยนมุมมองโดยไม่ต้องยิงเซิร์ฟเวอร์ใหม่ทุกครั้ง
 * จำนวนแถวเท่ากับจำนวนชุดที่มีจริง ไม่ใช่ผลคูณของทุกมิติ จึงไม่บาน
 *
 * วัดเป็น "จำนวนมื้อ" อย่างเดียว ไม่มียอดเงิน
 * เพราะเงินคิดแบบครบสามมื้อเป็นวันเต็ม ซึ่งขึ้นกับวิธีจัดกลุ่ม
 * ถ้าให้สลับแกนได้ตามใจแล้วคำนวณเงินตาม ยอดจะขยับตามแกนที่เลือก
 * แล้วจะมีตัวเลขเงินสองชุดที่ไม่ตรงกันในระบบเดียว ยอดเงินจึงอยู่ที่หน้าคิดเงินหน้าเดียว
 */
export const getFoodPivotData = async (
    { body, set }: { body: { date1: string, date2: string }, set: any }
) => {
    const { date1, date2 } = body ?? {};

    if (!isDate(date1) || !isDate(date2)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }
    if (date1 > date2) {
        set.status = 400;
        return { success: false, message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' };
    }
    const days = Math.floor((Date.parse(date2) - Date.parse(date1)) / 86400000) + 1;
    if (days > 400) {
        set.status = 400;
        return { success: false, message: 'เลือกช่วงได้ไม่เกิน 400 วันต่อครั้ง' };
    }

    try {
        const rows = await nurse`
            SELECT
                 fo.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย')      AS ward_name
                ,fo.meal
                ,COALESCE(m.name, '-')                          AS meal_name
                ,COALESCE(fi.food_type_id, 0)                   AS food_type_id
                ,COALESCE(ft.food_type_name, 'ไม่ระบุประเภท')    AS food_type_name
                ,TO_CHAR(fo.order_date, 'YYYY-MM-DD')           AS order_date
                ,COUNT(*)::int                                  AS qty
            FROM food_orders fo
            LEFT JOIN ward w        ON w.his_code = fo.ward
            LEFT JOIN meal m        ON m.meal = fo.meal
            LEFT JOIN food_items fi ON fi.food_item_id = fo.food_item_id
            LEFT JOIN food_types ft ON ft.food_type_id = fi.food_type_id
            WHERE fo.order_date BETWEEN ${date1} AND ${date2}
              AND fo.cancelled_at IS NULL
              /*
                ไม่นับงดอาหาร ตารางนี้ดูปริมาณอาหารที่ต้องทำจริง
                รายการงดอาหารไม่มีอาหารออกจากครัว ถ้านับรวมยอดจะเกินจริง
                ใครอยากรู้ว่ามีสั่งงดกี่มื้อ ดูได้ที่หน้าสรุปรายวันและหน้าคิดเงิน
              */
              AND COALESCE(fi.food_type_id, 0) <> ${NPO_FOOD_TYPE_ID}
            GROUP BY fo.ward, w.ward_name, fo.meal, m.name, fi.food_type_id, ft.food_type_name, fo.order_date
            ORDER BY ward_name, fo.meal, food_type_id, order_date`;

        /*
          ส่งทะเบียนประเภทไปด้วย ไม่ให้หน้าจอสร้างคอลัมน์จากข้อมูลที่มี

          ถ้าเดือนไหนไม่มีคนสั่ง VIP เลย คอลัมน์ VIP จะหายไปทั้งคอลัมน์
          คนอ่านจะแยกไม่ออกว่า "ไม่มีใครสั่ง" กับ "ระบบไม่ได้นับให้"
          ช่องที่เป็นศูนย์คือข้อมูล ไม่ใช่ช่องว่างเปล่า
        */
        const types = await nurse`
            SELECT food_type_id, food_type_name
            FROM food_types
            WHERE food_type_id <> ${NPO_FOOD_TYPE_ID} AND is_active
            ORDER BY food_type_id`;

        /*
          สรุปค่าใช้จ่ายท้ายตาราง

          สูตร: จำนวนถาด × ราคาต่อวัน ÷ จำนวนมื้อต่อวัน
          คูณก่อนหารแล้วค่อยปัดเศษครั้งเดียวตอนท้าย ไม่ปัดราคาต่อมื้อก่อน
          เพราะ 27 ถาด ราคา 140 ควรได้ 1,260.00 พอดี
          ถ้าปัด 140÷3 เป็น 46.67 ก่อนแล้วค่อยคูณ จะได้ 1,260.09 ซึ่งเกินมาจากการปัดเศษล้วนๆ

          แยกตามสัญญาด้วย เพราะช่วงที่เลือกอาจคาบเกี่ยวสองสัญญาซึ่งคนละราคา

          นับเฉพาะมื้อที่งานโภชนาการรับมอบแล้ว ยอดตรงนี้จึงน้อยกว่ายอดในตารางข้างบน
          ซึ่งเป็นยอดที่หอผู้ป่วยสั่ง ส่วนต่างคือ pending_meals ที่ส่งไปให้หน้าจอแสดงคู่กันเสมอ
        */
        const costRows = await nurse`
            WITH daily AS (
                SELECT fi.food_type_id, fo.order_date
                     , COUNT(*) FILTER (WHERE fo.recieve_order_status = 'Y')::int              AS meals
                     , COUNT(*) FILTER (WHERE fo.recieve_order_status IS DISTINCT FROM 'Y')::int AS pending_meals
                FROM food_orders fo
                LEFT JOIN food_items fi ON fi.food_item_id = fo.food_item_id
                WHERE fo.order_date BETWEEN ${date1} AND ${date2}
                  AND fo.cancelled_at IS NULL
                  AND COALESCE(fi.food_type_id, 0) <> ${NPO_FOOD_TYPE_ID}
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
            FROM daily d
            LEFT JOIN food_types ft ON ft.food_type_id = d.food_type_id
            LEFT JOIN LATERAL (
                SELECT fp.price_per_day, fp.meals_per_day, fp.effective_from, fp.effective_to, fp.contract_note
                FROM food_type_prices fp
                WHERE fp.food_type_id = d.food_type_id
                  AND fp.effective_from <= d.order_date
                  AND (fp.effective_to IS NULL OR fp.effective_to >= d.order_date)
                ORDER BY fp.effective_from DESC
                LIMIT 1
            ) p ON TRUE
            GROUP BY d.food_type_id, ft.food_type_name, p.price_per_day, p.meals_per_day,
                     p.effective_from, p.effective_to, p.contract_note
            ORDER BY d.food_type_id, effective_from`;

        const cost = costRows.map(r => {
            const meals = Number(r.meals);
            const pendingMeals = Number(r.pending_meals);
            const priceDay = r.price_per_day === null ? null : Number(r.price_per_day);
            const perDay = r.meals_per_day === null ? null : Number(r.meals_per_day);
            const hasPrice = priceDay !== null && perDay !== null && perDay > 0;
            return {
                food_type_id: r.food_type_id,
                food_type_name: String(sanitizeHTML(r.food_type_name ?? '') ?? '') || 'ไม่ระบุประเภท',
                meals,
                pending_meals: pendingMeals,
                price_per_day: priceDay,
                meals_per_day: perDay,
                effective_from: r.effective_from,
                effective_to: r.effective_to,
                contract_note: r.contract_note ? sanitizeHTML(r.contract_note) : null,
                amount: hasPrice ? roundUpMoney((meals * priceDay!) / perDay!) : null,
                has_price: hasPrice,
            };
        });

        return {
            success: true,
            data: {
                date1,
                date2,
                food_types: types.map(t => ({ ...t, food_type_name: sanitizeHTML(t.food_type_name) })),
                rows: rows.map(r => ({
                    ...r,
                    ward_name: sanitizeHTML(r.ward_name),
                    meal_name: sanitizeHTML(r.meal_name),
                    food_type_name: sanitizeHTML(r.food_type_name),
                })),
                total: rows.reduce((s, r) => s + Number(r.qty), 0),
                cost,
                cost_total: roundUpMoney(cost.reduce((s, c) => s + (c.amount ?? 0), 0)),
                // ถาดที่คิดเงินไม่ได้เพราะยังไม่ตั้งราคา ต้องเห็น ไม่ใช่หายไปจากยอด
                cost_unpriced_meals: cost.filter(c => !c.has_price).reduce((s, c) => s + c.meals, 0),
                // ถาดที่สั่งแล้วแต่งานโภชนาการยังไม่กดรับ ยังไม่เข้ายอดเงิน
                cost_pending_meals: cost.reduce((s, c) => s + c.pending_meals, 0),
            },
        };
    } catch (error) {
        console.error('Get food pivot data error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

export const getFoodPaymentSummary = async (
    { body, set }: { body: { date1: string, date2: string }, set: any }
) => {
    const { date1, date2 } = body ?? {};

    if (!isDate(date1) || !isDate(date2)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }
    if (date1 > date2) {
        set.status = 400;
        return { success: false, message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' };
    }

    const days = Math.floor((Date.parse(date2) - Date.parse(date1)) / 86400000) + 1;
    if (days > 400) {
        set.status = 400;
        return { success: false, message: 'เลือกช่วงได้ไม่เกิน 400 วันต่อครั้ง' };
    }

    try {
        /*
          จับคู่ราคาที่ระดับ "รายวัน" ก่อน แล้วค่อยรวมยอด

          ต้องทำลำดับนี้เพราะช่วงที่เลือกอาจคาบเกี่ยวสองสัญญา
          ถ้ารวมยอดก่อนแล้วค่อยหาราคา จะต้องเลือกราคาเดียวมาใช้กับทั้งช่วง
          ซึ่งผิดกับวันที่อยู่คนละสัญญา
        */
        const rows = await nurse<PaymentGroup[]>`
            WITH daily AS (
                /*
                  แยกนับสองชุดในรอบเดียว ไม่ใช่กรองมื้อที่ยังไม่รับทิ้งไปตั้งแต่ตรงนี้

                  ถ้ากรองทิ้ง แถวที่สั่งครบแต่ยังไม่มีใครกดรับจะหายจากรายงานทั้งแถว
                  คนอ่านจะแยกไม่ออกระหว่าง "หอนี้ไม่ได้สั่ง" กับ "สั่งแล้วแต่ยังไม่รับ"
                  ซึ่งเป็นคนละเรื่องกันโดยสิ้นเชิงตอนไปคุยกับบริษัท
                */
                SELECT fo.ward, fi.food_type_id, fo.order_date
                     , COUNT(*) FILTER (WHERE fo.recieve_order_status = 'Y')::int              AS meals
                     , COUNT(*) FILTER (WHERE fo.recieve_order_status IS DISTINCT FROM 'Y')::int AS pending_meals
                FROM food_orders fo
                LEFT JOIN food_items fi ON fi.food_item_id = fo.food_item_id
                WHERE fo.order_date BETWEEN ${date1} AND ${date2}
                  AND fo.cancelled_at IS NULL
                GROUP BY 1, 2, 3
            ), priced AS (
                SELECT d.*, p.food_type_price_id, p.price_per_day, p.meals_per_day,
                       p.effective_from, p.effective_to, p.contract_note
                FROM daily d
                LEFT JOIN LATERAL (
                    SELECT fp.food_type_price_id, fp.price_per_day, fp.meals_per_day,
                           fp.effective_from, fp.effective_to, fp.contract_note
                    FROM food_type_prices fp
                    WHERE fp.food_type_id = d.food_type_id
                      AND fp.effective_from <= d.order_date
                      AND (fp.effective_to IS NULL OR fp.effective_to >= d.order_date)
                    ORDER BY fp.effective_from DESC
                    LIMIT 1
                ) p ON TRUE
            )
            SELECT
                 pr.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย')          AS ward_name
                ,pr.food_type_id
                ,ft.food_type_name
                ,pr.food_type_price_id
                ,pr.price_per_day
                ,pr.meals_per_day
                ,TO_CHAR(pr.effective_from, 'YYYY-MM-DD')            AS effective_from
                ,TO_CHAR(pr.effective_to,   'YYYY-MM-DD')            AS effective_to
                ,pr.contract_note
                ,SUM(pr.meals)::int                                  AS meals
                ,SUM(pr.pending_meals)::int                          AS pending_meals
                ,TO_CHAR(MIN(pr.order_date), 'YYYY-MM-DD')           AS first_date
                ,TO_CHAR(MAX(pr.order_date), 'YYYY-MM-DD')           AS last_date
            FROM priced pr
            LEFT JOIN ward w       ON w.his_code = pr.ward
            LEFT JOIN food_types ft ON ft.food_type_id = pr.food_type_id
            /*
              แยกแถวตามสัญญาด้วย ไม่ใช่แค่หอกับประเภท
              เพราะมื้อของคนละสัญญาต้องคิดคนละราคา และใบเบิกต้องอ้างสัญญาได้ทีละฉบับ
            */
            GROUP BY pr.ward, w.ward_name, pr.food_type_id, ft.food_type_name,
                     pr.food_type_price_id, pr.price_per_day, pr.meals_per_day,
                     pr.effective_from, pr.effective_to, pr.contract_note
            ORDER BY ward_name, ft.food_type_name, effective_from`;

        const data = rows.map(r => {
            // meals = รับมอบแล้ว คิดเงินได้ / pendingMeals = สั่งแล้วยังไม่รับ ยังไม่คิดเงิน
            const meals = Number(r.meals);
            const pendingMeals = Number(r.pending_meals);
            const priceDay = r.price_per_day === null ? null : Number(r.price_per_day);
            const perDay = r.meals_per_day === null ? null : Number(r.meals_per_day);

            /*
              งดอาหารไม่คิดเงิน แต่ยังต้องอยู่ในรายงาน

              รายการนี้ถูกสั่งไว้เพื่อให้ครัวและหอผู้ป่วยรู้ว่าเตียงนี้งดอาหาร
              ไม่ใช่ลืมสั่ง ถ้าตัดออกจากรายงานไปเลย เวลาไล่ตรวจว่าทำไมยอดมื้อ
              ไม่ตรงกับจำนวนผู้ป่วย จะหาคำอธิบายไม่เจอ
              จึงแสดงไว้แต่ไม่นับเป็นเงิน และไม่นับเป็นรายการที่ "ยังไม่ตั้งราคา"
            */
            const billable = r.food_type_id !== NPO_FOOD_TYPE_ID;
            const hasPrice = billable && priceDay !== null && perDay !== null && perDay > 0;

            // ครบวันเท่าไหร่ เหลือเศษกี่มื้อ — แยกให้เห็นเพราะสองส่วนนี้คิดคนละราคา
            const fullDays = hasPrice ? Math.floor(meals / perDay!) : 0;
            const remainder = hasPrice ? meals % perDay! : 0;
            const pricePerMeal = hasPrice ? roundUpMoney(priceDay! / perDay!) : null;

            const dayAmount = hasPrice ? roundUpMoney(fullDays * priceDay!) : null;
            const remainderAmount = hasPrice ? roundUpMoney(remainder * pricePerMeal!) : null;

            return {
                ward: r.ward,
                ward_name: sanitizeHTML(r.ward_name),
                food_type_id: r.food_type_id,
                food_type_name: String(sanitizeHTML(r.food_type_name ?? '') ?? '') || 'ไม่ระบุประเภท',
                contract_note: r.contract_note ? sanitizeHTML(r.contract_note) : null,
                effective_from: r.effective_from,
                effective_to: r.effective_to,
                first_date: r.first_date,
                last_date: r.last_date,
                meals,
                pending_meals: pendingMeals,
                meals_per_day: billable ? perDay : null,
                price_per_day: billable ? priceDay : null,
                price_per_meal: pricePerMeal,
                full_days: fullDays,
                remainder_meals: remainder,
                day_amount: dayAmount,
                remainder_amount: remainderAmount,
                // งดอาหารได้ 0 ไม่ใช่ null เพราะ "ไม่คิดเงิน" ต่างจาก "คิดไม่ได้เพราะยังไม่ตั้งราคา"
                amount: billable ? (hasPrice ? roundUpMoney(dayAmount! + remainderAmount!) : null) : 0,
                has_price: hasPrice,
                billable,
            };
        });

        // สรุปรายประเภท สำหรับใบเบิกที่แยกตามรายการสัญญา
        const byType = new Map<string, { name: string, meals: number, pending_meals: number, full_days: number, remainder_meals: number, amount: number, has_price: boolean, billable: boolean }>();
        for (const r of data) {
            const key = r.food_type_name;
            const cur = byType.get(key) ?? { name: key, meals: 0, pending_meals: 0, full_days: 0, remainder_meals: 0, amount: 0, has_price: true, billable: r.billable };
            cur.meals += r.meals;
            cur.pending_meals += r.pending_meals;
            cur.full_days += r.full_days;
            cur.remainder_meals += r.remainder_meals;
            cur.amount += r.amount ?? 0;
            if (!r.has_price && r.billable) cur.has_price = false;
            byType.set(key, cur);
        }

        // เฉพาะรายการที่ต้องคิดเงินแต่คิดไม่ได้ งดอาหารไม่นับเป็นปัญหา
        const unpriced = data.filter(r => r.billable && !r.has_price);
        const npoRows = data.filter(r => !r.billable);
        const billableRows = data.filter(r => r.billable);

        return {
            success: true,
            data: {
                date1,
                date2,
                rows: data,
                by_type: [...byType.values()]
                    .map(t => ({ ...t, amount: roundUpMoney(t.amount) }))
                    .sort((a, b) => b.amount - a.amount),
                summary: {
                    wards: new Set(data.map(r => r.ward)).size,
                    // นับเฉพาะมื้อที่คิดเงิน ไม่งั้นจำนวนมื้อกับยอดเงินจะอธิบายกันไม่ได้
                    meals: billableRows.reduce((s, r) => s + r.meals, 0),
                    full_days: billableRows.reduce((s, r) => s + r.full_days, 0),
                    remainder_meals: billableRows.reduce((s, r) => s + r.remainder_meals, 0),
                    amount: roundUpMoney(billableRows.reduce((s, r) => s + (r.amount ?? 0), 0)),
                    // แสดงแยกไว้ให้เห็นว่ามีการสั่งงดอาหารกี่มื้อ แต่ไม่เข้ายอดเงิน
                    npo_meals: npoRows.reduce((s, r) => s + r.meals, 0),
                    /*
                      มื้อที่สั่งแล้วแต่งานโภชนาการยังไม่กดรับ

                      ยังไม่เข้ายอดเงินเพราะยังไม่มีหลักฐานว่ารับมอบของแล้ว
                      แต่ต้องเห็นคู่กับยอดที่จ่ายเสมอ ไม่งั้นเวลายอดเป็นศูนย์
                      คนใช้จะคิดว่าระบบพัง ทั้งที่แค่ยังไม่มีใครไปกดรับ
                    */
                    pending_meals: billableRows.reduce((s, r) => s + r.pending_meals, 0),
                    npo_pending_meals: npoRows.reduce((s, r) => s + r.pending_meals, 0),
                    /*
                      มื้อที่คิดเงินไม่ได้เพราะยังไม่ได้ตั้งราคาหรือสัญญาขาดช่วง
                      ต้องโชว์แยก ไม่ใช่ทำเป็นศูนย์ ไม่งั้นใบเบิกจะขาดไปเงียบๆ
                    */
                    unpriced_meals: unpriced.reduce((s, r) => s + r.meals, 0),
                    unpriced_groups: unpriced.length,
                },
            },
        };
    } catch (error) {
        console.error('Get food payment summary error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
