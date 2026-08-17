import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import { getRateMatrix, saveRates, clearRates } from '../controllers/rateController';

export const rateRoutes = new Elysia({ prefix: '/api/v1/rates' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Rates'] } })

    // ตารางอัตราทั้งผืน: กลุ่มตำแหน่ง × รหัสเวร
    .get('/', getRateMatrix)

    .post('/', saveRates, {
        body: t.Object({
            // หน้าจอส่งทั้งตารางมา ช่องที่เว้นว่างส่ง amount = null เพื่อสั่งลบอัตรานั้น
            rates: t.Array(t.Object({
                staff_position_id: t.Number(),
                shift_code: t.String(),
                amount: t.Union([t.Number(), t.Null()])
            }))
        })
    })

    .delete('/clear/:id', clearRates, {
        params: t.Object({ id: t.String() })
    });
