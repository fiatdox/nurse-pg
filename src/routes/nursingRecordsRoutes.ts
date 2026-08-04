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
    getActiveCarePlansByAN,
} from '../controllers/progressNoteController';

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
    .get('/care-plans/:an', getActiveCarePlansByAN, {
        params: t.Object({ an: t.String() }),
        detail: { summary: 'แผนการพยาบาลของผู้ป่วย ใช้ผูกบันทึกกลับไปที่ข้อวินิจฉัย' },
    });
