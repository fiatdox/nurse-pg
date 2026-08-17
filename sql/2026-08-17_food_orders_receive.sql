-- งานโภชนาการรับรายการอาหาร (food_orders)
--
-- ตารางมีคอลัมน์ recieve_order_status / recieve_order_datetime / reciever อยู่แล้ว
-- แต่ยังไม่เคยถูกใช้เลย (ทั้งตารางเป็น NULL) ไฟล์นี้จึงไม่สร้างคอลัมน์ซ้ำ
-- แค่นิยามความหมายให้ชัดและเติมส่วนที่ขาดคือชื่อผู้รับ
--
-- ความหมาย: 'Y' = ครัวรับรายการไปทำแล้ว NULL = ยังไม่รับ
-- เมื่อรับแล้ว หอผู้ป่วยจะยกเลิกรายการเองไม่ได้ ต้องให้งานโภชนาการเป็นคนถอน
-- เพราะของอาจเข้าครัวไปแล้ว การหายไปเงียบๆ ทำให้ยอดที่เตรียมกับยอดที่สั่งไม่ตรงกัน

ALTER TABLE food_orders
    ADD COLUMN IF NOT EXISTS reciever_name varchar(150);

-- เก็บชื่อผู้รับเป็นข้อความ ด้วยเหตุผลเดียวกับ cancelled_by_name
-- คือทะเบียนผู้ใช้อยู่ในฐานข้อมูล hris คนละตัว join ข้ามมาในคิวรีเดียวไม่ได้
COMMENT ON COLUMN food_orders.reciever_name IS
    'ชื่อเจ้าหน้าที่โภชนาการที่รับรายการ ณ เวลาที่รับ คัดลอกไว้เพราะ users อยู่ในฐานข้อมูล hris';

COMMENT ON COLUMN food_orders.recieve_order_status IS
    'Y = งานโภชนาการรับรายการแล้ว NULL = ยังไม่รับ รายการที่รับแล้วหอผู้ป่วยยกเลิกเองไม่ได้';

-- หน้าสรุปของงานโภชนาการดึงทั้งวันของทุกหอ แล้วแยกตามมื้อ
-- ดัชนีเดิม (ward, order_date, meal) ช่วยตอนกรองรายหอ แต่ไม่ช่วยตอนดึงทั้งโรงพยาบาล
CREATE INDEX IF NOT EXISTS ix_food_orders_active_date
    ON food_orders (order_date, meal)
    WHERE cancelled_at IS NULL;
