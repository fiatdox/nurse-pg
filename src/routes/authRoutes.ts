import { Elysia, t } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { loginCOREKON, resendLoginOtp, verifyLoginOtp } from '../controllers/authController';

export const authRoutes = new Elysia({ prefix: '/api/v1/auth' })
    // This route group also needs the JWT plugin to sign tokens
    .use(jwt({
        name: 'jwt',
        // ห้ามมีค่าสำรอง ถ้าไม่ตั้งค่าไว้ต้องพังตั้งแต่บูต ไม่ใช่เซ็น token ด้วยกุญแจที่ใครก็เดาได้
        secret: process.env.JWT_SECRET!,
        exp: '8h' // ปรับอายุ Token เป็น 8 ชั่วโมง
    }))
    .post('/login', loginCOREKON, {
        body: t.Object({
            username: t.String(),
            password: t.String()
        }),
        detail: {
            tags: ['Auth'],
            security: []
        }
    })
    /* ขั้นที่สองเมื่อเปิดโหมด OTP — otp_token ได้จาก /login ใช้ได้ครั้งเดียวภายใน 10 นาที */
    .post('/login/otp', verifyLoginOtp, {
        body: t.Object({ otp_token: t.String({ maxLength: 2000 }), code: t.String({ maxLength: 10 }) }),
        detail: { tags: ['Auth'], security: [], summary: 'ยืนยัน OTP จาก LINE หมอพร้อม → ได้ token จริง' },
    })
    .post('/login/otp/resend', resendLoginOtp, {
        body: t.Object({ otp_token: t.String({ maxLength: 2000 }) }),
        detail: { tags: ['Auth'], security: [], summary: 'ขอ OTP ใหม่ (ห่างกันอย่างน้อย 60 วินาที)' },
    });
