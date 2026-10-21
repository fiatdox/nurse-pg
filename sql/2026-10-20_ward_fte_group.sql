-- หอผู้ป่วยที่นับภาระงานรวมเป็นหน่วยเดียวกัน
-- ฐานข้อมูล: nurse

/*
  NICU กับ Nursery ใช้พยาบาลทีมเดียวกัน ดูแลผู้ป่วยกลุ่มเดียวกัน
  แค่แยกห้องตามระดับอาการ ในระบบจึงเป็นสองหอ (ward 31 กับ ward 3)

  ถ้าคิด FTE แยกหอ ต้องจัดตารางเวรสองที่ และตัวเลขทั้งสองฝั่งผิด
  ฝั่งหนึ่งมีผู้ป่วยแต่ไม่มีคน อีกฝั่งมีคนแต่ภาระงานไม่ครบ

  fte_group ชี้ไปที่ "หอหลัก" ของหน่วย หอหลักเองปล่อยเป็น NULL
  - การลงข้อมูลผู้ป่วย ใบสั่งยา สั่งอาหาร ยังแยกหอตามห้องจริงเหมือนเดิม
  - FTE / product / dashboard / การ์ดสรุปในหน้าลงประจำวัน คิดรวมทุกหอในหน่วย
  - จัดตารางเวรที่หอหลัก (ถ้ามีเวรที่ลงไว้ที่หอรอง ก็ยังถูกนับรวม)
  - ค่าน้ำหนักทั่วไป/วิกฤต ใช้ของหอหลัก

  ชี้ได้ชั้นเดียว หอหลักต้องไม่ชี้ต่อไปที่อื่น โค้ดอ่านแค่ชั้นเดียว
*/

BEGIN;

ALTER TABLE ward ADD COLUMN IF NOT EXISTS fte_group smallint REFERENCES ward (ward);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ward_fte_group_not_self') THEN
        ALTER TABLE ward ADD CONSTRAINT ck_ward_fte_group_not_self CHECK (fte_group IS NULL OR fte_group <> ward);
    END IF;
END $$;

COMMENT ON COLUMN ward.fte_group IS
    'หอหลักที่หอนี้นับภาระงาน/FTE รวมด้วย NULL = หอนี้เป็นหอหลักหรือไม่ได้รวมกับใคร';

-- NICU นับรวมกับ Nursery (หอหลัก) อ้างด้วยรหัส HIS ซึ่งตรงกันทุกเครื่อง
UPDATE ward
SET fte_group = (SELECT ward FROM ward WHERE his_code = '07' AND ward_name = 'Nursery')
WHERE his_code = '35' AND ward_name = 'NICU';

COMMIT;
