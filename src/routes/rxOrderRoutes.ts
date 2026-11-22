import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    lookupRxPatient, createRxOrder, listRxOrders, getRxOrder, getRxOrderFile,
    ackRxOrder, completeRxOrder, prepareRxOrder, setRxPickupSlot, pickupRxOrder, closeRxOrder, rejectRxOrder,
    resubmitRxOrder,
    listRxMissingHn, setRxOrderHn, editRxOrderHn, consultRxOrder,
} from '../controllers/rxOrderController';
import { readRxHn, listWardPatients } from '../controllers/rxHnReaderController';
import { getRxRetention } from '../controllers/rxRetentionController';
import { getRxDashboard } from '../controllers/rxDashboardController';
import { getRxInr, getRxRenal } from '../controllers/rxRenalController';
import {
    listRejectCategories, createRejectCategory, updateRejectCategory, reorderRejectCategories,
} from '../controllers/rxRejectCategoryController';

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

    .get('/ward-patients', listWardPatients, {
        query: t.Object({ ward: t.String() }),
        detail: { summary: 'ผู้ป่วยที่ส่งใบสั่งยาจากตึกนี้ได้ (นอนอยู่ หรือเพิ่งจำหน่ายจากตึกนี้) ให้เลือกแทนการพิมพ์ HN' },
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

    .get('/orders/:id/renal', getRxRenal, {
        detail: { summary: 'ค่าการทำงานของไตของผู้ป่วยในใบนี้ (Creatinine · eGFR CKD-EPI · CrCl Cockcroft-Gault) สูตรเดียวกับ DUE' },
    })

    .get('/orders/:id/inr', getRxInr, {
        detail: { summary: 'ผล INR ของผู้ป่วยในใบนี้ (lab_items_code 220 หรือตาม RX_INR_LAB_CODES)' },
    })

    .get('/orders/:id/files/:fileId', getRxOrderFile, {
        detail: { summary: 'เปิดดูไฟล์ใบสั่งยา (บันทึกลงประวัติทุกครั้งที่เปิด) · ไฟล์ที่ลบตามกำหนดแล้วได้ 410' },
    })

    .get('/dashboard', getRxDashboard, {
        query: t.Object({
            from: t.Optional(t.String()),
            to: t.Optional(t.String()),
            wards: t.Optional(t.String()),
            priorities: t.Optional(t.String()),
        }),
        detail: { summary: 'Dashboard ระบบส่งใบสั่งยา — ปริมาณงาน เวลาแต่ละขั้น ความทันเวลา รายหอ รายคน (เฉพาะผลรวม ไม่มีข้อมูลผู้ป่วย)' },
    })
    .get('/retention', getRxRetention, {
        query: t.Object({ days: t.Optional(t.String()) }),
        detail: { summary: 'จำนวนวันที่เก็บไฟล์ใบสั่งยา (ตั้งใน .env: RX_FILE_RETENTION_DAYS) และจำนวนไฟล์ที่จะถูกลบ (?days=N ดูล่วงหน้า)' },
    })

    .post('/orders/:id/ack', ackRxOrder, {
        detail: { summary: 'ห้องยากดรับ = จองงาน เครื่องที่กดทีหลังจะได้ 409' },
    })

    .post('/orders/:id/complete', completeRxOrder, {
        detail: { summary: 'คีย์ลง HIS เรียบร้อย ปิดงาน' },
    })

    .post('/orders/:id/prepare', prepareRxOrder, {
        detail: { summary: 'จัดยาเสร็จ พร้อมให้หอมารับ + กำหนดช่วงเวลารับยา 1 ชม. (body: { pickup_from: "YYYY-MM-DD HH:00" } หรือ null = ยังไม่เลือกรอบ)' },
    })

    .post('/orders/:id/pickup-slot', setRxPickupSlot, {
        detail: { summary: 'กำหนด/เปลี่ยน/ล้างรอบรับยาของใบที่จัดยาเสร็จแล้ว (body: { pickup_from: "YYYY-MM-DD HH:00" | null })' },
    })

    .post('/orders/:id/pickup', pickupRxOrder, {
        detail: { summary: 'ตึกมารับยาแล้ว (หอหรือห้องยากด) ปิดการส่งมอบ ใบออกจากคิว · ใบที่มีรอบกดก่อนรอบเริ่มได้ 409 BEFORE_SLOT' },
    })

    .post('/orders/:id/resubmit', resubmitRxOrder, {
        body: t.Object({
            priority: t.String(),
            tube_feed: t.Optional(t.Boolean()),
            note: t.Optional(t.String({ maxLength: 300 })),
        }),
        detail: { summary: 'หอแก้ประเภท (ความเร่งด่วน / NG-Tube) ของใบที่ถูกส่งกลับ แล้วส่งเป็นใบใหม่ด้วยไฟล์เดิม เริ่มนับเวลาใหม่' },
    })

    .post('/orders/:id/close', closeRxOrder, {
        detail: { summary: 'ปิดเรื่องใบที่ส่งกลับ ให้ออกจากคิวของทั้งสองฝั่ง' },
    })

    .get('/reject-categories', listRejectCategories, {
        query: t.Object({ all: t.Optional(t.String()) }),
        detail: { summary: 'กลุ่มเหตุผลส่งกลับ (เฉพาะที่เปิดใช้ · all=1 รวมที่ปิด พร้อมจำนวนใบที่ใช้)' },
    })
    .post('/reject-categories', createRejectCategory, {
        body: t.Object({ label: t.String(), require_note: t.Optional(t.Boolean()) }),
        detail: { summary: 'เพิ่มกลุ่มเหตุผลส่งกลับ (กลุ่มงานเภสัชกรรม/แอดมิน)' },
    })
    .post('/reject-categories/reorder', reorderRejectCategories, {
        body: t.Object({ codes: t.Array(t.String()) }),
        detail: { summary: 'เรียงลำดับกลุ่มเหตุผลส่งกลับใหม่ทั้งชุด' },
    })
    .patch('/reject-categories/:code', updateRejectCategory, {
        body: t.Object({ label: t.Optional(t.String()), active: t.Optional(t.Boolean()), require_note: t.Optional(t.Boolean()) }),
        detail: { summary: 'แก้ชื่อ / เปิด-ปิด / บังคับพิมพ์รายละเอียด ของกลุ่มเหตุผลส่งกลับ' },
    })

    .post('/orders/:id/reject', rejectRxOrder, {
        body: t.Object({ category: t.String(), reason: t.Optional(t.String()) }),
        detail: { summary: 'ส่งใบกลับให้หอแก้ไข · category = รหัสกลุ่มเหตุผล (GET /reject-categories) · reason = ข้อความเพิ่มเติม (บังคับเมื่อกลุ่มตั้ง require_note)' },
    })

    .post('/orders/:id/edit-hn', editRxOrderHn, {
        body: t.Object({ hn: t.String(), note: t.String() }),
        detail: { summary: 'หอแก้ HN ของใบที่ส่งแล้ว (ต้องมีหมายเหตุ · ห้องยาได้รับแจ้งเตือนทันที)' },
    })

    .post('/orders/:id/consult', consultRxOrder, {
        body: t.Object({ note: t.String({ maxLength: 1000 }), consulted_at: t.Optional(t.String()) }),
        detail: { summary: 'บันทึกว่าโทรปรึกษาแพทย์แล้ว (เวลา + ข้อความ) หอและห้องยาเห็นร่วมกัน · แจ้งอีกฝั่งทันที' },
    })

    .get('/admin/missing-hn', listRxMissingHn, {
        detail: { summary: 'แอดมิน: ใบที่ส่งมาโดยไม่มี HN พร้อมรายการไฟล์' },
    })

    .post('/orders/:id/hn', setRxOrderHn, {
        body: t.Object({ hn: t.String(), note: t.Optional(t.String()) }),
        detail: { summary: 'แอดมิน: ใส่ HN ให้ใบที่ไม่มี HN (ต้องยืนยันกับ HIS ได้ · แก้ HN ที่มีอยู่แล้วไม่ได้)' },
    });
