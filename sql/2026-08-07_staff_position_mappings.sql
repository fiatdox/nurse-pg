-- จับคู่ตำแหน่งในระบบบุคลากร (core_kon.user_positions) เข้ากับกลุ่มตำแหน่งของเรา (staff_position)
--
-- ที่มา: core_kon มีตำแหน่ง 100 แบบ ปนกันทั้งโรงพยาบาล (นายแพทย์ เภสัชกร พนักงานขับรถ ฯลฯ)
-- ส่วนงานพยาบาลสนใจแค่ไม่กี่ตำแหน่ง และต้องยุบให้เหลือ 3 กลุ่มคือ RN / TN / PN
-- เพราะอัตราค่าตอบแทนต่อเวรใน staff_position_rates ผูกอยู่กับ staff_position ไม่ใช่ตำแหน่งดิบ
--
-- ปลายทางคือ: ตำแหน่งจาก core_kon -> กลุ่มของเรา -> อัตราค่าตอบแทนตามเวรที่ขึ้น

CREATE TABLE IF NOT EXISTS staff_position_mappings (
    -- เป็น PK เพื่อบังคับว่าตำแหน่งหนึ่งอยู่ได้กลุ่มเดียวเท่านั้น
    -- ถ้าปล่อยให้ "พยาบาลวิชาชีพ" อยู่ทั้ง RN และ PN จะคิดค่าตอบแทนไม่ได้ว่าใช้อัตราไหน
    user_position_id  integer PRIMARY KEY,

    -- เก็บชื่อ ณ วันที่จับคู่ไว้ด้วย เพราะ core_kon อยู่คนละฐานข้อมูล ทำ FK ข้ามไม่ได้
    -- ถ้าตำแหน่งต้นทางถูกเปลี่ยนชื่อหรือลบ หน้าจอจะยังบอกได้ว่าเคยจับคู่อะไรไว้
    position_name     varchar(200) NOT NULL,

    staff_position_id smallint NOT NULL REFERENCES staff_position (staff_position_id),

    created_at        timestamp NOT NULL DEFAULT NOW(),
    updated_at        timestamp,
    updated_by        varchar(50)
);

-- หน้าจอถามด้วยกลุ่มเสมอ ("กลุ่มนี้มีตำแหน่งอะไรบ้าง")
CREATE INDEX IF NOT EXISTS ix_spm_group ON staff_position_mappings (staff_position_id);

COMMENT ON TABLE staff_position_mappings IS
    'จับคู่ core_kon.user_positions -> staff_position สำหรับคิดค่าตอบแทนตามเวร';
COMMENT ON COLUMN staff_position_mappings.user_position_id IS
    'อ้างถึง core_kon.user_positions.user_position_id — คนละฐานข้อมูล จึงไม่มี FK บังคับ';
