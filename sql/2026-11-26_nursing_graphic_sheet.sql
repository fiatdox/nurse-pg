-- ฟอร์มปรอท (graphic sheet) — ส่วนที่ยังไม่มีที่เก็บในระบบ
-- ฐานข้อมูล: nurse · สร้างตารางใหม่สองตาราง ไม่แตะตารางเดิม
--
-- สัญญาณชีพ ความปวด และยา ดึงจากตารางที่มีอยู่แล้ว (nursing_vital_records, nursing_medication_admins)
-- ตารางนี้เก็บเฉพาะแถวของฟอร์มที่ยังไม่มีที่บันทึก:
--   รายเวร: สารน้ำเข้า (oral, parenteral, อื่น ๆ) และออก (urine, drainage, อื่น ๆ)
--   รายวัน: stool, จำนวนครั้งปัสสาวะ, ประเภทผู้ป่วย, น้ำหนัก ส่วนสูง อาหาร, วันผ่าตัด

CREATE TABLE IF NOT EXISTS nursing_graphic_shift (
    id              bigserial PRIMARY KEY,
    an              varchar(20)  NOT NULL,
    ward_code       varchar(20),
    ward_name       varchar(200),
    record_date     date         NOT NULL,
    shift           varchar(10)  NOT NULL CHECK (shift IN ('ดึก', 'เช้า', 'บ่าย')),
    oral_ml         integer CHECK (oral_ml BETWEEN 0 AND 20000),
    parenteral_ml   integer CHECK (parenteral_ml BETWEEN 0 AND 20000),
    intake_other1_label varchar(60),
    intake_other1_ml    integer CHECK (intake_other1_ml BETWEEN 0 AND 20000),
    intake_other2_label varchar(60),
    intake_other2_ml    integer CHECK (intake_other2_ml BETWEEN 0 AND 20000),
    urine_ml        integer CHECK (urine_ml BETWEEN 0 AND 20000),
    drainage_ml     integer CHECK (drainage_ml BETWEEN 0 AND 20000),
    output_other1_label varchar(60),
    output_other1_ml    integer CHECK (output_other1_ml BETWEEN 0 AND 20000),
    output_other2_label varchar(60),
    output_other2_ml    integer CHECK (output_other2_ml BETWEEN 0 AND 20000),
    created_at      timestamp NOT NULL DEFAULT now(),
    created_by      varchar(100),
    created_by_name varchar(200),
    updated_at      timestamp NOT NULL DEFAULT now(),
    updated_by      varchar(100),
    updated_by_name varchar(200),
    UNIQUE (an, record_date, shift)
);
COMMENT ON TABLE nursing_graphic_shift IS 'ฟอร์มปรอท: สารน้ำเข้า-ออกรายเวร (ดึก 00-08 · เช้า 08-16 · บ่าย 16-24)';

CREATE TABLE IF NOT EXISTS nursing_graphic_daily (
    id              bigserial PRIMARY KEY,
    an              varchar(20)  NOT NULL,
    ward_code       varchar(20),
    ward_name       varchar(200),
    record_date     date         NOT NULL,
    stool_count     smallint CHECK (stool_count BETWEEN 0 AND 50),
    urine_count     smallint CHECK (urine_count BETWEEN 0 AND 50),
    patient_type    varchar(4) CHECK (patient_type IN ('CI', 'SI', 'MI', 'CL')),
    weight_kg       numeric(5,1) CHECK (weight_kg BETWEEN 0 AND 400),
    height_cm       numeric(5,1) CHECK (height_cm BETWEEN 0 AND 250),
    diet            varchar(100),
    is_operation_day boolean NOT NULL DEFAULT false,
    note            varchar(200),
    created_at      timestamp NOT NULL DEFAULT now(),
    created_by      varchar(100),
    created_by_name varchar(200),
    updated_at      timestamp NOT NULL DEFAULT now(),
    updated_by      varchar(100),
    updated_by_name varchar(200),
    UNIQUE (an, record_date)
);
COMMENT ON TABLE nursing_graphic_daily IS 'ฟอร์มปรอท: ข้อมูลรายวัน (stool, ปัสสาวะ, ประเภทผู้ป่วย CI/SI/MI/CL, Wt/Ht/Diet, วันผ่าตัด)';
COMMENT ON COLUMN nursing_graphic_daily.is_operation_day IS 'วันที่ผ่าตัด — ใช้นับ "Day after operation" ในฟอร์ม';

CREATE INDEX IF NOT EXISTS idx_nursing_graphic_shift_an ON nursing_graphic_shift (an, record_date);
CREATE INDEX IF NOT EXISTS idx_nursing_graphic_daily_an ON nursing_graphic_daily (an, record_date);
