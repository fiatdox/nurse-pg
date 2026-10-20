-- เพิ่มสถานะ "จัดยาเสร็จ พร้อมให้ตึกมารับ" ให้ใบสั่งยา
-- ฐานข้อมูล: nurse

/*
  เดิมใบจบที่ 'completed' = ห้องยาคีย์ลง HIS เสร็จ
  แต่หอยังไม่รู้ว่าเดินมารับยาได้เมื่อไหร่ ต้องโทรถาม ซึ่งเป็นสิ่งที่ระบบนี้ตั้งใจจะเลิกทำ

  'prepared' จึงเป็นขั้นหลังจากนั้น = ยาจัดเสร็จ วางรอให้ตึกมารับ
  ไม่รวมกับ completed เพราะสองอย่างนี้เกิดคนละเวลาและคนละมือ
  คีย์เสร็จคืองานหน้าจอ จัดยาเสร็จคืองานหน้าชั้นยา ใบที่คีย์แล้วแต่ยังจัดไม่เสร็จมีจริง

  ไม่มีขั้น "ตึกรับไปแล้ว" เพราะไม่มีใครกดให้ การบังคับขั้นที่ไม่มีคนกด
  ได้สถานะที่ค้างอยู่อย่างนั้นตลอดไป แล้วคนก็เลิกเชื่อสถานะทั้งหมด
*/

BEGIN;

ALTER TABLE rx_orders DROP CONSTRAINT IF EXISTS rx_orders_status_check;
ALTER TABLE rx_orders ADD CONSTRAINT rx_orders_status_check
    CHECK (status IN ('submitted', 'acknowledged', 'completed', 'prepared', 'rejected'));

/* เก็บชื่อ ณ เวลานั้นเหมือนขั้นอื่น ชื่อในฐานบุคลากรเปลี่ยนได้ แต่ใบที่ออกไปแล้วต้องอ่านได้เหมือนเดิม */
ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS prepared_by      varchar(100);
ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS prepared_by_name varchar(150);
ALTER TABLE rx_orders ADD COLUMN IF NOT EXISTS prepared_at      timestamp;

/* ค้นด้วย HN ต้องหาได้ข้ามวัน ดัชนีเดิม ix_rx_orders_hn ใช้ได้เฉพาะเลขเต็ม
   ส่วนการพิมพ์เลขท้ายไม่กี่ตัวต้องสแกน ซึ่งยอมรับได้ที่ LIMIT 500 */

COMMENT ON COLUMN rx_orders.prepared_at IS 'เวลาที่ห้องยาจัดยาเสร็จ พร้อมให้หอมารับ';

COMMIT;
