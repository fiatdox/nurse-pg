import { Elysia, t } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { loginCOREKON } from '../controllers/authController';

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

