import { Elysia, t } from 'elysia';
import { jwtVerify } from 'jose';

/**
 * แจ้งเตือนแบบทันทีระหว่างหอผู้ป่วยกับห้องยา
 *
 * ใช้ WebSocket ที่มากับ Elysia ไม่ได้พึ่งไลบรารีภายนอก
 * Bun มี pub/sub ให้อยู่แล้ว (subscribe / publish) ซึ่งทำเรื่อง "ห้อง" ได้ครบ
 * สิ่งที่ไลบรารีภายนอกมีให้เพิ่มคือการต่อใหม่อัตโนมัติ ซึ่งเขียนฝั่งเบราว์เซอร์เองได้
 *
 * **สัญญาณเป็นแค่ตัวสะกิด ข้อมูลจริงอยู่ในฐานข้อมูลเสมอ**
 * ทุกครั้งที่ต่อใหม่หรือได้รับสัญญาณ หน้าจอต้องดึงรายการผ่าน REST อีกรอบ
 * ไม่ใช่เอาค่าจากสัญญาณไปวาดตรง ๆ เพราะถ้าสัญญาณหายไปหนึ่งใบ
 * (เน็ตสะดุด เครื่องหลับ) หน้าจอจะเพี้ยนค้างโดยไม่มีอะไรมาแก้ให้ถูก
 */

/** สถานะของใบสั่งยา เรียงตามลำดับที่เกิดจริง ยกเว้น rejected ที่ออกกลางทางได้ */
export type RxStatus = 'submitted' | 'acknowledged' | 'completed' | 'prepared'
    | 'picked_up' | 'rejected' | 'closed';

/** ค่าที่ส่งไปกับสัญญาณ มีแค่พอให้รู้ว่าควรดึงอะไรใหม่ ไม่ใช่ข้อมูลผู้ป่วยเต็ม ๆ */
export interface RxOrderEvent {
    rx_order_id: string;
    ward: number;
    status: RxStatus;
    priority: 'routine' | 'discharge' | 'stat';
    by_name: string;
    at: string;
    reason?: string;
}

/** ห้องของห้องยา ทุกเครื่องที่เปิดหน้าคิวอยู่ในห้องนี้ แล้วค่อยกรองตึกที่ฝั่งหน้าจอ */
const PHARMACY_TOPIC = 'rx:pharmacy';
/** ห้องของหอผู้ป่วย หนึ่งห้องต่อหนึ่งตึก หอจะได้ไม่เห็นความเคลื่อนไหวของตึกอื่น */
const wardTopic = (ward: number | string) => `rx:ward:${ward}`;

/** ต้องส่งข้อความยืนยันตัวตนภายในเวลานี้ ไม่งั้นถูกตัดสาย */
const AUTH_TIMEOUT_MS = 5000;

type SocketState = { authed: boolean; username: string; timer: ReturnType<typeof setTimeout> | null };
const sockets = new Map<string, SocketState>();

/**
 * ตัวเซิร์ฟเวอร์ของ Bun ใช้ส่งข้อความจากนอก handler ของ WebSocket
 * (เช่นตอนบันทึกใบสั่งยาเสร็จใน REST controller)
 */
let server: { publish: (topic: string, data: string) => unknown } | null = null;

export const setRealtimeServer = (s: unknown) => {
    server = s as typeof server;
};

const verify = async (token: string): Promise<string | null> => {
    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET!));
        /* token ของบริษัทผู้รับจ้างเซ็นด้วยกุญแจเดียวกัน ต้องคัดออกเหมือน authMiddleware */
        if ((payload as { typ?: string }).typ === 'vendor') return null;
        const username = String((payload as { username?: string }).username ?? '');
        return username || null;
    } catch {
        return null;
    }
};

export const rxRealtimeRoutes = new Elysia()
    .ws('/ws/rx', {
        /*
          รับข้อความเป็นอ็อบเจ็กต์ ไม่ใช่สตริงดิบ Elysia ตรวจรูปแบบให้ก่อนเข้า handler
          ข้อความที่ไม่ตรงแบบจะถูกปัดตกตั้งแต่ชั้นนี้ ไม่ต้องไล่ตรวจเองใน handler
        */
        body: t.Object({
            type: t.Union([t.Literal('auth'), t.Literal('join'), t.Literal('ping')]),
            token: t.Optional(t.String()),
            room: t.Optional(t.Union([t.Literal('pharmacy'), t.Literal('ward')])),
            ward: t.Optional(t.Number()),
        }),

        open(ws) {
            /*
              ยังไม่ให้ทำอะไรจนกว่าจะยืนยันตัวตน และตั้งเวลาตัดสายไว้
              ถ้าไม่ตั้ง คนที่เปิดสายทิ้งไว้เฉย ๆ จะกินทรัพยากรไปเรื่อย ๆ
              ส่ง token เป็นข้อความแรกแทนการใส่ใน URL เพราะ URL ติดไปกับ log ของ proxy
            */
            const timer = setTimeout(() => {
                if (!sockets.get(ws.id)?.authed) ws.close();
            }, AUTH_TIMEOUT_MS);
            sockets.set(ws.id, { authed: false, username: '', timer });
        },

        async message(ws, data) {
            const state = sockets.get(ws.id);
            if (!state) { ws.close(); return; }

            if (data.type === 'auth') {
                const username = await verify(String(data.token ?? ''));
                if (!username) {
                    ws.send({ type: 'unauthorized' });
                    ws.close();
                    return;
                }
                if (state.timer) clearTimeout(state.timer);
                state.authed = true;
                state.username = username;
                state.timer = null;
                ws.send({ type: 'ready' });
                return;
            }

            // ทุกอย่างนอกจาก auth ต้องยืนยันตัวตนก่อน
            if (!state.authed) { ws.close(); return; }

            if (data.type === 'ping') { ws.send({ type: 'pong' }); return; }

            if (data.type === 'join') {
                if (data.room === 'pharmacy') {
                    ws.subscribe(PHARMACY_TOPIC);
                    ws.send({ type: 'joined', room: 'pharmacy' });
                    return;
                }
                /*
                  หอเข้าได้ทีละตึก ออกจากตึกเดิมก่อนเสมอ
                  ไม่เปิดให้ขอฟังรายการตึกแบบอิสระ ไม่งั้นใครมี token ก็ขอฟังตึกไหนก็ได้
                */
                const w = Number(data.ward);
                if (Number.isInteger(w) && w > 0) {
                    ws.unsubscribe(PHARMACY_TOPIC);
                    ws.subscribe(wardTopic(w));
                    ws.send({ type: 'joined', room: `ward:${w}` });
                }
            }
        },

        close(ws) {
            const state = sockets.get(ws.id);
            if (state?.timer) clearTimeout(state.timer);
            sockets.delete(ws.id);
        },
    });

/**
 * ส่งสัญญาณว่ามีใบใหม่ หรือสถานะใบเปลี่ยน
 *
 * ไม่โยน error ออกไปข้างนอกเด็ดขาด การแจ้งเตือนล้มเหลวต้องไม่ทำให้
 * การบันทึกใบสั่งยาที่สำเร็จไปแล้วกลายเป็นคำขอที่ error ฝั่งผู้ใช้
 */
export const emitRxOrder = (event: 'order:new' | 'order:status', payload: RxOrderEvent) => {
    try {
        if (!server) return;
        const frame = JSON.stringify({ type: event, ...payload });
        server.publish(PHARMACY_TOPIC, frame);
        server.publish(wardTopic(payload.ward), frame);
    } catch (error) {
        console.error('emitRxOrder failed:', error);
    }
};
