import { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';

// ฟังก์ชันสำหรับดึงข้อมูลรายการอาหาร
export const getNutritionMenu = async ({ set }: Context) => {
    try {
        const rows = await nurse`SELECT food_item_id, food_name, food_type_id FROM food_items WHERE is_active = 'Y'`;
        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่ออาหาร
            data: rows.map(row => ({
                ...row,
                food_name: sanitizeHTML(row.food_name)
            }))
        };
    } catch (error) {
        console.error('Get nutrition menu error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลมื้ออาหาร
export const getMeals = async ({ set }: Context) => {
    try {
        const rows = await nurse`SELECT meal, name AS meal_name FROM meal`;
        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่อมื้ออาหาร
            data: rows.map(row => ({
                ...row,
                meal_name: sanitizeHTML(row.meal_name)
            }))
        };
    } catch (error) {
        console.error('Get meals error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับสั่งอาหาร (Bulk upsert บน unique key (order_date, meal, an))
export const orderMenu = async ({ body, set }: { body: any[], set: any }) => {
    const orders = body;

    if (!orders || orders.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบรายการที่ต้องการบันทึก' };
    }

    try {
        const now = new Date();
        const values = orders.map(o => ({
            admission_list_id: o.admission_list_id,
            an: o.an,
            ward: o.ward,
            order_date: o.order_date,
            meal: o.meal,
            food_item_id: o.food_item_id,
            request_by: o.request_by,
            addon: o.addon ?? null,
            create_datetime: now
        }));

        await nurse.begin(async sql => {
            await sql`
                INSERT INTO food_orders ${sql(values, 'admission_list_id', 'an', 'ward', 'order_date', 'meal', 'food_item_id', 'request_by', 'addon', 'create_datetime')}
                ON CONFLICT (order_date, meal, an) DO UPDATE SET
                    food_item_id = EXCLUDED.food_item_id,
                    addon = EXCLUDED.addon,
                    request_by = EXCLUDED.request_by,
                    ward = EXCLUDED.ward
            `;
        });

        return {
            success: true,
            message: `บันทึกรายการอาหารเรียบร้อยแล้ว จำนวน ${orders.length} รายการ`
        };
    } catch (error) {
        console.error('Order menu error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงรายการอาหารของผู้ป่วยตาม ward และวันที่
export const getFoodOrdersByWard = async ({ body, set }: { body: { ward: string, date: string }, set: any }) => {
    const { ward, date } = body;

    if (!ward || !date) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward และ date' };
    }

    try {
        const rows = await nurse`
            SELECT
                al.admission_list_id,
                al.hn,
                al.an,
                al.patient_name,
                al.bedno,
                (
                    SELECT fi.food_name
                    FROM food_orders fo
                    JOIN food_items fi ON fo.food_item_id = fi.food_item_id
                    WHERE fo.an = al.an AND fo.order_date = ${date} AND fo.meal = 1
                ) AS breakfast,
                (
                    SELECT NULLIF(TRIM(fo.addon), '')
                    FROM food_orders fo
                    WHERE fo.an = al.an AND fo.order_date = ${date} AND fo.meal = 1
                ) AS breakfast_addon,
                (
                    SELECT fi.food_name
                    FROM food_orders fo
                    JOIN food_items fi ON fo.food_item_id = fi.food_item_id
                    WHERE fo.an = al.an AND fo.order_date = ${date} AND fo.meal = 2
                ) AS lunch,
                (
                    SELECT NULLIF(TRIM(fo.addon), '')
                    FROM food_orders fo
                    WHERE fo.an = al.an AND fo.order_date = ${date} AND fo.meal = 2
                ) AS lunch_addon,
                (
                    SELECT fi.food_name
                    FROM food_orders fo
                    JOIN food_items fi ON fo.food_item_id = fi.food_item_id
                    WHERE fo.an = al.an AND fo.order_date = ${date} AND fo.meal = 3
                ) AS dinner,
                (
                    SELECT NULLIF(TRIM(fo.addon), '')
                    FROM food_orders fo
                    WHERE fo.an = al.an AND fo.order_date = ${date} AND fo.meal = 3
                ) AS dinner_addon
            FROM admission_list al
            WHERE al.discharge_type_id = 0 AND al.ward = ${ward}
            ORDER BY al.bedno ASC
        `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                patient_name: sanitizeHTML(row.patient_name),
                // addon เป็นข้อความอิสระที่ผู้ใช้พิมพ์ ต้องล้างแท็กก่อนส่งออก
                breakfast_addon: sanitizeHTML(row.breakfast_addon),
                lunch_addon: sanitizeHTML(row.lunch_addon),
                dinner_addon: sanitizeHTML(row.dinner_addon)
            }))
        };
    } catch (error) {
        console.error('Get food orders by ward error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงรายการอาหารตาม ward, date, meal (สำหรับ addon)
export const getFoodOrdersAddonByWard = async ({ body, set }: { body: { ward: string, date: string, meal: number }, set: any }) => {
    const { ward, date, meal } = body;

    if (!ward || !date || !meal) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date และ meal' };
    }

    try {
        const rows = await nurse`
            SELECT
                fo.food_order_id,
                fo.an,
                fo.addon,
                al.bedno,
                al.patient_name,
                m.name AS meal_name,
                fi.food_name
            FROM food_orders fo
            JOIN admission_list al ON fo.an = al.an AND al.discharge_type_id = 0
            JOIN food_items fi ON fo.food_item_id = fi.food_item_id
            JOIN meal m ON fo.meal = m.meal
            WHERE fo.ward = ${ward} AND fo.order_date = ${date} AND fo.meal = ${meal}
            ORDER BY al.bedno ASC
        `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                patient_name: sanitizeHTML(row.patient_name)
            }))
        };
    } catch (error) {
        console.error('Get food orders addon by ward error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับ update addon ของรายการอาหารตาม ward, date, meal
export const updateFoodOrderAddon = async ({ body, set }: { body: { ward: string, date: string, meal: number, orders: { food_order_id: number, addon?: string | null }[] }, set: any }) => {
    const { ward, date, meal, orders } = body;

    if (!ward || !date || !meal || !orders || orders.length === 0) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date, meal และ orders' };
    }

    try {
        await nurse.begin(async sql => {
            for (const order of orders) {
                await sql`
                    UPDATE food_orders
                    SET addon = ${order.addon ?? null}
                    WHERE food_order_id = ${order.food_order_id}
                      AND order_date = ${date}
                      AND meal = ${meal}
                      AND ward = ${ward}
                `;
            }
        });

        return {
            success: true,
            message: `อัปเดต addon เรียบร้อยแล้ว จำนวน ${orders.length} รายการ`
        };
    } catch (error) {
        console.error('Update food order addon error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับยกเลิกรายการอาหาร
export const cancelOrderMenu = async ({ body, set }: { body: any[], set: any }) => {
    const orders = body;

    if (!orders || orders.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบรายการที่ต้องการลบ' };
    }

    try {
        const ids = orders.map(o => o.food_order_id);
        const result = await nurse`DELETE FROM food_orders WHERE food_order_id IN ${nurse(ids)}`;

        return {
            success: true,
            message: `ลบรายการอาหารเรียบร้อยแล้ว จำนวน ${result.count} รายการ`
        };
    } catch (error) {
        console.error('Cancel order menu error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันดึงประวัติการสั่งอาหารรายผู้ป่วย ย้อนหลังตามจำนวนวันที่ระบุ
export const getFoodOrderHistoryByAN = async ({ body, set }: { body: { an: string, days?: number }, set: any }) => {
    const { an, days } = body;

    if (!an || !an.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    // จำกัดช่วงย้อนหลังไม่เกิน 90 วัน กัน query ที่กว้างเกินจำเป็น
    const lookback = Math.min(Math.max(Number(days) || 7, 1), 90);

    try {
        const rows = await nurse`
            SELECT
                 fo.food_order_id
                ,TO_CHAR(fo.order_date, 'YYYY-MM-DD') AS order_date
                ,fo.meal
                ,m.name AS meal_name
                ,fi.food_name
                ,fo.addon
                ,fo.ward
                ,fo.create_datetime
            FROM food_orders fo
            JOIN meal m ON m.meal = fo.meal
            LEFT JOIN food_items fi ON fi.food_item_id = fo.food_item_id
            WHERE fo.an = ${an.trim()}
              AND fo.order_date > CURRENT_DATE - ${lookback}::int
              AND fo.order_date <= CURRENT_DATE
            ORDER BY fo.order_date DESC, fo.meal ASC
        `;

        return {
            success: true,
            data: rows.map(row => ({
                foodOrderId: row.food_order_id,
                orderDate: row.order_date,
                meal: row.meal,
                mealName: sanitizeHTML(row.meal_name),
                foodName: sanitizeHTML(row.food_name),
                addon: sanitizeHTML(row.addon),
                ward: row.ward,
            }))
        };
    } catch (error) {
        console.error('Get food order history error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
