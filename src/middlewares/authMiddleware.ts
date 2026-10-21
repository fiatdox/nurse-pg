import { Elysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';

/**
 * An authentication plugin for Elysia.
 * It verifies the JWT from the Authorization header and adds the user payload to the context.
 */
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required for authentication');
}

/** ค่าของ typ ใน JWT ที่บอกว่า token ใบนี้เป็นของบริษัทผู้รับจ้าง ไม่ใช่เจ้าหน้าที่ */
export const VENDOR_TOKEN = 'vendor';

/** ค่าของ typ สำหรับเจ้าหน้าที่ ใส่ไว้เพื่ออ่านง่าย token รุ่นเก่าไม่มีฟิลด์นี้ */
export const STAFF_TOKEN = 'staff';

export const authMiddleware = (app: Elysia) =>
    app.use(
        jwt({
            name: 'jwt',
            secret: process.env.JWT_SECRET!,
            exp: '8h' // กำหนดให้ตรงกัน
        })
    )
    // .derive() adds a new property to the context for this and subsequent handlers.
    // We use it to add a `user` property containing the verified JWT payload.
    .derive(async ({ jwt, headers }) => {
        const auth = headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) {
            return { user: null };
        }
        const token = auth.slice(7);
        try {
            // Properly verify JWT with expiration check enabled
            const userPayload = await jwt.verify(token);
            return {
                user: userPayload as { username: string; typ?: string } | null
            };
        } catch {
            // Token is invalid or expired
            return { user: null };
        }
    })
    // .onBeforeHandle is a hook that runs before the main route handler.
    // We use it to protect routes by checking if a user is authenticated.
    .onBeforeHandle(async ({ user, set }) => {
        /*
          token ของบริษัทผู้รับจ้างถูกเซ็นด้วยกุญแจดอกเดียวกับของเจ้าหน้าที่
          ถ้าไม่คัดชนิดตรงนี้ มันจะผ่านทุก route ที่ใช้ middleware ตัวนี้
          ซึ่งรวมถึงรายชื่อผู้ป่วย ผล lab และบันทึกทางการพยาบาล

          รับเฉพาะ typ = staff (allow-list) ไม่ใช่ "ปฏิเสธ vendor"
          token ชนิดใหม่ที่เพิ่มในอนาคต (เช่นขั้นกลางของการเข้าระบบ) จะถูกปฏิเสธเองโดยไม่ต้องจำมาแก้ที่นี่
          token เจ้าหน้าที่มี typ ตั้งแต่ ก.ย. 2569 และอายุ 8 ชม. รุ่นที่ไม่มี typ หมดอายุไปนานแล้ว
        */
        if (!user || (user as { typ?: string }).typ !== STAFF_TOKEN) {
            set.status = 401;
            return { success: false, message: 'Unauthorized' };
        }
    });