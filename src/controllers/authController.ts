import { Context } from 'elysia';
import { core_kon, nurse } from '../db';
import { STAFF_TOKEN } from '../middlewares/authMiddleware';
import { OtpSendError, sendStaffOtp } from '../utils/mophPromptOtp';
import {
    CHALLENGE_MAX_FAILED, CHALLENGE_MINUTES, OTP_MAX_ATTEMPTS, OTP_MAX_SENDS, OTP_MINUTES, OTP_RESEND_SECONDS,
    START_MAX_PER_WINDOW, START_WINDOW_MINUTES, STAFF_OTP_PENDING,
    logStaffAuth, newStaffOtp, staffOtpHash, staffOtpMatches, staffOtpRequired, validCid,
} from '../utils/staffOtp';

type Ctx = Context & { jwt: any; server?: { requestIP?: (r: Request) => { address: string } | null } | null };

/** IP และเบราว์เซอร์ของคนที่เรียก — Next ส่งต่อคำขอพร้อม x-forwarded-for */
const clientInfo = ({ request, server }: { request: Request; server?: Ctx['server'] }) => ({
    ip: (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || server?.requestIP?.(request)?.address
        || null)?.slice(0, 64) ?? null,
    user_agent: request.headers.get('user-agent')?.slice(0, 255) ?? null,
});

type StaffRow = {
    id: number; username: string; password: string; id_card: string | null;
    employee_name: string; mission_name: string | null; major_name: string | null; position_name: string | null;
};

const loadUser = async (username: string): Promise<StaffRow | null> => {
    const rows = await core_kon`
        SELECT id,username, password, id_card, CONCAT(pname, fname, ' ', lname) AS employee_name ,m."name" as mission_name,m1."name" as major_name,up.position_name
        FROM users u
        left join missions m on u.mission_id =m.mission_id
        left join majors m1 on u.major_id  =m1.major_id
        left join user_positions up on up.user_position_id =u.user_position_id
        WHERE username = ${username}
    `;
    return (rows[0] as StaffRow | undefined) ?? null;
};

/** ผลเข้าระบบสำเร็จ รูปเดิมทุกประการ หน้าจอเดิมจึงใช้ต่อได้ */
const loginResult = async (jwt: any, user: StaffRow, weak: boolean) => ({
    success: true,
    // ประทับชนิดไว้ใน token เพื่อให้แยกออกจาก token ของบริษัทผู้รับจ้างได้ ดู authMiddleware
    token: await jwt.sign({ username: user.username, typ: STAFF_TOKEN }),
    weak,
    data: {
        id: user.id,
        username: user.username,
        name: user.employee_name,
        mission_name: user.mission_name,
        major_name: user.major_name,
        position_name: user.position_name,
    },
});

/** ส่ง OTP ใหม่ให้ challenge — ส่งก่อนแล้วค่อยบันทึก ถ้าส่งไม่สำเร็จ OTP เดิม (ถ้ามี) ยังใช้ได้ */
const sendFor = async (challengeId: string, username: string, cid: string) => {
    const code = newStaffOtp();
    await sendStaffOtp({ cid, code, minutes: OTP_MINUTES, username });
    await nurse`
        UPDATE staff_login_otp
        SET otp_hash = ${staffOtpHash(challengeId, code)},
            otp_expires_at = now() + make_interval(mins => ${OTP_MINUTES}),
            otp_attempts = 0,
            send_count = send_count + 1,
            last_sent_at = now()
        WHERE challenge_id = ${challengeId}::uuid`;
};

const otpPayload = (otpToken: string) => ({
    success: true,
    otp_required: true,
    otp_token: otpToken,
    destination: 'LINE OA หมอพร้อม',
    expires_in: OTP_MINUTES * 60,
    resend_after: OTP_RESEND_SECONDS,
});

// ───── 1. ชื่อผู้ใช้ + รหัสผ่าน ─────

export const loginCOREKON = async (ctx: Ctx) => {
    const { body, set, jwt } = ctx;
    const { username, password } = body as { username: string; password: string };

    try {
        const user = await loadUser(username);
        if (!user || !(await Bun.password.verify(password, user.password, 'argon2id'))) {
            set.status = 401;
            return { success: false, message: 'Invalid username or password' };
        }
        const weak = password === user.id_card;

        /* โหมด OTP ปิด (ค่าเริ่มต้น) = เข้าระบบแบบเดิมทันที ไม่แตะตาราง OTP เลย */
        if (!(await staffOtpRequired())) return await loginResult(jwt, user, weak);

        const info = clientInfo(ctx);
        const cid = validCid(user.id_card);
        if (!cid) {
            await logStaffAuth({ username: user.username, event: 'otp_no_cid', ...info });
            set.status = 403;
            return {
                success: false, code: 'OTP_NO_CID',
                message: 'บัญชีนี้ไม่มีเลขบัตรประชาชนที่ถูกต้องในระบบ จึงส่ง OTP ทางหมอพร้อมไม่ได้ กรุณาติดต่อผู้ดูแลระบบ',
            };
        }

        const recent = await nurse`
            SELECT COUNT(*)::int AS n FROM staff_login_otp
            WHERE username = ${user.username}
              AND created_at > now() - make_interval(mins => ${START_WINDOW_MINUTES})`;
        if (Number(recent[0]?.n) >= START_MAX_PER_WINDOW) {
            await logStaffAuth({ username: user.username, event: 'otp_rate_limited', ...info });
            set.status = 429;
            return {
                success: false, code: 'OTP_LIMIT',
                message: `ขอ OTP บ่อยเกินไป กรุณารอ ${START_WINDOW_MINUTES} นาทีแล้วลองใหม่`,
            };
        }

        const created = await nurse`
            INSERT INTO staff_login_otp (username, expires_at, ip, user_agent)
            VALUES (${user.username}, now() + make_interval(mins => ${CHALLENGE_MINUTES}), ${info.ip}, ${info.user_agent})
            RETURNING challenge_id`;
        const challengeId = String(created[0].challenge_id);

        try {
            await sendFor(challengeId, user.username, cid);
        } catch (err) {
            const reason = err instanceof OtpSendError ? err.message : 'unexpected';
            console.error('Staff OTP send failed:', reason, err instanceof OtpSendError ? '' : err);
            await nurse`UPDATE staff_login_otp SET closed_at = now(), closed_reason = 'send_failed'
                        WHERE challenge_id = ${challengeId}::uuid`;
            await logStaffAuth({ username: user.username, event: 'otp_send_failed', detail: reason, ...info });
            set.status = 502;
            return {
                success: false, code: 'OTP_SEND_FAILED',
                message: err instanceof OtpSendError
                    ? `ส่งรหัส OTP ไม่สำเร็จ: ${err.message}`
                    : 'ส่งรหัส OTP ไปที่หมอพร้อมไม่สำเร็จ กรุณาตรวจว่าเพิ่มเพื่อน LINE หมอพร้อมและยืนยันตัวตนแล้ว หรือติดต่อผู้ดูแลระบบ',
            };
        }
        await logStaffAuth({ username: user.username, event: 'otp_sent', ...info });

        /* token ขั้นกลาง: ไม่มี typ = staff จึงใช้เรียก API อื่นไม่ได้ ตัวจริงคือ challenge ในฐาน (อายุ 10 นาที ใช้ครั้งเดียว) */
        const otpToken = await jwt.sign({ typ: STAFF_OTP_PENDING, cid: challengeId, username: user.username, weak });
        return otpPayload(otpToken);
    } catch (error) {
        console.error('Login error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ───── ขั้นกลาง: อ่าน challenge จาก otp_token ─────

const PENDING_EXPIRED = {
    success: false, code: 'OTP_SESSION_EXPIRED', message: 'ขั้นตอนเข้าระบบหมดเวลา กรุณาใส่รหัสผ่านใหม่',
};

type Challenge = {
    challenge_id: string; username: string; otp_hash: string | null; otp_expires_at: Date | null;
    otp_attempts: number; total_failed: number; send_count: number; last_sent_at: Date | null;
};

const loadChallenge = async (jwt: any, otpToken: string): Promise<{ c: Challenge; weak: boolean } | null> => {
    const p = await jwt.verify(String(otpToken ?? '')).catch(() => null);
    if (!p || p.typ !== STAFF_OTP_PENDING || typeof p.cid !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.cid)) return null;
    const rows = await nurse`
        SELECT challenge_id::text, username, otp_hash, otp_expires_at, otp_attempts, total_failed, send_count, last_sent_at
        FROM staff_login_otp
        WHERE challenge_id = ${p.cid}::uuid AND username = ${String(p.username ?? '')}
          AND closed_at IS NULL AND expires_at > now()`;
    return rows[0] ? { c: rows[0] as Challenge, weak: p.weak === true } : null;
};

// ───── 2. ขอ OTP ใหม่ ─────

export const resendLoginOtp = async (ctx: Ctx) => {
    const { body, set, jwt } = ctx;
    const { otp_token } = body as { otp_token: string };
    const info = clientInfo(ctx);
    try {
        const got = await loadChallenge(jwt, otp_token);
        if (!got) { set.status = 401; return PENDING_EXPIRED; }
        const { c } = got;

        const sentAt = c.last_sent_at ? new Date(c.last_sent_at).getTime() : 0;
        const wait = Math.ceil((sentAt + OTP_RESEND_SECONDS * 1000 - Date.now()) / 1000);
        if (wait > 0) {
            set.status = 429;
            return { success: false, code: 'OTP_COOLDOWN', retry_after: wait, message: `กรุณารออีก ${wait} วินาทีก่อนขอรหัสใหม่` };
        }
        if (Number(c.send_count) >= OTP_MAX_SENDS) {
            set.status = 429;
            return { success: false, code: 'OTP_LIMIT', message: 'ขอรหัสครบจำนวนแล้ว กรุณาใส่รหัสผ่านเพื่อเริ่มใหม่' };
        }

        const user = await loadUser(c.username);
        const cid = validCid(user?.id_card);
        if (!user || !cid) { set.status = 401; return PENDING_EXPIRED; }

        try {
            await sendFor(c.challenge_id, c.username, cid);
        } catch (err) {
            const reason = err instanceof OtpSendError ? err.message : 'unexpected';
            console.error('Staff OTP resend failed:', reason);
            await logStaffAuth({ username: c.username, event: 'otp_send_failed', detail: reason, ...info });
            set.status = 502;
            return {
                success: false, code: 'OTP_SEND_FAILED',
                message: err instanceof OtpSendError ? `ส่งรหัส OTP ไม่สำเร็จ: ${err.message}` : 'ส่งรหัส OTP ไปที่หมอพร้อมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
            };
        }
        await logStaffAuth({ username: c.username, event: 'otp_sent', detail: 'resend', ...info });
        return { success: true, expires_in: OTP_MINUTES * 60, resend_after: OTP_RESEND_SECONDS };
    } catch (error) {
        console.error('Staff OTP resend error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};

// ───── 3. ตรวจ OTP → token จริง ─────

export const verifyLoginOtp = async (ctx: Ctx) => {
    const { body, set, jwt } = ctx;
    const { otp_token, code } = body as { otp_token: string; code: string };
    const info = clientInfo(ctx);
    try {
        const got = await loadChallenge(jwt, otp_token);
        if (!got) { set.status = 401; return PENDING_EXPIRED; }
        const { c, weak } = got;

        if (!c.otp_hash || !c.otp_expires_at || new Date(c.otp_expires_at) < new Date()) {
            set.status = 400;
            return { success: false, code: 'OTP_EXPIRED', message: 'รหัส OTP หมดอายุแล้ว กรุณากดขอรหัสใหม่' };
        }

        if (!staffOtpMatches(c.challenge_id, String(code ?? '').trim(), c.otp_hash)) {
            const attempts = Number(c.otp_attempts) + 1;
            const total = Number(c.total_failed) + 1;
            const locked = total >= CHALLENGE_MAX_FAILED;
            await nurse`
                UPDATE staff_login_otp
                SET otp_attempts = ${attempts},
                    total_failed = ${total},
                    otp_hash = CASE WHEN ${attempts >= OTP_MAX_ATTEMPTS} THEN NULL ELSE otp_hash END,
                    closed_at = CASE WHEN ${locked} THEN now() ELSE closed_at END,
                    closed_reason = CASE WHEN ${locked} THEN 'too_many_fail' ELSE closed_reason END
                WHERE challenge_id = ${c.challenge_id}::uuid`;
            await logStaffAuth({ username: c.username, event: locked ? 'otp_locked' : 'otp_fail', ...info });
            set.status = locked ? 401 : 400;
            return locked
                ? { success: false, code: 'OTP_SESSION_EXPIRED', message: 'ใส่ OTP ผิดหลายครั้ง กรุณาใส่รหัสผ่านใหม่' }
                : attempts >= OTP_MAX_ATTEMPTS
                    ? { success: false, code: 'OTP_EXPIRED', message: 'ใส่ OTP ผิดครบ 3 ครั้ง รหัสนี้ใช้ไม่ได้แล้ว กรุณากดขอรหัสใหม่' }
                    : { success: false, code: 'OTP_WRONG', message: `รหัส OTP ไม่ถูกต้อง (เหลือ ${OTP_MAX_ATTEMPTS - attempts} ครั้ง)` };
        }

        /* ปิด challenge ก่อนออก token และเช็กว่ายังเปิดอยู่ใน WHERE — สองแท็บกดพร้อมกันได้ token แค่ใบเดียว */
        const closed = await nurse`
            UPDATE staff_login_otp SET closed_at = now(), closed_reason = 'ok', otp_hash = NULL
            WHERE challenge_id = ${c.challenge_id}::uuid AND closed_at IS NULL
            RETURNING 1`;
        if (closed.length === 0) { set.status = 401; return PENDING_EXPIRED; }

        const user = await loadUser(c.username);
        if (!user) { set.status = 401; return PENDING_EXPIRED; }
        await logStaffAuth({ username: c.username, event: 'otp_ok', ...info });
        return await loginResult(jwt, user, weak);
    } catch (error) {
        console.error('Staff OTP verify error:', error);
        set.status = 500;
        return { success: false, message: 'Internal Server Error' };
    }
};
