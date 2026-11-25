import { nurse } from '../db';

/**
 * POST /nursing-records/analytics — วิเคราะห์บันทึกทางการพยาบาลเชิงลึก หลายหอ ตามช่วงวันที่
 *
 * ใช้เฉพาะข้อมูลที่บันทึกในระบบนี้จริง (ฐาน nurse) ไม่ถาม HIS
 *   สัญญาณชีพ / NEWS2 · บันทึกทางการพยาบาล (NANDA/NIC/NOC) · แผนการพยาบาล · Focus list
 *   บันทึกรับผู้ป่วย (คัดกรองแรกรับ) · แบบประเมินความปวด
 *
 * แบบประเมินอื่น (GCS, Braden, Fall Risk ฯลฯ) ยังไม่มีที่เก็บฝั่งเซิร์ฟเวอร์ จึงไม่อยู่ในรายงานนี้
 * ทุกตัวเลขคิดที่นี่ หน้าจอแค่วาด จะได้ไม่มีสองที่คิดไม่ตรงกัน
 */

type Set = { status?: number | string };

const MAX_RANGE_DAYS = 366;
/** บันทึกช้ากว่าเวลาเหตุการณ์เกินนี้ถือว่า "ลงย้อนหลัง" */
const LATE_ENTRY_MINUTES = 60;
/** NEWS2 ตั้งแต่นี้ต้องวัดซ้ำภายในชั่วโมง (ตามแนว RCP: medium/high = ติดตามถี่ขึ้นและแจ้งแพทย์) */
const NEWS2_ESCALATE = 5;
/** ช่องว่างระหว่างการวัดสัญญาณชีพเกินนี้ (ชั่วโมง) = ขาดการวัดไปทั้งเวร */
const VITAL_GAP_HOURS = 8;

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const int = (v: unknown) => Number(v ?? 0);

/** ช่องคัดกรองแรกรับที่สรุปเป็นสัดส่วน — ชื่อคอลัมน์คงที่ในโค้ด ไม่ได้มาจากผู้ใช้ */
const ADMIT_FIELDS = [
    'admit_method', 'consciousness', 'fall_risk_screen', 'pressure_sore_screen', 'nutrition_screening',
    'adl_level', 'readmit_28_days', 'isolation_precaution', 'emotional_state', 'breathing',
] as const;

export const getRecordsAnalytics = async (
    { body, set }: { body: { date_from: string; date_to: string; wards?: string[] }; set: Set },
) => {
    const { date_from, date_to } = body ?? {};
    if (!isDay(date_from) || !isDay(date_to) || date_from > date_to) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุช่วงวันที่ (YYYY-MM-DD) ให้ถูกต้อง' };
    }
    const days = (Date.parse(date_to) - Date.parse(date_from)) / 86_400_000 + 1;
    if (days > MAX_RANGE_DAYS) {
        set.status = 400;
        return { success: false, message: `เลือกช่วงได้ไม่เกิน ${MAX_RANGE_DAYS} วัน` };
    }
    const wards = (body.wards ?? []).map(String).filter(Boolean).slice(0, 100);
    const from = `${date_from} 00:00:00`;
    const to = `${date_to} 23:59:59`;

    /* เงื่อนไขร่วมของทุกตาราง: ไม่ถูกลบ อยู่ในช่วงเวลาเหตุการณ์ และอยู่ในหอที่เลือก */
    const scope = (col = 'record_datetime') => nurse`
        is_deleted IS NOT TRUE
        AND ${nurse(col)} BETWEEN ${from}::text::timestamp AND ${to}::text::timestamp
        AND ${wards.length ? nurse`ward_code IN ${nurse(wards)}` : nurse`TRUE`}`;

    try {
        // ───────────── สัญญาณชีพ / NEWS2 ─────────────
        const [v] = await nurse`
            SELECT COUNT(*)::int AS n,
                   COUNT(DISTINCT an)::int AS patients,
                   COUNT(*) FILTER (WHERE news2_score IS NULL)::int AS incomplete,
                   COUNT(*) FILTER (WHERE news2_risk = 'low')::int AS low,
                   COUNT(*) FILTER (WHERE news2_risk = 'medium')::int AS medium,
                   COUNT(*) FILTER (WHERE news2_risk = 'high')::int AS high,
                   COUNT(DISTINCT an) FILTER (WHERE news2_score >= ${NEWS2_ESCALATE})::int AS patients_escalate,
                   COUNT(*) FILTER (WHERE vital_o2sat < 92)::int AS spo2_low,
                   COUNT(*) FILTER (WHERE vital_bp_s < 90)::int AS sbp_low,
                   COUNT(*) FILTER (WHERE vital_t >= 38)::int AS fever,
                   COUNT(*) FILTER (WHERE vital_p > 130 OR vital_p < 40)::int AS pulse_extreme,
                   COUNT(*) FILTER (WHERE vital_r >= 25 OR vital_r <= 8)::int AS resp_extreme,
                   COUNT(*) FILTER (WHERE COALESCE(avpu, 'A') <> 'A')::int AS not_alert,
                   COUNT(*) FILTER (WHERE entry_method = 'monitor_import')::int AS from_monitor,
                   COUNT(*) FILTER (WHERE entered_at > record_datetime + ${LATE_ENTRY_MINUTES} * INTERVAL '1 minute')::int AS late,
                   COUNT(*) FILTER (WHERE entered_at > record_datetime + ${LATE_ENTRY_MINUTES} * INTERVAL '1 minute'
                                    AND COALESCE(TRIM(late_entry_reason), '') <> '')::int AS late_with_reason,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM entered_at - record_datetime) / 60)
                       FILTER (WHERE entered_at > record_datetime)::float8 AS median_entry_delay_min
            FROM nursing_vital_records WHERE ${scope()}`;

        /*
          การตอบสนองต่อ NEWS2 สูง: ครั้งที่ได้ ≥ 5 ต้องมีการวัดซ้ำของผู้ป่วยคนเดิมภายใน 60 นาที
          ครั้งถัดไปดูเลยขอบปลายช่วงไปได้หนึ่งวัน ไม่งั้นค่าที่วัดตอนท้ายช่วงจะถูกนับว่าไม่ได้วัดซ้ำ
          ช่องว่างระหว่างการวัดคิดเฉพาะคู่ที่อยู่ในช่วงทั้งสองครั้ง
        */
        const [vf] = await nurse`
            WITH seq AS (
                SELECT an, record_datetime, news2_score,
                       LEAD(record_datetime) OVER (PARTITION BY an ORDER BY record_datetime) AS next_at
                FROM nursing_vital_records
                WHERE is_deleted IS NOT TRUE
                  AND record_datetime BETWEEN ${from}::text::timestamp AND (${to}::text::timestamp + INTERVAL '1 day')
                  AND ${wards.length ? nurse`ward_code IN ${nurse(wards)}` : nurse`TRUE`}
            )
            SELECT COUNT(*) FILTER (WHERE news2_score >= ${NEWS2_ESCALATE})::int AS escalate,
                   COUNT(*) FILTER (WHERE news2_score >= ${NEWS2_ESCALATE}
                                    AND next_at <= record_datetime + INTERVAL '60 minutes')::int AS rechecked_1h,
                   COUNT(*) FILTER (WHERE next_at <= ${to}::text::timestamp
                                    AND next_at > record_datetime + ${VITAL_GAP_HOURS} * INTERVAL '1 hour')::int AS gaps,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM next_at - record_datetime) / 3600)
                       FILTER (WHERE next_at <= ${to}::text::timestamp)::float8 AS median_interval_h
            FROM seq WHERE record_datetime <= ${to}::text::timestamp`;

        const vByShift = await nurse`
            SELECT COALESCE(shift, '-') AS shift, COUNT(*)::int AS n,
                   COUNT(*) FILTER (WHERE news2_risk IN ('medium', 'high'))::int AS elevated
            FROM nursing_vital_records WHERE ${scope()} GROUP BY 1`;
        const vDaily = await nurse`
            SELECT TO_CHAR(record_datetime, 'YYYY-MM-DD') AS date, COUNT(*)::int AS n,
                   COUNT(*) FILTER (WHERE news2_risk = 'medium')::int AS medium,
                   COUNT(*) FILTER (WHERE news2_risk = 'high')::int AS high
            FROM nursing_vital_records WHERE ${scope()} GROUP BY 1 ORDER BY 1`;

        // ───────────── บันทึกทางการพยาบาล (Progress Notes) ─────────────
        const [pn] = await nurse`
            SELECT COUNT(*)::int AS n,
                   COUNT(DISTINCT an)::int AS patients,
                   COUNT(*) FILTER (WHERE COALESCE(nanda_code, '') <> '')::int AS with_nanda,
                   COUNT(*) FILTER (WHERE COALESCE(TRIM(nic_codes), '') <> '')::int AS with_nic,
                   COUNT(*) FILTER (WHERE COALESCE(TRIM(noc_codes), '') <> '')::int AS with_noc,
                   COUNT(*) FILTER (WHERE care_plan_id IS NOT NULL)::int AS linked_plan,
                   COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
                   COUNT(*) FILTER (WHERE COALESCE(entered_by_trainee, '') <> '')::int AS by_trainee,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM cosigned_at - created_at) / 3600)
                       FILTER (WHERE cosigned_at IS NOT NULL)::float8 AS median_cosign_h,
                   COUNT(*) FILTER (WHERE created_at > record_datetime + ${LATE_ENTRY_MINUTES} * INTERVAL '1 minute')::int AS late
            FROM nursing_progress_notes WHERE ${scope()}`;
        const pnType = await nurse`
            SELECT COALESCE(note_type, '-') AS key, COUNT(*)::int AS n
            FROM nursing_progress_notes WHERE ${scope()} GROUP BY 1 ORDER BY 2 DESC`;
        const pnShift = await nurse`
            SELECT COALESCE(shift, '-') AS key, COUNT(*)::int AS n
            FROM nursing_progress_notes WHERE ${scope()} GROUP BY 1`;
        const pnRole = await nurse`
            SELECT COALESCE(author_role, '-') AS key, COUNT(*)::int AS n
            FROM nursing_progress_notes WHERE ${scope()} GROUP BY 1 ORDER BY 2 DESC`;
        const topNanda = await nurse`
            SELECT n.nanda_code AS code, COALESCE(MAX(r.label_th), MAX(n.nanda_label), n.nanda_code) AS label,
                   COUNT(*)::int AS n, COUNT(DISTINCT n.an)::int AS patients
            FROM nursing_progress_notes n
            LEFT JOIN ref_nanda_diagnoses r ON r.code = n.nanda_code
            WHERE n.is_deleted IS NOT TRUE
              AND n.record_datetime BETWEEN ${from}::text::timestamp AND ${to}::text::timestamp
              AND ${wards.length ? nurse`n.ward_code IN ${nurse(wards)}` : nurse`TRUE`}
              AND COALESCE(n.nanda_code, '') <> ''
            GROUP BY n.nanda_code ORDER BY 3 DESC LIMIT 10`;
        /* รหัส NIC/NOC เก็บเป็นข้อความคั่นจุลภาค แตกออกเป็นรายรหัสก่อนนับ */
        const topCodes = (col: 'nic_codes' | 'noc_codes', ref: 'ref_nic_interventions' | 'ref_noc_outcomes') => nurse`
            SELECT c.code, COALESCE(MAX(r.label_th), MAX(r.label_en), c.code) AS label, COUNT(*)::int AS n
            FROM nursing_progress_notes n
            CROSS JOIN LATERAL (SELECT TRIM(x) AS code FROM unnest(string_to_array(n.${nurse(col)}, ',')) x) c
            LEFT JOIN ${nurse(ref)} r ON r.code = c.code
            WHERE n.is_deleted IS NOT TRUE
              AND n.record_datetime BETWEEN ${from}::text::timestamp AND ${to}::text::timestamp
              AND ${wards.length ? nurse`n.ward_code IN ${nurse(wards)}` : nurse`TRUE`}
              AND c.code <> ''
            GROUP BY c.code ORDER BY 3 DESC LIMIT 10`;
        const topNic = await topCodes('nic_codes', 'ref_nic_interventions');
        const topNoc = await topCodes('noc_codes', 'ref_noc_outcomes');

        // ───────────── แผนการพยาบาล + Focus list ─────────────
        const [cp] = await nurse`
            SELECT COUNT(*)::int AS n,
                   COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                   COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                   COUNT(*) FILTER (WHERE status = 'active' AND evaluation_date < CURRENT_DATE)::int AS overdue_eval,
                   COUNT(*) FILTER (WHERE COALESCE(nanda_code, '') <> '')::int AS with_nanda
            FROM nursing_care_plans WHERE ${scope('created_at')}`;
        const [fc] = await nurse`
            SELECT COUNT(*)::int AS n,
                   COUNT(DISTINCT an)::int AS patients,
                   COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
                   COUNT(*) FILTER (WHERE status = 'final')::int AS final,
                   COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM completed_at - record_datetime) / 3600)
                       FILTER (WHERE status = 'final' AND completed_at IS NOT NULL)::float8 AS median_complete_h,
                   COUNT(*) FILTER (WHERE status = 'draft' AND record_datetime < NOW() - INTERVAL '24 hours')::int AS stale_draft,
                   COUNT(*) FILTER (WHERE entered_at > record_datetime + ${LATE_ENTRY_MINUTES} * INTERVAL '1 minute')::int AS late
            FROM nursing_focus_records WHERE ${scope()}`;
        const topTemplates = await nurse`
            SELECT COALESCE(template_code, '-') AS code, COALESCE(MAX(template_title), template_code) AS label,
                   COUNT(*)::int AS n,
                   COUNT(*) FILTER (WHERE status = 'final')::int AS final,
                   COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
            FROM nursing_focus_records WHERE ${scope()}
            GROUP BY template_code ORDER BY 3 DESC LIMIT 10`;
        const cancelReasons = await nurse`
            SELECT COALESCE(NULLIF(TRIM(cancel_reason), ''), 'ไม่ระบุ') AS key, COUNT(*)::int AS n
            FROM nursing_focus_records WHERE ${scope()} AND status = 'cancelled'
            GROUP BY 1 ORDER BY 2 DESC LIMIT 10`;

        // ───────────── บันทึกรับผู้ป่วย (คัดกรองแรกรับ) ─────────────
        const [ad] = await nurse`
            SELECT COUNT(*)::int AS n,
                   AVG(expected_los)::float8 AS mean_expected_los,
                   COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL)::int AS reviewed,
                   COUNT(*) FILTER (WHERE fall_risk_screen IN ('moderate', 'high'))::int AS fall_risk,
                   COUNT(*) FILTER (WHERE pressure_sore_screen IN ('moderate', 'high'))::int AS pressure_risk,
                   COUNT(*) FILTER (WHERE nutrition_screening IN ('risk', 'malnutrition'))::int AS nutrition_risk,
                   COUNT(*) FILTER (WHERE readmit_28_days = 'yes')::int AS readmit,
                   COUNT(*) FILTER (WHERE fall_risk_screen IS NOT NULL AND pressure_sore_screen IS NOT NULL
                                    AND nutrition_screening IS NOT NULL AND adl_level IS NOT NULL)::int AS screened_all
            FROM nursing_admit_records WHERE ${scope()}`;
        const admitDist: Record<string, { key: string; n: number }[]> = {};
        for (const f of ADMIT_FIELDS) {
            const rows = await nurse`
                SELECT COALESCE(NULLIF(TRIM(${nurse(f)}::text), ''), '(ไม่ได้ระบุ)') AS key, COUNT(*)::int AS n
                FROM nursing_admit_records WHERE ${scope()} GROUP BY 1 ORDER BY 2 DESC`;
            admitDist[f] = rows.map(r => ({ key: String(r.key), n: int(r.n) }));
        }

        // ───────────── ความปวด ─────────────
        const [pa] = await nurse`
            SELECT COUNT(*)::int AS n,
                   AVG(pain_score)::float8 AS mean_score,
                   COUNT(*) FILTER (WHERE pain_score >= 7)::int AS severe,
                   COUNT(*) FILTER (WHERE pain_score >= 4)::int AS needs_reassess,
                   COUNT(*) FILTER (WHERE pain_score >= 4 AND reassess_score IS NOT NULL)::int AS reassessed,
                   AVG(pain_score - reassess_score) FILTER (WHERE reassess_score IS NOT NULL)::float8 AS mean_reduction
            FROM nursing_pain_records WHERE ${scope()}`;

        // ───────────── รายหอ (ทุกตารางรวมกัน) ─────────────
        const byWard = await nurse`
            WITH u AS (
                SELECT ward_code, ward_name, 'vital' AS kind, (news2_risk = 'high') AS flag FROM nursing_vital_records WHERE ${scope()}
                UNION ALL SELECT ward_code, ward_name, 'note', (status = 'draft') FROM nursing_progress_notes WHERE ${scope()}
                UNION ALL SELECT ward_code, ward_name, 'focus', (status = 'draft') FROM nursing_focus_records WHERE ${scope()}
                UNION ALL SELECT ward_code, ward_name, 'admit', FALSE FROM nursing_admit_records WHERE ${scope()}
                UNION ALL SELECT ward_code, ward_name, 'pain', (pain_score >= 7) FROM nursing_pain_records WHERE ${scope()}
            )
            SELECT ward_code, MAX(ward_name) AS ward_name,
                   COUNT(*) FILTER (WHERE kind = 'vital')::int AS vitals,
                   COUNT(*) FILTER (WHERE kind = 'vital' AND flag)::int AS news2_high,
                   COUNT(*) FILTER (WHERE kind = 'note')::int AS notes,
                   COUNT(*) FILTER (WHERE kind = 'note' AND flag)::int AS note_drafts,
                   COUNT(*) FILTER (WHERE kind = 'focus')::int AS focus,
                   COUNT(*) FILTER (WHERE kind = 'focus' AND flag)::int AS focus_drafts,
                   COUNT(*) FILTER (WHERE kind = 'admit')::int AS admits,
                   COUNT(*) FILTER (WHERE kind = 'pain')::int AS pain
            FROM u GROUP BY ward_code ORDER BY COUNT(*) DESC`;

        const keyed = (rows: readonly Record<string, unknown>[]) => rows.map(r => ({ key: String(r.key), n: int(r.n) }));

        return {
            success: true,
            data: {
                date_from, date_to,
                thresholds: {
                    late_entry_minutes: LATE_ENTRY_MINUTES, news2_escalate: NEWS2_ESCALATE, vital_gap_hours: VITAL_GAP_HOURS,
                },
                vitals: {
                    n: int(v.n), patients: int(v.patients), incomplete: int(v.incomplete),
                    risk: { low: int(v.low), medium: int(v.medium), high: int(v.high) },
                    patients_escalate: int(v.patients_escalate),
                    abnormal: {
                        spo2_low: int(v.spo2_low), sbp_low: int(v.sbp_low), fever: int(v.fever),
                        pulse_extreme: int(v.pulse_extreme), resp_extreme: int(v.resp_extreme), not_alert: int(v.not_alert),
                    },
                    from_monitor: int(v.from_monitor), from_monitor_rate: pctOf(int(v.from_monitor), int(v.n)),
                    late: int(v.late), late_rate: pctOf(int(v.late), int(v.n)), late_with_reason: int(v.late_with_reason),
                    median_entry_delay_min: num(v.median_entry_delay_min),
                    escalate: int(vf.escalate), rechecked_1h: int(vf.rechecked_1h),
                    rechecked_1h_rate: pctOf(int(vf.rechecked_1h), int(vf.escalate)),
                    gaps: int(vf.gaps), median_interval_h: num(vf.median_interval_h),
                    by_shift: ['ดึก', 'เช้า', 'บ่าย', '-'].map(s => {
                        const r = vByShift.find(x => x.shift === s);
                        return { shift: s, n: int(r?.n), elevated: int(r?.elevated) };
                    }).filter(x => x.shift !== '-' || x.n > 0),
                    daily: vDaily.map(r => ({ date: String(r.date), n: int(r.n), medium: int(r.medium), high: int(r.high) })),
                },
                notes: {
                    n: int(pn.n), patients: int(pn.patients),
                    with_nanda: int(pn.with_nanda), nanda_rate: pctOf(int(pn.with_nanda), int(pn.n)),
                    with_nic: int(pn.with_nic), with_noc: int(pn.with_noc),
                    noc_rate: pctOf(int(pn.with_noc), int(pn.n)),
                    linked_plan: int(pn.linked_plan), linked_plan_rate: pctOf(int(pn.linked_plan), int(pn.n)),
                    drafts: int(pn.drafts), by_trainee: int(pn.by_trainee),
                    median_cosign_h: num(pn.median_cosign_h),
                    late: int(pn.late), late_rate: pctOf(int(pn.late), int(pn.n)),
                    by_type: keyed(pnType), by_shift: keyed(pnShift), by_role: keyed(pnRole),
                    top_nanda: topNanda.map(r => ({ code: String(r.code), label: String(r.label), n: int(r.n), patients: int(r.patients) })),
                    top_nic: topNic.map(r => ({ code: String(r.code), label: String(r.label), n: int(r.n) })),
                    top_noc: topNoc.map(r => ({ code: String(r.code), label: String(r.label), n: int(r.n) })),
                },
                care_plans: {
                    n: int(cp.n), active: int(cp.active), resolved: int(cp.resolved),
                    overdue_eval: int(cp.overdue_eval), with_nanda: int(cp.with_nanda),
                },
                focus: {
                    n: int(fc.n), patients: int(fc.patients),
                    draft: int(fc.draft), final: int(fc.final), cancelled: int(fc.cancelled),
                    completion_rate: pctOf(int(fc.final), int(fc.n) - int(fc.cancelled)),
                    median_complete_h: num(fc.median_complete_h), stale_draft: int(fc.stale_draft),
                    late: int(fc.late),
                    top_templates: topTemplates.map(r => ({
                        code: String(r.code), label: String(r.label), n: int(r.n), final: int(r.final), cancelled: int(r.cancelled),
                    })),
                    cancel_reasons: keyed(cancelReasons),
                },
                admit: {
                    n: int(ad.n), reviewed: int(ad.reviewed), reviewed_rate: pctOf(int(ad.reviewed), int(ad.n)),
                    mean_expected_los: num(ad.mean_expected_los),
                    fall_risk: int(ad.fall_risk), fall_risk_rate: pctOf(int(ad.fall_risk), int(ad.n)),
                    pressure_risk: int(ad.pressure_risk), pressure_risk_rate: pctOf(int(ad.pressure_risk), int(ad.n)),
                    nutrition_risk: int(ad.nutrition_risk), nutrition_risk_rate: pctOf(int(ad.nutrition_risk), int(ad.n)),
                    readmit: int(ad.readmit), readmit_rate: pctOf(int(ad.readmit), int(ad.n)),
                    screened_all: int(ad.screened_all), screened_all_rate: pctOf(int(ad.screened_all), int(ad.n)),
                    dist: admitDist,
                },
                pain: {
                    n: int(pa.n), mean_score: num(pa.mean_score), severe: int(pa.severe),
                    needs_reassess: int(pa.needs_reassess), reassessed: int(pa.reassessed),
                    reassessed_rate: pctOf(int(pa.reassessed), int(pa.needs_reassess)),
                    mean_reduction: num(pa.mean_reduction),
                },
                by_ward: byWard.map(r => ({
                    ward_code: String(r.ward_code ?? ''), ward_name: String(r.ward_name ?? r.ward_code ?? '-'),
                    vitals: int(r.vitals), news2_high: int(r.news2_high), notes: int(r.notes), note_drafts: int(r.note_drafts),
                    focus: int(r.focus), focus_drafts: int(r.focus_drafts), admits: int(r.admits), pain: int(r.pain),
                })),
            },
        };
    } catch (error) {
        console.error('Records analytics error:', error);
        set.status = 500;
        return { success: false, message: 'คำนวณรายงานไม่สำเร็จ' };
    }
};
