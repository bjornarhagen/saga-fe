import { pageChartScale, normalizeChartScale, chartScaleLabel } from './page-chart-scale.js';
import { CHART_SCALES } from './page-chart-scale.js';
import { registerBlock } from './block-dialog.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
const compactDetailed = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 3 });
const precise = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 2 });
const amountText = value => Math.abs(value) < 10000 ? precise.format(value / 100) : compact.format(value / 100);
const exact = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateLabel = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) ? dateFormat.format(new Date(date + 'T12:00:00Z')) : String(date);

function pointPeriod(point, fallback) {
  if (point.month && /^\d{4}-\d{2}$/.test(point.month) && Number.isFinite(Date.parse(point.month + '-01T12:00:00Z'))) return monthFormat.format(new Date(point.month + '-01T12:00:00Z'));
  if (!point.date) return fallback;
  const start = dateLabel(point.date);
  return point.starting ? `Starting point · ${start}` : point.end && point.end !== point.date ? `${start} – ${dateLabel(point.end)}` : start;
}

function pointDetails(point) {
  if (Number.isInteger(point.payments)) return `${point.payments} recorded payment${point.payments === 1 ? '' : 's'}`;
  if (Number.isInteger(point.count)) return `${point.count} recorded ledger entr${point.count === 1 ? 'y' : 'ies'}`;
  return '';
}

function interactivePlot(svg, data, classes = '') {
  return `<div class="chart-plot ${classes}" tabindex="0" role="group" aria-label="${esc(data.title)}.${data.scale ? ` ${chartScaleLabel(data.scale)} scale.` : ''} Use Left and Right Arrow to inspect points; Escape to dismiss." data-chart-data="${esc(JSON.stringify(data))}">${svg}</div>`;
}

function fittedGeometry(values, width, height, padding, scale) {
  const [top, right, bottom, left] = padding;
  const dataMin = Math.min(...values), dataMax = Math.max(...values);
  // Leave breathing room, with a modest minimum span for flat or nearly flat
  // balances so a few øre of noise cannot become a full-height movement.
  const span = Math.max(dataMax - dataMin, Math.max(Math.abs(dataMin), Math.abs(dataMax)) * .02, 100);
  const center = dataMin + (dataMax - dataMin) / 2;
  let min = Math.floor(center - span * .58), max = Math.ceil(center + span * .58);
  if (dataMin >= 0) min = Math.max(0, min);
  if (dataMax <= 0) max = Math.min(0, max);
  if (min === max) { min = 0; max = 100; }
  const transform = scale === 'log' ? value => Math.sign(value) * Math.log10(1 + Math.abs(value) / 100)
    : scale === 'sqrt' ? value => Math.sign(value) * Math.sqrt(Math.abs(value)) : value => value;
  const low = transform(min), high = transform(max);
  const y = value => top + (height - top - bottom) * (high - transform(value)) / (high - low);
  const step = 10 ** Math.floor(Math.log10((max - min) / 4));
  const tick = Math.max(1, [1, 2, 5, 10].map(n => n * step).find(n => n >= (max - min) / 4));
  const candidates = [0];
  for (let value = Math.floor(max / tick) * tick; value >= min; value -= tick) candidates.push(value);
  if (scale !== 'linear') {
    for (let power = Math.floor(Math.log10(Math.max(-min, max))); power >= 0; power--) {
      for (const factor of [5, 2, 1]) for (const sign of [-1, 1]) candidates.push(sign * factor * 10 ** power);
    }
  }
  const ticks = [];
  for (const value of candidates) {
    if (value >= min && value <= max && ticks.every(existing => Math.abs(y(existing) - y(value)) >= 28)) ticks.push(value);
  }
  return { min, max, ticks: ticks.sort((a, b) => a - b), y, left, right: width - right, bottom: height - bottom };
}

function geometry(values, width, height, padding, scale = 'linear', includeZero = false) {
  if (!includeZero) return fittedGeometry(values, width, height, padding, scale);
  const [top, right, bottom, left] = padding;
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  if (min === max) max = min + 100;
  if (scale === 'log') {
    // Symmetric log uses a 1 kr constant. It is approximately linear near
    // zero and logarithmic for larger magnitudes, retaining signed øre values.
    const transform = value => Math.sign(value) * Math.log10(1 + Math.abs(value) / 100);
    const extent = value => 100 * 10 ** Math.ceil(Math.log10(Math.abs(value) / 100));
    min = min < 0 ? -extent(min) : 0; max = max > 0 ? extent(max) : 0;
    const low = transform(min), high = transform(max);
    const y = value => top + (height - top - bottom) * (high - transform(value)) / (high - low);
    const ticks = [...new Set([min, 0, max])];
    const exponent = Math.ceil(Math.log10(Math.max(-min, max) / 100));
    // Prefer decade labels, omitting those that crowd zero on a small plot.
    for (let power = exponent; power >= -2; power--) for (const sign of [-1, 1]) {
      const value = sign * Math.round(100 * 10 ** power);
      if (value >= min && value <= max && ticks.every(tick => Math.abs(y(tick) - y(value)) >= 28)) ticks.push(value);
    }
    return { min, max, ticks: ticks.sort((a, b) => a - b), y, left, right: width - right, bottom: height - bottom };
  }
  const step = 10 ** Math.floor(Math.log10((max - min) / 4));
  const tick = Math.max(1, [1, 2, 5, 10].map(n => n * step).find(n => n >= (max - min) / 4));
  min = Math.floor(min / tick) * tick; max = Math.ceil(max / tick) * tick;
  if (scale === 'sqrt') {
    // A signed power scale (exponent 0.5) softens outliers more gently than
    // log, with no currency-dependent tuning or loss of zero/negative values.
    const transform = value => Math.sign(value) * Math.sqrt(Math.abs(value));
    const low = transform(min), high = transform(max);
    const y = value => top + (height - top - bottom) * (high - transform(value)) / (high - low);
    const ticks = [...new Set([min, 0, max])];
    for (let power = Math.floor(Math.log10(Math.max(-min, max))); power >= 0; power--) {
      for (const factor of [5, 2, 1]) for (const sign of [-1, 1]) {
        const value = sign * factor * 10 ** power;
        if (value >= min && value <= max && ticks.every(tick => Math.abs(y(tick) - y(value)) >= 28)) ticks.push(value);
      }
    }
    return { min, max, ticks: ticks.sort((a, b) => a - b), y, left, right: width - right, bottom: height - bottom };
  }
  const y = value => top + (height - top - bottom) * (max - value) / (max - min);
  const ticks = [];
  for (let value = min; value <= max; value += tick) ticks.push(value);
  return { min, max, ticks, y, left, right: width - right, bottom: height - bottom };
}
const pathFor = (values, x, y) => values.map((value, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(value).toFixed(2)}`).join(' ');

export function sparkline(values, color = 'var(--chart-1)', { title = 'Trend', points = [], format = value => `${exact.format(value / 100)} kr`, scale = 'linear' } = {}) {
  if (values.length < 2) return '';
  scale = normalizeChartScale(scale);
  const g = geometry(values, 240, 64, [6, 3, 5, 3], scale);
  const x = i => g.left + (g.right - g.left) * i / (values.length - 1);
  const path = pathFor(values, x, g.y);
  const baseline = g.y(Math.max(g.min, Math.min(g.max, 0)));
  const svg = `<svg class="stat-sparkline" viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true"><path d="${path} L${g.right},${baseline} L${g.left},${baseline} Z" fill="${color}" fill-opacity=".09"/><path d="${path}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><path d="M${g.right},${g.y(values.at(-1))} l0,0" stroke="${color}" stroke-width="6" stroke-linecap="round" vector-effect="non-scaling-stroke"/><g class="chart-selection" aria-hidden="true"></g></svg>`;
  return interactivePlot(svg, { title, scale, domain: { min: g.min, max: g.max }, left: g.left, right: g.right, top: 0, bottom: 64, points: values.map((value, i) => ({ x: x(i), period: pointPeriod(points[i] || {}, `Point ${i + 1}`), details: pointDetails(points[i] || {}), rows: [{ name: title, value: format(value), color, y: g.y(value) }] })) }, 'chart-plot-sparkline');
}

// Each visual includes exact figures in a keyboard-accessible table. Series
// descriptors and colors are application constants; imported labels are escaped.
export function timeSeriesChart({ points, series, title, format, label, width = 720, height = 250, type = 'line', references = [], tooltipRows = () => [], empty = 'No recorded activity in this date range.', scale = 'linear', markers = [], timeSpacing = false }) {
  if (!points.length) return `<p class="no-results">${esc(empty)}</p>`;
  scale = normalizeChartScale(scale);
  const scaleName = chartScaleLabel(scale);
  const w = Math.max(280, width), h = Math.max(250, height);
  const values = points.flatMap(point => series.map(item => point[item.key])).filter(Number.isFinite);
  if (!values.length) return `<p class="no-results">${esc(empty)}</p>`;
  const g = geometry(type === 'bar' ? [...values, ...references.map(item => item.value)] : values, w, h, [markers.length ? 30 : 12, 8, 30, 0], scale, type === 'bar');
  const baseline = g.y(Math.max(g.min, Math.min(g.max, 0)));
  const inRange = item => item.value >= g.min && item.value <= g.max;
  const referencePosition = item => inRange(item) ? '' : item.value < g.min ? ' · below range' : ' · above range';
  const rangeNote = type !== 'bar' && (g.min > 0 || g.max < 0) ? ' · Auto range' : '';
  const ticks = g.ticks;
  const labels = ticks.map(amountText);
  const axisText = new Set(labels).size === labels.length ? amountText
    : value => Math.abs(value) < 10000 ? precise.format(value / 100) : compactDetailed.format(value / 100);
  // Axis labels use a 10px monospace font. Reserve only their text width and
  // an 8px gap; the small right inset keeps endpoint markers inside the plot.
  g.left = Math.max(28, ...ticks.map(value => axisText(value).length * 6 + 10));
  const dateValue = i => Date.parse(points[i].date + 'T12:00:00Z');
  const timeFraction = i => timeSpacing && points.length > 1 && dateValue(points.length - 1) > dateValue(0) ? (dateValue(i) - dateValue(0)) / (dateValue(points.length - 1) - dateValue(0)) : i / (points.length - 1);
  const x = i => type === 'bar' ? g.left + (g.right - g.left) * (i + .5) / points.length : points.length === 1 ? (g.left + g.right) / 2 : g.left + (g.right - g.left) * timeFraction(i);
  const bar = Math.min(20, (g.right - g.left) / points.length / series.length * .65);
  const barGap = Math.min(2, (g.right - g.left) / points.length * .08);
  const seriesX = (i, index) => type === 'bar' ? x(i) + (index - (series.length - 1) / 2) * (bar + barGap) : x(i);
  const stride = Math.max(1, Math.ceil((points.length - 1) / Math.max(1, Math.floor((w - 80) / 130))));
  let svg = `<svg class="time-series-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}"><desc>${esc(title)}. ${scaleName} scale. Vertical axis ${esc(format(g.min))} to ${esc(format(g.max))}. ${esc(label(points[0]))} to ${esc(label(points.at(-1)))}. Exact figures follow in the data table.</desc>`;
  svg += ticks.map(value => `<line x1="${g.left}" x2="${g.right}" y1="${g.y(value)}" y2="${g.y(value)}" stroke="var(--chart-grid)"${value === 0 ? ' stroke-width="1.5"' : ''}/><text x="${g.left - 8}" y="${g.y(value) + 4}" text-anchor="end" fill="var(--chart-label)">${esc(axisText(value))}</text>`).join('');
  svg += references.filter(inRange).map(item => `<line x1="${g.left}" x2="${g.right}" y1="${g.y(item.value)}" y2="${g.y(item.value)}" stroke="var(--border-strong)" stroke-dasharray="5 5"/>`).join('');
  svg += markers.map(marker => `<line x1="${x(marker.index)}" x2="${x(marker.index)}" y1="30" y2="${g.bottom}" stroke="var(--chart-label)" stroke-dasharray="3 4"/><text x="${x(marker.index)}" y="14" text-anchor="${x(marker.index) > g.right - 100 ? 'end' : x(marker.index) < g.left + 100 ? 'start' : 'middle'}" fill="var(--chart-label)">${esc(marker.name)}</text>`).join('');
  svg += series.map((item, index) => {
    if (type === 'bar') {
      return points.map((point, i) => !Number.isFinite(point[item.key]) ? '' : `<rect data-chart-series="${index}" x="${seriesX(i, index) - bar / 2}" y="${Math.min(g.y(0), g.y(point[item.key]))}" width="${bar}" height="${Math.abs(g.y(point[item.key]) - g.y(0))}" fill="${item.color}"/>`).join('');
    }
    const values = points.map(point => point[item.key]);
    const path = values.map((value, i) => Number.isFinite(value) ? `${i && Number.isFinite(values[i - 1]) ? 'L' : 'M'}${x(i).toFixed(2)},${g.y(value).toFixed(2)}` : '').join(' ');
    return `${series.length === 1 && points.length > 1 && values.every(Number.isFinite) ? `<path d="${path} L${x(points.length - 1)},${baseline} L${x(0)},${baseline} Z" fill="${item.color}" fill-opacity=".08"/>` : ''}<path data-chart-series="${index}" d="${path}" stroke="${item.color}" stroke-width="2.5" fill="none"${item.dashed ? ' stroke-dasharray="6 5"' : ''} stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${points.map((point, i) => !Number.isFinite(point[item.key]) ? '' : `<circle data-chart-series="${index}" cx="${x(i)}" cy="${g.y(point[item.key])}" r="${points.length > 40 ? 2 : 3.5}" fill="var(--bg-1)" stroke="${item.color}" stroke-width="2"/>`).join('')}`;
  }).join('');
  svg += points.map((point, i) => i % stride === 0 || i === points.length - 1 ? `<text x="${x(i)}" y="${h - 10}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}" fill="var(--chart-label)">${esc(label(point))}</text>` : '').join('') + '<g class="chart-selection" aria-hidden="true"></g></svg>';
  const plot = interactivePlot(svg, { title, scale, domain: { min: g.min, max: g.max }, left: g.left, right: g.right, top: markers.length ? 30 : 12, bottom: g.bottom, points: points.map((point, i) => ({ x: x(i), period: pointPeriod(point, label(point)), details: pointDetails(point), rows: series.map((item, seriesIndex) => ({ item, seriesIndex })).filter(({ item }) => Number.isFinite(point[item.key])).map(({ item, seriesIndex }) => ({ seriesIndex, name: item.name, value: format(point[item.key]), color: item.color, x: seriesX(i, seriesIndex), y: g.y(point[item.key]) })), extra: [...references.map(item => ({ name: item.name, value: format(item.value) })), ...tooltipRows(point)] })).filter(point => point.rows.length) });
  return `<figure class="time-series-figure"><div class="chart-legend">${series.map(item => `<span><i style="--series-color:${item.color}" class="${item.dashed ? 'dashed' : ''}"></i>${esc(item.name)}</span>`).join('')}${references.map(item => `<span><i class="dashed" style="--series-color:var(--border-strong)"></i>${esc(item.name)} ${esc(format(item.value))}${referencePosition(item)}</span>`).join('')}<span class="chart-currency">NOK</span></div>${plot}<figcaption>${esc(label(points[0]))} – ${esc(label(points.at(-1)))} · ${scaleName} scale${rangeNote}</figcaption><details class="chart-data"><summary>View chart figures</summary><div class="table-scroll"><table><caption class="sr-only">${esc(title)}</caption><thead><tr><th scope="col">Period</th>${series.map(item => `<th scope="col" class="numeric">${esc(item.name)}</th>`).join('')}</tr></thead><tbody>${points.map(point => `<tr><th scope="row">${point.starting ? 'Start · ' : ''}${esc(point.month || point.date || label(point))}${point.end && point.end !== point.date ? ` – ${esc(point.end)}` : ''}</th>${series.map(item => `<td class="numeric">${Number.isFinite(point[item.key]) ? esc(format(point[item.key])) : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></figure>`;
}


// Read the page control on every redraw, preserving an open figures table.
export function renderTimeSeriesChart(container, options) {
  const expanded = container.querySelector('.chart-data')?.open;
  const scale = pageChartScale(container);
  container.innerHTML = timeSeriesChart({ ...options, scale });
  if (expanded && container.querySelector('.chart-data')) container.querySelector('.chart-data').open = true;
  registerBlock(container, chartBlock({ ...options, scale }));
}

export function chartBlock(options) {
  // Copy all mutable chart data while retaining application format functions.
  const snapshot = { ...options, points: options.points.map(point => ({ ...point })), series: options.series.map(series => ({ ...series })), references: options.references?.map(item => ({ ...item })), markers: options.markers?.map(item => ({ ...item })) };
  return {
    title: snapshot.title,
    initial: { scale: snapshot.scale || 'linear', type: snapshot.type || 'line', series: snapshot.series.map(item => item.key), figures: false },
    controls: [
      { key: 'scale', label: 'Chart scale', choices: CHART_SCALES.map(item => ({ value: item.id, label: item.label })) },
      { key: 'type', label: 'Chart style', choices: [{ value: 'line', label: 'Lines' }, { value: 'bar', label: 'Bars' }] },
      { key: 'series', label: 'Visible series', type: 'series', choices: snapshot.series.map(item => ({ value: item.key, label: item.name })) },
      { key: 'figures', label: 'Show chart figures', type: 'checkbox' },
    ],
    render(container, settings) {
      const series = snapshot.series.filter(item => settings.series.includes(item.key));
      container.innerHTML = series.length ? timeSeriesChart({ ...snapshot, series, scale: settings.scale, type: settings.type, width: container.clientWidth || 960, height: 420 }) : '<p class="no-results">Select a series to show the chart.</p>';
      const figures = container.querySelector('.chart-data');
      if (figures) figures.open = settings.figures;
    },
  };
}
