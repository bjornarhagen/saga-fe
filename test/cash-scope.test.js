import test from 'node:test';
import assert from 'node:assert/strict';
import { cashForecastTransactions } from '../src/lib/cash-scope.js';
import { baseline, summarize } from '../src/lib/engine.js';
import { historicalCash } from '../src/lib/forecast.js';

const accounts = [
  { id: 'daily', role: 'available', accountType: 'checking' },
  { id: 'pot', role: 'available', accountType: 'savings' },
  { id: 'reserve', role: 'reserve', accountType: 'savings' },
  { id: 'other', role: 'excluded', accountType: 'checking' },
  { id: 'portfolio', role: 'excluded', accountType: 'investment' },
];
const owned = id => ({ owned: true, accountId: id, ...accounts.find(account => account.id === id) });
const external = { owned: false, id: 'external' };
const row = (id, amount, kind, fromEndpoint, toEndpoint) => ({ id, date: '2026-01-15', month: '2026-01', amount, kind, regularIncome: kind === 'income', fromEndpoint, toEndpoint });

test('forecast scope retains spending, saving and income on available cash, including spending pots', () => {
  const rows = [
    row('salary', 10000, 'income', external, owned('daily')),
    row('purchase', -3000, 'expense', owned('daily'), external),
    row('pot-purchase', -500, 'expense', owned('pot'), external),
    row('contribution', -1000, 'saving', owned('daily'), owned('portfolio')),
    row('reserve-draw', 700, 'income', owned('reserve'), owned('daily')),
    row('mortgage-funding', -1500, 'expense', owned('daily'), owned('other')),
  ];
  assert.deepEqual(cashForecastTransactions(rows, accounts), rows);
});

test('forecast scope removes known movements outside available cash without changing actual totals', () => {
  const rows = [
    row('available-purchase', -100, 'expense', owned('daily'), external),
    row('reserve-purchase', -200, 'expense', owned('reserve'), external),
    row('other-income', 300, 'income', external, owned('other')),
    row('portfolio-fee', -400, 'expense', owned('portfolio'), external),
    row('reserve-income', 500, 'income', external, owned('reserve')),
  ];
  const before = structuredClone(rows);
  assert.deepEqual(cashForecastTransactions(rows, accounts).map(item => item.id), ['available-purchase']);
  assert.equal(summarize(rows).expense, 700);
  assert.equal(summarize(rows).income, 800);
  assert.deepEqual(rows, before);
});

test('effective endpoints take priority over source fields and preserve mirrored transfer behavior', () => {
  const rows = [
    { ...row('linked-cash', -100, 'expense', owned('daily'), external), accountId: 'portfolio', fromAccountId: 'reserve' },
    { ...row('linked-reserve', -200, 'expense', owned('reserve'), external), accountId: 'daily' },
    row('contribution-debit', -300, 'saving', owned('daily'), owned('reserve')),
    row('contribution-credit', 300, 'transfer', owned('daily'), owned('reserve')),
    row('draw-debit', -400, 'transfer', owned('reserve'), owned('daily')),
    { ...row('draw-credit', 400, 'income', owned('reserve'), owned('daily')), regularIncome: false },
  ];
  const selected = cashForecastTransactions(rows, accounts);
  assert.deepEqual(selected.map(item => item.id), ['linked-cash', 'contribution-debit', 'contribution-credit', 'draw-debit', 'draw-credit']);
  assert.deepEqual(summarize(selected), summarize(rows.filter(item => item.id !== 'linked-reserve')));
  assert.equal(baseline(selected, '2026-02-01', 1, '2026-01-01').income, 0, 'a reserve draw does not become regular income');
});

test('legacy rows use signed-side account IDs and retain genuinely unknown ownership', () => {
  const rows = [
    { id: 'known-cash', amount: -100, kind: 'expense', accountId: 'daily' },
    { id: 'known-reserve', amount: -100, kind: 'expense', accountId: 'reserve' },
    { id: 'known-other-income', amount: 100, kind: 'income', accountId: 'other' },
    { id: 'side-before-associated', amount: 100, kind: 'income', toAccountId: 'reserve', accountId: 'daily' },
    { id: 'effective-link', amount: -100, kind: 'expense', fromOwnedAccountId: 'reserve', accountId: 'daily' },
    { id: 'endpoint-id', amount: -100, kind: 'expense', fromEndpoint: { owned: true, id: 'reserve' } },
    { id: 'unknown-account', amount: -100, kind: 'expense', accountId: 'not-in-ledger' },
    { id: 'unknown-owner', amount: -100, kind: 'expense' },
    { id: 'incomplete-owned-endpoint', amount: -100, kind: 'expense', fromEndpoint: { owned: true, accountId: 'missing-profile' } },
  ];
  assert.deepEqual(cashForecastTransactions(rows, accounts).map(item => item.id), ['known-cash', 'unknown-account', 'unknown-owner', 'incomplete-owned-endpoint']);
});

test('known external signed sides and investments never become available cash through associated IDs', () => {
  const rows = [
    { ...row('external-debit', -100, 'expense', external, owned('daily')), accountId: 'daily' },
    { ...row('external-credit', 100, 'income', owned('daily'), external), accountId: 'daily' },
    row('invalid-investment-role', -100, 'expense', { owned: true, role: 'available', accountType: 'investment' }, external),
    row('zero', 0, 'expense', owned('reserve'), external),
    row('transfer', -100, 'transfer', owned('reserve'), owned('portfolio')),
  ];
  assert.deepEqual(cashForecastTransactions(rows, accounts).map(item => item.id), ['zero', 'transfer']);
});

test('the same cash scope supports historical reconstruction and the forecast baseline', () => {
  const rows = [
    row('salary', 1000, 'income', external, owned('daily')),
    row('purchase', -200, 'expense', owned('daily'), external),
    row('reserve-purchase', -700, 'expense', owned('reserve'), external),
  ];
  const scoped = cashForecastTransactions(rows, accounts);
  assert.equal(baseline(scoped, '2026-02-01', 1, '2026-01-01').expense, 200);
  assert.deepEqual(historicalCash({ transactions: scoped, firstDate: '2026-01-01', lastDate: '2026-01-31', cash: 2000, asOf: '2026-02-01', months: 1 }), [
    { date: '2026-01-01', historical: true, history: 1200 },
  ]);
});
