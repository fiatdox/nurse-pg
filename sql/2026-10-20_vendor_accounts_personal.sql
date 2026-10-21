-- บัญชีบริษัทผู้รับจ้างเป็นบัญชีรายบุคคล 1 คน : 1 บัญชี และยืนยันตัวตนได้
-- ฐานข้อมูล: nurse

/*
  ของเดิมบัญชีหนึ่งใช้กันทั้งบริษัท ผู้ดูแลตั้งรหัสผ่านแล้วส่งต่อให้
  ระบบจึงตอบไม่ได้ว่าใครเปิดรายงานหรือพิมพ์ใบติดถาด และรหัสผ่านก็ไม่ได้เป็นของใคร

  แบบใหม่
  - บัญชีผูกกับบุคคลจริง ชื่อ-สกุล เบอร์โทร ตำแหน่ง และเลขบัตรประชาชน
    เจ้าหน้าที่ต้องตรวจบัตรตัวจริงแล้วกดยืนยัน บัญชีที่ยังไม่ยืนยันเข้าระบบไม่ได้
  - เลขบัตรหนึ่งเลขมีได้บัญชีเดียว (national_id_hash UNIQUE) คือตัวบังคับ 1:1
  - ผู้ดูแลออกได้แค่รหัสชั่วคราวที่หมดอายุ ครั้งแรกที่เข้าต้องตั้งรหัสเอง
    ผู้ดูแลจึงไม่รู้รหัสจริงของใครเลย
  - ยืนยันตัวตนสองขั้นด้วย OTP ที่ส่งไปทาง LINE OA หมอพร้อม ของเจ้าของเลขบัตร ทุกครั้งที่เข้า
    หมอพร้อมผูกบัญชีกับเลขบัตรที่ยืนยันตัวตนแล้ว คนที่ได้รับ OTP จึงเป็นเจ้าของเลขบัตรจริง
    ซึ่งพิสูจน์ซ้ำอีกชั้นว่าเลขบัตรที่ผู้ดูแลกรอกเป็นของคนที่ถือบัญชีนี้
  - เข้าได้ทีละเครื่อง เข้าเครื่องใหม่แล้วเครื่องเก่าหลุด
  - บันทึกการเข้าระบบและการเรียกใช้ทุกครั้งรายบุคคล

  เลขบัตรเก็บแบบเข้ารหัส (AES-256-GCM) กุญแจอยู่ใน .env (VENDOR_PII_KEY) ไม่อยู่ในฐาน
  ต้องถอดรหัสได้ (ไม่ใช่แค่แฮช) เพราะต้องส่งเลขบัตรไปให้หมอพร้อมเพื่อส่ง OTP
  ถ้าฐานหลุดออกไปอย่างเดียว อ่านเลขบัตรไม่ได้
  national_id_hash เป็น HMAC ด้วยกุญแจเดียวกัน ใช้ตรวจซ้ำโดยไม่ต้องถอดรหัส
  national_id_last4 เก็บไว้แสดงผลแบบปิดบัง และให้เจ้าหน้าที่เทียบกับบัตรได้

  บัญชีเดิมที่ไม่มีข้อมูลบุคคลจะเข้าระบบไม่ได้จนกว่าผู้ดูแลจะกรอกข้อมูลและยืนยันตัวตน
  ซึ่งตั้งใจ บัญชีที่ใช้ร่วมกันทั้งบริษัทต้องถูกแทนด้วยบัญชีรายคน
*/

BEGIN;

ALTER TABLE vendor_accounts
     ADD COLUMN IF NOT EXISTS first_name                varchar(100)
    ,ADD COLUMN IF NOT EXISTS last_name                 varchar(100)
    ,ADD COLUMN IF NOT EXISTS job_title                 varchar(100)
    ,ADD COLUMN IF NOT EXISTS phone                     varchar(20)
    ,ADD COLUMN IF NOT EXISTS national_id_enc           text
    ,ADD COLUMN IF NOT EXISTS national_id_hash          char(64)
    ,ADD COLUMN IF NOT EXISTS national_id_last4         char(4)
    ,ADD COLUMN IF NOT EXISTS identity_verified_at      timestamptz
    ,ADD COLUMN IF NOT EXISTS identity_verified_by      integer
    ,ADD COLUMN IF NOT EXISTS identity_verified_by_name varchar(150)
    -- ต้องตั้งรหัสผ่านเองก่อนใช้งาน ค่าเริ่ม true ทำให้บัญชีเดิมต้องเปลี่ยนรหัสด้วย
    ,ADD COLUMN IF NOT EXISTS must_change_password      boolean NOT NULL DEFAULT true
    ,ADD COLUMN IF NOT EXISTS temp_password_expires_at  timestamptz
    ,ADD COLUMN IF NOT EXISTS password_changed_at       timestamptz
    -- OTP ที่ส่งไปหมอพร้อม เก็บแค่ HMAC ไม่เก็บตัวเลขจริง ใช้ได้ครั้งเดียว
    ,ADD COLUMN IF NOT EXISTS otp_hash                  char(64)
    ,ADD COLUMN IF NOT EXISTS otp_expires_at            timestamptz
    ,ADD COLUMN IF NOT EXISTS otp_attempts              smallint NOT NULL DEFAULT 0
    -- กันกดส่งรัว (หมอพร้อมอาจคิดค่าส่ง และผู้รับจะโดนข้อความถล่ม)
    ,ADD COLUMN IF NOT EXISTS otp_sent_at               timestamptz
    ,ADD COLUMN IF NOT EXISTS otp_window_start          timestamptz
    ,ADD COLUMN IF NOT EXISTS otp_window_count          smallint NOT NULL DEFAULT 0
    -- ขั้นกลางของการเข้าระบบ (หลังรหัสผ่านถูก ก่อนผ่าน OTP) ใช้ได้ครั้งเดียว
    ,ADD COLUMN IF NOT EXISTS pending_nonce             uuid
    ,ADD COLUMN IF NOT EXISTS pending_until             timestamptz
    -- session ที่ใช้งานอยู่ได้ตัวเดียว token ที่ sid ไม่ตรงถูกปฏิเสธ
    ,ADD COLUMN IF NOT EXISTS session_id                uuid
    ,ADD COLUMN IF NOT EXISTS session_started_at        timestamptz;

/*
  แบบร่างแรกใช้แอป Authenticator (TOTP) และถูกเปลี่ยนเป็น OTP ทางหมอพร้อมก่อนขึ้นเครื่องจริง
  คอลัมน์ชุดนั้นมีอยู่แค่บนฐาน dev ลบทิ้งให้โครงสร้างตรงกันทุกเครื่อง
*/
ALTER TABLE vendor_accounts
     DROP COLUMN IF EXISTS totp_secret_enc
    ,DROP COLUMN IF EXISTS totp_enabled_at
    ,DROP COLUMN IF EXISTS totp_last_step;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_accounts_national_id
    ON vendor_accounts (national_id_hash) WHERE national_id_hash IS NOT NULL;

/*
  บันทึกการเข้าระบบ ทั้งสำเร็จและไม่สำเร็จ
  vendor_account_id เป็น NULL ได้ กรณีกรอกชื่อผู้ใช้ที่ไม่มีอยู่จริง
*/
CREATE TABLE IF NOT EXISTS vendor_auth_events (
     vendor_auth_event_id bigserial    PRIMARY KEY
    ,vendor_account_id    integer      REFERENCES vendor_accounts (vendor_account_id)
    ,username_tried       varchar(64)
    ,event                varchar(40)  NOT NULL
    ,detail               varchar(255)
    ,ip                   varchar(64)
    ,user_agent           varchar(255)
    -- เจ้าหน้าที่ที่ทำรายการ เช่น ออกรหัสชั่วคราว ตัดการเข้าใช้ (NULL = บริษัททำเอง)
    ,actor_name           varchar(150)
    ,created_at           timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_vendor_auth_events_account
    ON vendor_auth_events (vendor_account_id, created_at DESC);

/* การเรียกใช้ทุกครั้งของบัญชีบริษัท ตอบได้ว่าใครเปิดรายงานหรือพิมพ์ใบติดถาดเมื่อไหร่ */
CREATE TABLE IF NOT EXISTS vendor_access_log (
     vendor_access_log_id bigserial    PRIMARY KEY
    ,vendor_account_id    integer      NOT NULL REFERENCES vendor_accounts (vendor_account_id)
    ,session_id           uuid
    ,method               varchar(10)  NOT NULL
    ,path                 varchar(255) NOT NULL
    ,ip                   varchar(64)
    ,created_at           timestamptz  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_vendor_access_log_account
    ON vendor_access_log (vendor_account_id, created_at DESC);

COMMENT ON COLUMN vendor_accounts.national_id_enc   IS 'เลขบัตรประชาชน เข้ารหัส AES-256-GCM ด้วย VENDOR_PII_KEY';
COMMENT ON COLUMN vendor_accounts.national_id_hash  IS 'HMAC-SHA256 ของเลขบัตร ใช้บังคับหนึ่งคนหนึ่งบัญชี';
COMMENT ON COLUMN vendor_accounts.otp_hash          IS 'HMAC ของ OTP ที่ส่งทาง LINE OA หมอพร้อม ใช้ได้ครั้งเดียว';
COMMENT ON COLUMN vendor_accounts.session_id        IS 'session ที่ใช้งานอยู่ เข้าเครื่องใหม่แล้วค่านี้เปลี่ยน เครื่องเก่าหลุด';
COMMENT ON TABLE  vendor_auth_events                IS 'ประวัติการเข้าระบบและการจัดการบัญชีของบริษัทผู้รับจ้าง';
COMMENT ON TABLE  vendor_access_log                 IS 'การเรียกใช้ API ทุกครั้งของบัญชีบริษัทผู้รับจ้าง รายบุคคล';

COMMIT;
