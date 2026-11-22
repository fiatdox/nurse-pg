-- กลุ่มเหตุผลที่ห้องยาส่งใบสั่งยากลับให้หอแก้ ใช้ทำสถิติ (ข้อความอิสระยังเก็บใน reject_reason เหมือนเดิม)
-- ฐานข้อมูล: nurse · เพิ่มคอลัมน์ว่างอย่างเดียว ใบเก่าที่ส่งกลับก่อนมีกลุ่ม = null (นับเป็น "ไม่ระบุกลุ่ม")
-- ค่าที่ใช้ได้ตรวจที่ backend (src/utils/rxRejectCategory.ts) ไม่ใส่ CHECK จะได้เพิ่มกลุ่มได้โดยไม่ต้อง migrate

ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS reject_category varchar(32);

COMMENT ON COLUMN rx_orders.reject_category IS 'กลุ่มเหตุผลที่ส่งกลับ เช่น duplicate, hn_mismatch (ดู src/utils/rxRejectCategory.ts)';
