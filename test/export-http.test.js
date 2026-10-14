import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/server/database.js';
import { createExportResponse } from '../src/server/export.js';

const request = (format, options) => new Request(`http://localhost/api/export${format === undefined ? '' : `?format=${format}`}`, options);
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'saga-fe-export-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const fakeSnapshot = { backup: destination => writeFile(destination, Buffer.alloc(256 * 1024, 1)) };

test('JSON downloads preserve the versioned archive and use private attachment headers', async () => {
  const archive = { format: 'saga-fe-ledger', formatVersion: 1, tables: { accounts: [{ id: 'synthetic', balance: 105 }] } };
  const response = await createExportResponse({ request: request(), store: { exportLedger: () => archive } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Disposition'), /^attachment; filename="saga-fe-ledger-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.deepEqual(await response.json(), archive);
});

test('invalid formats and HEAD requests do not open the database or create snapshots', async () => {
  const store = () => { throw new Error('Store should not be opened.'); };
  assert.equal((await createExportResponse({ request: request('csv'), store })).status, 400);
  assert.equal((await createExportResponse({ request: request(''), store })).status, 400);
  for (const format of ['json', 'sqlite']) {
    const response = await createExportResponse({ request: request(format, { method: 'HEAD' }), store });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.match(response.headers.get('Content-Disposition'), new RegExp(`\\.${format}"$`));
  }
});

test('SQLite downloads are consistent online snapshots and remove private temporary files', async t => {
  const root = await temporary(t);
  const store = createStore();
  t.after(() => store.close());
  const account = store.createAccount({ name: 'Synthetic export account', balance: 105, balanceDate: '2026-10-14' }).account;
  let snapshot;
  const response = await createExportResponse({ request: request('sqlite'), store: { backup: async destination => { snapshot = destination; await store.backup(destination); } } }, { temporaryRoot: root });
  assert.equal(response.status, 200);
  assert.equal((await stat(dirname(snapshot))).mode & 0o777, 0o700);
  assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
  store.updateAccount({ id: account.id, balance: 106, balanceDate: '2026-10-14' });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(Number(response.headers.get('Content-Length')), bytes.byteLength);
  assert.deepEqual(await readdir(root), []);
  const restoredPath = join(root, 'synthetic-restored.sqlite');
  await writeFile(restoredPath, bytes, { mode: 0o600 });
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  t.after(() => restored.close());
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(restored.prepare('SELECT amount FROM balance_snapshots WHERE account_id=?').get(account.id).amount, 105);
  assert.equal(store.getAccounts().accounts[0].balance, 106);
});

test('slow SQLite downloads bound concurrency and cancellation releases their snapshot', async t => {
  const root = await temporary(t);
  const first = await createExportResponse({ request: request('sqlite'), store: fakeSnapshot }, { temporaryRoot: root });
  const second = await createExportResponse({ request: request('sqlite'), store: fakeSnapshot }, { temporaryRoot: root });
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('Retry-After'), '5');
  const reader = first.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 64 * 1024);
  await reader.cancel();
  assert.deepEqual(await readdir(root), []);
  const retry = await createExportResponse({ request: request('sqlite'), store: fakeSnapshot }, { temporaryRoot: root });
  assert.equal(retry.status, 200);
  await retry.body.cancel();
  assert.deepEqual(await readdir(root), []);
});

test('aborting during backup waits for native work then removes its private snapshot', async t => {
  const root = await temporary(t);
  const controller = new AbortController();
  let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  const pending = createExportResponse({ request: request('sqlite', { signal: controller.signal }), store: {
    backup: async destination => { began(); await new Promise(resolve => { finish = resolve; }); await writeFile(destination, 'synthetic incomplete snapshot'); },
  } }, { temporaryRoot: root });
  await started;
  controller.abort();
  finish();
  assert.equal((await pending).status, 499);
  assert.deepEqual(await readdir(root), []);
});

test('aborting a response stream cleans up and backup failures expose no private details', async t => {
  const root = await temporary(t);
  const controller = new AbortController();
  const response = await createExportResponse({ request: request('sqlite', { signal: controller.signal }), store: fakeSnapshot }, { temporaryRoot: root });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), /cancelled/);
  // Cleanup closes an in-flight read before removing its directory.
  for (let attempt = 0; attempt < 100 && (await readdir(root)).length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await readdir(root), []);
  const failed = await createExportResponse({ request: request('sqlite'), store: { backup: async destination => { await writeFile(destination, 'synthetic'); throw new Error('synthetic-private-marker'); } } }, { temporaryRoot: root });
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes('synthetic-private-marker'), false);
  assert.deepEqual(await readdir(root), []);
  const jsonFailure = await createExportResponse({ request: request('json'), store: { exportLedger() { throw new Error('synthetic-private-marker'); } } });
  assert.equal(jsonFailure.status, 500);
  assert.equal((await jsonFailure.text()).includes('synthetic-private-marker'), false);
});
