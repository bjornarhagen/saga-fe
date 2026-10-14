import { writeFile } from 'node:fs/promises';
import { createAuthConfig } from '../src/auth/server.js';

const destination = process.argv[2];
if (!destination || destination === '-') throw new Error('Usage: node scripts/setup-auth.mjs /private/path/auth.json (password on stdin)');
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 2048) throw new Error('Password input is too long.'); }
const password = input.replace(/\r?\n$/, '');
await writeFile(destination, JSON.stringify(createAuthConfig(password)) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Owner authentication configured.');
