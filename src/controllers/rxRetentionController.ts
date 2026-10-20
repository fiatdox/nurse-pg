import { Context } from 'elysia';
import { join, resolve, sep } from 'path';
import { unlink } from 'fs/promises';
import { nurse } from '../db';
import { isAdmin } from './systemSettingsController';

/**
 * ระยะเวลาจัดเก็บไฟล์ใบสั่งยา
 *
 * ไฟล์ภาพที่หอสแกนส่งมาเก็บไว้ตามจำนวนวันที่ตั้ง ครบแล้วลบออกจากดิสก์
 * ลบเฉพาะไฟล์ ไม่ลบแถวในฐานข้อมูล ใบสั่งยา ชื่อผู้ป่วย สถานะ และประวัติการเปิดดูยังอยู่ครบ
 * (ใบสั่งยาตัวจริงอยู่ในแฟ้มผู้ป่วยและถูกคีย์ลง HIS แล้ว ภาพนี้เป็นสำเนาที่ใช้ส่งงานเท่านั้น)
 */

export const RETENTION_DEFAULT = 120;

/*
  ขั้นต่ำ 30 วัน กันพิมพ์ผิดเป็น 1 หรือ 0 แล้วไฟล์ทั้งระบบหายในรอบถัดไป
  การลบย้อนกลับไม่ได้ จึงไม่ยอมให้ตั้งค่าที่สั้นจนไม่มีใครทันสังเกต
*/
export const RETENTION_MIN = 30;
export const RETENTION_MAX = 3650;

/**
 * จำนวนวันเก็บไฟล์ ตั้งใน .env ด้วย RX_FILE_RETENTION_DAYS (ไม่ตั้ง = 120)
 *
 * อ่านครั้งเดียวตอนเปิดเซิร์ฟเวอร์ เปลี่ยนค่าแล้วต้อง restart
 * ค่าผิดรูปแบบหรือนอกช่วง ใช้ค่าเริ่มต้นแทนและเตือนใน log
 * ไม่ใช้ค่าที่ผิดไปตรง ๆ เพราะพิมพ์ผิดเป็น 1 แปลว่าไฟล์ทั้งระบบหายในรอบถัดไป
 * และการถอยไปใช้ 120 เป็นทางที่เก็บไฟล์ไว้นานขึ้น ไม่ใช่ลบเร็วขึ้น
 */
const RETENTION_DAYS = (() => {
    const raw = (process.env.RX_FILE_RETENTION_DAYS ?? '').trim();
    if (raw === '') return RETENTION_DEFAULT;
    const d = Number(raw);
    if (Number.isInteger(d) && d >= RETENTION_MIN && d <= RETENTION_MAX) return d;
    console.warn(
        `⚠️  RX_FILE_RETENTION_DAYS="${raw}" ใช้ไม่ได้ (ต้องเป็นจำนวนเต็ม ${RETENTION_MIN}-${RETENTION_MAX}) `
        + `ใช้ค่าเริ่มต้น ${RETENTION_DEFAULT} วันแทน`,
    );
    return RETENTION_DEFAULT;
})();

/** ทุกกี่ชั่วโมงไปไล่ลบ ถี่กว่าวันละครั้งเพื่อให้รอบที่พลาดเพราะ restart ถูกชดเชยเร็ว */
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;
const BATCH = 200;

const UPLOAD_ROOT = resolve(process.env.RX_UPLOAD_DIR || join(process.cwd(), 'uploads', 'rx'));

/* async ไว้เหมือนเดิม ผู้เรียกไม่ต้องเปลี่ยน ถ้าวันหนึ่งย้ายกลับไปเก็บในฐานข้อมูล */
export const retentionDays = async (): Promise<number> => RETENTION_DAYS;

/** ไฟล์ที่ยังไม่ถูกลบและเก่ากว่ากำหนด = จะถูกลบในรอบถัดไป */
const countDue = async (days: number) => {
    const r = await nurse`
        SELECT COUNT(*)::int AS files, COUNT(DISTINCT rx_order_id)::int AS orders,
               COALESCE(SUM(byte_size), 0)::bigint AS bytes
        FROM rx_order_files
        WHERE purged_at IS NULL AND uploaded_at < now() - make_interval(days => ${days})
    `;
    return { files: Number(r[0].files), orders: Number(r[0].orders), bytes: Number(r[0].bytes) };
};

let running = false;
let lastRun: { at: string; files: number; skipped: number } | null = null;

/**
 * ลบไฟล์ที่ครบกำหนด
 *
 * ทีละชุด ลบไฟล์ก่อนแล้วค่อยตั้ง purged_at เพื่อให้ "บันทึกว่าลบแล้ว" ตรงกับดิสก์จริงเสมอ
 * ถ้าเครื่องดับกลางทาง แถวที่ยังไม่ได้ตั้งจะถูกหยิบมาทำใหม่รอบหน้า (ไฟล์ที่หายไปแล้วถือว่าลบสำเร็จ)
 */
export const purgeExpiredRxFiles = async () => {
    if (running) return null;
    running = true;
    let files = 0;
    let skipped = 0;
    try {
        const days = await retentionDays();
        const seen = new Set<string>();
        for (;;) {
            const rows = await nurse`
                SELECT rx_file_id, rx_order_id, stored_path
                FROM rx_order_files
                WHERE purged_at IS NULL AND uploaded_at < now() - make_interval(days => ${days})
                  AND NOT (rx_file_id = ANY(${[...seen].map(Number)}::bigint[]))
                ORDER BY uploaded_at
                LIMIT ${BATCH}
            `;
            if (rows.length === 0) break;

            const done: number[] = [];
            const orders = new Set<string>();
            for (const r of rows) {
                seen.add(String(r.rx_file_id));
                const path = resolve(String(r.stored_path));
                /*
                  ลบเฉพาะไฟล์ที่อยู่ในโฟลเดอร์เก็บใบสั่งยาเท่านั้น
                  ค่าในฐานข้อมูลผิดหรือถูกแก้ ต้องไม่กลายเป็นการลบไฟล์อื่นของเครื่อง
                  ไฟล์ที่อยู่นอกโฟลเดอร์ (เช่นเคยย้าย RX_UPLOAD_DIR) ข้ามไว้ ไม่ตั้งว่าลบแล้ว
                */
                if (!path.startsWith(UPLOAD_ROOT + sep)) { skipped += 1; continue; }
                try {
                    await unlink(path);
                } catch (e) {
                    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                        console.error('Purge rx file failed:', r.rx_file_id, e);
                        skipped += 1;
                        continue;
                    }
                }
                done.push(Number(r.rx_file_id));
                orders.add(String(r.rx_order_id));
            }

            if (done.length > 0) {
                await nurse`UPDATE rx_order_files SET purged_at = now() WHERE rx_file_id = ANY(${done}::bigint[])`;
                files += done.length;
                /* ประวัติของใบบอกด้วยว่าไฟล์หายไปเพราะครบกำหนด ไม่ใช่มีคนลบ */
                for (const orderId of orders) {
                    await nurse`
                        INSERT INTO rx_order_events (rx_order_id, action, actor, actor_name, detail)
                        VALUES (${orderId}, 'purge_files', 'system', 'ระบบ (ครบกำหนดจัดเก็บ)',
                                ${nurse.json({ retention_days: days })})
                    `;
                }
            }
            if (rows.length < BATCH) break;
        }
        lastRun = { at: new Date().toISOString(), files, skipped };
        if (files > 0 || skipped > 0) {
            console.log(`🗑️  rx retention: ลบไฟล์ครบกำหนด ${files} ไฟล์${skipped ? ` · ข้าม ${skipped}` : ''}`);
        }
        return lastRun;
    } catch (error) {
        console.error('Purge rx files error:', error);
        return null;
    } finally {
        running = false;
    }
};

/** เริ่มตัวลบอัตโนมัติ เรียกครั้งเดียวตอนเปิดเซิร์ฟเวอร์ */
export const startRxRetention = () => {
    /* รอให้เซิร์ฟเวอร์ตั้งตัวก่อน ไม่ไปแย่งฐานข้อมูลตอนที่ทุกหน้าจอกำลังเชื่อมต่อกลับเข้ามา */
    setTimeout(() => { void purgeExpiredRxFiles(); }, 60_000);
    setInterval(() => { void purgeExpiredRxFiles(); }, RUN_EVERY_MS);
};

/* ───────────────────────── API ───────────────────────── */

/**
 * ค่าที่ใช้อยู่ ผู้ใช้ทุกคนอ่านได้ (หน้าจอใช้บอกว่าไฟล์เก็บกี่วัน)
 * ส่ง ?days=N มาด้วย = ขอดูว่าถ้าตั้งเป็น N จะมีไฟล์ถูกลบกี่ไฟล์ ใช้ประกอบการตัดสินใจก่อนแก้ .env
 * ค่าจริงเปลี่ยนจากหน้าจอไม่ได้ ต้องแก้ RX_FILE_RETENTION_DAYS แล้ว restart เซิร์ฟเวอร์
 */
export const getRxRetention = async ({ query, user, set }: Context & { user?: unknown }) => {
    try {
        const days = await retentionDays();
        const want = Number((query as { days?: string } | undefined)?.days);
        const preview = Number.isInteger(want) && want >= RETENTION_MIN && want <= RETENTION_MAX ? want : days;
        return {
            success: true,
            data: {
                days,
                min: RETENTION_MIN,
                max: RETENTION_MAX,
                default: RETENTION_DEFAULT,
                source: 'env' as const,
                env_key: 'RX_FILE_RETENTION_DAYS',
                is_admin: await isAdmin(user),
                preview_days: preview,
                due: await countDue(preview),
                last_run: lastRun,
            },
        };
    } catch (error) {
        console.error('Get rx retention error:', error);
        set.status = 500;
        return { success: false, message: 'อ่านค่าตั้งไม่สำเร็จ' };
    }
};
