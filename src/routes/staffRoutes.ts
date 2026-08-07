import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getStaffs,
    addStaff,
    updateStaff,
    deactivateStaff,
    activateStaff,
    getWardStaffByWard,
    clearWardStaffsByWard,
    addWardStaffs
} from '../controllers/staffController';

export const staffRoutes = new Elysia({ prefix: '/api/v1/staffs' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Staff'] } })
    .get('/', getStaffs, {
        query: t.Object({
            is_active: t.Optional(t.String())
        })
    })
    .post('/', addStaff, {
        body: t.Object({
            fullname: t.String(),
            staff_position_id: t.Number(),
            is_active: t.Optional(t.String())
        })
    })
    .put('/:id', updateStaff, {
        params: t.Object({
            id: t.String()
        }),
        body: t.Object({
            fullname: t.Optional(t.String()),
            staff_position_id: t.Optional(t.Number()),
            is_active: t.Optional(t.String())
        })
    })
    .patch('/:id/deactivate', deactivateStaff, {
        params: t.Object({
            id: t.String()
        })
    })
    .patch('/:id/activate', activateStaff, {
        params: t.Object({
            id: t.String()
        })
    })
    .get('/ward-staffs/:id', getWardStaffByWard, {
        params: t.Object({
            id: t.String()
        })
    })

    // เพิ่มเส้นทางสำหรับลบเจ้าหน้าที่ประจำหอผู้ป่วยทั้งหมดในหอผู้ป่วยที่ระบุ
    .delete('/ward-staffs-clear/:ward', clearWardStaffsByWard, {
        params: t.Object({
            ward: t.String()
        })
    })

    // เพิ่มเส้นทางสำหรับบันทึก/ปรับปรุงเจ้าหน้าที่ประจำหอผู้ป่วย
    .post('/ward-staffs', addWardStaffs, {
        body: t.Array(t.Object({
            // ใช้ t.Union เพื่อให้รองรับการส่งค่ามาเป็น String หรือ Number ก็ได้
            // staff_id = แบบเดิม · user_id = คนจาก core_kon.users (แบบใหม่)
            staff_id: t.Optional(t.Union([t.String(), t.Number()])),
            user_id: t.Optional(t.Union([t.String(), t.Number()])),
            ward: t.Union([t.String(), t.Number()])
        }))
    });
