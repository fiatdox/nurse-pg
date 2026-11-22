-- ยืนยันตัวตนขั้นที่สอง (MFA) ของเจ้าหน้าที่ด้วย OTP ทาง LINE OA หมอพร้อม
-- ฐานข้อมูล: nurse  (ไม่แตะ core_kon — บัญชีและรหัสผ่านยังอยู่ที่ core_kon.users เหมือนเดิม)

/*
  เปิด/ปิดด้วยค่าตั้ง system_settings.key = 'staff_login_otp' ({"enabled": true|false})
  ผู้ดูแลระบบสลับได้จากหน้าตั้งค่า ปิดไว้ = เข้าระบบแบบเดิม (ชื่อผู้ใช้ + รหัสผ่าน) ไม่แตะตารางชุดนี้เลย

  ตอนเปิด: รหัสผ่านถูก → สร้าง challenge หนึ่งแถว → ส่ง OTP ไปหมอพร้อมตามเลขบัตรของผู้ใช้
           → กรอก OTP ถูก → ได้ token จริง และ challenge ถูกปิดทิ้ง (ใช้ซ้ำไม่ได้)

  เก็บแค่ HMAC ของ OTP ไม่เก็บตัวเลขจริง และไม่เก็บเลขบัตร (อ่านจาก core_kon ตอนส่งทุกครั้ง)
*/

BEGIN;

CREATE TABLE IF NOT EXISTS staff_login_otp (
    challenge_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username        varchar(100) NOT NULL,
    /* ขั้นกลางทั้งก้อนหมดอายุเมื่อไหร่ (หลังรหัสผ่านถูก ต้องกรอก OTP ให้เสร็จภายในเวลานี้) */
    expires_at      timestamptz NOT NULL,
    /* OTP ตัวล่าสุดที่ส่งไป ขอใหม่ = ตัวเก่าใช้ไม่ได้ทันที */
    otp_hash        char(64),
    otp_expires_at  timestamptz,
    /* กรอกผิดกับ OTP ตัวนี้กี่ครั้ง (ครบแล้วทิ้ง ต้องขอใหม่) */
    otp_attempts    smallint NOT NULL DEFAULT 0,
    /* กรอกผิดรวมทั้ง challenge (ครบแล้วปิด challenge ต้องใส่รหัสผ่านใหม่) */
    total_failed    smallint NOT NULL DEFAULT 0,
    send_count      smallint NOT NULL DEFAULT 0,
    last_sent_at    timestamptz,
    /* ผ่านแล้ว หรือถูกปิดเพราะผิดเกิน — มีค่า = ใช้ต่อไม่ได้ */
    closed_at       timestamptz,
    closed_reason   varchar(20),
    ip              varchar(64),
    user_agent      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

/* นับว่าใครเริ่มเข้าระบบถี่ผิดปกติ (กันยิง OTP ใส่ LINE ของคนอื่นรัว ๆ) */
CREATE INDEX IF NOT EXISTS ix_staff_login_otp_user ON staff_login_otp (username, created_at DESC);

/* ประวัติการเข้าระบบด้วย OTP ไว้ตรวจย้อนหลัง — ไม่มีรหัส OTP หรือเลขบัตรอยู่ในนี้ */
CREATE TABLE IF NOT EXISTS staff_auth_events (
    event_id        bigserial PRIMARY KEY,
    username        varchar(100),
    /* otp_sent · otp_send_failed · otp_ok · otp_fail · otp_locked · otp_no_cid · otp_rate_limited · setting_on · setting_off */
    event           varchar(30) NOT NULL,
    detail          text,
    ip              varchar(64),
    user_agent      text,
    at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_staff_auth_events_user ON staff_auth_events (username, at DESC);

COMMENT ON TABLE staff_login_otp IS 'ขั้นกลางของการเข้าระบบเจ้าหน้าที่เมื่อเปิดโหมด OTP (หมอพร้อม) เก็บแค่ HMAC ของ OTP';
COMMENT ON TABLE staff_auth_events IS 'ประวัติการยืนยัน OTP ของเจ้าหน้าที่และการเปิด/ปิดโหมด OTP';

COMMIT;
