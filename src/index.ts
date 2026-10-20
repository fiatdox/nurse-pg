import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { corsMiddleware } from "./middlewares/corsMiddleware";
import { securityMiddleware } from "./middlewares/securityMiddleware";
import { loggerMiddleware } from "./middlewares/loggerMiddleware";
import { authRoutes } from "./routes/authRoutes";
import { icRoutes } from "./routes/icRoutes";
import { systemRoutes } from "./routes/systemRoutes";
import { staffRoutes } from "./routes/staffRoutes";
import { nutritionRoutes } from "./routes/nutritionRoutes";
import { nurseRoutes } from "./routes/nurseRoutes";
import { patientRoutes } from "./routes/patientRoutes";
import { dashboardRoutes } from "./routes/dashboardRoutes";
import { nursingRecordsRoutes } from "./routes/nursingRecordsRoutes";
import { focusTemplateRoutes } from "./routes/focusTemplateRoutes";
import { positionRoutes } from "./routes/positionRoutes";
import { rateRoutes } from "./routes/rateRoutes";
import { wardQuotaRoutes } from "./routes/wardQuotaRoutes";
import { holidayRoutes } from "./routes/holidayRoutes";
import { vendorRoutes } from "./routes/vendorRoutes";
import { rxOrderRoutes } from "./routes/rxOrderRoutes";
import { rxRealtimeRoutes, setRealtimeServer } from "./realtime";
import { startRxRetention } from "./controllers/rxRetentionController";
import { vendorAdminRoutes } from "./routes/vendorAdminRoutes";

const app = new Elysia()
  .use(corsMiddleware)
  .use(securityMiddleware)
  .use(loggerMiddleware)
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "Nurse PG API",
          version: "1.0.50",
        },
        tags: [
          { name: "Auth", description: "Authentication endpoints" },
          { name: "IC (Infection Control)", description: "Infection Control endpoints" },
          { name: "System", description: "System endpoints" },
          { name: "Staff", description: "Staff management endpoints" },
          { name: "Nutrition", description: "Nutrition / food order endpoints" },
          { name: "Nurse", description: "Nurse schedule / FTE endpoints" },
          { name: "Patient", description: "Patient admission / discharge / shift endpoints" },
          { name: "Dashboard", description: "IPD dashboard aggregation endpoints" },
          { name: "Nursing Records", description: "Nursing documentation endpoints" },
          { name: "Care Plan Templates", description: "Focus list / CNPG template management" },
          { name: "Positions", description: "จับคู่ตำแหน่งบุคลากรเข้ากลุ่มเพื่อคิดค่าตอบแทน" },
          { name: "Rates", description: "อัตราค่าตอบแทนต่อเวร แยกตามกลุ่มตำแหน่ง" },
          { name: "Ward Quotas", description: "อัตรากำลังต่อเวร แยกตามหอผู้ป่วยและกลุ่มตำแหน่ง" },
          { name: "Holidays", description: "วันหยุดขององค์กร (ไม่รวมเสาร์–อาทิตย์)" },
          { name: "Vendor", description: "บริษัทผู้รับจ้างทำอาหาร เข้าดูยอดของตัวเอง บัญชีแยกจากเจ้าหน้าที่" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    })
  )
  .use(authRoutes)
  .use(icRoutes)
  .use(systemRoutes)
  .use(staffRoutes)
  .use(nutritionRoutes)
  .use(nurseRoutes)
  .use(patientRoutes)
  .use(dashboardRoutes)
  .use(nursingRecordsRoutes)
  .use(focusTemplateRoutes)
  .use(positionRoutes)
  .use(rateRoutes)
  .use(wardQuotaRoutes)
  .use(holidayRoutes)
  .use(rxOrderRoutes)
  .use(vendorRoutes)
  .use(vendorAdminRoutes)

  /*
    WebSocket ใช้พอร์ตเดียวกับ API ไม่เปิดพอร์ตที่สอง
    จะได้ไม่ต้องขอเปิดไฟร์วอลล์เพิ่ม และอยู่โดเมนเดียวกับ REST ทั้งหมด
  */
  .use(rxRealtimeRoutes)

  .listen(4000);

/* ตัวเซิร์ฟเวอร์ใช้ส่งข้อความจากนอก handler เช่นตอนบันทึกใบสั่งยาเสร็จใน REST */
setRealtimeServer(app.server);

/* ลบไฟล์ภาพใบสั่งยาที่เก็บครบกำหนด (ค่าตั้งใน system_settings) รอบแรกหลังเปิดเครื่อง 1 นาที แล้วทุก 6 ชั่วโมง */
startRxRetention();

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
