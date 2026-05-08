import { Elysia } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
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
    .get('/admission-severity-levels', getAdmissionSeverityLV);
    
