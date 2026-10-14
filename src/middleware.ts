import { defineMiddleware } from 'astro:middleware';
import { allowedHost, authorityURL, authenticationRequired, COOKIE_NAME, readAuthConfig, requestOrigin, verifySession } from './auth/server.js';

export const onRequest = defineMiddleware(async (context, next) => {
  const requestURL = authorityURL(context.request, context.url);
  if (context.url.pathname !== '/api/health' && !allowedHost(requestURL)) {
    return new Response('Local access only.', { status: 403 });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(context.request.method)) {
    if (!requestURL || context.request.headers.get('origin') !== requestOrigin(requestURL)) return Response.json({ error: 'Request origin is not allowed.' }, { status: 403 });
    if (!context.request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Send JSON data.' }, { status: 415 });
    if (Number(context.request.headers.get('content-length') || 0) > 25 * 1024 * 1024) return Response.json({ error: 'Request is too large.' }, { status: 413 });
  }
  if (!['/api/health', '/login', '/api/session'].includes(context.url.pathname) && authenticationRequired(requestURL)) {
    let config;
    try { config = await readAuthConfig(); } catch { /* Return one non-sensitive setup error below. */ }
    if (!config) return Response.json({ error: 'Owner authentication must be configured before remote access.' }, { status: 503 });
    if (!verifySession(context.cookies.get(COOKIE_NAME)?.value, config)) {
      if (context.url.pathname.startsWith('/api/')) return Response.json({ error: 'Owner sign-in is required.' }, { status: 401 });
      return context.redirect('/login', 303);
    }
  }
  const response = await next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  // Vite needs same-origin WebSockets in development; production does not.
  const connect = import.meta.env.DEV ? "'self' ws://127.0.0.1:* ws://localhost:*" : "'self'";
  response.headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'`);
  return response;
});
