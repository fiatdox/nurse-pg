import type { Context } from 'elysia';
import { nurse, core_kon } from '../db';

/**
 * ค่าตั้งระดับระบบ
 *
 * เก็บที่เซิร์ฟเวอร์ไม่ใช่ที่เบราว์เซอร์ เพราะต้องมีผลกับทุกคนพร้อมกัน
 * และต้องบังคับใช้ได้จริงแม้ผู้ใช้จะแก้ค่าในเครื่องตัวเอง
 */

/** ผู้ดูแลระบบตามตารางบทบาทใน core_kon (ADMIN = role_id 1) */
export const isAdmin = async (username: unknown): Promise<boolean> => {
    const name = String((username as { username?: unknown } | null)?.username ?? username ?? '').trim();
    if (!name) return false;
    try {
        const rows = await core_kon`
            SELECT 1 FROM user_m_users_roles m
            JOIN users u ON u.id = m.user_id
            JOIN user_roles r ON r.id = m.role_id
            WHERE u.username = ${name} AND r.role_name = 'ADMIN'
            LIMIT 1
        `;
        return rows.length > 0;
    } catch (error) {
        console.error('Check admin error:', error);
        return false;
    }
};

/** อ่านค่าตั้งหนึ่งคีย์ ใช้ภายในโมดูลอื่นได้ด้วย */
export const readSetting = async <T>(key: string, fallback: T): Promise<T> => {
    try {
        const rows = await nurse`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`;
        return (rows[0]?.value as T) ?? fallback;
    } catch (error) {
        console.error('Read setting error:', error);
        return fallback;
    }
};

/** ผู้ช่วย AI เปิดอยู่ไหม — ปิดไว้ก่อนเสมอเมื่ออ่านค่าไม่ได้ */
export const aiAssistantEnabled = async (): Promise<boolean> => {
    const value = await readSetting<{ enabled?: boolean }>('ai_assistant', { enabled: false });
    return value?.enabled === true;
};

// ---------- อ่านค่าตั้งของผู้ช่วย AI ----------
// ผู้ใช้ทุกคนอ่านได้ เพราะหน้าจอต้องรู้ว่าจะแสดงปุ่มผู้ช่วยหรือไม่
export const getAiSetting = async ({ set, user }: Context & { user: any }) => {
    try {
        const rows = await nurse`
            SELECT value, updated_at, updated_by FROM system_settings WHERE key = 'ai_assistant' LIMIT 1
        `;
        const row = rows[0] as Record<string, unknown> | undefined;
        const value = (row?.value ?? { enabled: false }) as { enabled?: boolean };

        return {
            success: true,
            data: {
                enabled: value.enabled === true,
                updated_at: row?.updated_at ?? null,
                updated_by: row?.updated_by ?? null,
                // บอกหน้าจอว่าคนนี้แก้ได้ไหม จะได้ไม่ต้องเดาเองแล้วโชว์เมนูผิด
                can_manage: await isAdmin(user),
            },
        };
    } catch (error) {
        console.error('Get AI setting error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- เปิด/ปิดผู้ช่วย AI ----------
export const setAiSetting = async ({ body, set, user }: Context & { user: any }) => {
    const payload = (body ?? {}) as Record<string, unknown>;

    if (typeof payload.enabled !== 'boolean') {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ enabled เป็น true หรือ false' };
    }

    // ตรวจสิทธิ์ที่เซิร์ฟเวอร์เสมอ การซ่อนเมนูฝั่งหน้าจอเป็นแค่ความสะดวก ไม่ใช่การป้องกัน
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่เปลี่ยนค่านี้ได้' };
    }

    const username = String((user as { username?: unknown })?.username ?? '');

    try {
        const saved = await nurse`
            INSERT INTO system_settings (key, value, description, updated_at, updated_by)
            VALUES ('ai_assistant', ${nurse.json({ enabled: payload.enabled })},
                    'เปิด/ปิดผู้ช่วย AI ทั้งระบบ', ${new Date()}, ${username})
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
            RETURNING value, updated_at, updated_by
        `;
        const row = saved[0] as Record<string, unknown>;

        return {
            success: true,
            message: payload.enabled ? 'เปิดผู้ช่วย AI แล้ว' : 'ปิดผู้ช่วย AI แล้ว',
            data: {
                enabled: (row.value as { enabled?: boolean })?.enabled === true,
                updated_at: row.updated_at,
                updated_by: row.updated_by,
                can_manage: true,
            },
        };
    } catch (error) {
        console.error('Set AI setting error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
