-- ช่วงเวลาที่ให้ตึกมารับยา (slot ละ 1 ชั่วโมง) กำหนดตอนห้องยากด "จัดยาเสร็จ"
-- ฐานข้อมูล: nurse · เพิ่มคอลัมน์ว่างอย่างเดียว ใบเก่าไม่มี slot = null

ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS pickup_from timestamp;
ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS pickup_to   timestamp;

COMMENT ON COLUMN rx_orders.pickup_from IS 'เริ่มช่วงเวลาที่ให้ตึกมารับยา (ห้องยากำหนดตอนจัดยาเสร็จ)';
COMMENT ON COLUMN rx_orders.pickup_to   IS 'สิ้นสุดช่วงเวลารับยา = pickup_from + 1 ชั่วโมง';
