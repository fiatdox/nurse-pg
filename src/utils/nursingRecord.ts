/** ตัวช่วยที่ใช้ร่วมกันในบันทึกทางการพยาบาลทุกโมดูล */

import { core_kon } from '../db';

export const VALID_SHIFTS = ['ดึก', 'เช้า', 'บ่าย'];

export interface Actor {
    username: string;
    fullname: string;
    userId: string;
    positionName: string;
    /** กลุ่มงานที่สังกัด (majors.name) — ว่างได้ถ้าบัญชียังไม่ผูกกลุ่มงาน */
    majorName: string;
    /** บทบาททางการพยาบาลที่ได้จากตำแหน่งจริงในระบบบุคลากร ไม่ใช่ที่ผู้ใช้เลือกเอง */
    roleClass: RoleClass;
}

export type RoleClass = 'professional_nurse' | 'practical_nurse' | 'assistant' | 'other';

/**
 * แปลงตำแหน่งใน core_kon.user_positions เป็นบทบาททางการพยาบาล
 * ตรวจจากข้อมูลจริง: พยาบาลวิชาชีพ 429 คน · ผู้ช่วยพยาบาล 68 · พยาบาลเทคนิค 4
 * ตำแหน่งที่ไม่เกี่ยวกับการพยาบาลจัดเป็น other ซึ่งลงนามกำกับให้ใครไม่ได้
 */
const ROLE_BY_POSITION: Record<string, RoleClass> = {
    'พยาบาลวิชาชีพ': 'professional_nurse',
    'พยาบาลเทคนิค': 'practical_nurse',
    'ผู้ช่วยพยาบาล': 'assistant',
    'พนักงานช่วยการพยาบาล': 'assistant',
    'พนักงานช่วยเหลือคนไข้': 'assistant',
};

export const roleClassOf = (positionName: unknown): RoleClass =>
    ROLE_BY_POSITION[String(positionName ?? '').trim()] ?? 'other';

/** ผู้ที่ลงนามกำกับบันทึกของคนอื่นได้ */
export const canCosign = (actor: Actor): boolean => actor.roleClass === 'professional_nurse';

/** ผู้บันทึกที่ต้องมีพยาบาลวิชาชีพลงนามกำกับ */
export const NEEDS_COSIGN_ROLES: RoleClass[] = ['assistant', 'student' as RoleClass];

/**
 * ตัวตนของผู้บันทึกจาก JWT
 *
 * token มีแค่ { username } (ดู authController) ชื่อจริงจึงต้องมาจากฐานข้อมูล
 * ห้ามรับชื่อผู้บันทึกจาก client เพราะเป็นข้อมูลที่ใช้อ้างอิงทางกฎหมายว่าใครเป็นคนบันทึก
 */
export const resolveActor = async (user: unknown): Promise<Actor | null> => {
    const username = String((user as { username?: unknown } | null)?.username ?? '').trim();
    if (!username) return null;

    try {
        const rows = await core_kon`
            SELECT u.id, u.username, CONCAT(u.pname, u.fname, ' ', u.lname) AS employee_name,
                   up.position_name, mj."name" AS major_name
            FROM users u
            LEFT JOIN user_positions up ON up.user_position_id = u.user_position_id
            LEFT JOIN majors mj ON mj.major_id = u.major_id
            WHERE u.username = ${username}
            LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;

        const positionName = String(row.position_name ?? '').trim();
        return {
            username: String(row.username),
            fullname: String(row.employee_name ?? '').trim() || String(row.username),
            userId: String(row.id ?? ''),
            positionName,
            majorName: String(row.major_name ?? '').trim(),
            roleClass: roleClassOf(positionName),
        };
    } catch (error) {
        console.error('Resolve actor error:', error);
        return null;
    }
};

/**
 * ตีความ 'YYYY-MM-DD' และ 'YYYY-MM-DD HH:mm:ss' ว่าเป็นเวลาท้องถิ่นตามที่ผู้ใช้กรอก
 * ถ้าส่งข้อความตรงเข้า driver มันจะมองว่าเป็น UTC ทำให้เวลาที่บันทึกเพี้ยน
 * ไปเท่ากับ offset ของเครื่อง (ไทย = ช้าไป 7 ชั่วโมง)
 */
export const toLocalDate = (v: unknown): Date | null => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
        return new Date(
            Number(m[1]), Number(m[2]) - 1, Number(m[3]),
            Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)
        );
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
};

/**
 * เวรจากเวลาที่เกิดเหตุการณ์ — ดึก 00-08 / เช้า 08-16 / บ่าย 16-24
 *
 * เป็นแหล่งความจริงเดียวของ shift ทุกโมดูล ไม่รับค่าจาก client
 * เพราะเวรเป็นผลของเวลา ถ้าให้เลือกเองจะเกิดกรณีที่เวรกับเวลาขัดกัน
 * แล้วอ่านเวชระเบียนย้อนหลังไม่รู้ว่าอันไหนถูก
 *
 * ฝั่งหน้าจอมีสำเนาไว้แสดงกำกับใต้ช่องเวลา (NursingProgressNotes) ถ้าแก้ต้องแก้ให้ตรงกัน
 */
export const shiftOfTime = (d: Date): string => {
    const h = d.getHours();
    if (h < 8) return 'ดึก';
    if (h < 16) return 'เช้า';
    return 'บ่าย';
};
