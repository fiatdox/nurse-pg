-- อัตราค่าตอบแทนต่อเวร แยกตามกลุ่มตำแหน่ง
--
-- ตาราง staff_position_rates มีอยู่ก่อนแล้วแต่ไม่เคยถูกใช้ (0 แถว) และไม่มีโค้ดอ้างถึง
-- ไฟล์นี้ตรึงความหมายของคอลัมน์ให้ชัด แล้วเติมร่องรอยการแก้ไข
-- ไม่มีการลบหรือเปลี่ยนชนิดคอลัมน์เดิม
--
-- shift_code = nurse_shift_types.code (M, M_OT, M_OT4, A, ..., N_OT4)
-- คือใช้รหัสเวรชุดเดียวกับที่ nurse_shift_assignments บันทึกไว้ตอนจัดเวร
-- ทำให้คิดเงินได้ด้วยการ join ตรงๆ ไม่ต้องแปลงรหัสกลางทาง
--
-- เลือกเก็บ OT เป็นรหัสเวรของตัวเอง ไม่ใช่คอลัมน์แยก เพราะ OT มีสองแบบ (8 ชม. / 4 ชม.)
-- ถ้าใช้คอลัมน์ amount_ot จะเก็บได้แบบเดียว และ OT4 จะไม่มีที่อยู่

ALTER TABLE staff_position_rates
    ADD COLUMN IF NOT EXISTS updated_at timestamp,
    ADD COLUMN IF NOT EXISTS updated_by varchar(50);

-- ค่าตอบแทนติดลบไม่มีความหมาย และถ้าหลุดเข้าไปจะทำให้ยอดรวมของทั้งหอผู้ป่วยผิด
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'staff_position_rates'::regclass AND conname = 'ck_rate_amount_non_negative'
    ) THEN
        ALTER TABLE staff_position_rates
            ADD CONSTRAINT ck_rate_amount_non_negative CHECK (amount >= 0);
    END IF;
END $$;

COMMENT ON COLUMN staff_position_rates.users_position_id IS
    'อ้างถึง staff_position.staff_position_id (RN/TN/PN) — ชื่อคอลัมน์เดิมชวนเข้าใจผิด แต่ FK ชี้ไปที่ staff_position';
COMMENT ON COLUMN staff_position_rates.shift_code IS
    'รหัสเวรจาก nurse_shift_types.code — ชุดเดียวกับที่ nurse_shift_assignments ใช้';
COMMENT ON COLUMN staff_position_rates.amount IS
    'ค่าตอบแทนต่อหนึ่งเวร (บาท)';
COMMENT ON COLUMN staff_position_rates.amount_ot IS
    'ไม่ได้ใช้ — OT เก็บเป็นรหัสเวรของตัวเอง (M_OT, M_OT4, ...) คงคอลัมน์ไว้เฉยๆ ไม่ลบ';
