-- บัญชีบริษัทผู้รับจ้างทำอาหาร สำหรับเข้ามาดูรายงานยอดของตัวเอง
-- ฐานข้อมูล: nurse

/*
  ทำไมไม่ใช้ core_kon.users

  core_kon เป็นฐานบุคลากรของโรงพยาบาลที่ระบบอื่นใช้ร่วมกัน และ resolveActor /
  isNutritionStaff / canCosign / isAdmin อ่านตัวตนจากตารางนั้นทั้งหมด
  การแทรกแถวของคนนอกลงไปคือการให้บริษัทมีที่ยืนในตรรกะลงนามบันทึกทางการพยาบาล
  ต่อให้ตั้ง position_name เป็นอะไรก็ตาม บัญชีคนนอกจึงต้องอยู่คนละฐานไปเลย
*/

BEGIN;

CREATE TABLE IF NOT EXISTS vendors (
     vendor_id    serial       PRIMARY KEY
    ,vendor_name  varchar(255) NOT NULL
    ,tax_id       varchar(20)
    ,contact_name varchar(150)
    ,contact_tel  varchar(50)
    ,is_active    boolean      NOT NULL DEFAULT true
    ,created_at   timestamptz  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_accounts (
     vendor_account_id serial       PRIMARY KEY
    ,vendor_id         integer      NOT NULL REFERENCES vendors (vendor_id)
    ,username          varchar(64)  NOT NULL
    -- argon2id ตัวเดียวกับฝั่งเจ้าหน้าที่ ไม่เก็บรหัสผ่านดิบเด็ดขาด
    ,password          text         NOT NULL
    ,display_name      varchar(150) NOT NULL
    ,is_active         boolean      NOT NULL DEFAULT true
    /*
      บัญชีนี้เปิดให้คนนอกโรงพยาบาลใช้ จึงต้องล็อกได้เมื่อมีการเดารหัสผ่านรัว
      ของเจ้าหน้าที่ไม่มีกลไกนี้เพราะอยู่หลังเครือข่ายภายใน แต่บัญชีนี้ไม่ใช่
    */
    ,failed_count      smallint     NOT NULL DEFAULT 0
    ,locked_until      timestamptz
    ,last_login_at     timestamptz
    ,created_at        timestamptz  NOT NULL DEFAULT NOW()
    ,created_by        integer
    ,created_by_name   varchar(150)
    -- ชื่อผู้ใช้ห้ามซ้ำข้ามบริษัท ไม่งั้นตอน login จะตัดสินไม่ได้ว่าเป็นของใคร
    ,CONSTRAINT uq_vendor_accounts_username UNIQUE (username)
);

/*
  ประเภทอาหารที่บริษัทแต่ละเจ้ารับผิดชอบ

  ตอนนี้มีเจ้าเดียวก็จริง แต่ต้องมีตารางนี้ตั้งแต่แรก เพราะถ้าวันหนึ่งมีสองเจ้า
  แล้วค่อยมาเติมทีหลัง จะต้องไปไล่แก้ทุกคิวรีที่เขียนไปแล้วโดยไม่มีตัวกรอง
  ซึ่งพลาดง่ายและพลาดแล้วแปลว่าบริษัทหนึ่งเห็นยอดของอีกบริษัท
*/
CREATE TABLE IF NOT EXISTS vendor_food_types (
     vendor_id    integer  NOT NULL REFERENCES vendors (vendor_id) ON DELETE CASCADE
    ,food_type_id smallint NOT NULL REFERENCES food_types (food_type_id)
    ,PRIMARY KEY (vendor_id, food_type_id)
);

CREATE INDEX IF NOT EXISTS ix_vendor_accounts_vendor ON vendor_accounts (vendor_id);

COMMENT ON TABLE  vendors                     IS 'บริษัทผู้รับจ้างทำอาหาร';
COMMENT ON TABLE  vendor_accounts             IS 'บัญชีเข้าระบบของบริษัทผู้รับจ้าง แยกจาก core_kon.users โดยตั้งใจ';
COMMENT ON TABLE  vendor_food_types           IS 'ประเภทอาหารที่บริษัทแต่ละเจ้ารับผิดชอบ ใช้กรองไม่ให้เห็นยอดของเจ้าอื่น';
COMMENT ON COLUMN vendor_accounts.locked_until IS 'ล็อกถึงเมื่อไหร่ ตั้งเมื่อกรอกรหัสผ่านผิดติดกันหลายครั้ง';

COMMIT;
