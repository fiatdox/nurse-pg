import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import { getAiSetting, setAiSetting } from '../controllers/systemSettingsController';
import {
    getWardsV1,
    getSpclty,
    getAdmissionType,
    getAdmissionSeverityLV,
    getAdmissionChangeShiftTypes,
    getAdmissionShiftCareLevels
} from '../controllers/systemController';

export const systemRoutes = new Elysia({ prefix: '/api/v1/system' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['System'] } })
    .get('/wardsV1', getWardsV1)
    .get('/spclty', getSpclty)
    .get('/admission-types', getAdmissionType)
    // เพิ่มเส้นทางสำหรับดึงข้อมูลประเภทเวร
    .get('/admission-change-shift-types', getAdmissionChangeShiftTypes)
    // เพิ่มเส้นทางสำหรับดึงข้อมูลระดับการดูแลผู้ป่วยในเวร
    .get('/admission-shift-care-levels', getAdmissionShiftCareLevels)
    .get('/admission-severity-levels', getAdmissionSeverityLV)

    // ---------- ค่าตั้งผู้ช่วย AI ----------
    // อ่านได้ทุกคน เพราะหน้าจอต้องรู้ว่าจะแสดงปุ่มผู้ช่วยหรือไม่
    .get('/ai-setting', getAiSetting, {
        detail: { summary: 'สถานะผู้ช่วย AI และผู้ใช้คนนี้แก้ได้หรือไม่' },
    })
    // เปลี่ยนได้เฉพาะผู้ดูแลระบบ ตรวจสิทธิ์ที่ controller ไม่ใช่ที่หน้าจอ
    .put('/ai-setting', setAiSetting, {
        body: t.Object({ enabled: t.Boolean() }),
        detail: { summary: 'เปิด/ปิดผู้ช่วย AI ทั้งระบบ (เฉพาะผู้ดูแลระบบ)' },
    });
    
