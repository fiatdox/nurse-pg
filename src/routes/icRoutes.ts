import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import { getIpdPatientHistoryDaily, getOpdPatientHistoryDaily, getResultInFiscalYear, getResultDepInFiscalYear, operationFollowup, getLabno, getMdroSankeyFiscalYear, getAmrPatientReport } from '../controllers/icController';

export const icRoutes = new Elysia({ prefix: '/api/v1/ic' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['IC (Infection Control)'] } })
    .get('/ipd-patient-history-daily', getIpdPatientHistoryDaily)
    .get('/opd-patient-history-daily', getOpdPatientHistoryDaily)
    .get('/result-in-fiscal-year', getResultInFiscalYear)
    .get('/result-dep-in-fiscal-year', getResultDepInFiscalYear)
    .post('/amr-patient-report', getAmrPatientReport, {
        body: t.Object({
            date1: t.String(),
            date2: t.String()
        }),
        detail: { summary: 'รายชื่อผู้ป่วยที่ตรวจพบเชื้อดื้อยาตามช่วงวันที่ (หนึ่งแถวคือหนึ่งผลเพาะเชื้อ)' }
    })
    .get('/mdro-sankey-fiscal-year', getMdroSankeyFiscalYear, {
        detail: { summary: 'เส้นทางเชื้อดื้อยาปีงบประมาณปัจจุบัน หน่วยงาน → เชื้อ → กลุ่มดื้อยา (สำหรับกราฟ Sankey)' }
    })
    .post('/operation-followup', operationFollowup, {
        body: t.Object({
            date1: t.String(),
            date2: t.String()
        })
    })
    .get('/labno/:id', getLabno, {
        params: t.Object({
            id: t.String()
        })
    });