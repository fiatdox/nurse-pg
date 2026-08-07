import type { Context } from 'elysia';
import type { RowDataPacket } from 'mysql2';
import { nurse, his } from '../db';
import { sanitizeHTML } from '../utils/sanitize';
import { toLocalDate, resolveActor, type Actor } from '../utils/nursingRecord';

/**
 * แผนการพยาบาล (Nursing Care Plan)
 *
 * หนึ่ง AN มีได้หลายข้อวินิจฉัย แต่ละข้อคือหนึ่งแถวและมีวงจรของตัวเอง
 * (active → resolved เมื่อบรรลุเป้าหมาย หรือ revised เมื่อต้องปรับแผน)
 * บันทึกทางการพยาบาลผูกกลับมาที่แถวนี้ผ่าน nursing_progress_notes.care_plan_id
 */

/** คอลัมน์ที่รับจาก client — นอกรายการนี้ถูกตัดทิ้ง */
const PLAN_FIELDS = [
    // ไม่มี nurse_name / staff_id — ผู้บันทึกมาจาก token เท่านั้น เช่นเดียวกับโมดูลอื่น
    'ward_code', 'ward_name', 'start_date', 'priority',
    'nursing_diagnosis', 'nanda_code', 'related_to', 'goal',
    'expected_outcome', 'interventions', 'evaluation', 'evaluation_date', 'status',
] as const;

/** ฟิลด์ข้อความที่พยาบาลพิมพ์เอง ต้องล้างแท็กก่อนส่งออก */
const PLAN_TEXT_FIELDS = [
    'ward_name', 'nurse_name', 'nursing_diagnosis', 'related_to', 'goal',
    'expected_outcome', 'interventions', 'evaluation',
];

const VALID_PRIORITY = ['high', 'medium', 'low'];
const VALID_STATUS = ['active', 'resolved', 'revised'];

/** เพดานความยาวของคอลัมน์ varchar — เกินต้องคืน 400 ไม่ใช่ปล่อยไปพังเป็น 500 */
const MAX_LENGTH: Record<string, number> = {
    an: 20, ward_code: 20, ward_name: 100,
    priority: 10, status: 10, nursing_diagnosis: 500, nanda_code: 10,
};

const LENGTH_LABELS: Record<string, string> = {
    an: 'AN', ward_code: 'รหัสหอผู้ป่วย', ward_name: 'ชื่อหอผู้ป่วย',
    priority: 'ลำดับความสำคัญ', status: 'สถานะ',
    nursing_diagnosis: 'ข้อวินิจฉัยทางการพยาบาล', nanda_code: 'รหัส NANDA',
};

const tooLong = (values: Record<string, unknown>): string | null => {
    for (const [field, max] of Object.entries(MAX_LENGTH)) {
        const v = values[field];
        if (v === null || v === undefined) continue;
        if (String(v).length > max) {
            return `${LENGTH_LABELS[field] ?? field} ยาวเกิน ${max} ตัวอักษร`;
        }
    }
    return null;
};

const sanitizeRow = (row: Record<string, unknown>) => {
    const out = { ...row };
    for (const f of PLAN_TEXT_FIELDS) {
        if (typeof out[f] === 'string') out[f] = sanitizeHTML(out[f] as string);
    }
    return out;
};

/** ตัดเวลาออกจากค่าที่รับมา คอลัมน์เป็น date ไม่ใช่ timestamp */
const toDateOnly = (v: unknown): Date | null => {
    const d = toLocalDate(v);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * ตรวจและแปลงค่าให้พร้อมเขียนลงตาราง ใช้ร่วมกันทั้งตอนสร้างและตอนแก้ไข
 * เพื่อให้กติกาเหมือนกันทั้งสองทาง
 */
const buildValues = async (payload: Record<string, unknown>, actor: Actor) => {
    const diagnosis = String(payload.nursing_diagnosis ?? '').trim();
    if (diagnosis.length < 3) {
        return { error: 'กรุณาระบุข้อวินิจฉัยทางการพยาบาล อย่างน้อย 3 ตัวอักษร' };
    }

    const priority = String(payload.priority ?? 'medium').trim() || 'medium';
    if (!VALID_PRIORITY.includes(priority)) {
        return { error: 'ลำดับความสำคัญไม่ถูกต้อง (high / medium / low)' };
    }

    const status = String(payload.status ?? 'active').trim() || 'active';
    if (!VALID_STATUS.includes(status)) {
        return { error: 'สถานะไม่ถูกต้อง (active / resolved / revised)' };
    }

    const startDate = toDateOnly(payload.start_date) ?? toDateOnly(new Date())!;
    const evaluationDate = toDateOnly(payload.evaluation_date);

    if (evaluationDate && evaluationDate.getTime() < startDate.getTime()) {
        return { error: 'วันที่ประเมินผลต้องไม่ก่อนวันที่เริ่มแผน' };
    }

    const values: Record<string, unknown> = {};
    for (const f of PLAN_FIELDS) {
        const v = payload[f];
        values[f] = v === undefined || v === '' ? null : v;
    }

    values.nursing_diagnosis = diagnosis;
    values.priority = priority;
    values.status = status;
    values.start_date = startDate;
    // ปิดแผนแล้วต้องมีวันที่ประเมินผลเสมอ ไม่งั้นอ่านย้อนหลังไม่รู้ว่าสรุปผลเมื่อไร
    values.evaluation_date = evaluationDate ?? (status === 'active' ? null : toDateOnly(new Date()));
    // ผู้บันทึกมาจากบัญชีที่เข้าสู่ระบบ ไม่ใช่จากฟอร์ม — เป็นข้อมูลที่ใช้อ้างอิงว่าใครวางแผน
    values.staff_id = actor.userId;
    values.nurse_name = actor.fullname;

    // รหัส NANDA เป็นตัวเลือก แต่ถ้าส่งมาต้องมีจริงในตารางอ้างอิง
    // ไม่งั้นเวชระเบียนจะมีรหัสที่อ้างไปไม่ถึงข้อวินิจฉัยใด
    const nandaCode = String(payload.nanda_code ?? '').trim();
    if (nandaCode) {
        const ref = await nurse`
            SELECT code FROM ref_nanda_diagnoses WHERE code = ${nandaCode} AND is_active LIMIT 1
        `;
        if (ref.length === 0) {
            return { error: `ไม่พบรหัส NANDA "${nandaCode}" ในชุดคำมาตรฐาน` };
        }
    }
    values.nanda_code = nandaCode || null;

    const lengthError = tooLong({ ...values, an: payload.an });
    if (lengthError) return { error: lengthError };

    return { values };
};

/**
 * หอผู้ป่วยที่แท้จริงของ AN นี้ จากทะเบียนรับไว้ใน HIS
 *
 * ต้องหาเองไม่ใช่เชื่อค่าที่หน้าจอส่งมา เพราะ ward_code คือคีย์ที่หน้ารวมงานระดับหอใช้กรอง
 * ถ้าพลาดไปหอเดียว แผนของผู้ป่วยรายนั้นจะหายไปจากมุมมองของหอที่ดูแลจริง
 * หา HIS ไม่เจอ (เช่นเป็น AN ทดสอบ) ค่อยใช้ค่าที่ส่งมา จะได้ไม่บล็อกการบันทึก
 */
const fetchWardOfAN = async (an: string): Promise<{ code: string; name: string | null } | null> => {
    try {
        const [rows] = await his.execute<RowDataPacket[]>(
            `SELECT i.ward, w.name AS ward_name
             FROM ipt i LEFT JOIN ward w ON w.ward = i.ward
             WHERE i.an = ? LIMIT 1`,
            [an]
        );
        const code = String(rows[0]?.ward ?? '').trim();
        if (!code) return null;
        return { code, name: String(rows[0]?.ward_name ?? '').trim() || null };
    } catch (error) {
        console.error('Fetch ward of AN error:', error);
        return null;
    }
};

/**
 * ข้อวินิจฉัยเดิมที่ยังเปิดค้างอยู่ของผู้ป่วยรายนี้
 * ฐานข้อมูลกันไว้ด้วย uq_careplan_active_diagnosis อีกชั้น ตรงนี้มีไว้เพื่อบอกเหตุผลเป็นภาษาคน
 */
const findActiveDuplicate = async (an: string, diagnosis: string, exceptId: number | null) => {
    const rows = await nurse`
        SELECT id, nurse_name, start_date FROM nursing_care_plans
        WHERE an = ${an}
          AND lower(btrim(nursing_diagnosis)) = ${diagnosis.trim().toLowerCase()}
          AND status = 'active'
          AND is_deleted IS NOT TRUE
          ${exceptId ? nurse`AND id <> ${exceptId}` : nurse``}
        LIMIT 1
    `;
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
};

const duplicateMessage = (row: Record<string, unknown>) => {
    const by = String(row.nurse_name ?? '').trim() || 'ไม่ทราบผู้บันทึก';
    const on = row.start_date ? new Date(String(row.start_date)).toLocaleDateString('th-TH') : '-';
    return `ข้อวินิจฉัยนี้มีแผนที่ยังดำเนินการอยู่แล้ว (เริ่ม ${on} โดย ${by}) กรุณาแก้ไขแผนเดิมแทนการเพิ่มใหม่`;
};

// ---------- ดึงแผนการพยาบาลตาม AN ----------
export const getCarePlansByAN = async ({ params, query, set }: Context) => {
    const { an } = params as { an: string };
    const { status } = (query ?? {}) as { status?: string };

    if (!an?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }

    // ไม่กรองก็ได้ทั้งหมด เพราะหน้าจอต้องเห็นทั้งที่ดำเนินการอยู่และที่ปิดไปแล้ว
    const onlyStatus = String(status ?? '').trim();
    if (onlyStatus && !VALID_STATUS.includes(onlyStatus)) {
        set.status = 400;
        return { success: false, message: 'สถานะที่ใช้กรองไม่ถูกต้อง (active / resolved / revised)' };
    }

    try {
        const rows = await nurse`
            SELECT p.*, r.label_th AS nanda_label
            FROM nursing_care_plans p
            LEFT JOIN ref_nanda_diagnoses r ON r.code = p.nanda_code
            WHERE p.an = ${an.trim()}
              AND p.is_deleted IS NOT TRUE
              ${onlyStatus ? nurse`AND p.status = ${onlyStatus}` : nurse``}
            ORDER BY p.start_date DESC NULLS LAST, p.id DESC
        `;
        return { success: true, data: rows.map(r => sanitizeRow(r as Record<string, unknown>)) };
    } catch (error) {
        console.error('Get care plans error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แผนการพยาบาลทั้งหอผู้ป่วย ----------
/**
 * ใช้ดูภาพรวมของหอผู้ป่วย เช่น หน้ารวมงานหรือแดชบอร์ด ว่าตอนนี้มีข้อวินิจฉัยอะไรค้างอยู่บ้าง
 * จัดกลุ่มตาม AN ให้เลย เพราะมุมมองระดับหอสนใจ "ผู้ป่วยรายไหนมีแผนอะไร" ไม่ใช่แถวเรียงยาว
 */
export const getCarePlansByWard = async ({ query, set }: Context) => {
    const { ward_code, status, limit } = (query ?? {}) as {
        ward_code?: string; status?: string; limit?: string;
    };

    if (!ward_code?.trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward_code' };
    }

    // ไม่ระบุ = เอาเฉพาะที่ยังดำเนินการอยู่ ซึ่งเป็นสิ่งที่หน้ารวมงานต้องการเกือบทุกครั้ง
    const onlyStatus = String(status ?? 'active').trim();
    if (onlyStatus !== 'all' && !VALID_STATUS.includes(onlyStatus)) {
        set.status = 400;
        return { success: false, message: 'สถานะที่ใช้กรองไม่ถูกต้อง (active / resolved / revised / all)' };
    }

    const take = Math.min(Math.max(Number(limit) || 500, 1), 1000);

    try {
        const rows = await nurse`
            SELECT p.*, r.label_th AS nanda_label
            FROM nursing_care_plans p
            LEFT JOIN ref_nanda_diagnoses r ON r.code = p.nanda_code
            WHERE p.ward_code = ${ward_code.trim()}
              AND p.is_deleted IS NOT TRUE
              ${onlyStatus === 'all' ? nurse`` : nurse`AND p.status = ${onlyStatus}`}
            ORDER BY p.an, p.start_date DESC NULLS LAST, p.id DESC
            LIMIT ${take}
        `;

        const plans = rows.map(r => sanitizeRow(r as Record<string, unknown>));

        // สรุปต่อผู้ป่วยหนึ่งราย ให้หน้าจอเอาไปแสดงเป็นรายเตียงได้โดยไม่ต้องนับเอง
        const byAn = new Map<string, { an: string; total: number; high: number; plans: unknown[] }>();
        for (const plan of plans) {
            const an = String(plan.an ?? '');
            const bucket = byAn.get(an) ?? { an, total: 0, high: 0, plans: [] };
            bucket.total += 1;
            if (plan.priority === 'high' && plan.status === 'active') bucket.high += 1;
            bucket.plans.push(plan);
            byAn.set(an, bucket);
        }

        return {
            success: true,
            ward_code: ward_code.trim(),
            status: onlyStatus,
            total: plans.length,
            patients: byAn.size,
            data: plans,
            by_patient: Array.from(byAn.values()),
        };
    } catch (error) {
        console.error('Get care plans by ward error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- เพิ่มแผนใหม่ ----------
export const saveCarePlan = async ({ body, set, user }: Context & { user: any }) => {
    const payload = (body ?? {}) as Record<string, unknown>;
    const an = String(payload.an ?? '').trim();

    if (!an) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ an' };
    }
    if (!String(payload.ward_code ?? '').trim()) {
        set.status = 400;
        return { success: false, message: 'กรุณาระบุ ward_code' };
    }

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    const built = await buildValues(payload, actor);
    if (built.error) {
        set.status = 400;
        return { success: false, message: built.error };
    }

    // หอผู้ป่วยยึดตามทะเบียนรับไว้เสมอ ค่าที่หน้าจอส่งมาเป็นแค่ค่าสำรอง
    const ward = await fetchWardOfAN(an);
    if (ward) {
        built.values!.ward_code = ward.code;
        built.values!.ward_name = ward.name ?? built.values!.ward_name ?? null;
    }

    try {
        if (built.values!.status === 'active') {
            const clash = await findActiveDuplicate(an, String(built.values!.nursing_diagnosis), null);
            if (clash) {
                set.status = 409;
                return { success: false, message: duplicateMessage(clash), existing_id: clash.id };
            }
        }

        const saved = await nurse`
            INSERT INTO nursing_care_plans ${nurse({
                an,
                ...built.values!,
                created_at: new Date(),
                created_by: actor.username,
            })}
            RETURNING *
        `;

        return {
            success: true,
            message: 'บันทึกแผนการพยาบาลเรียบร้อยแล้ว',
            data: sanitizeRow(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        // สองคำขอที่เหมือนกันมาถึงพร้อมกัน ตัวที่แพ้มาชนที่ unique index
        if ((error as { code?: string })?.code === '23505') {
            const clash = await findActiveDuplicate(an, String(built.values!.nursing_diagnosis), null);
            set.status = 409;
            return {
                success: false,
                message: clash
                    ? duplicateMessage(clash)
                    : 'ข้อวินิจฉัยนี้มีแผนที่ยังดำเนินการอยู่แล้ว',
                existing_id: clash?.id ?? null,
            };
        }
        console.error('Save care plan error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- แก้ไขแผนเดิม ----------
export const updateCarePlan = async ({ params, body, set, user }: Context & { user: any }) => {
    const { id } = params as { id: string };
    const planId = Number(id);
    const payload = (body ?? {}) as Record<string, unknown>;

    if (!Number.isInteger(planId) || planId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const actor = await resolveActor(user);
    if (!actor) {
        set.status = 401;
        return { success: false, message: 'ไม่พบบัญชีผู้ใช้ที่เข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่' };
    }

    try {
        const current = await nurse`
            SELECT * FROM nursing_care_plans
            WHERE id = ${planId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบแผนการพยาบาลที่ต้องการแก้ไข' };
        }
        const prev = current[0] as Record<string, unknown>;

        // เติมค่าเดิมให้ก่อน หน้าจอส่งมาเฉพาะบางช่อง (เช่นปุ่มปิดแผน) จะได้ไม่ล้างของเดิมทิ้ง
        const merged: Record<string, unknown> = { ...prev, ...payload };
        const built = await buildValues(merged, actor);
        if (built.error) {
            set.status = 400;
            return { success: false, message: built.error };
        }

        // ย้ายหอผู้ป่วยระหว่างนอนโรงพยาบาลได้ ตอนแก้จึงยึดหอปัจจุบันจากทะเบียนรับไว้เหมือนตอนสร้าง
        const ward = await fetchWardOfAN(String(prev.an));
        if (ward) {
            built.values!.ward_code = ward.code;
            built.values!.ward_name = ward.name ?? built.values!.ward_name ?? null;
        }

        if (built.values!.status === 'active') {
            const clash = await findActiveDuplicate(
                String(prev.an), String(built.values!.nursing_diagnosis), planId
            );
            if (clash) {
                set.status = 409;
                return { success: false, message: duplicateMessage(clash), existing_id: clash.id };
            }
        }

        // ไม่ให้แก้ an เพื่อกันแผนย้ายข้ามผู้ป่วยโดยไม่ตั้งใจ
        // ผู้วางแผนคนแรกก็คงไว้ ผู้แก้ไขไปอยู่ที่ updated_by แทน
        const { staff_id: _s, nurse_name: _n, ...values } = built.values!;

        const saved = await nurse`
            UPDATE nursing_care_plans
            SET ${nurse({ ...values, updated_at: new Date(), updated_by: actor.username })}
            WHERE id = ${planId}
            RETURNING *
        `;

        return {
            success: true,
            message: 'แก้ไขแผนการพยาบาลเรียบร้อยแล้ว',
            data: sanitizeRow(saved[0] as Record<string, unknown>),
        };
    } catch (error) {
        if ((error as { code?: string })?.code === '23505') {
            set.status = 409;
            return { success: false, message: 'ข้อวินิจฉัยนี้มีแผนที่ยังดำเนินการอยู่แล้ว' };
        }
        console.error('Update care plan error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ---------- ลบ (soft delete) ----------
export const deleteCarePlan = async ({ params, set, user }: Context & { user: any }) => {
    const { id } = params as { id: string };
    const planId = Number(id);

    if (!Number.isInteger(planId) || planId <= 0) {
        set.status = 400;
        return { success: false, message: 'id ไม่ถูกต้อง' };
    }

    const actor = String(user?.username ?? '') || null;

    try {
        const current = await nurse`
            SELECT id FROM nursing_care_plans
            WHERE id = ${planId} AND is_deleted IS NOT TRUE
        `;
        if (current.length === 0) {
            set.status = 404;
            return { success: false, message: 'ไม่พบแผนการพยาบาลที่ต้องการลบ' };
        }

        // แผนที่มีบันทึกทางการพยาบาลอ้างถึงแล้ว ลบไม่ได้ ไม่งั้นบันทึกจะชี้ไปที่แผนที่หายไป
        // ให้ปิดแผนเป็น resolved / revised แทน ซึ่งเก็บร่องรอยไว้ครบ
        const linked = await nurse`
            SELECT count(*)::int AS n FROM nursing_progress_notes
            WHERE care_plan_id = ${planId} AND is_deleted IS NOT TRUE
        `;
        const used = Number((linked[0] as { n: number }).n);
        if (used > 0) {
            set.status = 409;
            return {
                success: false,
                message: `แผนนี้มีบันทึกทางการพยาบาลอ้างถึงอยู่ ${used} ฉบับ ลบไม่ได้ กรุณาปิดแผนเป็น "บรรลุเป้าหมาย" หรือ "ปรับแผน" แทน`,
            };
        }

        // เก็บแถวไว้เสมอ แค่ทำเครื่องหมายว่าลบ เพื่อการตรวจสอบย้อนหลัง
        await nurse`
            UPDATE nursing_care_plans
            SET is_deleted = TRUE, updated_at = ${new Date()}, updated_by = ${actor}
            WHERE id = ${planId}
        `;

        return { success: true, message: 'ลบแผนการพยาบาลเรียบร้อยแล้ว' };
    } catch (error) {
        console.error('Delete care plan error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
