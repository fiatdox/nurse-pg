import { Context } from 'elysia';
import { nurse } from '../db';
import { resolveActor } from '../utils/nursingRecord';
import { sanitizeHTML } from '../utils/sanitize';

/**
 * Dashboard ระบบส่งใบสั่งยา หอผู้ป่วย → ห้องยา
 *
 * คิดทุกตัวเลขในฐานข้อมูลแล้วส่งเฉพาะผลรวม ไม่ส่งรายใบออกไป
 * หน้าจอจึงไม่ได้รับชื่อหรือ HN ผู้ป่วยเลย (ชื่อที่มีคือชื่อเจ้าหน้าที่ผู้ทำงาน)
 *
 * ระยะเวลาทุกตัวเป็นวินาที ให้หน้าจอแปลงเป็นนาทีเอง
 * ใช้มัธยฐาน (P50) กับ P90 ไม่ใช้ค่าเฉลี่ย เพราะใบที่ค้างข้ามเวรใบเดียวดึงค่าเฉลี่ยไปไกล
 * จนอ่านไม่ออกว่างานปกติเร็วแค่ไหน ส่วน P90 บอกว่าใบที่ช้าช้าแค่ไหน
 *
 * ขั้นของใบ (ดู sql/2026-10-19_rx_status_*.sql)
 *   ส่ง (submitted_at) → รับ (ack_at) → คีย์ HIS (completed_at) / จัดยาเสร็จ (prepared_at)
 *   → ตึกมารับ (closed_at เมื่อ status = picked_up)
 *   หรือ ส่งกลับ (rejected_at) → ปิดเรื่อง (closed_at เมื่อ status = closed)
 * คีย์ HIS กับจัดยาสลับลำดับกันได้ จึงวัดทั้งสองจากเวลารับ ไม่ได้วัดต่อกัน
 */

/**
 * เวลาที่ห้องยาควรรับใบ แยกตามความด่วน — ตรงกับ STALE_SECONDS ของหน้าคิวห้องยา
 * ใบที่เกินเวลานี้ขึ้นเตือนสีแดงบนคิว dashboard จึงนับว่า "ไม่ทันเวลา" ด้วยเกณฑ์เดียวกัน
 */
export const RX_SLA_SECONDS = { stat: 5 * 60, discharge: 10 * 60, routine: 20 * 60 } as const;

const MAX_SPAN_DAYS = 366;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const int = (v: unknown) => Number(v ?? 0);

/** ชุดสถิติระยะเวลาเดียวกันทุกขั้น เขียนที่เดียวจะได้ไม่มีขั้นไหนคิดคนละแบบ */
const durationCols = (col: string) => nurse.unsafe(`
     percentile_cont(0.5) WITHIN GROUP (ORDER BY ${col}) AS ${col}_p50
    ,percentile_cont(0.9) WITHIN GROUP (ORDER BY ${col}) AS ${col}_p90
    ,COUNT(${col})::int AS ${col}_n`);

/*
  เกณฑ์เวลาตามความด่วนเป็นค่าคงที่ในโค้ด ฝังลง SQL ตรง ๆ ได้ ไม่ต้องเป็นพารามิเตอร์
  (พารามิเตอร์ตัวเลขในทุกแขนงของ CASE ทำให้ PG ต้องเดาชนิด ซึ่งพลาดได้)
*/
const slaOf = (col: string) => nurse.unsafe(
    `CASE ${col} WHEN 'stat' THEN ${RX_SLA_SECONDS.stat} WHEN 'discharge' THEN ${RX_SLA_SECONDS.discharge} ELSE ${RX_SLA_SECONDS.routine} END`);

const STAGES = ['t_first', 't_key', 't_prep', 't_lead', 't_pickup', 't_total'] as const;

const pickDurations = (r: Record<string, unknown>) => Object.fromEntries(STAGES.map(s => [s, {
    p50: num(r[`${s}_p50`]),
    p90: num(r[`${s}_p90`]),
    n: int(r[`${s}_n`]),
}]));

export const getRxDashboard = async ({ query, user, set }: Context & { user?: unknown }) => {
    const actor = await resolveActor(user);
    if (!actor) { set.status = 401; return { success: false, message: 'ไม่พบข้อมูลผู้ใช้' }; }

    const q = query as { from?: string; to?: string; wards?: string; priorities?: string } | undefined;

    const today = new Date();
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const to = q?.to && RE_DATE.test(q.to) ? q.to : iso(today);
    const from = q?.from && RE_DATE.test(q.from) ? q.from : iso(new Date(today.getTime() - 29 * 86_400_000));

    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (!(span >= 0)) { set.status = 400; return { success: false, message: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด' }; }
    if (span > MAX_SPAN_DAYS) {
        set.status = 400;
        return { success: false, message: `เลือกช่วงได้ไม่เกิน ${MAX_SPAN_DAYS} วัน` };
    }

    const wards = String(q?.wards ?? '').split(',').map(v => Number(v.trim()))
        .filter(v => Number.isInteger(v) && v > 0);
    const prios = String(q?.priorities ?? '').split(',').map(v => v.trim())
        .filter(v => ['routine', 'discharge', 'stat'].includes(v));

    /*
      ต่อเงื่อนไขเฉพาะตอนมีค่า และแปลงวันที่ผ่าน ::text ก่อนเสมอ
      เหตุผลเดียวกับ listRxOrders — พารามิเตอร์ null หาชนิดไม่เจอ และ timestamp ที่ส่งตรง ๆ ถูกเลื่อนเขตเวลา
    */
    const wardCond = wards.length ? nurse`AND o.ward IN ${nurse(wards)}` : nurse``;
    const prioCond = prios.length && prios.length < 3 ? nurse`AND o.priority IN ${nurse(prios)}` : nurse``;

    /*
      ใบในช่วงที่เลือก พร้อมระยะเวลาแต่ละขั้น

      t_first = ส่ง → ห้องยาตอบครั้งแรก (กดรับ หรือส่งกลับ) ใช้วัดว่าทันเวลาไหม
                ใบที่ถูกส่งกลับโดยไม่ได้กดรับก่อนก็ถือว่าห้องยาตอบแล้ว
      t_key   = รับ → คีย์ลง HIS เสร็จ
      t_prep  = รับ → จัดยาเสร็จ
      t_lead  = ส่ง → จัดยาเสร็จ (ตึกมารับได้) — ตัวเลขที่หอรู้สึกจริง
      t_pickup= จัดยาเสร็จ → ตึกมารับ (ยาวางรอที่เคาน์เตอร์นานแค่ไหน)
      t_total = ส่ง → ตึกมารับ

      sla_ok  = true/false ตามเกณฑ์ความด่วน
                ใบที่ยังไม่มีใครตอบ: เกินเวลาแล้ว = false, ยังไม่เกิน = null (ยังตัดสินไม่ได้ ไม่นับ)
    */
    const base = nurse`
        SELECT
             o.rx_order_id, o.ward, o.hn, o.priority, o.status, o.hn_source, o.his_verified,
             o.tube_feed, o.resend_of, o.reject_reason, o.submitted_at, o.rejected_at,
             o.ack_by, o.ack_by_name, o.completed_by, o.completed_by_name,
             o.prepared_by, o.prepared_by_name, o.closed_by, o.closed_by_name,
             o.rejected_by, o.rejected_by_name,
             w.ward_name,
             EXTRACT(EPOCH FROM (COALESCE(o.ack_at, o.rejected_at) - o.submitted_at))::float8 AS t_first,
             EXTRACT(EPOCH FROM (o.ack_at - o.submitted_at))::float8                         AS t_ack,
             EXTRACT(EPOCH FROM (o.completed_at - o.ack_at))::float8                         AS t_key,
             EXTRACT(EPOCH FROM (o.prepared_at - o.ack_at))::float8                          AS t_prep,
             EXTRACT(EPOCH FROM (o.prepared_at - o.submitted_at))::float8                    AS t_lead,
             EXTRACT(EPOCH FROM (CASE WHEN o.status = 'picked_up' THEN o.closed_at END
                                 - o.prepared_at))::float8                                   AS t_pickup,
             EXTRACT(EPOCH FROM (CASE WHEN o.status = 'picked_up' THEN o.closed_at END
                                 - o.submitted_at))::float8                                  AS t_total,
             CASE
                 WHEN COALESCE(o.ack_at, o.rejected_at) IS NOT NULL
                     THEN EXTRACT(EPOCH FROM (COALESCE(o.ack_at, o.rejected_at) - o.submitted_at))
                          <= ${slaOf('o.priority')}
                 WHEN EXTRACT(EPOCH FROM (LOCALTIMESTAMP - o.submitted_at))
                      > ${slaOf('o.priority')}
                     THEN false
             END AS sla_ok
        FROM rx_orders o
        LEFT JOIN ward w ON w.ward = o.ward
        WHERE o.submitted_at >= ${from}::text::date
          AND o.submitted_at <  ${to}::text::date + 1
          ${wardCond} ${prioCond}`;

    const slaCols = nurse`
         COUNT(*) FILTER (WHERE sla_ok)::int          AS sla_met
        ,COUNT(*) FILTER (WHERE sla_ok IS NOT NULL)::int AS sla_n`;

    try {
        const [
            [summary], byPriority, daily, heat, hourly, byWard, staffRows,
            reasons, hnSource, leadHist, [backlog], [fileStats],
        ] = await Promise.all([
            nurse`
                WITH b AS (${base})
                SELECT
                     COUNT(*)::int                                                AS orders
                    ,COUNT(DISTINCT hn)::int                                      AS patients
                    ,COUNT(DISTINCT ward)::int                                    AS wards
                    ,COUNT(*) FILTER (WHERE priority = 'stat')::int               AS stat
                    ,COUNT(*) FILTER (WHERE priority = 'discharge')::int          AS discharge
                    ,COUNT(*) FILTER (WHERE priority = 'routine')::int            AS routine
                    ,COUNT(*) FILTER (WHERE rejected_at IS NOT NULL)::int         AS rejected
                    ,COUNT(*) FILTER (WHERE resend_of IS NOT NULL)::int           AS resends
                    ,COUNT(*) FILTER (WHERE status = 'picked_up')::int            AS picked_up
                    ,COUNT(*) FILTER (WHERE status IN ('submitted','acknowledged','completed','prepared'))::int AS open
                    ,COUNT(*) FILTER (WHERE NOT his_verified)::int                AS unverified
                    ,COUNT(*) FILTER (WHERE tube_feed)::int                       AS tube_feed
                    ,${slaCols}
                    ,${durationCols('t_first')}, ${durationCols('t_key')}, ${durationCols('t_prep')}
                    ,${durationCols('t_lead')}, ${durationCols('t_pickup')}, ${durationCols('t_total')}
                FROM b`,

            nurse`
                WITH b AS (${base})
                SELECT priority
                    ,COUNT(*)::int AS orders
                    ,COUNT(*) FILTER (WHERE rejected_at IS NOT NULL)::int AS rejected
                    ,${slaCols}
                    ,${durationCols('t_first')}, ${durationCols('t_key')}, ${durationCols('t_prep')}
                    ,${durationCols('t_lead')}, ${durationCols('t_pickup')}, ${durationCols('t_total')}
                FROM b GROUP BY priority`,

            /* วันที่ไม่มีใบต้องอยู่ในกราฟเป็นศูนย์ ไม่ใช่หายไป ไม่งั้นเส้นจะลากข้ามวันหยุดเหมือนงานต่อเนื่อง */
            nurse`
                WITH b AS (${base}),
                days AS (
                    SELECT generate_series(${from}::text::date, ${to}::text::date, INTERVAL '1 day')::date AS d
                )
                SELECT TO_CHAR(days.d, 'YYYY-MM-DD') AS date
                    ,COUNT(b.rx_order_id)::int                                  AS orders
                    ,COUNT(*) FILTER (WHERE b.priority = 'stat')::int           AS stat
                    ,COUNT(*) FILTER (WHERE b.priority = 'discharge')::int      AS discharge
                    ,COUNT(*) FILTER (WHERE b.priority = 'routine')::int        AS routine
                    ,COUNT(*) FILTER (WHERE b.rejected_at IS NOT NULL)::int     AS rejected
                    ,COUNT(*) FILTER (WHERE b.sla_ok)::int                      AS sla_met
                    ,COUNT(*) FILTER (WHERE b.sla_ok IS NOT NULL)::int          AS sla_n
                    ,percentile_cont(0.5) WITHIN GROUP (ORDER BY b.t_first)     AS t_first_p50
                    ,percentile_cont(0.5) WITHIN GROUP (ORDER BY b.t_lead)      AS t_lead_p50
                    ,percentile_cont(0.9) WITHIN GROUP (ORDER BY b.t_lead)      AS t_lead_p90
                FROM days
                LEFT JOIN b ON b.submitted_at::date = days.d
                GROUP BY days.d ORDER BY days.d`,

            nurse`
                WITH b AS (${base})
                SELECT EXTRACT(ISODOW FROM submitted_at)::int AS dow
                    ,EXTRACT(HOUR FROM submitted_at)::int     AS hour
                    ,COUNT(*)::int                            AS orders
                FROM b GROUP BY 1, 2`,

            nurse`
                WITH b AS (${base})
                SELECT EXTRACT(HOUR FROM submitted_at)::int AS hour
                    ,COUNT(*)::int AS orders
                    ,${slaCols}
                    ,percentile_cont(0.5) WITHIN GROUP (ORDER BY t_first) AS t_first_p50
                    ,percentile_cont(0.9) WITHIN GROUP (ORDER BY t_first) AS t_first_p90
                FROM b GROUP BY 1 ORDER BY 1`,

            nurse`
                WITH b AS (${base})
                SELECT ward, MAX(ward_name) AS ward_name
                    ,COUNT(*)::int                                            AS orders
                    ,COUNT(DISTINCT hn)::int                                  AS patients
                    ,COUNT(*) FILTER (WHERE priority = 'stat')::int           AS stat
                    ,COUNT(*) FILTER (WHERE priority = 'discharge')::int      AS discharge
                    ,COUNT(*) FILTER (WHERE priority = 'routine')::int        AS routine
                    ,COUNT(*) FILTER (WHERE rejected_at IS NOT NULL)::int     AS rejected
                    ,COUNT(*) FILTER (WHERE resend_of IS NOT NULL)::int       AS resends
                    ,COUNT(*) FILTER (WHERE NOT his_verified)::int            AS unverified
                    ,COUNT(*) FILTER (WHERE tube_feed)::int                   AS tube_feed
                    ,${slaCols}
                    ,${durationCols('t_first')}, ${durationCols('t_lead')}, ${durationCols('t_pickup')}
                FROM b GROUP BY ward ORDER BY orders DESC`,

            /*
              ผลงานรายคน — หนึ่งใบมีได้หลายคนทำคนละขั้น จึงแตกเป็นแถวตามบทบาทก่อนแล้วค่อยรวม
              เวลาที่ผูกกับแต่ละบทบาทคือเวลาของขั้นที่คนนั้นกดจบ
            */
            nurse`
                WITH b AS (${base}),
                roles AS (
                    SELECT ack_by AS u, ack_by_name AS n, 'ack' AS role, t_ack AS t FROM b WHERE ack_by IS NOT NULL
                    UNION ALL
                    SELECT completed_by, completed_by_name, 'key', t_key FROM b WHERE completed_by IS NOT NULL
                    UNION ALL
                    SELECT prepared_by, prepared_by_name, 'prep', t_prep FROM b WHERE prepared_by IS NOT NULL
                    UNION ALL
                    SELECT closed_by, closed_by_name, 'handover', t_pickup FROM b
                        WHERE status = 'picked_up' AND closed_by IS NOT NULL
                    UNION ALL
                    SELECT rejected_by, rejected_by_name, 'reject', NULL FROM b WHERE rejected_by IS NOT NULL
                )
                SELECT u AS username, MAX(n) AS name
                    ,COUNT(*) FILTER (WHERE role = 'ack')::int       AS ack
                    ,COUNT(*) FILTER (WHERE role = 'key')::int       AS key
                    ,COUNT(*) FILTER (WHERE role = 'prep')::int      AS prep
                    ,COUNT(*) FILTER (WHERE role = 'handover')::int  AS handover
                    ,COUNT(*) FILTER (WHERE role = 'reject')::int    AS reject
                    ,percentile_cont(0.5) WITHIN GROUP (ORDER BY t) FILTER (WHERE role = 'ack')  AS t_ack_p50
                    ,percentile_cont(0.5) WITHIN GROUP (ORDER BY t) FILTER (WHERE role = 'key')  AS t_key_p50
                    ,percentile_cont(0.5) WITHIN GROUP (ORDER BY t) FILTER (WHERE role = 'prep') AS t_prep_p50
                FROM roles GROUP BY u ORDER BY COUNT(*) DESC`,

            /* เหตุผลที่ส่งกลับ — จัดกลุ่มแบบตัดช่องว่างและตัวพิมพ์ เหตุผลเดียวกันที่พิมพ์ต่างกันนิดหน่อยจะรวมกัน */
            nurse`
                WITH b AS (${base})
                SELECT MAX(reject_reason) AS reason, COUNT(*)::int AS n
                    ,TO_CHAR(MAX(rejected_at), 'YYYY-MM-DD HH24:MI') AS last_at
                FROM b WHERE rejected_at IS NOT NULL AND reject_reason IS NOT NULL
                GROUP BY LOWER(REGEXP_REPLACE(TRIM(reject_reason), '\\s+', ' ', 'g'))
                ORDER BY n DESC, last_at DESC LIMIT 15`,

            nurse`
                WITH b AS (${base})
                SELECT hn_source
                    ,COUNT(*)::int AS orders
                    ,COUNT(*) FILTER (WHERE his_verified)::int AS verified
                    ,COUNT(*) FILTER (WHERE rejected_at IS NOT NULL)::int AS rejected
                FROM b GROUP BY hn_source`,

            /* ช่วงเวลา ส่ง → จัดยาเสร็จ เป็นนาที ขอบช่วงตั้งให้อ่านง่าย ไม่ใช่เท่ากันทุกช่อง */
            nurse`
                WITH b AS (${base})
                SELECT bucket, COUNT(*)::int AS n FROM (
                    SELECT CASE
                        WHEN t_lead < 600   THEN 0
                        WHEN t_lead < 1200  THEN 1
                        WHEN t_lead < 1800  THEN 2
                        WHEN t_lead < 2700  THEN 3
                        WHEN t_lead < 3600  THEN 4
                        WHEN t_lead < 5400  THEN 5
                        WHEN t_lead < 7200  THEN 6
                        ELSE 7 END AS bucket
                    FROM b WHERE t_lead IS NOT NULL
                ) x GROUP BY bucket ORDER BY bucket`,

            /*
              งานค้างตอนนี้ — ไม่ขึ้นกับช่วงวันที่ที่เลือก (ใบค้างจากเมื่อวานก็ยังเป็นงานที่ต้องทำ)
              แต่ยังกรองตามตึกและความด่วนที่เลือก
            */
            nurse`
                SELECT
                     COUNT(*) FILTER (WHERE status = 'submitted')::int     AS waiting
                    ,COUNT(*) FILTER (WHERE status = 'acknowledged')::int  AS working
                    ,COUNT(*) FILTER (WHERE status = 'completed')::int     AS keyed
                    ,COUNT(*) FILTER (WHERE status = 'prepared')::int      AS ready
                    ,COUNT(*) FILTER (WHERE status = 'rejected')::int      AS rejected_open
                    ,COUNT(*) FILTER (WHERE status = 'submitted' AND
                        EXTRACT(EPOCH FROM (LOCALTIMESTAMP - submitted_at)) >
                        ${slaOf('o.priority')})::int AS overdue
                    ,MAX(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - submitted_at)))
                        FILTER (WHERE status = 'submitted')::float8         AS oldest_waiting
                    ,MAX(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - prepared_at)))
                        FILTER (WHERE status = 'prepared')::float8          AS oldest_ready
                FROM rx_orders o
                WHERE status IN ('submitted','acknowledged','completed','prepared','rejected')
                  ${wardCond} ${prioCond}`,

            /* หน้าเอกสารต่อใบ และการเปิดดูไฟล์ (ห้องยาเปิดดูซ้ำบ่อยแปลว่าภาพอ่านยาก) */
            nurse`
                WITH b AS (${base})
                SELECT
                     (SELECT COUNT(*) FROM rx_order_files f WHERE f.rx_order_id IN (SELECT rx_order_id FROM b))::int AS files
                    ,(SELECT COUNT(*) FROM rx_order_events e
                        WHERE e.action = 'view_file' AND e.rx_order_id IN (SELECT rx_order_id FROM b))::int AS views`,
        ]);

        const pct = (met: unknown, n: unknown) => (int(n) > 0 ? int(met) / int(n) : null);

        return {
            success: true,
            data: {
                range: { from, to, days: span + 1 },
                sla_seconds: RX_SLA_SECONDS,
                summary: {
                    orders: int(summary.orders),
                    patients: int(summary.patients),
                    wards: int(summary.wards),
                    by_priority: { stat: int(summary.stat), discharge: int(summary.discharge), routine: int(summary.routine) },
                    rejected: int(summary.rejected),
                    resends: int(summary.resends),
                    picked_up: int(summary.picked_up),
                    open: int(summary.open),
                    unverified: int(summary.unverified),
                    tube_feed: int(summary.tube_feed),
                    sla: { met: int(summary.sla_met), n: int(summary.sla_n), rate: pct(summary.sla_met, summary.sla_n) },
                    durations: pickDurations(summary),
                    files: int(fileStats?.files),
                    file_views: int(fileStats?.views),
                },
                by_priority: byPriority.map(r => ({
                    priority: String(r.priority),
                    orders: int(r.orders),
                    rejected: int(r.rejected),
                    sla: { met: int(r.sla_met), n: int(r.sla_n), rate: pct(r.sla_met, r.sla_n) },
                    durations: pickDurations(r),
                })),
                daily: daily.map(r => ({
                    date: String(r.date),
                    orders: int(r.orders),
                    stat: int(r.stat), discharge: int(r.discharge), routine: int(r.routine),
                    rejected: int(r.rejected),
                    sla: { met: int(r.sla_met), n: int(r.sla_n), rate: pct(r.sla_met, r.sla_n) },
                    t_first_p50: num(r.t_first_p50),
                    t_lead_p50: num(r.t_lead_p50),
                    t_lead_p90: num(r.t_lead_p90),
                })),
                heatmap: heat.map(r => ({ dow: int(r.dow), hour: int(r.hour), orders: int(r.orders) })),
                hourly: hourly.map(r => ({
                    hour: int(r.hour),
                    orders: int(r.orders),
                    sla: { met: int(r.sla_met), n: int(r.sla_n), rate: pct(r.sla_met, r.sla_n) },
                    t_first_p50: num(r.t_first_p50),
                    t_first_p90: num(r.t_first_p90),
                })),
                by_ward: byWard.map(r => ({
                    ward: int(r.ward),
                    ward_name: sanitizeHTML(String(r.ward_name ?? `หอ ${r.ward}`)),
                    orders: int(r.orders),
                    patients: int(r.patients),
                    stat: int(r.stat), discharge: int(r.discharge), routine: int(r.routine),
                    rejected: int(r.rejected),
                    resends: int(r.resends),
                    unverified: int(r.unverified),
                    tube_feed: int(r.tube_feed),
                    sla: { met: int(r.sla_met), n: int(r.sla_n), rate: pct(r.sla_met, r.sla_n) },
                    t_first: { p50: num(r.t_first_p50), p90: num(r.t_first_p90) },
                    t_lead: { p50: num(r.t_lead_p50), p90: num(r.t_lead_p90) },
                    t_pickup: { p50: num(r.t_pickup_p50), p90: num(r.t_pickup_p90) },
                })),
                by_staff: staffRows.map(r => ({
                    username: String(r.username),
                    name: sanitizeHTML(String(r.name ?? r.username)),
                    ack: int(r.ack), key: int(r.key), prep: int(r.prep),
                    handover: int(r.handover), reject: int(r.reject),
                    t_ack_p50: num(r.t_ack_p50),
                    t_key_p50: num(r.t_key_p50),
                    t_prep_p50: num(r.t_prep_p50),
                })),
                reject_reasons: reasons.map(r => ({
                    reason: sanitizeHTML(String(r.reason ?? '')),
                    n: int(r.n),
                    last_at: r.last_at,
                })),
                hn_source: hnSource.map(r => ({
                    source: String(r.hn_source),
                    orders: int(r.orders),
                    verified: int(r.verified),
                    rejected: int(r.rejected),
                })),
                lead_histogram: leadHist.map(r => ({ bucket: int(r.bucket), n: int(r.n) })),
                backlog: {
                    waiting: int(backlog?.waiting),
                    working: int(backlog?.working),
                    keyed: int(backlog?.keyed),
                    ready: int(backlog?.ready),
                    rejected_open: int(backlog?.rejected_open),
                    overdue: int(backlog?.overdue),
                    oldest_waiting: num(backlog?.oldest_waiting),
                    oldest_ready: num(backlog?.oldest_ready),
                },
            },
        };
    } catch (error) {
        console.error('Rx dashboard error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
