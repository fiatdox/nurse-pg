import { Elysia, t } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { vendorMiddleware } from '../middlewares/vendorMiddleware';
import { vendorLogin, vendorProfile } from '../controllers/vendorAuthController';
import { vendorSummary, vendorDaily, vendorContracts } from '../controllers/vendorReportController';
import {
    vendorFoodSummary, vendorWardSummary, vendorTrayLabels, vendorWards,
} from '../controllers/vendorKitchenController';
import { getVendorMenuAccess } from '../controllers/menuAccessController';

const range = t.Object({
    date1: t.String(),
    date2: t.String(),
});

/**
 * เส้นทางสำหรับบริษัทผู้รับจ้างทำอาหาร
 *
 * แยก prefix ออกมาทั้งก้อนโดยตั้งใจ ไม่เอาไปแขวนใต้ /api/v1/nutrition
 * เพราะ route ของงานโภชนาการไม่มีตัวกรองตามบริษัท ถ้าเอาไปปนกัน
 * วันหนึ่งจะมีคนเผลอเพิ่ม endpoint ใหม่แล้วลืมใส่ตัวกรอง
 */
export const vendorRoutes = new Elysia({ prefix: '/api/v1/vendor' })
    .guard({ detail: { tags: ['Vendor'] } })

    // login ต้องอยู่นอก middleware เพราะยังไม่มี token ให้ตรวจ
    .use(jwt({
        name: 'jwt',
        secret: process.env.JWT_SECRET!,
        exp: '8h'
    }))
    .post('/login', vendorLogin, {
        body: t.Object({
            username: t.String({ minLength: 1, maxLength: 64 }),
            password: t.String({ minLength: 1, maxLength: 200 })
        }),
        detail: { summary: 'เข้าระบบสำหรับบริษัทผู้รับจ้างทำอาหาร', security: [] }
    })

    /*
      ทุก route ใต้บรรทัดนี้ต้องมี token ของบริษัท
      ลำดับสำคัญ Elysia ผูก hook กับ route ที่ลงทะเบียนหลังจากนี้เท่านั้น
      route ไหนที่เขียนไว้ข้างบนจะไม่ถูกป้องกัน เหมือนที่ /login ตั้งใจให้เป็น
    */
    .use(vendorMiddleware)
    .get('/me', vendorProfile, {
        detail: { summary: 'ข้อมูลบัญชีบริษัทที่กำลังเข้าระบบอยู่' }
    })
    /*
      เมนูที่ผู้ดูแลระบบเปิด/ปิดให้กลุ่มบริษัท
      แยก endpoint จากของเจ้าหน้าที่ เพราะ token คนละชนิดและคนละ middleware
      ตัวนี้ไม่รับพารามิเตอร์ว่าจะดูกลุ่มไหน บังคับเป็นกลุ่ม vendor เสมอ
    */
    .get('/menu-access', getVendorMenuAccess, {
        detail: { summary: 'เมนูที่กลุ่มบริษัทมองเห็น' }
    })
    .post('/summary', vendorSummary, {
        body: range,
        detail: { summary: 'ยอดที่โรงพยาบาลต้องจ่าย แยกตามประเภทอาหารและช่วงสัญญา' }
    })
    .post('/daily', vendorDaily, {
        body: range,
        detail: { summary: 'แจกแจงจำนวนมื้อรายวัน แยกตามประเภทและมื้อ' }
    })
    .get('/contracts', vendorContracts, {
        detail: { summary: 'ราคาตามสัญญาของประเภทอาหารที่บริษัทนี้รับผิดชอบ' }
    })

    /*
      ใบงานประจำวัน — นับยอดที่สั่ง ไม่ใช่ยอดที่รับแล้ว
      บริษัทต้องเตรียมของก่อนถึงเวลารับมอบ ถ้านับยอดที่รับแล้วใบงานจะว่างทุกวัน
    */
    .post('/food-summary', vendorFoodSummary, {
        body: t.Object({
            date1: t.String(),
            date2: t.String(),
            ward: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        detail: { summary: 'สรุปยอดอาหารตามช่วงวันที่ แยกตามหอ มื้อ และเมนู พร้อมรายการของเพิ่ม' }
    })
    .post('/ward-summary', vendorWardSummary, {
        body: range,
        detail: { summary: 'ยอดสั่งอาหารแยกตามหอผู้ป่วย x มื้อ x ประเภท ใช้เป็นใบส่งของ' }
    })
    .post('/tray-labels', vendorTrayLabels, {
        body: t.Object({
            date: t.String(),
            meal: t.Number(),
            ward: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        detail: { summary: 'ฉลากติดถาดอาหาร มีชื่อผู้ป่วยและเตียง ไม่มี HN/AN' }
    })
    .post('/wards', vendorWards, {
        body: range,
        detail: { summary: 'รายชื่อหอที่บริษัทนี้มีรายการส่งในช่วงวันที่ที่ระบุ' }
    });
