import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { isNutritionStaff } from './nutritionController';

/**
 * จัดการรายการเมนูอาหาร (ตาราง food_items)
 *
 * แยกไฟล์จาก nutritionController เพราะไฟล์นั้นดูแลรายการสั่งอาหารรายวัน
 * ส่วนนี้ดูแลทะเบียนเมนูซึ่งเปลี่ยนไม่บ่อยและมีคนใช้คนละกลุ่ม
 */

/**
 * ประเภทห้องที่เมนูหนึ่งชื่อจะถูกสร้างขึ้นได้
 *
 * ครัวคิดต้นทุนและจัดถาดแยกตามประเภทห้อง เมนูชื่อเดียวกันจึงต้องมีคนละแถว
 * ประเภทถูกเก็บเป็นรหัสใน food_items.food_type_id (อ้าง food_types)
 * ส่วนวงเล็บท้ายชื่อเหลือไว้เพื่อการอ่านบนฉลากและใบส่งครัวเท่านั้น ไม่ใช่แหล่งความจริง
 */
const FOOD_CLASSES = ['สามัญ', 'พิเศษ', 'VIP'] as const;
type FoodClass = typeof FOOD_CLASSES[number];

/**
 * รหัสประเภทของชื่อที่ผู้ใช้ติ๊ก
 *
 * อ่านจากตารางทุกครั้งแทนการฝังรหัสไว้ในโค้ด เพราะถ้าวันหนึ่งมีคนแก้ชื่อประเภท
 * หรือเพิ่มประเภทใหม่ ตารางจะเป็นคนบอก ไม่ต้องตามแก้สองที่ให้ตรงกัน
 */
const resolveClassIds = async (classes: readonly FoodClass[]) => {
    const rows = await nurse<{ food_type_id: number, food_type_name: string }[]>`
        SELECT food_type_id, food_type_name FROM food_types
        WHERE food_type_name = ANY(${classes as unknown as string[]})`;
    return new Map(rows.map(r => [r.food_type_name, r.food_type_id]));
};

/** ตัดวงเล็บประเภทที่ผู้ใช้พิมพ์ติดมาท้ายชื่อออก จะได้ไม่กลายเป็น 'ธรรมดา (สามัญ) (พิเศษ)' */
const stripClassSuffix = (name: string) =>
    name.replace(/\s*\(\s*(สามัญ|พิเศษ|VIP)\s*\)\s*$/i, '').trim();

/** เทียบชื่อซ้ำแบบตัดช่องว่างและไม่สนตัวพิมพ์ ให้ตรงกับกติกาของ uq_food_items_name_norm */
const normalizeName = (name: string) => name.replace(/\s+/g, '').toLowerCase();

// รายการเมนูทั้งหมดสำหรับหน้าจัดการ รวมเมนูที่ปิดใช้งานแล้ว ต่างจาก /menu ที่ส่งเฉพาะที่เปิดอยู่
export const listFoodItems = async ({ set, user }: { set: any, user?: unknown }) => {
    const { ok } = await isNutritionStaff(user);
    if (!ok) {
        set.status = 403;
        return { success: false, message: 'เฉพาะเจ้าหน้าที่งานโภชนาการเท่านั้นที่จัดการรายการเมนูได้' };
    }

    try {
        /*
          นับยอดการสั่งมาด้วย เพราะคนใช้ต้องรู้ก่อนกดปิดเมนูว่ามีคนสั่งอยู่จริงไหม
          และเป็นเหตุผลว่าทำไมถึงไม่มีปุ่มลบ — food_orders ย้อนหลังอ้างถึง food_item_id นี้อยู่
        */
        const rows = await nurse`
            SELECT
                 fi.food_item_id
                ,fi.food_name
                ,fi.food_type_id
                ,ft.food_type_name
                ,fi.is_active
                ,fi.created_at
                ,fi.created_by_name
                ,fi.updated_at
                ,fi.updated_by_name
                ,COALESCE(u.order_count, 0)::int AS order_count
            FROM food_items fi
            LEFT JOIN food_types ft ON ft.food_type_id = fi.food_type_id
            LEFT JOIN (
                SELECT food_item_id, count(*)::int AS order_count
                FROM food_orders
                WHERE cancelled_at IS NULL
                GROUP BY food_item_id
            ) u ON u.food_item_id = fi.food_item_id
            ORDER BY fi.food_name`;

        return {
            success: true,
            data: rows.map(r => ({
                ...r,
                food_name: sanitizeHTML(r.food_name),
                food_type_name: sanitizeHTML(r.food_type_name),
                created_by_name: sanitizeHTML(r.created_by_name),
                updated_by_name: sanitizeHTML(r.updated_by_name),
                is_active: r.is_active === 'Y',
            })),
        };
    } catch (error) {
        console.error('List food items error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * เพิ่มเมนูอาหาร หนึ่งชื่อได้หลายประเภทห้องในครั้งเดียว
 *
 * ติ๊กครบสามช่องแล้วกดบันทึกจะได้สามแถว คือ (สามัญ) (พิเศษ) (VIP)
 * ประเภทที่มีอยู่แล้วจะถูกข้าม ไม่ทำให้ทั้งชุดล้มเหลว เพราะกรณีที่เจอบ่อยคือ
 * เคยเพิ่มไว้แค่สามัญ แล้วมาเพิ่มพิเศษกับ VIP ทีหลังโดยติ๊กครบทั้งสามช่อง
 */
export const createFoodItems = async (
    { body, set, user }: { body: { food_name: string, classes: string[] }, set: any, user?: unknown }
) => {
    const { ok, actor } = await isNutritionStaff(user);
    if (!ok) {
        set.status = 403;
        return { success: false, message: 'เฉพาะเจ้าหน้าที่งานโภชนาการเท่านั้นที่เพิ่มเมนูได้' };
    }

    // ล้าง HTML ก่อนเทียบซ้ำและก่อนบันทึก ชื่อนี้ถูกเอาไปแสดงบนฉลากติดถาดและหน้าสั่งอาหาร
    const baseName = stripClassSuffix(String(sanitizeHTML(String(body?.food_name ?? '')) ?? '').trim());

    if (!baseName) {
        set.status = 400;
        return { success: false, message: 'กรุณากรอกชื่ออาหาร' };
    }
    if (baseName.length > 100) {
        set.status = 400;
        return { success: false, message: 'ชื่ออาหารยาวเกินไป (ไม่เกิน 100 ตัวอักษร)' };
    }

    const picked = new Set(
        (Array.isArray(body?.classes) ? body.classes : []).map(c => String(c).trim())
    );
    // เรียงตามลำดับมาตรฐาน ไม่ใช่ตามที่หน้าจอส่งมา ผลลัพธ์จะได้อ่านง่ายเหมือนกันทุกครั้ง
    const ordered: FoodClass[] = FOOD_CLASSES.filter(c => picked.has(c));

    if (ordered.length === 0) {
        set.status = 400;
        return { success: false, message: 'กรุณาเลือกประเภทอย่างน้อยหนึ่งประเภท (สามัญ / พิเศษ / VIP)' };
    }

    const names = ordered.map(c => `${baseName} (${c})`);

    try {
        const existing = await nurse<{ food_name: string }[]>`
            SELECT food_name FROM food_items
            WHERE lower(regexp_replace(food_name, '[[:space:]]+', '', 'g'))
                  = ANY(${names.map(normalizeName)})`;
        const taken = new Set(existing.map(r => normalizeName(r.food_name)));

        const skipped = ordered.filter(c => taken.has(normalizeName(`${baseName} (${c})`)));
        const toInsert = ordered
            .map(cls => ({ cls, food_name: `${baseName} (${cls})` }))
            .filter(x => !taken.has(normalizeName(x.food_name)));

        if (toInsert.length === 0) {
            set.status = 409;
            return {
                success: false,
                message: `มีเมนู "${baseName}" อยู่แล้วทุกประเภทที่เลือก (${ordered.join(', ')})`,
            };
        }

        const classIds = await resolveClassIds(toInsert.map(x => x.cls));
        const missing = toInsert.filter(x => !classIds.has(x.cls)).map(x => x.cls);
        if (missing.length > 0) {
            // ทะเบียนประเภทหาย แปลว่ายังไม่ได้รัน migration ไม่ควรบันทึกเมนูที่ไม่มีประเภท
            set.status = 500;
            return { success: false, message: `ไม่พบประเภทอาหาร ${missing.join(', ')} ในทะเบียน กรุณาแจ้งผู้ดูแลระบบ` };
        }

        const actorId = actor?.userId ? Number(actor.userId) : null;
        const values = toInsert.map(x => ({
            food_name: x.food_name,
            food_type_id: classIds.get(x.cls)!,
            is_active: 'Y',
            created_at: new Date(),
            created_by: actorId,
            created_by_name: actor?.fullname ?? null,
        }));

        const inserted = await nurse<{ food_item_id: number, food_name: string, food_type_id: number }[]>`
            INSERT INTO food_items ${nurse(values, 'food_name', 'food_type_id', 'is_active', 'created_at', 'created_by', 'created_by_name')}
            RETURNING food_item_id, food_name, food_type_id`;

        return {
            success: true,
            message: skipped.length
                ? `เพิ่มเมนูแล้ว ${inserted.length} รายการ (ข้าม ${skipped.join(', ')} เพราะมีอยู่แล้ว)`
                : `เพิ่มเมนูแล้ว ${inserted.length} รายการ`,
            data: { created: inserted, skipped },
        };
    } catch (error) {
        console.error('Create food items error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * เปิด/ปิดการใช้งานเมนู
 *
 * ไม่มีการลบแถว เพราะรายการสั่งอาหารย้อนหลังชี้มาที่ food_item_id นี้
 * ถ้าลบทิ้ง ใบสรุปและฉลากของวันเก่าจะแสดงชื่ออาหารไม่ได้
 */
export const setFoodItemActive = async (
    { body, set, user }: { body: { food_item_id: number, is_active: boolean }, set: any, user?: unknown }
) => {
    const { ok, actor } = await isNutritionStaff(user);
    if (!ok) {
        set.status = 403;
        return { success: false, message: 'เฉพาะเจ้าหน้าที่งานโภชนาการเท่านั้นที่แก้ไขเมนูได้' };
    }

    const id = Number(body?.food_item_id);
    if (!Number.isInteger(id) || id <= 0) {
        set.status = 400;
        return { success: false, message: 'ไม่พบรายการเมนูที่ต้องการแก้ไข' };
    }

    try {
        const rows = await nurse`
            UPDATE food_items
            SET is_active       = ${body?.is_active ? 'Y' : null}
               ,updated_at      = NOW()
               ,updated_by      = ${actor?.userId ? Number(actor.userId) : null}
               ,updated_by_name = ${actor?.fullname ?? null}
            WHERE food_item_id = ${id}
            RETURNING food_item_id, food_name, is_active`;

        if (rows.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบรายการเมนูที่ต้องการแก้ไข' };
        }

        return {
            success: true,
            message: body?.is_active ? 'เปิดใช้งานเมนูแล้ว' : 'ปิดใช้งานเมนูแล้ว',
            data: { ...rows[0], is_active: rows[0]!.is_active === 'Y' },
        };
    } catch (error) {
        console.error('Set food item active error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
