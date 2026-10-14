import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';

// Audit an exported Git tree before publication. --source skips deliberately
// ignored local state and is only for development; CI uses strict mode.
const root = resolve(process.argv.find(arg => arg.startsWith('--root='))?.slice(7) || '.');
const sourceMode = process.argv.includes('--source');
const generated = new Set(['.git', 'node_modules', '.astro', 'dist']);
const privateDirs = new Set(['.budget-data', 'data', 'secrets', 'backups', 'exports']);
const forbidden = /(?:\.(?:csv|tsv|sqlite(?:-[a-z]+)?|db(?:-[a-z]+)?|dump|bak|pem|key|agekey)$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)[^/]*auth[^/]*\.json$)/i;
const screenshot = /(?:screenshot|preview|capture)[^/]*\.(?:png|jpe?g|webp)$/i;
const failures = [];
let count = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), name = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) { failures.push(`${name}: symlink requires explicit review`); continue; }
    if (entry.isDirectory()) {
      if (generated.has(entry.name)) { if (!sourceMode && entry.name !== '.git') failures.push(`${name}: generated directory in public source tree`); continue; }
      if (privateDirs.has(entry.name)) { if (!sourceMode) failures.push(`${name}: private runtime directory`); continue; }
      await walk(path); continue;
    }
    if (forbidden.test(name) && !name.endsWith('.env.example')) { if (!sourceMode) failures.push(`${name}: private data or credential file`); continue; }
    if (screenshot.test(name)) { failures.push(`${name}: unreviewed screenshot`); continue; }
    const bytes = await readFile(path); count++;
    if (/\.(?:woff2?|png|jpg|jpeg|webp|ico)$/.test(name)) continue;
    if (bytes.includes(0)) { failures.push(`${name}: unexpected binary file`); continue; }
    const text = bytes.toString('utf8');
    if (/\b\d{4}[. ]\d{2}[. ]\d{5}\b|\b\d{11}\b/.test(text)) failures.push(`${name}: possible bank account identifier`);
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:ghp_|github_pat_|tskey-auth-)[A-Za-z0-9_-]{20,}/.test(text)) failures.push(`${name}: possible credential`);
    if (/"sessionKey"\s*:\s*"[A-Za-z0-9_-]{32,}"/.test(text)) failures.push(`${name}: possible owner authentication configuration`);
    if (text.startsWith('SQLite format 3')) failures.push(`${name}: database content`);
  }
}
await walk(root);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error('Privacy audit failed. No matched values were printed.'); process.exitCode = 1;
} else console.log(`Privacy audit passed for ${count} source files${sourceMode ? ' (ignored local state excluded)' : ' (public tree)'}.`);
