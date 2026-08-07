import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    listFocusTemplates,
    getFocusTemplate,
    saveFocusTemplate,
    updateFocusTemplate,
    setFocusTemplateStatus,
    getFocusTemplateRevisions,
    deleteFocusTemplate,
} from '../controllers/focusTemplateController';

/**
 * แม่แบบแผนการพยาบาลแบบ Focus list
 *
 * แยกจาก /nursing-records เพราะเป็นคนละชั้นของข้อมูล — ที่นี่คือเนื้อหาวิชาการ
 * ที่ผู้ดูแลระบบดูแล ส่วนใต้ /nursing-records คือบันทึกของผู้ป่วยแต่ละราย
 * ทุกเส้นทางที่เขียนข้อมูลตรวจสิทธิ์ผู้ดูแลระบบซ้ำที่ controller ไม่ได้พึ่งการซ่อนเมนู
 */
export const focusTemplateRoutes = new Elysia({ prefix: '/api/v1/care-plan-templates' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Care Plan Templates'] } })

    .get('/', listFocusTemplates, {
        query: t.Object({
            ward_code: t.Optional(t.String()),
            status: t.Optional(t.String()),
            q: t.Optional(t.String()),
        }),
        detail: { summary: 'รายการแม่แบบ Focus list (ไม่ระบุ status = เฉพาะที่เผยแพร่แล้ว)' },
    })
    .get('/:id', getFocusTemplate, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'แม่แบบหนึ่งใบพร้อมเนื้อหาทุกระยะ' },
    })
    .get('/revisions/:id', getFocusTemplateRevisions, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ประวัติการแก้ไขแม่แบบ (เฉพาะผู้ดูแลระบบ)' },
    })
    .post('/', saveFocusTemplate, {
        body: t.Object(
            {
                code: t.String(),
                title: t.String(),
                owner_ward_code: t.String(),
            },
            { additionalProperties: true }
        ),
        detail: { summary: 'สร้างแม่แบบใหม่ (สร้างมาเป็นฉบับร่างเสมอ)' },
    })
    // ส่งเฉพาะช่องที่แก้ได้ ช่องที่ไม่ส่งมาจะคงค่าเดิม
    .put('/:id', updateFocusTemplate, {
        params: t.Object({ id: t.String() }),
        body: t.Object({}, { additionalProperties: true }),
        detail: { summary: 'แก้ไขแม่แบบ (เนื้อหาเปลี่ยน = ขยับเลขรุ่นและเก็บประวัติ)' },
    })
    .put('/status/:id', setFocusTemplateStatus, {
        params: t.Object({ id: t.String() }),
        body: t.Object(
            { status: t.String(), reason: t.Optional(t.String()) },
            { additionalProperties: false }
        ),
        detail: { summary: 'เผยแพร่ / เลิกใช้ / เปลี่ยนกลับเป็นร่าง' },
    })
    .delete('/:id', deleteFocusTemplate, {
        params: t.Object({ id: t.String() }),
        detail: { summary: 'ลบแม่แบบ (แม่แบบที่ถูกใช้บันทึกแล้วลบไม่ได้)' },
    });
