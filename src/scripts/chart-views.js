import { applyAsciiGlyphs } from './ascii-chart-glyphs.js';
import { normalizeChartView, normalizeAsciiCellSize } from './chart-view-settings.js';

const initialized = new WeakMap();
const targets = '.chart-plot, .bar-fill, .account-allocation-bar';
const decoration = '[data-ascii-glyphs], .ascii-bar-glyphs';

function characterBar(element, cellSize) {
  const glyphs = element.ownerDocument.createElement('span');
  glyphs.className = 'ascii-bar-glyphs';
  glyphs.setAttribute('aria-hidden', 'true');
  glyphs.style.color = element.style.getPropertyValue('background-color') || element.style.getPropertyValue('background') || 'var(--chart-1)';
  glyphs.textContent = '#'.repeat(Math.min(2000, Math.max(1, Math.ceil(element.getBoundingClientRect().width / cellSize))));
  element.setAttribute('data-ascii-bar', '');
  element.append(glyphs);
  return () => { glyphs.remove(); element.removeAttribute('data-ascii-bar'); };
}

// A view layer only: source figures, hit targets, and chart controls stay with
// the existing renderers. Observe their replacements and visibility changes,
// while ignoring our own glyphs and the live tooltip selection.
export function initializeChartViews(doc = document, { renderGlyphs = applyAsciiGlyphs } = {}) {
  if (initialized.has(doc)) return initialized.get(doc);
  const win = doc.defaultView, root = doc.documentElement;
  const records = new Map(), dirty = new Set();
  let frame = null, disposed = false;
  const resize = new win.ResizeObserver(entries => {
    for (const { target, contentRect } of entries) {
      const record = records.get(target);
      const size = `${contentRect.width.toFixed(2)},${contentRect.height.toFixed(2)}`;
      if (record && record.observedSize !== size) {
        record.observedSize = size;
        queue(target);
      }
    }
  });

  function queue(element, force = false) {
    if (!records.has(element)) {
      records.set(element, { cleanup: null, signature: null });
      resize.observe(element);
    }
    if (force) records.get(element).signature = null;
    dirty.add(element);
    if (frame === null && !disposed) frame = win.requestAnimationFrame(draw);
  }

  function collect(node, force = false) {
    if (node.matches?.(decoration) || node.closest?.(decoration)) return;
    if (node.matches?.(targets)) queue(node, force);
    for (const element of node.querySelectorAll?.(targets) || []) queue(element, force);
  }

  function draw() {
    frame = null;
    const ascii = normalizeChartView(root.dataset.chartView) === 'ascii';
    const cellSize = normalizeAsciiCellSize(root.dataset.asciiCellSize);
    root.style.setProperty('--ascii-cell-size', `${cellSize}px`);
    for (const [element, record] of records) {
      if (!element.isConnected) {
        record.cleanup?.(); resize.unobserve(element);
        records.delete(element); dirty.delete(element);
      }
    }
    const pending = [...dirty]; dirty.clear();
    for (const element of pending) {
      const record = records.get(element);
      if (!record) continue;
      const bounds = element.getBoundingClientRect();
      const isPlot = element.matches('.chart-plot');
      const svg = isPlot ? element.querySelector('svg') : null;
      const signature = `${bounds.width.toFixed(2)},${bounds.height.toFixed(2)},${cellSize},${ascii}`;
      if (record.signature === signature && record.svg === svg) continue;
      record.cleanup?.(); record.cleanup = null;
      record.svg = svg; record.signature = signature;
      // Display:none sections and closed dialogs have no usable screen matrix.
      // Resize/visibility observers retry them when they are opened.
      if (!ascii || !bounds.width || !bounds.height || isPlot && !svg) continue;
      try {
        record.cleanup = svg ? renderGlyphs(element, { cellSize, lineMode: 'rotated' }) : characterBar(element, cellSize);
      } catch { /* A chart that cannot be converted keeps its normal rendering. */ }
    }
  }

  const mutation = new win.MutationObserver(changes => {
    let removed = false;
    for (const change of changes) {
      if (change.target.closest?.('.chart-selection, ' + decoration)) continue;
      if (change.type === 'attributes') { collect(change.target); continue; }
      const nodes = [...change.addedNodes, ...change.removedNodes].filter(node => !node.matches?.(decoration));
      if (!nodes.length) continue;
      for (const node of change.addedNodes) collect(node);
      const plot = change.target.closest?.('.chart-plot');
      if (plot) queue(plot, true);
      if ([...change.removedNodes].some(node => node.matches?.(targets) || node.querySelector?.(targets))) removed = true;
    }
    // Also release detached plots when replacement content has no charts.
    if (removed && frame === null && !disposed) frame = win.requestAnimationFrame(draw);
  });
  mutation.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
  const refresh = () => { for (const element of records.keys()) queue(element, true); };
  win.addEventListener('saga:chartviewchange', refresh);
  win.addEventListener('saga:themechange', refresh);
  collect(doc);
  doc.fonts?.ready.then(() => { if (!disposed) refresh(); });

  const dispose = () => {
    disposed = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    mutation.disconnect(); resize.disconnect();
    win.removeEventListener('saga:chartviewchange', refresh);
    win.removeEventListener('saga:themechange', refresh);
    for (const record of records.values()) record.cleanup?.();
    records.clear(); dirty.clear(); initialized.delete(doc);
  };
  initialized.set(doc, dispose);
  return dispose;
}
