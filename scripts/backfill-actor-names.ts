/**
 * เติมชื่อเต็มของผู้กระทำให้ข้อมูลที่บันทึกไว้ก่อนมีคอลัมน์ชื่อ
 *
 * ข้อมูลเดิมเก็บแต่ username ซึ่งเป็นเลขบัตรประชาชน หน้าจออ่านไม่ออกว่าใคร
 * สคริปต์นี้ค้นชื่อจาก core_kon แล้วเติมย้อนหลัง ไม่แตะแถวที่มีชื่ออยู่แล้ว
 * รันซ้ำได้ปลอดภัย
 *
 *   bun run scripts/backfill-actor-names.ts
 */

import { nurse, core_kon } from '../src/db';

/** งานที่ต้องเติม: ตาราง · คอลัมน์ username · คอลัมน์ชื่อที่จะเติม */
const JOBS: { table: string; from: string; to: string }[] = [
    { table: 'nursing_focus_records', from: 'updated_by', to: 'updated_by_name' },
    { table: 'nursing_focus_records', from: 'cancelled_by', to: 'cancelled_by_name' },
    { table: 'nursing_focus_record_revisions', from: 'changed_by', to: 'changed_by_name' },
    { table: 'care_plan_templates', from: 'created_by', to: 'created_by_name' },
    { table: 'care_plan_templates', from: 'updated_by', to: 'updated_by_name' },
    { table: 'care_plan_template_revisions', from: 'changed_by', to: 'changed_by_name' },
];

/** ชื่อเต็มตาม username — ค้นครั้งเดียวแล้วใช้ซ้ำ คนคนเดียวมักปรากฏหลายแถว */
const cache = new Map<string, string | null>();

const nameOf = async (username: string): Promise<string | null> => {
    if (cache.has(username)) return cache.get(username)!;
    try {
        const rows = await core_kon`
            SELECT CONCAT(pname, fname, ' ', lname) AS employee_name
            FROM users WHERE username = ${username} LIMIT 1
        `;
        const name = String(rows[0]?.employee_name ?? '').trim() || null;
        cache.set(username, name);
        return name;
    } catch (error) {
        console.error(`ค้นชื่อของ ${username} ไม่สำเร็จ:`, error);
        cache.set(username, null);
        return null;
    }
};

let filled = 0, skipped = 0;

for (const job of JOBS) {
    const rows = await nurse.unsafe(
        `SELECT DISTINCT ${job.from} AS username FROM ${job.table}
         WHERE ${job.from} IS NOT NULL AND btrim(${job.from}) <> '' AND ${job.to} IS NULL`
    );

    for (const row of rows) {
        const username = String((row as { username: unknown }).username);
        const name = await nameOf(username);

        // ไม่มีในทะเบียนบุคลากร (เช่น 'seed' ที่สคริปต์ใส่เอง) ปล่อยว่างไว้
        // ดีกว่าเดาชื่อ หน้าจอจะแสดงเป็น "-" ซึ่งตรงความจริงมากกว่า
        if (!name) { skipped++; continue; }

        const done = await nurse.unsafe(
            `UPDATE ${job.table} SET ${job.to} = $1 WHERE ${job.from} = $2 AND ${job.to} IS NULL RETURNING 1`,
            [name, username]
        );
        filled += done.length;
        console.log(`  ${job.table}.${job.to}: ${username} -> ${name} (${done.length} แถว)`);
    }
}

console.log(`\nเติมชื่อแล้ว ${filled} แถว · ไม่พบในทะเบียนบุคลากร ${skipped} บัญชี`);
process.exit(0);
