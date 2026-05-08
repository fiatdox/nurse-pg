import { Elysia } from 'elysia';

export const securityMiddleware = (app: Elysia) =>
    app.onAfterHandle(({ set, path }) => {
        if (path.startsWith('/docs')) {
            set.headers['X-Content-Type-Options'] = 'nosniff';
            set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
            return;
        }
        set.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none';";
        set.headers['X-Content-Type-Options'] = 'nosniff';
        set.headers['X-Frame-Options'] = 'DENY';
        set.headers['X-XSS-Protection'] = '1; mode=block';
        set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    });