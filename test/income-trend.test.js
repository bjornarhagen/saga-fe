import test from 'node:test';
import assert from 'node:assert/strict';
import { incomeTrend, applyIncomeTrend, incomeTrendDamping, incomeTrendMinimumMonths, incomeTrendWindow } from '../src/lib/income-trend.js';
import { shiftMonth } from '../src/lib/engine.js';

const incomeRow = (month, amount, extra = {}) => ({ date: `${month}-20`, month, amount, kind: 'income', regularIncome: true, ...extra });
const history = (length = 36, value = index => 100000 + 100 * index, start = '2024-01') => Array.from({ length }, (_, index) => incomeRow(shiftMonth(start, index), value(index)));
const options = { firstDate: '2024-01-01', historyAsOf: '2027-01-15', asOf: '2027-01-15', horizon: 3 };
const estimate = (transactions = history(), extra = {}) => incomeTrend({ ...options, transactions, ...extra });

test('income trend uses robust matched-year changes and an explicit damped extrapolation', () => {
  const result = estimate();
  assert.equal(result.ready, true);
  assert.equal(result.reason, '');
  assert.equal(result.start, '2024-01');
  assert.equal(result.end, '2026-12');
  assert.equal(result.completeMonths, 36);
  assert.equal(result.incomeMonths, 36);
  assert.equal(result.matchedPairs, 36); // three cross-year comparisons per calendar month
  assert.equal(result.anchorIncome, 103400);
  assert.equal(result.monthlyTrend, 100);
  assert.equal(result.damping, 0.98);
  assert.deepEqual(result.futureIncome, [103594, 103688, 103780]);
  assert.equal(incomeTrendDamping, 0.98);
  assert.equal(incomeTrendMinimumMonths, 24);
  assert.equal(incomeTrendWindow, 36);
});

test('annual holiday pay and isolated regular-income spikes do not create a seasonal trend', () => {
  const rows = history(24, index => 100000 + Math.floor(index / 12) * 1200 + (index % 12 === 5 ? 50000 : index % 12 === 11 ? 10000 : 0), '2025-01');
  rows[19].amount += 250000;
  rows[23].amount += 250000;
  const result = estimate(rows, { firstDate: '2025-01-01' });
  assert.equal(result.ready, true);
  assert.equal(result.monthlyTrend, 100);
  assert.equal(result.anchorIncome, 101200);
  assert.deepEqual(result.futureIncome, [101394, 101488, 101580]);
  const flatSeasonal = estimate(history(36, index => 100000 + (index % 12 === 5 ? 50000 : index % 12 === 11 ? 10000 : 0)));
  assert.equal(flatSeasonal.monthlyTrend, 0);
  assert.deepEqual(flatSeasonal.futureIncome, [100000, 100000, 100000]);
});

test('forecast exclusions, irregular income, transfers and owned cash injections are ignored', () => {
  const clean = history();
  const dirty = [...clean,
    incomeRow('2026-12', 999999, { excludeForecast: true }),
    incomeRow('2026-12', 999999, { regularIncome: false }),
    incomeRow('2026-12', 999999, { kind: 'saving' }),
    incomeRow('2026-12', 999999, { kind: 'transfer' }),
    incomeRow('2026-12', 999999, { ownedMovement: true }),
    incomeRow('2026-12', 999999, { fromEndpoint: { owned: true }, toEndpoint: { owned: true } }),
    incomeRow('2027-01', 999999),
  ];
  assert.deepEqual(estimate(dirty), estimate(clean));
  // Row order and a stale precomputed month do not change the dated history.
  assert.deepEqual(estimate(clean.map(row => ({ ...row, month: '1900-01' })).reverse()), estimate(clean));
});

test('the model needs sufficient complete history and recurring-income coverage', () => {
  const short = estimate(history(23, () => 100000, '2025-02'), { firstDate: '2025-02-01' });
  assert.equal(short.ready, false);
  assert.match(short.reason, /24 complete months.*23 available/);
  assert.deepEqual(short.futureIncome, []);
  const partial = estimate(history(24, () => 100000, '2025-01'), { firstDate: '2025-01-02' });
  assert.equal(partial.completeMonths, 23);
  assert.equal(partial.ready, false);
  const sparse = history(24, index => index < 7 ? 0 : 100000, '2025-01');
  const unavailable = estimate(sparse, { firstDate: '2025-01-01' });
  assert.match(unavailable.reason, /18 complete months with regular income; 17 available/);
  assert.equal(unavailable.incomeMonths, 17);
  const sufficient = estimate(history(24, index => index < 6 ? 0 : 100000, '2025-01'), { firstDate: '2025-01-01' });
  assert.equal(sufficient.ready, true);
  assert.equal(sufficient.matchedPairs, 6);
});

test('a missing recent salary needs manual review and is not silently replaced by old earnings', () => {
  for (const index of [33, 34, 35]) {
    const rows = history(); rows[index].amount = 0;
    const result = estimate(rows);
    assert.equal(result.ready, false);
    assert.match(result.reason, /latest 3 complete months need regular income/);
  }
  const excluded = history(); excluded[35].excludeForecast = true;
  assert.equal(estimate(excluded).ready, false);
});

test('a declining income trend stays nonnegative without inventing income recovery', () => {
  const rows = history(36, index => 200000 - index * 5000);
  const result = estimate(rows, { horizon: 60 });
  assert.equal(result.ready, true);
  assert.equal(result.monthlyTrend, -5000);
  assert.equal(result.anchorIncome, 30000);
  assert.deepEqual(result.futureIncome.slice(0, 3), [20298, 15592, 10980]);
  assert.ok(result.futureIncome.every((value, index, list) => Number.isSafeInteger(value) && value >= 0 && (!index || value <= list[index - 1])));
  assert.equal(result.futureIncome.at(-1), 0);
});

test('salary is aligned to future checkpoint months after a later balance date', () => {
  const regular = estimate();
  const laterBalance = estimate(history(), { asOf: '2027-03-31' });
  assert.equal(laterBalance.end, '2026-12');
  assert.equal(laterBalance.futureIncome[0], regular.futureIncome[2]);
  const cutoff = estimate([...history(), incomeRow('2027-01', 999999)], { historyAsOf: '2027-02-01', asOf: '2027-01-15' });
  assert.deepEqual(cutoff, regular);
  const stale = estimate(history(), { asOf: '2038-01-01' });
  assert.equal(stale.ready, false);
  assert.match(stale.reason, /10 years/);
});

test('the trailing training window is independent of older observations', () => {
  const rows = [...history(12, () => 999999999, '2023-01'), ...history()];
  const result = estimate(rows, { firstDate: '2023-01-01' });
  assert.deepEqual(result, estimate());
});

test('fractional annual slopes and even medians are projected exactly before rounding to øre', () => {
  const tiny = estimate(history(24, index => 1000 + Math.floor(index / 12) * 6, '2025-01'), { firstDate: '2025-01-01', horizon: 60 });
  assert.equal(tiny.ready, true);
  assert.equal(tiny.monthlyTrend, 1); // display rounding, model retains 0.5 øre/month
  assert.equal(tiny.anchorIncome, 1006);
  assert.equal(tiny.futureIncome[0], 1007);
  assert.equal(tiny.futureIncome.at(-1), 1023);
  const rows = history(24, index => 1000 + (index >= 12 ? (index % 12 < 6 ? 6 : 18) : 0), '2025-01');
  const evenMedian = estimate(rows, { firstDate: '2025-01-01' });
  assert.equal(evenMedian.monthlyTrend, 1);
  assert.deepEqual(evenMedian.futureIncome, [1020, 1021, 1022]);
});

test('unsupported dates, amounts and overflow cannot produce unsafe currency values', () => {
  for (const horizon of [0, 61, 1.5, NaN]) assert.equal(estimate(history(), { horizon }).ready, false);
  for (const asOf of ['', '2027-02-30', '2027-13-01']) assert.equal(estimate(history(), { asOf }).ready, false);
  assert.match(estimate(history(), { firstDate: null }).reason, /dated transaction coverage/);
  const badDate = history(); badDate[35].date = '2026-12-32';
  assert.match(estimate(badDate).reason, /invalid date/);
  for (const amount of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    const rows = history(); rows[0].amount = amount;
    assert.match(estimate(rows).reason, /safe integer/);
  }
  const monthlyOverflow = [...history(), incomeRow('2026-12', Number.MAX_SAFE_INTEGER)];
  assert.match(estimate(monthlyOverflow).reason, /totals exceed/);
  const projectedOverflow = history(36, index => Number.MAX_SAFE_INTEGER - (35 - index) * 100000000000000);
  const result = estimate(projectedOverflow, { horizon: 60 });
  assert.equal(result.ready, false);
  assert.match(result.reason, /Projected income exceeds/);
  assert.deepEqual(result.futureIncome, []);
});

test('the shared income-trend switch preserves each income baseline and every other flow field', () => {
  const flows = [{ income: 200, expense: 30, saving: 10, month: '2027-02' }, { income: 0, expense: 40, saving: 20 }, { income: 400, expense: 50, saving: 30 }];
  const trend = { ready: true, anchorIncome: 100, futureIncome: [110, 120, 125] };
  const adjusted = applyIncomeTrend({ flows, trend, enabled: true });
  assert.equal(adjusted.ready, true);
  assert.deepEqual(adjusted.flows, [{ income: 220, expense: 30, saving: 10, month: '2027-02' }, { income: 0, expense: 40, saving: 20 }, { income: 500, expense: 50, saving: 30 }]);
  assert.deepEqual(flows.map(flow => flow.income), [200, 0, 400]);
  assert.notEqual(adjusted.flows, flows);
  const disabled = applyIncomeTrend({ flows, enabled: false, trend: { ready: false, reason: 'No history.' } });
  assert.equal(disabled.ready, true);
  assert.equal(disabled.flows, flows);
  assert.equal(disabled.reason, '');
});

test('the shared income trend supports declining income and exact proportional øre rounding', () => {
  const adjusted = applyIncomeTrend({ flows: [{ income: 101, expense: 1, saving: 2 }, { income: Number.MAX_SAFE_INTEGER, expense: 3, saving: 4 }], trend: { ready: true, anchorIncome: 100, futureIncome: [50, 99] }, enabled: true });
  assert.equal(adjusted.ready, true);
  assert.equal(adjusted.flows[0].income, 51);
  assert.equal(adjusted.flows[1].income, Number((BigInt(Number.MAX_SAFE_INTEGER) * 99n + 50n) / 100n));
  const zero = applyIncomeTrend({ flows: [{ income: 100 }], trend: { ready: true, anchorIncome: 100, futureIncome: [0] }, enabled: true });
  assert.equal(zero.flows[0].income, 0);
});

test('unavailable or unsafe shared income trends cannot silently produce flat or unsafe forecasts', () => {
  const flows = [{ income: 100, expense: 1, saving: 2 }];
  const valid = { ready: true, anchorIncome: 100, futureIncome: [110] };
  const unavailable = applyIncomeTrend({ flows, trend: { ready: false, reason: 'Needs more history.' }, enabled: true });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.reason, 'Needs more history.');
  assert.equal(unavailable.flows, null);
  for (const trend of [{ ...valid, anchorIncome: 0 }, { ...valid, anchorIncome: 1.5 }, { ...valid, futureIncome: [] }, { ...valid, futureIncome: [-1] }, { ...valid, futureIncome: [1.5] }]) assert.equal(applyIncomeTrend({ flows, trend, enabled: true }).ready, false);
  const overflow = applyIncomeTrend({ flows: [{ income: Number.MAX_SAFE_INTEGER }], trend: { ...valid, futureIncome: [200] }, enabled: true });
  assert.equal(overflow.ready, false);
  assert.match(overflow.reason, /supported integer/);
  assert.equal(overflow.flows, null);
});
