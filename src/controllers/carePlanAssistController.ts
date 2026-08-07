import type { Context } from 'elysia';
import type { RowDataPacket } from 'mysql2';
import { nurse, his } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { resolveActor } from '../utils/nursingRecord';
import { chat, extractJSON, isConfigured, LMStudioError } from '../utils/lmStudio';
import { aiAssistantEnabled } from './systemSettingsController';

/**
 * ผู้ช่วยร่างกิจกรรมการพยาบาล
 *
 * ร่างเท่านั้น ไม่บันทึกอะไรลงฐานข้อมูล พยาบาลเป็นผู้ตัดสินใจว่าจะใช้ข้อความไหน
 * แล้วกดบันทึกเองผ่าน POST /careplan ตามปกติ ความรับผิดชอบทางวิชาชีพจึงอยู่ที่คนเสมอ
 */

/** เพดานผลลัพธ์ กันโมเดลสาธยายยาวจนเอาไปใช้ไม่ได้ */
const MAX_ITEMS = 8;
const MAX_ITEM_LENGTH = 300;
const MAX_OUTCOME_LENGTH = 600;

/**
 * จำกัดจำนวนครั้งต่อผู้ใช้
 * หนึ่งคำขอกินเวลาโมเดลราวหนึ่งนาที ถ้ากดรัวจะแย่งคิวกันเองทั้งโรงพยาบาล
 * เก็บในหน่วยความจำพอ เพราะรีสตาร์ทแล้วเริ่มนับใหม่ก็ไม่เสียหาย
 */
const RATE_LIMIT = { max: 5, windowMs: 60_000 };
const recentCalls = new Map<string, number[]>();

/**
 * งานร่างทำเป็นเบื้องหลัง ไม่ให้ผู้เรียกค้างสายรอ
 *
 * โมเดลใช้เวลาราวหนึ่งนาที ซึ่งนานกว่าที่ proxy ระหว่างทางยอมให้ค้างสาย
 * (dev proxy ของ Next ตัดที่ 30 วินาที · nginx ปกติ 60 วินาที)
 * จึงตอบ job_id กลับไปทันที แล้วให้หน้าจอถามผลเป็นระยะ ทุกคำขอจึงจบในเสี้ยววินาที
 *
 * เก็บในหน่วยความจำพอ ผลลัพธ์เป็นแค่ร่างที่ขอใหม่ได้ ไม่ใช่ข้อมูลที่เสียไม่ได้
 */
interface SuggestJob {
    owner: string;
    status: 'pending' | 'done' | 'error';
    createdAt: number;
    finishedAt?: number;
    data?: unknown;
    message?: string;
}
const jobs = new Map<string, SuggestJob>();
const JOB_TTL_MS = 10 * 60_000;

const purgeOldJobs = () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
    }
};

const tooManyRequests = (username: string): boolean => {
    const now = Date.now();
    const calls = (recentCalls.get(username) ?? []).filter(t => now - t < RATE_LIMIT.windowMs);
    if (calls.length >= RATE_LIMIT.max) {
        recentCalls.set(username, calls);
        return true;
    }
    calls.push(now);
    recentCalls.set(username, calls);
    return false;
};

/**
 * ข้อมูลผู้ป่วยที่ส่งให้โมเดลได้
 * เอาแค่อายุกับเพศซึ่งจำเป็นต่อการเลือกกิจกรรม ไม่ส่ง HN AN ชื่อ หรือเตียง
 * เพราะข้อมูลระบุตัวตนไม่มีผลต่อคำแนะนำ แต่เพิ่มความเสี่ยงถ้าหลุด
 */
const fetchPatientContext = async (an: string): Promise<{ age: number | null; sex: string | null }> => {
    try {
        const [rows] = await his.execute<RowDataPacket[]>(
            `SELECT p.birthday, p.sex FROM ipt i LEFT JOIN patient p ON p.hn = i.hn WHERE i.an = ? LIMIT 1`,
            [an]
        );
        const birthday = rows[0]?.birthday;
        let age: number | null = null;
        if (birthday) {
            const b = new Date(birthday);
            if (!isNaN(b.getTime())) {
                const now = new Date();
                age = now.getFullYear() - b.getFullYear();
                const before =
                    now.getMonth() < b.getMonth() ||
                    (now.getMonth() === b.getMonth() && now.getDate() < b.getDate());
                if (before) age -= 1;
                if (age < 0 || age > 130) age = null;
            }
        }
        // รหัสเพศใน HIS: 1 = ชาย, 2 = หญิง
        const sexCode = String(rows[0]?.sex ?? '').trim();
        const sex = sexCode === '1' ? 'ชาย' : sexCode === '2' ? 'หญิง' : null;
        return { age, sex };
    } catch (error) {
        console.error('Fetch patient context error:', error);
        return { age: null, sex: null };
    }
};

/** สัญญาณชีพครั้งล่าสุดของ AN นี้ เขียนเป็นประโยคเดียวให้โมเดลอ่าน */
const fetchLatestVitals = async (an: string) => {
    const rows = await nurse`
        SELECT record_datetime, vital_t, vital_p, vital_r, vital_bp_s, vital_bp_d,
               vital_o2sat, pain_score, consciousness, news2_score, news2_risk
        FROM nursing_vital_records
        WHERE an = ${an} AND is_deleted IS NOT TRUE
        ORDER BY record_datetime DESC, id DESC
        LIMIT 1
    `;
    const v = rows[0] as Record<string, unknown> | undefined;
    if (!v) return null;

    const parts: string[] = [];
    if (v.vital_t != null) parts.push(`อุณหภูมิ ${v.vital_t} องศาเซลเซียส`);
    if (v.vital_p != null) parts.push(`ชีพจร ${v.vital_p} ครั้ง/นาที`);
    if (v.vital_r != null) parts.push(`หายใจ ${v.vital_r} ครั้ง/นาที`);
    if (v.vital_bp_s != null && v.vital_bp_d != null) parts.push(`ความดัน ${v.vital_bp_s}/${v.vital_bp_d} มม.ปรอท`);
    if (v.vital_o2sat != null) parts.push(`ออกซิเจนปลายนิ้ว ${v.vital_o2sat}%`);
    if (v.pain_score != null) parts.push(`ระดับความปวด ${v.pain_score}/10`);
    if (v.consciousness) parts.push(`ระดับความรู้สึกตัว ${v.consciousness}`);
    if (v.news2_score != null) parts.push(`NEWS2 ${v.news2_score} คะแนน (${v.news2_risk ?? '-'})`);

    return {
        text: parts.join(', ') || null,
        recorded_at: v.record_datetime,
    };
};

const SYSTEM_PROMPT = `คุณเป็นผู้ช่วยของพยาบาลวิชาชีพในโรงพยาบาลไทย ช่วยร่างแผนการพยาบาล
ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอก JSON
รูปแบบ: {"interventions":["...","..."],"expected_outcome":"..."}

ข้อกำหนด
- interventions: กิจกรรมการพยาบาลที่พยาบาลปฏิบัติได้จริง 4-6 ข้อ ภาษาไทย ขึ้นต้นด้วยคำกริยา ระบุความถี่เมื่อจำเป็น
- expected_outcome: ผลลัพธ์ที่วัดได้ ระบุตัวเลขหรือเกณฑ์ที่ตรวจสอบได้ ภาษาไทย หนึ่งย่อหน้า
- ห้ามสั่งยา ห้ามระบุชื่อยาหรือขนาดยา ให้เขียนว่า "ให้ยาตามแผนการรักษา" แทน
- ห้ามวินิจฉัยโรคหรือสั่งการรักษาที่เป็นอำนาจของแพทย์
- ต้องสอดคล้องกับเพศและอายุของผู้ป่วยที่ระบุ ห้ามแนะนำการดูแลอวัยวะที่ผู้ป่วยเพศนั้นไม่มี
- อ้างอิงชุดคำมาตรฐาน NIC ที่ให้มาเป็นหลักก่อน แล้วจึงขยายความให้ปฏิบัติได้`;

/** งานร่างจริง ทำงานหลังจากตอบ job_id ไปแล้ว ผลลัพธ์ไปจบที่ jobs.set() */
const runSuggestion = async (jobId: string, an: string, diagnosis: string, payload: Record<string, unknown>) => {
    const finish = (patch: Partial<SuggestJob>) => {
        const job = jobs.get(jobId);
        if (job) jobs.set(jobId, { ...job, ...patch, finishedAt: Date.now() });
    };

    try {
        const [patient, vitals, nic] = await Promise.all([
            fetchPatientContext(an),
            fetchLatestVitals(an),
            nurse`SELECT code, label_th FROM ref_nic_interventions WHERE is_active ORDER BY domain, sort_order`,
        ]);

        const relatedTo = String(payload.related_to ?? '').trim().slice(0, 500);
        const goal = String(payload.goal ?? '').trim().slice(0, 500);

        const prompt = [
            `ข้อวินิจฉัยทางการพยาบาล: ${diagnosis.slice(0, 500)}`,
            relatedTo ? `สัมพันธ์กับ: ${relatedTo}` : null,
            goal ? `เป้าหมาย: ${goal}` : null,
            patient.age !== null || patient.sex
                ? `ผู้ป่วย: ${patient.sex ?? 'ไม่ระบุเพศ'}${patient.age !== null ? ` อายุ ${patient.age} ปี` : ''}`
                : null,
            vitals?.text ? `สัญญาณชีพล่าสุด: ${vitals.text}` : 'ยังไม่มีบันทึกสัญญาณชีพ',
            '',
            'ชุดคำมาตรฐาน NIC ที่ใช้อ้างอิงได้:',
            nic.map(n => `- ${String(n.label_th)}`).join('\n'),
        ].filter(Boolean).join('\n');

        const result = await chat(SYSTEM_PROMPT, prompt);
        const parsed = extractJSON<{ interventions?: unknown; expected_outcome?: unknown }>(result.text);

        if (!parsed) {
            return finish({
                status: 'error',
                message: result.truncated ? 'โมเดลตอบไม่จบ ลองใหม่อีกครั้ง' : 'อ่านคำตอบของโมเดลไม่ได้ ลองใหม่อีกครั้ง',
            });
        }

        // ล้างแท็กและตัดความยาว ข้อความจากโมเดลเชื่อรูปแบบไม่ได้เท่ากับข้อมูลที่คนกรอก
        const interventions = (Array.isArray(parsed.interventions) ? parsed.interventions : [])
            .filter(v => typeof v === 'string' && v.trim())
            .slice(0, MAX_ITEMS)
            .map(v => (sanitizeHTML(String(v).trim()) ?? '').slice(0, MAX_ITEM_LENGTH))
            .filter(v => v.length > 0);

        const expectedOutcome = (sanitizeHTML(String(parsed.expected_outcome ?? '').trim()) ?? '')
            .slice(0, MAX_OUTCOME_LENGTH);

        if (interventions.length === 0) {
            return finish({ status: 'error', message: 'โมเดลไม่ได้ให้กิจกรรมการพยาบาลกลับมา ลองใหม่อีกครั้ง' });
        }

        finish({
            status: 'done',
            data: {
                interventions,
                expected_outcome: expectedOutcome || null,
                // ส่งกลับว่าใช้อะไรเป็นข้อมูลตั้งต้น พยาบาลจะได้ตรวจได้ว่าโมเดลเห็นอะไรบ้าง
                context: {
                    patient_age: patient.age,
                    patient_sex: patient.sex,
                    vitals: vitals?.text ?? null,
                    vitals_recorded_at: vitals?.recorded_at ?? null,
                },
                model: result.model,
                elapsed_ms: result.elapsedMs,
            },
        });
    } catch (error) {
        if (error instanceof LMStudioError) {
            return finish({ status: 'error', message: error.message });
        }
        console.error('Suggest care plan error:', error);
        finish({ status: 'error', message: 'ขอคำแนะนำไม่สำเร็จ กรุณาลองใหม่' });
    }
};

// ---------- ถามผลของงานร่าง ----------
export const getSuggestionStatus = async ({ params, set, user }: Context & { user: any }) => {
    const { jobId } = params as { jobId: string };
    const job = jobs.get(String(jobId));

    if (!job) {
        set.status = 404;
        return { success: false, message: 'ไม่พบคำขอนี้ อาจหมดอายุแล้ว กรุณาขอใหม่' };
    }

    // ร่างของใครคนนั้นดู เพราะข้อความมีบริบทอาการของผู้ป่วยอยู่ในนั้น
    const username = String((user as { username?: unknown } | null)?.username ?? '');
    if (job.owner !== username) {
        set.status = 403;
        return { success: false, message: 'ดูผลคำขอของผู้อื่นไม่ได้' };
    }

    if (job.status === 'pending') {
        return { success: true, status: 'pending', waited_ms: Date.now() - job.createdAt };
    }
    if (job.status === 'error') {
        return { success: false, status: 'error', message: job.message ?? 'ขอคำแนะนำไม่สำเร็จ' };
    }
    return { success: true, status: 'done', data: job.data };
};

export const suggestCarePlan = async ({ body, set, user }: Context & { user: any }) => {
    const payload = (body ?? {}) as Record<string, unknown>;
    const an = String(payload.an ?? '').trim();
    const diagnosis = String(payload.nursing_diagnosis ?? '').trim();

    // ตรวจทุกครั้งที่เรียก ไม่ใช่ตอนบูต ผู้ดูแลระบบปิดเมื่อไรก็มีผลกับคำขอถัดไปทันที
    if (!(await aiAssistantEnabled())) {
        set.status = 403;
        return { success: false, message: 'ผู้ช่วย AI ถูกปิดใช้งานโดยผู้ดูแลระบบ' };
    }
    if (!isConfigured()) {
        set.status = 503;
        return { success: false, message: 'ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์โมเดล (LM_STUDIO_URL / LM_STUDIO_MODEL)' };
    }
    if (!an) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }
    if (diagnosis.length < 3) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุข้อวินิจฉัยทางการพยาบาล อย่างน้อย 3 ตัวอักษร' };
    }

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }
    if (tooManyRequests(actor.username)) {
        set.status = 429;
        return {
            success: false,
            message: `ขอคำแนะนำได้ไม่เกิน ${RATE_LIMIT.max} ครั้งต่อนาที กรุณารอสักครู่`,
        };
    }

    purgeOldJobs();
    const jobId = crypto.randomUUID();
    jobs.set(jobId, { owner: actor.username, status: 'pending', createdAt: Date.now() });

    // ตั้งใจไม่ await — ต้องตอบ job_id กลับไปทันทีก่อนที่ proxy ระหว่างทางจะตัดสาย
    void runSuggestion(jobId, an, diagnosis, payload);

    set.status = 202;
    return { success: true, status: 'pending', job_id: jobId };
};
