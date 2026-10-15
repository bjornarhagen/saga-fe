import test from 'node:test';
import assert from 'node:assert/strict';
import { baseline, forecastHistory, project, shiftMonth } from '../src/lib/engine.js';
import { methodForecasts, historicalCash } from '../src/lib/forecast.js';
import { createStore } from '../src/server/database.js';

const tx = (date, amount, kind = 'expense', extra = {}) => ({ date, month: date.slice(0, 7), amount, kind, category: 'Synthetic', description: 'Synthetic', ...extra });
const months = ['2026-07', '2026-08', '2026-09'];
const transactions = months.flatMap((month, i) => [tx(`${month}-01`, (i + 1) * 1000, 'income', { regularIncome: true }), tx(`${month}-02`, -(i + 1) * 100), tx(`${month}-03`, -(i + 1) * 10, 'saving')]);
const inputs = { transactions, firstDate: '2026-07-01', historyAsOf: '2026-10-15', lookback: 3, assumptions: { income: 5000, expense: 500, saving: 50 }, cash: 10000, savings: 2000, buffer: 1000, adjustment: 0, oneOff: 0, horizon: 3, asOf: '2026-10-15' };
const byId = options => Object.fromEntries(methodForecasts({ ...inputs, ...options }).map(method => [method.id, method]));

test('comparison methods estimate flows independently and reconcile in integer øre', () => {
  const methods = byId();
  assert.equal(methods.unchanged.projection.monthlyNet, 4450);
  assert.equal(methods.average.projection.monthlyNet, 1780);
  assert.equal(methods.recent.projection.monthlyNet, 2670);
  assert.equal(methods.smoothed.projection.monthlyNet, 1611); // 1810 − 181 − 18
  assert.match(methods.seasonal.reason, /12 complete months; 3 available/);
  for (const method of Object.values(methods).filter(method => method.projection)) {
    assert.equal(method.projection.endBalance, inputs.cash + method.projection.points.reduce((sum, point) => sum + point.cashChange, 0));
    assert.ok(method.projection.points.every(point => Number.isSafeInteger(point.balance)));
  }
});

test('all history methods honor salary classification, exclusions, empty months and complete coverage', () => {
  const rows = [...transactions, tx('2026-09-04', 999999, 'income'), tx('2026-09-05', -999999, 'transfer'), tx('2026-09-06', -999999, 'expense', { excludeForecast: true }), tx('2026-10-01', -999999)];
  assert.deepEqual(baseline(rows, '2026-10-15', 3, '2026-07-01'), baseline(transactions, '2026-10-15', 3, '2026-07-01'));
  const methods = byId({ transactions: rows });
  assert.equal(methods.recent.projection.monthlyNet, 2670);
  const history = forecastHistory([tx('2026-06-15', -999), tx('2026-07-01', -100), tx('2026-09-01', -300)], '2026-10-15', 6, '2026-06-15');
  assert.deepEqual(history.series.map(point => point.expense), [100, 0, 300]);
  assert.deepEqual(forecastHistory([], '2026-10-15', 12, null).series, []);
  const noHistory = byId({ transactions: [], firstDate: null });
  assert.ok(noHistory.unchanged.projection);
  assert.ok(noHistory.average.reason);
  assert.equal(byId({ lookback: 1 }).smoothed.projection, null);
  assert.equal(byId({ cash: null, asOf: '' }).unchanged.projection, null);
});

test('forecast history cutoffs never use transactions after a past balance month', () => {
  const methods = byId({ historyAsOf: '2026-09-15', asOf: '2026-09-15' });
  assert.equal(methods.average.projection.monthlyNet, 1335); // July and August
  assert.equal(methods.recent.projection.monthlyNet, 1780);
});

test('scenario adjustments and one-off costs apply equally except to unchanged assumptions', () => {
  const normal = byId(), changed = byId({ adjustment: -50, oneOff: 500 });
  for (const id of ['average', 'recent', 'smoothed']) assert.equal(changed[id].projection.endBalance - normal[id].projection.endBalance, -350);
  assert.equal(changed.unchanged.projection.endBalance, normal.unchanged.projection.endBalance);
  assert.match(byId({ adjustment: -250 }).smoothed.reason, /negative/);
});

test('seasonal repeat aligns with the future calendar, repeats beyond a year, and ignores lookback', () => {
  const annual = Array.from({ length: 12 }, (_, i) => { const month = shiftMonth('2025-01', i); return [tx(`${month}-01`, 10000 + i * 100, 'income', { regularIncome: true }), tx(`${month}-02`, -1000 - i * 10), tx(`${month}-03`, -100, 'saving')]; }).flat();
  const seasonal = byId({ transactions: annual, firstDate: '2025-01-01', historyAsOf: '2026-01-31', asOf: '2026-01-31', lookback: 1, horizon: 24 }).seasonal;
  assert.equal(seasonal.reason, '');
  assert.equal(seasonal.projection.points[0].date, '2026-02-28');
  assert.equal(seasonal.projection.points[1].date, '2026-03-31');
  assert.equal(seasonal.projection.points[0].cashChange, 8990); // February
  assert.equal(seasonal.projection.points[11].cashChange, 8900); // January
  assert.equal(seasonal.projection.points[12].cashChange, seasonal.projection.points[0].cashChange);
  assert.equal(seasonal.projection.endBalance, inputs.cash + seasonal.projection.points.reduce((sum, point) => sum + point.cashChange, 0));
});

test('variable monthly cash flows track a temporary reserve need even when final cash recovers', () => {
  const p = project({ ...inputs, income: 0, expense: 0, horizon: 3, monthlyFlows: [{ income: 0, expense: 12000, saving: 0 }, { income: 5000, expense: 0, saving: 0 }, { income: 5000, expense: 0, saving: 0 }] });
  assert.deepEqual(p.points.map(point => point.balance), [-2000, 3000, 8000]);
  assert.equal(p.reserveNeeded, 3000);
  assert.equal(p.endReserveNeeded, 0);
  assert.equal(p.uncovered, 1000);
});

test('five-year projections retain anniversary dates, negative balances and exact øre', () => {
  const p = project({ cash: -1, income: 105, expense: 200, saving: 1, asOf: '2026-01-31', horizon: 60 });
  assert.equal(p.points.length, 60);
  assert.equal(p.points[24].date, '2028-02-29');
  assert.equal(p.points.at(-1).date, '2031-01-31');
  assert.equal(p.endBalance, -5761);
  for (const horizon of [0, 61, 1.5]) assert.throws(() => project({ ...inputs, horizon }), /horizon/);
});

test('displayed history reconstructs cash at checkpoints and keeps real one-offs and irregular income', () => {
  const rows = [tx('2026-07-15', -50), tx('2026-08-01', -100, 'expense', { excludeForecast: true }), tx('2026-08-20', 500, 'income'), tx('2026-09-01', -200, 'saving'), tx('2026-09-02', -99999, 'transfer'), tx('2026-10-16', 99999, 'income')];
  const params = { transactions: rows, firstDate: '2026-07-15', lastDate: '2026-10-16', cash: 1000, asOf: '2026-10-15', months: 3 };
  assert.deepEqual(historicalCash(params).map(point => [point.date, point.history]), [['2026-07-15', 800], ['2026-08-15', 700], ['2026-09-15', 1000]]);
  assert.deepEqual(historicalCash({ ...params, months: 0 }), []);
  assert.deepEqual(historicalCash({ ...params, firstDate: '2026-10-16' }), []);
  assert.deepEqual(historicalCash({ ...params, cash: null }), []);
  assert.deepEqual(historicalCash({ ...params, firstDate: '2026-09-20' }).map(point => point.date), ['2026-09-20']);
  assert.equal(historicalCash({ ...params, firstDate: '2026-07-01' })[0].date, '2026-07-15');
  assert.deepEqual(historicalCash({ ...params, lastDate: '2026-08-31' }).map(point => point.date), ['2026-07-15', '2026-08-15']);
  const clamped = historicalCash({ ...params, firstDate: '2025-01-01', lastDate: '2026-03-31', asOf: '2026-03-31', months: 3 });
  assert.deepEqual(clamped.map(point => point.date), ['2025-12-31', '2026-01-31', '2026-02-28']);
});

test('long horizon, comparison choices and chart history persist alongside legacy settings and edits', t => {
  const store = createStore(); t.after(() => store.close());
  store.saveSettings({ horizon: 3, fields: { cash: '-1.05' }, assumptions: { income: 500000 } });
  store.saveOverrides({ synthetic: { excludeForecast: true } });
  store.saveSettings({ horizon: 60, methods: ['average', 'seasonal'], historyMonths: 24 });
  assert.equal(store.getSettings().horizon, 60);
  assert.deepEqual(store.getSettings().methods, ['average', 'seasonal']);
  assert.equal(store.getSettings().historyMonths, 24);
  assert.equal(store.getSettings().fields.cash, '-1.05');
  assert.equal(store.getSettings().assumptions.income, 500000);
  assert.equal(store.getOverrides().synthetic.excludeForecast, true);
  store.saveSettings({ methods: [], historyMonths: 0 });
  assert.deepEqual(store.getSettings().methods, []);
  assert.equal(store.getSettings().historyMonths, 0);
  for (const settings of [{ horizon: 61 }, { historyMonths: -1 }, { historyMonths: 2 }, { methods: ['unknown'] }, { methods: ['average', 'average'] }, { methods: 'average' }]) assert.throws(() => store.saveSettings(settings));
});
