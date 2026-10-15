import test from 'node:test';
import assert from 'node:assert/strict';
import { spendingPlanForecast, spendingPlanTransactions, spendingPlanExpenseNeedsReview } from '../src/lib/spending-plans.js';
import { baseline, project, shiftMonth, summarize } from '../src/lib/engine.js';
import { methodForecasts } from '../src/lib/forecast.js';

const asOf = '2026-10-15';
const account = (extra = {}) => ({ id: 'pot', name: 'Example pot', role: 'available', accountType: 'savings', balance: 10001, balanceDate: asOf, ...extra });
const plan = (extra = {}) => ({ accountId: 'pot', category: 'Example upgrades', monthlySpending: 4000, monthlyFunding: 0, topUps: [], reviewAtBalance: null, ...extra });
const forecast = (extra = {}) => spendingPlanForecast({ plans: [plan()], accounts: [account()], asOf, horizon: 4, ...extra });
const cashInputs = { cash: 50000, savings: 1000, income: 10000, expense: 5000, saving: 1000, adjustment: 100, oneOff: 500, buffer: 1000, horizon: 4, asOf };

test('a finite pot spends exact øre until depleted without repeating purchases forever', () => {
  const result = forecast({ plans: [plan({ reviewAtBalance: 3000 })] });
  assert.equal(result.ready, true);
  assert.equal(result.hasPlannedSpending, true);
  assert.deepEqual(result.expenses, [4000, 4000, 2001, 0]);
  assert.equal(result.monthlyExpense, 2500);
  assert.deepEqual(result.managedCategories, ['Example upgrades']);
  const detail = result.plans[0];
  assert.equal(detail.balance, 10001);
  assert.equal(detail.endBalance, 0);
  assert.equal(detail.asOf, asOf);
  assert.equal(detail.depletionDate, '2027-01-15');
  assert.deepEqual(detail.points.map(point => point.balance), [6001, 2001, 0, 0]);
  assert.deepEqual(detail.review, { threshold: 3000, balance: 2001, date: '2026-12-15', due: true });
  assert.equal(detail.points.reduce((sum, point) => sum + point.spending, 0), detail.balance);
  const projection = project({ ...cashInputs, plannedExpenses: result.expenses });
  assert.equal(projection.monthlyNet, 1400);
  assert.deepEqual(projection.points.map(point => point.cashChange), [-600, -100, 1899, 3900]);
  assert.equal(projection.endBalance, 55099);
});

test('monthly and dated internal funding combine once per clamped anniversary interval', () => {
  const result = forecast({ asOf: '2028-01-31', accounts: [account({ balance: 5, balanceDate: '2028-01-31' })], plans: [plan({ monthlySpending: 8, monthlyFunding: 2, topUps: [
    { date: '2028-01-30', amount: 100 }, { date: '2028-01-31', amount: 100 },
    { date: '2028-02-01', amount: 3 }, { date: '2028-02-29', amount: 5 },
    { date: '2028-03-01', amount: 9 }, { date: '2028-03-31', amount: 4 },
    { date: '2028-04-30', amount: 1 }, { date: '2028-06-01', amount: 100 }
  ] })] });
  assert.equal(result.ready, true);
  assert.deepEqual(result.plans[0].points.map(point => point.date), ['2028-02-29', '2028-03-31', '2028-04-30', '2028-05-31']);
  assert.deepEqual(result.plans[0].points.map(point => point.funding), [10, 15, 3, 2]);
  assert.deepEqual(result.expenses, [8, 8, 8, 8]);
  assert.equal(result.plans[0].endBalance, 3);
  assert.equal(result.plans[0].depletionDate, undefined);
  // Funding changes which existing cash is allocated, never aggregate income.
  const projection = project({ ...cashInputs, oneOff: 0, income: 0, expense: 0, saving: 0, adjustment: 0, plannedExpenses: result.expenses });
  assert.equal(projection.endBalance, cashInputs.cash - 32);
});

test('a depleted pot resumes only when its scheduled internal funding arrives', () => {
  const result = forecast({ accounts: [account({ balance: 5 })], plans: [plan({ monthlySpending: 8, topUps: [{ date: '2027-01-01', amount: 10 }] })] });
  assert.deepEqual(result.expenses, [5, 0, 8, 2]);
  assert.equal(result.plans[0].depletionDate, '2026-11-15');
  assert.equal(result.monthlyExpense, 4);
  const empty = forecast({ accounts: [account({ balance: 0 })], plans: [plan({ reviewAtBalance: 0 })] });
  assert.deepEqual(empty.expenses, [0, 0, 0, 0]);
  assert.equal(empty.hasPlannedSpending, false);
  assert.equal(empty.plans[0].depletionDate, asOf);
  assert.equal(empty.plans[0].review.due, true);
});

test('unset pace tracks the observed pot without removing historical costs or inventing zero spending', () => {
  const result = forecast({ plans: [plan({ monthlySpending: null, monthlyFunding: 100, topUps: [{ date: '2026-11-01', amount: 1000 }], reviewAtBalance: 9000 })] });
  assert.equal(result.ready, true);
  assert.equal(result.hasPlannedSpending, false);
  assert.deepEqual(result.managedCategories, []);
  assert.deepEqual(result.expenses, [0, 0, 0, 0]);
  assert.equal(result.plans[0].trackedOnly, true);
  assert.deepEqual(result.plans[0].points, []);
  assert.equal(result.plans[0].endBalance, 10001);
  assert.equal(result.plans[0].review.due, false);
  const unknown = forecast({ plans: [plan({ monthlySpending: null })], accounts: [account({ balance: null, balanceDate: null })] });
  assert.equal(unknown.ready, true);
  assert.equal(unknown.plans[0].balance, null);
  assert.equal(unknown.plans[0].endBalance, null);
  for (const accounts of [[], [account({ role: 'reserve' })], [account({ accountType: 'investment' })]]) {
    const invalidTracked = forecast({ plans: [plan({ monthlySpending: null })], accounts });
    assert.equal(invalidTracked.ready, true, 'tracking issues cannot change an otherwise independent cash forecast');
    assert.equal(invalidTracked.plans[0].ready, false);
    assert.ok(invalidTracked.plans[0].reason);
    assert.deepEqual(invalidTracked.managedCategories, []);
  }
  const zero = forecast({ plans: [plan({ monthlySpending: 0 })] });
  assert.deepEqual(zero.managedCategories, ['Example upgrades'], 'an explicitly chosen zero pace differs from unset');
});

test('managed categories affect forecast expenses alone while all actual rows and summaries remain intact', () => {
  const result = forecast();
  const rows = Object.freeze([
    { id: 'purchase', date: '2026-09-01', month: '2026-09', kind: 'expense', category: 'Example upgrades', amount: -5000 },
    { id: 'exceptional', date: '2026-09-02', month: '2026-09', kind: 'expense', category: 'Example upgrades', amount: -7000, excludeForecast: true },
    { id: 'ordinary', date: '2026-09-03', month: '2026-09', kind: 'expense', category: 'Example food', amount: -500 },
    { id: 'income', date: '2026-09-04', month: '2026-09', kind: 'income', category: 'Example upgrades', amount: 8000, regularIncome: true },
    { id: 'saving', date: '2026-09-05', month: '2026-09', kind: 'saving', category: 'Example upgrades', amount: -1000 },
    { id: 'funding', date: '2026-09-06', month: '2026-09', kind: 'transfer', category: 'Example upgrades', amount: -10000 }
  ].map(Object.freeze));
  const before = summarize(rows);
  const filtered = spendingPlanTransactions(rows, result);
  assert.deepEqual(filtered.map(row => row.id), ['ordinary', 'income', 'saving', 'funding']);
  assert.equal(filtered[0], rows[2]);
  assert.deepEqual(summarize(rows), before);
  assert.equal(before.expense, 12500);
  const amounts = baseline(filtered, asOf, 1, '2026-09-01');
  assert.equal(amounts.expense, 500);
  const projection = project({ ...cashInputs, ...amounts, plannedExpenses: result.expenses, adjustment: 0, oneOff: 0 });
  assert.equal(projection.endBalance, cashInputs.cash + (8000 - 500 - 1000) * 4 - 10001);
  assert.deepEqual(spendingPlanTransactions(rows, forecast({ plans: [plan({ monthlySpending: null })] })), rows);
});

test('paced plans block forecasts when the pot is unknown, mismatched, negative or outside available cash', () => {
  const cases = [
    { accounts: [], reason: /missing/ },
    { accounts: [account({ balance: null })], reason: /known, nonnegative/ },
    { accounts: [account({ balance: -1 })], reason: /known, nonnegative/ },
    { accounts: [account({ balance: 1.5 })], reason: /known, nonnegative/ },
    { accounts: [account({ balanceDate: '2026-10-14' })], reason: /date must match/ },
    { accounts: [account({ balanceDate: null })], reason: /date must match/ },
    { accounts: [account({ role: 'reserve' })], reason: /available cash/ },
    { accounts: [account({ accountType: 'investment' })], reason: /investments/ },
    { asOf: '2026-02-30', reason: /valid forecast starting date/ }
  ];
  for (const { reason, ...options } of cases) {
    const result = forecast(options);
    assert.equal(result.ready, false);
    assert.match(result.plans[0].reason, reason);
    assert.deepEqual(result.managedCategories, []);
    assert.deepEqual(result.plans[0].points, []);
  }
});

test('invalid plans and duplicate category ownership never silently remove historical spending', () => {
  for (const changes of [{ monthlySpending: -1 }, { monthlySpending: 0.5 }, { monthlyFunding: -1 }, { monthlyFunding: Number.MAX_SAFE_INTEGER + 1 }, { reviewAtBalance: -1 }, { topUps: [{ date: '2026-02-30', amount: 1 }] }, { topUps: [{ date: asOf, amount: 0 }] }, { category: '' }]) {
    const result = forecast({ plans: [plan(changes)] });
    assert.equal(result.ready, false);
    assert.ok(result.plans[0].reason);
    assert.deepEqual(result.managedCategories, []);
  }
  for (const second of [plan({ category: 'Different category' }), plan({ accountId: 'second-pot' }), plan({ accountId: 'second-pot', category: '  EXAMPLE UPGRADES  ' })]) {
    const result = forecast({ plans: [plan(), second], accounts: [account(), account({ id: 'second-pot' })] });
    assert.equal(result.ready, false);
    assert.deepEqual(result.managedCategories, []);
  }
});

test('managed categories match historical expenses regardless of case or surrounding spaces', () => {
  const result = forecast({ plans: [plan({ category: '  example upgrades  ' })] });
  const rows = [
    { kind: 'expense', category: 'Example upgrades', amount: -100 },
    { kind: 'expense', category: '  EXAMPLE UPGRADES ', amount: -200 },
    { kind: 'expense', category: 'Example food', amount: -300 },
    { kind: 'income', category: 'Example upgrades', amount: 400 },
    { kind: 'saving', category: 'Example upgrades', amount: -500 },
    { kind: 'transfer', category: 'Example upgrades', amount: -600 }
  ];
  assert.deepEqual(spendingPlanTransactions(rows, result), rows.slice(2));
  const norwegian = { managedCategories: ['  MØBLER  '] };
  assert.deepEqual(spendingPlanTransactions([{ kind: 'expense', category: 'møbler' }], norwegian), []);
});

test('custom ordinary spending needs review when managed categories are added or removed', () => {
  const upgrades = forecast();
  const both = { managedCategories: ['Example upgrades', 'Example furniture'] };
  assert.equal(spendingPlanExpenseNeedsReview(upgrades, 1000), true);
  assert.equal(spendingPlanExpenseNeedsReview(upgrades, 0), true);
  assert.equal(spendingPlanExpenseNeedsReview(upgrades, undefined), false);
  assert.equal(spendingPlanExpenseNeedsReview(upgrades, 1000, ['Example upgrades']), false);
  assert.equal(spendingPlanExpenseNeedsReview(upgrades, 1000, ['  EXAMPLE UPGRADES  ']), false);
  assert.equal(spendingPlanExpenseNeedsReview(both, 1000, ['Example upgrades']), true, 'adding a pot category requires review');
  assert.equal(spendingPlanExpenseNeedsReview(upgrades, 1000, both.managedCategories), true, 'removing a pot category also requires review');
  assert.equal(spendingPlanExpenseNeedsReview(both, 1000, ['EXAMPLE FURNITURE', 'example upgrades', 'Example furniture']), false, 'category acknowledgement is an unordered normalized set');
  assert.equal(spendingPlanExpenseNeedsReview(forecast({ plans: [] }), 1000, ['Example upgrades']), true, 'removing the last managed category requires review');
  assert.equal(spendingPlanExpenseNeedsReview(forecast({ plans: [] }), 1000), false);
  assert.equal(spendingPlanExpenseNeedsReview(forecast({ plans: [plan({ monthlySpending: null })] }), 1000), false);
  assert.equal(spendingPlanExpenseNeedsReview(forecast({ plans: [plan({ monthlySpending: null })] }), 1000, ['Example upgrades']), true, 'clearing the last spending pace returns its category to history');
  assert.equal(spendingPlanExpenseNeedsReview(forecast({ plans: [plan({ monthlySpending: 0 })] }), 1000), true, 'explicit zero pace still replaces historical costs');
});

test('multiple finite plans combine in integer øre with safe means near the integer limit', () => {
  const result = forecast({ plans: [plan({ monthlySpending: 1 }), plan({ accountId: 'second', category: 'Example furniture', monthlySpending: 2 })], accounts: [account({ balance: 1 }), account({ id: 'second', balance: 4 })] });
  assert.equal(result.ready, true);
  assert.deepEqual(result.expenses, [3, 2, 0, 0]);
  assert.equal(result.monthlyExpense, 1);
  const large = forecast({ plans: [plan({ monthlySpending: Number.MAX_SAFE_INTEGER, monthlyFunding: Number.MAX_SAFE_INTEGER })], accounts: [account({ balance: 0 })] });
  assert.equal(large.ready, true);
  assert.equal(large.monthlyExpense, Number.MAX_SAFE_INTEGER);
  assert.ok(large.expenses.every(Number.isSafeInteger));
  assert.deepEqual(spendingPlanForecast({ asOf, horizon: 2 }), { plans: [], managedCategories: [], expenses: [0, 0], monthlyExpense: 0, hasPlannedSpending: false, ready: true });
});

test('overflow blocks pot projections rather than rounding balances or combined spending', () => {
  const limit = Number.MAX_SAFE_INTEGER;
  for (const options of [
    { plans: [plan({ monthlyFunding: 1 })], accounts: [account({ balance: limit })] },
    { plans: [plan({ monthlyFunding: limit, topUps: [{ date: '2026-11-01', amount: 1 }] })], accounts: [account({ balance: 0 })] },
    { plans: [plan({ monthlySpending: limit }), plan({ accountId: 'second', category: 'Example furniture', monthlySpending: 1 })], accounts: [account({ balance: limit }), account({ id: 'second', balance: 1 })] }
  ]) {
    const result = forecast(options);
    assert.equal(result.ready, false);
    assert.ok(result.plans.some(detail => /supported integer/.test(detail.reason)));
    assert.ok(result.expenses.every(Number.isSafeInteger));
  }
});

test('planned purchases combine with variable monthly cash flows and one-offs exactly once', () => {
  const monthlyFlows = [{ income: 100, expense: 20, saving: 5 }, { income: 200, expense: 30, saving: 10 }, { income: 300, expense: 40, saving: 15 }, { income: 400, expense: 50, saving: 20 }];
  const projection = project({ ...cashInputs, cash: 1000, adjustment: 1, oneOff: 10, monthlyFlows, plannedExpenses: [1, 2, 3, 0] });
  assert.deepEqual(projection.points.map(point => point.cashChange), [63, 157, 241, 329]);
  assert.equal(projection.endBalance, 1790);
  assert.equal(projection.monthlyNet, 200); // mean monthly cash flow, excluding the one-off
  assert.equal(projection.breakEvenCut, 0);
  const negative = project({ ...cashInputs, income: 0, expense: 0, saving: 0, adjustment: 0, plannedExpenses: [1, 2, 3, 0] });
  assert.equal(negative.monthlyNet, -2);
  assert.equal(negative.breakEvenCut, 2);
  assert.deepEqual(project(cashInputs), project({ ...cashInputs, plannedExpenses: [0, 0, 0, 0] }));
});

test('all forecast methods receive planned expenses, including seasonal monthly flows', () => {
  const rows = Array.from({ length: 36 }, (_, i) => {
    const month = shiftMonth('2023-10', i);
    return [{ date: `${month}-01`, month, amount: -100, kind: 'expense', category: 'Example food' },
      { date: `${month}-20`, month, amount: 1000, kind: 'income', regularIncome: true }];
  }).flat();
  const options = { ...cashInputs, transactions: rows, firstDate: '2023-10-01', historyAsOf: asOf, lookback: 12, assumptions: { income: 1000, expense: 100, saving: 0 } };
  const plain = methodForecasts(options), planned = methodForecasts({ ...options, plannedExpenses: [1, 2, 3, 0] });
  for (let i = 0; i < plain.length; i++) {
    assert.ok(planned[i].projection);
    assert.equal(planned[i].projection.endBalance, plain[i].projection.endBalance - 6);
    assert.equal(planned[i].projection.monthlyNet, plain[i].projection.monthlyNet - 2);
  }
});

test('an overflowing comparison reports its own error while safe planned forecasts remain usable', () => {
  const result = forecast({ horizon: 2, accounts: [account({ balance: 2 })], plans: [plan({ monthlySpending: 1 })] });
  const options = { ...cashInputs, cash: 10, savings: 0, buffer: 0, adjustment: 0, oneOff: 0, horizon: 2,
    transactions: [{ date: '2026-09-01', month: '2026-09', amount: Number.MAX_SAFE_INTEGER, kind: 'income', regularIncome: true }],
    firstDate: '2026-07-01', historyAsOf: asOf, lookback: 3, assumptions: { income: 1, expense: 1, saving: 0 }, plannedExpenses: result.expenses };
  const methods = Object.fromEntries(methodForecasts(options).map(method => [method.id, method]));
  assert.equal(methods.unchanged.projection.endBalance, 8);
  assert.equal(methods.unchanged.reason, '');
  assert.ok(methods.average.projection);
  assert.equal(methods.recent.projection, null);
  assert.match(methods.recent.reason, /supported integer/);
  const normalOptions = { ...options, plannedExpenses: undefined, transactions: [{ ...options.transactions[0], amount: 20 }] };
  const normal = Object.fromEntries(methodForecasts(normalOptions).map(method => [method.id, method]));
  assert.deepEqual(normal.unchanged.projection, project({ ...normalOptions, ...normalOptions.assumptions }));
  assert.equal(normal.recent.projection.endBalance, 50);
  assert.equal(normal.recent.reason, '');
  const invalidHorizon = methodForecasts({ ...normalOptions, horizon: 0 });
  assert.equal(invalidHorizon.find(method => method.id === 'unchanged').projection, null);
  assert.match(invalidHorizon.find(method => method.id === 'unchanged').reason, /horizon/);
});

test('planned expense inputs and all resulting projected amounts remain safe integers', () => {
  for (const plannedExpenses of [[], [1, 2], [1, 2, 3, -1], [1, 2, 3, 0.5], [1, 2, 3, Number.MAX_SAFE_INTEGER + 1], '1234']) assert.throws(() => project({ ...cashInputs, plannedExpenses }), /planned expense/);
  assert.throws(() => project({ ...cashInputs, cash: Number.MAX_SAFE_INTEGER, plannedExpenses: [0, 0, 0, 0] }), /supported integer/);
  assert.throws(() => project({ ...cashInputs, income: 0.5, plannedExpenses: [0, 0, 0, 0] }), /safe integer/);
  assert.throws(() => project({ ...cashInputs, cash: -Number.MAX_SAFE_INTEGER, income: 0, expense: 0, saving: 0, adjustment: 0, oneOff: 0, plannedExpenses: [0, 0, 0, 0] }), /supported integer/);
  for (const horizon of [0, 61, 1.5]) assert.throws(() => forecast({ horizon }), /horizon/);
});
