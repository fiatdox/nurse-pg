import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getAdmitRecordByAN,
    saveAdmitRecord,
} from '../controllers/nursingRecordsController';
import {
    getPainRecordsByAN,
    savePainRecord,
    deletePainRecord,
} from '../controllers/painController';
import {
    getVitalRecordsByAN,
    saveVitalRecord,
    deleteVitalRecord,
} from '../controllers/vitalSignsController';
import {
    getProgressNotesByAN,
    saveProgressNote,
    updateProgressNote,
    deleteProgressNote,
    getProgressNoteRevisions,
    approveProgressNote,
    getPendingApprovals,
    getNursingTerminology,
} from '../controllers/progressNoteController';
import {
    getCarePlansByAN,
    getCarePlansByWard,
    saveCarePlan,
    updateCarePlan,
    deleteCarePlan,
} from '../controllers/carePlanController';
import { suggestCarePlan, getSuggestionStatus } from '../controllers/carePlanAssistController';
import {
    getFocusRecordsByAN,
    getFocusRecordsByWard,
    saveFocusRecord,
    updateFocusRecord,
    completeFocusRecord,
    deleteFocusRecord,
    getFocusRecordRevisions,
    getFocusIndicators,
} from '../controllers/focusRecordController';

export const nursingRecordsRoutes = new Elysia({ prefix: '/api/v1/nursing-records' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Nursing Records'] } })

    .get('/admit/:an', getAdmitRecordByAN, {
        params: t.Object({ an: t.String() }),
        detail: { summary: 'ดึงบันทึกแรกรับผู้ป่วย (admit record) ตาม AN' },
    })
    // รับฟิลด์เพิ่มได้ตามฟอร์ม แต่ controller จะคัดเฉพาะคอลัมน์ที่มีจริงในตาราง
    .post('/admit', saveAdmitRecord, {
        body: t.Object(
            {
                an: t.String(),
                ward_code: t.String(),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'บันทึก/แก้ไขบันทึกแรกรับผู้ป่วย (หนึ่ง AN ต่อหนึ่งใบ)' },
    })

    // ---------- สัญญาณชีพ (Vital Signs) ----------
    .get('/vital/:an', getVitalRecordsByAN, {
        params: t.Object({ an: t.String() }),
        query: t.Object({ limit: t.Optional(t.String()) }),
        detail: { summary: 'ดึงสัญญาณชีพตาม AN พร้อมกลุ่มอายุสำหรับช่วงค่าปกติ (ใหม่สุดก่อน)' },
    })
    // หนึ่ง AN มีได้หลายครั้ง ทุกครั้งที่วัดคือแถวใหม่เพื่อให้เห็นแนวโน้ม
    // ไม่รับ nurse_name จาก client — ผู้บันทึกมาจากบัญชีที่เข้าสู่ระบบเท่านั้น
    .post('/vital', saveVitalRecord, {
        body: t.Object(
            {
                an: t.String(),
                ward_code: t.String(),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'บันทึกสัญญาณชีพ (ผู้บันทึกจาก token, คำนวณ MAP / PP / NEWS2 อัตโนมัติ)' },
    })
    .delete('/vital/:id', deleteVitalRecord, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ลบสัญญาณชีพ (soft delete)' },
    })

    // ---------- แบบประเมินความปวด ----------
    .get('/pain/:an', getPainRecordsByAN, {
        params: t.Object({ an: t.String() }),
        query: t.Object({ limit: t.Optional(t.String()) }),
        detail: { summary: 'ดึงประวัติการประเมินความปวดตาม AN (ใหม่สุดก่อน)' },
    })
    // หนึ่ง AN มีได้หลายครั้ง ทุกครั้งที่บันทึกคือแถวใหม่เพื่อให้เห็นแนวโน้ม
    .post('/pain', savePainRecord, {
        body: t.Object(
            {
                an: t.String(),
                ward_code: t.String(),
                nurse_name: t.String(),
                pain_score: t.Number(),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'บันทึกการประเมินความปวด' },
    })
    .delete('/pain/:id', deletePainRecord, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ลบการประเมินความปวด (soft delete)' },
    })

    // ---------- บันทึกทางการพยาบาล (Progress Notes) ----------
    .get('/nursing/:an', getProgressNotesByAN, {
        params: t.Object({ an: t.String() }),
        query: t.Object({
            limit: t.Optional(t.String()),
            // status=approved สำหรับออกเวชระเบียน ร่างจะไม่ติดไปด้วย
            status: t.Optional(t.String()),
        }),
        detail: { summary: 'ดึงบันทึกทางการพยาบาลตาม AN (ใหม่สุดก่อน · status=approved เพื่อตัดร่างออก)' },
    })
    // ไม่รับ nurse_name จาก client — ผู้บันทึกมาจากบัญชีที่เข้าสู่ระบบเท่านั้น
    .post('/nursing', saveProgressNote, {
        body: t.Object(
            {
                an: t.String(),
                ward_code: t.String(),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'บันทึกทางการพยาบาล (DAR / FOCUS / SOAP / SOAPIE / PIE)' },
    })
    // แก้ร่างไม่ต้องมีเหตุผล แต่แก้บันทึกที่อนุมัติแล้วต้องมีเสมอ — controller เป็นคนตัดสิน
    // จึงประกาศเป็น optional ตรงนี้ ไม่งั้นจะถูกปฏิเสธเป็น 422 ก่อนถึง controller
    .put('/nursing/:id', updateProgressNote, {
        params: t.Object({ id: t.String() }),
        body: t.Object(
            { amend_reason: t.Optional(t.String()) },
            { additionalProperties: true }
        ),
        detail: { summary: 'แก้ไขบันทึก (ร่างแก้ได้เลย · ที่อนุมัติแล้วต้องระบุเหตุผลและเก็บฉบับเดิม)' },
    })
    .delete('/nursing/:id', deleteProgressNote, {
        params: t.Object({ id: t.String() }),
        query: t.Object({ reason: t.Optional(t.String()) }),
        detail: { summary: 'ยกเลิกบันทึกทางการพยาบาล (ต้องระบุเหตุผล เก็บแถวไว้เสมอ)' },
    })
    // ใช้ path ขึ้นต้นด้วยคำคงที่ ไม่ใช่ /nursing/:id/... เพราะ router ของ Elysia
    // ไม่ยอมให้ตำแหน่งเดียวกันมีชื่อพารามิเตอร์ต่างกัน (ชนกับ GET /nursing/:an)
    .get('/nursing-revisions/:id', getProgressNoteRevisions, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ประวัติการแก้ไขของบันทึกหนึ่งฉบับ' },
    })
    // ผู้อนุมัติมาจาก token ไม่รับจาก body — ลายเซ็นต้องเป็นของคนที่เซ็นจริง
    .post('/nursing-approve/:id', approveProgressNote, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'พยาบาลวิชาชีพอนุมัติร่าง ให้บันทึกเข้าเวชระเบียน (ใช้ชื่อจากบัญชีที่ล็อกอิน)' },
    })
    .get('/nursing-pending', getPendingApprovals, {
        query: t.Object({ ward_code: t.String() }),
        detail: { summary: 'ร่างที่รออนุมัติของหอผู้ป่วย (คิวงานของพยาบาลผู้ตรวจสอบ)' },
    })

    // ---------- ข้อมูลอ้างอิงสำหรับฟอร์ม ----------
    .get('/terminology', getNursingTerminology, {
        detail: { summary: 'ชุดคำมาตรฐาน NANDA-I / NIC / NOC สำหรับ dropdown' },
    })
    // ---------- แผนการพยาบาล (Nursing Care Plan) ----------
    // ใช้ path ขึ้นต้นด้วยคำคงที่ ไม่ใช่ /careplan?ward_code= เพื่อให้แยกจาก /careplan/:an ชัดเจน
    .get('/careplan-ward', getCarePlansByWard, {
        query: t.Object({
            ward_code: t.String(),
            status: t.Optional(t.String()),
            limit: t.Optional(t.String()),
        }),
        detail: { summary: 'แผนการพยาบาลทั้งหอผู้ป่วย พร้อมสรุปรายผู้ป่วย (ไม่ระบุ status = เอาเฉพาะที่ดำเนินการอยู่)' },
    })
    .get('/careplan/:an', getCarePlansByAN, {
        params: t.Object({ an: t.String() }),
        query: t.Object({ status: t.Optional(t.String()) }),
        detail: { summary: 'แผนการพยาบาลทั้งหมดของผู้ป่วย (กรองด้วย status ได้)' },
    })
    // ไม่รับ nurse_name จาก client — ผู้วางแผนมาจากบัญชีที่เข้าสู่ระบบเท่านั้น
    .post('/careplan', saveCarePlan, {
        body: t.Object(
            {
                an: t.String(),
                ward_code: t.String(),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'เพิ่มข้อวินิจฉัยทางการพยาบาล (กันข้อวินิจฉัยเดิมเปิดค้างซ้ำ)' },
    })
    .put('/careplan/:id', updateCarePlan, {
        params: t.Object({ id: t.String() }),
        body: t.Object({}, { additionalProperties: true }),
        detail: { summary: 'แก้ไขแผน / ปิดแผนเป็นบรรลุเป้าหมายหรือปรับแผน (ส่งเฉพาะช่องที่แก้ได้)' },
    })
    // ร่างเท่านั้น ไม่บันทึกอะไร พยาบาลต้องกดบันทึกเองผ่าน POST /careplan
    .post('/careplan-suggest', suggestCarePlan, {
        body: t.Object(
            {
                an: t.String(),
                nursing_diagnosis: t.String(),
                related_to: t.Optional(t.String()),
                goal: t.Optional(t.String()),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'สั่งให้โมเดลในเครือข่ายโรงพยาบาลร่างกิจกรรมการพยาบาล (ตอบ job_id ทันที ไม่ค้างสาย)' },
    })
    // โมเดลใช้เวลานานกว่าที่ proxy ระหว่างทางยอมให้ค้างสาย จึงต้องถามผลเป็นระยะแทนการรอ
    .get('/careplan-suggest/:jobId', getSuggestionStatus, {
        params: t.Object({ jobId: t.String() }),
        detail: { summary: 'ถามผลของคำขอร่าง (pending / done / error)' },
    })
    .delete('/careplan/:id', deleteCarePlan, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ลบแผนการพยาบาล (soft delete · แผนที่มีบันทึกอ้างถึงแล้วลบไม่ได้)' },
    })
    // ---------- แผนการพยาบาลแบบ Focus list ----------
    // ใช้ path ขึ้นต้นด้วยคำคงที่เหมือนกลุ่มอื่น เพราะ router ของ Elysia
    // ไม่ยอมให้ตำแหน่งเดียวกันมีชื่อพารามิเตอร์ต่างกัน
    .get('/focus-ward', getFocusRecordsByWard, {
        query: t.Object({
            ward_code: t.String(),
            status: t.Optional(t.String()),
            template_code: t.Optional(t.String()),
            from: t.Optional(t.String()),
            to: t.Optional(t.String()),
            limit: t.Optional(t.String()),
        }),
        detail: { summary: 'ใบ Focus ทั้งหอผู้ป่วย (ดูว่าใบไหนยังค้างเป็นร่าง)' },
    })
    // เหตุผลหลักที่ผลประเมินเป็นช่องติ๊ก — สรุปเป็นตัวชี้วัดได้โดยไม่ต้องเปิดอ่านทีละใบ
    .get('/focus-indicators', getFocusIndicators, {
        query: t.Object({
            template_code: t.String(),
            ward_code: t.Optional(t.String()),
            from: t.Optional(t.String()),
            to: t.Optional(t.String()),
        }),
        detail: { summary: 'สรุปผลการประเมินเป็นตัวชี้วัด (นับเฉพาะใบที่ปิดแล้ว)' },
    })
    .get('/focus-revisions/:id', getFocusRecordRevisions, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ประวัติการแก้ไขของใบ Focus หนึ่งใบ' },
    })
    .get('/focus/:an', getFocusRecordsByAN, {
        params: t.Object({ an: t.String() }),
        query: t.Object({ status: t.Optional(t.String()) }),
        detail: { summary: 'ใบ Focus ทั้งหมดของผู้ป่วย (กรองด้วย status ได้)' },
    })
    // ไม่รับ nurse_name จาก client — ผู้บันทึกมาจากบัญชีที่เข้าสู่ระบบเท่านั้น
    .post('/focus', saveFocusRecord, {
        body: t.Object(
            {
                an: t.String(),
                // รับเป็นข้อความได้ด้วย เพราะ id เป็น bigint ซึ่ง postgres.js คืนมาเป็น string
                // หน้าจอที่ส่งค่าที่เพิ่งอ่านมาจาก API กลับมาตรงๆ จึงส่งเป็นข้อความ
                // controller แปลงเป็นตัวเลขและตรวจว่าเป็นจำนวนเต็มบวกอยู่แล้ว
                template_id: t.Union([t.Number(), t.String()]),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'เปิดใบ Focus จากแม่แบบ (คัดลอกโครงแม่แบบติดไปกับใบ)' },
    })
    // แก้ร่างไม่ต้องมีเหตุผล แต่แก้ใบที่ปิดแล้วต้องมีเสมอ — controller เป็นคนตัดสิน
    .put('/focus/:id', updateFocusRecord, {
        params: t.Object({ id: t.String() }),
        body: t.Object(
            { amend_reason: t.Optional(t.String()) },
            { additionalProperties: true }
        ),
        detail: { summary: 'บันทึกผลการประเมิน (ใบที่ปิดแล้วต้องระบุเหตุผลและเก็บฉบับเดิม)' },
    })
    .post('/focus-complete/:id', completeFocusRecord, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ปิดใบให้เข้าเวชระเบียน (ทุกระยะต้องมีผลประเมินอย่างน้อยหนึ่งรายการ)' },
    })
    .delete('/focus/:id', deleteFocusRecord, {
        params: t.Object({ id: t.String() }),
        query: t.Object({ reason: t.Optional(t.String()) }),
        detail: { summary: 'ยกเลิกใบ Focus (ใบที่ปิดแล้วต้องระบุเหตุผล เก็บแถวไว้เสมอ)' },
    })

    // ชื่อเดิมที่หน้าบันทึกทางการพยาบาลใช้ผูก note กลับไปที่ข้อวินิจฉัย
    .get('/care-plans/:an', getCarePlansByAN, {
        params: t.Object({ an: t.String() }),
        query: t.Object({ status: t.Optional(t.String()) }),
        detail: { summary: 'แผนการพยาบาลของผู้ป่วย ใช้ผูกบันทึกกลับไปที่ข้อวินิจฉัย' },
    });
