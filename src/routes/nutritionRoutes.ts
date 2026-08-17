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
    getDailyFoodSummary,
    receiveFoodOrders
} from '../controllers/nutritionController';

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
    .post('/receive-orders', receiveFoodOrders, {
        body: t.Object({
            ward: t.String(),
            date: t.String(),
            meal: t.Number(),
            undo: t.Optional(t.Boolean())
        }),
        detail: { summary: 'งานโภชนาการรับรายการอาหารรายหอผู้ป่วยต่อมื้อ (undo = ถอนการรับ)' }
    })
