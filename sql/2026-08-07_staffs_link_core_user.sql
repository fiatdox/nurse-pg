-- ผูกแถวใน staffs กลับไปหาบัญชีจริงใน core_kon.users
--
-- ที่มา: หน้าตั้งค่าเจ้าหน้าที่ประจำหอผู้ป่วยเดิมเลือกจากตาราง staffs ที่พิมพ์ชื่อเข้าไปเอง
-- ทำให้ชื่อซ้ำ/สะกดไม่ตรงกับทะเบียนบุคลากรจริง และไม่รู้ว่าใครคือใครในระบบกลาง
-- เปลี่ยนมาเลือกจาก core_kon.users โดยกรองเฉพาะตำแหน่งที่จับคู่ไว้ใน staff_position_mappings
--
-- ยังคง staff_id เป็นตัวอ้างอิงหลักเหมือนเดิม เพราะ ward_staffs,
-- nurse_shift_assignments และ staff_position_rates ผูกกับ staff_id อยู่แล้ว
-- การเปลี่ยนไปใช้ users.id ตรงๆ จะต้องรื้อทั้งสามตาราง โดยไม่ได้อะไรเพิ่ม
-- staffs จึงกลายเป็น "สำเนาเฉพาะคนที่งานพยาบาลใช้" ที่ชี้กลับไปหาต้นทางได้

ALTER TABLE staffs
    ADD COLUMN IF NOT EXISTS user_id integer;

-- คนหนึ่งต้องมีได้แถวเดียว ไม่งั้นเลือกเข้าหอผู้ป่วยสองรอบจะได้เจ้าหน้าที่ซ้ำ
-- แล้วยอดกำลังคนกับ FTE จะเกินจริง
CREATE UNIQUE INDEX IF NOT EXISTS uq_staffs_user
    ON staffs (user_id) WHERE user_id IS NOT NULL;

COMMENT ON COLUMN staffs.user_id IS
    'อ้างถึง core_kon.users.id — คนละฐานข้อมูล จึงไม่มี FK บังคับ NULL คือแถวเก่าที่พิมพ์ชื่อเข้ามาเอง';
