-- เพิ่มความเร่งด่วน "ยากลับบ้าน" ให้ใบสั่งยาจากหอผู้ป่วย
--
-- ผู้ป่วยนั่งรอกลับบ้านอยู่ที่หอ ยาที่ยังไม่ได้จึงกลายเป็นเวลารอของคนที่พร้อมกลับแล้ว
-- ด่วนกว่าใบปกติ แต่ไม่ใช่เรื่องฉุกเฉินทางคลินิกแบบ STAT
-- จึงเป็นระดับที่สามไม่ใช่เอาไปรวมกับ STAT ซึ่งจะทำให้เสียงเตือนฉุกเฉินดังจนไม่มีใครสนใจ

ALTER TABLE rx_orders DROP CONSTRAINT IF EXISTS rx_orders_priority_check;

ALTER TABLE rx_orders ADD CONSTRAINT rx_orders_priority_check
    CHECK (priority IN ('routine', 'discharge', 'stat'));
