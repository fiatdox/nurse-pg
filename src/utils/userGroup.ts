import { resolveActor } from './nursingRecord';
import { isAdmin } from '../controllers/systemSettingsController';

/**
 * กลุ่มผู้ใช้ สำหรับตัดสินว่าจะโชว์เมนูไหน
 *
 * ผูกกับกลุ่มงานจริงในทะเบียนบุคลากร (core_kon) ไม่สร้างทะเบียนสิทธิ์ชุดที่สอง
 * ด้วยเหตุผลเดียวกับที่งานโภชนาการใช้มาก่อนแล้ว (ดู isNutritionStaff):
 * ทะเบียนที่ต้องมีคนคอยอัปเดตตอนคนย้ายหน่วย คือทะเบียนที่จะไม่ถูกอัปเดต
 * คนย้ายจากห้องยาไปตึกผู้ป่วย เมนูต้องเปลี่ยนตามโดยไม่ต้องมีใครสั่ง
 *
 * ย้ำว่านี่คือ "การมองเห็นเมนู" ไม่ใช่การกันข้อมูล การกันจริงอยู่ที่แต่ละ endpoint
 * คนที่รู้ URL ยังเปิดหน้าได้ และนั่นถูกต้องแล้วสำหรับระบบที่คนทำงานแทนกันทั้งวัน
 */
export type StaffGroup = 'nursing' | 'pharmacy' | 'nutrition' | 'vendor' | 'admin' | 'other';

export const GROUP_KEYS: StaffGroup[] = ['nursing', 'pharmacy', 'nutrition', 'vendor', 'admin'];

export const GROUP_LABEL: Record<StaffGroup, string> = {
    nursing: 'กลุ่มงานพยาบาล',
    pharmacy: 'กลุ่มห้องยา',
    nutrition: 'กลุ่มโภชนาการ',
    vendor: 'กลุ่มบริษัททำอาหาร',
    admin: 'กลุ่มแอดมิน',
    other: 'กลุ่มงานอื่น',
};

/** ชื่อกลุ่มงานในทะเบียนบุคลากรที่ตรงตัว */
const EXACT_MAJOR: Record<string, StaffGroup> = {
    'กลุ่มงานเภสัชกรรม': 'pharmacy',
    'กลุ่มงานโภชนศาสตร์': 'nutrition',
    /*
      งานป้องกันการติดเชื้อ (IC) เป็นพยาบาล แต่ชื่อกลุ่มงานไม่ได้ขึ้นต้นด้วย "การพยาบาล"
      จึงต้องระบุตรงตัว ไม่งั้นทีม IC จะไม่เห็นเมนู IC ของตัวเอง
    */
    'ด้านการควบคุมและป้องกันการติดเชื้อ': 'nursing',
    'กลุ่มงานฝ่ายการพยาบาล': 'nursing',
    'กลุ่มงานวิจัยและพัฒนาการพยาบาล': 'nursing',
};

/** กลุ่มงานการพยาบาลมีหลายสิบชื่อ (อายุรกรรม ศัลยกรรม ไอซียู ...) จับจากคำขึ้นต้นแทนการไล่รายชื่อ */
const NURSING_PREFIX = 'กลุ่มงานการพยาบาล';

export const groupOfMajor = (majorName: string): StaffGroup => {
    const name = String(majorName ?? '').trim();
    if (!name) return 'other';
    if (EXACT_MAJOR[name]) return EXACT_MAJOR[name];
    if (name.startsWith(NURSING_PREFIX)) return 'nursing';
    return 'other';
};

export interface GroupInfo {
    username: string;
    fullname: string;
    majorName: string;
    /** กลุ่มจากกลุ่มงาน หนึ่งคนอยู่ได้กลุ่มเดียว ยกเว้นแอดมินที่เพิ่มเข้ามาอีกกลุ่ม */
    groups: StaffGroup[];
    isAdmin: boolean;
}

/**
 * กลุ่มของผู้ใช้ที่กำลังล็อกอินอยู่
 * แอดมินได้กลุ่ม admin เพิ่ม ไม่ใช่แทนที่ หัวหน้าที่เป็นแอดมินด้วยจึงยังเห็นเมนูหน่วยตัวเองตามปกติ
 */
export const resolveGroups = async (user: unknown): Promise<GroupInfo | null> => {
    const actor = await resolveActor(user);
    if (!actor) return null;

    const groups: StaffGroup[] = [groupOfMajor(actor.majorName)];
    const admin = await isAdmin(user);
    if (admin) groups.push('admin');

    return {
        username: actor.username,
        fullname: actor.fullname,
        majorName: actor.majorName,
        groups,
        isAdmin: admin,
    };
};
