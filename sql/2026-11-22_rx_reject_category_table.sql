-- กลุ่มเหตุผลส่งกลับใบสั่งยา ให้เภสัช (กลุ่มงานเภสัชกรรม) และแอดมินตั้งค่าเองได้ที่ /pharmacy/reject-categories
-- ฐานข้อมูล: nurse · ตารางใหม่ + ใส่ 7 กลุ่มเริ่มต้น (รหัสเดียวกับที่ใช้ไปแล้วใน rx_orders.reject_category)
-- ไม่มีการลบ: กลุ่มที่เลิกใช้ให้ปิด (active = false) สถิติย้อนหลังยังอ่านชื่อได้

CREATE TABLE IF NOT EXISTS rx_reject_categories (
    code         varchar(32)  PRIMARY KEY,
    label        varchar(100) NOT NULL,
    sort_order   integer      NOT NULL DEFAULT 0,
    active       boolean      NOT NULL DEFAULT true,
    require_note boolean      NOT NULL DEFAULT false,
    updated_by   varchar(100),
    updated_at   timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  rx_reject_categories IS 'กลุ่มเหตุผลที่ห้องยาส่งใบสั่งยากลับให้หอแก้ (ใช้ทำสถิติ)';
COMMENT ON COLUMN rx_reject_categories.require_note IS 'true = ต้องพิมพ์รายละเอียดเพิ่มตอนเลือกกลุ่มนี้ (เช่น อื่น ๆ)';

INSERT INTO rx_reject_categories (code, label, sort_order, require_note) VALUES
    ('duplicate',     'ส่งซ้ำ',                      10, false),
    ('hn_mismatch',   'HN ไม่ตรงกับรูป',             20, false),
    ('wrong_patient', 'ผิดผู้ป่วย / ผิดหอ',           30, false),
    ('image_unclear', 'ภาพไม่ชัด / ไม่ครบหน้า',       40, false),
    ('no_signature',  'ไม่มีลายเซ็นแพทย์',           50, false),
    ('order_unclear', 'คำสั่งยาไม่ชัดเจน / ไม่ครบ',  60, false),
    ('other',         'อื่น ๆ',                      999, true)
ON CONFLICT (code) DO NOTHING;
