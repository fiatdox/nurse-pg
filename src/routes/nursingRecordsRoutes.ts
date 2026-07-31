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
    });
