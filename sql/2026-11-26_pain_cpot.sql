-- แบบประเมินความปวด: เพิ่ม CPOT (Critical-Care Pain Observation Tool) ฉบับภาษาไทย
-- ฐานข้อมูล: nurse · แก้เฉพาะ nursing_pain_records (เพิ่มคอลัมน์ + ขยาย CHECK) ไม่ลบข้อมูลเดิม
--
-- อ้างอิง: การประเมินความปวด (CPOT) งานการพยาบาล คณะแพทยศาสตร์ศิริราชพยาบาล 2564
--   Gélinas C, et al. Am J Crit Care 2006;15(4):420-7
--   Karuna W, et al. J Med Assoc Thai 2017;100(Suppl.7):S9-S19 (ฉบับภาษาไทย)
--
-- CPOT ประเมินจากพฤติกรรม 4 ด้าน ด้านละ 0-2 รวม 0-8
--   0-2 mild · 3-5 moderate · >5 severe · moderate/severe ต้องได้รับการจัดการ
-- pain_score เก็บผลรวม CPOT (0-8) ส่วนคะแนนรายด้านเก็บใน tool_items เช่น
--   {"facial":1,"body":1,"muscle":0,"airway_mode":"ventilator","airway":1}
--   airway_mode = ventilator (ใส่ท่อช่วยหายใจ: การยอมตามเครื่อง) | vocal (ไม่ได้ใส่ท่อ: การออกเสียง)

ALTER TABLE nursing_pain_records ADD COLUMN IF NOT EXISTS tool_items jsonb;
COMMENT ON COLUMN nursing_pain_records.tool_items IS 'คะแนนรายด้านของเครื่องมือแบบสังเกตพฤติกรรม (CPOT) — pain_score คือผลรวม';

ALTER TABLE nursing_pain_records DROP CONSTRAINT IF EXISTS chk_pain_assessment_tool;
ALTER TABLE nursing_pain_records ADD CONSTRAINT chk_pain_assessment_tool
    CHECK (assessment_tool IN ('NRS', 'VAS', 'Wong-Baker', 'FLACC', 'BPS', 'CPOT'));
