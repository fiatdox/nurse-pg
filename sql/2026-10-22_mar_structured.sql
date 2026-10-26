-- บันทึกการให้ยา (MAR) แบบมีโครงสร้าง ให้วิเคราะห์เชิงลึกได้
-- ฐานข้อมูล: nurse

/*
  ตารางสองตัวนี้สร้างไว้ก่อนแต่ยังไม่มีใครใช้ (0 แถว) ข้อมูลเกือบทุกช่องเป็นข้อความอิสระ
  ขนาดยา '2g' ความถี่ 'q 6 hr prn' เหตุผลที่งดให้ยาเป็นประโยคที่พิมพ์เอง
  เก็บแบบนั้นแล้วตอบคำถามพื้นฐานของงานบริหารความปลอดภัยด้านยาไม่ได้เลย:

    - ให้ยาตรงเวลากี่เปอร์เซ็นต์ ช้าไปกี่นาที          ← ต้องรู้ "เวลาที่ควรให้" ของแต่ละมื้อ
    - มื้อไหนไม่มีบันทึกเลย (missed dose)             ← ต้องรู้ว่าคำสั่งนี้มีกี่มื้อต่อวัน เวลาไหน
    - งดให้ยาเพราะอะไรมากที่สุด                       ← เหตุผลต้องเป็นรหัส นับกลุ่มได้
    - ยาความเสี่ยงสูงมีการตรวจสอบซ้ำครบไหม           ← ต้องมีธงยาความเสี่ยงสูงและผู้ตรวจซ้ำ
    - ยา PRN ได้ผลไหม ประเมินซ้ำครบไหม              ← ต้องมีคะแนนก่อน/หลัง
    - คำสั่งยาที่พยาบาลคัดลอกมาตรวจทานแล้วหรือยัง    ← ต้องมีผู้ตรวจทานคนที่สอง

  จึงเพิ่มช่องที่เป็นโครงสร้าง โดยคงช่องข้อความเดิมไว้เป็นข้อความแสดงผลที่ server ประกอบให้
  (dose = '2 g', frequency = 'BID 09:00, 21:00') หน้าจอและรายงานเก่าที่อ่านช่องเดิมจึงไม่พัง

  คำสั่งยาพยาบาลเป็นผู้คัดลอกจากคำสั่งแพทย์มาลงเอง (ยังไม่ดึงจาก HIS)
  จึงต้องมีพยาบาลวิชาชีพอีกคนตรวจทาน (verified_by) และนับได้ว่าคำสั่งไหนยังไม่ผ่านการตรวจทาน
*/

BEGIN;

/* ───── คำสั่งยา ───── */

ALTER TABLE nursing_medication_orders
    ADD COLUMN IF NOT EXISTS hn                     varchar(9),
    ADD COLUMN IF NOT EXISTS dose_value             numeric(10,3),
    ADD COLUMN IF NOT EXISTS dose_unit              varchar(20),
    /* OD BID TID QID Q4H Q6H Q8H Q12H HS = มีมื้อประจำ · STAT ONCE = ครั้งเดียว · PRN = เมื่อมีอาการ */
    ADD COLUMN IF NOT EXISTS frequency_code         varchar(10),
    /* เวลาที่ต้องให้ในแต่ละวัน — แหล่งของ "มื้อที่ควรได้" ทั้งหมด null สำหรับ PRN/STAT/ONCE */
    ADD COLUMN IF NOT EXISTS schedule_times         time[],
    ADD COLUMN IF NOT EXISTS start_datetime         timestamp,
    /* ยาที่ต้องตรงเวลาเข้ม (เช่น antibiotic บางตัว insulin) ช่วงตรงเวลา ±30 นาที ยาทั่วไป ±60 นาที ตามแนว ISMP */
    ADD COLUMN IF NOT EXISTS time_critical          boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS high_alert             boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS drug_class             varchar(30),
    ADD COLUMN IF NOT EXISTS prn_min_interval_hours numeric(4,1),
    ADD COLUMN IF NOT EXISTS prn_max_per_day        smallint,
    ADD COLUMN IF NOT EXISTS created_by_name        varchar(150),
    ADD COLUMN IF NOT EXISTS verified_by            varchar(20),
    ADD COLUMN IF NOT EXISTS verified_by_name       varchar(150),
    ADD COLUMN IF NOT EXISTS verified_at            timestamp,
    ADD COLUMN IF NOT EXISTS discontinued_at        timestamp,
    ADD COLUMN IF NOT EXISTS discontinued_by        varchar(20),
    ADD COLUMN IF NOT EXISTS discontinue_reason     varchar(300),
    ADD COLUMN IF NOT EXISTS deleted_by             varchar(20),
    ADD COLUMN IF NOT EXISTS delete_reason          varchar(300);

ALTER TABLE nursing_medication_orders
    DROP CONSTRAINT IF EXISTS chk_medorder_route,
    ADD CONSTRAINT chk_medorder_route CHECK (route IN ('PO','SL','IV','IM','SC','ID','PR','INH','NEB','TOP','EYE','EAR','NASAL','NG','PV','OTHER')),
    DROP CONSTRAINT IF EXISTS chk_medorder_freq,
    ADD CONSTRAINT chk_medorder_freq CHECK (frequency_code IS NULL OR frequency_code IN
        ('OD','BID','TID','QID','Q4H','Q6H','Q8H','Q12H','HS','STAT','ONCE','PRN')),
    DROP CONSTRAINT IF EXISTS chk_medorder_dose,
    ADD CONSTRAINT chk_medorder_dose CHECK (dose_value IS NULL OR dose_value > 0),
    DROP CONSTRAINT IF EXISTS chk_medorder_schedule,
    ADD CONSTRAINT chk_medorder_schedule CHECK (
        frequency_code IS NULL
        OR (frequency_code IN ('STAT','ONCE','PRN') AND schedule_times IS NULL)
        OR (frequency_code NOT IN ('STAT','ONCE','PRN') AND cardinality(schedule_times) > 0)),
    DROP CONSTRAINT IF EXISTS chk_medorder_prn,
    ADD CONSTRAINT chk_medorder_prn CHECK (prn = (frequency_code = 'PRN') OR frequency_code IS NULL),
    DROP CONSTRAINT IF EXISTS chk_medorder_verify,
    ADD CONSTRAINT chk_medorder_verify CHECK (verified_by IS NULL OR verified_by <> created_by);

CREATE INDEX IF NOT EXISTS idx_medorder_ward_start ON nursing_medication_orders (ward_code, start_date) WHERE is_deleted IS NOT TRUE;

/* ───── การให้ยาแต่ละครั้ง ───── */

ALTER TABLE nursing_medication_admins
    /* มื้อที่บันทึกนี้ตอบ — null สำหรับ PRN · ใช้วัดความตรงเวลาและหามื้อที่ไม่มีบันทึก */
    ADD COLUMN IF NOT EXISTS scheduled_at           timestamp,
    ADD COLUMN IF NOT EXISTS dose_value             numeric(10,3),
    ADD COLUMN IF NOT EXISTS dose_unit              varchar(20),
    /* เหตุผลเมื่อไม่ได้ให้ยา (held / refused / omitted) เป็นรหัส นับกลุ่มได้ · held_reason เดิมเป็นรายละเอียดเพิ่ม */
    ADD COLUMN IF NOT EXISTS reason_code            varchar(30),
    ADD COLUMN IF NOT EXISTS double_checked_by      varchar(20),
    ADD COLUMN IF NOT EXISTS double_checked_by_name varchar(150),
    ADD COLUMN IF NOT EXISTS prn_indication         varchar(200),
    /* คะแนนอาการก่อน/หลังให้ยา PRN (เช่น pain 0-10) ใช้วัดผลของยา */
    ADD COLUMN IF NOT EXISTS pre_score              smallint,
    ADD COLUMN IF NOT EXISTS post_score             smallint,
    ADD COLUMN IF NOT EXISTS reassessed_at          timestamp,
    ADD COLUMN IF NOT EXISTS adverse_reaction       boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS adverse_note           varchar(500),
    ADD COLUMN IF NOT EXISTS deleted_by             varchar(20),
    ADD COLUMN IF NOT EXISTS delete_reason          varchar(300);

ALTER TABLE nursing_medication_admins
    DROP CONSTRAINT IF EXISTS fk_medadmin_order,
    ADD CONSTRAINT fk_medadmin_order FOREIGN KEY (order_id) REFERENCES nursing_medication_orders(id),
    DROP CONSTRAINT IF EXISTS chk_medadmin_reason,
    ADD CONSTRAINT chk_medadmin_reason CHECK (
        (status = 'given' AND reason_code IS NULL)
        OR (status <> 'given' AND reason_code IN
            ('NPO','PATIENT_REFUSED','DRUG_UNAVAILABLE','HOLD_PARAMETER','PATIENT_AWAY',
             'DOCTOR_HOLD','ADVERSE_REACTION','VOMITING','OTHER'))),
    DROP CONSTRAINT IF EXISTS chk_medadmin_scores,
    ADD CONSTRAINT chk_medadmin_scores CHECK (
        (pre_score IS NULL OR pre_score BETWEEN 0 AND 10) AND (post_score IS NULL OR post_score BETWEEN 0 AND 10)),
    DROP CONSTRAINT IF EXISTS chk_medadmin_doublecheck,
    ADD CONSTRAINT chk_medadmin_doublecheck CHECK (double_checked_by IS NULL OR double_checked_by <> staff_id);

/* หนึ่งมื้อมีบันทึกได้รายการเดียว ไม่งั้นมื้อเดียวกันจะถูกนับว่าให้ยาสองครั้ง */
CREATE UNIQUE INDEX IF NOT EXISTS ux_medadmin_slot
    ON nursing_medication_admins (order_id, scheduled_at)
    WHERE is_deleted IS NOT TRUE AND scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_medadmin_ward_time ON nursing_medication_admins (ward_code, admin_datetime) WHERE is_deleted IS NOT TRUE;

COMMIT;
