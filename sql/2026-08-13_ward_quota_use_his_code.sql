-- แก้รหัสหอผู้ป่วยของตารางอัตรากำลังให้ตรงกับตารางอื่น
--
-- ปัญหา: ระบบนี้มีรหัสหอผู้ป่วยสองชุดอยู่ในตาราง ward เดียวกัน
--     ward.ward     = รหัสภายในของตาราง (1, 2, 3, ...)
--     ward.his_code = รหัสจาก HIS ('00', '01', '09', ...)
-- ตารางอื่นที่เกี่ยวกับกำลังคนใช้ his_code ทั้งหมด
--     ward_staffs.ward             = smallint ของ his_code   เช่น 9
--     nurse_shift_assignments.ward = varchar ของ his_code    เช่น '09'
-- แต่ ward_shift_quotas เผลอเก็บเป็น ward.ward ทำให้ join กับสองตารางบนไม่ตรงหอ
-- เช่น "อายุรกรรม 3" ถูกเก็บเป็น 18 ขณะที่เจ้าหน้าที่ของหอเดียวกันอยู่ใต้เลข 9
--
-- แก้โดยแปลงค่าที่มีอยู่ ไม่ต้องกรอกใหม่ เพราะหอที่เลือกไว้ถูกต้องแล้ว ผิดแค่กุญแจ
--
-- ตรวจแล้วว่า his_code ของหอที่ยังใช้งานทุกแห่งเป็นตัวเลขล้วน ไม่ซ้ำกัน
-- และไม่ชนกันหลังตัดศูนย์นำหน้า จึงแปลงเป็น smallint ได้ปลอดภัย

DO $$
DECLARE
    moved int;
BEGIN
    -- กันรันซ้ำ: ถ้าแปลงไปแล้ว การรันอีกครั้งจะแปลผิดซ้ำซ้อน
    -- (เลข 9 ที่แปลงแล้ว จะถูกมองเป็น ward.ward=9 แล้วเด้งไปเป็น his_code 15)
    IF COALESCE(obj_description('ward_shift_quotas'::regclass), '') LIKE '%[ward=his_code]%' THEN
        RAISE NOTICE 'ward_shift_quotas ใช้ his_code อยู่แล้ว ข้ามการแปลง';
        RETURN;
    END IF;

    UPDATE ward_shift_quotas q
    SET ward = w.his_code::smallint
    FROM ward w
    WHERE w.ward = q.ward
      AND w.his_code ~ '^[0-9]+$';

    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'แปลงรหัสหอผู้ป่วยแล้ว % แถว', moved;

    COMMENT ON TABLE ward_shift_quotas IS
        'อัตรากำลังต่อเวร แยกตามหอผู้ป่วย กลุ่มตำแหน่ง และรหัสเวร '
        '· คอลัมน์ ward เก็บ his_code เป็นตัวเลข ตรงกับ ward_staffs.ward [ward=his_code]';
END $$;

COMMENT ON COLUMN ward_shift_quotas.ward IS
    'รหัสหอผู้ป่วยจาก ward.his_code แปลงเป็นตัวเลข — ชุดเดียวกับ ward_staffs.ward '
    'และตรงกับ nurse_shift_assignments.ward เมื่อเติมศูนย์นำหน้าให้ครบสองหลัก';
