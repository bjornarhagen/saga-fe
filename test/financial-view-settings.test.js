import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/server/database.js';

test('financial views persist independently of actual values and survive ledger exports', async t => {
  const store = createStore(); t.after(() => store.close());
  store.createAccount({ name: 'Example account', role: 'available', balance: 12345, balanceDate: '2026-02-01' });
  const actual = store.getAccounts();
  const financialView = { view: 'wealth', useReserve: false, assetGroups: ['cash', 'investments'], growthBps: 500, reserveGrowthBps: 0, assetGrowth: { reserve: { source: 'manual', coverage: null, flowKinds: {} }, investments: { source: 'manual', coverage: null, flowKinds: {} } }, reserveContribution: 100, investmentContribution: null };
  store.saveSettings({ financialView, balanceSource: 'latest', assumptions: { income: 10000 } });
  store.saveSettings({ horizon: 12 });
  assert.deepEqual(store.getSettings().financialView, financialView);
  assert.equal(store.getSettings().balanceSource, 'latest');
  assert.equal(store.getSettings().assumptions.income, 10000);
  assert.deepEqual(JSON.parse(store.exportLedger().tables.settings[0].value_json).financialView, financialView);
  assert.deepEqual(store.getAccounts(), actual);
});

test('invalid financial view settings reject atomically and allow explicit zero or automatic allocation', t => {
  const store = createStore(); t.after(() => store.close());
  store.saveSettings({ financialView: { view: 'budget', reserveContribution: 0 }, horizon: 3 });
  const original = store.getSettings();
  for (const financialView of [null, [], { view: 'unknown' }, { useReserve: 1 }, { assetGroups: ['cash', 'cash'] }, { assetGroups: ['debt'] }, { growthBps: 0.5 }, { growthBps: -10001 }, { growthBps: 100001 }, { investmentContribution: -1 }, { reserveContribution: '1' }, { secret: true }]) {
    assert.throws(() => store.saveSettings({ financialView, horizon: 12 }));
    assert.deepEqual(store.getSettings(), original);
  }
  assert.equal(original.financialView.reserveContribution, 0);
  assert.equal(original.financialView.investmentContribution, null);
  store.saveSettings({ financialView: { growthBps: -10000, assetGroups: [] } });
  assert.equal(store.getSettings().financialView.growthBps, -10000);
  assert.deepEqual(store.getSettings().financialView.assetGroups, []);
});
