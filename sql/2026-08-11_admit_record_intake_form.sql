-- เติมช่องที่ยังขาดในบันทึกแรกรับ ให้ครอบคลุมแบบฟอร์มกระดาษ
-- "ใบบันทึกการรวบรวมข้อมูลแรกรับ" (SD-IM-003.019) ของโรงพยาบาลพะเยา
--
-- หัวข้อในฟอร์มกระดาษส่วนใหญ่เป็นคู่ "ไม่มี / มี (ระบุ)" จึงเก็บเป็นสองคอลัมน์
-- คอลัมน์สถานะบอกว่าติ๊กช่องไหน อีกคอลัมน์เก็บรายละเอียดที่เขียนต่อท้าย
-- แยกกันเพราะ "ไม่มี" กับ "ยังไม่ได้ถาม" ต้องต่างกัน — ถ้าเก็บเป็นข้อความว่างอย่างเดียว
-- จะแยกไม่ออกว่าพยาบาลประเมินแล้วว่าไม่มี หรือยังไม่ได้ประเมิน
--
-- หมายเหตุ: marital_status, religion, occupation, education_level, payment_scheme,
-- communication มีคอลัมน์อยู่ก่อนแล้วแต่ไม่เคยถูกบันทึก (ไม่อยู่ใน ADMIT_FIELDS)
-- รอบนี้ต่อสายให้ใช้งานได้จริง ไม่ต้องสร้างคอลัมน์ใหม่

ALTER TABLE nursing_admit_records
    -- ส่วนหัวของฟอร์ม
    ADD COLUMN IF NOT EXISTS readmit_28_days       varchar(20),   -- รับเข้าภายหลังจำหน่าย 28 วันด้วยโรคเดิม
    ADD COLUMN IF NOT EXISTS refer_from            varchar(200),  -- Refer จาก (สถานพยาบาลต้นทาง)
    ADD COLUMN IF NOT EXISTS initial_symptoms      text,          -- อาการแรกรับ (คนละช่องกับอาการสำคัญ)

    -- ประวัติการเจ็บป่วยในอดีต
    ADD COLUMN IF NOT EXISTS allergy_status        varchar(20),
    ADD COLUMN IF NOT EXISTS surgery_status        varchar(20),
    ADD COLUMN IF NOT EXISTS surgery_detail        varchar(300),
    ADD COLUMN IF NOT EXISTS substance_status      varchar(20),
    ADD COLUMN IF NOT EXISTS substance_detail      varchar(300),
    -- เก็บเป็นรายการคั่นด้วยจุลภาค (DM, HT, COPD, CVA, Heart) เพราะติ๊กได้หลายข้อ
    ADD COLUMN IF NOT EXISTS chronic_status        varchar(20),
    ADD COLUMN IF NOT EXISTS chronic_diseases      varchar(200),
    ADD COLUMN IF NOT EXISTS chronic_other         varchar(200),
    ADD COLUMN IF NOT EXISTS treatment_status      varchar(20),
    ADD COLUMN IF NOT EXISTS treatment_detail      varchar(300),

    -- ข้อมูลทั่วไป / สถานภาพทางสังคม
    ADD COLUMN IF NOT EXISTS social_role           varchar(50),   -- หัวหน้าครอบครัว / สมาชิก / อื่นๆ
    ADD COLUMN IF NOT EXISTS dependents_count      smallint,      -- สมาชิกที่ต้องรับผิดชอบ (คน)
    ADD COLUMN IF NOT EXISTS social_other          varchar(200),  -- นักเรียน สงฆ์ ฯลฯ
    ADD COLUMN IF NOT EXISTS family_housing        varchar(50),   -- มี/ไม่มีบ้านอยู่เป็นหลักแหล่ง
    ADD COLUMN IF NOT EXISTS caregiver_status      varchar(50),   -- มี/ไม่มีผู้ดูแล
    ADD COLUMN IF NOT EXISTS disability_status     varchar(20),
    ADD COLUMN IF NOT EXISTS disability_detail     varchar(300),
    ADD COLUMN IF NOT EXISTS environment_status    varchar(20),
    ADD COLUMN IF NOT EXISTS environment_detail    varchar(300),
    ADD COLUMN IF NOT EXISTS economic_status       varchar(20),
    ADD COLUMN IF NOT EXISTS economic_detail       varchar(300),
    ADD COLUMN IF NOT EXISTS spiritual_belief      varchar(300),
    ADD COLUMN IF NOT EXISTS contact_address       varchar(300),
    ADD COLUMN IF NOT EXISTS contact_phone         varchar(50);

-- ตารางนี้คุมค่าที่เป็นตัวเลือกด้วย CHECK ทุกคอลัมน์อยู่แล้ว (chk_admit_from, chk_religion, ...)
-- คอลัมน์ใหม่จึงต้องคุมแบบเดียวกัน ไม่งั้นค่าที่สะกดผิดจะหลุดเข้าไปแล้วนับสถิติไม่ตรง
-- ทุกข้อยอม NULL ได้ เพราะ "ยังไม่ได้ประเมิน" เป็นสถานะที่ถูกต้องระหว่างกรอกฟอร์ม
DO $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT * FROM (VALUES
            ('chk_readmit_28_days',   'readmit_28_days',    $v$'yes','no'$v$),
            ('chk_allergy_status',    'allergy_status',     $v$'none','present'$v$),
            ('chk_surgery_status',    'surgery_status',     $v$'none','present'$v$),
            ('chk_substance_status',  'substance_status',   $v$'none','present'$v$),
            ('chk_chronic_status',    'chronic_status',     $v$'none','present'$v$),
            ('chk_treatment_status',  'treatment_status',   $v$'none','present'$v$),
            ('chk_disability_status', 'disability_status',  $v$'none','present'$v$),
            ('chk_environment_status','environment_status', $v$'none','present'$v$),
            ('chk_economic_status',   'economic_status',    $v$'none','present'$v$),
            ('chk_social_role',       'social_role',        $v$'head','member','other'$v$),
            ('chk_family_housing',    'family_housing',     $v$'settled','homeless'$v$),
            ('chk_caregiver_status',  'caregiver_status',   $v$'has','none'$v$)
        ) AS t(cname, col, allowed)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'nursing_admit_records'::regclass AND conname = c.cname
        ) THEN
            EXECUTE format(
                'ALTER TABLE nursing_admit_records ADD CONSTRAINT %I CHECK (%I IS NULL OR %I IN (%s))',
                c.cname, c.col, c.col, c.allowed
            );
        END IF;
    END LOOP;
END $$;

COMMENT ON COLUMN nursing_admit_records.readmit_28_days IS
    'รับเข้ามาภายหลังจำหน่าย 28 วันด้วยโรคเดิม — ใช้เฝ้าระวังการกลับมานอนซ้ำ';
COMMENT ON COLUMN nursing_admit_records.initial_symptoms IS
    'อาการแรกรับที่หอผู้ป่วย — ต่างจาก chief_complaint ซึ่งเป็นอาการที่ทำให้มาโรงพยาบาล';
COMMENT ON COLUMN nursing_admit_records.chronic_diseases IS
    'โรคประจำตัวที่ติ๊กไว้ คั่นด้วยจุลภาค เช่น DM,HT — ที่ไม่อยู่ในรายการให้เขียนใน chronic_other';
