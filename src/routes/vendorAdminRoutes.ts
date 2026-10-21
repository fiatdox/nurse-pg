import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    listVendors,
    saveVendor,
    setVendorFoodTypes,
    createVendorAccount,
    updateVendorIdentity,
    resetVendorCredentials,
    updateVendorAccount,
    getVendorAccountHistory,
} from '../controllers/vendorAdminController';

/**
 * จัดการบริษัทและบัญชีของบริษัท — ฝั่งเจ้าหน้าที่
 *
 * ใช้ authMiddleware (ซึ่งปฏิเสธ token ของบริษัท) แล้วยังตรวจ isAdmin
 * ซ้ำในทุก handler อีกชั้น เพราะการเปิดบัญชีให้คนนอกเป็นการให้สิทธิ์เข้าถึงข้อมูล
 * ถ้าวันหนึ่งมีใครย้าย route นี้ไปไว้ผิดที่ ชั้นที่สองจะยังกันไว้ได้
 */
export const vendorAdminRoutes = new Elysia({ prefix: '/api/v1/vendor-admin' })
    .use(authMiddleware)
    .guard({ detail: { tags: ['Vendor'] } })

    .get('/vendors', listVendors, {
        detail: { summary: 'รายชื่อบริษัท พร้อมบัญชีและประเภทอาหารที่ผูกไว้' }
    })
    .put('/vendor', saveVendor, {
        body: t.Object({
            vendor_id: t.Optional(t.Number()),
            vendor_name: t.String({ minLength: 1, maxLength: 255 }),
            tax_id: t.Optional(t.String({ maxLength: 20 })),
            contact_name: t.Optional(t.String({ maxLength: 150 })),
            contact_tel: t.Optional(t.String({ maxLength: 50 })),
            is_active: t.Optional(t.Boolean()),
        }),
        detail: { summary: 'เพิ่มหรือแก้ไขบริษัท' }
    })
    .put('/food-types', setVendorFoodTypes, {
        body: t.Object({
            vendor_id: t.Number(),
            food_type_ids: t.Array(t.Number()),
        }),
        detail: { summary: 'ผูกประเภทอาหารที่บริษัทรับผิดชอบ ส่งมาทั้งชุด' }
    })
    .post('/account', createVendorAccount, {
        body: t.Object({
            vendor_id: t.Number(),
            username: t.String({ minLength: 4, maxLength: 64 }),
            first_name: t.String({ minLength: 1, maxLength: 100 }),
            last_name: t.String({ minLength: 1, maxLength: 100 }),
            job_title: t.Optional(t.String({ maxLength: 100 })),
            phone: t.String({ minLength: 9, maxLength: 30 }),
            national_id: t.String({ minLength: 13, maxLength: 20 }),
            // ต้องเป็น true เท่านั้น — ผู้ดูแลยืนยันว่าเห็นบัตรประชาชนตัวจริงแล้ว
            identity_checked: t.Literal(true),
        }),
        detail: { summary: 'เปิดบัญชีรายบุคคล ได้รหัสผ่านชั่วคราวกลับไปครั้งเดียว' }
    })
    .put('/account/identity', updateVendorIdentity, {
        body: t.Object({
            vendor_account_id: t.Number(),
            first_name: t.String({ minLength: 1, maxLength: 100 }),
            last_name: t.String({ minLength: 1, maxLength: 100 }),
            job_title: t.Optional(t.String({ maxLength: 100 })),
            phone: t.String({ minLength: 9, maxLength: 30 }),
            // ไม่ส่ง = ไม่เปลี่ยน ยกเว้นบัญชีที่ยังไม่มีเลขบัตรซึ่งต้องกรอก
            national_id: t.Optional(t.String({ maxLength: 20 })),
            identity_checked: t.Literal(true),
        }),
        detail: { summary: 'แก้ไข/กรอกข้อมูลบุคคลและยืนยันตัวตน' }
    })
    .post('/account/reset', resetVendorCredentials, {
        body: t.Object({
            vendor_account_id: t.Number(),
        }),
        detail: { summary: 'ออกรหัสผ่านชั่วคราวใหม่ (ลืมรหัสผ่าน)' }
    })
    .patch('/account', updateVendorAccount, {
        body: t.Object({
            vendor_account_id: t.Number(),
            is_active: t.Optional(t.Boolean()),
            unlock: t.Optional(t.Boolean()),
            revoke_session: t.Optional(t.Boolean()),
        }),
        detail: { summary: 'เปิด/ปิดบัญชี ปลดล็อก หรือตัดการเข้าใช้ที่ค้างอยู่' }
    })
    .get('/account/history', getVendorAccountHistory, {
        query: t.Object({ vendor_account_id: t.Numeric() }),
        detail: { summary: 'ประวัติการเข้าระบบ การจัดการบัญชี และการเรียกใช้ของบัญชีหนึ่ง' }
    });
