/**
 * แม่แบบตั้งต้น: Focus list ถอดท่อช่วยหายใจ (extubation)
 * ถอดตามฟอร์มกระดาษของหอผู้ป่วยหนัก โรงพยาบาลพะเยา
 *
 * รันซ้ำได้ — ถ้ามีรหัสนี้อยู่แล้วจะอัปเดตเนื้อหาแทนการสร้างซ้ำ
 *   bun run scripts/seed-extubation-template.ts
 */

import { nurse } from '../src/db';
import { normalizeTemplateBody } from '../src/utils/focusTemplate';

const CODE = 'EXTUBATION';
const OWNER_WARD = '1'; // ผู้ป่วยหนัก 1 — เปลี่ยนได้ในหน้าจัดการแม่แบบ

const body = {
    sections: [
        {
            id: 'prep',
            title: 'ระยะเตรียมถอดท่อช่วยหายใจ',
            activities: [
                'แจ้งให้ผู้ป่วยทราบและขอความร่วมมือ',
                'จัดท่าศีรษะสูง อย่างน้อย 45 องศา',
                'เตรียมอุปกรณ์จำเป็นในการถอดท่อให้พร้อมใช้ ได้แก่ syringe 10 ml. สำหรับ deflate cuff / อุปกรณ์ป้องกันส่วนบุคคล (PPE) / อุปกรณ์สำหรับดูดเสมหะ / อุปกรณ์สำหรับการให้ออกซิเจนตามแผนการรักษา / รถฉุกเฉิน (Emergency cart) กรณีเกิดภาวะถอดท่อช่วยหายใจล้มเหลว หรือเกิด PES',
                'บันทึก EKG / O2 saturation และสัญญาณชีพ ก่อนถอดท่อช่วยหายใจ',
                'ตรวจสอบการงดน้ำและอาหาร ก่อนถอดท่อ',
            ],
            evaluations: [
                { id: 'prep_ack', kind: 'check', label: 'ผู้ป่วยรับทราบ ให้ความร่วมมือ' },
                { id: 'prep_ekg', kind: 'choice', label: 'EKG', options: ['normal sinus rhythm'], allow_other: true },
                { id: 'prep_o2sat', kind: 'number', label: 'O2 sat.', unit: '%', min: 0, max: 100 },
                // ความดันบันทึกเป็น systolic/diastolic ตามที่พยาบาลเขียนจริง จึงเป็นข้อความไม่ใช่ตัวเลขเดียว
                { id: 'prep_bp', kind: 'text', label: 'BP (มม.ปรอท)' },
                { id: 'prep_pr', kind: 'number', label: 'PR', unit: 'ครั้งต่อนาที', min: 0, max: 300 },
                { id: 'prep_rr', kind: 'number', label: 'RR', unit: 'ครั้งต่อนาที', min: 0, max: 99 },
                { id: 'prep_npo', kind: 'choice', label: 'NPO', options: ['ใช่', 'ไม่ใช่'] },
                { id: 'prep_ng_feed', kind: 'time', label: 'last NG feed เวลา' },
            ],
        },
        {
            id: 'extubate',
            title: 'ระยะถอดท่อช่วยหายใจ',
            activities: [
                'ดูดเสมหะในช่องปากออกให้หมด',
                'ดูดเสมหะในท่อช่วยหายใจ โดยใช้แรงดัน 80-120 มม.ปรอท ด้วยความนุ่มนวล และใช้เวลาไม่เกิน 15 วินาที ให้หมด',
                'ปล่อยลมของ endotracheal cuff โดยใช้ syringe 10 ml ออกให้หมด',
                'ให้ผู้ป่วยหายใจเข้าเต็มที่และค่อยๆ ถอดท่อช่วยหายใจ',
                'ดูแลให้ผู้ป่วยพักผ่อนบนเตียงหลังถอดท่อช่วยหายใจ',
            ],
            evaluations: [
                { id: 'ext_airway_clear', kind: 'check', label: 'หลังดูดเสมหะ ทางเดินหายใจโล่ง' },
                { id: 'ext_time', kind: 'time', label: 'ถอดท่อช่วยหายใจ เวลา' },
                { id: 'ext_no_pes', kind: 'check', label: 'ไม่เกิด PES' },
            ],
        },
        {
            id: 'post',
            title: 'ระยะหลังถอดท่อช่วยหายใจ',
            activities: [
                'ดูแลให้ได้รับออกซิเจนตามแผนการรักษา',
                'ติดตามสัญญาณชีพ และบันทึกสัญญาณชีพทุก 1 ชั่วโมง',
                'Monitor EKG / O2 saturation พร้อมติดตามอาการและอาการแสดงของภาวะหายใจลำบาก ได้แก่ RR > 30 ครั้ง/นาที หรือ RR < 10 ครั้ง/นาที หรือหายใจมีเสียง stridor',
                'ดูแลการงดน้ำและอาหารทางปาก อย่างน้อย 2 ชั่วโมงหลังถอดท่อช่วยหายใจ หรือตามแผนการรักษา',
                'ดูแลติดตามอาการ ให้การดูแลตามแผนการรักษา แผนการพยาบาล จนย้ายออกจากหอผู้ป่วยหนัก หรือ 48 ชั่วโมงหลังถอดท่อช่วยหายใจ',
            ],
            evaluations: [
                { id: 'post_o2_cannula', kind: 'number', label: 'ได้รับ O2 Cannula', unit: 'l/m', min: 0, max: 15 },
                { id: 'post_o2_mask', kind: 'number', label: 'ได้รับ O2 Face Mask', unit: 'l/m', min: 0, max: 15 },
                { id: 'post_o2_hfnc', kind: 'number', label: 'ได้รับ O2 HFNC FiO2', unit: '%', min: 21, max: 100 },
                { id: 'post_no_reintubation', kind: 'check', label: 'ไม่เกิดการใส่ท่อช่วยหายใจซ้ำ' },
                { id: 'post_no_distress', kind: 'check', label: 'ไม่พบอาการหายใจลำบาก' },
                { id: 'post_distress', kind: 'check', label: 'พบอาการหายใจลำบาก' },
                { id: 'post_distress_rr', kind: 'number', label: 'RR ขณะหายใจลำบาก', unit: 'ครั้งต่อนาที', min: 0, max: 99 },
                { id: 'post_pes', kind: 'choice', label: 'PES', options: ['พบ', 'ไม่พบ'] },
                { id: 'post_reintubate_time', kind: 'time', label: 'ใส่ท่อช่วยหายใจซ้ำ เวลา' },
                { id: 'post_not_reintubated', kind: 'check', label: 'ไม่ได้ใส่ท่อช่วยหายใจซ้ำ' },
            ],
        },
    ],
};

const checked = normalizeTemplateBody(body);
if ('error' in checked) {
    console.error('โครงแม่แบบไม่ผ่านการตรวจ:', checked.error);
    process.exit(1);
}

const wardRow = await nurse`SELECT ward_name FROM ward WHERE ward = ${OWNER_WARD} LIMIT 1`;
const wardName = String(wardRow[0]?.ward_name ?? '').trim() || null;

const existing = await nurse`
    SELECT id, version FROM care_plan_templates
    WHERE lower(btrim(code)) = ${CODE.toLowerCase()} AND is_deleted IS NOT TRUE
`;

const values = {
    code: CODE,
    title: 'ถอดท่อช่วยหายใจ (extubation)',
    objective: 'ผู้ป่วยปลอดภัยและได้รับการเฝ้าระวังในแต่ละระยะของการถอดท่อช่วยหายใจ',
    owner_ward_code: OWNER_WARD,
    owner_ward_name: wardName,
    body: nurse.json(checked.body as never),
    status: 'published',
};

if (existing.length > 0) {
    const id = Number(existing[0]!.id);
    const version = Number(existing[0]!.version) + 1;
    await nurse`
        UPDATE care_plan_templates
        SET ${nurse({ ...values, version, updated_at: new Date(), updated_by: 'seed' })}
        WHERE id = ${id}
    `;
    console.log(`อัปเดตแม่แบบเดิม id=${id} เป็นรุ่นที่ ${version}`);
} else {
    const saved = await nurse`
        INSERT INTO care_plan_templates ${nurse({
            ...values,
            version: 1,
            created_at: new Date(),
            created_by: 'seed',
        })}
        RETURNING id
    `;
    console.log(`สร้างแม่แบบใหม่ id=${saved[0]!.id} (${wardName ?? OWNER_WARD})`);
}

const total = checked.body.sections.reduce(
    (acc, s) => ({
        activities: acc.activities + s.activities.length,
        evaluations: acc.evaluations + s.evaluations.length,
    }),
    { activities: 0, evaluations: 0 }
);
console.log(`${checked.body.sections.length} ระยะ · กิจกรรม ${total.activities} ข้อ · รายการประเมินผล ${total.evaluations} รายการ`);

process.exit(0);
