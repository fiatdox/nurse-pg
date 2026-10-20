-- สิทธิ์การมองเห็นเมนูรายกลุ่มผู้ใช้
-- ฐานข้อมูล: nurse

/*
  เก็บเฉพาะสิ่งที่ผู้ดูแลระบบ "แก้จากค่าเริ่มต้น" ไม่ได้เก็บทั้งตาราง

  ค่าเริ่มต้นว่ากลุ่มไหนเห็นเมนูไหนอยู่ในโค้ดหน้าจอ (app/lib/menu.tsx)
  เพราะเมนูเกิดพร้อมหน้าจอเสมอ ถ้าต้องมาเพิ่มแถวในฐานข้อมูลทุกครั้งที่มีเมนูใหม่
  วันที่ลืมเพิ่มคือวันที่เมนูใหม่หายไปจากสายตาทุกคนโดยไม่มีใครรู้ว่าทำไม

  แถวในตารางนี้จึงอ่านว่า "ข้อยกเว้น" เท่านั้น ไม่มีแถว = ใช้ค่าเริ่มต้นของเมนูนั้น

  กลุ่มผู้ใช้ไม่ได้เก็บที่นี่และไม่ได้เก็บที่ไหนเลย มาจากกลุ่มงานในทะเบียนบุคลากร
  (core_kon) โดยตรง ดู src/utils/userGroup.ts — คนย้ายกลุ่มงานแล้วเมนูเปลี่ยนตามเอง
  ไม่ต้องมีใครมาตามปิดสิทธิ์ ซึ่งเป็นงานที่ถูกลืมเสมอเวลาคนย้ายหน่วย
*/

BEGIN;

CREATE TABLE IF NOT EXISTS menu_access (
    /* รหัสเมนู ตั้งในโค้ดหน้าจอ เช่น 'ipd.rx-order' ไม่ใช้ URL เพราะ URL เดียวอยู่ได้หลายเมนู */
    menu_key    varchar(100) NOT NULL,
    /* nursing · pharmacy · nutrition · vendor · admin */
    group_key   varchar(20)  NOT NULL,
    visible     boolean      NOT NULL,
    updated_by      varchar(100),
    updated_by_name varchar(150),
    updated_at  timestamp    NOT NULL DEFAULT now(),
    PRIMARY KEY (menu_key, group_key)
);

CREATE INDEX IF NOT EXISTS ix_menu_access_group ON menu_access (group_key);

COMMENT ON TABLE menu_access IS 'ข้อยกเว้นการมองเห็นเมนูรายกลุ่ม ไม่มีแถว = ใช้ค่าเริ่มต้นในโค้ดหน้าจอ';

COMMIT;
