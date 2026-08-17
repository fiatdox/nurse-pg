-- อัตรากำลังต่อเวรของแต่ละหอผู้ป่วย
--
-- กำหนดว่าหอผู้ป่วยหนึ่ง เวรหนึ่ง กลุ่มตำแหน่งหนึ่ง ขึ้นได้กี่คน
-- ใช้ตรวจตอนจัดเวรว่าลงเกินโควตาไหม และใช้เทียบกับกำลังคนจริงในรายงาน FTE
--
-- shift_code ใช้รหัสชุดเดียวกับ nurse_shift_types เหมือนหน้าอัตราค่าตอบแทน
-- (M, M_OT, M_OT4, A, ..., N_OT4) เพราะโควตา OT ต่างจากโควตาเวรปกติ
-- ถ้าเก็บแค่ เช้า/บ่าย/ดึก จะบอกไม่ได้ว่าให้ขึ้น OT ได้กี่คน
--
-- ward เป็น smallint ให้ตรงกับ ward_staffs.ward และ nurse_shift_assignments.ward

CREATE TABLE IF NOT EXISTS ward_shift_quotas (
    ward_shift_quota_id serial PRIMARY KEY,
    ward              smallint NOT NULL,
    staff_position_id smallint NOT NULL REFERENCES staff_position (staff_position_id),
    shift_code        varchar(20) NOT NULL,
    -- จำนวนคนที่ขึ้นเวรนี้ได้ 0 = ไม่ให้ขึ้นเวรนี้เลย ส่วนไม่มีแถว = ยังไม่ได้กำหนด
    quota             smallint NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT NOW(),
    updated_at timestamp,
    updated_by varchar(50),
    CONSTRAINT uq_ward_shift_quota UNIQUE (ward, staff_position_id, shift_code),
    CONSTRAINT ck_ward_shift_quota_non_negative CHECK (quota >= 0)
);

CREATE INDEX IF NOT EXISTS ix_wsq_ward ON ward_shift_quotas (ward);

COMMENT ON TABLE ward_shift_quotas IS
    'อัตรากำลังต่อเวร แยกตามหอผู้ป่วย กลุ่มตำแหน่ง และรหัสเวร';
COMMENT ON COLUMN ward_shift_quotas.shift_code IS
    'รหัสเวรจาก nurse_shift_types.code — ชุดเดียวกับที่ nurse_shift_assignments ใช้';
COMMENT ON COLUMN ward_shift_quotas.quota IS
    'จำนวนคนที่ขึ้นเวรนี้ได้ — 0 คือไม่ให้ขึ้น ต่างจากการไม่มีแถวซึ่งแปลว่ายังไม่ได้กำหนด';
