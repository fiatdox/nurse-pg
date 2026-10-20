-- ขั้นปิดงานของใบสั่งยา: ตึกมารับยาแล้ว และ ปิดเรื่องใบที่ส่งกลับ
-- ฐานข้อมูล: nurse

/*
  ก่อนหน้านี้ใบจบที่ 'prepared' (จัดยาเสร็จ รอตึกมารับ) แล้วค้างอยู่บนจอตลอดไป
  เพราะไม่มีขั้นไหนบอกว่าตึกมารับไปแล้ว ของที่รับไปแล้วจึงกองรวมกับของที่ยังรอ
  จนนับไม่ได้ว่าตรงหน้าเคาน์เตอร์เหลือของที่ต้องส่งมอบกี่ใบ เรื่องเดียวกับใบที่ส่งกลับ

  แยกเป็นสองสถานะ ไม่ใช่ 'ปิดงาน' ตัวเดียว เพราะสองเรื่องนี้ไม่เหมือนกัน
    picked_up = ตึกมารับยาไปแล้ว เป็นการส่งมอบจริง มีคนมารับ มีเวลา มีชื่อคนจ่าย
    closed    = ใบที่ส่งกลับไปแล้วถูกจัดการเรียบร้อย เป็นงานเก็บกวาดหน้าจอ
  ถ้ารวมเป็นสถานะเดียว ประวัติจะตอบไม่ได้ว่าใบไหน "ส่งมอบแล้ว" จริง ๆ

  ใช้คอลัมน์ชุดเดียวเก็บทั้งสองกรณี เพราะหนึ่งใบไปได้ทางเดียวเท่านั้น
  ส่วนว่าเป็นทางไหน สถานะกับประวัติ (rx_order_events) บอกอยู่แล้ว
*/

BEGIN;

ALTER TABLE rx_orders DROP CONSTRAINT IF EXISTS rx_orders_status_check;
ALTER TABLE rx_orders ADD CONSTRAINT rx_orders_status_check
    CHECK (status IN ('submitted', 'acknowledged', 'completed', 'prepared',
                      'picked_up', 'rejected', 'closed'));

ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS closed_by      varchar(100);
ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS closed_by_name varchar(150);
ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS closed_at      timestamp;

COMMENT ON COLUMN rx_orders.closed_at IS 'เวลาที่ตึกมารับยา (picked_up) หรือเวลาที่ปิดเรื่องใบที่ส่งกลับ (closed)';

COMMIT;
