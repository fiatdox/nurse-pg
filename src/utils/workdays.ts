import { nurse, core_kon } from '../db';

/**
 * วันราชการในช่วงวันที่ = วันทั้งหมด − เสาร์อาทิตย์ − วันหยุดที่ประกาศ
 *
 * ใช้กับช่อง "จำนวนวันราชการเดือนนี้" ของแบบฟอร์ม FTE ทุกงาน
 * วันหยุดที่ตรงกับเสาร์อาทิตย์อยู่แล้วต้องไม่ถูกหักซ้ำ จึงกรองด้วย DOW ในคิวรีเดียวกัน
 * ฐานบุคลากรล่มไม่ควรทำให้ทั้งรายงานพัง ถือว่าไม่มีวันหยุดพิเศษแล้วไปต่อ
 */
export const workdaysBetween = async (from: string, to: string) => {
    const [d] = await nurse`
        SELECT COUNT(*) FILTER (WHERE EXTRACT(DOW FROM g) NOT IN (0, 6))::int AS weekdays
        FROM generate_series(${from}::date, ${to}::date, INTERVAL '1 day') g`;

    let publicHolidays = 0;
    try {
        const [h] = await core_kon`
            SELECT COUNT(*)::int AS n
            FROM core_kon.hr_holidays
            WHERE is_active
              AND holiday_date BETWEEN ${from}::date AND ${to}::date
              AND EXTRACT(DOW FROM holiday_date) NOT IN (0, 6)`;
        publicHolidays = Number(h?.n ?? 0);
    } catch (error) {
        console.error('Workdays: read holidays failed', error);
    }

    return {
        workdays: Math.max(Number(d?.weekdays ?? 0) - publicHolidays, 0),
        public_holidays: publicHolidays,
    };
};

/** วันแรกและวันสุดท้ายของเดือน 'YYYY-MM' เป็น 'YYYY-MM-DD' */
export const monthBounds = (month: string) => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}`, days: last };
};
