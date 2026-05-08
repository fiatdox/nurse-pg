import { Context } from 'elysia';
import { nurse } from '../db';
import { sanitizeHTML } from '../utils/sanitize';



// ฟังก์ชั่นแสดงรายชื่อหอผู้ป่วย
export const getWardsV1 = async ({ set }: Context) => {
    try {
        const rows = await nurse`SELECT ward, ward_name, his_code, is_labor_room, is_active, general, crisis FROM ward WHERE is_active = 'Y' ORDER BY ward_name ASC`;
        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่อหอผู้ป่วย
            data: rows.map(row => ({
                ...row,
                ward_name: sanitizeHTML(row.ward_name)
            }))
        };
    } catch (error) {
        console.error('Get wards error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

export const getSpclty = async ({ set }: Context) => {
    try {
        const rows = await nurse`SELECT spclty, name FROM spclty WHERE is_active = 'Y' ORDER BY name DESC`;
        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่อหอผู้ป่วย
            data: rows.map(row => ({
                ...row,
                name: sanitizeHTML(row.name)
            }))
        };
    } catch (error) {
        console.error('Get spclty error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

export const getAdmissionType = async ({ set }: Context) => {
    try {
        const rows = await nurse`SELECT admission_type_id, admission_type_name FROM admission_types ORDER BY admission_type_name DESC`;
        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่อหอผู้ป่วย
            data: rows.map(row => ({
                ...row,
                admission_type_name: sanitizeHTML(row.admission_type_name)
            }))
        };
    } catch (error) {
        console.error('Get admission types error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

export const getAdmissionSeverityLV = async ({ set }: Context) => {
    try {
        const rows = await nurse`SELECT severity_level_id, severity_level_name FROM admission_severity_level ORDER BY severity_level_name DESC`;
        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่อหอผู้ป่วย
            data: rows.map(row => ({
                ...row,
                severity_level_name: sanitizeHTML(row.severity_level_name)
            }))
        };
    } catch (error) {
        console.error('Get admission severity levels error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

//ประเภทเวร
export const getAdmissionChangeShiftTypes= async ({ set }: Context) => {
    try {
        const rows = await nurse`select admission_change_shift_type_id,shift_name from admission_change_shift_types`;
        
        return {
            success: true,
            // ป้องกันการโจมตีแบบ XSS โดยการลบแท็ก HTML ออกจากชื่อหอผู้ป่วย
            data: rows.map(row => ({
                ...row,
                shift_name: sanitizeHTML(row.shift_name)
            }))
        };
    } catch (error) {
        console.error('Get admission change shift types error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};

// ระดับการดูแลผู้ป่วยในเวร
export const getAdmissionShiftCareLevels = async ({ set }: Context) => {
    try {
        const rows = await nurse`SELECT admission_shift_care_level_id, name FROM admission_shift_care_levels WHERE is_active = 'Y'`

        return {
            success: true,
            data: rows.map(row => ({
                ...row,
                name: sanitizeHTML(row.name)
            }))
        };
    } catch (error) {
        console.error('Get admission shift care levels error:', error);
        set.status = 500;
        return {
            success: false,
            message: 'Internal Server Error'
        };
    }
};
