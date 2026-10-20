import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    lookupRxPatient, createRxOrder, listRxOrders, getRxOrder, getRxOrderFile,
    ackRxOrder, completeRxOrder, prepareRxOrder, pickupRxOrder, closeRxOrder, rejectRxOrder,
} from '../controllers/rxOrderController';
import { readRxHn } from '../controllers/rxHnReaderController';
import { getRxRetention, setRxRetention } from '../controllers/rxRetentionController';

/**
 * ใบสั่งยาจากหอผู้ป่วยถึงห้องยา
 *
 * ใช้ authMiddleware ตัวเดียวกับระบบพยาบาล ไม่มีบัญชีแยก
 * เพราะคนที่ส่งใบสั่งยาคือพยาบาลที่มีบัญชีอยู่แล้ว การสร้างบัญชีชุดที่สอง
 * แปลว่าต้องมีคนคอยปิดบัญชีสองที่ตอนคนลาออก ซึ่งจะมีที่หนึ่งถูกลืมเสมอ
 */
export const rxOrderRoutes = new Elysia({ prefix: '/api/v1/rx' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Rx Order (ใบสั่งยา หอ → ห้องยา)'] } })

    .get('/patient-lookup', lookupRxPatient, {
        query: t.Object({ hn: t.String(), ward: t.Optional(t.String()) }),
        detail: { summary: 'ค้นชื่อผู้ป่วยจาก HN เพื่อยืนยันก่อนส่งใบสั่งยา' },
    })

    .post('/read-hn', readRxHn, {
        /*
          อ่านอย่างเดียว ไม่เก็บภาพและไม่สร้างใบ จึงไม่ต้องจำกัดจำนวนไฟล์เหมือน /orders
          รับทีละภาพ เพราะหน้าจอแปลงหน้าแรกของเอกสารมาให้แล้ว
        */
        body: t.Object({
            file: t.Optional(t.File({ type: ['image/jpeg', 'image/png'], maxSize: '12m' })),
            candidates: t.Optional(t.String()),
            source: t.Optional(t.String()),
            /* หอที่กำลังส่งใบ ใช้เรียงให้คนที่นอนอยู่หอนี้ขึ้นก่อน ไม่ได้ใช้กรองทิ้ง */
            ward: t.Optional(t.String()),
        }),
        detail: { summary: 'อ่านเลข HN จากภาพใบสั่งยาแล้วยืนยันกับ HIS (ไม่บันทึกอะไร)' },
    })

    .post('/orders', createRxOrder, {
        /*
          ตรวจชนิดและขนาดไฟล์ที่ชั้นนี้ด้วย ไม่ใช่เฉพาะในคอนโทรลเลอร์
          ของใหญ่เกินขนาดจะถูกปัดตกก่อนถูกอ่านเข้าหน่วยความจำ
        */
        body: t.Object({
            ward: t.Union([t.String(), t.Number()]),
            hn: t.Optional(t.String()),
            an: t.Optional(t.String()),
            patient_name: t.Optional(t.String()),
            hn_source: t.Optional(t.String()),
            priority: t.Optional(t.String()),
            note: t.Optional(t.String()),
            /* เลขใบเดิมที่ถูกส่งกลับ ส่งมาเมื่อหอกด "ส่งอีกครั้ง" เซิร์ฟเวอร์ตรวจเองว่าใบนั้นเป็นของหอนี้จริง */
            resend_of: t.Optional(t.String()),
            /* 'true' = ผู้ป่วยได้รับอาหารทางสายยาง ห้องยาต้องเตรียมยาให้ใช้ทางสายได้ */
            tube_feed: t.Optional(t.String()),
            files: t.Union([
                t.File({ type: ['application/pdf', 'image/jpeg', 'image/png'], maxSize: '20m' }),
                t.Files({ type: ['application/pdf', 'image/jpeg', 'image/png'], maxSize: '20m' }),
            ]),
        }),
        detail: { summary: 'หอผู้ป่วยส่งใบสั่งยาที่สแกนแล้วให้ห้องยา' },
    })

    .get('/orders', listRxOrders, {
        query: t.Object({
            ward: t.Optional(t.String()),
            /* หลายตึกคั่นด้วยจุลภาค เช่น wards=1,3,7 — ห้องยาแบ่งกันรับตามตึก */
            wards: t.Optional(t.String()),
            status: t.Optional(t.String()),
            date: t.Optional(t.String()),
            /* ช่วงเวลาแบบละเอียด ใช้ดูย้อนหลังทีละเวร รูปแบบ YYYY-MM-DD HH:mm ตามเวลาท้องถิ่น */
            from: t.Optional(t.String()),
            to: t.Optional(t.String()),
            /* ค้นด้วย HN เมื่อส่งมา ตัวกรองวันและเวรถูกข้ามทั้งหมด เพราะใบที่ตามหามักอยู่คนละเวร */
            hn: t.Optional(t.String()),
            /* ความด่วนที่เครื่องนี้รับ คั่นด้วยจุลภาค เช่น priorities=stat — เครื่องแยกกันรับงานได้ */
            priorities: t.Optional(t.String()),
        }),
        detail: { summary: 'รายการใบสั่งยา ไม่ระบุหอ = เห็นทุกหอ (มุมมองห้องยา)' },
    })

    .get('/orders/:id', getRxOrder, {
        detail: { summary: 'รายละเอียดใบสั่งยา พร้อมรายการไฟล์และประวัติการดำเนินการ' },
    })

    .get('/orders/:id/files/:fileId', getRxOrderFile, {
        detail: { summary: 'เปิดดูไฟล์ใบสั่งยา (บันทึกลงประวัติทุกครั้งที่เปิด) · ไฟล์ที่ลบตามกำหนดแล้วได้ 410' },
    })

    .get('/retention', getRxRetention, {
        query: t.Object({ days: t.Optional(t.String()) }),
        detail: { summary: 'จำนวนวันที่เก็บไฟล์ใบสั่งยา และจำนวนไฟล์ที่จะถูกลบ (?days=N ดูล่วงหน้า)' },
    })
    .put('/retention', setRxRetention, {
        body: t.Object({ days: t.Number() }),
        detail: { summary: 'ตั้งจำนวนวันเก็บไฟล์ใบสั่งยา (เฉพาะผู้ดูแลระบบ)' },
    })

    .post('/orders/:id/ack', ackRxOrder, {
        detail: { summary: 'ห้องยากดรับ = จองงาน เครื่องที่กดทีหลังจะได้ 409' },
    })

    .post('/orders/:id/complete', completeRxOrder, {
        detail: { summary: 'คีย์ลง HIS เรียบร้อย ปิดงาน' },
    })

    .post('/orders/:id/prepare', prepareRxOrder, {
        detail: { summary: 'จัดยาเสร็จ พร้อมให้หอมารับ (กดได้ทั้งก่อนและหลังคีย์ลง HIS)' },
    })

    .post('/orders/:id/pickup', pickupRxOrder, {
        detail: { summary: 'ตึกมารับยาแล้ว ปิดการส่งมอบ ใบออกจากคิว' },
    })

    .post('/orders/:id/close', closeRxOrder, {
        detail: { summary: 'ปิดเรื่องใบที่ส่งกลับ ให้ออกจากคิวของทั้งสองฝั่ง' },
    })

    .post('/orders/:id/reject', rejectRxOrder, {
        body: t.Object({ reason: t.String() }),
        detail: { summary: 'ส่งใบกลับให้หอแก้ไข ต้องระบุเหตุผล' },
    });
