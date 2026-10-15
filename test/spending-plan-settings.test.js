import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/database.js';

const plan = accountId => ({ accountId, category: 'Example furnishings', monthlySpending: null, monthlyFunding: 0, topUps: [], reviewAtBalance: null });

test('spending plans survive reopening, partial settings saves and both ledger exports without changing actuals', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-pot-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  let store = createStore(path);
  const account = store.createAccount({ name: 'Example furnishings pot', accountType: 'savings', role: 'available', balance: 10005, balanceDate: '2026-01-31' }).account;
  const plans = [{ ...plan(account.id), monthlySpending: 2000, monthlyFunding: 100, topUps: [{ date: '2026-03-01', amount: 505 }], reviewAtBalance: 2000 }];
  store.saveSettings({ fields: { cash: '100.05', 'balance-date': '2026-01-31' }, assumptions: { expense: 500 }, spendingPlans: plans, expensePlanCategories: [plans[0].category] });
  store.saveOverrides({ synthetic: { category: 'Example one-off', excludeForecast: true } });
  store.saveSettings({ horizon: 12, fields: { buffer: '0' } });
  const actuals = store.getAccounts();
  store.close();
  store = createStore(path); t.after(() => store.close());
  assert.deepEqual(store.getSettings().spendingPlans, plans);
  assert.deepEqual(store.getSettings().expensePlanCategories, [plans[0].category]);
  assert.equal(store.getSettings().fields.cash, '100.05');
  assert.equal(store.getSettings().fields.buffer, '0');
  assert.equal(store.getSettings().assumptions.expense, 500);
  assert.equal(store.getSettings().horizon, 12);
  assert.deepEqual(store.getAccounts(), actuals);
  assert.equal(store.getOverrides().synthetic.excludeForecast, true);
  const archiveSettings = JSON.parse(store.exportLedger().tables.settings[0].value_json);
  assert.deepEqual(archiveSettings.spendingPlans, plans);
  assert.deepEqual(archiveSettings.expensePlanCategories, [plans[0].category]);
  const backup = join(directory, 'backup.sqlite');
  await store.backup(backup);
  const restored = createStore(backup); t.after(() => restored.close());
  assert.deepEqual(restored.getSettings().spendingPlans, plans);
  assert.deepEqual(restored.getSettings().expensePlanCategories, [plans[0].category]);
  assert.deepEqual(restored.getAccounts(), actuals);
  store.saveSettings({ spendingPlans: [] });
  assert.deepEqual(store.getSettings().spendingPlans, []);
  assert.deepEqual(store.getAccounts(), actuals);
  assert.equal(store.getOverrides().synthetic.category, 'Example one-off');
});

test('invalid spending plans reject atomically without replacing saved plans or other settings', t => {
  const store = createStore(); t.after(() => store.close());
  const account = store.createAccount({ name: 'Example pot' }).account;
  const original = plan(account.id);
  store.saveSettings({ horizon: 3, spendingPlans: [original] });
  const invalid = [
    null, {}, [null], [{ ...original, accountId: 'missing-account' }],
    [{ ...original, category: '' }], [{ ...original, monthlySpending: -1 }],
    [{ ...original, monthlySpending: 1.5 }], [{ ...original, monthlySpending: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...original, monthlyFunding: -1 }], [{ ...original, monthlyFunding: '100' }],
    [{ ...original, reviewAtBalance: -1 }], [{ ...original, unexpected: true }],
    [{ ...original, topUps: [{ date: '2026-02-30', amount: 100 }] }],
    [{ ...original, topUps: [{ date: '2026-02-01', amount: 0 }] }],
    [{ ...original, topUps: [{ date: '2026-02-01', amount: 100, bankTransfer: true }] }],
    [original, { ...original, category: 'Another category' }],
  ];
  for (const spendingPlans of invalid) {
    assert.throws(() => store.saveSettings({ horizon: 12, spendingPlans }));
    assert.equal(store.getSettings().horizon, 3);
    assert.deepEqual(store.getSettings().spendingPlans, [original]);
  }
  const another = store.createAccount({ name: 'Another pot' }).account;
  assert.throws(() => store.saveSettings({ spendingPlans: [original, { ...plan(another.id), category: 'EXAMPLE FURNISHINGS' }] }), /only one/);
  store.saveSettings({ spendingPlans: [{ accountId: account.id, category: 'Defaults' }] });
  assert.deepEqual(store.getSettings().spendingPlans, [{ ...plan(account.id), category: 'Defaults' }]);
  for (const expensePlanCategories of [null, 'Example', [''], ['Example', 'EXAMPLE']]) assert.throws(() => store.saveSettings({ expensePlanCategories }));
});
