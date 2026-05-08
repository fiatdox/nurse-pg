import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';

/**
 * CORS Middleware configuration
 * ควรแก้ไข allowedOrigins ให้ตรงกับ domain ของ client ที่อนุญาต
 */
export const corsMiddleware = (app: Elysia) =>
    app.use(
        cors({
            origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:4000'],
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            maxAge: 86400 // 24 hours
        })
    );
