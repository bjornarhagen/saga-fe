import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthConfig, verifyPassword, createSession, verifySession, sessionCookie, allowLoginAttempt, authorityURL, allowedHost, authenticationRequired } from '../src/auth/server.js';

test('raw HTTP Host controls the access boundary even when the adapter URL is loopback', () => {
  const internal = new URL('http://localhost:4321/api/accounts');
  const url = authorityURL(new Request(internal, { headers: { host: 'untrusted.example', 'x-forwarded-host': 'localhost' } }), internal);
  assert.equal(allowedHost(url), false);
  assert.equal(authenticationRequired(url), true);
  const local = authorityURL(new Request(internal, { headers: { host: '127.0.0.1:5187' } }), internal);
  assert.equal(local.origin, 'http://127.0.0.1:5187');
  assert.equal(allowedHost(local), true);
  for (const host of ['user@localhost', 'localhost/path', 'localhost:99999', 'localhost,other']) {
    assert.equal(authorityURL(new Request(internal, { headers: { host } }), internal), null);
  }
});

test('owner password uses independent salted hashes and rejects wrong/oversized passwords', () => {
  const first = createAuthConfig('synthetic-owner-password-only');
  const second = createAuthConfig('synthetic-owner-password-only');
  assert.notEqual(first.password.hash, second.password.hash);
  assert.ok(verifyPassword('synthetic-owner-password-only', first));
  assert.equal(verifyPassword('wrong', first), false);
  assert.equal(verifyPassword('x'.repeat(1025), first), false);
  assert.throws(() => createAuthConfig('short'));
});
test('sessions expire, reject tampering and cannot survive secret rotation', () => {
  const config = createAuthConfig('synthetic-owner-password-only'); const now = 2000000000000;
  const token = createSession(config, now);
  assert.ok(verifySession(token, config, now));
  assert.equal(verifySession(token, config, now + 9 * 3600000), false);
  assert.equal(verifySession(token + 'x', config, now), false);
  assert.equal(verifySession(token, createAuthConfig('synthetic-owner-password-only'), now), false);
  assert.match(sessionCookie(token), /HttpOnly; SameSite=Strict/);
  assert.match(sessionCookie(token), /Secure/);
  assert.match(sessionCookie(''), /Max-Age=0/);
});
test('sign-in attempts are bounded and expire', () => {
  const now = 2000000000000;
  for (let i = 0; i < 5; i++) assert.ok(allowLoginAttempt('synthetic-client', now));
  assert.equal(allowLoginAttempt('synthetic-client', now), false);
  assert.ok(allowLoginAttempt('synthetic-client', now + 16 * 60000));
});
