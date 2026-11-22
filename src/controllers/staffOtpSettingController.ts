import type { Context } from 'elysia';
import { nurse, core_kon } from '../db';
import { isAdmin } from './systemSettingsController';
import { otpReadyProblem, otpTransportName } from '../utils/mophPromptOtp';
import { STAFF_OTP_KEY, forceOff, logStaffAuth, staffOtpSetting, staffOtpTablesReady, validCid } from '../utils/staffOtp';

/**
 * เปิด/ปิดโหมด OTP (MFA ทาง LINE OA หมอพร้อม) ตอนเข้าระบบของเจ้าหน้าที่ — เฉพาะผู้ดูแลระบบ
 *
 * เปิดได้ก็ต่อเมื่อพร้อมจริงทุกข้อ ไม่งั้นทุกคนจะเข้าระบบไม่ได้ทันที รวมผู้ดูแลที่เพิ่งกดเปิดเอง
 *   - ตารางของโหมดนี้มีในฐานแล้ว (รัน sql/2026-11-21_staff_login_otp.sql)
 *   - ช่องทางส่ง OTP ใช้งานได้ (เชื่อม API หมอพร้อมแล้ว หรือ console บนเครื่อง dev)
 *   - บัญชีของผู้ดูแลคนที่กดเปิดมีเลขบัตรที่ถูกต้อง (ไม่งั้นตัวเองจะเข้าระบบไม่ได้)
 * ปิดได้ทุกเมื่อ ไม่มีเงื่อนไข
 */

const nameOf = (user: unknown) => String((user as { username?: unknown } | null)?.username ?? '');

/** สถานะทั้งหมดที่หน้าตั้งค่าต้องใช้ แสดงเหตุผลที่ยังเปิดไม่ได้ให้ผู้ดูแลเห็นตรง ๆ */
const status = async (user: unknown) => {
    const [enabled, tables, admin] = await Promise.all([staffOtpSetting(), staffOtpTablesReady(), isAdmin(user)]);
    const rows = await nurse`SELECT updated_at, updated_by FROM system_settings WHERE key = ${STAFF_OTP_KEY} LIMIT 1`;

    /* ผู้ใช้ทั้งระบบที่ไม่มีเลขบัตรที่ถูกต้อง = คนที่จะเข้าระบบไม่ได้ทันทีเมื่อเปิด — นับเฉพาะผู้ดูแล ไม่ส่งรายชื่อ */
    let missingCid: number | null = null;
    if (admin) {
        try {
            const users = await core_kon`SELECT id_card FROM users`;
            missingCid = users.filter(u => !validCid(u.id_card)).length;
        } catch { missingCid = null; }
    }

    return {
        enabled,
        /* สวิตช์ฉุกเฉินใน .env ปิดทับอยู่ — ค่าในฐานเปิดไว้ก็ไม่มีผล */
        force_off: forceOff(),
        effective: enabled && !forceOff(),
        transport: otpTransportName(),
        ready_problem: !tables ? 'ยังไม่ได้รัน sql/2026-11-21_staff_login_otp.sql บนฐาน nurse' : otpReadyProblem(),
        users_without_cid: missingCid,
        updated_at: rows[0]?.updated_at ?? null,
        updated_by: rows[0]?.updated_by ?? null,
        can_manage: admin,
    };
};

export const getStaffOtpSetting = async ({ set, user }: Context & { user: unknown }) => {
    try {
        return { success: true, data: await status(user) };
    } catch (error) {
        console.error('Get staff OTP setting error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

export const setStaffOtpSetting = async ({ body, set, user }: Context & { user: unknown }) => {
    const enabled = (body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ enabled เป็น true หรือ false' };
    }
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนค่านี้ได้' };
    }
    const username = nameOf(user);

    if (enabled) {
        if (!(await staffOtpTablesReady())) {
            set.status = 409;
            return { success: false, message: 'ยังเปิดไม่ได้: ยังไม่ได้รัน sql/2026-11-21_staff_login_otp.sql บนฐาน nurse' };
        }
        const problem = otpReadyProblem();
        if (problem) {
            set.status = 409;
            return { success: false, message: `ยังเปิดไม่ได้: ${problem}` };
        }
        const me = await core_kon`SELECT id_card FROM users WHERE username = ${username} LIMIT 1`;
        if (!validCid(me[0]?.id_card)) {
            set.status = 409;
            return { success: false, message: 'ยังเปิดไม่ได้: บัญชีของคุณไม่มีเลขบัตรประชาชนที่ถูกต้อง เปิดแล้วคุณจะเข้าระบบไม่ได้' };
        }
    }

    try {
        await nurse`
            INSERT INTO system_settings (key, value, description, updated_at, updated_by)
            VALUES (${STAFF_OTP_KEY}, ${nurse.json({ enabled })},
                    'บังคับ OTP ทาง LINE OA หมอพร้อม ตอนเข้าระบบของเจ้าหน้าที่ (MFA)', ${new Date()}, ${username})
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`;
        /* ตารางประวัติอาจยังไม่มีตอนปิด (ไม่เคยรัน migration) logStaffAuth กลืน error เองอยู่แล้ว */
        await logStaffAuth({ username, event: enabled ? 'setting_on' : 'setting_off' });
        return {
            success: true,
            message: enabled ? 'เปิดโหมด OTP แล้ว ผู้ใช้ทุกคนต้องยืนยัน OTP ทางหมอพร้อมตอนเข้าระบบครั้งถัดไป' : 'ปิดโหมด OTP แล้ว',
            data: await status(user),
        };
    } catch (error) {
        console.error('Set staff OTP setting error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
