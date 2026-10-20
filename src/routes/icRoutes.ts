import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import { getIpdPatientHistoryDaily, getOpdPatientHistoryDaily, getResultInFiscalYear, getResultDepInFiscalYear, operationFollowup, getLabno, getMdroSankeyFiscalYear, getAmrPatientReport, getOpdInfectionFollowup } from '../controllers/icController';

export const icRoutes = new Elysia({ prefix: '/api/v1/ic' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['IC (Infection Control)'] } })
    .get('/ipd-patient-history-daily', getIpdPatientHistoryDaily)
    .get('/opd-patient-history-daily', getOpdPatientHistoryDaily, {
        query: t.Object({
            // ไม่ส่งมา = วันนี้ ตัวคอนโทรลเลอร์เป็นคนเติมให้ และตรวจรูปแบบซ้ำอีกชั้น
            date: t.Optional(t.String())
        }),
        detail: { summary: 'ผู้ป่วยนอกที่มารับบริการในวันที่เลือก และมีผลเพาะเชื้อดื้อยาย้อนหลัง 90 วัน' }
    })
    /* ?fy=2568 = ปีงบประมาณ พ.ศ. ที่ต้องการ ไม่ส่ง = ปีงบปัจจุบัน */
    .get('/result-in-fiscal-year', getResultInFiscalYear, { query: t.Object({ fy: t.Optional(t.String()) }), })
    .get('/result-dep-in-fiscal-year', getResultDepInFiscalYear, { query: t.Object({ fy: t.Optional(t.String()) }), })
    .post('/amr-patient-report', getAmrPatientReport, {
        body: t.Object({
            date1: t.String(),
            date2: t.String()
        }),
        detail: { summary: 'รายชื่อผู้ป่วยที่ตรวจพบเชื้อดื้อยาตามช่วงวันที่ (หนึ่งแถวคือหนึ่งผลเพาะเชื้อ)' }
    })
    .post('/opd-infection-followup', getOpdInfectionFollowup, {
        body: t.Object({
            date: t.String()
        }),
        detail: { summary: 'ผู้ป่วยนอกที่มีนัดในวันที่เลือก และยังอยู่ในช่วงเฝ้าระวังเชื้อดื้อยา 90 วัน' }
    })
    .get('/mdro-sankey-fiscal-year', getMdroSankeyFiscalYear, {
        query: t.Object({ fy: t.Optional(t.String()) }),
        detail: { summary: 'เส้นทางเชื้อดื้อยาตามปีงบประมาณ (?fy=พ.ศ. ไม่ส่ง = ปีปัจจุบัน) หน่วยงาน → เชื้อ → กลุ่มดื้อยา (สำหรับกราฟ Sankey)' }
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