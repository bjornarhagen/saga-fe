import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/database.js';
import { growthReview } from '../src/lib/organic-growth.js';

const defaults = () => ({ reserve: { source: 'manual', coverage: null, flowKinds: {} }, investments: { source: 'manual', coverage: null, flowKinds: {} } });
const confirmed = { complete: true, from: '2026-01-01', to: '2027-01-01', accountIds: ['example-investment'] };

test('asset growth settings default to manual flat values while preserving legacy investment assumptions', t => {
  const store = createStore(); t.after(() => store.close());
  store.saveSettings({ financialView: { growthBps: 500 } });
  assert.equal(store.getSettings().financialView.growthBps, 500);
  assert.equal(store.getSettings().financialView.reserveGrowthBps, 0);
  assert.deepEqual(store.getSettings().financialView.assetGrowth, defaults());
  store.saveSettings({ financialView: { reserveGrowthBps: -10000, assetGrowth: { investments: { source: 'history', coverage: confirmed, flowKinds: { 'example-capital': 'capital', 'example-interest': 'return' } } } } });
  const saved = store.getSettings().financialView;
  assert.equal(saved.reserveGrowthBps, -10000);
  assert.deepEqual(saved.assetGrowth.reserve, defaults().reserve);
  assert.deepEqual(saved.assetGrowth.investments.coverage, confirmed);
  assert.deepEqual(saved.assetGrowth.investments.flowKinds, { 'example-capital': 'capital', 'example-interest': 'return' });
});

test('reviewed asset growth survives unrelated saves, reopen, ledger export and a SQLite backup without changing actuals', async t => {
  const root = mkdtempSync(join(tmpdir(), 'saga-fe-growth-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.sqlite'), backup = join(root, 'backup.sqlite');
  let store = createStore(path);
  store.createAccount({ name: 'Example investments', accountType: 'investment', balance: 12345, balanceDate: '2026-01-01' });
  const actuals = store.getAccounts();
  store.saveSettings({ horizon: 3, financialView: { growthBps: 650, reserveGrowthBps: 275, assetGrowth: { investments: { source: 'history', coverage: confirmed, flowKinds: { 'example-interest': 'return' } } } } });
  const financialView = store.getSettings().financialView;
  store.saveSettings({ horizon: 12, assumptions: { income: 12345 } });
  assert.deepEqual(store.getSettings().financialView, financialView);
  assert.deepEqual(JSON.parse(store.exportLedger().tables.settings[0].value_json).financialView, financialView);
  await store.backup(backup); store.close();
  for (const file of [path, backup]) {
    store = createStore(file);
    assert.deepEqual(store.getSettings().financialView, financialView);
    assert.deepEqual(store.getAccounts(), actuals);
    store.close();
  }
});

test('invalid growth settings and classification bounds reject atomically', t => {
  const store = createStore(); t.after(() => store.close());
  store.saveSettings({ financialView: { reserveGrowthBps: 100 }, horizon: 3 });
  const original = store.getSettings();
  const invalidOptions = [null, [], { secret: true }, { source: null }, { source: 'automatic' }, { coverage: false }, { coverage: { ...confirmed, complete: false } }, { coverage: { ...confirmed, to: confirmed.from } }, { coverage: { ...confirmed, from: '2026-02-30' } }, { coverage: { ...confirmed, accountIds: [] } }, { coverage: { ...confirmed, accountIds: ['same', 'same'] } }, { coverage: { ...confirmed, accountIds: ['x'.repeat(201)] } }, { coverage: { ...confirmed, secret: true } }, { flowKinds: null }, { flowKinds: [] }, { flowKinds: { sample: 'income' } }, { flowKinds: { ' padded ': 'capital' } }, { flowKinds: { ['x'.repeat(201)]: 'capital' } }, { flowKinds: JSON.parse('{"__proto__":"capital"}') }, { flowKinds: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`flow-${i}`, 'capital'])) }];
  const values = [{ reserveGrowthBps: -10001 }, { reserveGrowthBps: 100001 }, { reserveGrowthBps: 1.5 }, { assetGrowth: null }, { assetGrowth: [] }, { assetGrowth: { cash: {} } }, ...invalidOptions.map(option => ({ assetGrowth: { reserve: option } }))];
  for (const financialView of values) {
    assert.throws(() => store.saveSettings({ financialView, horizon: 12 }));
    assert.deepEqual(store.getSettings(), original);
  }
});

test('transactions expose minimal canonical growth flows, pair mirrored contributions once, and preserve owned endpoints', t => {
  const store = createStore(); t.after(() => store.close());
  const cash = store.createAccount({ name: 'Example daily cash', accountType: 'checking' }).account;
  const reserve = store.createAccount({ name: 'Example reserve', accountType: 'savings', role: 'reserve', balance: 100000, balanceDate: '2026-01-01' }).account;
  const investment = store.createAccount({ name: 'Example investments', accountType: 'investment', balance: 100000, balanceDate: '2026-01-01' }).account;
  const sourceAccounts = [{ externalId: 'cash', id: cash.id, name: 'Example daily cash' }, { externalId: 'reserve', id: reserve.id, name: 'Example reserve' }, { externalId: 'investment', id: investment.id, name: 'Example investments' }];
  store.ingest({ adapter: 'canonical-v1', sourceKey: 'example-bank', data: { accounts: sourceAccounts, transactions: [
    { externalId: 'reserve-funding', date: '2026-06-01', amount: -1000, accountExternalId: 'cash', fromAccountExternalId: 'cash', toAccountExternalId: 'reserve', description: 'Example reserve contribution' },
    { externalId: 'investment-funding', date: '2026-06-02', amount: -2000, accountExternalId: 'cash', fromAccountExternalId: 'cash', toAccountExternalId: 'investment', description: 'Example investment contribution' },
    { externalId: 'ordinary-expense', date: '2026-06-03', amount: -500, accountExternalId: 'cash', description: 'Example purchase' },
    { externalId: 'interest', date: '2026-12-31', amount: 100, accountExternalId: 'reserve', toAccountExternalId: 'reserve', fromExternalAccount: { externalId: 'bank-interest', name: 'Example interest payer' }, description: 'Example interest' }
  ] } });
  store.ingest({ adapter: 'canonical-v1', sourceKey: 'example-platform', data: { accounts: sourceAccounts, transactions: [
    { externalId: 'reserve-mirror', date: '2026-06-01', amount: 1000, accountExternalId: 'reserve', fromAccountExternalId: 'cash', toAccountExternalId: 'reserve' },
    { externalId: 'investment-mirror', date: '2026-06-02', amount: 2000, accountExternalId: 'investment', fromAccountExternalId: 'cash', toAccountExternalId: 'investment' }
  ] } });
  store.updateAccount({ id: reserve.id, balance: 101100, balanceDate: '2027-01-01' });
  const response = store.getTransactions();
  assert.equal(response.growthFlows.length, 3);
  for (const flow of response.growthFlows) {
    assert.deepEqual(Object.keys(flow).sort(), ['amount', 'date', 'from', 'id', 'label', 'to']);
    for (const endpoint of [flow.from, flow.to].filter(Boolean)) assert.deepEqual(Object.keys(endpoint).sort(), ['accountId', 'owned']);
  }
  const funding = response.growthFlows.find(flow => flow.to?.accountId === investment.id);
  assert.equal(funding.amount, 2000);
  assert.deepEqual(funding.from, { accountId: cash.id, owned: true });
  const interest = response.growthFlows.find(flow => flow.label === 'Example interest');
  assert.deepEqual(interest.from, { accountId: null, owned: false });
  const options = { coverage: { complete: true, from: '2026-01-01', to: '2027-01-01', accountIds: [reserve.id] }, flowKinds: { [interest.id]: 'return' } };
  const review = growthReview({ accounts: response.accountDetails.filter(account => account.id === reserve.id), flows: response.growthFlows, options });
  assert.equal(review.evidence.ready, true);
  assert.equal(review.evidence.recordedNetMovement, 1100);
  assert.equal(review.evidence.capitalNetMovement, 1000);
  assert.equal(review.evidence.returnMovement, 100);
});
