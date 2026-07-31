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

  .listen(4000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
