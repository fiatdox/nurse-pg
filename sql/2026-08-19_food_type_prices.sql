-- ราคาอาหารตามประเภทห้อง จากผลการประกวดราคา
-- ฐานข้อมูล: nurse

BEGIN;

/*
  เก็บเป็นประวัติ ไม่ใช่ราคาปัจจุบันช่องเดียว

  ราคามาจากการประกวดราคาซึ่งเปลี่ยนทุกรอบสัญญา ถ้าเก็บค่าเดียวแล้วทับของเก่า
  พอย้อนไปคิดยอดของเดือนที่ผ่านมา ระบบจะใช้ราคาใหม่กับอาหารที่ส่งไปด้วยราคาเก่า
  ตัวเลขจะผิดโดยไม่มีอะไรเตือน และผิดย้อนหลังทั้งหมดพร้อมกัน

  หนึ่งแถวคือ "ราคานี้มีผลตั้งแต่วันนี้เป็นต้นไป" ราคาที่ใช้ ณ วันหนึ่ง
  คือแถวที่ effective_from มากที่สุดที่ยังไม่เกินวันนั้น
*/
CREATE TABLE IF NOT EXISTS food_type_prices (
     food_type_price_id serial PRIMARY KEY
    ,food_type_id       smallint     NOT NULL REFERENCES food_types (food_type_id)
    /*
      ช่วงเวลาของสัญญา — เริ่มมีผลถึงสิ้นสุด
      effective_to เป็น NULL ได้ แปลว่ายังไม่กำหนดวันสิ้นสุด (ใช้ไปจนกว่าจะมีสัญญาใหม่)
      แยกวันสิ้นสุดออกมาเพราะบางช่วงไม่มีสัญญาต่อเนื่อง ถ้าใช้แค่วันเริ่ม
      ราคาของสัญญาที่หมดอายุแล้วจะถูกใช้ต่อไปเรื่อยๆ โดยไม่มีอะไรเตือน
    */
    ,effective_from     date         NOT NULL
    ,effective_to       date
    /*
      ราคาต่อหนึ่งวัน ไม่ใช่ต่อมื้อ เพราะสัญญาคิดเป็นวัน
      โรงพยาบาลจ่ายเมื่อผู้ป่วยได้อาหารครบทั้งวัน (meals_per_day มื้อ)
      ถ้าเก็บเป็นราคาต่อมื้อจะต้องหาร 3 ซึ่งลงตัวบ้างไม่ลงตัวบ้าง
      แล้วผลรวมจะเพี้ยนจากการปัดเศษ
    */
    ,price_per_day      numeric(10,2) NOT NULL CHECK (price_per_day >= 0)
    ,meals_per_day      smallint      NOT NULL DEFAULT 3 CHECK (meals_per_day > 0)
    ,contract_note      varchar(255)
    ,created_at         timestamptz   NOT NULL DEFAULT NOW()
    ,created_by         integer
    ,created_by_name    varchar(150)
    -- ประเภทเดียวกันมีราคาเริ่มมีผลวันเดียวกันซ้ำไม่ได้ ไม่งั้นจะตัดสินไม่ได้ว่าใช้อันไหน
    ,CONSTRAINT uq_food_type_prices UNIQUE (food_type_id, effective_from)
    ,CONSTRAINT ck_food_type_prices_period CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- ตารางเคยถูกสร้างไปแล้วก่อนมีคอลัมน์ช่วงสัญญา จึงต้องเติมให้ด้วย
ALTER TABLE food_type_prices ADD COLUMN IF NOT EXISTS effective_to date;

ALTER TABLE food_type_prices DROP CONSTRAINT IF EXISTS ck_food_type_prices_period;
ALTER TABLE food_type_prices
    ADD CONSTRAINT ck_food_type_prices_period CHECK (effective_to IS NULL OR effective_to >= effective_from);

CREATE INDEX IF NOT EXISTS ix_food_type_prices_lookup
    ON food_type_prices (food_type_id, effective_from DESC);

COMMENT ON TABLE  food_type_prices              IS 'ราคาอาหารตามประเภทห้องจากการประกวดราคา เก็บเป็นประวัติตามวันที่เริ่มมีผล';
COMMENT ON COLUMN food_type_prices.price_per_day IS 'ราคาต่อผู้ป่วยหนึ่งคนหนึ่งวัน จ่ายเมื่อได้อาหารครบ meals_per_day มื้อ';
COMMENT ON COLUMN food_type_prices.meals_per_day IS 'จำนวนมื้อที่ถือว่าครบหนึ่งวัน ปกติ 3';
COMMENT ON COLUMN food_type_prices.effective_to  IS 'วันสิ้นสุดสัญญา NULL = ยังไม่กำหนด ใช้ไปจนกว่าจะมีสัญญาใหม่';

COMMIT;
