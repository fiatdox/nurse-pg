import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getWorkUnits,
    getWorkUnitReport,
    getWorkUnitGroupReport,
    saveWorkUnitEntries,
} from '../controllers/workUnitController';

const nullableNumber = t.Union([t.Number(), t.Null()]);

export const workUnitRoutes = new Elysia({ prefix: '/api/v1/work-units' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Nurse'] } })

    .get('/', getWorkUnits, {
        detail: { summary: 'หน่วยงานที่คิด product จากยอดงาน (ER · OR · วิสัญญี · ห้องคลอด · OPD) และรายการที่นับ' },
    })

    .post('/report', getWorkUnitReport, {
        body: t.Object({
            work_unit_id: t.Number(),
            month: t.String(),
        }),
        detail: { summary: 'FTE / product รายวันรายเวรของหน่วยงานหนึ่งในเดือนที่เลือก' },
    })

    .post('/group-report', getWorkUnitGroupReport, {
        body: t.Object({
            group: t.String({ maxLength: 30 }),
            month_from: t.String(),
            month_to: t.String(),
        }),
        detail: { summary: 'สรุป FTE / product ของหน่วยรายเดือนทั้งกลุ่ม (เช่น ห้องตรวจ OPD) ตามช่วงเดือน' },
    })

    .put('/entries', saveWorkUnitEntries, {
        body: t.Object({
            month: t.String(),
            entries: t.Array(t.Object({
                work_unit_id: t.Number(),
                record_date: t.String(),
                shift_type_id: t.Number(),
                qty: t.Array(t.Object({ item_id: t.Number(), qty: nullableNumber }), { maxItems: 20 }),
                regular: t.Optional(nullableNumber),
                ot: t.Optional(nullableNumber),
            }), { maxItems: 3000 }),
            headcount: t.Optional(t.Array(t.Object({
                work_unit_id: t.Number(),
                nurses: nullableNumber,
            }), { maxItems: 100 })),
        }),
        detail: { summary: 'บันทึกยอดงานและคนขึ้นเวรของเดือน (null = ลบค่าที่กรอกไว้)' },
    });
