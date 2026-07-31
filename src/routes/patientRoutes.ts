import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    getPatientsByWard,
    dischargePatient,
    cancelDischarge,
    getPatientDischargeByWard,
    getPatientByward,
    getDischargedPatientByWard,
    registerPatient,
    updatePatient,
    upsertAdmissionShiftDailyRecord,
    copyPreviousShiftDailyRecords,
    getPatientShiftDailyRecordsByWard,
    getPatientsBYAN,
    savePatientsInShift,
    saveShiftAssessment,
    getShiftAssessment,
    getPatientShiftDailyRecordsSummary,
    getPatientsRegisterByWard,
} from '../controllers/patientController';

const nullableString = t.Optional(t.Union([t.String(), t.Null()]));
const nullableNumber = t.Optional(t.Union([t.Number(), t.Null()]));
const nullableNumOrStr = t.Optional(t.Union([t.Number(), t.String(), t.Null()]));

export const patientRoutes = new Elysia({ prefix: '/api/v1/patients' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Patient'] } })

    // ---------- รายการผู้ป่วย ----------
    .post('/patients-list-by-ward', getPatientsByWard, {
        body: t.Object({
            ward: t.String()
        })
    })
    .get('/view-patient-by-ward/:ward', getPatientByward, {
        params: t.Object({
            ward: t.String()
        })
    })
    .get('/patients-register-by-ward/:ward', getPatientsRegisterByWard, {
        params: t.Object({
            ward: t.String()
        })
    })
    .post('/patient-by-an', getPatientsBYAN, {
        body: t.Object({
            an: t.String()
        })
    })

    // ---------- ลงทะเบียน / แก้ไข ----------
    .post('/register', registerPatient, {
        body: t.Object({
            an: t.String(),
            hn: t.String(),
            patient_name: t.String(),
            reg_datetime: t.String(),
            ward: t.String(),
            before_ward: nullableString,
            birth_date: nullableString,
            spclty: nullableString,
            gender: nullableString,
            bedno: nullableString,
            admission_type_id: nullableNumber,
            status: t.Optional(t.Union([t.Number(), t.String()])),
            admission_change_shift_type_id: nullableNumber,
            incharge_doctor: nullableString
        })
    })
    .put('/update-patient', updatePatient, {
        body: t.Object({
            admission_list_id: t.Number(),
            patient_name: t.String(),
            reg_datetime: t.String(),
            ward: t.String(),
            before_ward: nullableString,
            birth_date: nullableString,
            spclty: nullableString,
            bedno: nullableString,
            admission_type_id: nullableNumber,
            status: t.Optional(t.Union([t.Number(), t.String()])),
            admission_change_shift_type_id: nullableNumber,
            incharge_doctor: nullableString
        })
    })

    // ---------- จำหน่ายผู้ป่วย ----------
    .post('/discharge', dischargePatient, {
        body: t.Object({
            admission_list_id: t.Number(),
            discharge_type_id: t.Number(),
            discharge_datetime: t.String(),
            move_to_ward: t.Union([t.String(), t.Null()]),
            status: t.Union([t.String(), t.Number()]),
            los: t.Number()
        })
    })
    .patch('/cancel-discharge/:admission_list_id', cancelDischarge, {
        params: t.Object({
            admission_list_id: t.String()
        })
    })
    .post('/view-discharged-patient-by-ward', getDischargedPatientByWard, {
        body: t.Object({
            ward: t.String(),
            ds1: t.String(),
            ds2: t.String()
        })
    })
    .post('/patient-discharge-by-ward', getPatientDischargeByWard, {
        body: t.Object({
            ward: t.String(),
            date_from: nullableString,
            date_to: nullableString
        })
    })

    // ---------- shift daily record ----------
    .post('/admission-shift-daily-records', upsertAdmissionShiftDailyRecord, {
        body: t.Object({
            admission_list_id: t.Number(),
            shift_type_id: t.Number(),
            date: t.String(),
            level: nullableNumber,
            admission_shift_care_level_id: nullableNumber,
            severity_level_id: t.Optional(t.Number()),
            hn: t.Optional(t.String()),
            an: t.Optional(t.String())
        })
    })
    .post('/patient-shift-daily-records/copy-previous', copyPreviousShiftDailyRecords, {
        body: t.Object({
            ward: t.String(),
            target_date: t.String(),
            target_shift_type_id: t.Number(),
            source_date: t.String(),
            source_shift_type_id: t.Number()
        })
    })
    .post('/patient-shift-daily-records', getPatientShiftDailyRecordsByWard, {
        body: t.Object({
            ward: t.String(),
            date: t.String()
        })
    })
    .post('/patient-shift-daily-records-summary', getPatientShiftDailyRecordsSummary, {
        body: t.Object({
            ward: t.String(),
            date: t.String()
        })
    })

    // ---------- shift assessment ----------
    .post('/save-patients-in-shift', savePatientsInShift, {
        body: t.Array(t.Object({
            admission_list_id: t.Number(),
            admission_change_shift_type_id: t.Number(),
            an: t.String(),
            hn: t.String(),
            ward: t.String(),
            shift_date: t.String(),
            staff: nullableString,
            severity_level_id: t.Number(),
            ventilator_use: nullableNumOrStr,
            comment: nullableString
        }))
    })
    .post('/save-shift-assessment', saveShiftAssessment, {
        body: t.Object({
            admission_list_id: t.Number(),
            admission_change_shift_type_id: t.Number(),
            an: t.String(),
            hn: t.String(),
            ward: t.String(),
            shift_date: t.String(),
            severity_level_id: t.Number(),
            staff: nullableString,
            ventilator_use: nullableNumOrStr,
            level_of_care: nullableNumOrStr,
            pain_score: nullableNumber,
            fall_risk: nullableNumOrStr,
            pressure_sore_risk: nullableNumOrStr,
            gcs_eye: nullableNumber,
            gcs_verbal: nullableNumber,
            gcs_motor: nullableNumber,
            oxygen_support_type_id: nullableNumber,
            safety_precautions: t.Optional(t.Union([t.Array(t.Any()), t.Any(), t.Null()])),
            comment: nullableString
        })
    })
    .post('/get-shift-assessment', getShiftAssessment, {
        body: t.Object({
            admission_list_id: t.Number(),
            shift_date: t.String(),
            admission_change_shift_type_id: t.Number(),
            ward: t.String()
        })
    });
