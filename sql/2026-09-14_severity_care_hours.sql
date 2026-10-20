-- ชั่วโมงการพยาบาลต่อวันของผู้ป่วยแต่ละประเภท ใช้คิด product ตามประเภท
-- ฐานข้อมูล: nurse

/*
  ที่มา: ไฟล์ FTE NS ปี68.xlsx สูตรคอลัมน์ U
      ((t1*1.5 + t2*3.5 + t3*5.5 + t4*7.5 + t5*12) / 3) / (จำนวนคน * 7) * 100

  เก็บเป็นคอลัมน์ในตาราง ไม่ฝังตัวเลขไว้ในโค้ด เพราะเป็นเกณฑ์ของฝ่ายการพยาบาล
  ที่ปรับได้ตามมาตรฐานที่ใช้ในแต่ละปี ถ้าฝังในโค้ดจะต้องแก้โปรแกรมทุกครั้งที่เกณฑ์เปลี่ยน
  และจะไล่ย้อนไม่ได้ว่ารายงานเดือนไหนคิดด้วยเกณฑ์อะไร
*/

BEGIN;

ALTER TABLE admission_severity_level
    ADD COLUMN IF NOT EXISTS care_hours numeric(5,2);

UPDATE admission_severity_level SET care_hours = 1.50 WHERE severity_level_id = 1 AND care_hours IS NULL;
UPDATE admission_severity_level SET care_hours = 3.50 WHERE severity_level_id = 2 AND care_hours IS NULL;
UPDATE admission_severity_level SET care_hours = 5.50 WHERE severity_level_id = 3 AND care_hours IS NULL;
UPDATE admission_severity_level SET care_hours = 7.50 WHERE severity_level_id = 4 AND care_hours IS NULL;
UPDATE admission_severity_level SET care_hours = 12.00 WHERE severity_level_id = 5 AND care_hours IS NULL;

COMMENT ON COLUMN admission_severity_level.care_hours IS
    'ชั่วโมงการพยาบาลต่อผู้ป่วยหนึ่งคนต่อวัน ใช้คิด product ตามประเภท (ค่าจากเกณฑ์ปี 2568: 1.5/3.5/5.5/7.5/12)';

COMMIT;
