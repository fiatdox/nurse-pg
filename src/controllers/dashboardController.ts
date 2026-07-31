import type { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';

type RangeBody = { ward: string; date_from: string; date_to: string };

const parseRange = (body: unknown) => {
    const { ward, date_from, date_to } = (body ?? {}) as RangeBody;
    if (!ward?.trim() || !date_from?.trim() || !date_to?.trim()) return null;
    return { ward: ward.trim(), from: date_from.trim(), to: date_to.trim() };
};

/**
 * จำนวนผู้ป่วยที่ยังนอนอยู่ในหอผู้ป่วย ณ วันนั้น (census รายวัน)
 * นับผู้ป่วยที่ลงทะเบียนไม่เกินวันนั้น และยังไม่จำหน่าย หรือจำหน่ายหลังจากวันนั้น
 */
const censusCTE = (ward: string, from: string, to: string) => nurse`
    SELECT
         TO_CHAR(ds.d, 'YYYY-MM-DD') AS record_date
        ,(
            SELECT COUNT(*) FROM admission_list al
            WHERE al.ward = ${ward}
              AND al.reg_datetime::date <= ds.d
              AND (al.discharge_datetime IS NULL OR al.discharge_datetime::date > ds.d)
         )::int AS census
    FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') AS ds(d)
    ORDER BY ds.d
`;

// ---------- สถิติรายวัน + สรุปภาระงานเทียบมาตรฐาน ----------
export const getIpdDailyStats = async ({ body, set }: Context) => {
    const range = parseRange(body);
    if (!range) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date_from และ date_to' };
    }
    const { ward, from, to } = range;

    try {
        const [daily, wardInfo, nurseCount] = await Promise.all([
            nurse`
                SELECT
                     TO_CHAR(ds.d, 'YYYY-MM-DD') AS record_date
                    ,(
                        SELECT COUNT(*) FROM admission_list al
                        WHERE al.ward = ${ward}
                          AND al.admission_type_id = 1
                          AND al.reg_datetime::date = ds.d
                     )::int AS new_admit
                    ,(
                        SELECT COUNT(*) FROM admission_list al
                        WHERE al.ward = ${ward}
                          AND al.admission_type_id = 2
                          AND al.reg_datetime::date = ds.d
                     )::int AS transfer_in
                    ,(
                        SELECT COUNT(*) FROM admission_list al
                        WHERE al.ward = ${ward}
                          AND al.reg_datetime::date <= ds.d
                          AND (al.discharge_datetime IS NULL OR al.discharge_datetime::date > ds.d)
                     )::int AS census
                    ,(
                        SELECT COUNT(*) FROM admission_list al
                        WHERE al.ward = ${ward}
                          AND al.discharge_datetime::date = ds.d
                     )::int AS discharge
                FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') AS ds(d)
                ORDER BY ds.d
            `,
            nurse`
                SELECT ward_name, bed, general, crisis
                FROM ward
                WHERE his_code = ${ward}
                LIMIT 1
            `,
            nurse`
                SELECT COUNT(DISTINCT nsa.staff_id)::int AS n
                FROM nurse_shift_assignments nsa
                JOIN nurse_shift_types nst ON nst.nurse_shift_type_id = nsa.nurse_shift_type_id
                WHERE nsa.ward = ${ward}
                  AND nsa.shift_date BETWEEN ${from}::date AND ${to}::date
                  AND nst.code <> 'OFF'
            `,
        ]);

        const w = wardInfo[0];
        // มาตรฐานชั่วโมงการพยาบาล (NHPPD) ต่อผู้ป่วย 1 คน/วัน — แปลงเป็นอัตราส่วน พยาบาล:ผู้ป่วย ต่อเวร 8 ชม.
        // 3 เวร/วัน → พยาบาล 1 คนดูแลได้ (8 x 3) / NHPPD คน
        const nhppd = Number(w?.general ?? 0);
        const standardRatio = nhppd > 0 ? Math.round((24 / nhppd) * 10) / 10 : 0;

        const rows = daily.map(r => ({
            date: r.record_date,
            newAdmit: r.new_admit,
            transferIn: r.transfer_in,
            // ผู้ป่วยยกมาจากวันก่อน = census - รับใหม่ - รับย้าย (สามค่านี้รวมกันได้ census พอดี)
            continued: Math.max(0, r.census - r.new_admit - r.transfer_in),
            discharge: r.discharge,
            census: r.census,
        }));

        const sum = (k: keyof (typeof rows)[number]) =>
            rows.reduce((a, r) => a + (r[k] as number), 0);

        const totalPatientDays = sum('census');
        const days = rows.length || 1;

        return {
            success: true,
            data: {
                ward,
                ward_name: sanitizeHTML(w?.ward_name ?? ''),
                daily: rows,
                summary: {
                    totalPatientDays,
                    avgCensus: Math.round((totalPatientDays / days) * 10) / 10,
                    totalNewAdmit: sum('newAdmit'),
                    totalTransferIn: sum('transferIn'),
                    totalContinued: sum('continued'),
                    totalDischarge: sum('discharge'),
                    nurseCount: nurseCount[0]?.n ?? 0,
                    standardRatio,
                    nursingHourStandard: nhppd,
                    crisisHourStandard: Number(w?.crisis ?? 0),
                    totalBeds: w?.bed ?? null,
                    days,
                },
            },
        };
    } catch (error) {
        console.error('Get IPD daily stats error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ชั่วโมงการทำงานรายบุคคล ----------
export const getNurseWorkload = async ({ body, set }: Context) => {
    const range = parseRange(body);
    if (!range) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date_from และ date_to' };
    }
    const { ward, from, to } = range;

    try {
        const rows = await nurse`
            WITH assign AS (
                SELECT
                     nsa.staff_id
                    ,nsa.shift_date
                    ,nst.code
                    ,nst.admission_change_shift_type_id AS shift_grp
                FROM nurse_shift_assignments nsa
                JOIN nurse_shift_types nst
                  ON nst.nurse_shift_type_id = nsa.nurse_shift_type_id
                WHERE nsa.ward = ${ward}
                  AND nsa.shift_date BETWEEN ${from}::date AND ${to}::date
                  AND nst.code <> 'OFF'
            ),
            daily_census AS (
                SELECT
                     ds.d AS record_date
                    ,(
                        SELECT COUNT(*) FROM admission_list al
                        WHERE al.ward = ${ward}
                          AND al.reg_datetime::date <= ds.d
                          AND (al.discharge_datetime IS NULL OR al.discharge_datetime::date > ds.d)
                     )::numeric AS census
                FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') AS ds(d)
            ),
            -- จำนวนพยาบาลที่ขึ้นเวรนั้นจริง ใช้หารภาระผู้ป่วยต่อคน
            shift_staff AS (
                SELECT shift_date, shift_grp, COUNT(DISTINCT staff_id)::numeric AS n
                FROM assign
                GROUP BY shift_date, shift_grp
            )
            SELECT
                 s.staff_id
                ,s.fullname
                ,COALESCE(sp.code, '-') AS position
                ,COUNT(*) FILTER (WHERE a.shift_grp = 2 AND a.code NOT LIKE '%OT%')::int AS morning_shifts
                ,COUNT(*) FILTER (WHERE a.shift_grp = 3 AND a.code NOT LIKE '%OT%')::int AS afternoon_shifts
                ,COUNT(*) FILTER (WHERE a.shift_grp = 1 AND a.code NOT LIKE '%OT%')::int AS night_shifts
                ,COALESCE(SUM(
                    CASE WHEN a.code LIKE '%OT4' THEN 4
                         WHEN a.code LIKE '%OT'  THEN 8
                         ELSE 0 END
                 ), 0)::int AS ot_hours
                ,ROUND(AVG(dc.census / NULLIF(ss.n, 0)), 1) AS patient_load
            FROM assign a
            JOIN staffs s ON s.staff_id = a.staff_id
            LEFT JOIN staff_position sp ON sp.staff_position_id = s.staff_position_id
            LEFT JOIN daily_census dc ON dc.record_date = a.shift_date
            LEFT JOIN shift_staff ss ON ss.shift_date = a.shift_date AND ss.shift_grp = a.shift_grp
            GROUP BY s.staff_id, s.fullname, sp.code
            ORDER BY s.fullname
        `;

        return {
            success: true,
            data: rows.map(r => {
                const morningShifts = r.morning_shifts;
                const afternoonShifts = r.afternoon_shifts;
                const nightShifts = r.night_shifts;
                const otHours = r.ot_hours;
                return {
                    staffId: r.staff_id,
                    name: sanitizeHTML(r.fullname ?? ''),
                    position: r.position,
                    morningShifts,
                    afternoonShifts,
                    nightShifts,
                    otHours,
                    totalHours: (morningShifts + afternoonShifts + nightShifts) * 8 + otHours,
                    patientLoad: Number(r.patient_load ?? 0),
                };
            }),
        };
    } catch (error) {
        console.error('Get nurse workload error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ระดับความรุนแรงผู้ป่วยแยกตามช่วงเวร ----------
export const getShiftSeverityDistribution = async ({ body, set }: Context) => {
    const range = parseRange(body);
    if (!range) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date_from และ date_to' };
    }
    const { ward, from, to } = range;

    try {
        // ทุกชุดของ (วัน × เวร × ระดับความรุนแรง) ต้องมีแถวเสมอ แม้ยังไม่มีการประเมิน
        // จึง CROSS JOIN ปฏิทินกับตารางอ้างอิงก่อน แล้วค่อย LEFT JOIN ข้อมูลจริงเข้ามา
        const rows = await nurse`
            SELECT
                 TO_CHAR(ds.d, 'YYYY-MM-DD') AS record_date
                ,acst.admission_change_shift_type_id AS shift_type_id
                ,acst.shift_name
                ,sl.severity_level_id
                ,sl.severity_level_name
                ,sl.acuity_level_name
                ,COUNT(DISTINCT adr.admission_list_id)::int AS patient_count
                ,COUNT(adr.admission_shift_daily_record)::int AS record_count
            FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') AS ds(d)
            CROSS JOIN admission_change_shift_types acst
            CROSS JOIN admission_severity_level sl
            LEFT JOIN admission_shift_daily_record adr
                   ON adr.record_date = ds.d
                  AND adr.shift_type_id = acst.admission_change_shift_type_id
                  AND adr.severity_level_id = sl.severity_level_id
            LEFT JOIN admission_list al
                   ON al.admission_list_id = adr.admission_list_id
                  AND al.ward = ${ward}
            WHERE adr.admission_list_id IS NULL OR al.admission_list_id IS NOT NULL
            GROUP BY ds.d, acst.admission_change_shift_type_id, acst.shift_name,
                     sl.severity_level_id, sl.severity_level_name, sl.acuity_level_name
            ORDER BY ds.d, acst.admission_change_shift_type_id, sl.severity_level_id
        `;

        const severityLevels = [...new Map(
            rows.map(r => [r.severity_level_id, {
                severityLevelId: r.severity_level_id,
                severityLevelName: sanitizeHTML(r.severity_level_name ?? ''),
                acuityLevelName: sanitizeHTML(r.acuity_level_name ?? ''),
            }])
        ).values()];

        const shiftTypes = [...new Map(
            rows.map(r => [r.shift_type_id, {
                shiftTypeId: r.shift_type_id,
                shiftName: sanitizeHTML(r.shift_name ?? ''),
            }])
        ).values()];

        const days = [...new Set(rows.map(r => r.record_date))].map(date => ({
            date,
            shifts: shiftTypes.map(st => {
                const levels = rows
                    .filter(r => r.record_date === date && r.shift_type_id === st.shiftTypeId)
                    .map(r => ({
                        severityLevelId: r.severity_level_id,
                        patientCount: r.patient_count,
                        recordCount: r.record_count,
                    }));
                return {
                    ...st,
                    totalPatients: levels.reduce((a, l) => a + l.patientCount, 0),
                    levels,
                };
            }),
        }));

        return { success: true, data: { severityLevels, shiftTypes, days } };
    } catch (error) {
        console.error('Get shift severity distribution error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- อัตราครองเตียง ----------
export const getBedOccupancy = async ({ body, set }: Context) => {
    const range = parseRange(body);
    if (!range) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date_from และ date_to' };
    }
    const { ward, from, to } = range;

    try {
        const [wardInfo, census] = await Promise.all([
            nurse`SELECT ward_name, bed FROM ward WHERE his_code = ${ward} LIMIT 1`,
            censusCTE(ward, from, to),
        ]);

        const w = wardInfo[0];
        // ward.bed อาจเป็น null ในหอที่ยังไม่ได้บันทึกจำนวนเตียง — คืน null ให้ต่างจาก 0% จริง
        const totalBeds: number | null = w?.bed ?? null;
        const days = census.length || 1;
        const avgCensus = census.reduce((a, r) => a + r.census, 0) / days;
        const peakCensus = census.reduce((a, r) => Math.max(a, r.census), 0);

        return {
            success: true,
            data: {
                ward,
                ward_name: sanitizeHTML(w?.ward_name ?? ''),
                totalBeds,
                occupied: Math.round(avgCensus * 10) / 10,
                peakOccupied: peakCensus,
                occupancyRate: totalBeds ? Math.round((avgCensus / totalBeds) * 100) : null,
                peakOccupancyRate: totalBeds ? Math.round((peakCensus / totalBeds) * 100) : null,
                daily: census.map(r => ({ date: r.record_date, census: r.census })),
            },
        };
    } catch (error) {
        console.error('Get bed occupancy error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- การเปลี่ยนระดับการดูแลข้ามเวร (Sankey) ----------
export const getCareLevelFlow = async ({ body, set }: Context) => {
    const range = parseRange(body);
    if (!range) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward, date_from และ date_to' };
    }
    const { ward, from, to } = range;

    try {
        // จับคู่เวรที่ต่อเนื่องกันภายในวันเดียวกัน: ดึก(1) -> เช้า(2) -> บ่าย(3)
        // นับผู้ป่วยรายเดียวกันที่มีบันทึกทั้งสองเวร แล้วดูว่าระดับการดูแลเปลี่ยนไปอย่างไร
        const rows = await nurse`
            WITH shift_pairs AS (
                SELECT 1 AS from_shift, 2 AS to_shift
                UNION ALL
                SELECT 2, 3
            )
            SELECT
                 p.from_shift
                ,sf.shift_name       AS from_shift_name
                ,a.admission_shift_care_level_id AS from_level_id
                ,cf.name             AS from_level_name
                ,p.to_shift
                ,st.shift_name       AS to_shift_name
                ,b.admission_shift_care_level_id AS to_level_id
                ,ct.name             AS to_level_name
                ,COUNT(*)::int       AS value
            FROM shift_pairs p
            JOIN admission_shift_daily_record a
              ON a.shift_type_id = p.from_shift
             AND a.record_date BETWEEN ${from}::date AND ${to}::date
            JOIN admission_shift_daily_record b
              ON b.admission_list_id = a.admission_list_id
             AND b.record_date = a.record_date
             AND b.shift_type_id = p.to_shift
            JOIN admission_list al
              ON al.admission_list_id = a.admission_list_id
             AND al.ward = ${ward}
            JOIN admission_shift_care_levels cf ON cf.admission_shift_care_level_id = a.admission_shift_care_level_id
            JOIN admission_shift_care_levels ct ON ct.admission_shift_care_level_id = b.admission_shift_care_level_id
            JOIN admission_change_shift_types sf ON sf.admission_change_shift_type_id = p.from_shift
            JOIN admission_change_shift_types st ON st.admission_change_shift_type_id = p.to_shift
            GROUP BY p.from_shift, sf.shift_name, a.admission_shift_care_level_id, cf.name,
                     p.to_shift, st.shift_name, b.admission_shift_care_level_id, ct.name
            ORDER BY p.from_shift, a.admission_shift_care_level_id, b.admission_shift_care_level_id
        `;

        // ชื่อ node ต้องไม่ซ้ำกันข้ามเวร จึงผูกชื่อเวรไว้ด้วย
        const nodeName = (shiftName: string, levelName: string) => `${shiftName} · ${levelName}`;
        const nodeMap = new Map<string, { name: string; shiftTypeId: number; shiftName: string; careLevelId: number; careLevelName: string }>();

        const addNode = (shiftTypeId: number, shiftName: string, careLevelId: number, careLevelName: string) => {
            const name = nodeName(sanitizeHTML(shiftName) ?? '', sanitizeHTML(careLevelName) ?? '');
            if (!nodeMap.has(name)) {
                nodeMap.set(name, {
                    name,
                    shiftTypeId,
                    shiftName: sanitizeHTML(shiftName) ?? '',
                    careLevelId,
                    careLevelName: sanitizeHTML(careLevelName) ?? '',
                });
            }
            return name;
        };

        const links = rows.map(r => ({
            source: addNode(r.from_shift, r.from_shift_name, r.from_level_id, r.from_level_name),
            target: addNode(r.to_shift, r.to_shift_name, r.to_level_id, r.to_level_name),
            value: r.value,
            changed: r.from_level_id !== r.to_level_id,
        }));

        const nodes = [...nodeMap.values()].sort(
            (a, b) => a.shiftTypeId - b.shiftTypeId || a.careLevelId - b.careLevelId
        );

        return {
            success: true,
            data: {
                nodes,
                links,
                totalTransitions: links.reduce((a, l) => a + l.value, 0),
                changedTransitions: links.filter(l => l.changed).reduce((a, l) => a + l.value, 0),
            },
        };
    } catch (error) {
        console.error('Get care level flow error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
