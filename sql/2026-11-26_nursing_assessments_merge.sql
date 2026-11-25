-- รวมแบบประเมินที่ให้คะแนน 4 ชนิดไว้ตารางเดียว
-- ฐานข้อมูล: nurse
--
-- แทนตารางเดิม 4 ตาราง (ทุกตารางมี 0 แถว และไม่มีโค้ด backend หรือ foreign key อ้างถึง ตรวจเมื่อ 2026-11-26):
--   nursing_braden_records         → assessment_type = 'braden'
--   nursing_fall_risk_records      → assessment_type = 'fall_risk'
--   nursing_gcs_records            → assessment_type = 'gcs'
--   nursing_mental_health_records  → assessment_type = 'mental_health'
--
-- คะแนนรายข้อเก็บใน items (jsonb) เช่น
--   braden:        {"sensory_perception":3,"moisture":4,"activity":2,"mobility":3,"nutrition":3,"friction_shear":2}
--   fall_risk:     {"history_of_falling":25,"secondary_diagnosis":15,"ambulatory_aid":0,"iv_heparin_lock":20,"gait":10,"mental_status":0}
--   gcs:           {"eye_opening":4,"verbal_response":5,"motor_response":6}
--   mental_health: {"q1":1,"q2":0,...,"q9":0}
-- ข้อมูลเฉพาะชนิดที่ไม่ใช่คะแนนเก็บใน details (jsonb) เช่น
--   gcs:           {"pupil_left":3,"pupil_right":3,"pupil_reaction_left":"brisk","pupil_reaction_right":"brisk"}
--   mental_health: {"assessment_tool":"PHQ-9","mood":"...","sleep_pattern":"...","appetite":"...","social_interaction":"...","referral":"..."}

CREATE TABLE IF NOT EXISTS nursing_assessments (
    id               bigserial PRIMARY KEY,
    an               varchar(20)  NOT NULL,
    ward_code        varchar(20),
    ward_name        varchar(200),
    assessment_type  varchar(20)  NOT NULL CHECK (assessment_type IN ('braden', 'fall_risk', 'gcs', 'mental_health')),
    record_datetime  timestamp    NOT NULL,
    shift            varchar(10),
    items            jsonb        NOT NULL DEFAULT '{}'::jsonb,
    total_score      smallint,
    risk_level       varchar(30),
    interventions    text,
    details          jsonb        NOT NULL DEFAULT '{}'::jsonb,
    note             text,
    staff_id         varchar(50),
    nurse_name       varchar(200),
    created_at       timestamp NOT NULL DEFAULT now(),
    created_by       varchar(100),
    updated_at       timestamp NOT NULL DEFAULT now(),
    updated_by       varchar(100),
    is_deleted       boolean   NOT NULL DEFAULT false
);
COMMENT ON TABLE nursing_assessments IS 'แบบประเมินที่ให้คะแนน: Braden, Fall Risk, GCS, Mental Health (คะแนนรายข้อใน items)';

CREATE INDEX IF NOT EXISTS idx_nursing_assessments_an
    ON nursing_assessments (an, assessment_type, record_datetime DESC) WHERE NOT is_deleted;

-- ---------------------------------------------------------------------------
-- ตารางเดิมที่เลิกใช้ — รันเองหลังตรวจว่ายังเป็น 0 แถว
-- ---------------------------------------------------------------------------
-- SELECT 'braden', count(*) FROM nursing_braden_records
-- UNION ALL SELECT 'fall_risk', count(*) FROM nursing_fall_risk_records
-- UNION ALL SELECT 'gcs', count(*) FROM nursing_gcs_records
-- UNION ALL SELECT 'mental_health', count(*) FROM nursing_mental_health_records
-- UNION ALL SELECT 'io', count(*) FROM nursing_io_records;
--
-- DROP TABLE IF EXISTS nursing_braden_records;
-- DROP TABLE IF EXISTS nursing_fall_risk_records;
-- DROP TABLE IF EXISTS nursing_gcs_records;
-- DROP TABLE IF EXISTS nursing_mental_health_records;
-- DROP TABLE IF EXISTS nursing_io_records;            -- แทนด้วยฟอร์มปรอท (nursing_graphic_shift)
