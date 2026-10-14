import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/database.js';

function memory(t) { const store = createStore(); t.after(() => store.close()); return store; }
test('empty database preserves unknown balances and unsaved settings', t => {
  const store = memory(t);
  assert.equal(store.getSettings(), null);
  const data = store.getTransactions();
  assert.equal(data.metadata.rows, 0);
  assert.equal(data.metadata.firstDate, null);
  assert.equal(data.metadata.lastDate, null);
  const created = store.createAccount({ name: 'Everyday', role: 'available' });
  assert.equal(created.account.balance, null);
  assert.equal(created.totals.hasBalances, false);
  assert.equal(created.totals.missingAvailable, 1);
  assert.equal(created.totals.missingReserve, 0);
});
test('account balances stay exact with dated snapshots and separate roles', t => {
  const store = memory(t);
  const cash = store.createAccount({ name: 'Everyday', balance: 105, balanceDate: '2026-10-14' }).account;
  const reserve = store.createAccount({ name: 'Reserve', role: 'reserve', balance: 20000, balanceDate: '2026-10-14' }).account;
  store.createAccount({ name: 'Retirement', role: 'excluded', balance: 900000, balanceDate: '2026-10-14' });
  let result = store.updateAccount({ id: cash.id, balance: -1, balanceDate: '2026-10-15' });
  assert.equal(result.totals.available, -1);
  assert.equal(result.totals.reserve, 20000);
  assert.deepEqual(result.totals.balanceDates, ['2026-10-14', '2026-10-15']);
  store.updateAccount({ id: cash.id, balance: 999, balanceDate: '2026-10-01' });
  assert.equal(store.getAccounts().totals.available, -1);
  result = store.updateAccount({ id: reserve.id, balance: null, balanceDate: '2026-10-15' });
  assert.equal(result.totals.reserve, 0);
  assert.equal(result.totals.missingReserve, 1);
  assert.equal(result.accounts.find(account => account.id === reserve.id).balance, null);
  assert.throws(() => store.updateAccount({ id: cash.id, balance: 1.05 }), /integer/);
  assert.throws(() => store.updateAccount({ id: cash.id, balance: Number.MAX_SAFE_INTEGER + 1 }), /integer/);
  assert.throws(() => store.updateAccount({ id: cash.id, balance: 1, balanceDate: '2026-02-30' }), /date/);
});
test('settings and orphaned legacy overrides are validated and survive reopening', t => {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-test-')); const path = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = createStore(path);
  store.saveSettings({ fields: { cash: '1.05', 'balance-date': '2026-10-14' }, assumptions: { income: 300000 }, horizon: 3 });
  store.saveSettings({ fields: { savings: '0' }, lookback: 6 });
  store.saveOverrides({ 'legacy-0': { kind: 'saving', category: 'Reserve', excludeForecast: true } });
  store.close(); store = createStore(path); t.after(() => store.close());
  assert.equal(store.getSettings().fields.cash, '1.05');
  assert.equal(store.getSettings().fields.savings, '0');
  assert.equal(store.getSettings().lookback, 6);
  assert.equal(store.getSettings().balanceSource, 'manual');
  store.saveSettings({ balanceSource: 'accounts' });
  assert.equal(store.getSettings().balanceSource, 'accounts');
  assert.throws(() => store.saveSettings({ balanceSource: 'invalid' }), /Balance source/);
  assert.equal(store.getOverrides()['legacy-0'].kind, 'saving');
  assert.throws(() => store.saveOverrides({ id: { amount: 1 } }), /Unknown/);
  assert.throws(() => store.saveSettings({ horizon: 0 }), /range/);
  assert.throws(() => store.saveSettings({ assumptions: { income: NaN } }), /integer/);
  assert.throws(() => store.saveSettings({ fields: { cash: 'Infinity' } }), /valid/);
  store.saveOverrides({}); assert.deepEqual(store.getOverrides(), {});
});
test('failed account update rolls back all fields and exact total overflow is rejected', t => {
  const store = memory(t);
  const first = store.createAccount({ name: 'First', balance: Number.MAX_SAFE_INTEGER, balanceDate: '2026-10-14' }).account;
  assert.throws(() => store.createAccount({ name: 'Overflow', balance: 1 }), /exact/);
  assert.equal(store.getAccounts().accounts.length, 1);
  assert.throws(() => store.updateAccount({ id: first.id, name: 'Changed', role: 'invalid' }), /role/);
  assert.equal(store.getAccounts().accounts[0].name, 'First');
});

test('online backup includes committed WAL data and can be opened independently', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-backup-test-')); const sourcePath = join(directory, 'source.sqlite'), backupPath = join(directory, 'backup.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore(sourcePath); t.after(() => store.close());
  store.createAccount({ name: 'WAL account', balance: 105, balanceDate: '2026-10-14' });
  await store.backup(backupPath);
  const restored = createStore(backupPath); t.after(() => restored.close());
  assert.equal(restored.getAccounts().accounts[0].balance, 105);
  store.createAccount({ name: 'Later account' });
  assert.equal(restored.getAccounts().accounts.length, 1);
});

test('overdraft cash is supported while savings and buffer amounts stay nonnegative', t => {
  const store = memory(t);
  store.saveSettings({ fields: { cash: '-123.45', savings: '0', adjustment: '-50' } });
  assert.equal(store.getSettings().fields.cash, '-123.45');
  for (const field of ['savings', 'buffer', 'one-off']) assert.throws(() => store.saveSettings({ fields: { [field]: '-0.01' } }), /negative/);
});
test('role totals remain exact across extreme positive and negative balances', t => {
  const store = memory(t);
  store.ingest({ adapter: 'canonical-v1', data: { accounts: [
    { externalId: 'large-positive', name: 'Large positive', balance: Number.MAX_SAFE_INTEGER, balanceDate: '2026-10-14' },
    { externalId: 'small-positive', name: 'Small positive', balance: 2, balanceDate: '2026-10-14' },
    { externalId: 'small-negative', name: 'Small negative', balance: -2, balanceDate: '2026-10-14' }
  ] } });
  assert.equal(store.getAccounts().totals.available, Number.MAX_SAFE_INTEGER);
});
