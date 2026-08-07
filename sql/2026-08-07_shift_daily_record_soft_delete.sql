-- ยกเลิกรายการที่ลงผิดในรายงานประจำวัน (admission_shift_daily_record)
--
-- ปัญหา: พยาบาลติ๊กระดับการดูแลให้ผู้ป่วยผิดเวร หรือติ๊กให้คนที่ไม่ได้อยู่เวรนั้น
-- แล้วเอาออกไม่ได้ เพราะ Radio ของ antd กดซ้ำเพื่อยกเลิกไม่ได้ และไม่มี API ลบ
-- ผลคือ count_remain (ยอดคงพยาบาล) กับ FTE ของเวรนั้นเกินจริงถาวร
--
-- ไม่ลบแถวทิ้ง เพราะตัวเลขพวกนี้ถูกใช้อ้างอิงในรายงานภาระงานที่ส่งออกไปแล้ว
-- ถ้าลบจริงจะไล่ไม่ได้ว่าตัวเลขเปลี่ยนเพราะอะไร ใช้วิธีทำเครื่องหมายแทน
-- แล้วให้ทุก query ที่นับยอดข้ามแถวที่ถูกยกเลิก

ALTER TABLE admission_shift_daily_record
    ADD COLUMN IF NOT EXISTS deleted_at    timestamp,
    ADD COLUMN IF NOT EXISTS deleted_by    integer,
    ADD COLUMN IF NOT EXISTS delete_reason varchar(500);

-- ดัชนีบางส่วน: เกือบทุก query กรอง deleted_at IS NULL
-- เก็บเฉพาะแถวที่ยังใช้งาน ดัชนีจึงเล็กกว่าการทำดัชนีทั้งตาราง
CREATE INDEX IF NOT EXISTS ix_asdr_active
    ON admission_shift_daily_record (record_date, shift_type_id)
    WHERE deleted_at IS NULL;

COMMENT ON COLUMN admission_shift_daily_record.deleted_at IS
    'เวลาที่ยกเลิกรายการ NULL คือยังใช้งานอยู่ ทุก query ที่นับยอดต้องกรองคอลัมน์นี้';
