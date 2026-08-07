-- แผนการพยาบาลแบบ Focus list / CNPG
--
-- ต่างจาก nursing_care_plans เดิมตรงที่กิจกรรมการพยาบาลไม่ได้พิมพ์รายคน
-- แต่มาจากแม่แบบที่หอผู้ป่วยเขียนไว้ล่วงหน้า พยาบาลเลือก Focus แล้วติ๊กผลประเมิน
-- คอลัมน์ผลประเมินจึงเป็นข้อมูลที่ "นับได้" เช่น อัตราการใส่ท่อช่วยหายใจซ้ำใน 48 ชม.
-- ซึ่งเป็นตัวชี้วัดที่ text ก้อนเดียวตอบไม่ได้
--
-- ตาราง nursing_care_plans เดิมไม่ถูกแตะต้อง ข้อมูลที่ลงนามไปแล้วยังอยู่ครบ

-- ---------- แม่แบบ ----------
CREATE TABLE IF NOT EXISTS care_plan_templates (
    id              bigserial PRIMARY KEY,
    code            varchar(40)  NOT NULL,
    title           text         NOT NULL,      -- Focus เช่น "ถอดท่อช่วยหายใจ (extubation)"
    objective       text,                       -- วัตถุประสงค์
    -- หอผู้ป่วยที่เป็นเจ้าของเนื้อหา หออื่นหยิบไปใช้ได้แต่แก้ไม่ได้
    owner_ward_code varchar(20)  NOT NULL,
    owner_ward_name varchar(100),
    body            jsonb        NOT NULL DEFAULT '{"sections":[]}'::jsonb,
    version         integer      NOT NULL DEFAULT 1,
    -- draft = ยังแก้อยู่ ไม่ขึ้นให้เลือก · published = ใช้ได้ · retired = เลิกใช้ ของเก่ายังอ่านได้
    status          varchar(10)  NOT NULL DEFAULT 'draft',
    created_at      timestamp    NOT NULL DEFAULT now(),
    created_by      varchar(50),
    updated_at      timestamp,
    updated_by      varchar(50),
    is_deleted      boolean      NOT NULL DEFAULT false
);

-- รหัสห้ามซ้ำในหมู่แม่แบบที่ยังไม่ถูกลบ ใช้อ้างอิงจากบันทึกและรายงาน
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpt_code
    ON care_plan_templates (lower(btrim(code))) WHERE is_deleted IS NOT TRUE;

CREATE INDEX IF NOT EXISTS ix_cpt_ward   ON care_plan_templates (owner_ward_code);
CREATE INDEX IF NOT EXISTS ix_cpt_status ON care_plan_templates (status);

-- ---------- ประวัติการแก้แม่แบบ ----------
-- แม่แบบคือเนื้อหาเชิงวิชาการที่ผ่านการรับรอง การแก้ต้องตามรอยได้ว่าใครแก้อะไรเมื่อไร
CREATE TABLE IF NOT EXISTS care_plan_template_revisions (
    id          bigserial PRIMARY KEY,
    template_id bigint      NOT NULL REFERENCES care_plan_templates(id),
    version     integer     NOT NULL,
    snapshot    jsonb       NOT NULL,
    action      varchar(20) NOT NULL,   -- create / update / publish / retire / delete
    reason      varchar(500),
    changed_by  varchar(50),
    changed_at  timestamp   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_cptr_template ON care_plan_template_revisions (template_id, version DESC);

-- ---------- บันทึกรายผู้ป่วย ----------
CREATE TABLE IF NOT EXISTS nursing_focus_records (
    id               bigserial PRIMARY KEY,
    an               varchar(20)  NOT NULL,
    ward_code        varchar(20),
    ward_name        varchar(100),
    staff_id         varchar(20),
    nurse_name       varchar(200),

    template_id      bigint       NOT NULL REFERENCES care_plan_templates(id),
    template_code    varchar(40)  NOT NULL,
    template_title   text         NOT NULL,
    template_version integer      NOT NULL,
    -- สำเนาโครงแม่แบบ ณ เวลาที่บันทึก
    -- ถ้าอ้างอิงแม่แบบอย่างเดียว การแก้แม่แบบในอนาคตจะย้อนไปเปลี่ยนเวชระเบียนเก่า ซึ่งผิด
    structure        jsonb        NOT NULL,
    answers          jsonb        NOT NULL DEFAULT '{}'::jsonb,

    record_datetime  timestamp    NOT NULL,
    shift            varchar(10),
    -- draft = ยังทำหัตถการไม่จบ แก้ได้อิสระ · final = ปิดใบแล้ว เข้าเวชระเบียน
    status           varchar(10)  NOT NULL DEFAULT 'draft',
    completed_at     timestamp,
    note             text,
    request_id       uuid,

    created_at       timestamp    NOT NULL DEFAULT now(),
    created_by       varchar(50),
    updated_at       timestamp,
    updated_by       varchar(50),
    is_deleted       boolean      NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ix_nfr_an    ON nursing_focus_records (an, record_datetime DESC);
CREATE INDEX IF NOT EXISTS ix_nfr_ward  ON nursing_focus_records (ward_code, record_datetime DESC);
CREATE INDEX IF NOT EXISTS ix_nfr_tpl   ON nursing_focus_records (template_id);

-- กันกดบันทึกซ้ำจากการกดปุ่มรัว เช่นเดียวกับสัญญาณชีพและบันทึกทางการพยาบาล
CREATE UNIQUE INDEX IF NOT EXISTS uq_nfr_request
    ON nursing_focus_records (request_id) WHERE request_id IS NOT NULL;

-- ---------- ประวัติการแก้บันทึกที่ปิดใบแล้ว ----------
-- กติกาเดียวกับ nursing_progress_note_revisions: ร่างแก้ได้อิสระ
-- แต่ใบที่ปิดแล้วถือเป็นเวชระเบียน แก้ต้องมีเหตุผลและเก็บฉบับเดิมไว้ทุกครั้ง
CREATE TABLE IF NOT EXISTS nursing_focus_record_revisions (
    id          bigserial PRIMARY KEY,
    record_id   bigint      NOT NULL REFERENCES nursing_focus_records(id),
    revision_no smallint    NOT NULL,
    snapshot    jsonb       NOT NULL,
    action      varchar(20) NOT NULL,   -- complete / amend / cancel
    reason      varchar(500),
    changed_by  varchar(50),
    changed_at  timestamp   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_nfrr_record ON nursing_focus_record_revisions (record_id, revision_no DESC);

ALTER TABLE nursing_focus_records
    ADD COLUMN IF NOT EXISTS revision_no smallint NOT NULL DEFAULT 0;

-- ---------- บันทึกย้อนหลัง ----------
-- record_datetime = เวลาที่เหตุการณ์เกิดจริง · entered_at = เวลาที่นั่งพิมพ์
-- ต้องแยกกัน ไม่งั้นอ่านย้อนหลังไม่รู้ว่าบันทึกสดหรือมาลงทีหลัง
-- กติกาเดียวกับ nursing_vital_records: ย้อนเกิน 24 ชม. ต้องมีเหตุผล
ALTER TABLE nursing_focus_records
    ADD COLUMN IF NOT EXISTS entered_at        timestamp,
    ADD COLUMN IF NOT EXISTS late_entry_reason text;

-- ---------- การยกเลิกใบที่เข้าเวชระเบียนแล้ว ----------
-- ร่างที่ยังไม่ปิดยกเลิกได้ด้วย is_deleted เพราะไม่เคยเป็นเวชระเบียน หายไปได้
-- แต่ใบที่ปิดแล้วต้องคงอยู่ในรายการพร้อมตราประทับ status = 'cancelled'
-- ถ้าซ่อนทิ้ง จะอ่านย้อนหลังไม่รู้เลยว่าเคยมีใบนี้และถูกยกเลิกด้วยเหตุผลใด
ALTER TABLE nursing_focus_records
    ADD COLUMN IF NOT EXISTS cancelled_at  timestamp,
    ADD COLUMN IF NOT EXISTS cancelled_by  varchar(50),
    ADD COLUMN IF NOT EXISTS cancel_reason varchar(500);

-- กลุ่มงานของผู้บันทึก ณ เวลาที่บันทึก (majors.name ใน core_kon)
-- เก็บติดไปกับใบเหมือน nurse_name ไม่ join ตอนอ่าน
-- เพราะพยาบาลย้ายกลุ่มงานได้ แต่ใบเก่าต้องคงบอกว่าตอนนั้นสังกัดที่ไหน
ALTER TABLE nursing_focus_records
    ADD COLUMN IF NOT EXISTS nurse_major varchar(200);

-- ชื่อเต็มของผู้แก้ไขล่าสุด — updated_by เก็บ username ซึ่งเป็นเลข 13 หลัก อ่านไม่รู้ว่าใคร
-- ผู้สร้างมีชื่อเต็มอยู่ที่ nurse_name แล้ว จึงเพิ่มเฉพาะฝั่งผู้แก้ไข
ALTER TABLE nursing_focus_records
    ADD COLUMN IF NOT EXISTS updated_by_name   varchar(200),
    ADD COLUMN IF NOT EXISTS cancelled_by_name varchar(200);

-- ชื่อผู้กระทำในทุกตารางประวัติ ด้วยเหตุผลเดียวกัน — หน้าจอต้องอ่านออกว่าใครทำอะไร
-- คอลัมน์ที่เก็บ username ยังอยู่ครบ ใช้ชี้ตัวตนตอนสอบสวนย้อนหลัง เพราะชื่อคนซ้ำกันได้
ALTER TABLE nursing_focus_record_revisions
    ADD COLUMN IF NOT EXISTS changed_by_name varchar(200);

ALTER TABLE care_plan_templates
    ADD COLUMN IF NOT EXISTS created_by_name varchar(200),
    ADD COLUMN IF NOT EXISTS updated_by_name varchar(200);

ALTER TABLE care_plan_template_revisions
    ADD COLUMN IF NOT EXISTS changed_by_name varchar(200);
