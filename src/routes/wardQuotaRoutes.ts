import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getQuotaOptions,
    getWardQuotas,
    saveWardQuotas,
    clearWardQuotas,
} from '../controllers/wardQuotaController';

export const wardQuotaRoutes = new Elysia({ prefix: '/api/v1/ward-quotas' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Ward Quotas'] } })

    // กลุ่มตำแหน่ง เวร และหอผู้ป่วยที่เลือกได้ — ใช้วาดโครงตาราง
    .get('/options', getQuotaOptions)

    .get('/:ward', getWardQuotas, {
        params: t.Object({ ward: t.String() })
    })

    .post('/', saveWardQuotas, {
        body: t.Object({
            ward: t.Number(),
            // หน้าจอส่งทั้งตารางมา ช่องที่เว้นว่างส่ง quota = null เพื่อสั่งลบ
            quotas: t.Array(t.Object({
                staff_position_id: t.Number(),
                shift_code: t.String(),
                quota: t.Union([t.Number(), t.Null()])
            }))
        })
    })

    .delete('/clear/:ward', clearWardQuotas, {
        params: t.Object({ ward: t.String() })
    });
