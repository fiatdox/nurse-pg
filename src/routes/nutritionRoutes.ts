import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getNutritionMenu,
    getMeals,
    orderMenu,
    getFoodOrdersByWard,
    getFoodOrdersAddonByWard,
    updateFoodOrderAddon,
    cancelOrderMenu,
    getFoodOrderHistoryByAN,
    getNutritionAccess,
    getFoodTypeDashboard,
    getTrayLabels,
    getDailyFoodSummary,
    getDailyTypeSummary,
    receiveFoodOrders,
    approveFoodOrders
} from '../controllers/nutritionController';
import {
    listFoodItems,
    createFoodItems,
    setFoodItemActive
} from '../controllers/foodItemController';
import {
    getFoodTypePrices,
    setFoodTypePrice,
    deleteFoodTypePrice
} from '../controllers/foodPriceController';
import { getFoodPaymentSummary, getFoodPivotData } from '../controllers/foodPaymentController';

export const nutritionRoutes = new Elysia({ prefix: '/api/v1/nutrition' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Nutrition'] } })
    .get('/menu', getNutritionMenu)
    .get('/meals', getMeals)
    .post('/order-menu', orderMenu, {
        body: t.Array(t.Object({
            admission_list_id: t.Number(),
            an: t.String(),
            ward: t.String(),
            order_date: t.String(),
            meal: t.Number(),
            food_item_id: t.Number(),
            request_by: t.String(),
            addon: t.Optional(t.Union([t.String(), t.Null()]))
        }))
    })
    .post('/food-orders-by-ward', getFoodOrdersByWard, {
        body: t.Object({
            ward: t.String(),
            date: t.String()
        })
    })
    .post('/food-orders-addon-by-ward', getFoodOrdersAddonByWard, {
        body: t.Object({
            ward: t.String(),
            date: t.String(),
            meal: t.Number()
        })
    })
    .patch('/update-food-orders-addon', updateFoodOrderAddon, {
        body: t.Object({
            ward: t.String(),
            date: t.String(),
            meal: t.Number(),
            orders: t.Array(t.Object({
                food_order_id: t.Number(),
                addon: t.Optional(t.Union([t.String(), t.Null()]))
            }))
        })
    })
    .post('/food-order-history', getFoodOrderHistoryByAN, {
        body: t.Object({
            an: t.String(),
            days: t.Optional(t.Number())
        }),
        detail: { summary: 'ประวัติการสั่งอาหารรายผู้ป่วย ย้อนหลังตามจำนวนวันที่ระบุ (ค่าเริ่มต้น 7 วัน)' }
    })
    .post('/cancel-order-menu', cancelOrderMenu, {
        body: t.Array(t.Object({
            food_order_id: t.Number(),
            reason: t.Optional(t.Union([t.String(), t.Null()]))
        })),
        detail: { summary: 'ยกเลิกรายการสั่งอาหาร (ทำเครื่องหมาย ไม่ลบแถว เก็บชื่อผู้ยกเลิกและเหตุผลไว้)' }
    })
    .get('/access', getNutritionAccess, {
        detail: { summary: 'สิทธิ์งานโภชนาการของผู้ใช้ที่ล็อกอินอยู่ ใช้ตัดสินว่าจะแสดงเมนูไหม' }
    })
    .post('/daily-summary', getDailyFoodSummary, {
        body: t.Object({ date: t.String() }),
        detail: { summary: 'สรุปรายการอาหารประจำวัน แยกตามมื้อ หอผู้ป่วย และเมนู' }
    })
    .post('/daily-type-summary', getDailyTypeSummary, {
        body: t.Object({ date: t.String() }),
        detail: { summary: 'สรุปยอดการสั่งอาหารประจำวัน แยกตามหอผู้ป่วย มื้อ และประเภทห้อง (สามัญ / พิเศษ / VIP)' }
    })
    .post('/food-type-dashboard', getFoodTypeDashboard, {
        body: t.Object({ date1: t.String(), date2: t.String() }),
        detail: { summary: 'สรุปยอดอาหารตามประเภทห้อง ชนิดอาหาร มื้อ วัน และหอผู้ป่วย สำหรับแดชบอร์ดงานโภชนาการ' }
    })
    .post('/tray-labels', getTrayLabels, {
        body: t.Object({
            date: t.String(),
            meal: t.Number(),
            ward: t.Optional(t.Union([t.String(), t.Null()]))
        }),
        detail: { summary: 'รายการสำหรับพิมพ์ฉลากติดถาดอาหาร เรียงตามหอผู้ป่วยและเตียง' }
    })
    .post('/approve-orders', approveFoodOrders, {
        body: t.Object({
            ward: t.String(),
            date: t.String(),
            meal: t.Number(),
            undo: t.Optional(t.Boolean())
        }),
        detail: { summary: 'อนุมัติรายการอาหารให้ส่งต่อบริษัทผู้รับจ้าง รายหอต่อมื้อ (undo = ถอนการอนุมัติ)' }
    })
    .post('/receive-orders', receiveFoodOrders, {
        body: t.Object({
            ward: t.String(),
            date: t.String(),
            meal: t.Number(),
            undo: t.Optional(t.Boolean())
        }),
        detail: { summary: 'งานโภชนาการรับรายการอาหารรายหอผู้ป่วยต่อมื้อ (undo = ถอนการรับ)' }
    })
    .get('/food-items', listFoodItems, {
        detail: { summary: 'ทะเบียนเมนูอาหารทั้งหมด รวมที่ปิดใช้งานแล้ว พร้อมยอดการสั่ง' }
    })
    .post('/food-items', createFoodItems, {
        body: t.Object({
            food_name: t.String(),
            classes: t.Array(t.String(), { minItems: 1 })
        }),
        detail: { summary: 'เพิ่มเมนูอาหาร สร้างหนึ่งแถวต่อหนึ่งประเภทห้องที่เลือก (สามัญ / พิเศษ / VIP)' }
    })
    .post('/food-payment', getFoodPaymentSummary, {
        body: t.Object({ date1: t.String(), date2: t.String() }),
        detail: { summary: 'ยอดเงินที่ต้องจ่ายบริษัทผู้รับจ้างทำอาหาร ตามช่วงวันที่และราคาตามสัญญา' }
    })
    .post('/food-pivot', getFoodPivotData, {
        body: t.Object({ date1: t.String(), date2: t.String() }),
        detail: { summary: 'ข้อมูลดิบสำหรับตารางไขว้ หอผู้ป่วย × มื้อ × ประเภท × วัน (นับเป็นจำนวนมื้อ)' }
    })
    .post('/food-type-prices', getFoodTypePrices, {
        body: t.Optional(t.Object({ as_of: t.Optional(t.String()) })),
        detail: { summary: 'ราคาอาหารตามประเภทห้อง ณ วันที่อ้างอิง พร้อมประวัติราคาทั้งหมด' }
    })
    .put('/food-type-prices', setFoodTypePrice, {
        body: t.Object({
            food_type_price_id: t.Optional(t.Union([t.Number(), t.Null()])),
            food_type_id: t.Number(),
            price_per_day: t.Number(),
            effective_from: t.String(),
            effective_to: t.Optional(t.Union([t.String(), t.Null()])),
            meals_per_day: t.Optional(t.Number()),
            contract_note: t.Optional(t.Union([t.String(), t.Null()])),
            vendor_id: t.Optional(t.Union([t.Number(), t.Null()]))
        }),
        detail: { summary: 'เพิ่มหรือแก้ไขสัญญาราคาอาหาร ส่ง food_type_price_id = แก้ไขฉบับนั้น (เฉพาะผู้ดูแลระบบ)' }
    })
    .delete('/food-type-prices', deleteFoodTypePrice, {
        body: t.Object({ food_type_price_id: t.Number() }),
        detail: { summary: 'ลบรายการราคาออกจากประวัติ ใช้แก้กรณีบันทึกผิด (เฉพาะผู้ดูแลระบบ)' }
    })
    .patch('/food-items/active', setFoodItemActive, {
        body: t.Object({
            food_item_id: t.Number(),
            is_active: t.Boolean()
        }),
        detail: { summary: 'เปิด/ปิดการใช้งานเมนูอาหาร (ไม่ลบแถว เพราะรายการสั่งย้อนหลังอ้างถึงอยู่)' }
    })
