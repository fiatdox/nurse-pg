import { Elysia, t } from 'elysia';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
    listVendors,
    saveVendor,
    setVendorFoodTypes,
    createVendorAccount,
    updateVendorAccount,
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
            password: t.String({ minLength: 10, maxLength: 200 }),
            display_name: t.String({ minLength: 1, maxLength: 150 }),
        }),
        detail: { summary: 'เพิ่มบัญชีเข้าระบบให้บริษัท' }
    })
    .patch('/account', updateVendorAccount, {
        body: t.Object({
            vendor_account_id: t.Number(),
            password: t.Optional(t.String({ minLength: 10, maxLength: 200 })),
            display_name: t.Optional(t.String({ maxLength: 150 })),
            is_active: t.Optional(t.Boolean()),
            unlock: t.Optional(t.Boolean()),
        }),
        detail: { summary: 'ตั้งรหัสผ่านใหม่ เปิด/ปิดบัญชี หรือปลดล็อก' }
    });
