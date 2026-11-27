-- บันทึกการตามทีม RRT (Rapid Response Team) และคัดกรอง sepsis (qSOFA)
-- ฐานข้อมูล: nurse
--
-- เกณฑ์ของโรงพยาบาล: NEWS2 ≥ 5 ต้องตาม RRT
-- ทุกครั้งที่ถึงเกณฑ์ต้องมีบันทึก 1 แถว: ตามแล้ว (called) หรือไม่ได้ตามพร้อมเหตุผล (not_called เช่น DNR, แพทย์อยู่ที่เตียงแล้ว)
-- ตัวชี้วัด: เวลาตอบสนอง (team_arrived_at - called_at), ถึงเกณฑ์แต่ไม่ได้ตาม, ผลลัพธ์ (ย้าย ICU / CPR / เสียชีวิต)
-- sepsis: qSOFA (RR ≥ 22, SBP ≤ 100, ความรู้สึกตัวเปลี่ยน) ≥ 2 ร่วมกับสงสัยติดเชื้อ = คัดกรองพบ

CREATE TABLE IF NOT EXISTS nursing_rrt_calls (
    id                    bigserial PRIMARY KEY,
    an                    varchar(20)  NOT NULL,
    ward_code             varchar(20),
    ward_name             varchar(200),
    vital_id              bigint,                    -- สัญญาณชีพที่ทำให้ถึงเกณฑ์ (ว่างได้ ถ้าตามด้วยเหตุอื่น เช่น พยาบาลกังวล)
    trigger_at            timestamp    NOT NULL,     -- เวลาที่ถึงเกณฑ์
    trigger_reason        varchar(20)  NOT NULL CHECK (trigger_reason IN ('news2', 'nurse_concern', 'other')),
    news2_score           smallint,
    qsofa_score           smallint CHECK (qsofa_score BETWEEN 0 AND 3),
    suspected_infection   boolean      NOT NULL DEFAULT false,
    sepsis_screen_positive boolean     NOT NULL DEFAULT false,  -- qSOFA ≥ 2 และสงสัยติดเชื้อ (คำนวณที่ server)
    status                varchar(12)  NOT NULL CHECK (status IN ('called', 'not_called')),
    not_called_reason     text,
    called_at             timestamp,
    notified_to           varchar(200),              -- ผู้รับแจ้ง เช่น แพทย์เวร / ทีม RRT
    team_arrived_at       timestamp,
    outcome               varchar(20) CHECK (outcome IN ('stay_ward', 'transfer_icu', 'transfer_other', 'cpr', 'death', 'other')),
    outcome_note          text,
    note                  text,
    staff_id              varchar(50),
    nurse_name            varchar(200),
    created_at            timestamp NOT NULL DEFAULT now(),
    created_by            varchar(100),
    updated_at            timestamp NOT NULL DEFAULT now(),
    updated_by            varchar(100),
    is_deleted            boolean   NOT NULL DEFAULT false,
    CONSTRAINT chk_rrt_called CHECK (status <> 'called' OR called_at IS NOT NULL),
    CONSTRAINT chk_rrt_not_called CHECK (status <> 'not_called' OR coalesce(trim(not_called_reason), '') <> ''),
    CONSTRAINT chk_rrt_arrival CHECK (team_arrived_at IS NULL OR called_at IS NULL OR team_arrived_at >= called_at)
);
COMMENT ON TABLE nursing_rrt_calls IS 'การตามทีม RRT เมื่อถึงเกณฑ์ (NEWS2 ≥ 5) และคัดกรอง sepsis ด้วย qSOFA';

CREATE INDEX IF NOT EXISTS idx_nursing_rrt_calls_an
    ON nursing_rrt_calls (an, trigger_at DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_nursing_rrt_calls_vital
    ON nursing_rrt_calls (vital_id) WHERE NOT is_deleted AND vital_id IS NOT NULL;
