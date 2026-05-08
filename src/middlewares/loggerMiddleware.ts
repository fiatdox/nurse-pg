import { Elysia } from 'elysia';
import { appendFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_DIR = 'logs';
const LOG_RETENTION_DAYS = 45; // ลบ logs ที่เก่ากว่า 45 วัน

/**
 * สร้างชื่อไฟล์ log ตามวันที่ (เช่น access-2026-03-27.log)
 */
const getLogFileName = (): string => {
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    return join(LOG_DIR, `access-${date}.log`);
};

/**
 * ลบ log files ที่เก่ากว่า 45 วัน
 */
const cleanupOldLogs = async () => {
    try {
        const files = await readdir(LOG_DIR);
        const now = Date.now();
        const cutoffTime = now - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

        for (const file of files) {
            if (!file.startsWith('access-') || !file.endsWith('.log')) continue;

            // Extract date from filename: access-2026-03-27.log
            const dateMatch = file.match(/access-(\d{4}-\d{2}-\d{2})\.log/);
            if (!dateMatch) continue;

            const fileDate = new Date(dateMatch[1]);
            if (fileDate.getTime() < cutoffTime) {
                const filePath = join(LOG_DIR, file);
                await unlink(filePath);
                console.log(`🗑️ ลบ log เก่า: ${file}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up old logs:', error);
    }
};

// เรียก cleanup เมื่อแอปเริ่มต้น
cleanupOldLogs();

// เรียก cleanup ทุก 24 ชั่วโมง
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

// สร้างโฟลเดอร์สำหรับเก็บ Log ถ้ายังไม่มี
await mkdir(LOG_DIR, { recursive: true }).catch(() => {});

const colorMethod = (method: string) => {
    switch (method) {
        case 'GET':
            return `\x1b[32m${method}\x1b[0m`; // Green
        case 'POST':
            return `\x1b[34m${method}\x1b[0m`; // Blue
        case 'PUT':
            return `\x1b[33m${method}\x1b[0m`; // Yellow
        case 'DELETE':
            return `\x1b[31m${method}\x1b[0m`; // Red
        case 'PATCH':
            return `\x1b[35m${method}\x1b[0m`; // Magenta
        default:
            return method;
    }
};

const colorStatus = (status: number | string | undefined) => {
    if (!status) return '\x1b[37mN/A\x1b[0m'; // White for N/A
    const s = status.toString();
    if (typeof status === 'number') {
        if (status >= 500) return `\x1b[31m${s}\x1b[0m`; // Red
        if (status >= 400) return `\x1b[33m${s}\x1b[0m`; // Yellow
        if (status >= 300) return `\x1b[36m${s}\x1b[0m`; // Cyan
        if (status >= 200) return `\x1b[32m${s}\x1b[0m`; // Green
    }
    return `\x1b[37m${s}\x1b[0m`; // White for others
};

export const loggerMiddleware = (app: Elysia) =>
    app
        .derive({ as: 'global' }, () => ({ requestStart: Date.now() }))
        .onAfterHandle(async (ctx) => {
            const { request, set, server, requestStart } = ctx;
            const duration = Date.now() - requestStart;
            const clientIP = server?.requestIP(request)?.address || 'unknown';
            const method = request.method;
            const coloredMethod = colorMethod(method);
            const methodPadding = 6;
            const coloredMethodPadded = coloredMethod + ' '.repeat(Math.max(0, methodPadding - method.length));

            // ดึง Query Params มารวมกับ Path เพื่อให้เห็นข้อมูลครบถ้วน (เช่น ?ward=01)
            const url = new URL(request.url);
            const fullPath = url.pathname + url.search;
            
            // ดึง loginname จาก JWT token โดย decode payload (ไม่ verify — ใช้แค่ logging)
            let userId = '-';
            const authHeader = request.headers.get('authorization');
            if (authHeader?.startsWith('Bearer ')) {
                try {
                    const payload = JSON.parse(atob(authHeader.slice(7).split('.')[1]));
                    userId = payload?.username || payload?.loginname || '-';
                } catch { /* token malformed — ปล่อยเป็น '-' */ }
            }
            
            // เพิ่ม User Agent และ Referer
            const userAgent = request.headers.get('user-agent') || '-';
            const referer = request.headers.get('referer') || '-';

            console.log(`${clientIP.padEnd(15)} | ${userId.padEnd(10)} | ${coloredMethodPadded} | ${fullPath.padEnd(30)} | ${`${duration}ms`.padEnd(8)} | ${colorStatus(set.status)}`);

            // บันทึกลงไฟล์ (File Log) - ตัดสีออกและเพิ่ม Timestamp
            const timestamp = new Date().toISOString();
            const status = set.status ? set.status.toString() : 'N/A';
            // เพิ่ม Referer และ User Agent ลงในไฟล์ Log (Format คล้าย Combined Log Format)
            const fileLogMessage = `${timestamp} | ${clientIP.padEnd(15)} | ${userId.padEnd(10)} | ${method.padEnd(6)} | ${fullPath.padEnd(30)} | ${`${duration}ms`.padEnd(8)} | ${status} | "${referer}" | "${userAgent}"\n`;

            try {
                const logFile = getLogFileName();
                await appendFile(logFile, fileLogMessage);
            } catch (error) {
                console.error('Error writing to log file:', error);
            }
        });