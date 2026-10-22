-- ภาระงานและ product ของหน่วยงานที่ไม่ใช่หอผู้ป่วย (ER · วิสัญญี · ห้องผ่าตัด · ห้องคลอด · OPD)
-- ฐานข้อมูล: nurse

/*
  ที่มา: ไฟล์ FTE ของแต่ละงานใน docs/ ปีงบ 2568

  หอผู้ป่วยคิดภาระงานจากยอดผู้ป่วยที่บันทึกในระบบอยู่แล้ว (admission_shift_daily_record)
  แต่หน่วยงานเหล่านี้นับคนละอย่าง — ER นับตามระดับคัดแยก วิสัญญีนับตามชนิดการระงับความรู้สึก
  ห้องผ่าตัดนับ major/minor ห้องคลอดนับคลอดปกติ/C-S/แทรกซ้อน OPD นับ visit รายเดือน
  ทุกไฟล์ใช้สูตรรูปเดียวกันคือ  ภาระงาน = Σ (จำนวนราย × ชั่วโมงต่อราย)
                               product = ภาระงาน ÷ (คนขึ้นเวร × 7) × 100
  ต่างกันแค่ "รายการที่นับ" กับ "ชั่วโมงต่อราย" จึงเก็บเป็นข้อมูล ไม่เขียนสูตรแยกห้าชุด
  หน่วยงานใหม่หรือเกณฑ์ชั่วโมงที่เปลี่ยนในปีหน้า แก้ที่ตาราง ไม่ต้องแก้โปรแกรม

  ไม่ได้เอาหน่วยงานเหล่านี้ไปใส่ตาราง ward เพราะ ward คือหอผู้ป่วยของ HIS
  และถูกใช้ทำรายการหอในหน้ารับผู้ป่วย สั่งอาหาร ส่งใบสั่งยา ฯลฯ
  ใส่ไปแล้ว ER จะโผล่ให้เลือกสั่งอาหารผู้ป่วยในทันที
*/

BEGIN;

CREATE TABLE IF NOT EXISTS work_units (
    work_unit_id   serial       PRIMARY KEY,
    code           varchar(10)  NOT NULL UNIQUE,
    name           varchar(150) NOT NULL,
    /* shift = นับรายวันรายเวร (ด/ช/บ) · month = นับรวมทั้งเดือน (OPD) */
    period         varchar(5)   NOT NULL CHECK (period IN ('shift', 'month')),
    /* หน่วยที่ต้องดูรวมกัน เช่น ห้องตรวจทุกห้องของ OPD — null = ดูเดี่ยว */
    unit_group     varchar(30),
    /*
      สัดส่วนภาระงานของเวร ด/ช/บ (ร้อยละ) ใช้เมื่อยอดที่นับเป็น "ยอดคงพยาบาลปลายเวร"
      ซึ่งเป็นผู้ป่วยกลุ่มเดียวกันทั้งวัน ชั่วโมงการพยาบาลต่อวันจึงต้องแบ่งลงแต่ละเวร (เหมือนหอผู้ป่วย)
      null = ไม่ถ่วง ใช้กับหน่วยที่นับ "รายที่ให้บริการในเวรนั้น" (ER วิสัญญี ห้องผ่าตัด)
      เพราะชั่วโมงต่อรายเป็นชั่วโมงของรายนั้นเต็มๆ ไม่ได้กระจายทั้งวัน
    */
    weight_n       numeric(5,2),
    weight_d       numeric(5,2),
    weight_e       numeric(5,2),
    /*
      รหัสหอ (HIS) ของตารางเวรที่ใช้นับคนขึ้นเวร เช่น ห้องคลอด = '08'
      null = หน่วยนี้ยังไม่ได้จัดเวรในระบบ ให้กรอกจำนวนคนขึ้นเวรเองพร้อมยอดผู้ป่วย
    */
    staff_ward     varchar(5),
    is_active      boolean      NOT NULL DEFAULT true,
    display_order  smallint     NOT NULL DEFAULT 0,
    CHECK ((weight_n IS NULL) = (weight_d IS NULL) AND (weight_d IS NULL) = (weight_e IS NULL))
);

COMMENT ON TABLE work_units IS 'หน่วยงานที่คิด FTE/product จากยอดงานที่กรอกเอง ไม่ใช่จากทะเบียนผู้ป่วยใน';

CREATE TABLE IF NOT EXISTS work_unit_items (
    item_id        serial       PRIMARY KEY,
    work_unit_id   integer      NOT NULL REFERENCES work_units(work_unit_id),
    code           varchar(20)  NOT NULL,
    name           varchar(100) NOT NULL,
    /* ชั่วโมงการพยาบาลต่อราย ตามเกณฑ์ของงานนั้น */
    care_hours     numeric(6,2) NOT NULL CHECK (care_hours >= 0),
    display_order  smallint     NOT NULL DEFAULT 0,
    is_active      boolean      NOT NULL DEFAULT true,
    UNIQUE (work_unit_id, code)
);

COMMENT ON TABLE work_unit_items IS 'รายการที่นับเป็นภาระงานของแต่ละหน่วย และชั่วโมงการพยาบาลต่อราย';

/*
  ยอดงาน — หนึ่งแถวต่อ หน่วย × วัน × เวร × รายการ
  หน่วยรายเดือน (OPD) เก็บที่วันที่ 1 ของเดือน เวร 0
*/
CREATE TABLE IF NOT EXISTS work_unit_counts (
    work_unit_id   integer      NOT NULL REFERENCES work_units(work_unit_id),
    record_date    date         NOT NULL,
    shift_type_id  smallint     NOT NULL CHECK (shift_type_id BETWEEN 0 AND 3),
    item_id        integer      NOT NULL REFERENCES work_unit_items(item_id),
    qty            integer      NOT NULL CHECK (qty >= 0),
    updated_by     varchar(100),
    updated_at     timestamp    NOT NULL DEFAULT now(),
    PRIMARY KEY (work_unit_id, record_date, shift_type_id, item_id)
);

/*
  คนขึ้นเวร สำหรับหน่วยที่ยังไม่ได้จัดเวรในระบบ (staff_ward เป็น null)
  แยกปกติกับ OT ตามแบบฟอร์มเดิม ไม่แยกตำแหน่งเพราะแบบฟอร์มของหน่วยเหล่านี้ไม่ได้แยก
  numeric เพราะ OPD นับเป็นวันทำงานซึ่งมีเศษวัน (เช่น 61.5, 103.24)
*/
CREATE TABLE IF NOT EXISTS work_unit_staff (
    work_unit_id   integer      NOT NULL REFERENCES work_units(work_unit_id),
    record_date    date         NOT NULL,
    shift_type_id  smallint     NOT NULL CHECK (shift_type_id BETWEEN 0 AND 3),
    regular        numeric(7,2) NOT NULL DEFAULT 0 CHECK (regular >= 0),
    ot             numeric(7,2) NOT NULL DEFAULT 0 CHECK (ot >= 0),
    updated_by     varchar(100),
    updated_at     timestamp    NOT NULL DEFAULT now(),
    PRIMARY KEY (work_unit_id, record_date, shift_type_id)
);

/* จำนวนพยาบาลที่มีจริงในเดือน (ช่อง "จำนวนพยาบาลมีจริงเดือนนี้") สำหรับหน่วยที่ไม่ได้จัดเวรในระบบ */
CREATE TABLE IF NOT EXISTS work_unit_headcount (
    work_unit_id   integer      NOT NULL REFERENCES work_units(work_unit_id),
    month          date         NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    nurses         smallint     NOT NULL CHECK (nurses >= 0),
    updated_by     varchar(100),
    updated_at     timestamp    NOT NULL DEFAULT now(),
    PRIMARY KEY (work_unit_id, month)
);

/* ───── ค่าเริ่มต้นจากไฟล์ปีงบ 2568 ───── */

INSERT INTO work_units (code, name, period, unit_group, weight_n, weight_d, weight_e, staff_ward, display_order) VALUES
    ('ER',    'งานอุบัติเหตุและฉุกเฉิน', 'shift', NULL, NULL, NULL, NULL, NULL, 10),
    ('OR',    'งานห้องผ่าตัด',           'shift', NULL, NULL, NULL, NULL, NULL, 20),
    ('ANES',  'งานวิสัญญี',              'shift', NULL, NULL, NULL, NULL, NULL, 30),
    -- ห้องคลอดนับยอดคงพยาบาลปลายเวร จึงถ่วงตามเวร (เชค list FTE: 30/40/30) และมีตารางเวรในระบบแล้ว
    ('LR',    'งานห้องคลอด',             'shift', NULL, 30, 40, 30, '08', 40),
    ('OPD01', 'อายุรกรรม',               'month', 'OPD', NULL, NULL, NULL, NULL, 101),
    ('OPD02', 'จุดคัดแยก',               'month', 'OPD', NULL, NULL, NULL, NULL, 102),
    ('OPD03', 'คลินิกพิเศษ อายุรกรรม',    'month', 'OPD', NULL, NULL, NULL, NULL, 103),
    ('OPD04', 'ทั่วไป',                  'month', 'OPD', NULL, NULL, NULL, NULL, 104),
    ('OPD05', 'ศัลยกรรม',                'month', 'OPD', NULL, NULL, NULL, NULL, 105),
    ('OPD06', 'กระดูก',                  'month', 'OPD', NULL, NULL, NULL, NULL, 106),
    ('OPD07', 'เวชศาสตร์ฟื้นฟู',          'month', 'OPD', NULL, NULL, NULL, NULL, 107),
    ('OPD08', 'คลื่นหัวใจ (EKG)',         'month', 'OPD', NULL, NULL, NULL, NULL, 108),
    ('OPD09', 'ฉีดยา',                   'month', 'OPD', NULL, NULL, NULL, NULL, 109),
    ('OPD10', 'ตา',                      'month', 'OPD', NULL, NULL, NULL, NULL, 110),
    ('OPD11', 'หู คอ จมูก',              'month', 'OPD', NULL, NULL, NULL, NULL, 111),
    ('OPD12', 'เด็ก',                    'month', 'OPD', NULL, NULL, NULL, NULL, 112),
    ('OPD13', 'ตรวจสุขภาพ',              'month', 'OPD', NULL, NULL, NULL, NULL, 113),
    ('OPD14', 'ทางเดินปัสสาวะ',          'month', 'OPD', NULL, NULL, NULL, NULL, 114),
    ('OPD15', 'นิรนาม + TB',             'month', 'OPD', NULL, NULL, NULL, NULL, 115),
    ('OPD16', 'นรีเวช + ANC',            'month', 'OPD', NULL, NULL, NULL, NULL, 116),
    ('OPD17', 'ทานตะวัน',                'month', 'OPD', NULL, NULL, NULL, NULL, 117)
ON CONFLICT (code) DO NOTHING;

INSERT INTO work_unit_items (work_unit_id, code, name, care_hours, display_order)
SELECT u.work_unit_id, v.code, v.name, v.hours, v.ord
FROM (VALUES
    -- ER: ระดับคัดแยก R=3.2, E=2.5, U=1, semi=0.5, non=0.24
    ('ER',   'R',      'Resuscitation',  3.20, 1),
    ('ER',   'E',      'Emergency',      2.50, 2),
    ('ER',   'U',      'Urgent',         1.00, 3),
    ('ER',   'SEMI',   'Semi-urgent',    0.50, 4),
    ('ER',   'NON',    'Non-urgent',     0.24, 5),
    -- ห้องผ่าตัด: NN = 3.6 ทั้ง major และ minor
    ('OR',   'MAJOR',  'Major',          3.60, 1),
    ('OR',   'MINOR',  'Minor',          3.60, 2),
    -- วิสัญญี: GA และ MAC = 3.7 · ห้องพักฟื้น = 0.75
    ('ANES', 'GA',     'GA',             3.70, 1),
    ('ANES', 'MAC',    'MAC',            3.70, 2),
    ('ANES', 'RECOV',  'Recovery',       0.75, 3),
    -- ห้องคลอด: คลอดปกติ = 6 · C/S และภาวะแทรกซ้อน = 4.5
    ('LR',   'NORMAL', 'คลอดปกติ',        6.00, 1),
    ('LR',   'CS',     'C/S',            4.50, 2),
    ('LR',   'COMP',   'ภาวะแทรกซ้อน',    4.50, 3)
) AS v(unit, code, name, hours, ord)
JOIN work_units u ON u.code = v.unit
ON CONFLICT (work_unit_id, code) DO NOTHING;

-- OPD ทุกห้องตรวจ: visit ละ 0.2 ชั่วโมง
INSERT INTO work_unit_items (work_unit_id, code, name, care_hours, display_order)
SELECT work_unit_id, 'VISIT', 'จำนวน visit', 0.20, 1
FROM work_units WHERE unit_group = 'OPD'
ON CONFLICT (work_unit_id, code) DO NOTHING;

COMMIT;
