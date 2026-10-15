import { pageChartScale } from './page-chart-scale.js';
import { rollingNumberMarkup, renderRollingNumbers } from './number-roll.js';
import { sparkline, chartBlock } from './charts.js';
import { registerBlock } from './block-dialog.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const percent = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
export const percentage = value => value === null ? '—' : `${percent.format(value)}%`;

export function changeText(current, previous, money) {
  const delta = current - previous;
  if (!delta) return 'Unchanged';
  const direction = delta > 0 ? '↑' : '↓';
  // A zero or negative base has no useful conventional percentage change.
  return `${direction} ${previous > 0 ? percentage(Math.abs(delta) / previous * 100) : money(Math.abs(delta))}`;
}

const tones = { income: 'var(--chart-in)', expense: 'var(--chart-out)', saving: 'var(--chart-3)', net: 'var(--chart-4)', neutral: 'var(--accent)' };
const paths = {
  income: 'M18 6 6 18M6 7v11h11',
  expense: 'M6 18 18 6M7 6h11v11',
  saving: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  balance: 'M3 6h17v14H3V6Zm0 0V4h14v2M15 11h6v5h-6v-5Z',
  payment: 'M3 5h18v14H3V5Zm0 5h18M6 15h4',
  calendar: 'M4 5h16v16H4V5Zm4-3v6m8-6v6M4 11h16',
  trend: 'M3 3v18h18M6 15l5-5 4 3 6-7',
  percent: 'M5 19 19 5M8 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm14 14a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
};
const iconMarkup = icon => `<span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[icon] || paths.trend}"/></svg></span>`;
const trendMarkup = (item, scale) => item.values?.length > 1 ? `<div class="stat-trend">${sparkline(item.values, tones[item.tone] || tones.neutral, { title: item.label, points: item.trendPoints, format: item.trendFormat, scale })}${item.trendLabel ? `<span>${esc(item.trendLabel)}</span>` : ''}</div>` : '';

// All values are text; only application-generated local links are supported.
export function statisticsMarkup(items, { scale = 'linear' } = {}) {
  return items.map(item => {
    const { label, value, note, href, color = '', icon = 'trend', tone = 'neutral' } = item;
    return `<div class="stat-item" style="--stat-accent:${tones[tone] || tones.neutral}"><dt>${iconMarkup(icon)}<span>${esc(label)}</span></dt><dd class="stat-value ${esc(color)}">${href ? `<a class="ledger-link" href="${esc(href)}">${rollingNumberMarkup(value, label)}</a>` : rollingNumberMarkup(value, label)}</dd><dd class="stat-note">${esc(note)}</dd>${item.values?.length > 1 ? `<dd class="stat-trend-wrap">${trendMarkup(item, scale)}</dd>` : ''}</div>`;
  }).join('');
}

export function metricCardsMarkup(items, { scale = 'linear' } = {}) {
  return items.map(item => `<article class="metric" style="--stat-accent:${tones[item.tone] || tones.neutral}"><div class="metric-label"><span>${esc(item.label)}</span>${iconMarkup(item.icon || 'balance')}</div><div class="metric-value ${esc(item.color || '')}">${rollingNumberMarkup(item.value, item.label)}</div><div class="metric-note">${esc(item.note)}</div>${trendMarkup(item, scale)}${item.change ? `<div class="metric-comparison"><span class="change-badge ${esc(item.change.color || '')}">${esc(item.change.text)}</span><span>${esc(item.change.note)}</span></div>` : ''}</article>`).join('');
}

export function statisticBlock(item, scale) {
  const snapshot = { ...item, values: item.values ? [...item.values] : [], trendPoints: item.trendPoints?.map(point => ({ ...point })) };
  const trend = snapshot.values.length > 1 ? chartBlock({
    title: snapshot.label,
    scale,
    points: snapshot.values.map((value, i) => ({ ...snapshot.trendPoints?.[i], value })),
    series: [{ key: 'value', name: snapshot.label, color: tones[snapshot.tone] || tones.neutral }],
    format: snapshot.trendFormat || (value => `${new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100)} kr`),
    label: point => point.month || point.date || '',
  }) : null;
  return {
    title: snapshot.label,
    initial: { ...trend?.initial, notes: true, trend: !!trend },
    controls: [
      { key: 'notes', label: 'Show explanation', type: 'checkbox' },
      ...(trend ? [{ key: 'trend', label: 'Show trend', type: 'checkbox' }, ...trend.controls] : []),
    ],
    render(container, settings) {
      container.innerHTML = `<dl class="expanded-statistic">${statisticsMarkup([{ ...snapshot, values: [] }], { scale: settings.scale })}</dl><div class="expanded-statistic-trend"></div>`;
      container.querySelector('.stat-note').hidden = !settings.notes;
      if (settings.notes && (snapshot.change || snapshot.trendLabel)) {
        const note = container.ownerDocument?.createElement('p');
        if (note) {
          note.className = 'input-note';
          note.textContent = [snapshot.change ? `${snapshot.change.text} ${snapshot.change.note}` : '', snapshot.trendLabel].filter(Boolean).join(' · ');
          container.append(note);
        }
      }
      if (trend && settings.trend) trend.render(container.querySelector('.expanded-statistic-trend'), settings);
    },
  };
}

function renderBlocks(container, items, markup, selector) {
  const scale = pageChartScale(container);
  renderRollingNumbers(container, markup(items, { scale }));
  container.querySelectorAll(selector).forEach((element, index) => registerBlock(element, statisticBlock(items[index], scale)));
}
export const renderStatistics = (container, items) => renderBlocks(container, items, statisticsMarkup, ':scope > .stat-item');
export const renderMetricCards = (container, items) => renderBlocks(container, items, metricCardsMarkup, ':scope > .metric');
