import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    listHolidays,
    listHolidayYears,
    createHoliday,
    updateHoliday,
    deactivateHoliday,
    reactivateHoliday,
} from '../controllers/holidayController';

/**
 * วันหยุดขององค์กร
 *
 * อ่านได้ทุกคน (หน้าจัดเวรต้องใช้) แต่ทุกเส้นทางที่เขียนตรวจสิทธิ์ผู้ดูแลระบบ
 * ซ้ำที่ controller ไม่ได้พึ่งการซ่อนเมนู
 */
const holidayBody = t.Object({
    holiday_date: t.String(),
    name_th: t.String(),
    holiday_type: t.Optional(t.String()),
    note: t.Optional(t.Union([t.String(), t.Null()])),
});

export const holidayRoutes = new Elysia({ prefix: '/api/v1/holidays' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Holidays'] } })

    .get('/', listHolidays, {
        query: t.Object({
            year: t.Optional(t.String()),
            include_inactive: t.Optional(t.String()),
        }),
        detail: { summary: 'รายการวันหยุด (ไม่รวมเสาร์–อาทิตย์)' },
    })

    .get('/years', listHolidayYears, {
        detail: { summary: 'ปีที่มีข้อมูลวันหยุดแล้ว' },
    })

    .post('/', createHoliday, { body: holidayBody })

    .put('/:id', updateHoliday, {
        params: t.Object({ id: t.String() }),
        body: holidayBody,
    })

    // ยกเลิกประกาศ ไม่ได้ลบแถว เพื่อให้ตารางเวรเดิมตามรอยได้
    .delete('/:id', deactivateHoliday, {
        params: t.Object({ id: t.String() }),
    })

    .put('/restore/:id', reactivateHoliday, {
        params: t.Object({ id: t.String() }),
    });
