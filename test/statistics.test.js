import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, previousPeriod, periodStatistics, comparePeriods, ratio, activitySeries, automaticGrouping } from '../src/lib/statistics.js';
import { changeText, statisticsMarkup } from '../src/scripts/statistics.js';
import { applyOverrides } from '../src/lib/engine.js';

const transaction = (date, amount, kind = 'expense', extra = {}) => ({ id: date + amount, date, month: date.slice(0, 7), amount, kind, description: 'Synthetic payment', category: 'Food', ...extra });
const coverage = { firstDate: '2026-01-01', lastDate: '2026-10-14' };

test('comparison ranges use calendar months, equal custom days, and leap years', () => {
  assert.deepEqual(previousPeriod({ start: '2026-07-01', end: '2026-09-30' }, '3'), { start: '2026-04-01', end: '2026-06-30' });
  assert.deepEqual(previousPeriod({ start: '2026-01-01', end: '2026-03-31' }, '3'), { start: '2025-10-01', end: '2025-12-31' });
  assert.deepEqual(previousPeriod({ start: '2024-03-01', end: '2024-03-14' }, 'current'), { start: '2024-02-01', end: '2024-02-14' });
  assert.equal(previousPeriod({ start: '2024-03-01', end: '2024-03-30' }, 'current'), null);
  assert.deepEqual(previousPeriod({ start: '2026-03-05', end: '2026-03-07' }, 'custom'), { start: '2026-03-02', end: '2026-03-04' });
  assert.equal(calendarDays('2024-02-01', '2024-02-29'), 29);
  assert.equal(calendarDays('2026-03-28', '2026-03-30'), 3);
  assert.equal(previousPeriod({ start: '2026-03-07', end: '2026-03-05' }, 'custom'), null);
  assert.equal(previousPeriod({ start: '2026-01-01', end: '2026-10-14' }, 'all'), null);
});

test('spending statistics keep integer øre, include one-offs, and exclude transfers, savings and refunds', () => {
  const rows = [transaction('2026-09-03', -105), transaction('2026-09-04', -210, 'expense', { excludeForecast: true }), transaction('2026-09-05', -90000, 'transfer'), transaction('2026-09-06', 90000, 'transfer'), transaction('2026-09-07', -10000, 'saving'), transaction('2026-09-08', 40000, 'income'), transaction('2026-09-09', 500, 'income'), transaction('2026-08-31', -999999)];
  const result = periodStatistics(rows, { start: '2026-09-01', end: '2026-09-30' }, coverage);
  assert.equal(result.days, 30);
  assert.equal(result.dailySpending, 11);
  assert.equal(result.medianPayment, 158);
  assert.equal(result.spendingPayments, 2);
  assert.equal(result.largestPayment.amount, -210);
  assert.equal(result.totals.net, 30185);
  assert.equal(result.savingsRate, 10000 / 40500 * 100);
  const edited = applyOverrides(rows, { [rows[1].id]: { kind: 'transfer' } });
  assert.equal(periodStatistics(edited, { start: '2026-09-01', end: '2026-09-30' }, coverage).medianPayment, 105);
});

test('daily averages use covered calendar days and distinguish empty data from recorded zero spending', () => {
  const range = { start: '2026-09-01', end: '2026-09-30' };
  assert.equal(periodStatistics([], range).dailySpending, null);
  const empty = periodStatistics([], range, coverage);
  assert.equal(empty.dailySpending, 0);
  assert.equal(empty.medianPayment, null);
  assert.equal(empty.largestPayment, null);
  assert.equal(empty.savingsRate, null);
  const partial = periodStatistics([transaction('2026-09-15', -10000)], range, { firstDate: '2026-09-15', lastDate: '2026-09-19' });
  assert.equal(partial.days, 5);
  assert.equal(partial.dailySpending, 2000);
  assert.equal(periodStatistics([], { start: '2027-01-01', end: '2027-01-31' }, coverage).days, 0);
});

test('comparisons require full coverage of both periods and preserve real zero periods', () => {
  const range = { start: '2026-09-01', end: '2026-09-30' };
  const rows = [transaction('2026-09-02', -1000)];
  assert.equal(comparePeriods(rows, range, '1', coverage).totals.expense, 0);
  assert.equal(comparePeriods(rows, range, '1', { ...coverage, firstDate: '2026-08-02' }), null);
  assert.equal(comparePeriods(rows, range, '1', { ...coverage, lastDate: '2026-09-29' }), null);
  assert.equal(comparePeriods(rows, range, 'all', coverage), null);
});

test('ratios and changes handle zero and negative bases without misleading percentages', () => {
  const money = amount => amount + ' øre';
  assert.equal(ratio(50, 0), null);
  assert.equal(ratio(50, -1), null);
  assert.equal(ratio(150, 100), 150);
  assert.equal(changeText(100, 0, money), '↑ 100 øre');
  assert.equal(changeText(100, -100, money), '↑ 200 øre');
  assert.equal(changeText(50, 100, money), '↓ 50%');
  assert.equal(changeText(0, 0, money), 'Unchanged');
});

test('statistic text escapes imported content and local links', () => {
  const markup = statisticsMarkup([{ label: '<label>', value: '10 kr', note: '<img src=x onerror=alert(1)>', href: '#transactions/a"b' }]);
  assert.ok(markup.includes('&lt;img'));
  assert.ok(markup.includes('#transactions/a&quot;b'));
  assert.ok(!markup.includes('<img'));
});

test('time buckets preserve exact filtered totals and fill gaps inside recorded coverage', () => {
  const range = { start: '2026-08-01', end: '2026-10-31' };
  const rows = [transaction('2026-08-05', -105), transaction('2026-10-10', -210, 'saving'), transaction('2026-10-14', 500), transaction('2026-09-01', -999, 'transfer')];
  const monthly = activitySeries(rows, range, coverage, 'month');
  assert.deepEqual(monthly.points.map(point => [point.date, point.end, point.income, point.expense, point.saving, point.net]), [
    ['2026-08-01', '2026-08-31', 0, 105, 0, -105],
    ['2026-09-01', '2026-09-30', 0, 0, 0, 0],
    ['2026-10-01', '2026-10-14', 500, 0, 210, 290],
  ]);
  for (const interval of ['day', 'week', 'month', 'auto']) {
    const result = activitySeries(rows, range, coverage, interval);
    assert.equal(result.points.reduce((sum, point) => sum + point.net, 0), 185);
    assert.equal(result.points.reduce((sum, point) => sum + point.count, 0), 4);
  }
  assert.equal(activitySeries(rows, range, coverage).interval, 'week');
});

test('time buckets clip partial months and days, cross years, and retain empty scopes', () => {
  const range = { start: '2025-12-01', end: '2026-02-15' };
  const partialCoverage = { firstDate: '2025-12-20', lastDate: '2026-01-03' };
  const monthly = activitySeries([], range, partialCoverage, 'month');
  assert.deepEqual(monthly.points.map(point => [point.date, point.end]), [['2025-12-20', '2025-12-31'], ['2026-01-01', '2026-01-03']]);
  assert.equal(activitySeries([], range, partialCoverage).interval, 'day');
  assert.deepEqual(activitySeries([], range, {}).points, []);
  assert.deepEqual(activitySeries([], { start: '2027-01-01', end: '2027-02-01' }, coverage).points, []);
  assert.deepEqual(activitySeries([], { start: '2026-02-01', end: '2026-01-01' }, coverage).points, []);
});


test('overview grouping defaults follow the selected duration, with short custom ranges and invalid dates handled', () => {
  assert.equal(automaticGrouping({ start: '2026-07-01', end: '2026-09-30' }), 'week');
  assert.equal(automaticGrouping({ start: '2025-10-01', end: '2026-09-30' }), 'month');
  assert.equal(automaticGrouping({ start: '2026-09-01', end: '2026-09-30' }), 'day');
  assert.equal(automaticGrouping({ start: '2026-10-01', end: '2026-10-14' }), 'day');
  assert.equal(automaticGrouping({ start: '2026-02-01', end: '2026-01-01' }), 'day');
});
