import { rollingNumberMarkup, renderRollingNumbers } from './number-roll.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initialized = new WeakSet();

export function nearestPoint(points, x) {
  return points.reduce((nearest, point, index) => Math.abs(point.x - x) < Math.abs(points[nearest].x - x) ? index : nearest, 0);
}

export function tooltipMarkup(data, index, selectedSeries = null) {
  const point = data.points[index];
  const rows = point.rows.map((row, i) => `<div class="chart-tooltip-row ${i === selectedSeries ? 'selected' : ''}"><dt><i style="--series-color:${esc(row.color)}"></i>${esc(row.name)}</dt><dd>${rollingNumberMarkup(row.value, `series:${i}:${row.name}`)}</dd></div>`).join('');
  const extra = point.extra?.length ? `<dl class="chart-tooltip-extra">${point.extra.map((row, i) => `<div class="chart-tooltip-row"><dt>${esc(row.name)}</dt><dd>${rollingNumberMarkup(row.value, `extra:${i}:${row.name}`)}</dd></div>`).join('')}</dl>` : '';
  return `<p class="chart-tooltip-context">${esc(data.title)}</p><p class="chart-tooltip-period">${esc(point.period)}</p><dl>${rows}</dl>${extra}${point.details ? `<p class="chart-tooltip-note">${esc(point.details)}</p>` : ''}`;
}

export function initializeChartTooltips(root = document) {
  if (initialized.has(root)) return;
  initialized.add(root);
  const doc = root.ownerDocument || root, win = doc.defaultView;
  const tooltip = doc.createElement('div');
  tooltip.id = 'chart-tooltip'; tooltip.className = 'chart-tooltip';
  tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
  doc.body.append(tooltip);
  const cache = new WeakMap(), indices = new WeakMap();
  let active = null, index = 0, mode = null, series = null, timer, dismissed = null, pointerLocation = null;
  const chartFor = target => target?.closest?.('[data-chart-data]');
  const dataFor = chart => {
    if (!cache.has(chart)) cache.set(chart, JSON.parse(chart.dataset.chartData));
    return cache.get(chart);
  };
  function hide(dismiss = false) {
    clearTimeout(timer);
    if (dismiss && active) dismissed = { chart: active, index };
    active?.removeAttribute('aria-describedby'); active?.removeAttribute('data-chart-active');
    const selection = active?.querySelector('.chart-selection');
    if (selection) selection.replaceChildren();
    active = null; mode = null; series = null; pointerLocation = null; tooltip.hidden = true;
  }
  function place(chart, point) {
    const svg = chart.querySelector('svg'), matrix = svg.getScreenCTM();
    if (!matrix) return;
    const anchor = new win.DOMPoint(point.x, Math.min(...point.rows.map(row => row.y))).matrixTransform(matrix);
    const viewportWidth = doc.documentElement.clientWidth, viewportHeight = doc.documentElement.clientHeight;
    // clientWidth excludes a visible scrollbar; 100vw/innerWidth do not.
    tooltip.style.maxWidth = `${viewportWidth - 16}px`;
    tooltip.style.minWidth = `${Math.min(220, viewportWidth - 16)}px`;
    tooltip.style.maxHeight = `${viewportHeight - 16}px`;
    const bounds = tooltip.getBoundingClientRect(), gap = 12, edge = 8;
    let preferredLeft = anchor.x - bounds.width / 2;
    const above = anchor.y - bounds.height - gap;
    let preferredTop = above >= edge ? above : anchor.y + gap;
    if (mode === 'pointer' && pointerLocation) {
      // Stay beside the cursor rather than placing the popup over a tall
      // neighbouring point. Keyboard and touch retain point anchoring.
      preferredLeft = pointerLocation.x + gap;
      if (preferredLeft + bounds.width > viewportWidth - edge) preferredLeft = pointerLocation.x - bounds.width - gap;
      preferredTop = pointerLocation.y + gap;
      if (preferredTop + bounds.height > viewportHeight - edge) preferredTop = pointerLocation.y - bounds.height - gap;
    }
    const left = Math.max(edge, Math.min(viewportWidth - bounds.width - edge, preferredLeft));
    const top = Math.max(edge, Math.min(viewportHeight - bounds.height - edge, preferredTop));
    tooltip.style.left = `${left}px`; tooltip.style.top = `${top}px`;
  }
  function show(chart, next, input, selectedSeries = null, location = null) {
    clearTimeout(timer);
    if (input === 'pointer' && dismissed?.chart === chart && dismissed.index === next) return;
    dismissed = null;
    const data = dataFor(chart), point = data.points[next];
    const changed = active !== chart || index !== next || series !== selectedSeries || tooltip.hidden;
    const resetNumbers = active !== chart || tooltip.hidden;
    if (active && active !== chart) hide();
    active = chart; index = next; mode = input; series = selectedSeries; indices.set(chart, index);
    pointerLocation = location;
    tooltip.setAttribute('aria-live', input === 'keyboard' ? 'polite' : 'off');
    chart.setAttribute('aria-describedby', tooltip.id); chart.setAttribute('data-chart-active', String(index));
    if (changed) {
      tooltip.hidden = false;
      renderRollingNumbers(tooltip, tooltipMarkup(data, index, series), { duration: 210, reset: resetNumbers });
      const selection = chart.querySelector('.chart-selection');
      selection.innerHTML = `<line class="chart-hover-rule" x1="${point.x}" x2="${point.x}" y1="${data.top}" y2="${data.bottom}" vector-effect="non-scaling-stroke"/>${point.rows.map(row => `<path d="M${row.x ?? point.x},${row.y} l0,0" stroke="${esc(row.color)}" stroke-width="9" stroke-linecap="round" vector-effect="non-scaling-stroke"/><path d="M${row.x ?? point.x},${row.y} l0,0" stroke="var(--bg-1)" stroke-width="4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`).join('')}`;
    }
    tooltip.hidden = false;
    place(chart, point);
  }
  function pointerPoint(event, chart) {
    const svg = chart.querySelector('svg'), matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const position = new win.DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const data = dataFor(chart);
    if (position.x < data.left - 8 || position.x > data.right + 8 || position.y < data.top - 8 || position.y > data.bottom + 8) return null;
    return nearestPoint(data.points, position.x);
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(() => hide(), 160); };
  root.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    let chart = chartFor(event.target);
    if (tooltip.contains(event.target)) {
      // The popup remains hoverable, but never blocks a chart beneath it.
      // This also handles large pointer jumps from a low point to a spike.
      chart = doc.elementsFromPoint(event.clientX, event.clientY).map(chartFor).find(Boolean);
      if (!chart) { clearTimeout(timer); return; }
    }
    if (!chart) return;
    const next = pointerPoint(event, chart);
    if (next === null) { if (tooltip.contains(event.target)) { clearTimeout(timer); return; } if (active === chart && mode === 'pointer') later(); return; }
    const selected = event.target.closest?.('[data-chart-series]')?.dataset.chartSeries;
    show(chart, next, 'pointer', selected === undefined ? null : Number(selected), { x: event.clientX, y: event.clientY });
  });
  root.addEventListener('pointerout', event => {
    const chart = chartFor(event.target);
    if (chart && chart === active && mode === 'pointer' && !chart.contains(event.relatedTarget) && !tooltip.contains(event.relatedTarget)) { dismissed = null; later(); }
  });
  tooltip.addEventListener('pointerenter', () => clearTimeout(timer));
  tooltip.addEventListener('pointerleave', () => { if (mode === 'pointer') later(); });
  root.addEventListener('pointerdown', event => {
    if (tooltip.contains(event.target)) return;
    const chart = chartFor(event.target);
    if (!chart) { hide(); dismissed = null; return; }
    if (event.pointerType === 'touch') {
      const next = pointerPoint(event, chart);
      if (next !== null) show(chart, next, 'touch');
    }
  });
  root.addEventListener('focusin', event => {
    const chart = chartFor(event.target);
    if (chart && chart === active && mode === 'touch') return;
    if (chart) show(chart, indices.get(chart) || 0, 'keyboard');
    else hide();
  });
  root.addEventListener('focusout', event => { if (active && !active.contains(event.relatedTarget)) hide(); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { hide(true); return; }
    const chart = chartFor(event.target);
    if (!chart || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const last = dataFor(chart).points.length - 1, current = indices.get(chart) || 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, current + (event.key === 'ArrowRight' ? 1 : -1)));
    show(chart, next, 'keyboard');
  });
  win.addEventListener('scroll', event => {
    if (tooltip.contains(event.target)) return;
    if (active && mode === 'keyboard' && doc.activeElement === active) {
      const bounds = active.getBoundingClientRect();
      if (bounds.bottom > 0 && bounds.top < win.innerHeight) { place(active, dataFor(active).points[index]); return; }
    }
    hide();
  }, true);
  win.addEventListener('resize', () => hide());
  win.addEventListener('blur', () => hide());
  new win.MutationObserver(() => { if (active && !active.isConnected) hide(); }).observe(doc.getElementById('content') || doc.body, { childList: true, subtree: true });
}
