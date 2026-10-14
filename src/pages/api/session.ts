import type { APIRoute } from 'astro';
import { allowLoginAttempt, createSession, readAuthConfig, requestOrigin, sessionCookie, verifyPassword } from '../../auth/server.js';

export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  if (!allowLoginAttempt(clientAddress || 'owner')) return Response.json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, { status: 429, headers: { 'Retry-After': '900' } });
  try {
    const reader = request.body?.getReader(); let text = '', bytes = 0; const decoder = new TextDecoder();
    if (reader) while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2048) { await reader.cancel(); return Response.json({ error: 'Sign-in unsuccessful.' }, { status: 413 }); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const { password } = JSON.parse(text);
    const config = await readAuthConfig();
    if (!config) return Response.json({ error: 'Owner authentication is not configured.' }, { status: 503 });
    if (!verifyPassword(password, config)) return Response.json({ error: 'Sign-in unsuccessful.' }, { status: 401 });
    return Response.json({ authenticated: true }, { headers: { 'Set-Cookie': sessionCookie(createSession(config), new URL(requestOrigin(url)).protocol === 'https:') } });
  } catch { return Response.json({ error: 'Sign-in unsuccessful.' }, { status: 400 }); }
};

export const DELETE: APIRoute = ({ url }) => Response.json({ authenticated: false }, { headers: { 'Set-Cookie': sessionCookie('', new URL(requestOrigin(url)).protocol === 'https:') } });
