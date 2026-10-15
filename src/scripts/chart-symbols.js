const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dashPatterns = { solid: '', dashed: '6 5', dotted: '1 4', 'long-dash': '12 5', 'dash-dot': '8 4 2 4' };

export const chartShape = value => ['circle', 'square', 'diamond', 'triangle'].includes(value) ? value : 'circle';

// SVG dash values are drawing instructions, so accept bounded numbers only.
// Invalid custom patterns fall back to the application's existing line style.
export function chartDashArray(value, fallback = '') {
  // Normalized solid styles use an empty pattern. Preserve it when tooltip
  // metadata passes through the same style helper as the original legend.
  if (typeof value === 'string' && !value.trim()) return '';
  if (Object.hasOwn(dashPatterns, value)) return dashPatterns[value];
  const source = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d+)?(?:[ ,]+\d+(?:\.\d+)?){0,7}$/.test(source)) return fallback;
  const numbers = source.split(/[ ,]+/).map(Number);
  return numbers.some(number => number > 0) && numbers.every(number => number >= 0 && number <= 40) ? numbers.join(' ') : fallback;
}

export function chartLineStyle(item = {}, reference = false) {
  return {
    shape: chartShape(item.shape),
    color: item.color || (reference ? 'var(--border-strong)' : 'var(--chart-1)'),
    dashArray: chartDashArray(item.dashArray, reference ? '5 5' : item.dashed ? '6 5' : ''),
    opacity: Number.isFinite(item.opacity) ? Math.max(0, Math.min(1, item.opacity)) : 1,
    strokeWidth: Number.isFinite(item.strokeWidth) ? Math.max(1, Math.min(6, item.strokeWidth)) : reference ? 1 : 2.5,
  };
}

export function chartSymbolMarkup({ shape = 'circle', color, x, y, radius = 3.5, strokeWidth = 2, opacity = 1, seriesIndex = null }) {
  const attributes = `${seriesIndex === null ? '' : ` data-chart-series="${seriesIndex}"`} data-chart-shape="${chartShape(shape)}" fill="var(--bg-1)" stroke="${esc(color)}" stroke-width="${strokeWidth}" opacity="${opacity}" vector-effect="non-scaling-stroke"`;
  if (shape === 'square') return `<rect${attributes} x="${x - radius}" y="${y - radius}" width="${radius * 2}" height="${radius * 2}"/>`;
  if (shape === 'diamond') return `<polygon${attributes} points="${x},${y - radius * 1.3} ${x + radius * 1.3},${y} ${x},${y + radius * 1.3} ${x - radius * 1.3},${y}"/>`;
  if (shape === 'triangle') return `<polygon${attributes} points="${x},${y - radius * 1.3} ${x + radius * 1.2},${y + radius} ${x - radius * 1.2},${y + radius}"/>`;
  return `<circle${attributes} cx="${x}" cy="${y}" r="${radius}"/>`;
}

export function chartSampleMarkup(item, reference = false) {
  const style = chartLineStyle(item, reference);
  return `<svg class="chart-series-sample" width="34" height="16" viewBox="0 0 34 16" aria-hidden="true" focusable="false" style="flex-shrink:0"><line x1="1" x2="33" y1="8" y2="8" stroke="${esc(style.color)}" stroke-width="${style.strokeWidth}" opacity="${style.opacity}"${style.dashArray ? ` stroke-dasharray="${style.dashArray}"` : ''}/>${reference ? '' : chartSymbolMarkup({ ...style, x: 17, y: 8, radius: 3, strokeWidth: 1.5 })}</svg>`;
}
