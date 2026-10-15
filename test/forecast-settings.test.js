import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeIncomeGrowthSettings } from '../src/lib/forecast-settings.js';
import { settings } from '../src/server/validation.js';
import { createStore } from '../src/server/database.js';

test('shared income growth is optional, strictly boolean, and survives partial settings updates', t => {
  const store = createStore(); t.after(() => store.close());
  store.createAccount({ name: 'Example cash', balance: 10000, balanceDate: '2026-10-01' });
  store.saveOverrides({ example: { excludeForecast: true } });
  const accounts = store.getAccounts(), overrides = store.getOverrides();
  assert.deepEqual(settings({ horizon: 6 }), { horizon: 6 });
  store.saveSettings({ incomeGrowth: true, horizon: 6 });
  store.saveSettings({ lookback: 12 });
  assert.equal(store.getSettings().incomeGrowth, true);
  const original = store.getSettings();
  for (const incomeGrowth of [null, 'true', 0, 1, {}, []]) {
    assert.throws(() => store.saveSettings({ incomeGrowth, horizon: 12 }), /true or false/);
    assert.deepEqual(store.getSettings(), original);
  }
  store.saveSettings({ incomeGrowth: false });
  assert.equal(store.getSettings().incomeGrowth, false);
  assert.equal(store.getSettings().horizon, 6);
  assert.deepEqual(store.getAccounts(), accounts);
  assert.deepEqual(store.getOverrides(), overrides);
});

test('legacy comparison selections become a shared toggle and preserve other settings without mutation', () => {
  const input = { methods: ['average', 'income-trend', 'seasonal'], forecastChart: { methods: ['income-trend', 'scenario'], scopes: ['cash'], points: false }, horizon: 12, assumptions: { income: 10000 } };
  const original = structuredClone(input);
  assert.deepEqual(normalizeIncomeGrowthSettings(input), { ...input, incomeGrowth: true, methods: ['average', 'seasonal'], forecastChart: { ...input.forecastChart, methods: ['scenario'] } });
  assert.deepEqual(input, original);
  assert.deepEqual(normalizeIncomeGrowthSettings({ methods: ['income-trend'], forecastChart: { methods: ['income-trend'] }, incomeGrowth: false }), { methods: [], forecastChart: { methods: ['scenario'] }, incomeGrowth: false });
  assert.deepEqual(normalizeIncomeGrowthSettings({ methods: ['average'], forecastChart: { methods: ['scenario'] } }), { methods: ['average'], forecastChart: { methods: ['scenario'] } });
  assert.deepEqual(settings({ forecastChart: { methods: ['income-trend'] } }).forecastChart.methods, ['scenario']);
  assert.equal(settings({ forecastChart: { methods: ['income-trend'] } }).incomeGrowth, true);
  assert.deepEqual(settings({ methods: ['income-trend', 'recent'], incomeGrowth: false }), { methods: ['recent'], incomeGrowth: false });
});

test('reading legacy stored settings migrates their meaning without rewriting the ledger', t => {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-settings-')), path = join(directory, 'example.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = createStore(path);
  store.createAccount({ name: 'Example reserve', role: 'reserve', balance: 50000, balanceDate: '2026-10-01' });
  store.close();
  const legacy = { methods: ['average', 'income-trend'], forecastChart: { scopes: ['cash'], methods: ['income-trend'] }, fields: { cash: '100.00' } };
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('forecast',?,?)").run(JSON.stringify(legacy), '2026-10-01T00:00:00.000Z');
  db.close();
  store = createStore(path); t.after(() => store.close());
  const before = store.exportLedger();
  const normalized = store.getSettings();
  assert.equal(normalized.incomeGrowth, true);
  assert.deepEqual(normalized.methods, ['average']);
  assert.deepEqual(normalized.forecastChart.methods, ['scenario']);
  assert.equal(normalized.fields.cash, '100.00');
  assert.deepEqual(store.exportLedger().tables, before.tables);
  store.saveSettings({ horizon: 12 });
  assert.equal(store.getSettings().incomeGrowth, true);
  assert.deepEqual(store.getSettings().methods, ['average']);
});
