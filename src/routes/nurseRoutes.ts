import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    addNurseSchedule,
    getNurseScheduleDetail,
    deleteNurseSchedule,
    getNurseSchedule,
    getFTEByWard,
    getNurseShiftTypes,
    getNurseScheduleByDate
} from '../controllers/nurseController';

export const nurseRoutes = new Elysia({ prefix: '/api/v1/nurse' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Nurse'] } })
    .get('/nurse-shift-types', getNurseShiftTypes)
    .get('/schedule', getNurseSchedule, {
        query: t.Object({
            ward: t.String(),
            month: t.String()
        })
    })
    .post('/nurse-schedules', addNurseSchedule, {
        body: t.Array(t.Object({
            staff_id: t.Number(),
            shift_date: t.String(),
            shift_code: t.String(),
            ward: t.String(),
            nurse_shift_type_id: t.Optional(t.Union([t.Number(), t.Null()])),
            created_by: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
            updated_by: t.Optional(t.Union([t.String(), t.Number(), t.Null()]))
        }))
    })
    .post('/nurse-schedule-detail', getNurseScheduleDetail, {
        body: t.Object({
            ward: t.String(),
            shift_date: t.String(),
            staff_id: t.Number(),
            shift_code: t.Optional(t.String())
        })
    })
    .post('/nurse-schedule-by-date', getNurseScheduleByDate, {
        body: t.Object({
            ward: t.String(),
            date: t.String()
        })
    })
    .delete('/nurse-schedules-delete', deleteNurseSchedule, {
        body: t.Array(t.Union([
            t.Number(),
            t.Object({ shift_assignment_id: t.Number() })
        ]))
    })
    .post('/fte-by-ward', getFTEByWard, {
        body: t.Object({
            ward: t.String(),
            month: t.String()
        })
    });
