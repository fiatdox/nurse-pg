import { Elysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';

/**
 * An authentication plugin for Elysia.
 * It verifies the JWT from the Authorization header and adds the user payload to the context.
 */
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required for authentication');
}

export const authMiddleware = (app: Elysia) =>
    app.use(
        jwt({
            name: 'jwt',
            secret: process.env.JWT_SECRET!,
            exp: '8h' // กำหนดให้ตรงกัน
        })
    )
    // .derive() adds a new property to the context for this and subsequent handlers.
    // We use it to add a `user` property containing the verified JWT payload.
    .derive(async ({ jwt, headers }) => {
        const auth = headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) {
            return { user: null };
        }
        const token = auth.slice(7);
        try {
            // Properly verify JWT with expiration check enabled
            const userPayload = await jwt.verify(token);
            return {
                user: userPayload as { loginname: string; name: string } | null
            };
        } catch {
            // Token is invalid or expired
            return { user: null };
        }
    })
    // .onBeforeHandle is a hook that runs before the main route handler.
    // We use it to protect routes by checking if a user is authenticated.
    .onBeforeHandle(async ({ user, set }) => {
        // Check if user is authenticated
        if (!user) {
            set.status = 401;
            return { success: false, message: 'Unauthorized' };
        }
    });