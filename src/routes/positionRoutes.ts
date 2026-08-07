import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getStaffPositions,
    getCorePositions,
    getPositionMappings,
    savePositionMappings,
    clearPositionMappings,
    getMajors,
    getEligibleStaff,
} from '../controllers/positionController';

export const positionRoutes = new Elysia({ prefix: '/api/v1/positions' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Positions'] } })

    // กลุ่มตำแหน่งของเรา (RN / TN / PN)
    .get('/', getStaffPositions)

    // ตำแหน่งทั้งหมดจากระบบบุคลากร พร้อมบอกว่าตัวไหนถูกกลุ่มไหนจับคู่ไว้แล้ว
    .get('/core', getCorePositions)

    .get('/mappings/:id', getPositionMappings, {
        params: t.Object({ id: t.String() })
    })

    .post('/mappings', savePositionMappings, {
        body: t.Object({
            staff_position_id: t.Number(),
            // Transfer ส่งสถานะปลายทางมาทั้งก้อน จึงต้องรับรายการว่างได้ (= เอาออกหมด)
            user_position_ids: t.Array(t.Union([t.Number(), t.String()]))
        })
    })

    .delete('/mappings-clear/:id', clearPositionMappings, {
        params: t.Object({ id: t.String() })
    })

    // กลุ่มงาน ใช้เป็นตัวกรองตอนเลือกเจ้าหน้าที่เข้าหอผู้ป่วย
    .get('/majors', getMajors)

    // บุคลากรที่เลือกเข้าหอผู้ป่วยได้ — กรองด้วยตำแหน่งที่จับคู่ไว้แล้ว
    .get('/eligible-staff', getEligibleStaff, {
        query: t.Object({ major_id: t.Optional(t.String()) })
    });
