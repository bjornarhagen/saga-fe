import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/engine.js';
import { accountAssetSummary, contributionAllocation, financialProjection } from '../src/lib/financial-forecast.js';

const accounts = [
  { id: 'cash', role: 'available', accountType: 'checking', balance: 10000, balanceDate: '2026-01-31' },
  { id: 'reserve', role: 'reserve', accountType: 'savings', balance: 3000, balanceDate: '2026-01-31' },
  { id: 'invest', role: 'excluded', accountType: 'investment', balance: 2000, balanceDate: '2026-01-31' },
  { id: 'other', role: 'excluded', accountType: 'credit', balance: -500, balanceDate: '2026-01-31' }
];
const contribution = (target, amount, extra = {}) => ({ date: '2026-01-04', month: '2026-01', kind: 'saving', amount, toEndpoint: { owned: true, accountId: target }, ...extra });
const allocationInput = { accounts, start: '2026-01', end: '2026-01', months: 1, saving: 1000 };
const base = { cash: 10000, savings: 3000, income: 5000, expense: 4000, saving: 500, horizon: 3, asOf: '2026-01-31' };
const scenario = (options = {}) => financialProjection({ projection: project(base), cash: base.cash, reserve: base.savings, investments: 2000, other: -500, buffer: 0, asOf: base.asOf, ...options });

test('contributions use effective owned destinations and preserve unknown saving', () => {
  const transactions = [
    contribution('reserve', -200), contribution('invest', -100), contribution('unknown', -100),
    contribution('reserve', 200), // Receiving leg of the same transfer.
    contribution('reserve', -100000, { excludeForecast: true }),
    contribution('reserve', -100000, { kind: 'expense' }),
    contribution('reserve', -100000, { date: '2025-12-31', month: '2025-12' }),
    contribution('reserve', -100000, { date: '2026-02-01', month: '2026-02' })
  ];
  assert.deepEqual(contributionAllocation({ ...allocationInput, transactions }), { reserve: 500, investment: 250, unallocated: 250 });
  const external = [contribution('reserve', -100, { toEndpoint: { owned: false, accountId: 'reserve' } })];
  assert.deepEqual(contributionAllocation({ ...allocationInput, transactions: external }), { reserve: 0, investment: 0, unallocated: 1000 });
  const changed = accounts.map(account => account.id === 'reserve' ? { ...account, role: 'available' } : account);
  assert.deepEqual(contributionAllocation({ ...allocationInput, transactions: [contribution('reserve', -100)], accounts: changed }), { reserve: 0, investment: 0, unallocated: 1000 });
});

test('custom saving allocation rounds exact proportions without losing øre', () => {
  const transactions = [contribution('reserve', -1), contribution('invest', -1), contribution('unknown', -1)];
  assert.deepEqual(contributionAllocation({ ...allocationInput, transactions, saving: 2 }), { reserve: 1, investment: 1, unallocated: 0 });
  const veryLarge = [contribution('reserve', -Number.MAX_SAFE_INTEGER), contribution('invest', -Number.MAX_SAFE_INTEGER)];
  const result = contributionAllocation({ ...allocationInput, transactions: veryLarge, saving: Number.MAX_SAFE_INTEGER });
  assert.equal(BigInt(result.reserve) + BigInt(result.investment) + BigInt(result.unallocated), BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(result.unallocated, 0);
  assert.deepEqual(contributionAllocation({ ...allocationInput, transactions, months: 0 }), { reserve: 0, investment: 0, unallocated: 1000 });
  assert.deepEqual(contributionAllocation({ ...allocationInput, transactions: [] }), { reserve: 0, investment: 0, unallocated: 1000 });
});

test('full-date contribution bounds are inclusive and honor custom monthly saving', () => {
  const transactions = [contribution('reserve', -20, { date: '2026-01-03' }), contribution('reserve', -20), contribution('invest', -20, { date: '2026-01-05' })];
  assert.deepEqual(contributionAllocation({ ...allocationInput, transactions, start: '2026-01-04', end: '2026-01-05', months: 2, saving: 3 }), { reserve: 2, investment: 1, unallocated: 0 });
});

test('account summary partitions each latest observation once and identifies incomplete mixed dates', () => {
  const summary = accountAssetSummary(accounts);
  assert.deepEqual([summary.cash.total, summary.reserve.total, summary.investments.total, summary.other.total, summary.total], [10000, 3000, 2000, -500, 14500]);
  assert.equal(summary.ready, true);
  assert.equal(summary.known, 4);
  assert.equal(summary.sameDate, true);
  const mixed = accountAssetSummary([...accounts, { id: 'unknown', role: 'reserve', accountType: 'savings', balance: null }, { id: 'later', role: 'available', accountType: 'checking', balance: 1, balanceDate: '2026-02-01' }]);
  assert.equal(mixed.total, 14501);
  assert.equal(mixed.missing, 1);
  assert.equal(mixed.ready, false);
  assert.equal(mixed.dateStart, '2026-01-31');
  assert.equal(mixed.dateEnd, '2026-02-01');
  assert.equal(mixed.sameDate, false);
  assert.equal(accountAssetSummary([]).ready, false);
  assert.equal(accountAssetSummary([{ ...accounts[0], balanceDate: null }]).ready, false);
});

test('saving transfers reduce cash once while increasing tracked reserve and investments', () => {
  const result = scenario({ reserveContribution: 300, investmentContribution: 150 });
  assert.equal(result.start.total, 14500);
  assert.deepEqual(result.points.map(point => [point.cash, point.reserve, point.investments, point.unallocated]), [[10500, 3300, 2150, 50], [11000, 3600, 2300, 50], [11500, 3900, 2450, 50]]);
  assert.equal(result.end.total, 17350);
  assert.equal(result.totalUnallocated, 150);
  assert.equal(result.totalSpendingSurplus, 3000);
  assert.equal(result.totalGrowth, 0);
});

test('reserve draws preserve total money and retain an uncovered negative cash balance', () => {
  const projection = project({ ...base, cash: 100, income: 0, expense: 1000, saving: 0 });
  const input = { projection, cash: 100, reserve: 1500, investments: 50000, other: 0, asOf: base.asOf, buffer: 200 };
  const drawn = financialProjection(input);
  const untouched = financialProjection({ ...input, useReserve: false });
  assert.deepEqual(drawn.points.map(point => [point.cash, point.reserve, point.reserveDraw, point.uncovered]), [[200, 400, 1100, 0], [-400, 0, 400, 600], [-1400, 0, 0, 1600]]);
  assert.equal(drawn.firstDrawDate, '2026-02-28');
  assert.equal(drawn.totalDraw, 1500);
  assert.equal(drawn.endUncovered, 1600);
  assert.equal(drawn.end.investments, 50000);
  assert.deepEqual(drawn.points.map(point => point.total), untouched.points.map(point => point.total));
  assert.equal(untouched.totalDraw, 0);
  assert.equal(untouched.end.cash, -2900);
});

test('variable monthly contributions fit each month and newly funded reserves can cover cash', () => {
  const projection = project({ ...base, cash: 0, income: 0, expense: 0, monthlyFlows: [{ income: 0, expense: 100, saving: 200 }, { income: 0, expense: 100, saving: 0 }, { income: 0, expense: 0, saving: 100 }] });
  const result = scenario({ projection, cash: 0, reserve: 1000, reserveContribution: [200, 0, 100], investmentContribution: [0, 0, 0] });
  assert.deepEqual(result.points.map(point => point.cash), [0, 0, 0]);
  assert.deepEqual(result.points.map(point => point.reserve), [900, 800, 800]);
  assert.equal(result.totalDraw, 500);
  assert.equal(result.end.total - result.start.total, -200);
});

test('engine exposes reconciled monthly income, spending, and saving including one-offs and pots', () => {
  const projection = project({ ...base, adjustment: -100, oneOff: 700, plannedExpenses: [200, 0, 50], monthlyFlows: [{ income: 5000, expense: 4000, saving: 500 }, { income: 6000, expense: 4200, saving: 300 }, { income: 5000, expense: 3900, saving: 500 }] });
  assert.deepEqual(projection.points.map(point => point.expense), [4800, 4100, 3850]);
  for (const point of projection.points) assert.equal(point.cashChange, point.income - point.expense - point.saving);
  const result = scenario({ projection, reserveContribution: [500, 300, 500] });
  assert.equal(result.totalExpense, 12750);
  assert.equal(result.totalIncome, 16000);
  assert.equal(result.end.total - result.start.total, 3250);
});

test('optional growth compounds from opening investments before each new contribution', () => {
  const result = scenario({ annualGrowthBps: 1200, investmentContribution: 500 });
  const monthlyRate = Math.expm1(Math.log1p(0.12) / 12);
  assert.equal(result.points[0].growth, Math.round(2000 * monthlyRate));
  assert.equal(result.points[0].investments, 2500 + result.points[0].growth);
  assert.equal(result.points[1].growth, Math.round(result.points[0].investments * monthlyRate));
  assert.equal(result.end.total - result.start.total, result.totalSpendingSurplus + result.totalGrowth);
  const loss = scenario({ annualGrowthBps: -10000, investmentContribution: 500 });
  assert.deepEqual(loss.points.map(point => point.investments), [500, 500, 500]);
  assert.deepEqual(loss.points.map(point => point.growth), [-2000, -500, -500]);
});

test('flat growth defaults preserve investments and negative growth reduces total without touching cash', () => {
  const flat = scenario(), negative = scenario({ annualGrowthBps: -2000 });
  assert.equal(flat.end.investments, 2000);
  assert.equal(flat.totalGrowth, 0);
  assert.ok(negative.totalGrowth < 0);
  assert.deepEqual(flat.points.map(point => point.cash), negative.points.map(point => point.cash));
  assert.equal(negative.end.total - flat.end.total, negative.totalGrowth);
});

test('reserve growth compounds before contributions and can fund a later cash shortfall', () => {
  const projection = project({ ...base, cash: 0, income: 0, expense: 100, saving: 0, horizon: 12 });
  const result = financialProjection({ projection, cash: 0, reserve: 1000000, asOf: base.asOf, annualReserveGrowthBps: 1200 });
  const rate = Math.expm1(Math.log1p(0.12) / 12);
  assert.equal(result.points[0].reserveGrowth, Math.round(1000000 * rate));
  assert.equal(result.points[0].investmentGrowth, 0);
  assert.equal(result.points[0].reserve, 1000000 + result.points[0].reserveGrowth - 100);
  assert.equal(result.totalDraw, 1200);
  assert.equal(result.end.total - result.start.total, result.totalGrowth - result.totalExpense);
  const funded = scenario({ reserveContribution: 500, annualReserveGrowthBps: 1200, annualGrowthBps: 500 });
  assert.equal(funded.points[0].reserveGrowth, Math.round(base.savings * rate));
  for (const point of funded.points) assert.equal(point.growth, point.reserveGrowth + point.investmentGrowth);
  const exhausted = scenario({ annualReserveGrowthBps: -10000, reserveContribution: 500, useReserve: false });
  assert.deepEqual(exhausted.points.map(point => point.reserve), [500, 500, 500]);
  assert.throws(() => scenario({ annualReserveGrowthBps: 0.5 }), RangeError);
  assert.throws(() => scenario({ annualReserveGrowthBps: -10001 }), RangeError);
});

test('effective annual growth reaches the annual assumption within monthly øre rounding', () => {
  const projection = project({ ...base, income: 0, expense: 0, saving: 0, horizon: 12 });
  const positive = scenario({ projection, investments: 1000000, annualGrowthBps: 1200 });
  const negative = scenario({ projection, investments: 1000000, annualGrowthBps: -2000 });
  assert.ok(Math.abs(positive.end.investments - 1120000) <= 7);
  assert.ok(Math.abs(negative.end.investments - 800000) <= 7);
  assert.equal(positive.end.cash, positive.start.cash);
  assert.equal(negative.end.cash, negative.start.cash);
});

test('every month conserves funds across income, spending, saving, growth and draws', () => {
  const result = scenario({ cash: -500, reserve: 600, reserveContribution: [100, 200, 0], investmentContribution: [100, 300, 400], annualGrowthBps: 500, buffer: 1000 });
  let previous = result.start;
  for (const point of result.points) {
    assert.equal(point.total, point.cash + point.reserve + point.investments + point.other);
    assert.equal(point.total - previous.total, point.income - point.expense - point.unallocated + point.growth);
    assert.ok(Object.values(point).filter(value => typeof value === 'number').every(Number.isSafeInteger));
    previous = point;
  }
});

test('invalid assumptions, missing flows, over-allocation and unsafe arithmetic fail explicitly', () => {
  for (const options of [{ annualGrowthBps: -10001 }, { annualGrowthBps: 100001 }, { annualGrowthBps: 0.5 }, { reserve: -1 }, { buffer: -1 }, { cash: 0.1 }, { reserveContribution: 501 }, { investmentContribution: [1] }, { useReserve: 1 }, { asOf: '2026-02-30' }, { projection: { points: [{ date: '2026-02-28', cashChange: 500 }] } }]) assert.throws(() => scenario(options), RangeError);
  const inconsistent = { points: [{ date: '2026-02-28', income: 100, expense: 50, saving: 0, cashChange: 49 }] };
  assert.throws(() => scenario({ projection: inconsistent }), /cash change/);
  assert.throws(() => scenario({ cash: Number.MAX_SAFE_INTEGER }), RangeError);
  assert.throws(() => scenario({ investments: Number.MAX_SAFE_INTEGER, annualGrowthBps: 100000 }), RangeError);
  assert.throws(() => contributionAllocation({ ...allocationInput, saving: -1 }), RangeError);
  assert.throws(() => accountAssetSummary([{ ...accounts[0], balance: 0.5 }]), RangeError);
  assert.throws(() => accountAssetSummary([{ ...accounts[0], balanceDate: '2026-02-30' }]), RangeError);
});
