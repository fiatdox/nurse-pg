import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getIpdDailyStats,
    getNurseWorkload,
    getShiftSeverityDistribution,
    getBedOccupancy,
    getCareLevelFlow,
} from '../controllers/dashboardController';
import { getStaffingAnalytics } from '../controllers/staffingController';

const rangeBody = t.Object({
    ward: t.String(),
    date_from: t.String(),
    date_to: t.String(),
});

export const dashboardRoutes = new Elysia({ prefix: '/api/v1/dashboard' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Dashboard'] } })

    .post('/ipd-daily-stats', getIpdDailyStats, {
        body: rangeBody,
        detail: { summary: 'สถิติรายวัน (รับใหม่ / รับย้าย / ดูแลต่อเนื่อง / จำหน่าย) + สรุปภาระงานเทียบมาตรฐาน' },
    })
    .post('/nurse-workload', getNurseWorkload, {
        body: rangeBody,
        detail: { summary: 'ชั่วโมงการทำงานรายบุคคล แยกเวรเช้า/บ่าย/ดึก/OT' },
    })
    .post('/shift-severity-distribution', getShiftSeverityDistribution, {
        body: rangeBody,
        detail: { summary: 'ระดับความรุนแรงผู้ป่วยแยกตามช่วงเวร (ดึก / เช้า / บ่าย)' },
    })
    .post('/bed-occupancy', getBedOccupancy, {
        body: rangeBody,
        detail: { summary: 'อัตราครองเตียงเฉลี่ยและสูงสุดในช่วงเวลา' },
    })
    .post('/care-level-flow', getCareLevelFlow, {
        body: rangeBody,
        detail: { summary: 'การเปลี่ยนระดับการดูแลของผู้ป่วยข้ามเวร ดึก → เช้า → บ่าย (Sankey)' },
    })
    .post('/staffing', getStaffingAnalytics, {
        body: t.Object({
            date_from: t.String(),
            date_to: t.String(),
            /* รหัส HIS ของหอ ไม่ส่ง/ว่าง = ทุกหอที่เปิดใช้งาน · หอที่รวมเป็นหน่วยเดียวกันขยายให้เอง */
            wards: t.Optional(t.Array(t.String(), { maxItems: 100 })),
            /* 1 = ดึก · 2 = เช้า · 3 = บ่าย ไม่ส่ง/ว่าง = ทุกเวร */
            shifts: t.Optional(t.Array(t.Number(), { maxItems: 3 })),
        }),
        detail: { summary: 'วิเคราะห์อัตรากำลังพยาบาล หลายหอ หลายเวร ตามช่วงวันที่ (productivity, ขาด/เกิน, OT, skill mix, รายบุคคล)' },
    });
