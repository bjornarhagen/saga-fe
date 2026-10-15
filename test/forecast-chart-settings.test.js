import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/server/database.js';

test('chart layer preferences survive partial settings saves and exports without changing accounts', t => {
  const store = createStore(); t.after(() => store.close());
  store.createAccount({ name: 'Example reserve', role: 'reserve', balance: 12345, balanceDate: '2026-02-01' });
  const accounts = store.getAccounts();
  const forecastChart = { scopes: ['cash', 'cash-reserve', 'investments'], methods: ['scenario', 'average'], startingGuides: true, fundingLimits: true, points: false };
  store.saveSettings({ forecastChart, methods: ['recent'], incomeGrowth: true, financialView: { growthBps: 100 }, horizon: 6 });
  store.saveSettings({ lookback: 3 });
  assert.deepEqual(store.getSettings().forecastChart, forecastChart);
  assert.deepEqual(store.getSettings().methods, ['recent']);
  assert.equal(store.getSettings().incomeGrowth, true);
  assert.equal(store.getSettings().financialView.growthBps, 100);
  assert.deepEqual(JSON.parse(store.exportLedger().tables.settings[0].value_json).forecastChart, forecastChart);
  assert.deepEqual(store.getAccounts(), accounts);
});

test('invalid chart layers reject atomically and new settings get a quiet default', t => {
  const store = createStore(); t.after(() => store.close());
  store.saveSettings({ forecastChart: {}, horizon: 6 });
  const saved = store.getSettings();
  assert.deepEqual(saved.forecastChart, { scopes: ['cash', 'cash-reserve-investments'], methods: ['scenario'], startingGuides: false, fundingLimits: false, points: true });
  for (const forecastChart of [null, [], { scopes: [] }, { scopes: ['cash', 'cash'] }, { scopes: ['unknown'] }, { methods: [] }, { methods: ['scenario', 'scenario'] }, { methods: ['linear-regression'] }, { fundingLimits: 1 }, { startingGuides: 'yes' }, { unexpected: true }]) {
    assert.throws(() => store.saveSettings({ forecastChart, horizon: 12 }));
    assert.deepEqual(store.getSettings(), saved);
  }
});
