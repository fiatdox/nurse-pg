/**
 * การปัดเศษเงินของระบบ
 *
 * ใช้ที่เดียวทุกที่ที่คิดเงิน ถ้าปล่อยให้แต่ละหน้าปัดเศษกันเอง
 * ยอดรวมของสองหน้าที่คิดจากข้อมูลชุดเดียวกันจะไม่ตรงกันทีละสตางค์
 * แล้วไม่มีใครบอกได้ว่าหน้าไหนถูก
 */

/** ทศนิยมของสกุลเงินบาท */
export const MONEY_DECIMALS = 2;

/**
 * ปัดเศษขึ้นเป็นทศนิยมสองตำแหน่ง
 *
 * ปัดขึ้นเสมอเมื่อมีเศษ ไม่ใช่ปัดครึ่งขึ้น เช่น 46.661 ได้ 46.67 ไม่ใช่ 46.66
 *
 * ล้างความคลาดเคลื่อนของเลขทศนิยมฐานสองก่อนปัด เพราะ 46.67 ถูกเก็บจริง
 * เป็น 46.670000000000002 ถ้าปัดขึ้นตรงๆ จะกลายเป็น 46.68
 * ทั้งที่ไม่มีเศษให้ปัด แล้วยอดจะบวมขึ้นทีละสตางค์ทุกบรรทัด
 */
export const roundUpMoney = (value: number, decimals: number = MONEY_DECIMALS): number => {
    if (!Number.isFinite(value)) return 0;
    const factor = 10 ** decimals;
    const scaled = value * factor;
    const cleaned = Math.round(scaled * 1e6) / 1e6;
    return Math.ceil(cleaned) / factor;
};

/** ข้อความจำนวนเงินสำหรับแสดงผล ปัดเศษด้วยกติกาเดียวกันก่อนเสมอ */
export const formatMoney = (value: number, decimals: number = MONEY_DECIMALS): string =>
    roundUpMoney(value, decimals).toLocaleString('th-TH', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
