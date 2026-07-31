import { Context } from 'elysia';
import { his, nurse } from '../db';
import { RowDataPacket } from 'mysql2';
import { sanitizeHTML } from '../utils/sanitize';

// ฟังก์ชันสำหรับดึงข้อมูลผู้ป่วยตาม ward
export const getPatientsByWard = async ({ body, set }: Context) => {
    const { ward } = body as { ward: string };
    try {
        // ดึง an ที่ลงทะเบียนแล้วใน admission_list (status=1 = ยังแอดมิทอยู่) ward เดียวกัน — PG
        const registeredRows = await nurse<{ an: string }[]>`
            SELECT an FROM admission_list WHERE ward = ${ward} AND status = '1'
        `;
        const registeredAns = registeredRows.map(r => r.an);

        // ipt อยู่ใน HIS (MySQL) — คงไว้
        let rows: RowDataPacket[];
        if (registeredAns.length > 0) {
            const placeholders = registeredAns.map(() => '?').join(',');
            [rows] = await his.execute<RowDataPacket[]>(
                `SELECT i.an, i.hn, i.dchstts, CONCAT(p.pname, p.fname, ' ', p.lname) AS ptname,
                concat(i.regdate,' ',i.regtime) AS regdate, p.birthday, p.sex, a.bedno, d.name AS doctor_name, i.ward
                FROM ipt i
                LEFT JOIN patient p ON p.hn = i.hn
                LEFT JOIN iptadm a ON a.an = i.an
                LEFT JOIN doctor d ON d.code = i.incharge_doctor
                WHERE i.dchstts IS NULL AND i.ward = ? AND i.an NOT IN (${placeholders})
                ORDER BY a.bedno ASC`,
                [ward, ...registeredAns]
            );
        } else {
            [rows] = await his.execute<RowDataPacket[]>(
                `SELECT i.an, i.hn, i.dchstts, CONCAT(p.pname, p.fname, ' ', p.lname) AS ptname,
                concat(i.regdate,' ',i.regtime) AS regdate, p.birthday, p.sex, a.bedno, d.name AS doctor_name, i.ward
                FROM ipt i
                LEFT JOIN patient p ON p.hn = i.hn
                LEFT JOIN iptadm a ON a.an = i.an
                LEFT JOIN doctor d ON d.code = i.incharge_doctor
                WHERE i.dchstts IS NULL AND i.ward = ?
                ORDER BY a.bedno ASC`,
                [ward]
            );
        }

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                ptname: sanitizeHTML(row.ptname),
                gender: row.sex ?? null,
            }))
        };
    } catch (error) {
        console.error('Get patients error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันจำหน่ายผู้ป่วย (discharge / transfer / refer)
export const dischargePatient = async ({ body, set }: Context) => {
    const {
        admission_list_id,
        discharge_type_id,
        discharge_datetime,
        move_to_ward,
        status,
        los,
    } = body as {
        admission_list_id: number;
        discharge_type_id: number;
        discharge_datetime: string;
        move_to_ward: string | null;
        status: string;
        los: number;
    };

    try {
        const [existing, dischargeType] = await Promise.all([
            nurse`SELECT admission_list_id FROM admission_list WHERE admission_list_id = ${admission_list_id} LIMIT 1`,
            nurse`SELECT discharge_type_name FROM discharge_types WHERE discharge_type_id = ${discharge_type_id} LIMIT 1`,
        ]);

        if (existing.length === 0) {
            set.status = 404;
            return { success: false, message: `ไม่พบข้อมูลผู้ป่วย admission_list_id: ${admission_list_id}` };
        }

        const typeLabel = dischargeType[0]?.discharge_type_name ?? 'จำหน่ายผู้ป่วย';

        await nurse.begin(async sql => {
            await sql`
                UPDATE admission_list SET
                    discharge_type_id = ${discharge_type_id},
                    discharge_datetime = ${discharge_datetime},
                    move_to_ward = ${move_to_ward ?? null},
                    status = ${status},
                    los = ${los}
                WHERE admission_list_id = ${admission_list_id}
            `;
        });

        return {
            success: true,
            message: `${typeLabel}เรียบร้อยแล้ว`,
            data: { admission_list_id, discharge_type_id, discharge_type_name: typeLabel, status, discharge_datetime, move_to_ward: move_to_ward ?? null, los }
        };

    } catch (error) {
        console.error('Discharge patient error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error during discharge.' };
    }
};

// ฟังก์ชันยกเลิกการจำหน่ายผู้ป่วย
export const cancelDischarge = async ({ params, set }: Context) => {
    const admission_list_id = Number(params.admission_list_id);

    try {
        const existing = await nurse`
            SELECT admission_list_id, status FROM admission_list
            WHERE admission_list_id = ${admission_list_id} LIMIT 1
        `;

        if (existing.length === 0) {
            set.status = 404;
            return { success: false, message: `ไม่พบข้อมูลผู้ป่วย admission_list_id: ${admission_list_id}` };
        }

        if (existing[0].status === '1') {
            set.status = 400;
            return { success: false, message: 'ผู้ป่วยยังไม่ได้ถูกจำหน่าย' };
        }

        await nurse.begin(async sql => {
            await sql`
                UPDATE admission_list SET
                    status = '1',
                    discharge_type_id = 0,
                    discharge_datetime = NULL,
                    move_to_ward = NULL,
                    los = NULL
                WHERE admission_list_id = ${admission_list_id}
            `;
        });

        return {
            success: true,
            message: 'ยกเลิกการจำหน่ายเรียบร้อยแล้ว',
            data: { admission_list_id, status: '1' }
        };

    } catch (error) {
        console.error('Cancel discharge error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error during cancel discharge.' };
    }
};

// ฟังก์ชันดึงรายชื่อผู้ป่วยที่จำหน่ายแล้วตาม ward
export const getPatientDischargeByWard = async ({ body, set }: Context) => {
    const { ward, date_from, date_to } = body as {
        ward: string;
        date_from?: string | null;
        date_to?: string | null;
    };

    try {
        const dateFilter = date_from && date_to
            ? nurse`AND al.discharge_datetime::date BETWEEN ${date_from}::date AND ${date_to}::date`
            : date_from
                ? nurse`AND al.discharge_datetime::date >= ${date_from}::date`
                : date_to
                    ? nurse`AND al.discharge_datetime::date <= ${date_to}::date`
                    : nurse``;

        const rows = await nurse`
            SELECT
                al.admission_list_id,
                al.an,
                al.hn,
                al.patient_name,
                al.ward,
                al.bedno,
                al.reg_datetime,
                al.discharge_datetime,
                al.move_to_ward,
                al.los,
                al.status,
                dt.discharge_type_name,
                ast.status_name
            FROM admission_list al
            LEFT JOIN discharge_types dt ON dt.discharge_type_id = al.discharge_type_id
            LEFT JOIN admission_statuses ast ON ast.status_code = al.status
            WHERE al.ward = ${ward} AND al.status IN ('2', '3')
            ${dateFilter}
            ORDER BY al.discharge_datetime DESC
        `;

        return {
            success: true,
            total: rows.length,
            data: rows.map(row => ({
                ...row,
                patient_name: row.patient_name ? sanitizeHTML(row.patient_name) : null,
            }))
        };
    } catch (error) {
        console.error('Get patient discharge by ward error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลผู้ป่วยตาม ward (จากตาราง admission_list)
export const getPatientByward = async ({ params, set }: Context) => {
    const { ward } = params as { ward: string };
    try {
        const rows = await nurse`
            SELECT
                al.admission_list_id,
                al.hn,
                al.an,
                al.patient_name,
                (al.reg_datetime + INTERVAL '543 years') AS reg_datetime,
                al.reg_datetime::date AS reg_date,
                t.admission_type_name,
                al.incharge_doctor,
                s.name AS spclty_name,
                al.bedno,
                al.admission_type_id,
                al.spclty
            FROM admission_list al
            LEFT JOIN spclty s ON s.spclty = al.spclty
            LEFT JOIN admission_types t ON t.admission_type_id = al.admission_type_id
            WHERE al.ward = ${ward} AND al.status = '1'
            ORDER BY al.bedno ASC
        `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                patient_name: row.patient_name ? sanitizeHTML(row.patient_name) : null,
                incharge_doctor: row.incharge_doctor ? sanitizeHTML(row.incharge_doctor) : null,
                spclty_name: row.spclty_name ? sanitizeHTML(row.spclty_name) : null,
                admission_type_name: row.admission_type_name ? sanitizeHTML(row.admission_type_name) : null
            }))
        };
    } catch (error) {
        console.error('Get patient by ward error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

export const getDischargedPatientByWard = async ({ body, set }: Context) => {
    const { ward, ds1, ds2 } = body as { ward: string; ds1: string; ds2: string };
    try {
        const rows = await nurse`
            SELECT
                al.admission_list_id,
                al.hn,
                al.an,
                al.patient_name,
                (al.reg_datetime + INTERVAL '543 years') AS reg_datetime,
                al.reg_datetime::date AS reg_date,
                t.admission_type_name,
                al.incharge_doctor,
                s.name AS spclty_name,
                al.bedno,
                al.admission_type_id,
                al.spclty,
                al.discharge_datetime,
                dt.discharge_type_name
            FROM admission_list al
            LEFT JOIN spclty s ON s.spclty = al.spclty
            LEFT JOIN admission_types t ON t.admission_type_id = al.admission_type_id
            LEFT JOIN discharge_types dt ON dt.discharge_type_id = al.discharge_type_id
            WHERE al.ward = ${ward} AND al.status = '2'
              AND al.discharge_datetime::date BETWEEN ${ds1}::date AND ${ds2}::date
            ORDER BY al.bedno ASC
        `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                patient_name: row.patient_name ? sanitizeHTML(row.patient_name) : null,
                incharge_doctor: row.incharge_doctor ? sanitizeHTML(row.incharge_doctor) : null,
                spclty_name: row.spclty_name ? sanitizeHTML(row.spclty_name) : null,
                admission_type_name: row.admission_type_name ? sanitizeHTML(row.admission_type_name) : null
            }))
        };
    } catch (error) {
        console.error('Get discharged patient by ward error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันสำหรับลงทะเบียนผู้ป่วยใหม่
// หมายเหตุ: ดึง AN จาก HIS (MySQL) แต่บันทึกลง admission_list ที่ฐาน PostgreSQL
export const registerPatient = async ({ body, set }: Context) => {
    const {
        an,
        hn,
        patient_name,
        reg_datetime,
        before_ward,
        ward,
        birth_date,
        spclty,
        gender,
        bedno,
        admission_type_id,
        status,
        admission_change_shift_type_id,
        incharge_doctor,
    } = body as any;

    try {
        // --- ตรวจสอบว่า AN มีอยู่จริงในฐานข้อมูล HIS (MySQL) ---
        const [existingPatient] = await his.execute<RowDataPacket[]>(
            `SELECT an, incharge_doctor FROM ipt WHERE an = ?`,
            [an]
        );
        if (existingPatient.length === 0) {
            set.status = 404;
            return { success: false, message: `Patient with AN '${an}' not found in the main system.` };
        }

        const finalInchargeDoctor = incharge_doctor || existingPatient[0].incharge_doctor || null;

        // --- บันทึกลง admission_list ที่ฐาน PostgreSQL ---
        const registeredPatient = await nurse.begin(async sql => {
            const inserted = await sql`
                INSERT INTO admission_list (
                    an, hn, patient_name, reg_datetime, birth_date,
                    ward, spclty, admission_type_id, status,
                    incharge_doctor, gender, bedno,
                    before_ward, admission_change_shift_type_id,
                    discharge_type_id
                ) VALUES (
                    ${an},
                    ${hn},
                    ${patient_name},
                    ${reg_datetime},
                    ${birth_date ?? null},
                    ${ward},
                    ${spclty ?? null},
                    ${admission_type_id ?? null},
                    ${status ?? 1},
                    ${finalInchargeDoctor ?? null},
                    ${gender ?? ''},
                    ${bedno ?? null},
                    ${before_ward ?? null},
                    ${admission_change_shift_type_id ?? null},
                    0
                )
                RETURNING *
            `;

            if (inserted.length === 0) {
                throw new Error('Failed to retrieve patient details after registration.');
            }
            return inserted[0];
        });

        return {
            success: true,
            message: 'Patient registered successfully.',
            data: {
                ...registeredPatient,
                patient_name: sanitizeHTML(registeredPatient.patient_name),
                incharge_doctor: registeredPatient.incharge_doctor
                    ? sanitizeHTML(registeredPatient.incharge_doctor)
                    : null,
            },
        };

    } catch (error) {
        console.error('Register patient error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error during patient registration.',
        };
    }
};

export const updatePatient = async ({ body, set }: Context) => {
    const {
        admission_list_id,
        patient_name,
        reg_datetime,
        before_ward,
        ward,
        birth_date,
        spclty,
        bedno,
        admission_type_id,
        status,
        admission_change_shift_type_id,
        incharge_doctor,
    } = body as any;

    try {
        const existing = await nurse`
            SELECT admission_list_id FROM admission_list WHERE admission_list_id = ${admission_list_id} LIMIT 1
        `;
        if (existing.length === 0) {
            set.status = 404;
            return { success: false, message: 'Patient admission not found.' };
        }

        const updated = await nurse`
            UPDATE admission_list SET
                patient_name = ${patient_name},
                reg_datetime = ${reg_datetime},
                birth_date = ${birth_date ?? null},
                ward = ${ward},
                spclty = ${spclty ?? null},
                admission_type_id = ${admission_type_id ?? null},
                status = ${status ?? 1},
                incharge_doctor = ${incharge_doctor ?? null},
                bedno = ${bedno ?? null},
                before_ward = ${before_ward ?? null},
                admission_change_shift_type_id = ${admission_change_shift_type_id ?? null}
            WHERE admission_list_id = ${admission_list_id}
            RETURNING *
        `;

        const updatedPatient = updated[0];
        return {
            success: true,
            message: 'Patient updated successfully.',
            data: {
                ...updatedPatient,
                patient_name: sanitizeHTML(updatedPatient.patient_name),
                incharge_doctor: updatedPatient.incharge_doctor
                    ? sanitizeHTML(updatedPatient.incharge_doctor)
                    : null,
            },
        };
    } catch (error) {
        console.error('Update patient error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error during patient update.',
        };
    }
};


export const upsertAdmissionShiftDailyRecord = async ({ body, set, user }: Context & { user: any }) => {
    const { admission_list_id, level, admission_shift_care_level_id, shift_type_id, date, hn, an, severity_level_id } = body as {
        admission_list_id: number;
        level?: number | null;
        admission_shift_care_level_id?: number | null;
        shift_type_id: number;
        date: string;
        hn?: string;
        an?: string;
        severity_level_id?: number;
    };

    const careLevelId = admission_shift_care_level_id ?? null;
    const severityLevelId = level ?? severity_level_id ?? null;

    // แปลง DD/MM/YYYY → YYYY-MM-DD
    const parsedDate = date.includes('/')
        ? date.split('/').reverse().join('-')
        : date;

    const recorded_by = user?.id ?? null;

    try {
        const existing = await nurse`
            SELECT admission_shift_daily_record FROM admission_shift_daily_record
            WHERE admission_list_id = ${admission_list_id}
              AND shift_type_id = ${shift_type_id}
              AND record_date = ${parsedDate}
        `;

        if (existing.length > 0) {
            await nurse`
                UPDATE admission_shift_daily_record
                SET admission_shift_care_level_id = ${careLevelId},
                    severity_level_id = ${severityLevelId},
                    hn = ${hn ?? null},
                    an = ${an ?? null},
                    updated_by = ${recorded_by},
                    updated_at = NOW()
                WHERE admission_list_id = ${admission_list_id}
                  AND shift_type_id = ${shift_type_id}
                  AND record_date = ${parsedDate}
            `;
            return { success: true, message: 'อัพเดทข้อมูลเรียบร้อยแล้ว' };
        } else {
            await nurse`
                INSERT INTO admission_shift_daily_record
                    (admission_list_id, shift_type_id, admission_shift_care_level_id, severity_level_id, record_date, hn, an, recorded_by, created_at)
                VALUES
                    (${admission_list_id}, ${shift_type_id}, ${careLevelId}, ${severityLevelId}, ${parsedDate}, ${hn ?? null}, ${an ?? null}, ${recorded_by}, NOW())
            `;
            return { success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' };
        }
    } catch (error) {
        console.error('Upsert admission shift daily record error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// คัดลอก shift daily records จากเวร/วันที่ต้นทาง → ปลายทาง (upsert)
export const copyPreviousShiftDailyRecords = async ({ body, set, user }: Context & { user: any }) => {
    const { ward, target_date, target_shift_type_id, source_date, source_shift_type_id } = body as {
        ward: string;
        target_date: string;
        target_shift_type_id: number;
        source_date: string;
        source_shift_type_id: number;
    };

    const parseDate = (d: string) => d.includes('/') ? d.split('/').reverse().join('-') : d;
    const parsedTargetDate = parseDate(target_date);
    const parsedSourceDate = parseDate(source_date);
    const recorded_by = user?.id ?? null;

    try {
        const sourceRows = await nurse`
            SELECT asdr.admission_list_id, asdr.admission_shift_care_level_id, asdr.severity_level_id, asdr.hn, asdr.an
            FROM admission_shift_daily_record asdr
            JOIN admission_list al ON al.admission_list_id = asdr.admission_list_id
            WHERE al.ward = ${ward}
              AND al.status = '1'
              AND asdr.shift_type_id = ${source_shift_type_id}
              AND asdr.record_date = ${parsedSourceDate}
        `;

        if (sourceRows.length === 0) {
            return { success: true, message: 'ไม่พบข้อมูลต้นทางที่จะคัดลอก', copied: 0 };
        }

        await nurse.begin(async sql => {
            for (const row of sourceRows) {
                const existing = await sql`
                    SELECT admission_shift_daily_record FROM admission_shift_daily_record
                    WHERE admission_list_id = ${row.admission_list_id}
                      AND shift_type_id = ${target_shift_type_id}
                      AND record_date = ${parsedTargetDate}
                `;

                if (existing.length > 0) {
                    await sql`
                        UPDATE admission_shift_daily_record
                        SET admission_shift_care_level_id = ${row.admission_shift_care_level_id},
                            severity_level_id = ${row.severity_level_id},
                            hn = ${row.hn},
                            an = ${row.an},
                            updated_by = ${recorded_by},
                            updated_at = NOW()
                        WHERE admission_list_id = ${row.admission_list_id}
                          AND shift_type_id = ${target_shift_type_id}
                          AND record_date = ${parsedTargetDate}
                    `;
                } else {
                    await sql`
                        INSERT INTO admission_shift_daily_record
                            (admission_list_id, shift_type_id, admission_shift_care_level_id, severity_level_id, record_date, hn, an, recorded_by, created_at)
                        VALUES
                            (${row.admission_list_id}, ${target_shift_type_id}, ${row.admission_shift_care_level_id}, ${row.severity_level_id}, ${parsedTargetDate}, ${row.hn}, ${row.an}, ${recorded_by}, NOW())
                    `;
                }
            }
        });

        return {
            success: true,
            message: `คัดลอกข้อมูลเรียบร้อยแล้ว จำนวน ${sourceRows.length} รายการ`,
            copied: sourceRows.length
        };
    } catch (error) {
        console.error('Copy previous shift daily records error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ดึงข้อมูลผู้ป่วยพร้อม care level และ severity level ของแต่ละเวรตามวันที่
export const getPatientShiftDailyRecordsByWard = async ({ body, set }: Context) => {
    const { ward, date } = body as { ward: string; date: string };

    const parsedDate = date.includes('/')
        ? date.split('/').reverse().join('-')
        : date;

    try {
        const rows = await nurse`
            SELECT
                al.admission_list_id,
                al.an,
                al.patient_name,
                (SELECT asdr.admission_shift_care_level_id FROM admission_shift_daily_record asdr
                 WHERE asdr.admission_list_id = al.admission_list_id AND asdr.shift_type_id = 1 AND asdr.record_date = ${parsedDate}) AS night_care_level,
                (SELECT asdr.severity_level_id FROM admission_shift_daily_record asdr
                 WHERE asdr.admission_list_id = al.admission_list_id AND asdr.shift_type_id = 1 AND asdr.record_date = ${parsedDate}) AS night_severity_level,
                (SELECT asdr.admission_shift_care_level_id FROM admission_shift_daily_record asdr
                 WHERE asdr.admission_list_id = al.admission_list_id AND asdr.shift_type_id = 2 AND asdr.record_date = ${parsedDate}) AS morning_care_level,
                (SELECT asdr.severity_level_id FROM admission_shift_daily_record asdr
                 WHERE asdr.admission_list_id = al.admission_list_id AND asdr.shift_type_id = 2 AND asdr.record_date = ${parsedDate}) AS morning_severity_level,
                (SELECT asdr.admission_shift_care_level_id FROM admission_shift_daily_record asdr
                 WHERE asdr.admission_list_id = al.admission_list_id AND asdr.shift_type_id = 3 AND asdr.record_date = ${parsedDate}) AS evening_care_level,
                (SELECT asdr.severity_level_id FROM admission_shift_daily_record asdr
                 WHERE asdr.admission_list_id = al.admission_list_id AND asdr.shift_type_id = 3 AND asdr.record_date = ${parsedDate}) AS evening_severity_level
            FROM admission_list al
            WHERE al.ward = ${ward} AND al.status = '1'
        `;

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                patient_name: sanitizeHTML(row.patient_name)
            }))
        };
    } catch (error) {
        console.error('Get patient shift daily records by ward error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลผู้ป่วยตาม AN (จาก HIS - MySQL)
export const getPatientsBYAN = async ({ body, set }: Context) => {
    const { an } = body as { an: string };
    try {
        const [rows] = await his.execute<RowDataPacket[]>(
            `select i.an,i.hn,i.dchstts,CONCAT(p.pname,p.fname,' ',p.lname)as ptname
            ,concat(i.regdate,' ',i.regtime)as regdate,p.birthday,p.sex,a.bedno ,d.name  as doctor_name
            ,i.ward,w.name as ward_name,p.sex as gender
            from ipt i
            left join patient p on p.hn=i.hn
            LEFT join iptadm a on a.an=i.an
            left join doctor d on d.code=i.incharge_doctor
            left join ward w on w.ward=i.ward
            where i.an = ? limit 1`,
            [an]
        );

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                ptname: sanitizeHTML(row.ptname),
                doctor_name: sanitizeHTML(row.doctor_name),
                ward_name: sanitizeHTML(row.ward_name)
            }))
        };
    } catch (error) {
        console.error('Get patients by AN error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ฟังก์ชันบันทึกข้อมูลผู้ป่วยที่อยู่ในคาบเวรรับการพยาบาล
export const savePatientsInShift = async ({ body, set }: { body: any[], set: any }) => {
    const patients = body;

    if (!patients || patients.length === 0) {
        set.status = 400;
        return {
            success: false,
            message: 'ไม่พบข้อมูลที่ต้องการบันทึก'
        };
    }

    try {
        const now = new Date();
        const values = patients.map(p => ({
            admission_list_id: p.admission_list_id,
            admission_change_shift_type_id: p.admission_change_shift_type_id,
            an: p.an,
            hn: p.hn,
            ward: p.ward,
            shift_date: p.shift_date,
            staff: p.staff,
            severity_level_id: p.severity_level_id,
            ventilator_use: p.ventilator_use,
            comment: p.comment,
            create_datetime: now
        }));

        await nurse.begin(async sql => {
            await sql`
                INSERT INTO admission_change_shift ${sql(values, 'admission_list_id', 'admission_change_shift_type_id', 'an', 'hn', 'ward', 'shift_date', 'staff', 'severity_level_id', 'ventilator_use', 'comment', 'create_datetime')}
                ON CONFLICT (admission_list_id, admission_change_shift_type_id, shift_date, ward) DO UPDATE SET
                    staff = EXCLUDED.staff,
                    severity_level_id = EXCLUDED.severity_level_id,
                    ventilator_use = EXCLUDED.ventilator_use,
                    comment = EXCLUDED.comment,
                    admission_change_shift_type_id = EXCLUDED.admission_change_shift_type_id,
                    update_datetime = NOW(),
                    update_by = EXCLUDED.staff
            `;
        });

        return {
            success: true,
            message: `บันทึกข้อมูลเรียบร้อยแล้ว จำนวน ${patients.length} รายการ`
        };

    } catch (error) {
        console.error('Error saving patients in shift:', error);
        set.status = 500;
        return {
            success: false,
            message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล',
            error: String(error)
        };
    }
};

// ฟังก์ชันบันทึกข้อมูลอาการผู้ป่วยรายเวร (Shift Assessment)
export const saveShiftAssessment = async ({ body, set }: Context) => {
    const {
        admission_list_id,
        admission_change_shift_type_id,
        an,
        hn,
        ward,
        shift_date,
        staff,
        severity_level_id,
        ventilator_use,
        level_of_care,
        pain_score,
        fall_risk,
        pressure_sore_risk,
        gcs_eye,
        gcs_verbal,
        gcs_motor,
        oxygen_support_type_id,
        safety_precautions,
        comment,
    } = body as any;

    const safeStaff = staff ?? null;
    const safeVentilatorUse = ventilator_use ?? null;
    const safeLevelOfCare = level_of_care ?? null;
    const safePainScore = pain_score ?? null;
    const safeFallRisk = fall_risk ?? null;
    const safePressureSoreRisk = pressure_sore_risk ?? null;
    const safeGcsEye = gcs_eye ?? null;
    const safeGcsVerbal = gcs_verbal ?? null;
    const safeGcsMotor = gcs_motor ?? null;
    const safeOxygenSupportTypeId = oxygen_support_type_id ?? null;
    const safeSafetyPrecautions = safety_precautions ? JSON.stringify(safety_precautions) : null;
    const safeComment = comment ?? null;

    try {
        const existing = await nurse`
            SELECT admission_change_shift_id FROM admission_change_shift
            WHERE admission_list_id = ${admission_list_id}
              AND admission_change_shift_type_id = ${admission_change_shift_type_id}
              AND shift_date::date = ${shift_date}::date
              AND ward = ${ward}
            LIMIT 1
        `;

        let admission_change_shift_id: number;
        let action: string;

        if (existing.length > 0) {
            const existingId = existing[0].admission_change_shift_id;
            await nurse`
                UPDATE admission_change_shift SET
                    staff = ${safeStaff},
                    severity_level_id = ${severity_level_id},
                    ventilator_use = ${safeVentilatorUse},
                    level_of_care = ${safeLevelOfCare},
                    pain_score = ${safePainScore},
                    fall_risk = ${safeFallRisk},
                    pressure_sore_risk = ${safePressureSoreRisk},
                    gcs_eye = ${safeGcsEye},
                    gcs_verbal = ${safeGcsVerbal},
                    gcs_motor = ${safeGcsMotor},
                    oxygen_support_type_id = ${safeOxygenSupportTypeId},
                    safety_precautions = ${safeSafetyPrecautions},
                    comment = ${safeComment},
                    update_datetime = NOW(),
                    update_by = ${safeStaff}
                WHERE admission_change_shift_id = ${existingId}
            `;
            admission_change_shift_id = existingId;
            action = 'updated';
        } else {
            const inserted = await nurse`
                INSERT INTO admission_change_shift (
                    admission_list_id, admission_change_shift_type_id,
                    an, hn, ward, shift_date, staff,
                    severity_level_id, ventilator_use,
                    level_of_care, pain_score, fall_risk, pressure_sore_risk,
                    gcs_eye, gcs_verbal, gcs_motor, oxygen_support_type_id,
                    safety_precautions, comment, create_datetime
                ) VALUES (
                    ${admission_list_id}, ${admission_change_shift_type_id},
                    ${an}, ${hn}, ${ward}, ${shift_date}, ${safeStaff},
                    ${severity_level_id}, ${safeVentilatorUse},
                    ${safeLevelOfCare}, ${safePainScore}, ${safeFallRisk}, ${safePressureSoreRisk},
                    ${safeGcsEye}, ${safeGcsVerbal}, ${safeGcsMotor}, ${safeOxygenSupportTypeId},
                    ${safeSafetyPrecautions}, ${safeComment}, NOW()
                )
                RETURNING admission_change_shift_id
            `;
            admission_change_shift_id = inserted[0].admission_change_shift_id;
            action = 'created';
        }

        return {
            success: true,
            message: action === 'created'
                ? 'บันทึกข้อมูลอาการผู้ป่วยรายเวรเรียบร้อยแล้ว'
                : 'อัพเดทข้อมูลอาการผู้ป่วยรายเวรเรียบร้อยแล้ว',
            admission_change_shift_id,
            action
        };
    } catch (error) {
        console.error('Save shift assessment error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูลอาการผู้ป่วยรายเวร',
            error: String(error)
        };
    }
};

// ฟังก์ชันดึงข้อมูลอาการผู้ป่วยรายเวร (Shift Assessment)
export const getShiftAssessment = async ({ body, set }: Context) => {
    const { admission_list_id, shift_date, admission_change_shift_type_id, ward } = body as {
        admission_list_id: number;
        shift_date: string;
        admission_change_shift_type_id: number;
        ward: string;
    };

    try {
        const rows = await nurse`
            SELECT
                admission_list_id, admission_change_shift_type_id, an, hn, ward, shift_date, staff,
                severity_level_id, ventilator_use, level_of_care, pain_score, fall_risk, pressure_sore_risk,
                gcs_eye, gcs_verbal, gcs_motor, oxygen_support_type_id,
                safety_precautions, comment, create_datetime, update_datetime, update_by
            FROM admission_change_shift
            WHERE admission_list_id = ${admission_list_id}
              AND shift_date::date = ${shift_date}::date
              AND admission_change_shift_type_id = ${admission_change_shift_type_id}
              AND ward = ${ward}
            LIMIT 1
        `;

        if (rows.length === 0) {
            return { success: true, data: null };
        }

        const row = rows[0];
        return {
            success: true,
            data: {
                ...row,
                safety_precautions: row.safety_precautions
                    ? (typeof row.safety_precautions === 'string'
                        ? JSON.parse(row.safety_precautions)
                        : row.safety_precautions)
                    : null,
                comment: row.comment ? sanitizeHTML(row.comment) : null,
                staff: row.staff ? sanitizeHTML(row.staff) : null,
            }
        };
    } catch (error) {
        console.error('Get shift assessment error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'เกิดข้อผิดพลาดในการดึงข้อมูลอาการผู้ป่วยรายเวร'
        };
    }
};

// ฟังก์ชันสรุปข้อมูลสถิติผู้ป่วยรายเวรประจำวัน แยกตาม shift type
export const getPatientShiftDailyRecordsSummary = async ({ body, set }: Context) => {
    const { ward, date } = body as { ward: string; date: string };

    if (!ward || !ward.trim() || !date || !date.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward และ date' };
    }

    const parsedDate = date.includes('/')
        ? date.split('/').reverse().join('-')
        : date;

    try {
        const rows = await nurse`
            SELECT
                 acst.admission_change_shift_type_id
                ,acst.shift_name
                ,acst.weight
                ,SUM(CASE WHEN al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS count_remain

                ,(
                    SELECT COUNT(*)
                    FROM admission_list al2
                    WHERE al2.ward = ${ward}
                      AND al2.admission_type_id = 1
                      AND al2.reg_datetime::date = ${parsedDate}::date
                      AND al2.admission_change_shift_type_id = acst.admission_change_shift_type_id
                ) AS count_new_patient

                ,(
                    SELECT COUNT(*)
                    FROM admission_list al2
                    WHERE al2.ward = ${ward}
                      AND al2.admission_type_id = 2
                      AND al2.reg_datetime::date = ${parsedDate}::date
                      AND al2.admission_change_shift_type_id = acst.admission_change_shift_type_id
                ) AS count_get_ward_patient
                ,SUM(CASE WHEN al.discharge_type_id = 1
                          AND al.discharge_datetime::date = ${parsedDate}::date
                          AND al.discharge_datetime::time BETWEEN
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '00:00:00' WHEN 2 THEN TIME '08:00:00' WHEN 3 THEN TIME '16:00:00'
                                END
                              AND
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '07:59:59' WHEN 2 THEN TIME '15:59:59' WHEN 3 THEN TIME '23:59:59'
                                END
                          THEN 1 ELSE 0 END) AS count_discharge
                ,SUM(CASE WHEN al.discharge_type_id = 2
                          AND al.discharge_datetime::date = ${parsedDate}::date
                          AND al.discharge_datetime::time BETWEEN
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '00:00:00' WHEN 2 THEN TIME '08:00:00' WHEN 3 THEN TIME '16:00:00'
                                END
                              AND
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '07:59:59' WHEN 2 THEN TIME '15:59:59' WHEN 3 THEN TIME '23:59:59'
                                END
                          THEN 1 ELSE 0 END) AS count_transfer_out
                ,SUM(CASE WHEN al.discharge_type_id = 3
                          AND al.discharge_datetime::date = ${parsedDate}::date
                          AND al.discharge_datetime::time BETWEEN
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '00:00:00' WHEN 2 THEN TIME '08:00:00' WHEN 3 THEN TIME '16:00:00'
                                END
                              AND
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '07:59:59' WHEN 2 THEN TIME '15:59:59' WHEN 3 THEN TIME '23:59:59'
                                END
                          THEN 1 ELSE 0 END) AS count_refer
                ,SUM(CASE WHEN al.discharge_type_id = 4
                          AND al.discharge_datetime::date = ${parsedDate}::date
                          AND al.discharge_datetime::time BETWEEN
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '00:00:00' WHEN 2 THEN TIME '08:00:00' WHEN 3 THEN TIME '16:00:00'
                                END
                              AND
                                CASE acst.admission_change_shift_type_id
                                    WHEN 1 THEN TIME '07:59:59' WHEN 2 THEN TIME '15:59:59' WHEN 3 THEN TIME '23:59:59'
                                END
                          THEN 1 ELSE 0 END) AS count_dead
                ,SUM(CASE WHEN asdr.admission_shift_care_level_id = 1 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS care_normal
                ,SUM(CASE WHEN asdr.admission_shift_care_level_id = 2 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS care_o2
                ,SUM(CASE WHEN asdr.admission_shift_care_level_id = 3 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS care_hfnc
                ,SUM(CASE WHEN asdr.admission_shift_care_level_id = 4 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS care_vent_cs
                ,SUM(CASE WHEN asdr.severity_level_id = 1 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS severity_1
                ,SUM(CASE WHEN asdr.severity_level_id = 2 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS severity_2
                ,SUM(CASE WHEN asdr.severity_level_id = 3 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS severity_3
                ,SUM(CASE WHEN asdr.severity_level_id = 4 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS severity_4
                ,SUM(CASE WHEN asdr.severity_level_id = 5 AND al.admission_list_id IS NOT NULL THEN 1 ELSE 0 END) AS severity_5
            FROM admission_change_shift_types acst
            LEFT JOIN admission_shift_daily_record asdr
                   ON asdr.shift_type_id = acst.admission_change_shift_type_id
                  AND asdr.record_date = ${parsedDate}
            LEFT JOIN admission_list al
                   ON al.admission_list_id = asdr.admission_list_id
                  AND al.ward = ${ward}
            GROUP BY
                 acst.admission_change_shift_type_id
                ,acst.shift_name
                ,acst.weight
            ORDER BY acst.admission_change_shift_type_id
        `;

        return { success: true, data: rows };
    } catch (error) {
        console.error('Get patient shift daily records summary error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ฟังก์ชันสำหรับดึงข้อมูลผู้ป่วยที่ลงทะเบียนตาม ward พร้อมข้อมูลเวร (Shift Records)
export const getPatientsRegisterByWard = async ({ params, set }: Context) => {
    const { ward } = params as { ward: string };

    try {
        // 1. ดึงข้อมูลผู้ป่วยจาก admission_list (PG)
        const patients = await nurse`
            SELECT
                al.admission_list_id,
                al.hn,
                al.an,
                al.patient_name AS name,
                EXTRACT(YEAR FROM AGE(CURRENT_DATE, al.birth_date))::int AS age,
                al.ward,
                al.bedno AS bed,
                al.reg_datetime,
                s.name AS spclty_name,
                al.incharge_doctor,
                al.admission_type_id,
                al.spclty
            FROM admission_list al
            LEFT JOIN spclty s ON s.spclty = al.spclty
            WHERE al.ward = ${ward} AND al.status = '1'
            ORDER BY al.bedno ASC
        `;

        if (patients.length === 0) {
            return { success: true, data: [] };
        }

        // 2. ดึงข้อมูล wardName จาก HIS (MySQL)
        const [wardData] = await his.execute<RowDataPacket[]>(
            `SELECT name FROM ward WHERE ward = ?`,
            [ward]
        );
        const wardName = wardData.length > 0 ? wardData[0].name : ward;

        // 3. ดึงข้อมูล doctorName จาก HIS (MySQL)
        const doctorCodes = [...new Set(patients.map(p => p.incharge_doctor).filter(Boolean))];
        let doctorMap: Record<string, string> = {};
        if (doctorCodes.length > 0) {
            const placeholders = doctorCodes.map(() => '?').join(',');
            const [doctors] = await his.execute<RowDataPacket[]>(
                `SELECT code, name FROM doctor WHERE code IN (${placeholders})`,
                doctorCodes
            );
            doctors.forEach(d => {
                doctorMap[d.code] = d.name;
            });
        }

        // 4. ประกอบข้อมูลเป็น JSON Format ตามโครงสร้างที่ต้องการ
        const data = patients.map(p => {
            const regDate = p.reg_datetime ? new Date(p.reg_datetime) : null;
            let admitDate = null;
            let admitDateTimeIso = null;

            if (regDate && !isNaN(regDate.getTime())) {
                const pad = (n: number) => n.toString().padStart(2, '0');
                admitDate = `${pad(regDate.getDate())}/${pad(regDate.getMonth() + 1)}/${regDate.getFullYear()}`;
                admitDateTimeIso = `${regDate.getFullYear()}-${pad(regDate.getMonth() + 1)}-${pad(regDate.getDate())}T${pad(regDate.getHours())}:${pad(regDate.getMinutes())}:${pad(regDate.getSeconds())}`;
            }

            return {
                admission_list_id: p.admission_list_id,
                hn: p.hn,
                an: p.an,
                name: p.name ? sanitizeHTML(p.name) : null,
                age: p.age !== null ? Number(p.age) : null,
                ward: p.ward,
                wardName: wardName ? sanitizeHTML(wardName) : p.ward,
                bed: p.bed,
                admitDate,
                admitDateTimeIso,
                spcltyName: p.spclty_name ? sanitizeHTML(p.spclty_name) : null,
                doctorName: p.incharge_doctor && doctorMap[p.incharge_doctor] ? sanitizeHTML(doctorMap[p.incharge_doctor]) : (p.incharge_doctor || null),
                admission_type_id: p.admission_type_id ?? null,
                spclty: p.spclty ?? null
            };
        });

        return {
            success: true,
            data
        };

    } catch (error) {
        console.error('Get patients register by ward error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};
