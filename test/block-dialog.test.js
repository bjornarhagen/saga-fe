import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlockSession } from '../src/scripts/block-dialog.js';
import { chartBlock, timeSeriesChart } from '../src/scripts/charts.js';
import { statisticBlock } from '../src/scripts/statistics.js';
import { rankingBlock } from '../src/scripts/ranking-dialog.js';

const options = () => ({
  title: 'Synthetic activity', scale: 'sqrt', type: 'bar',
  points: [{ date: '2026-01-01', income: 105, expense: -205 }, { date: '2026-02-01', income: 305, expense: 0 }],
  series: [{ key: 'income', name: 'Money in', color: 'var(--chart-in)' }, { key: 'expense', name: 'Spending', color: 'var(--chart-out)' }],
  format: value => `${value} øre`, label: point => point.date,
});
const target = () => ({ innerHTML: '', clientWidth: 1100, figures: {}, querySelector() { return this.figures; } });

test('dialog options, selected series and resets are isolated from the page and other sessions', () => {
  const page = options();
  const pageBefore = timeSeriesChart(page);
  const block = chartBlock(page);
  const first = createBlockSession(block), second = createBlockSession(block);
  first.options.scale = 'log'; first.options.type = 'line'; first.options.series.splice(1, 1); first.options.figures = true;
  const output = target(); first.render(output);
  assert.match(output.innerHTML, /Logarithmic scale/);
  assert.doesNotMatch(output.innerHTML, /<rect |Spending/);
  assert.match(output.innerHTML, /105 øre/);
  assert.match(output.innerHTML, /1100 420/);
  assert.equal(output.figures.open, true);
  assert.deepEqual(second.options, block.initial);
  assert.equal(timeSeriesChart(page), pageBefore);
  first.reset();
  assert.deepEqual(first.options, second.options);
  first.options.series.pop();
  assert.equal(block.initial.series.length, 2);
  assert.equal(createBlockSession(block).options.series.length, 2);
});

test('dialog data remains a snapshot when the page data changes or a new descriptor is registered', () => {
  const page = options();
  const session = createBlockSession(chartBlock(page));
  page.points[0].income = 999; page.series[0].name = 'Changed on page'; page.points.push({ date: '2026-03-01', income: 999 });
  const output = target(); session.render(output);
  assert.match(output.innerHTML, /105 øre/);
  assert.doesNotMatch(output.innerHTML, /999 øre|Changed on page/);
  const next = target(); createBlockSession(chartBlock(page)).render(next);
  assert.match(next.innerHTML, /999 øre/);
});

test('empty series is recoverable and empty histories render without stale data', () => {
  const session = createBlockSession(chartBlock(options()));
  session.options.series = [];
  const output = target(); session.render(output);
  assert.match(output.innerHTML, /Select a series/);
  session.reset(); session.render(output);
  assert.match(output.innerHTML, /105 øre/);
  createBlockSession(chartBlock({ ...options(), points: [] })).render(output);
  assert.match(output.innerHTML, /No recorded activity/);
  assert.doesNotMatch(output.innerHTML, /105 øre/);
});

test('expanded statistic trends retain signed exact values and supplied units', () => {
  const item = { label: 'Recorded days', value: '2 days', values: [0, 2], trendFormat: value => `${value} days`, trendPoints: [{ date: '2026-01-01' }, { date: '2026-02-01' }] };
  const session = createBlockSession(statisticBlock(item, 'log'));
  const trendTarget = target();
  const output = { innerHTML: '', note: {}, querySelector(selector) { return selector === '.stat-note' ? this.note : trendTarget; } };
  item.values[1] = 99;
  session.options.notes = false;
  session.render(output);
  assert.equal(output.note.hidden, true);
  assert.match(trendTarget.innerHTML, /2 days/);
  assert.doesNotMatch(trendTarget.innerHTML, /99 days/);
  assert.equal(session.options.scale, 'log');
  const noTrend = createBlockSession(statisticBlock({ label: 'No history', value: '—' }, 'sqrt'));
  assert.equal(noTrend.controls.length, 1);
});

test('breakdown options show all rows, sort locally, and escape source labels', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ name: i ? `Merchant ${i}` : '<script>example()</script>', amount: (i + 1) * 100 }));
  const session = createBlockSession(rankingBlock('Synthetic merchants', rows, String));
  const output = target(); session.render(output);
  assert.equal((output.innerHTML.match(/class="expanded-ranking-row"/g) || []).length, 12);
  assert.match(output.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(output.innerHTML, /<script>/);
  session.options.limit = '6'; session.options.order = 'name'; session.options.bars = false; session.render(output);
  assert.equal((output.innerHTML.match(/class="expanded-ranking-row"/g) || []).length, 6);
  assert.doesNotMatch(output.innerHTML, /bar-track/);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].amount, 100);
});
