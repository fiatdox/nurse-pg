/**
 * วันหยุดขององค์กร — core_kon.hr_holidays
 *
 * เก็บเฉพาะวันหยุดที่ประกาศเป็นรายวัน ไม่รวมเสาร์–อาทิตย์ซึ่งดูจากตัววันที่ได้เอง
 * ผู้ใช้ทุกคนอ่านได้ เพราะหน้าจัดเวรต้องรู้ว่าวันไหนหยุดเพื่อระบายสีและปรับอัตรากำลัง
 * แต่การแก้ไขจำกัดเฉพาะผู้ดูแลระบบ เพราะเป็นข้อมูลกลางที่ระบบอื่นในฐาน hris ใช้ร่วมกัน
 *
 * ตรวจสิทธิ์ซ้ำที่นี่ทุกเส้นทางที่เขียนข้อมูล ไม่ได้พึ่งการซ่อนเมนูฝั่งหน้าจอ
 */

import { Context } from 'elysia';
import { core_kon } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor } from '../utils/nursingRecord';
import { isAdmin } from './systemSettingsController';

const clean = (v: unknown) => sanitizeHTML(String(v ?? '').trim()) ?? '';

const HOLIDAY_TYPES = ['public', 'substitution', 'special', 'organization'];

/** 'YYYY-MM-DD' เท่านั้น — กันไม่ให้ driver ตีความ timezone แล้ววันเลื่อน */
const toDateOnly = (v: unknown): string | null => {
    const s = String(v ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const shape = (r: Record<string, unknown>) => ({
    id: Number(r.id),
    // คืนเป็น YYYY-MM-DD ล้วน ไม่ผ่าน toISOString ซึ่งจะเลื่อนวันตาม timezone
    holiday_date: r.holiday_date instanceof Date
        ? `${r.holiday_date.getFullYear()}-${String(r.holiday_date.getMonth() + 1).padStart(2, '0')}-${String(r.holiday_date.getDate()).padStart(2, '0')}`
        : String(r.holiday_date ?? ''),
    name_th: clean(r.name_th),
    holiday_type: clean(r.holiday_type),
    note: clean(r.note) || null,
    is_active: r.is_active === true,
});

/**
 * รายการวันหยุด
 *
 * ไม่ระบุปี = คืนทุกปีที่มีข้อมูล เพราะรายการทั้งหมดยังนับหลักสิบไม่ใช่หลักหมื่น
 * ระบุ include_inactive เมื่อหน้าจอผู้ดูแลต้องการเห็นรายการที่ยกเลิกไปแล้วด้วย
 */
export const listHolidays = async ({ query, set, user }: Context & { user: any }) => {
    const { year, include_inactive } = query as { year?: string; include_inactive?: string };
    const y = year ? Number(year) : null;

    if (year && (!Number.isInteger(y) || y! < 1900 || y! > 2200)) {
        set.status = 400;
        return { success: false, message: 'ปีไม่ถูกต้อง' };
    }

    try {
        const showAll = include_inactive === 'true';
        const rows = await core_kon`
            SELECT id, holiday_date, name_th, holiday_type, note, is_active
            FROM core_kon.hr_holidays
            WHERE TRUE
              ${y ? core_kon`AND EXTRACT(YEAR FROM holiday_date) = ${y}` : core_kon``}
              ${showAll ? core_kon`` : core_kon`AND is_active`}
            ORDER BY holiday_date
        `;

        return {
            success: true,
            // บอกหน้าจอว่าคนนี้แก้ได้ไหม จะได้ไม่ต้องเดาเองแล้วโชว์ปุ่มผิด
            can_manage: await isAdmin(user),
            data: rows.map(r => shape(r as Record<string, unknown>)),
        };
    } catch (error) {
        console.error('List holidays error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** ปีที่มีข้อมูลแล้ว ใช้ทำตัวเลือกในหน้าจอ */
export const listHolidayYears = async ({ set }: Context) => {
    try {
        const rows = await core_kon`
            SELECT DISTINCT EXTRACT(YEAR FROM holiday_date)::int AS year
            FROM core_kon.hr_holidays ORDER BY year DESC
        `;
        return { success: true, data: rows.map(r => Number(r.year)) };
    } catch (error) {
        console.error('List holiday years error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

const readBody = (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return {
        holiday_date: toDateOnly(b.holiday_date),
        name_th: clean(b.name_th).slice(0, 200),
        holiday_type: clean(b.holiday_type) || 'public',
        note: clean(b.note).slice(0, 300) || null,
    };
};

const validate = (v: ReturnType<typeof readBody>): string | null => {
    if (!v.holiday_date) return 'กรุณาระบุวันที่ในรูปแบบ YYYY-MM-DD';
    if (!v.name_th) return 'กรุณาระบุชื่อวันหยุด';
    if (!HOLIDAY_TYPES.includes(v.holiday_type)) return 'ประเภทวันหยุดไม่ถูกต้อง';
    return null;
};

/** เพิ่มวันหยุด — เฉพาะผู้ดูแลระบบ */
export const createHoliday = async ({ body, set, user }: Context & { user: any }) => {
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขวันหยุดได้' };
    }

    const v = readBody(body);
    const err = validate(v);
    if (err) {
        set.status = 400;
        return { success: false, message: err };
    }

    try {
        const actor = await resolveActor(user);
        const actorId = actor?.userId ? Number(actor.userId) : null;

        // วันเดียวมีได้ประกาศเดียว ถ้าซ้ำต้องบอกให้ชัดว่าไปแก้ของเดิม
        const dup = await core_kon`
            SELECT id, name_th FROM core_kon.hr_holidays
            WHERE holiday_date = ${v.holiday_date} AND is_active LIMIT 1
        `;
        if (dup.length > 0) {
            set.status = 409;
            return {
                success: false,
                message: `วันที่นี้มีวันหยุด "${clean(dup[0].name_th)}" อยู่แล้ว หากต้องการเปลี่ยนให้แก้รายการเดิม`,
            };
        }

        const saved = await core_kon`
            INSERT INTO core_kon.hr_holidays
                (holiday_date, name_th, holiday_type, note, created_by, updated_by)
            VALUES (${v.holiday_date}, ${v.name_th}, ${v.holiday_type}, ${v.note}, ${actorId}, ${actorId})
            RETURNING id, holiday_date, name_th, holiday_type, note, is_active
        `;
        return { success: true, message: 'เพิ่มวันหยุดเรียบร้อยแล้ว', data: shape(saved[0] as Record<string, unknown>) };
    } catch (error) {
        console.error('Create holiday error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** แก้ไขวันหยุด — เฉพาะผู้ดูแลระบบ */
export const updateHoliday = async ({ params, body, set, user }: Context & { user: any }) => {
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขวันหยุดได้' };
    }

    const id = Number((params as { id: string }).id);
    if (!Number.isInteger(id)) {
        set.status = 400;
        return { success: false, message: 'รหัสวันหยุดไม่ถูกต้อง' };
    }

    const v = readBody(body);
    const err = validate(v);
    if (err) {
        set.status = 400;
        return { success: false, message: err };
    }

    try {
        const actor = await resolveActor(user);
        const actorId = actor?.userId ? Number(actor.userId) : null;

        const dup = await core_kon`
            SELECT id FROM core_kon.hr_holidays
            WHERE holiday_date = ${v.holiday_date} AND is_active AND id <> ${id} LIMIT 1
        `;
        if (dup.length > 0) {
            set.status = 409;
            return { success: false, message: 'วันที่นี้มีวันหยุดอื่นอยู่แล้ว' };
        }

        const saved = await core_kon`
            UPDATE core_kon.hr_holidays
            SET holiday_date = ${v.holiday_date}, name_th = ${v.name_th},
                holiday_type = ${v.holiday_type}, note = ${v.note},
                updated_at = now(), updated_by = ${actorId}
            WHERE id = ${id}
            RETURNING id, holiday_date, name_th, holiday_type, note, is_active
        `;
        if (saved.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบวันหยุดที่ระบุ' };
        }
        return { success: true, message: 'แก้ไขวันหยุดเรียบร้อยแล้ว', data: shape(saved[0] as Record<string, unknown>) };
    } catch (error) {
        console.error('Update holiday error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/**
 * ยกเลิกประกาศวันหยุด — เฉพาะผู้ดูแลระบบ
 *
 * ปิดการใช้งานแทนการลบแถว เพราะตารางเวรที่จัดไปแล้วอ้างอิงวันหยุดชุดนั้น
 * ถ้าลบทิ้งจะตามรอยไม่ได้ว่าตอนจัดเวรยึดอะไรเป็นเกณฑ์
 */
export const deactivateHoliday = async ({ params, set, user }: Context & { user: any }) => {
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขวันหยุดได้' };
    }

    const id = Number((params as { id: string }).id);
    if (!Number.isInteger(id)) {
        set.status = 400;
        return { success: false, message: 'รหัสวันหยุดไม่ถูกต้อง' };
    }

    try {
        const actor = await resolveActor(user);
        const actorId = actor?.userId ? Number(actor.userId) : null;

        const removed = await core_kon`
            UPDATE core_kon.hr_holidays
            SET is_active = false, updated_at = now(), updated_by = ${actorId}
            WHERE id = ${id} AND is_active
            RETURNING id
        `;
        if (removed.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบวันหยุดที่ระบุ หรือถูกยกเลิกไปแล้ว' };
        }
        return { success: true, message: 'ยกเลิกวันหยุดเรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Deactivate holiday error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

/** เปิดใช้งานวันหยุดที่ยกเลิกไว้ — เฉพาะผู้ดูแลระบบ */
export const reactivateHoliday = async ({ params, set, user }: Context & { user: any }) => {
    if (!(await isAdmin(user))) {
        set.status = 403;
        return { success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่แก้ไขวันหยุดได้' };
    }

    const id = Number((params as { id: string }).id);
    if (!Number.isInteger(id)) {
        set.status = 400;
        return { success: false, message: 'รหัสวันหยุดไม่ถูกต้อง' };
    }

    try {
        // อ่านเป็นข้อความ ไม่ใช่ Date เพราะ driver ส่ง Date กลับไปเป็น timestamptz
        // แล้ววันเลื่อนตาม offset ทำให้เทียบวันซ้ำไม่เจอ จนไปติดที่ unique index เป็น 500
        const target = await core_kon`
            SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d
            FROM core_kon.hr_holidays WHERE id = ${id} LIMIT 1
        `;
        if (target.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบวันหยุดที่ระบุ' };
        }

        // ระหว่างที่ยกเลิกไว้ อาจมีคนประกาศวันหยุดอื่นทับวันเดียวกัน
        const dup = await core_kon`
            SELECT id FROM core_kon.hr_holidays
            WHERE holiday_date = ${String(target[0].d)} AND is_active AND id <> ${id} LIMIT 1
        `;
        if (dup.length > 0) {
            set.status = 409;
            return { success: false, message: 'วันที่นี้มีวันหยุดอื่นใช้งานอยู่แล้ว' };
        }

        const actor = await resolveActor(user);
        const actorId = actor?.userId ? Number(actor.userId) : null;

        await core_kon`
            UPDATE core_kon.hr_holidays
            SET is_active = true, updated_at = now(), updated_by = ${actorId}
            WHERE id = ${id}
        `;
        return { success: true, message: 'เปิดใช้งานวันหยุดเรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Reactivate holiday error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
