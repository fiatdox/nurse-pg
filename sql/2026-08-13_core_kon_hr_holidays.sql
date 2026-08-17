-- ตารางวันหยุดขององค์กร — core_kon (ฐาน hris)
--
-- ⚠️ ไฟล์นี้ยังไม่ได้รัน เป็นแบบร่างให้ตรวจก่อน
-- core_kon เป็นฐานข้อมูลกลางที่ระบบอื่นใช้ร่วมกัน (HR, IT, สถิติ, บริจาค)
-- การสร้างตารางที่นี่กระทบมากกว่าฐานของงานพยาบาล จึงควรได้รับอนุมัติก่อนรัน
--
-- ขอบเขต: เก็บเฉพาะ "วันหยุดที่ประกาศเป็นรายวัน" เท่านั้น
-- ไม่เก็บวันเสาร์–อาทิตย์ เพราะรู้ได้จากตัววันที่เองอยู่แล้ว การเก็บซ้ำมีแต่จะทำให้
-- ข้อมูลไม่ตรงกันเมื่อมีคนลืมเติมเสาร์อาทิตย์ของปีถัดไป
--
-- กติกาที่ผู้ใช้ข้อมูลต้องใช้ร่วมกัน:
--     เป็นวันหยุด = (เสาร์ หรือ อาทิตย์) หรือ (มีแถวที่ยัง is_active ในตารางนี้)
--
-- ตารางนี้ตอบแค่ว่า "วันไหนเป็นวันหยุด" ไม่ตัดสินว่าแต่ละระบบจะทำอะไรกับมัน
-- งานพยาบาลจะเอาไปใช้ปรับอัตรากำลังและอัตราค่าตอบแทน ส่วน HR อาจใช้คิดวันลา
-- ถ้าใส่นโยบายของงานพยาบาลลงตารางกลาง ระบบอื่นจะได้รับผลกระทบโดยไม่ตั้งใจ

-- ชื่อตาราง: ใช้คำนำหน้า hr_ ตามโมดูลอื่นในฐานนี้ (hr_leave_requests, hr_leave_types,
-- hr_settings) และเพราะวันหยุดเป็นเรื่องของงานบุคคล ไม่ใช่ของงานพยาบาลอย่างเดียว
-- ถ้าต้องการชื่อ core_kon.holiday ตามที่คุยไว้ ให้เปลี่ยนเฉพาะชื่อในไฟล์นี้ได้เลย

CREATE TABLE IF NOT EXISTS core_kon.hr_holidays (
    id serial PRIMARY KEY,

    holiday_date date NOT NULL,
    name_th      varchar(200) NOT NULL,

    -- public       = วันหยุดราชการประจำปี (ปีใหม่ สงกรานต์ วันเฉลิมฯ)
    -- substitution = วันหยุดชดเชย เมื่อวันหยุดตรงกับเสาร์–อาทิตย์
    -- special      = วันหยุดพิเศษตามมติคณะรัฐมนตรี ประกาศเป็นครั้งคราว
    -- organization = วันหยุดเฉพาะของโรงพยาบาล
    holiday_type varchar(20) NOT NULL DEFAULT 'public',

    note       varchar(300),

    -- ยกเลิกวันหยุดที่ประกาศไว้แล้วเกิดขึ้นได้จริง (มติ ครม. เปลี่ยน)
    -- ใช้ปิดการใช้งานแทนการลบ เพื่อให้ตารางเวรที่จัดไปแล้วตามรอยได้ว่าตอนนั้นยึดอะไร
    is_active  boolean NOT NULL DEFAULT true,

    created_at timestamptz NOT NULL DEFAULT now(),
    created_by integer,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by integer,

    CONSTRAINT ck_hr_holidays_type
        CHECK (holiday_type IN ('public', 'substitution', 'special', 'organization'))
);

-- หนึ่งวันมีได้แถวเดียว เพื่อไม่ให้ระบบที่นับจำนวนวันหยุดนับซ้ำ
-- ถ้าปีไหนมีวันหยุดสองอย่างตรงกัน ให้เขียนรวมไว้ในชื่อเดียว
-- เป็น partial index เพื่อให้ยกเลิกวันหยุดเดิมแล้วประกาศใหม่วันเดียวกันได้
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_holidays_date
    ON core_kon.hr_holidays (holiday_date) WHERE is_active;

COMMENT ON TABLE core_kon.hr_holidays IS
    'วันหยุดขององค์กรที่ประกาศเป็นรายวัน — ไม่รวมเสาร์–อาทิตย์ซึ่งดูจากตัววันที่ได้เอง';
COMMENT ON COLUMN core_kon.hr_holidays.holiday_type IS
    'public=วันหยุดราชการ substitution=วันหยุดชดเชย special=มติ ครม. organization=เฉพาะโรงพยาบาล';
COMMENT ON COLUMN core_kon.hr_holidays.is_active IS
    'false = ยกเลิกประกาศแล้ว เก็บแถวไว้เพื่อตามรอยว่าตอนจัดเวรยึดอะไรเป็นเกณฑ์';


-- ---------------------------------------------------------------------------
-- ตัวอย่างการใช้งาน (ไม่ได้รัน — ไว้อ้างอิงตอนเขียนโค้ด)
-- ---------------------------------------------------------------------------
--
-- ตรวจว่าวันหนึ่งเป็นวันหยุดหรือไม่:
--   SELECT EXTRACT(ISODOW FROM d) IN (6, 7)                         AS is_weekend,
--          EXISTS (SELECT 1 FROM core_kon.hr_holidays h
--                   WHERE h.holiday_date = d AND h.is_active)       AS is_holiday
--   FROM (SELECT DATE '2026-12-05' AS d) t;
--
-- ดึงวันหยุดทั้งเดือน เพื่อส่งให้หน้าจัดเวรระบายสี:
--   SELECT holiday_date, name_th, holiday_type
--   FROM core_kon.hr_holidays
--   WHERE is_active AND holiday_date >= DATE '2026-08-01'
--                   AND holiday_date <  DATE '2026-09-01'
--   ORDER BY holiday_date;
--
-- ตัวอย่างข้อมูลที่จะกรอก (วันจันทรคติเปลี่ยนทุกปี ต้องกรอกรายปี คำนวณล่วงหน้าไม่ได้):
--   INSERT INTO core_kon.hr_holidays (holiday_date, name_th, holiday_type) VALUES
--     ('2026-01-01', 'วันขึ้นปีใหม่',                'public'),
--     ('2026-04-06', 'วันจักรี',                     'public'),
--     ('2026-04-13', 'วันสงกรานต์',                  'public'),
--     ('2026-04-14', 'วันสงกรานต์',                  'public'),
--     ('2026-04-15', 'วันสงกรานต์',                  'public'),
--     ('2026-12-07', 'ชดเชยวันคล้ายวันพระบรมราชสมภพ', 'substitution');
