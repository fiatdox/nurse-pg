import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { isAdmin } from './systemSettingsController';
import { resolveActor } from '../utils/nursingRecord';
import { roundUpMoney } from '../utils/money';
import { NPO_FOOD_TYPE_ID } from './foodItemController';

/**
 * ราคาอาหารตามประเภทห้อง จากผลการประกวดราคา
 *
 * เป็นค่าตั้งของผู้ดูแลระบบ ไม่ใช่ของงานโภชนาการ เพราะตัวเลขนี้ผูกกับสัญญาจัดซื้อ
 * และเป็นฐานในการคิดเงินที่โรงพยาบาลต้องจ่ายผู้รับจ้าง
 */

const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

/**
 * ราคาของทุกประเภท พร้อมราคาที่ใช้อยู่ ณ วันที่อ้างอิง และประวัติทั้งหมด
 *
 * ผู้ใช้ทั่วไปอ่านได้ เพราะรายงานยอดเงินต้องใช้ราคา
 * แต่การแก้ไขจำกัดเฉพาะผู้ดูแลระบบ
 */
export const getFoodTypePrices = async (
    { body, set, user }: { body?: { as_of?: string } | null, set: any, user?: unknown }
) => {
    const asOf = isDate(body?.as_of) ? String(body?.as_of) : new Date().toISOString().slice(0, 10);

    try {
        const rows = await nurse`
            SELECT
                 ft.food_type_id
                ,ft.food_type_name
                ,ft.is_active
                /*
                  ราคาที่มีผล ณ วันอ้างอิง คือแถวที่เริ่มมีผลล่าสุดที่ยังไม่เกินวันนั้น
                  ใช้คิวรีย่อยเรียงแล้วหยิบใบเดียว ไม่ใช่ MAX() เพราะต้องได้ทั้งแถว
                  ไม่ใช่แค่ตัววันที่
                */
                ,cur.price_per_day
                ,cur.meals_per_day
                ,TO_CHAR(cur.effective_from, 'YYYY-MM-DD') AS effective_from
                ,TO_CHAR(cur.effective_to, 'YYYY-MM-DD')   AS effective_to
                ,cur.contract_note
                ,cur.created_by_name
                ,(SELECT COUNT(*)::int FROM food_type_prices p WHERE p.food_type_id = ft.food_type_id) AS price_count
            FROM food_types ft
            LEFT JOIN LATERAL (
                SELECT p.price_per_day, p.meals_per_day, p.effective_from, p.effective_to, p.contract_note, p.created_by_name
                FROM food_type_prices p
                WHERE p.food_type_id = ft.food_type_id
                  AND p.effective_from <= ${asOf}
                  -- สัญญาที่หมดอายุแล้วไม่ถูกนำมาใช้ ช่วงที่ไม่มีสัญญาจะได้ราคาว่าง
                  AND (p.effective_to IS NULL OR p.effective_to >= ${asOf})
                ORDER BY p.effective_from DESC
                LIMIT 1
            ) cur ON TRUE
            ORDER BY ft.food_type_id`;

        const history = await nurse`
            SELECT
                 h.food_type_price_id
                ,h.food_type_id
                ,ft.food_type_name
                ,h.price_per_day
                ,h.meals_per_day
                ,TO_CHAR(h.effective_from, 'YYYY-MM-DD') AS effective_from
                ,TO_CHAR(h.effective_to, 'YYYY-MM-DD')   AS effective_to
                ,h.contract_note
                ,TO_CHAR(h.created_at, 'YYYY-MM-DD HH24:MI') AS created_at
                ,h.created_by_name
                ,h.vendor_id
                ,v.vendor_name
            FROM food_type_prices h
            JOIN food_types ft ON ft.food_type_id = h.food_type_id
            LEFT JOIN vendors v ON v.vendor_id = h.vendor_id
            ORDER BY h.effective_from DESC, h.food_type_id`;

        /*
          ทะเบียนบริษัทส่งไปด้วย หน้าตั้งราคาต้องมีตัวเลือกให้ผูกสัญญา
          เอาเฉพาะที่ยังเปิดใช้งาน การผูกสัญญาใหม่กับบริษัทที่ปิดไปแล้วไม่มีความหมาย
        */
        const vendors = await nurse`
            SELECT vendor_id, vendor_name FROM vendors WHERE is_active ORDER BY vendor_name`;

        return {
            success: true,
            data: {
                as_of: asOf,
                can_manage: await isAdmin(user),
                types: rows.map(r => ({
                    food_type_id: r.food_type_id,
                    food_type_name: sanitizeHTML(r.food_type_name),
                    is_active: r.is_active,
                    // งดอาหารไม่ต้องตั้งราคา ไม่มีอาหารส่งจริงจึงไม่คิดเงินให้บริษัท
                    billable: r.food_type_id !== NPO_FOOD_TYPE_ID,
                    // ประเภทที่ยังไม่เคยตั้งราคาจะได้ null ไม่ใช่ 0 เพราะ "ยังไม่ตั้ง" ต่างจาก "ฟรี"
                    price_per_day: r.price_per_day === null ? null : Number(r.price_per_day),
                    meals_per_day: r.meals_per_day === null ? null : Number(r.meals_per_day),
                    // ค่าเฉลี่ยไว้ตรวจทานเท่านั้น การจ่ายคิดเป็นวันเต็ม จึงไม่เอาไปคูณต่อ
                    price_per_meal: r.price_per_day === null || !r.meals_per_day
                        ? null
                        : roundUpMoney(Number(r.price_per_day) / Number(r.meals_per_day)),
                    effective_from: r.effective_from,
                    effective_to: r.effective_to,
                    contract_note: r.contract_note ? sanitizeHTML(r.contract_note) : null,
                    created_by_name: r.created_by_name ? sanitizeHTML(r.created_by_name) : null,
                    price_count: r.price_count,
                })),
                history: history.map(h => ({
                    ...h,
                    food_type_name: sanitizeHTML(h.food_type_name),
                    price_per_day: Number(h.price_per_day),
                    meals_per_day: Number(h.meals_per_day),
                    contract_note: h.contract_note ? sanitizeHTML(h.contract_note) : null,
                    created_by_name: h.created_by_name ? sanitizeHTML(h.created_by_name) : null,
                    vendor_id: h.vendor_id === null ? null : Number(h.vendor_id),
                    vendor_name: h.vendor_name ? sanitizeHTML(h.vendor_name) : null,
                })),
                /*
                  ทะเบียนบริษัทส่งไปด้วย หน้าตั้งราคาต้องมีตัวเลือกให้ผูกสัญญา
                  ส่งเฉพาะที่ยังเปิดใช้งาน เพราะการผูกสัญญาใหม่กับบริษัทที่ปิดไปแล้วไม่มีความหมาย
                */
                vendors: vendors.map(v => ({
                    vendor_id: Number(v.vendor_id),
                    vendor_name: sanitizeHTML(v.vendor_name),
                })),
            },
        };
    } catch (error) {
        console.error('Get food type prices error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * เพิ่มหรือแก้ไขสัญญาราคาหนึ่งฉบับ
 *
 * หนึ่งแถวคือหนึ่งสัญญา = ประเภทอาหาร + ช่วงวันที่ + ราคา
 * ส่ง food_type_price_id มาด้วย = แก้ไขฉบับนั้น ไม่ส่ง = เพิ่มฉบับใหม่
 *
 * ไม่ทับของเดิม สัญญาเก่ายังอยู่ครบเพื่อคิดยอดย้อนหลังได้ตรงกับราคาที่ใช้ในตอนนั้น
 */
export const setFoodTypePrice = async (
    { body, set, user }: {
        body: {
            food_type_price_id?: number | null,
            food_type_id: number, price_per_day: number, effective_from: string,
            effective_to?: string | null, meals_per_day?: number, contract_note?: string | null,
            vendor_id?: number | null
        },
        set: any,
        user?: unknown
    }
) => {
    // ตรวจสิทธิ์ที่เซิร์ฟเวอร์เสมอ การซ่อนเมนูฝั่งหน้าจอเป็นแค่ความสะดวก ไม่ใช่การป้องกัน
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่ตั้งราคาอาหารได้' };
    }

    const typeId = Number(body?.food_type_id);
    const price = Number(body?.price_per_day);
    const meals = body?.meals_per_day === undefined ? 3 : Number(body.meals_per_day);
    const from = String(body?.effective_from ?? '');
    const vendorId = body?.vendor_id ? Number(body.vendor_id) : null;

    if (!Number.isInteger(typeId) || typeId <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบประเภทอาหารที่ต้องการตั้งราคา' };
    }
    if (!Number.isFinite(price) || price < 0) {
        set.status = 400;
        return { success: false, message: 'กรุณากรอกราคาเป็นตัวเลขไม่ติดลบ' };
    }
    if (price > 100000) {
        set.status = 400;
        return { success: false, message: 'ราคาสูงผิดปกติ กรุณาตรวจสอบอีกครั้ง' };
    }
    if (!Number.isInteger(meals) || meals < 1 || meals > 6) {
        set.status = 400;
        return { success: false, message: 'จำนวนมื้อต่อวันต้องอยู่ระหว่าง 1 ถึง 6' };
    }
    if (!isDate(from)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันที่เริ่มมีผลในรูปแบบ YYYY-MM-DD' };
    }

    const to = body?.effective_to ? String(body.effective_to) : null;
    if (to !== null && !isDate(to)) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุวันสิ้นสุดสัญญาในรูปแบบ YYYY-MM-DD' };
    }
    if (to !== null && to < from) {
        set.status = 400;
        return { success: false, message: 'วันสิ้นสุดสัญญาต้องไม่มาก่อนวันเริ่มมีผล' };
    }

    const editId = body?.food_type_price_id ? Number(body.food_type_price_id) : null;
    if (editId !== null && (!Number.isInteger(editId) || editId <= 0)) {
        set.status = 400;
        return { success: false, message: 'ไม่พบสัญญาที่ต้องการแก้ไข' };
    }

    try {
        const exists = await nurse`SELECT 1 FROM food_types WHERE food_type_id = ${typeId} LIMIT 1`;
        if (exists.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบประเภทอาหารที่ต้องการตั้งราคา' };
        }

        /*
          สัญญาต้องมีเจ้าของเสมอ

          แถวที่ไม่ระบุบริษัทจะไม่ปรากฏในหน้าของบริษัทใดเลย มื้อในช่วงนั้นจะกลายเป็น
          "ยังไม่มีราคา" ทั้งที่ตั้งราคาไว้แล้ว แล้วยอดจะขาดไปเงียบๆ ตอนวางบิล
        */
        if (vendorId === null) {
            set.status = 400;
            return { success: false, message: 'กรุณาระบุบริษัทคู่สัญญา' };
        }
        const vendorExists = await nurse`SELECT 1 FROM vendors WHERE vendor_id = ${vendorId} LIMIT 1`;
        if (vendorExists.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบบริษัทที่ระบุ' };
        }

        if (editId !== null) {
            const target = await nurse`SELECT 1 FROM food_type_prices WHERE food_type_price_id = ${editId} LIMIT 1`;
            if (target.length === 0) {
                set.status = 404;
                return { success: false, message: 'ไม่พบสัญญาที่ต้องการแก้ไข' };
            }
        }

        /*
          กันช่วงสัญญาซ้อนกันของประเภทเดียวกัน

          ถ้าปล่อยให้ซ้อนได้ วันที่อยู่ในสองสัญญาพร้อมกันจะมีสองราคา
          แล้วยอดที่ต้องจ่ายจะขึ้นกับว่าคิวรีหยิบแถวไหนมาก่อน ซึ่งไม่แน่นอน

          ตรวจในโค้ดแทน exclusion constraint เพราะต้องติดตั้งส่วนขยาย btree_gist
          ซึ่งอาจไม่มีสิทธิ์บนเครื่องจริง ตารางนี้มีคนแก้ทีละคนและนานๆ ครั้ง
          ความเสี่ยงที่สองคนบันทึกพร้อมกันจึงต่ำพอรับได้

          ตอนแก้ไข ต้องกันฉบับที่กำลังแก้ออกจากการเทียบ ไม่งั้นจะฟ้องว่าซ้อนกับตัวเอง
          และเทียบด้วยรหัสของแถว ไม่ใช่วันเริ่ม เพราะการแก้อาจเลื่อนวันเริ่มด้วย
        */
        const overlap = await nurse`
            SELECT TO_CHAR(effective_from, 'YYYY-MM-DD') AS f
                  ,TO_CHAR(effective_to,   'YYYY-MM-DD') AS t
            FROM food_type_prices
            WHERE food_type_id = ${typeId}
              AND food_type_price_id IS DISTINCT FROM ${editId}
              AND effective_from <= ${to ?? '9999-12-31'}
              AND COALESCE(effective_to, '9999-12-31'::date) >= ${from}
            ORDER BY effective_from
            LIMIT 1`;

        if (overlap.length > 0) {
            const o = overlap[0] as { f: string, t: string | null };
            set.status = 409;
            return {
                success: false,
                message: `ช่วงสัญญาซ้อนกับรายการเดิม (${o.f} ถึง ${o.t ?? 'ไม่กำหนด'}) กรุณาระบุวันสิ้นสุดของสัญญาเดิมก่อน`,
            };
        }

        const actor = await resolveActor(user);
        const note = body?.contract_note ? String(sanitizeHTML(String(body.contract_note)) ?? '').trim().slice(0, 255) : null;

        const actorId = actor?.userId ? Number(actor.userId) : null;

        const saved = editId !== null
            ? await nurse`
                UPDATE food_type_prices
                SET food_type_id    = ${typeId}
                   ,vendor_id       = ${vendorId}
                   ,effective_from  = ${from}
                   ,effective_to    = ${to}
                   ,price_per_day   = ${price}
                   ,meals_per_day   = ${meals}
                   ,contract_note   = ${note}
                   ,created_at      = NOW()
                   ,created_by      = ${actorId}
                   ,created_by_name = ${actor?.fullname ?? null}
                WHERE food_type_price_id = ${editId}
                RETURNING food_type_price_id, food_type_id, price_per_day, meals_per_day,
                          TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from,
                          TO_CHAR(effective_to,   'YYYY-MM-DD') AS effective_to`
            : await nurse`
                INSERT INTO food_type_prices
                    (food_type_id, vendor_id, effective_from, effective_to, price_per_day, meals_per_day, contract_note, created_by, created_by_name)
                VALUES (${typeId}, ${vendorId}, ${from}, ${to}, ${price}, ${meals}, ${note}, ${actorId}, ${actor?.fullname ?? null})
                RETURNING food_type_price_id, food_type_id, price_per_day, meals_per_day,
                          TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from,
                          TO_CHAR(effective_to,   'YYYY-MM-DD') AS effective_to`;

        const row = saved[0] as Record<string, unknown>;
        return {
            success: true,
            message: editId !== null
                ? `แก้ไขสัญญาแล้ว (${from} ถึง ${to ?? 'ไม่กำหนด'})`
                : `เพิ่มสัญญาแล้ว (${from} ถึง ${to ?? 'ไม่กำหนด'})`,
            data: { ...row, price_per_day: Number(row.price_per_day), meals_per_day: Number(row.meals_per_day) },
        };
    } catch (error) {
        console.error('Set food type price error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * ลบราคาหนึ่งรายการออกจากประวัติ
 *
 * มีไว้แก้กรณีบันทึกผิดวัน ไม่ใช่ไว้ล้างประวัติ
 * ราคาที่เคยใช้คิดยอดไปแล้วไม่ควรลบ เพราะยอดที่ออกไปแล้วจะอธิบายไม่ได้
 */
export const deleteFoodTypePrice = async (
    { body, set, user }: { body: { food_type_price_id: number }, set: any, user?: unknown }
) => {
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบราคาได้' };
    }

    const id = Number(body?.food_type_price_id);
    if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบรายการราคาที่ต้องการลบ' };
    }

    try {
        const rows = await nurse`
            DELETE FROM food_type_prices WHERE food_type_price_id = ${id}
            RETURNING food_type_id, TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from`;

        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบรายการราคาที่ต้องการลบ' };
        }

        return { success: true, message: 'ลบรายการราคาแล้ว', data: rows[0] };
    } catch (error) {
        console.error('Delete food type price error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
