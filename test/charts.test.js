import test from 'node:test';
import assert from 'node:assert/strict';
import { timeSeriesChart, renderTimeSeriesChart, sparkline } from '../src/scripts/charts.js';
import { metricCardsMarkup } from '../src/scripts/statistics.js';
import { nearestPoint, tooltipMarkup } from '../src/scripts/chart-tooltips.js';

const chart = (points, options = {}) => timeSeriesChart({ points, series: [{ key: 'net', name: 'Cash change', color: 'var(--chart-4)' }], title: 'Synthetic cash movement', format: value => `${value} øre`, label: point => point.date, ...options });
const chartData = markup => JSON.parse(markup.match(/data-chart-data="([^"]+)"/)[1].replace(/&(?:quot|amp|lt|gt|#39);/g, entity => ({ '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" }[entity])));

test('charts handle zero, negative and single-point histories with exact accessible figures', () => {
  for (const points of [[{ date: '2026-01-01', net: 0 }], [{ date: '2026-01-01', net: -1 }, { date: '2026-01-02', net: 1 }], [{ date: '2026-01-01', net: -50000 }, { date: '2026-01-02', net: -60000 }]]) {
    for (const width of [280, 720]) {
      const output = chart(points, { width });
      assert.doesNotMatch(output, /NaN|Infinity|undefined/);
      assert.match(output, /<summary>View chart figures<\/summary>/);
      assert.match(output, /role="img"/);
      for (const point of points) assert.ok(output.includes(`<td class="numeric">${point.net} øre</td>`));
    }
  }
  assert.equal(chart([]), '<p class="no-results">No recorded activity in this date range.</p>');
});

test('grouped bars keep signed values and a second forecast line retains its own figures', () => {
  const points = [{ date: '2026-01-01', net: -105, original: 200 }, { date: '2026-02-01', net: 300, original: 400 }];
  const bars = chart(points, { type: 'bar' });
  assert.equal((bars.match(/<rect /g) || []).length, 2);
  assert.doesNotMatch(bars, /height="-/);
  const grouped = chartData(chart(points, { type: 'bar', series: [{ key: 'net', name: 'Scenario', color: 'var(--chart-4)' }, { key: 'original', name: 'Original', color: 'var(--chart-in)' }] }));
  assert.ok(grouped.points[0].rows[0].x < grouped.points[0].x);
  assert.ok(grouped.points[0].rows[1].x > grouped.points[0].x);
  const comparison = chart(points, { series: [{ key: 'net', name: 'Scenario', color: 'var(--chart-4)' }, { key: 'original', name: 'Unchanged', color: 'var(--chart-label)', dashed: true }], references: [{ name: 'Buffer', value: 250 }] });
  assert.match(comparison, /stroke-dasharray="6 5"/);
  assert.match(comparison, /Buffer 250 øre/);
  for (const amount of [-105, 200, 300, 400]) assert.ok(comparison.includes(`<td class="numeric">${amount} øre</td>`));
});

test('charts escape source labels and decorative sparklines do not invent a trend from one observation', () => {
  const output = chart([{ date: '<img src=x>', net: 105 }], { title: '" onload="example' });
  assert.doesNotMatch(output, /<img|aria-label="" onload/);
  assert.match(output, /&lt;img src=x&gt;/);
  assert.equal(sparkline([105]), '');
  assert.equal(sparkline([]), '');
  assert.doesNotMatch(sparkline([0, 0, 0]), /NaN|Infinity/);
  assert.match(sparkline([-100, 200, -50]), /aria-hidden="true"/);
});

test('interactive chart data retains full periods, signed exact values, counts and comparison context', () => {
  const points = [{ date: '2026-09-01', end: '2026-09-07', count: 12, net: -105, original: 200 }];
  const data = chartData(chart(points, {
    series: [{ key: 'net', name: 'Scenario', color: 'var(--chart-4)' }, { key: 'original', name: 'Unchanged', color: 'var(--chart-label)' }],
    references: [{ name: 'Buffer', value: 500 }],
    tooltipRows: point => [{ name: 'Difference', value: `${point.net - point.original} øre` }],
  }));
  assert.equal(data.points[0].period, '1 Sept 2026 – 7 Sept 2026');
  assert.equal(data.points[0].details, '12 recorded ledger entries');
  assert.deepEqual(data.points[0].rows.map(row => row.value), ['-105 øre', '200 øre']);
  assert.deepEqual(data.points[0].extra, [{ name: 'Buffer', value: '500 øre' }, { name: 'Difference', value: '-305 øre' }]);
  const output = tooltipMarkup(data, 0, 1);
  assert.match(output, /chart-tooltip-row selected/);
  assert.match(output, /-305 øre/);
});

test('sparklines expose their actual dates and øre amounts through one keyboard target', () => {
  const markup = sparkline([-105, 0, 315], 'var(--chart-4)', { title: 'Cash change', points: [{ month: '2026-07' }, { month: '2026-08' }, { month: '2026-09' }] });
  const data = chartData(markup);
  assert.deepEqual(data.points.map(point => point.period), ['July 2026', 'August 2026', 'September 2026']);
  assert.deepEqual(data.points.map(point => point.rows[0].value.replace(/\s/g, ' ')), ['−1,05 kr', '0,00 kr', '3,15 kr']);
  assert.equal((markup.match(/tabindex="0"/g) || []).length, 1);
  assert.match(markup, /preserveAspectRatio="none"/);
});

test('hover picking uses the nearest time point, including chart edges and single points', () => {
  const points = [{ x: 10 }, { x: 40 }, { x: 90 }];
  assert.equal(nearestPoint(points, -100), 0);
  assert.equal(nearestPoint(points, 39), 1);
  assert.equal(nearestPoint(points, 70), 2);
  assert.equal(nearestPoint(points, 1000), 2);
  assert.equal(nearestPoint([{ x: 20 }], 1000), 0);
});

test('tooltip text and payloads cannot turn imported names into executable markup', () => {
  const data = chartData(chart([{ date: '<img src=x onerror=example()>', net: 105 }], { title: '<script>example()</script>' }));
  const tooltip = tooltipMarkup(data, 0);
  assert.doesNotMatch(tooltip, /<script>|<img/);
  assert.match(tooltip, /&lt;script&gt;/);
  assert.match(tooltip, /&lt;img/);
});


test('logarithmic charts retain signed and zero amounts, exact figures and reference lines', () => {
  const points = [-1000000, -10000, -1, 0, 1, 10000, 1000000].map((net, i) => ({ date: `2026-01-0${i + 1}`, net }));
  for (const type of ['line', 'bar']) {
    const output = chart(points, { scale: 'log', type, references: [{ name: 'Buffer', value: -5000 }] });
    const data = chartData(output);
    assert.equal(data.scale, 'log');
    assert.match(output, /Logarithmic scale/);
    assert.doesNotMatch(output, /data-chart-scale/);
    assert.doesNotMatch(output, /NaN|Infinity|undefined|height="-/);
    const y = data.points.map(point => point.rows[0].y);
    assert.ok(y.every((value, i) => i === 0 || value < y[i - 1]));
    assert.ok(Math.abs((y[0] + y.at(-1)) / 2 - y[3]) < 0.0001);
    assert.deepEqual(data.points.map(point => point.rows[0].value), points.map(point => `${point.net} øre`));
    assert.ok(data.points.every(point => point.extra[0].value === '-5000 øre'));
    for (const point of points) assert.ok(output.includes(`<td class="numeric">${point.net} øre</td>`));
  }
});

test('log scale makes orders of magnitude comparable and handles zero or tiny constant histories', () => {
  const points = [10000, 100000, 1000000].map((net, i) => ({ date: `2026-01-0${i + 1}`, net }));
  const linear = chartData(chart(points)).points.map(point => point.rows[0].y);
  const logarithmic = chartData(chart(points, { scale: 'log' })).points.map(point => point.rows[0].y);
  assert.ok(linear[1] - linear[2] > 8 * (linear[0] - linear[1]));
  assert.ok(Math.abs((logarithmic[0] - logarithmic[1]) / (logarithmic[1] - logarithmic[2]) - 1) < 0.01);
  for (const net of [0, 1, -1, 1000000000]) {
    const output = chart([{ date: '2026-01-01', net }], { scale: 'log' });
    assert.doesNotMatch(output, /NaN|Infinity|undefined/);
    const y = chartData(output).points[0].rows[0].y;
    assert.ok(y >= 12 && y <= 220);
  }
  assert.equal(chartData(chart(points, { scale: 'unexpected' })).scale, 'linear');
});

test('one page scale controls multiple charts, survives data redraws, and retains open figures', () => {
  const page = () => ({ control: { value: 'linear' }, note: { hidden: true }, querySelector(selector) { return selector === '[data-page-chart-scale]' ? this.control : this.note; } });
  const overview = page(), otherPage = page();
  const container = view => ({
    innerHTML: '', details: { open: false }, closest: () => view,
    querySelector() { return this.details; },
  });
  const first = container(overview), second = container(overview), other = container(otherPage);
  const options = { points: [{ date: '2026-01-01', net: 100 }], series: [{ key: 'net', name: 'Cash', color: 'var(--chart-4)' }], title: 'Synthetic cash', format: String, label: point => point.date };
  for (const target of [first, second, other]) renderTimeSeriesChart(target, options);
  overview.control.value = 'log';
  first.details.open = true;
  for (const target of [first, second, other]) renderTimeSeriesChart(target, options);
  assert.equal(chartData(first.innerHTML).scale, 'log');
  assert.equal(chartData(second.innerHTML).scale, 'log');
  assert.equal(chartData(other.innerHTML).scale, 'linear');
  assert.equal(overview.note.hidden, false);
  assert.equal(first.details.open, true);
  renderTimeSeriesChart(first, { ...options, width: 320, points: [{ date: '2026-01-02', net: -500 }] });
  assert.equal(chartData(first.innerHTML).scale, 'log');
  assert.equal(chartData(first.innerHTML).points[0].rows[0].value, '-500');
  overview.control.value = 'linear';
  renderTimeSeriesChart(first, options);
  assert.equal(chartData(first.innerHTML).scale, 'linear');
  assert.equal(overview.note.hidden, true);
  overview.control.value = 'sqrt';
  for (const target of [first, second]) renderTimeSeriesChart(target, options);
  assert.equal(chartData(first.innerHTML).scale, 'sqrt');
  assert.equal(chartData(second.innerHTML).scale, 'sqrt');
  assert.match(overview.note.textContent, /outliers/);
});

test('statistic sparklines use the page scale and retain exact tooltip values', () => {
  const items = [{ label: 'Cash change', value: '9 kr', values: [-100, 0, 1000], trendPoints: [{ date: '2026-01-01' }, { date: '2026-01-02' }, { date: '2026-01-03' }] }];
  const linear = chartData(metricCardsMarkup(items));
  const squareRoot = chartData(metricCardsMarkup(items, { scale: 'sqrt' }));
  assert.equal(squareRoot.scale, 'sqrt');
  assert.deepEqual(squareRoot.points.map(point => point.rows[0].value), linear.points.map(point => point.rows[0].value));
  const logarithmic = chartData(metricCardsMarkup(items, { scale: 'log' }));
  assert.equal(logarithmic.scale, 'log');
  assert.notEqual(linear.points[1].rows[0].y, logarithmic.points[1].rows[0].y);
  assert.deepEqual(logarithmic.points.map(point => point.rows[0].value), linear.points.map(point => point.rows[0].value));
});

test('square root gives everyday amounts room without magnifying tiny amounts like log', () => {
  // User-shaped synthetic amounts: 1–10 kr, 100–2,000 kr and a 30,000 kr outlier.
  const points = [0, 100, 1000, 10000, 200000, 3000000].map((net, i) => ({ date: `2026-01-0${i + 1}`, net }));
  const positions = scale => chartData(chart(points, { scale })).points.map(point => point.rows[0].y);
  const linear = positions('linear'), sqrt = positions('sqrt'), log = positions('log');
  const height = 220 - 12;
  const everyday = values => (values[3] - values[4]) / height;
  const tiny = values => (values[1] - values[2]) / height;
  assert.ok(everyday(sqrt) > 0.19 && everyday(sqrt) < 0.21);
  assert.ok(everyday(sqrt) > 3 * everyday(linear));
  assert.ok(tiny(sqrt) < 0.015);
  assert.ok(tiny(log) > 10 * tiny(sqrt));
  const output = chart(points, { scale: 'sqrt' });
  assert.match(output, /Square root scale/);
  assert.equal(chartData(output).scale, 'sqrt');
});

test('square root preserves signed values, zero, references and exact financial figures', () => {
  for (const amounts of [[-3000000, -200000, -1, 0, 1, 200000, 3000000], [0], [1], [-1], [50000, 50000]]) {
    const points = amounts.map((net, i) => ({ date: `2026-01-0${i + 1}`, net }));
    for (const type of ['line', 'bar']) {
      const output = chart(points, { scale: 'sqrt', type, references: [{ name: 'Buffer', value: 500 }] });
      assert.doesNotMatch(output, /NaN|Infinity|undefined|height="-/);
      const data = chartData(output);
      assert.deepEqual(data.points.map(point => point.rows[0].value), amounts.map(value => `${value} øre`));
      for (const point of data.points) {
        assert.ok(point.rows[0].y >= 12 && point.rows[0].y <= 220);
        assert.equal(point.extra[0].value, '500 øre');
      }
      for (const amount of amounts) assert.ok(output.includes(`<td class="numeric">${amount} øre</td>`));
      if (amounts.length === 7) {
        const y = data.points.map(point => point.rows[0].y);
        assert.ok(y.every((value, i) => i === 0 || value < y[i - 1]));
        assert.ok(Math.abs((y[0] + y.at(-1)) / 2 - y[3]) < 0.0001);
      }
    }
  }
});


test('pages inherit the browser default while explicit page overrides take priority', () => {
  const root = { dataset: { chartScaleDefault: 'sqrt' } };
  const control = { value: 'default' }, note = {};
  const page = { querySelector: selector => selector === '[data-page-chart-scale]' ? control : note };
  const container = { ownerDocument: { documentElement: root }, closest: () => page, querySelector: () => null, innerHTML: '' };
  const options = { points: [{ date: '2026-01-01', net: 100 }], series: [{ key: 'net', name: 'Cash', color: 'var(--chart-4)' }], title: 'Synthetic cash', format: String, label: point => point.date };
  renderTimeSeriesChart(container, options);
  assert.equal(chartData(container.innerHTML).scale, 'sqrt');
  root.dataset.chartScaleDefault = 'log';
  renderTimeSeriesChart(container, options);
  assert.equal(chartData(container.innerHTML).scale, 'log');
  control.value = 'linear';
  root.dataset.chartScaleDefault = 'sqrt';
  renderTimeSeriesChart(container, options);
  assert.equal(chartData(container.innerHTML).scale, 'linear');
  control.value = 'default';
  renderTimeSeriesChart(container, options);
  assert.equal(chartData(container.innerHTML).scale, 'sqrt');
});

test('forecast lines fit the balance range in every scale without distant buffers flattening them', () => {
  const points = [{ date: '2026-01-01', net: 5000000, original: 5000000 }, { date: '2026-02-01', net: 6500000, original: 6400000 }, { date: '2026-03-01', net: 8000000, original: 7800000 }];
  for (const scale of ['linear', 'sqrt', 'log']) {
    const output = chart(points, { scale, series: [{ key: 'net', name: 'Scenario', color: 'var(--chart-4)' }, { key: 'original', name: 'Unchanged', color: 'var(--chart-label)' }], references: [{ name: 'Cash buffer', value: 500000 }, { name: 'Distant target', value: 20000000 }] });
    const data = chartData(output);
    assert.ok(data.domain.min > 4000000 && data.domain.min < 5000000);
    assert.ok(data.domain.max > 8000000 && data.domain.max < 9000000);
    const occupied = (data.points[0].rows[0].y - data.points.at(-1).rows[0].y) / (data.bottom - data.top);
    assert.ok(occupied > 0.8, `${scale}: balances should occupy most of the plot`);
    assert.match(output, /Cash buffer 500000 øre · below range/);
    assert.match(output, /Distant target 20000000 øre · above range/);
    assert.match(output, /Auto range/);
    assert.doesNotMatch(output, /stroke-dasharray="5 5"/);
    assert.deepEqual(data.points[0].extra.map(row => row.value), ['500000 øre', '20000000 øre']);
    assert.deepEqual(data.points.map(point => point.rows[0].value), points.map(point => `${point.net} øre`));
    for (const amount of [5000000, 6500000, 8000000, 6400000, 7800000]) assert.ok(output.includes(`<td class="numeric">${amount} øre</td>`));
    const nearBuffer = chart(points, { scale, references: [{ name: 'Nearby buffer', value: 6000000 }] });
    assert.match(nearBuffer, /stroke-dasharray="5 5"/);
    assert.doesNotMatch(nearBuffer, /below range|above range/);
  }
});

test('line auto-range follows positive, negative, zero-crossing and filtered account histories', () => {
  const histories = [[2500000, 4200000], [-8000000, -5000000], [-50000, 50000], [0, 4200000], [5000000, 5000001], [5000000], [0, 0]];
  for (const scale of ['linear', 'sqrt', 'log']) for (const amounts of histories) {
    const points = amounts.map((net, i) => ({ date: `2026-01-0${i + 1}`, net }));
    const output = chart(points, { scale });
    const data = chartData(output), { min, max } = data.domain;
    assert.doesNotMatch(output, /NaN|Infinity|undefined/);
    assert.ok(min < max && min <= Math.min(...amounts) && max >= Math.max(...amounts));
    assert.ok(data.points.every(point => point.rows[0].y >= data.top && point.rows[0].y <= data.bottom));
    if (amounts.every(value => value > 0)) assert.ok(min > 0);
    if (amounts.every(value => value < 0)) assert.ok(max < 0);
    if (amounts.includes(0)) assert.equal(min, 0);
    if (amounts[0] === 5000000) assert.ok(max - min < 500000);
  }
});

test('bars keep a zero baseline while fitted line and sparkline fills stay inside the plot', () => {
  for (const scale of ['linear', 'sqrt', 'log']) {
    const points = [{ date: '2026-01-01', net: 5000000 }, { date: '2026-02-01', net: 8000000 }];
    assert.equal(chartData(chart(points, { scale, type: 'bar' })).domain.min, 0);
    assert.equal(chartData(chart(points.map(point => ({ ...point, net: -point.net })), { scale, type: 'bar' })).domain.max, 0);
    for (const markup of [chart(points, { scale }), sparkline(points.map(point => point.net), 'var(--chart-4)', { scale })]) {
      const data = chartData(markup);
      assert.ok(data.domain.min > 0);
      const area = markup.match(/<path d="([^"]+)" fill=/)[1];
      for (const match of area.matchAll(/[ML]([-\d.]+),([-\d.]+)/g)) {
        const y = Number(match[2]);
        assert.ok(y >= data.top && y <= data.bottom, `${scale}: area should stay in the plot`);
      }
    }
  }
});

test('a fitted axis keeps large, close tick amounts distinguishable', () => {
  const output = chart([{ date: '2026-01-01', net: 100000000 }, { date: '2026-02-01', net: 100000001 }]);
  const svg = output.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)[1];
  const labels = [...svg.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]+)<\/text>/g)].map(match => match[1]);
  assert.ok(labels.length >= 2);
  assert.equal(new Set(labels).size, labels.length);
});

test('history and future branches meet without inventing values in missing periods', () => {
  const points = [{ date: '2026-07-15', history: 200 }, { date: '2026-08-15', history: 100, net: 100, alternate: 100, starting: true }, { date: '2026-09-15', net: -50, alternate: 150 }];
  const series = [{ key: 'history', name: 'Recorded history', color: 'var(--chart-6)' }, { key: 'net', name: 'Scenario', color: 'var(--chart-4)' }, { key: 'alternate', name: 'Alternative', color: 'var(--chart-1)' }];
  for (const scale of ['linear', 'sqrt', 'log']) {
    const output = chart(points, { series, scale, markers: [{ index: 1, name: 'Forecast starts' }], timeSpacing: true });
    const data = chartData(output);
    assert.doesNotMatch(output, /NaN|Infinity|undefined/);
    assert.match(output, /Forecast starts/);
    assert.match(output, /<td class="numeric">—<\/td>/);
    assert.deepEqual(data.points[0].rows.map(row => row.name), ['Recorded history']);
    assert.deepEqual(data.points[2].rows.map(row => row.name), ['Scenario', 'Alternative']);
    assert.match(tooltipMarkup(data, 2, 1), /chart-tooltip-row selected/);
    assert.ok(data.points.every(point => point.rows.every(row => Number.isFinite(row.y))));
  }
});

test('time-spaced forecasts respect a partial earliest history interval', () => {
  const points = [{ date: '2026-08-14', net: 100 }, { date: '2026-08-15', net: 200 }, { date: '2026-09-15', net: 300 }];
  const data = chartData(chart(points, { timeSpacing: true }));
  assert.ok(data.points[1].x - data.points[0].x < (data.points[2].x - data.points[1].x) / 20);
});
