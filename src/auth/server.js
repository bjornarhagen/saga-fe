import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const COOKIE_NAME = 'saga_fe_session';
const MAX_SESSION_AGE = 8 * 60 * 60;

export function createAuthConfig(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) throw new Error('Use an owner password between 16 and 1024 characters.');
  const salt = randomBytes(32).toString('hex');
  return { version: 1, password: { salt, hash: scryptSync(password, salt, 64).toString('hex') }, sessionKey: randomBytes(48).toString('base64url') };
}

export async function readAuthConfig() {
  const path = process.env.SAGA_FE_AUTH_FILE;
  if (!path) return null;
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.version !== 1 || !/^[a-f0-9]{64}$/.test(config.password?.salt || '') || !/^[a-f0-9]{128}$/.test(config.password?.hash || '') || !/^[A-Za-z0-9_-]{64}$/.test(config.sessionKey || '')) throw new Error('Owner authentication is not configured correctly.');
  return config;
}

export function verifyPassword(password, config) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) return false;
  const expected = Buffer.from(config.password.hash, 'hex');
  return timingSafeEqual(scryptSync(password, config.password.salt, 64), expected);
}

export function createSession(config, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub: 'owner', exp: Math.floor(now / 1000) + MAX_SESSION_AGE, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return payload + '.' + createHmac('sha256', config.sessionKey).update(payload).digest('base64url');
}

export function verifySession(token, config, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  const expected = createHmac('sha256', config.sessionKey).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    return data.sub === 'owner' && Number.isInteger(data.exp) && data.exp > seconds && data.exp <= seconds + MAX_SESSION_AGE;
  } catch { return false; }
}

export function sessionCookie(token, secure = true) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? MAX_SESSION_AGE : 0}${secure ? '; Secure' : ''}`;
}

export function requestOrigin(url) {
  return process.env.SAGA_FE_PUBLIC_ORIGIN || url.origin;
}

// Astro's standalone adapter can normalize request.url to its internal host.
// Validate the actual HTTP authority; forwarded host headers are not trusted.
export function authorityURL(request, fallbackURL) {
  const host = request.headers.get('host');
  if (!host || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(host)) return null;
  try {
    const authority = new URL(`${fallbackURL.protocol}//${host}`);
    const url = new URL(fallbackURL);
    url.host = authority.host;
    return url;
  } catch { return null; }
}

export function allowedHost(url) {
  if (!url) return false;
  const hosts = ['127.0.0.1', 'localhost', '[::1]', ...(process.env.SAGA_FE_ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean)];
  try { if (process.env.SAGA_FE_PUBLIC_ORIGIN) hosts.push(new URL(process.env.SAGA_FE_PUBLIC_ORIGIN).hostname); } catch { return false; }
  return hosts.includes(url.hostname);
}

export function authenticationRequired(url) {
  return process.env.SAGA_FE_AUTH_REQUIRED === 'true' || !!process.env.SAGA_FE_AUTH_FILE || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

const attempts = new Map();
export function allowLoginAttempt(key, now = Date.now()) {
  for (const [k, entry] of attempts) if (entry.expires <= now) attempts.delete(k);
  let entry = attempts.get(key);
  if (!entry) {
    if (attempts.size >= 1000) return false;
    entry = { count: 0, expires: now + 15 * 60 * 1000 }; attempts.set(key, entry);
  }
  entry.count++;
  return entry.count <= 5;
}
