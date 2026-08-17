-- ยกเลิกรายการสั่งอาหารที่ลงผิด (food_orders)
--
-- ปัญหา: หน้าสั่งอาหารมีปุ่มดึงมื้อก่อนหน้ามาสั่งทั้งหอในคลิกเดียว ถ้ากดผิดวัน
-- หรือผิดมื้อ จะได้รายการที่ไม่มีใครต้องการเต็มหอ แล้วเอาออกไม่ได้เลย
-- ของเดิมมี API ลบอยู่ (cancel-order-menu) แต่เป็น DELETE จริง ย้อนดูไม่ได้ว่าใครลบ
--
-- ไม่ลบแถวทิ้ง เพราะใบสรุปรายการอาหารถูกพิมพ์ส่งครัวไปแล้ว ถ้าหายไปทั้งแถว
-- จะไล่ไม่ได้ว่าทำไมยอดที่ครัวได้รับไม่ตรงกับยอดในระบบ ใช้วิธีทำเครื่องหมายแทน

ALTER TABLE food_orders
    ADD COLUMN IF NOT EXISTS cancelled_at      timestamp,
    ADD COLUMN IF NOT EXISTS cancelled_by      integer,
    ADD COLUMN IF NOT EXISTS cancelled_by_name varchar(150),
    ADD COLUMN IF NOT EXISTS cancel_reason     varchar(500);

-- เก็บชื่อผู้ยกเลิกซ้ำไว้เป็นข้อความด้วย เพราะทะเบียนผู้ใช้อยู่คนละฐานข้อมูล (hris)
-- จะ join ข้ามมาในคิวรีเดียวไม่ได้ ถ้าเก็บแต่ id หน้าประวัติจะแสดงได้แค่ตัวเลข
COMMENT ON COLUMN food_orders.cancelled_by_name IS
    'ชื่อผู้ยกเลิก ณ เวลาที่ยกเลิก คัดลอกไว้เพราะ users อยู่ในฐานข้อมูล hris คนละตัวกับตารางนี้';

COMMENT ON COLUMN food_orders.cancelled_at IS
    'เวลาที่ยกเลิกรายการ NULL คือยังใช้งานอยู่ ทุก query ที่ส่งรายการให้ครัวต้องกรองคอลัมน์นี้';

/*
  ดัชนีกันซ้ำเดิมคลุมทุกแถว ทำให้พอยกเลิกไปแล้วสั่งมื้อเดิมใหม่ไม่ได้
  เพราะไปชนแถวที่ยกเลิกทิ้งไว้ ต้องเปลี่ยนเป็นดัชนีบางส่วนที่นับเฉพาะแถวที่ยังใช้งาน
  หนึ่งคน หนึ่งวัน หนึ่งมื้อ ยังมีได้รายการเดียวเหมือนเดิม แต่ของที่ยกเลิกแล้วไม่นับ

  หมายเหตุ: ORDER MENU ใช้ ON CONFLICT กับดัชนีนี้ ต้องระบุ WHERE cancelled_at IS NULL
  ในคำสั่งด้วย ไม่งั้น postgres จะหาดัชนีที่ตรงไม่เจอแล้ว insert ล้ม
*/
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'food_orders' AND indexname = 'food_orders_order_date_idx'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'food_orders' AND indexname = 'uq_food_orders_active'
    ) THEN
        -- ต้องไม่มีคู่ซ้ำค้างอยู่ก่อน ไม่งั้นสร้างดัชนีใหม่ไม่ผ่านแล้วตารางจะเหลือแต่ของเก่า
        CREATE UNIQUE INDEX uq_food_orders_active
            ON food_orders (order_date, meal, an)
            WHERE cancelled_at IS NULL;

        DROP INDEX food_orders_order_date_idx;
        RAISE NOTICE 'เปลี่ยนดัชนีกันซ้ำเป็นแบบนับเฉพาะรายการที่ยังไม่ถูกยกเลิกแล้ว';
    ELSE
        RAISE NOTICE 'ดัชนี uq_food_orders_active มีอยู่แล้ว ข้ามการแปลง';
    END IF;
END $$;

-- เกือบทุกคิวรีของหน้าสั่งอาหารกรองด้วยหอผู้ป่วยกับวันที่ และต้องข้ามรายการที่ยกเลิก
CREATE INDEX IF NOT EXISTS ix_food_orders_active_ward_date
    ON food_orders (ward, order_date, meal)
    WHERE cancelled_at IS NULL;
