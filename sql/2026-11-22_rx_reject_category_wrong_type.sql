-- กลุ่มเหตุผลส่งกลับ: หอเลือกประเภทใบผิด (ปกติ / ยากลับบ้าน / STAT หรือ NG-Tube)
-- ฐานข้อมูล: nurse · หอแก้ได้เองด้วยปุ่ม "แก้ประเภทแล้วส่งใหม่" ไม่ต้องสแกนใหม่ (POST /orders/:id/resubmit)
-- เพิ่มแถวเดียว ไม่แตะกลุ่มเดิม · รันซ้ำได้

INSERT INTO rx_reject_categories (code, label, sort_order, require_note)
VALUES ('wrong_type', 'ระบุประเภทผิด (ปกติ / กลับบ้าน / STAT / NG-Tube)', 35, false)
ON CONFLICT (code) DO NOTHING;
