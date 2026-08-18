-- จัดการรายการเมนูอาหาร (เพิ่มชื่อเมนู / เปิด-ปิดการใช้งาน)
-- ฐานข้อมูล: nurse

BEGIN;

-- เก็บว่าใครเพิ่มเมนูและเพิ่มเมื่อไหร่ เพราะชื่อเมนูไปโผล่บนฉลากติดถาดและใบส่งครัว
-- ถ้าพิมพ์ผิดแล้วส่งไปถึงครัว ต้องตามได้ว่าต้องไปถามใคร
ALTER TABLE food_items
    ADD COLUMN IF NOT EXISTS created_at      timestamptz,
    ADD COLUMN IF NOT EXISTS created_by      integer,
    ADD COLUMN IF NOT EXISTS created_by_name varchar(150),
    ADD COLUMN IF NOT EXISTS updated_at      timestamptz,
    ADD COLUMN IF NOT EXISTS updated_by      integer,
    ADD COLUMN IF NOT EXISTS updated_by_name varchar(150);

COMMENT ON COLUMN food_items.created_by_name IS 'ชื่อผู้เพิ่มเมนู เก็บเป็นข้อความเพราะทะเบียนบุคลากรอยู่คนละฐานข้อมูล';
COMMENT ON COLUMN food_items.updated_by_name IS 'ชื่อผู้แก้ไขล่าสุด (เปิด/ปิดการใช้งานเมนู)';

/*
  กันเมนูซ้ำ โดยเทียบแบบตัดช่องว่างและไม่สนตัวพิมพ์
  ข้อมูลเดิมสะกดวงเล็บไม่เหมือนกัน มีทั้ง 'ธรรมดา (VIP)' และ 'ธรรมดา(VIP)'
  ถ้าเทียบตรง ๆ จะยอมให้เพิ่มชื่อเดียวกันซ้ำได้แค่เพราะเว้นวรรคต่างกัน
  ตรวจแล้วว่า 41 แถวที่มีอยู่ไม่ชนกันภายใต้กติกานี้
*/
CREATE UNIQUE INDEX IF NOT EXISTS uq_food_items_name_norm
    ON food_items (lower(regexp_replace(food_name, '[[:space:]]+', '', 'g')));

/* ─────────── ย้ายประเภทอาหารจากวงเล็บในชื่อ มาเก็บเป็นรหัสจริง ─────────── */

/*
  ตาราง food_types มีมาแต่แรกแต่ไม่เคยมีข้อมูล และ food_items.food_type_id
  เป็น NULL ทั้ง 41 แถว ทุกที่ในระบบเลยต้องอ่านประเภทจากข้อความในชื่อ
  ซึ่งพังเงียบ ๆ ได้ถ้ามีคนพิมพ์ '(สามัญ )' เว้นวรรคเกิน หรือ '(vip)' ตัวเล็ก

  รหัสตั้งเป็นค่าคงที่ ไม่ปล่อยให้ sequence แจก เพราะโค้ดและรายงานอ้างถึงรหัสนี้
  9 = งดอาหาร ไม่ใช่ประเภทห้อง แต่ต้องมีที่อยู่ ไม่งั้น NPO จะเหลือเป็น NULL
  แล้วต้องคงการอ่านชื่อไว้อยู่ดี
*/
INSERT INTO food_types (food_type_id, food_type_name, is_active) VALUES
     (1, 'สามัญ',           true)
    ,(2, 'พิเศษ',           true)
    ,(3, 'VIP',             true)
    ,(9, 'งดอาหาร (NPO)',   true)
ON CONFLICT (food_type_id) DO NOTHING;

-- sequence ยังชี้ที่ 1 อยู่ ถ้าไม่ขยับ การเพิ่มประเภทใหม่ในอนาคตจะชนรหัสที่ใส่ไปแล้ว
SELECT setval('food_types_food_type_id_seq', GREATEST((SELECT MAX(food_type_id) FROM food_types), 1));

/*
  เทียบชื่อแบบตัดช่องว่างทั้งหมดออกก่อน เพราะข้อมูลเดิมสะกดวงเล็บไม่เหมือนกัน
  มีทั้ง 'ธรรมดา (VIP)' 'ธรรมดา(VIP)' และ 'ธรรมดาเกาท์  (VIP)' เว้นวรรคสองครั้ง
  ตรวจแล้วว่าจับคู่ได้ครบทั้ง 41 แถว: สามัญ 14 / พิเศษ 13 / VIP 13 / NPO 1
*/
UPDATE food_items fi
SET food_type_id = v.food_type_id
FROM (
    SELECT
         food_item_id
        ,CASE
            WHEN n LIKE '%(สามัญ)'      THEN 1
            WHEN n LIKE '%(พิเศษ)'      THEN 2
            WHEN upper(n) LIKE '%(VIP)' THEN 3
            WHEN upper(n) LIKE 'NPO%'   THEN 9
         END AS food_type_id
    FROM (SELECT food_item_id, regexp_replace(food_name, '[[:space:]]+', '', 'g') AS n FROM food_items) s
) v
WHERE v.food_item_id = fi.food_item_id
  AND v.food_type_id IS NOT NULL
  AND fi.food_type_id IS DISTINCT FROM v.food_type_id;

-- ผูกความสัมพันธ์หลังเติมข้อมูลเสร็จ ถ้าผูกก่อนจะติดตั้งแต่แถวแรก
ALTER TABLE food_items
    DROP CONSTRAINT IF EXISTS fk_food_items_food_type;
ALTER TABLE food_items
    ADD CONSTRAINT fk_food_items_food_type
    FOREIGN KEY (food_type_id) REFERENCES food_types (food_type_id);

CREATE INDEX IF NOT EXISTS ix_food_items_food_type ON food_items (food_type_id);

COMMENT ON COLUMN food_items.food_type_id IS 'ประเภทอาหาร อ้าง food_types — เป็นแหล่งความจริง วงเล็บท้ายชื่อเหลือไว้เพื่อการอ่านบนฉลากเท่านั้น';

COMMIT;
