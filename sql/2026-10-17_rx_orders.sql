-- ระบบส่งใบสั่งยาจากหอผู้ป่วยไปห้องยา (แทนการส่งแฟกซ์)
-- ฐานข้อมูล: nurse

/*
  ของเดิมหอผู้ป่วยส่งใบ order ทางแฟกซ์ ห้องยาอ่านจากกระดาษแล้วคีย์ลง HIS
  ปัญหาคือไม่รู้ว่าใบไปถึงหรือยัง ใครรับ คีย์เสร็จหรือยัง และย้อนกลับไปดูไม่ได้

  ตารางชุดนี้เก็บสามอย่างแยกกัน
    rx_orders        ใบสั่งยาหนึ่งใบต่อผู้ป่วยหนึ่งคน พร้อมสถานะปัจจุบัน
    rx_order_files   ไฟล์ที่แนบมา แยกตารางเพราะหนึ่งใบมีได้หลายหน้า
    rx_order_events  ประวัติทุกการกระทำ รวมถึงการเปิดดูไฟล์

  เหตุที่ต้องมี rx_order_events แยกจากคอลัมน์สถานะใน rx_orders
  คอลัมน์บอกได้แค่สถานะล่าสุด แต่ข้อมูลผู้ป่วยต้องตอบได้ว่า "ใครเปิดดูไฟล์นี้บ้าง"
  ซึ่งเป็นเหตุการณ์ที่ไม่เปลี่ยนสถานะ จึงเก็บในคอลัมน์ไม่ได้เลย
*/

BEGIN;

CREATE TABLE IF NOT EXISTS rx_orders (
    rx_order_id     bigserial PRIMARY KEY,

    /*
      หอผู้ป่วยที่ส่ง อ้างชนิดเดียวกับตาราง ward (smallint)
      ไม่ใช้ชื่อหอเป็นตัวอ้างอิง เพราะชื่อหอถูกแก้ไขได้และเคยสะกดไม่ตรงกับฝั่ง HIS มาแล้ว
    */
    ward            smallint NOT NULL REFERENCES ward (ward),

    hn              varchar(20),
    an              varchar(20),
    /* ที่มาของเลข HN บอกห้องยาว่าต้องตรวจกับภาพต้นฉบับละเอียดแค่ไหน */
    hn_source       varchar(10) NOT NULL DEFAULT 'manual'
                    CHECK (hn_source IN ('barcode', 'pdf_text', 'ocr', 'manual')),
    patient_name    varchar(150),
    /* จริงเมื่อค้นเจอใน HIS ตอนรับเข้า เท็จไม่ได้แปลว่าผิด แปลว่ายืนยันไม่ได้ตอนนั้น */
    his_verified    boolean NOT NULL DEFAULT false,

    priority        varchar(10) NOT NULL DEFAULT 'routine'
                    CHECK (priority IN ('routine', 'stat')),

    status          varchar(15) NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted', 'acknowledged', 'completed', 'rejected')),

    note            text,
    reject_reason   text,

    /*
      เก็บทั้งรหัสผู้ใช้และชื่อ ณ เวลานั้น
      ชื่อในฐานบุคลากรเปลี่ยนได้ (เปลี่ยนนามสกุล เลื่อนตำแหน่ง) แต่เอกสารที่ออกไปแล้ว
      ต้องอ่านได้เหมือนวันที่เกิดเหตุ จึงคัดลอกชื่อไว้ ไม่ใช่ join เอาตอนแสดงผล
    */
    submitted_by        varchar(100) NOT NULL,
    submitted_by_name   varchar(150) NOT NULL,
    submitted_at        timestamp NOT NULL DEFAULT now(),

    ack_by          varchar(100),
    ack_by_name     varchar(150),
    ack_at          timestamp,

    completed_by        varchar(100),
    completed_by_name   varchar(150),
    completed_at        timestamp,

    rejected_by         varchar(100),
    rejected_by_name    varchar(150),
    rejected_at         timestamp
);

/* คิวของห้องยาเรียงตามความด่วนก่อนแล้วค่อยตามเวลา ดัชนีจึงต้องมี priority อยู่ด้วย */
CREATE INDEX IF NOT EXISTS ix_rx_orders_queue
    ON rx_orders (status, priority, submitted_at);
CREATE INDEX IF NOT EXISTS ix_rx_orders_ward
    ON rx_orders (ward, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ix_rx_orders_hn
    ON rx_orders (hn);

CREATE TABLE IF NOT EXISTS rx_order_files (
    rx_file_id      bigserial PRIMARY KEY,
    rx_order_id     bigint NOT NULL REFERENCES rx_orders (rx_order_id) ON DELETE CASCADE,
    file_no         integer NOT NULL DEFAULT 1,
    original_name   varchar(255) NOT NULL,
    stored_path     text NOT NULL,
    mime_type       varchar(100) NOT NULL,
    byte_size       integer NOT NULL,
    /* ใช้เตือนเมื่อสแกนใบเดิมส่งซ้ำ ไม่ได้ใช้กันซ้ำแบบบังคับ เพราะบางครั้งต้องส่งซ้ำจริง */
    sha256          char(64) NOT NULL,
    uploaded_at     timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_rx_order_files_order ON rx_order_files (rx_order_id, file_no);
CREATE INDEX IF NOT EXISTS ix_rx_order_files_sha   ON rx_order_files (sha256, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS rx_order_events (
    rx_event_id     bigserial PRIMARY KEY,
    rx_order_id     bigint NOT NULL REFERENCES rx_orders (rx_order_id) ON DELETE CASCADE,
    /* submit · ack · complete · reject · view_file */
    action          varchar(20) NOT NULL,
    actor           varchar(100),
    actor_name      varchar(150),
    at              timestamp NOT NULL DEFAULT now(),
    detail          jsonb
);

CREATE INDEX IF NOT EXISTS ix_rx_order_events_order ON rx_order_events (rx_order_id, at);

COMMENT ON TABLE rx_orders IS 'ใบสั่งยาที่หอผู้ป่วยสแกนส่งให้ห้องยา แทนการส่งแฟกซ์';
COMMENT ON TABLE rx_order_events IS 'ประวัติการกระทำทุกครั้งรวมถึงการเปิดดูไฟล์ ใช้ตรวจสอบย้อนหลังตาม PDPA';

COMMIT;
