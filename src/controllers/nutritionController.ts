import { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor, type Actor } from '../utils/nursingRecord';
import { isAdmin } from './systemSettingsController';

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
                -- ต้องมี WHERE ให้ตรงกับ uq_food_orders_active ที่เป็นดัชนีบางส่วน
                -- รายการที่ถูกยกเลิกไปแล้วจึงไม่ถูกนับเป็นรายการซ้ำ สั่งใหม่ได้เป็นแถวใหม่
                ON CONFLICT (order_date, meal, an) WHERE cancelled_at IS NULL DO UPDATE SET
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
        /*
          LATERAL แทนคิวรีย่อยชุดเดิม เพราะต้องได้ food_order_id ของแต่ละมื้อมาด้วย
          หน้าจอถึงจะสั่งยกเลิกรายมื้อได้ ถ้าใช้คิวรีย่อยจะต้องเขียนซ้ำอีกสามชุด

          LEFT JOIN กับ food_items ไม่ใช่ JOIN เพื่อให้รายการที่ผูกกับเมนูที่ถูกปิดไปแล้ว
          ยังโผล่มาให้ยกเลิกได้ ไม่ใช่หายไปเงียบๆ ทั้งที่ครัวยังเห็นอยู่
        */
        const mealPick = (mealNo: number) => nurse`
            LEFT JOIN LATERAL (
                SELECT fo.food_order_id, fi.food_name, NULLIF(TRIM(fo.addon), '') AS addon,
                       -- COALESCE เพราะคอลัมน์เป็น NULL ตอนยังไม่รับ แล้ว NULL = 'Y' ได้ NULL ไม่ใช่ false
                       COALESCE(fo.recieve_order_status = 'Y', false) AS received, fo.reciever_name
                FROM food_orders fo
                LEFT JOIN food_items fi ON fi.food_item_id = fo.food_item_id
                WHERE fo.an = al.an
                  AND fo.order_date = ${date}
                  AND fo.meal = ${mealNo}
                  AND fo.cancelled_at IS NULL
                LIMIT 1
            )`;

        const rows = await nurse`
            SELECT
                al.admission_list_id,
                al.hn,
                al.an,
                al.patient_name,
                al.bedno,
                b.food_order_id AS breakfast_order_id,
                b.food_name     AS breakfast,
                b.addon         AS breakfast_addon,
                b.received      AS breakfast_received,
                l.food_order_id AS lunch_order_id,
                l.food_name     AS lunch,
                l.addon         AS lunch_addon,
                l.received      AS lunch_received,
                d.food_order_id AS dinner_order_id,
                d.food_name     AS dinner,
                d.addon         AS dinner_addon,
                d.received      AS dinner_received,
                COALESCE(b.reciever_name, l.reciever_name, d.reciever_name) AS reciever_name
            FROM admission_list al
            ${mealPick(1)} b ON TRUE
            ${mealPick(2)} l ON TRUE
            ${mealPick(3)} d ON TRUE
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
            /*
              หยิบทะเบียนผู้ป่วยในมาใบเดียว ไม่ใช่ JOIN ตรงๆ

              พบว่ามี AN ที่มีทะเบียนค้างอยู่สองแถวโดยยังไม่จำหน่ายทั้งคู่
              ถ้า join ธรรมดา รายการอาหารหนึ่งรายการจะถูกแตกเป็นสองแถว
              ที่มี food_order_id เท่ากัน แล้วหน้าจอจะฟ้องว่าคีย์ซ้ำ
              และถ้าแก้ addon จะยิงอัปเดตซ้ำสองครั้งกับรายการเดียวกัน
            */
            JOIN LATERAL (
                SELECT al.bedno, al.patient_name
                FROM admission_list al
                WHERE al.an = fo.an AND al.discharge_type_id = 0
                ORDER BY al.admission_list_id DESC
                LIMIT 1
            ) al ON TRUE
            JOIN food_items fi ON fo.food_item_id = fi.food_item_id
            JOIN meal m ON fo.meal = m.meal
            WHERE fo.ward = ${ward} AND fo.order_date = ${date} AND fo.meal = ${meal}
              AND fo.cancelled_at IS NULL
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

/**
 * ตรวจว่าเป็นเจ้าหน้าที่งานโภชนาการหรือไม่
 *
 * ผูกกับกลุ่มงานจริงในทะเบียนบุคลากร ไม่ได้สร้างบทบาทใหม่ในฐานข้อมูล hris
 * ที่ใช้ร่วมกับระบบอื่น และไม่ให้หน้าจอเป็นคนบอกว่าตัวเองเป็นใคร
 * ผู้ดูแลระบบผ่านได้ด้วย เพราะต้องแก้ปัญหาให้หน่วยงานได้ตอนมีเรื่องด่วน
 */
const NUTRITION_MAJOR = 'กลุ่มงานโภชนศาสตร์';

export const isNutritionStaff = async (user: unknown): Promise<{ ok: boolean; actor: Actor | null }> => {
    const actor = await resolveActor(user);
    if (!actor) return { ok: false, actor: null };
    if (actor.majorName === NUTRITION_MAJOR) return { ok: true, actor };
    return { ok: await isAdmin(user), actor };
};

// หน้าจอใช้ค่านี้ตัดสินว่าจะโชว์เมนูงานโภชนาการไหม การกันจริงอยู่ที่ทุก endpoint ที่เขียนข้อมูล
export const getNutritionAccess = async ({ user }: { user?: unknown }) => {
    const { ok, actor } = await isNutritionStaff(user);
    return {
        success: true,
        data: {
            can_receive: ok,
            major_name: actor?.majorName ?? '',
            fullname: actor?.fullname ?? '',
        },
    };
};

/**
 * ยกเลิกรายการอาหาร — ทำเครื่องหมายไว้ ไม่ลบแถวทิ้ง
 *
 * ใบสรุปรายการอาหารถูกพิมพ์ส่งครัวไปแล้ว ถ้าลบจริงจะไล่ไม่ได้ว่าทำไมยอดที่ครัว
 * ได้รับไม่ตรงกับยอดในระบบ จึงเก็บแถวไว้พร้อมชื่อคนยกเลิกกับเหตุผล
 * แล้วให้ทุกคิวรีที่ส่งรายการให้ครัวข้ามแถวที่ถูกยกเลิก
 */
export const cancelOrderMenu = async ({ body, set, user }: { body: any[], set: any, user?: unknown }) => {
    const orders = body;

    if (!orders || orders.length === 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบรายการที่ต้องการยกเลิก' };
    }

    const ids = orders
        .map(o => Number(o.food_order_id))
        .filter(id => Number.isInteger(id) && id > 0);

    if (ids.length === 0) {
        set.status = 400;
        return { success: false, message: 'รหัสรายการอาหารไม่ถูกต้อง' };
    }

    // เหตุผลรับมาได้จากรายการแรก หน้าจอยกเลิกทีละมื้ออยู่แล้ว
    const reason = String(sanitizeHTML(String(orders[0]?.reason ?? '').trim()) ?? '').slice(0, 500) || null;

    try {
        const { ok: nutritionStaff, actor } = await isNutritionStaff(user);
        const actorId = actor?.userId ? Number(actor.userId) : null;

        /*
          รายการที่งานโภชนาการรับไปแล้ว หอผู้ป่วยยกเลิกเองไม่ได้
          ของอาจเข้าครัวไปแล้ว ถ้าหายไปเงียบๆ ยอดที่เตรียมกับยอดที่สั่งจะไม่ตรงกัน
          ถ้าต้องยกเลิกจริงต้องแจ้งงานโภชนาการให้ถอนการรับก่อน คนของหน่วยนั้นยกเลิกได้เอง
        */
        if (!nutritionStaff) {
            const locked = await nurse`
                SELECT food_order_id, reciever_name,
                       TO_CHAR(recieve_order_datetime, 'DD/MM/YYYY HH24:MI') AS at
                FROM food_orders
                WHERE food_order_id IN ${nurse(ids)}
                  AND cancelled_at IS NULL
                  AND recieve_order_status = 'Y'
            `;
            if (locked.length > 0) {
                set.status = 409;
                const who = sanitizeHTML(locked[0].reciever_name) || 'งานโภชนาการ';
                return {
                    success: false,
                    message: `ยกเลิกไม่ได้ เพราะ${who}รับรายการไปแล้วเมื่อ ${locked[0].at} น. กรุณาแจ้งงานโภชนาการให้ถอนการรับก่อน`,
                };
            }
        }

        const result = await nurse`
            UPDATE food_orders
            SET cancelled_at      = NOW(),
                cancelled_by      = ${actorId},
                cancelled_by_name = ${actor?.fullname ?? null},
                cancel_reason     = ${reason}
            WHERE food_order_id IN ${nurse(ids)}
              AND cancelled_at IS NULL
            RETURNING food_order_id
        `;

        if (result.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบรายการที่ยังใช้งานอยู่ อาจถูกยกเลิกไปแล้ว' };
        }

        return {
            success: true,
            message: `ยกเลิกรายการอาหารเรียบร้อยแล้ว จำนวน ${result.length} รายการ`,
            data: { cancelled: result.map(r => r.food_order_id) }
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
                ,TO_CHAR(fo.cancelled_at, 'YYYY-MM-DD HH24:MI') AS cancelled_at
                ,fo.cancelled_by_name
                ,fo.cancel_reason
            FROM food_orders fo
            JOIN meal m ON m.meal = fo.meal
            LEFT JOIN food_items fi ON fi.food_item_id = fo.food_item_id
            WHERE fo.an = ${an.trim()}
              AND fo.order_date > CURRENT_DATE - ${lookback}::int
              AND fo.order_date <= CURRENT_DATE
            ORDER BY fo.order_date DESC, fo.meal ASC, fo.food_order_id ASC
        `;

        return {
            success: true,
            // รายการที่ยกเลิกแล้วยังส่งกลับไปด้วย ประวัติจึงบอกได้ว่าเคยสั่งอะไรไว้
            // แล้วใครเป็นคนเอาออกเมื่อไหร่ ซึ่งเป็นเหตุผลที่ไม่ลบแถวทิ้งตั้งแต่แรก
            data: rows.map(row => ({
                foodOrderId: row.food_order_id,
                orderDate: row.order_date,
                meal: row.meal,
                mealName: sanitizeHTML(row.meal_name),
                foodName: sanitizeHTML(row.food_name),
                addon: sanitizeHTML(row.addon),
                ward: row.ward,
                cancelledAt: row.cancelled_at,
                cancelledBy: sanitizeHTML(row.cancelled_by_name),
                cancelReason: sanitizeHTML(row.cancel_reason),
            }))
        };
    } catch (error) {
        console.error('Get food order history error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * สรุปรายการอาหารประจำวันสำหรับงานโภชนาการ
 *
 * ครัวต้องการสองมุมพร้อมกัน: ยอดรวมทั้งโรงพยาบาลว่าต้องทำเมนูไหนกี่ที่
 * กับยอดแยกรายหอว่าจัดใส่รถเข็นของแต่ละตึกอย่างละกี่ที่
 * ส่งเป็นแถวย่อยรายหอ×เมนู แล้วให้หน้าจอรวมยอดเอง จะได้ไม่ต้องยิงสองรอบ
 */
export const getDailyFoodSummary = async ({ body, set }: { body: { date: string }, set: any }) => {
    const date = String(body?.date ?? '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD' };
    }

    try {
        const rows = await nurse`
            SELECT
                 fo.meal
                ,fo.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
                ,fo.food_item_id
                ,COALESCE(fi.food_name, 'ไม่พบเมนูในระบบ')  AS food_name
                ,COUNT(*)::int                              AS qty
                ,COUNT(*) FILTER (WHERE fo.recieve_order_status = 'Y')::int AS received
                ,COUNT(*) FILTER (WHERE fo.addon IS NOT NULL AND TRIM(fo.addon) <> '')::int AS with_addon
            FROM food_orders fo
            LEFT JOIN ward w       ON w.his_code = fo.ward
            LEFT JOIN food_items fi ON fi.food_item_id = fo.food_item_id
            WHERE fo.order_date = ${date}
              AND fo.cancelled_at IS NULL
            GROUP BY fo.meal, fo.ward, w.ward_name, fo.food_item_id, fi.food_name
            ORDER BY fo.meal, w.ward_name NULLS LAST, food_name
        `;

        // หมายเหตุรายคน ครัวต้องเห็นเป็นรายบรรทัด รวมยอดแทนกันไม่ได้
        const addons = await nurse`
            SELECT fo.meal, fo.ward, fo.an, al.bedno, al.patient_name,
                   COALESCE(fi.food_name, '-') AS food_name, fo.addon
            FROM food_orders fo
            LEFT JOIN admission_list al ON al.an = fo.an
            LEFT JOIN food_items fi     ON fi.food_item_id = fo.food_item_id
            WHERE fo.order_date = ${date}
              AND fo.cancelled_at IS NULL
              AND fo.addon IS NOT NULL AND TRIM(fo.addon) <> ''
            ORDER BY fo.meal, fo.ward, al.bedno
        `;

        // สถานะการรับรายหอ×มื้อ — ใช้เวลาที่รับล่าสุดเป็นตัวแทนของทั้งชุด
        const status = await nurse`
            SELECT
                 fo.meal
                ,fo.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
                ,COUNT(*)::int AS total
                ,COUNT(*) FILTER (WHERE fo.recieve_order_status = 'Y')::int AS received
                ,MAX(fo.reciever_name) FILTER (WHERE fo.recieve_order_status = 'Y') AS reciever_name
                ,TO_CHAR(MAX(fo.recieve_order_datetime), 'DD/MM/YYYY HH24:MI') AS received_at
            FROM food_orders fo
            LEFT JOIN ward w ON w.his_code = fo.ward
            WHERE fo.order_date = ${date}
              AND fo.cancelled_at IS NULL
            GROUP BY fo.meal, fo.ward, w.ward_name
            ORDER BY fo.meal, w.ward_name NULLS LAST
        `;

        return {
            success: true,
            data: {
                date,
                rows: rows.map(r => ({ ...r, food_name: sanitizeHTML(r.food_name), ward_name: sanitizeHTML(r.ward_name) })),
                addons: addons.map(r => ({
                    ...r,
                    patient_name: sanitizeHTML(r.patient_name),
                    food_name: sanitizeHTML(r.food_name),
                    addon: sanitizeHTML(r.addon),
                })),
                wards: status.map(r => ({
                    ...r,
                    ward_name: sanitizeHTML(r.ward_name),
                    reciever_name: sanitizeHTML(r.reciever_name),
                    pending: r.total - r.received,
                })),
            },
        };
    } catch (error) {
        console.error('Get daily food summary error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * งานโภชนาการรับรายการอาหารของหอผู้ป่วยหนึ่งมื้อหนึ่ง
 *
 * รับทั้งชุดไม่ใช่ทีละราย เพราะครัวทำงานเป็นรอบต่อมื้อต่อตึก ไม่ได้ไล่ทีละเตียง
 * เมื่อรับแล้วหอผู้ป่วยจะยกเลิกเองไม่ได้ ถอนได้เฉพาะคนของงานโภชนาการ
 */
export const receiveFoodOrders = async (
    { body, set, user }: { body: { ward: string, date: string, meal: number, undo?: boolean }, set: any, user?: unknown }
) => {
    const { ward, date, meal, undo } = body ?? {};

    if (!ward || !/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) || ![1, 2, 3].includes(Number(meal))) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date (YYYY-MM-DD) และ meal (1-3) ให้ถูกต้อง' };
    }

    const { ok, actor } = await isNutritionStaff(user);
    if (!ok) {
        set.status = 403;
        return { success: false, message: 'เฉพาะเจ้าหน้าที่งานโภชนาการเท่านั้นที่รับรายการอาหารได้' };
    }

    try {
        const actorId = actor?.userId ? Number(actor.userId) : null;

        const result = undo
            ? await nurse`
                UPDATE food_orders
                SET recieve_order_status = NULL, recieve_order_datetime = NULL,
                    reciever = NULL, reciever_name = NULL
                WHERE ward = ${ward} AND order_date = ${date} AND meal = ${Number(meal)}
                  AND cancelled_at IS NULL AND recieve_order_status = 'Y'
                RETURNING food_order_id`
            : await nurse`
                UPDATE food_orders
                SET recieve_order_status = 'Y', recieve_order_datetime = NOW(),
                    reciever = ${actorId}, reciever_name = ${actor?.fullname ?? null}
                WHERE ward = ${ward} AND order_date = ${date} AND meal = ${Number(meal)}
                  AND cancelled_at IS NULL AND recieve_order_status IS DISTINCT FROM 'Y'
                RETURNING food_order_id`;

        if (result.length === 0) {
            set.status = 404;
            return {
                success: false,
                message: undo ? 'ไม่พบรายการที่รับไว้ของหอผู้ป่วยและมื้อนี้' : 'ไม่พบรายการที่ยังไม่ได้รับของหอผู้ป่วยและมื้อนี้',
            };
        }

        return {
            success: true,
            message: `${undo ? 'ถอนการรับ' : 'รับ'}รายการอาหารเรียบร้อยแล้ว จำนวน ${result.length} รายการ`,
            data: { affected: result.length },
        };
    } catch (error) {
        console.error('Receive food orders error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * รายการสำหรับพิมพ์ฉลากติดถาดอาหาร
 *
 * หนึ่งแถวคือหนึ่งฉลาก = หนึ่งถาด เรียงตามหอผู้ป่วยแล้วตามเตียง
 * เพราะคนติดฉลากทำงานไล่ไปทีละตึกทีละเตียง ถ้าเรียงตามชื่ออาหารจะต้องเดินย้อนไปมา
 */
export const getTrayLabels = async (
    { body, set }: { body: { date: string, meal: number, ward?: string | null }, set: any }
) => {
    const { date, meal, ward } = body ?? {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) || ![1, 2, 3].includes(Number(meal))) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ date (YYYY-MM-DD) และ meal (1-3) ให้ถูกต้อง' };
    }

    try {
        const rows = await nurse`
            SELECT
                 fo.food_order_id
                ,fo.ward
                ,COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name
                ,al.bedno
                ,al.an
                ,al.hn
                ,al.patient_name
                ,fi.food_name
                ,NULLIF(TRIM(fo.addon), '') AS addon
                ,m.name AS meal_name
            FROM food_orders fo
            -- หยิบทะเบียนใบเดียวด้วยเหตุผลเดียวกับหน้า Addon คือมี AN ที่มีทะเบียนค้างซ้ำ
            JOIN LATERAL (
                SELECT a.bedno, a.an, a.hn, a.patient_name
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
              ${ward ? nurse`AND fo.ward = ${ward}` : nurse``}
            ORDER BY w.ward_name NULLS LAST, al.bedno, al.an
        `;

        return {
            success: true,
            data: rows.map(r => ({
                food_order_id: r.food_order_id,
                ward: r.ward,
                ward_name: sanitizeHTML(r.ward_name),
                bedno: r.bedno ? sanitizeHTML(r.bedno) : null,
                an: r.an,
                hn: r.hn,
                patient_name: sanitizeHTML(r.patient_name),
                food_name: sanitizeHTML(r.food_name),
                addon: sanitizeHTML(r.addon),
                meal_name: sanitizeHTML(r.meal_name),
            })),
        };
    } catch (error) {
        console.error('Get tray labels error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * สรุปยอดอาหารตามประเภท สำหรับหน้าแดชบอร์ดของงานโภชนาการ
 *
 * ประเภทอ่านจาก food_items.food_type_id ที่อ้าง food_types ไม่ใช่จากวงเล็บในชื่อ
 * ของเดิมอ่านจากชื่อเพราะตารางประเภทยังว่าง ซึ่งพังเงียบ ๆ ได้ถ้าสะกดวงเล็บต่างไป
 * COALESCE ไว้เผื่อเมนูที่ยังไม่ได้ระบุประเภท จะได้ไม่หายไปจากยอดรวม
 */
const FOOD_CLASS_SQL = `COALESCE(ft.food_type_name, 'ไม่ระบุประเภท')`;

export const getFoodTypeDashboard = async (
    { body, set }: { body: { date1: string, date2: string }, set: any }
) => {
    const { date1, date2 } = body ?? {};
    const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

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
          MATERIALIZED เพื่อให้ CTE ถูกคำนวณรอบเดียว
          ถ้าปล่อยให้ตัวจัดการแทรกเข้าไปในทุกคิวรีย่อย จะกลายเป็นอ่านตารางซ้ำสี่รอบ
        */
        const rows = await nurse.unsafe(`
            WITH src AS MATERIALIZED (
                SELECT
                     fo.order_date
                    ,fo.meal
                    ,fo.an
                    ,fo.ward
                    ,${FOOD_CLASS_SQL} AS class
                    -- ตัดวงเล็บประเภทห้องท้ายชื่อออก ให้เหลือชนิดอาหารล้วน
                    -- ใช้ [(] [)] แทน \( \) เพราะ backslash ในสตริงของ TS ถูกกลืนไปหนึ่งชั้น
                    -- แล้วกลายเป็น regex คนละตัวโดยไม่มีใครรู้ (ของเดิมคืนชื่อเต็มมาเฉยๆ)
                    ,btrim(regexp_replace(fi.food_name, '[[:space:]]*[(][^)]*[)][[:space:]]*$', '')) AS diet
                FROM food_orders fo
                JOIN food_items fi ON fi.food_item_id = fo.food_item_id
                LEFT JOIN food_types ft ON ft.food_type_id = fi.food_type_id
                WHERE fo.cancelled_at IS NULL
                  AND fo.order_date BETWEEN $1 AND $2
            )
            SELECT
                 (SELECT COUNT(*)::int FROM src)                        AS total
                ,(SELECT COUNT(DISTINCT order_date)::int FROM src)      AS days
                ,(SELECT COUNT(DISTINCT an)::int FROM src)              AS patients
                ,(SELECT COUNT(DISTINCT ward)::int FROM src)            AS wards
                ,(SELECT COALESCE(json_agg(t), '[]') FROM (
                    SELECT class AS name, COUNT(*)::int AS qty
                    FROM src GROUP BY 1 ORDER BY 2 DESC, 1) t)          AS by_class
                ,(SELECT COALESCE(json_agg(t), '[]') FROM (
                    SELECT diet AS name, COUNT(*)::int AS qty
                    FROM src GROUP BY 1 ORDER BY 2 DESC, 1) t)          AS by_diet
                ,(SELECT COALESCE(json_agg(t), '[]') FROM (
                    SELECT meal, class, COUNT(*)::int AS qty
                    FROM src GROUP BY 1, 2 ORDER BY 1, 2) t)            AS by_meal
                ,(SELECT COALESCE(json_agg(t), '[]') FROM (
                    SELECT to_char(order_date, 'YYYY-MM-DD') AS date, class, COUNT(*)::int AS qty
                    FROM src GROUP BY 1, 2 ORDER BY 1, 2) t)            AS daily
                ,(SELECT COALESCE(json_agg(t), '[]') FROM (
                    SELECT COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name,
                           src.class, COUNT(*)::int AS qty
                    FROM src LEFT JOIN ward w ON w.his_code = src.ward
                    GROUP BY 1, 2 ORDER BY 3 DESC) t)                   AS by_ward
                /*
                  สามชั้นในแถวเดียว สำหรับกราฟ Sankey มื้อ → หอผู้ป่วย → ประเภทห้อง
                  ส่งเป็นยอดดิบให้หน้าจอต่อเส้นเอง เพราะจำนวนหอไม่มาก
                  ไม่ต้องยุบเป็น "อื่นๆ" เหมือนกราฟเชื้อดื้อยาที่มี 41 หน่วยงาน
                */
                ,(SELECT COALESCE(json_agg(t), '[]') FROM (
                    SELECT src.meal,
                           COALESCE(w.ward_name, 'ไม่ระบุหอผู้ป่วย') AS ward_name,
                           src.class, COUNT(*)::int AS qty
                    FROM src LEFT JOIN ward w ON w.his_code = src.ward
                    GROUP BY 1, 2, 3 ORDER BY 4 DESC) t)                AS meal_ward_class
        `, [date1, date2]);

        const r = rows[0];
        const clean = <T extends { name?: string; ward_name?: string }>(arr: T[]) =>
            arr.map(x => ({
                ...x,
                ...(x.name !== undefined ? { name: sanitizeHTML(x.name) } : {}),
                ...(x.ward_name !== undefined ? { ward_name: sanitizeHTML(x.ward_name) } : {}),
            }));

        return {
            success: true,
            data: {
                start_date: date1,
                end_date: date2,
                summary: {
                    total: r.total,
                    days: r.days,
                    patients: r.patients,
                    wards: r.wards,
                },
                by_class: clean(r.by_class),
                by_diet: clean(r.by_diet),
                by_meal: r.by_meal,
                daily: r.daily,
                by_ward: clean(r.by_ward),
                meal_ward_class: clean(r.meal_ward_class),
            },
        };
    } catch (error) {
        console.error('Get food type dashboard error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
