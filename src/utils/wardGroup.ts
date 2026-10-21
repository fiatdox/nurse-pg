import { nurse } from '../db';
import { sanitizeHTML } from './sanitize';

/**
 * หอผู้ป่วยที่นับภาระงานรวมเป็นหน่วยเดียวกัน (ward.fte_group)
 *
 * เช่น NICU กับ Nursery ใช้พยาบาลทีมเดียวกัน แค่แยกห้องตามระดับอาการ
 * รายงานภาระงานต้องคิดรวม ไม่งั้นต้องจัดเวรสองที่ และ FTE ทั้งสองฝั่งผิด
 *
 * ส่งรหัส HIS ของหอใดก็ได้ในหน่วยเข้ามา จะได้ทั้งหน่วยกลับไป หอหลักอยู่ตัวแรกเสมอ
 * หอที่ไม่ได้รวมกับใครจะได้หน่วยที่มีสมาชิกตัวเดียว คิวรีจึงเขียนแบบเดียวได้ทุกหอ
 */
export interface WardGroup {
    /** หอหลัก — ค่าน้ำหนักทั่วไป/วิกฤตของหน่วยใช้ของหอนี้ */
    primary: { ward: number; his_code: string; ward_name: string; general: number; crisis: number };
    members: { his_code: string; ward_name: string; bed: number | null }[];
    /** รหัส HIS ของทุกหอในหน่วย ใช้กับ `IN ${nurse(codes)}` */
    codes: string[];
    /** เตียงรวมทั้งหน่วย — null ถ้ามีหอไหนยังไม่ได้บันทึกจำนวนเตียง เพราะผลรวมจะต่ำกว่าจริง */
    bed: number | null;
    /** ชื่อแสดงผล เช่น "Nursery + NICU" */
    label: string;
}

export const wardGroupOf = async (hisCode: string): Promise<WardGroup | null> =>
    (await wardUnits([hisCode]))[0] ?? null;

/**
 * หลายหอพร้อมกัน — ขยายแต่ละหอเป็นหน่วยของมัน แล้วตัดหน่วยซ้ำ
 * เลือก NICU กับ Nursery มาด้วยกันจะได้หน่วยเดียว ไม่ใช่สองหน่วยที่นับคนซ้ำ
 * ไม่ส่งรหัสมา (null) = ทุกหน่วยที่มีหอเปิดใช้งานอยู่
 */
export const wardUnits = async (hisCodes: string[] | null): Promise<WardGroup[]> => {
    if (hisCodes && hisCodes.length === 0) return [];
    const pick = hisCodes ? nurse`his_code IN ${nurse(hisCodes)}` : nurse`is_active = 'Y'`;
    const rows = await nurse`
        WITH heads AS (
            SELECT DISTINCT COALESCE(fte_group, ward) AS head FROM ward WHERE ${pick}
        )
        SELECT w.ward, w.his_code, w.ward_name, w.bed, w.general, w.crisis, h.head
        FROM ward w
        JOIN heads h ON h.head = COALESCE(w.fte_group, w.ward)
        ORDER BY h.head, (w.ward = h.head) DESC, w.ward`;

    const byHead = new Map<number, typeof rows>();
    for (const r of rows) {
        const k = Number(r.head);
        if (!byHead.has(k)) byHead.set(k, [] as unknown as typeof rows);
        byHead.get(k)!.push(r);
    }

    return [...byHead.values()].map(list => {
        const head = list[0];
        const members = list.map(r => ({
            his_code: String(r.his_code),
            ward_name: String(r.ward_name),
            bed: r.bed === null ? null : Number(r.bed),
        }));
        return {
            primary: {
                ward: Number(head.ward),
                his_code: String(head.his_code),
                ward_name: String(head.ward_name),
                general: Number(head.general),
                crisis: Number(head.crisis),
            },
            members,
            codes: members.map(m => m.his_code),
            bed: members.some(m => m.bed === null) ? null : members.reduce((a, m) => a + (m.bed ?? 0), 0),
            label: members.map(m => m.ward_name).join(' + '),
        };
    });
};

/** ข้อมูลหน่วยที่ส่งให้หน้าจอ — หน้าจอใช้บอกผู้ใช้ว่าตัวเลขนี้รวมหอไหนบ้าง */
export const groupInfo = (g: WardGroup) => ({
    primary_code: g.primary.his_code,
    primary_name: sanitizeHTML(g.primary.ward_name),
    label: sanitizeHTML(g.label),
    members: g.members.map(m => ({ his_code: m.his_code, ward_name: sanitizeHTML(m.ward_name) })),
    combined: g.members.length > 1,
});
