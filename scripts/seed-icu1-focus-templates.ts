/**
 * แม่แบบตั้งต้น: Focus list ทั่วไปของหอผู้ป่วยหนัก 1 โรงพยาบาลพะเยา
 * ถอดจากฟอร์มกระดาษ 6 Focus — รับใหม่/รับย้าย · Discharge planning · ย้าย ward ·
 * Refer out · ไม่สมัครอยู่/Palliative · Near dead/Dead
 *
 * ฟอร์มต้นฉบับมี 3 คอลัมน์ (Focus / วัตถุประสงค์ / กิจกรรมการพยาบาล) ไม่มีคอลัมน์ประเมินผล
 * รายการประเมินผลในนี้จึงมาจากสองแหล่งเท่านั้น ไม่ได้แต่งขึ้นเอง
 *   1. วัตถุประสงค์ของ Focus นั้น แปลงเป็นช่องติ๊กว่าบรรลุหรือไม่
 *   2. สิ่งที่กิจกรรมสั่งให้ทำอย่างเจาะจงจนตรวจได้ เช่น ตรวจสอบสิทธิ · ลง MEWS · เซ็นเอกสาร
 * ทั้งหมดแก้ได้ในหน้าจัดการแม่แบบ
 *
 * รันซ้ำได้ — รหัสเดิมจะถูกอัปเดตแทนการสร้างซ้ำ
 *   bun run scripts/seed-icu1-focus-templates.ts
 */

import { nurse } from '../src/db';
import { normalizeTemplateBody } from '../src/utils/focusTemplate';

const OWNER_WARD = '1'; // ผู้ป่วยหนัก 1 — เปลี่ยนได้ในหน้าจัดการแม่แบบ

interface Seed {
    code: string;
    title: string;
    objective: string;
    sections: {
        id: string;
        title: string;
        activities: string[];
        evaluations: Record<string, unknown>[];
    }[];
}

const seeds: Seed[] = [
    // ---------- 1. รับใหม่ / รับย้าย ----------
    {
        code: 'ICU1_ADMIT',
        title: 'รับใหม่ / รับย้าย',
        objective: [
            '1. ผู้ป่วยและญาติเข้าใจเหตุผลที่ต้องเข้ารับการรักษาใน ICU',
            '2. ผู้ป่วยและญาติทราบกฎ ระเบียบ การเยี่ยม การติดต่อสอบถามอาการ',
            '3. ผู้ป่วยและญาติพึงพอใจในการให้ข้อมูล',
        ].join('\n'),
        sections: [{
            id: 'admit',
            title: 'รับใหม่ / รับย้ายเข้าหอผู้ป่วยหนัก',
            activities: [
                'ปฏิบัติตาม Flow chart กระบวนงานรับใหม่/รับย้าย ในหอผู้ป่วยหนัก 1',
                'แนะนำอาคารสถานที่ อุปกรณ์เครื่องใช้สำหรับผู้ป่วย',
                'ให้ข้อมูลความจำเป็นที่ผู้ป่วยต้องเข้ารับการรักษาใน ICU กฎระเบียบการเข้าเยี่ยม และมอบเอกสารคำแนะนำการเข้าเยี่ยม / แนะนำ QR code ข้อมูลการเยี่ยมและการดูแลใน ICU',
                'ตรวจสอบสิทธิการรักษา ขอเบอร์โทรศัพท์ติดต่อญาติ',
            ],
            evaluations: [
                { id: 'adm_type', kind: 'choice', label: 'ประเภทการรับเข้า', options: ['รับใหม่', 'รับย้าย'] },
                { id: 'adm_understand', kind: 'check', label: 'ผู้ป่วยและญาติเข้าใจเหตุผลที่ต้องเข้ารับการรักษาใน ICU' },
                { id: 'adm_rules', kind: 'check', label: 'ผู้ป่วยและญาติทราบกฎ ระเบียบ การเยี่ยม การติดต่อสอบถามอาการ' },
                { id: 'adm_doc_given', kind: 'check', label: 'มอบเอกสารคำแนะนำการเข้าเยี่ยม / แนะนำ QR code แล้ว' },
                { id: 'adm_right_checked', kind: 'check', label: 'ตรวจสอบสิทธิการรักษาแล้ว' },
                { id: 'adm_contact', kind: 'check', label: 'บันทึกเบอร์โทรศัพท์ติดต่อญาติแล้ว' },
                { id: 'adm_satisfied', kind: 'check', label: 'ผู้ป่วยและญาติพึงพอใจในการให้ข้อมูล' },
            ],
        }],
    },

    // ---------- 2. Discharge planning ----------
    {
        code: 'ICU1_DCPLAN',
        title: 'Discharge planning (within 48 hr.)',
        objective: [
            '1. วางแผนจัดบริการในการดูแล รักษา และประสานงานในทีมสหสาขาวิชาชีพ',
            '2. สนับสนุนและเสริมพลังผู้ป่วยและครอบครัวรายกรณี (Individual care)',
            '3. เพื่อเตรียมความพร้อมผู้ป่วย/ญาติ และชุมชน ให้มีส่วนร่วมในการดูแลสุขภาพ อย่างมั่นใจ ปลอดภัย และพึงพอใจ',
            '4. ตอบสนองต่อความต้องการของผู้ป่วยและญาติ ผู้ดูแล',
        ].join('\n'),
        sections: [
            {
                id: 'assess',
                title: 'ประเมินและวางแผน',
                activities: [
                    'สร้างสัมพันธภาพ ประเมินความต้องการของผู้ป่วยและญาติ ผู้ดูแล ประเมินปัจจัยเสี่ยงของการเกิดโรคและแนะนำการดูแลตนเองให้สอดคล้องกับสภาวะโรค',
                    'ให้คำแนะนำหลีกเลี่ยงปัจจัยเสี่ยงต่อการเกิดโรค เช่น งดสูบบุหรี่ และพิจารณาส่งปรึกษาคลินิกงดบุหรี่ การใช้สารเสพติด',
                ],
                evaluations: [
                    { id: 'dc_group', kind: 'choice', label: 'กลุ่มโรค', options: ['STEMI', 'Stroke'], allow_other: true },
                    { id: 'dc_within48', kind: 'check', label: 'วางแผนจำหน่ายภายใน 48 ชั่วโมงแรก' },
                    { id: 'dc_assess', kind: 'check', label: 'ประเมินความต้องการของผู้ป่วย ญาติ ผู้ดูแล และปัจจัยเสี่ยงแล้ว' },
                    { id: 'dc_risk_advice', kind: 'check', label: 'ให้คำแนะนำหลีกเลี่ยงปัจจัยเสี่ยง (งดบุหรี่ สารเสพติด)' },
                    { id: 'dc_smoking_clinic', kind: 'choice', label: 'ส่งปรึกษาคลินิกงดบุหรี่', options: ['ส่งปรึกษา', 'ไม่จำเป็น'] },
                ],
            },
            {
                id: 'dmethod',
                // แยกเป็นระยะของตัวเองเพราะ D-METHOD เป็นชุดหัวข้อที่ต้องให้ครบ
                // การติ๊กทีละหัวข้อทำให้ตรวจความครบถ้วนได้โดยไม่ต้องเปิดอ่านทีละราย
                title: 'ให้คำแนะนำตาม D-METHOD',
                activities: [
                    'D — ความรู้เรื่องโรคที่เป็นอยู่ สาเหตุ อาการ แนวทางการรักษา',
                    'M — ยาที่ผู้ป่วยได้รับ ระยะเวลาที่ใช้ อาการข้างเคียง ข้อควรระวัง',
                    'E — การจัดสิ่งแวดล้อมให้สะอาด เหมาะสมกับภาวะสุขภาพ',
                    'T — วัตถุประสงค์ของการตรวจรักษา การพยาบาล ภาวะแทรกซ้อนที่อาจเกิดขึ้น',
                    'H — ข้อจำกัดด้านสุขภาพ คำแนะนำในการปฏิบัติตัว การส่งเสริมและฟื้นฟูสภาพ',
                    'O — ความสำคัญของการมาตรวจตามนัดหมาย การติดต่อขอความช่วยเหลือกรณีเกิดภาวะฉุกเฉิน ระบุอาการเตือน (Warning Signs) หรือปัญหาที่อาจพบ',
                    'D — การเลือกรับประทานอาหารที่เหมาะสมกับโรค',
                ],
                evaluations: [
                    { id: 'dm_disease', kind: 'check', label: 'D — ความรู้เรื่องโรค สาเหตุ อาการ แนวทางการรักษา' },
                    { id: 'dm_medicine', kind: 'check', label: 'M — ยาที่ได้รับ อาการข้างเคียง ข้อควรระวัง' },
                    { id: 'dm_environment', kind: 'check', label: 'E — การจัดสิ่งแวดล้อม' },
                    { id: 'dm_treatment', kind: 'check', label: 'T — การตรวจรักษา การพยาบาล ภาวะแทรกซ้อน' },
                    { id: 'dm_health', kind: 'check', label: 'H — ข้อจำกัดด้านสุขภาพ การปฏิบัติตัว การฟื้นฟูสภาพ' },
                    { id: 'dm_outpatient', kind: 'check', label: 'O — การมาตรวจตามนัด อาการเตือน การขอความช่วยเหลือ' },
                    { id: 'dm_diet', kind: 'check', label: 'D — อาหารที่เหมาะสมกับโรค' },
                ],
            },
            {
                id: 'team',
                title: 'ประสานทีมและติดตามผล',
                activities: [
                    'ร่วมกับทีมสหสาขาวิชาชีพ ในการวางแผนดูแลต่อเนื่อง',
                ],
                evaluations: [
                    { id: 'dc_team', kind: 'check', label: 'ร่วมวางแผนดูแลต่อเนื่องกับทีมสหสาขาวิชาชีพแล้ว' },
                    { id: 'dc_empower', kind: 'check', label: 'ผู้ป่วยและครอบครัวได้รับการเสริมพลังรายกรณี' },
                    { id: 'dc_confident', kind: 'check', label: 'ผู้ป่วย/ญาติมั่นใจและพึงพอใจในการดูแลต่อเนื่อง' },
                ],
            },
        ],
    },

    // ---------- 3. ย้าย ward ----------
    {
        code: 'ICU1_TRANSFER',
        title: 'ย้าย ward',
        objective: [
            '1. เตรียมผู้ป่วยและญาติให้มีความพร้อมในการดูแลต่อเนื่อง',
            '2. สื่อสารข้อมูลสำคัญให้แก่ทีมการดูแลครบถ้วน',
        ].join('\n'),
        sections: [{
            id: 'transfer',
            title: 'ย้ายออกจากหอผู้ป่วยหนัก',
            activities: [
                'ตรวจสอบเวชระเบียนผู้ป่วย',
                'ตรวจสอบยา และของใช้ส่วนตัวของผู้ป่วยให้ครบก่อนย้าย',
                'ส่งเวรข้อมูลการเจ็บป่วย อาการปัจจุบันของผู้ป่วยให้ครบถ้วน และลง Patient Transfer record พร้อม MEWS',
                'แจ้งข้อมูลแก่ญาติผู้ป่วยเมื่อมีการย้ายผู้ป่วย',
            ],
            evaluations: [
                { id: 'trf_to_ward', kind: 'text', label: 'หอผู้ป่วยปลายทาง' },
                { id: 'trf_time', kind: 'time', label: 'เวลาที่ย้าย' },
                { id: 'trf_record', kind: 'check', label: 'ตรวจสอบเวชระเบียนผู้ป่วยครบถ้วน' },
                { id: 'trf_belongings', kind: 'check', label: 'ตรวจสอบยาและของใช้ส่วนตัวครบก่อนย้าย' },
                { id: 'trf_handover', kind: 'check', label: 'ส่งเวรข้อมูลการเจ็บป่วยและอาการปัจจุบันครบถ้วน' },
                { id: 'trf_transfer_record', kind: 'check', label: 'ลง Patient Transfer record แล้ว' },
                { id: 'trf_mews', kind: 'number', label: 'MEWS ก่อนย้าย', min: 0, max: 20 },
                { id: 'trf_inform_family', kind: 'check', label: 'แจ้งข้อมูลแก่ญาติเมื่อมีการย้ายแล้ว' },
            ],
        }],
    },

    // ---------- 4. Refer out ----------
    {
        code: 'ICU1_REFEROUT',
        title: 'Refer out',
        objective: [
            '1. ผู้ป่วยและญาติรับทราบ เข้าใจเหตุผลของการส่งต่อ',
            '2. ผู้ป่วยได้รับการเตรียมความพร้อมทั้งด้านร่างกายและจิตใจในการส่งต่อ',
        ].join('\n'),
        sections: [{
            id: 'refer',
            title: 'ส่งต่อไปรับการรักษาที่โรงพยาบาลอื่น',
            activities: [
                'ปฏิบัติตาม Flow chart กระบวนการการส่งต่อผู้ป่วยเพื่อไปรับการรักษาต่อโรงพยาบาลอื่น (refer out)',
                'ประสานส่งเวรข้อมูลสำคัญ ผลการตรวจทางห้องปฏิบัติการต่างๆ ของผู้ป่วยที่ refer แก่หน่วยงานที่เกี่ยวข้อง',
            ],
            evaluations: [
                { id: 'ref_hospital', kind: 'text', label: 'โรงพยาบาลปลายทาง' },
                { id: 'ref_time', kind: 'time', label: 'เวลาที่ส่งต่อ' },
                { id: 'ref_understand', kind: 'check', label: 'ผู้ป่วยและญาติรับทราบและเข้าใจเหตุผลของการส่งต่อ' },
                { id: 'ref_prepared', kind: 'check', label: 'ผู้ป่วยได้รับการเตรียมความพร้อมทั้งร่างกายและจิตใจ' },
                { id: 'ref_flowchart', kind: 'check', label: 'ปฏิบัติตาม Flow chart การส่งต่อผู้ป่วยแล้ว' },
                { id: 'ref_labs', kind: 'check', label: 'ส่งข้อมูลสำคัญและผลตรวจทางห้องปฏิบัติการแก่หน่วยงานที่เกี่ยวข้องแล้ว' },
            ],
        }],
    },

    // ---------- 5. ไม่สมัครอยู่ / Palliative ----------
    {
        code: 'ICU1_PALLIATIVE',
        title: 'ไม่สมัครอยู่ / Palliative',
        objective: 'ตอบสนองความต้องการด้านร่างกาย จิตใจ สังคม และจิตวิญญาณ ของผู้ป่วยและครอบครัว',
        sections: [{
            id: 'palliative',
            title: 'ไม่สมัครอยู่ / การดูแลแบบประคับประคอง',
            activities: [
                'ให้ข้อมูลแก่ญาติเกี่ยวกับการดำเนินของโรค การรักษาและการให้การพยาบาลที่เป็นอยู่',
                'หลังญาติได้รับข้อมูลจากแพทย์ พยาบาล และมีเจตนาไม่ยินยอมรับการรักษาในโรงพยาบาล ให้เซ็นเอกสารไม่ยินยอมรับการรักษา',
                'ปฏิบัติตาม Flow chart กระบวนงานการดูแลผู้ป่วยระยะท้าย',
            ],
            evaluations: [
                { id: 'pal_type', kind: 'choice', label: 'ประเภท', options: ['ไม่สมัครอยู่', 'Palliative'] },
                { id: 'pal_info', kind: 'check', label: 'ให้ข้อมูลแก่ญาติเรื่องการดำเนินของโรค การรักษาและการพยาบาลแล้ว' },
                { id: 'pal_consent', kind: 'choice', label: 'เอกสารไม่ยินยอมรับการรักษา', options: ['เซ็นแล้ว', 'ไม่เกี่ยวข้อง'] },
                { id: 'pal_flowchart', kind: 'check', label: 'ปฏิบัติตาม Flow chart การดูแลผู้ป่วยระยะท้ายแล้ว' },
                { id: 'pal_needs_met', kind: 'check', label: 'ตอบสนองความต้องการด้านร่างกาย จิตใจ สังคม และจิตวิญญาณแล้ว' },
            ],
        }],
    },

    // ---------- 6. Near dead / Dead ----------
    {
        code: 'ICU1_NEARDEAD',
        title: 'Near dead / Dead',
        objective: [
            '1. ผู้ป่วยได้รับการดูแลในระยะท้าย',
            '2. ผู้ป่วยเสียชีวิตอย่างสงบ',
        ].join('\n'),
        sections: [{
            id: 'neardead',
            title: 'การดูแลระยะท้ายและการจำหน่ายผู้ป่วยถึงแก่กรรม',
            activities: [
                'เปิดโอกาสให้ญาติอยู่กับผู้ป่วยในวาระสุดท้ายของชีวิต',
                'ปฏิบัติตาม Flow chart กระบวนงานการจำหน่ายผู้ป่วยถึงแก่กรรม',
            ],
            evaluations: [
                { id: 'nd_stage', kind: 'choice', label: 'ระยะ', options: ['Near dead', 'Dead'] },
                { id: 'nd_time', kind: 'time', label: 'เวลา' },
                { id: 'nd_family_present', kind: 'check', label: 'เปิดโอกาสให้ญาติอยู่กับผู้ป่วยในวาระสุดท้ายแล้ว' },
                { id: 'nd_endoflife_care', kind: 'check', label: 'ผู้ป่วยได้รับการดูแลในระยะท้าย' },
                { id: 'nd_peaceful', kind: 'check', label: 'ผู้ป่วยเสียชีวิตอย่างสงบ' },
                { id: 'nd_flowchart', kind: 'check', label: 'ปฏิบัติตาม Flow chart การจำหน่ายผู้ป่วยถึงแก่กรรมแล้ว' },
            ],
        }],
    },
];

const wardRow = await nurse`SELECT ward_name FROM ward WHERE ward = ${OWNER_WARD} LIMIT 1`;
const wardName = String(wardRow[0]?.ward_name ?? '').trim() || null;

let created = 0, updated = 0;

for (const seed of seeds) {
    const checked = normalizeTemplateBody({ sections: seed.sections });
    if ('error' in checked) {
        console.error(`[${seed.code}] โครงแม่แบบไม่ผ่านการตรวจ: ${checked.error}`);
        process.exit(1);
    }

    const values = {
        code: seed.code,
        title: seed.title,
        objective: seed.objective,
        owner_ward_code: OWNER_WARD,
        owner_ward_name: wardName,
        body: nurse.json(checked.body as never),
        status: 'published',
    };

    const existing = await nurse`
        SELECT id, version FROM care_plan_templates
        WHERE lower(btrim(code)) = ${seed.code.toLowerCase()} AND is_deleted IS NOT TRUE
    `;

    const totals = checked.body.sections.reduce(
        (acc, s) => ({
            a: acc.a + s.activities.length,
            e: acc.e + s.evaluations.length,
        }),
        { a: 0, e: 0 }
    );

    if (existing.length > 0) {
        const id = Number(existing[0]!.id);
        const version = Number(existing[0]!.version) + 1;
        await nurse`
            UPDATE care_plan_templates
            SET ${nurse({ ...values, version, updated_at: new Date(), updated_by: 'seed' })}
            WHERE id = ${id}
        `;
        updated++;
        console.log(`อัปเดต ${seed.code} (id=${id} รุ่นที่ ${version}) — ${checked.body.sections.length} ระยะ · กิจกรรม ${totals.a} · ประเมินผล ${totals.e}`);
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
        created++;
        console.log(`สร้าง ${seed.code} (id=${saved[0]!.id}) — ${checked.body.sections.length} ระยะ · กิจกรรม ${totals.a} · ประเมินผล ${totals.e}`);
    }
}

console.log(`\nสร้างใหม่ ${created} · อัปเดต ${updated} · เจ้าของ ${wardName ?? OWNER_WARD}`);
process.exit(0);
