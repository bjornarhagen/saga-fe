const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_GLYPHS = 6000;
const MAX_GENERATION_WORK = MAX_GLYPHS * 4;
const applied = new WeakMap();

function generationBudget(limit = MAX_GENERATION_WORK) {
  let remaining = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_GENERATION_WORK, Math.floor(limit))) : MAX_GENERATION_WORK;
  return {
    exhausted: false,
    spend(amount = 1) {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > remaining) {
        this.exhausted = true;
        return false;
      }
      remaining -= amount;
      return true;
    },
  };
}

function pathSegments(path, work) {
  const tokens = path.matchAll(/[MLml]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[A-Za-z]/g);
  const segments = [];
  let command, x = 0, y = 0, segment, token = tokens.next();
  while (!token.done) {
    if (!work.spend()) return [];
    if (/^[A-Za-z]$/.test(token.value[0])) { command = token.value[0]; token = tokens.next(); }
    if (!['M', 'm', 'L', 'l'].includes(command) || token.done) return [];
    const nextX = Number(token.value[0]);
    token = tokens.next();
    if (token.done) return [];
    const nextY = Number(token.value[0]);
    token = tokens.next();
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return [];
    x = command === command.toLowerCase() ? x + nextX : nextX;
    y = command === command.toLowerCase() ? y + nextY : nextY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    if (command.toLowerCase() === 'm') {
      segment = [];
      segments.push(segment);
      command = command === 'm' ? 'l' : 'L';
    }
    if (!segment) return [];
    segment.push({ x, y });
  }
  return segments;
}

function dashPattern(dashArray) {
  let pattern = (Array.isArray(dashArray) ? dashArray : String(dashArray).split(/[ ,]+/)).map(Number);
  if (!pattern.every(value => Number.isFinite(value) && value >= 0)) pattern = [];
  if (pattern.length % 2) pattern = [...pattern, ...pattern];
  return pattern;
}

function boundedSamples(cells, maxGlyphs) {
  if (!Number.isFinite(maxGlyphs) || cells.length <= maxGlyphs) return cells;
  const count = Math.max(0, Math.floor(maxGlyphs));
  if (count < 2) return count ? [cells[0]] : [];
  // Retain existing samples instead of drawing between them. Real missing-data
  // gaps and dash gaps remain empty when a dense history exceeds the budget.
  return Array.from({ length: count }, (_, i) => cells[Math.round(i * (cells.length - 1) / (count - 1))]);
}

// The production charts use straight M/L paths. Rasterize each subpath on its
// own so a missing observation remains a gap rather than an invented line.
export function lineGlyphCells(path, cellWidth, cellHeight, { dashArray = [], scaleX = 1, scaleY = 1, endpoints = true, maxGlyphs = Infinity, maxWork = MAX_GENERATION_WORK, _workBudget } = {}) {
  if (![cellWidth, cellHeight, scaleX, scaleY].every(value => Number.isFinite(value) && value > 0)) return [];
  const work = _workBudget || generationBudget(maxWork);
  const pattern = dashPattern(dashArray);
  const period = pattern.reduce((sum, value) => sum + value, 0);
  function painted(distance) {
    if (!period) return true;
    let position = distance % period;
    for (let i = 0; i < pattern.length; i++) {
      if (position < pattern[i]) return i % 2 === 0;
      position -= pattern[i];
    }
    return true;
  }
  const cells = new Map();
  function put(x, y, glyph, distance, endpoint = false) {
    const column = Math.round(x / cellWidth), row = Math.round(y / cellHeight);
    const key = `${column},${row}`, existing = cells.get(key);
    const error = (x / cellWidth - column) ** 2 + (y / cellHeight - row) ** 2;
    // Test the dash at the closest sample to this cell's centre. Testing every
    // sample would fill short gaps with the neighbouring painted dash.
    if (!endpoint && existing && existing.error < error) return;
    cells.set(key, { x: column * cellWidth, y: row * cellHeight, glyph, error, painted: endpoint || painted(distance) });
  }
  for (const points of pathSegments(path, work)) {
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1], to = points[i];
      const dx = (to.x - from.x) / cellWidth, dy = (to.y - from.y) / cellHeight;
      const length = Math.hypot((to.x - from.x) * scaleX, (to.y - from.y) * scaleY);
      if (![dx, dy, length, distance + length].every(Number.isFinite)) return [];
      const glyph = Math.abs(dy) < Math.abs(dx) * .4 ? '-'
        : Math.abs(dx) < Math.abs(dy) * .4 ? '|' : dx * dy < 0 ? '/' : '\\';
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
      if (!work.spend(steps + 1)) return [];
      for (let step = 0; step <= steps; step++) {
        const fraction = step / steps;
        put(from.x + (to.x - from.x) * fraction, from.y + (to.y - from.y) * fraction, glyph, distance + length * fraction);
      }
      distance += length;
    }
    if (endpoints && points.length) {
      if (!work.spend(2)) return [];
      put(points[0].x, points[0].y, '+', 0, true);
      put(points.at(-1).x, points.at(-1).y, '+', distance, true);
    }
  }
  if (work.exhausted) return [];
  return boundedSamples([...cells.values()].filter(cell => cell.painted).map(({ x, y, glyph }) => ({ x, y, glyph })), maxGlyphs);
}

function* paintedSpans(start, end, pattern, work) {
  const period = pattern.reduce((sum, value) => sum + value, 0);
  if (!period) { if (work.spend()) yield [start, end]; return; }
  let index = 0, phase = start % period, position = start;
  while (phase >= pattern[index]) {
    if (!work.spend()) return;
    phase -= pattern[index++];
  }
  while (position < end) {
    if (!work.spend()) return;
    const next = Math.min(end, position + pattern[index] - phase);
    if (index % 2 === 0 && next > position) yield [position, next];
    position = next;
    phase = 0;
    index = (index + 1) % pattern.length;
  }
}

// Sample in screen distance, then return SVG coordinates. Text is rotated
// inside the unscaled character layer, keeping its angle and proportions on
// sparklines whose horizontal and vertical SVG scales differ.
export function rotatedLineGlyphs(path, cellSize, { dashArray = [], scaleX = 1, scaleY = 1, endpoints = true, maxGlyphs = Infinity, maxWork = MAX_GENERATION_WORK, _workBudget } = {}) {
  if (![cellSize, scaleX, scaleY].every(value => Number.isFinite(value) && value > 0)) return [];
  const work = _workBudget || generationBudget(maxWork);
  const pattern = dashPattern(dashArray), cells = [];
  for (const points of pathSegments(path, work)) {
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      if (!work.spend()) return [];
      const from = points[i - 1], to = points[i];
      const dx = (to.x - from.x) * scaleX, dy = (to.y - from.y) * scaleY;
      const length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || !Number.isFinite(distance + length)) return [];
      if (!length) continue;
      let rotation = Math.atan2(dy, dx) * 180 / Math.PI;
      if (rotation > 90) rotation -= 180;
      if (rotation < -90) rotation += 180;
      for (const [start, end] of paintedSpans(distance, distance + length, pattern, work)) {
        const count = Math.max(1, Math.ceil((end - start) / cellSize)), width = (end - start) / count;
        if (!work.spend(count)) return [];
        for (let sample = 0; sample < count; sample++) {
          const fraction = (start + (sample + .5) * width - distance) / length;
          cells.push({ x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, glyph: '-', rotation, width });
        }
      }
      if (work.exhausted) return [];
      distance += length;
    }
    if (endpoints && points.length) {
      if (!work.spend(points.length > 1 ? 2 : 1)) return [];
      cells.push({ ...points[0], glyph: '+', rotation: 0 });
      if (points.length > 1) cells.push({ ...points.at(-1), glyph: '+', rotation: 0 });
    }
  }
  if (work.exhausted) return [];
  return boundedSamples(cells, maxGlyphs);
}

function markerGlyphCell(marker) {
  let bounds;
  try { bounds = marker.getBBox(); } catch { return null; }
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  const shape = marker.getAttribute('data-chart-shape');
  const cell = {
    x: bounds.x + bounds.width / 2,
    // Production triangle markers extend 1.3 radii above the observation and
    // one radius below it. Its bounding-box centre is not the observation.
    y: bounds.y + bounds.height * (shape === 'triangle' ? 1.3 / 2.3 : .5),
    glyph: { circle: 'o', square: '#', triangle: '^', diamond: 'x' }[shape] || '+',
  };
  return Number.isFinite(cell.x) && Number.isFinite(cell.y) ? cell : null;
}

function barGlyphCells(rect, cellWidth, cellHeight, work) {
  const x = Number(rect.getAttribute('x')), y = Number(rect.getAttribute('y'));
  const width = Number(rect.getAttribute('width')), height = Number(rect.getAttribute('height'));
  if (![x, y, width, height, x + width, y + height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
  const columns = Math.max(1, Math.floor(width / cellWidth));
  const rows = Math.max(1, Math.floor(height / cellHeight));
  if (!work.spend(columns * rows)) return [];
  const cells = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    cells.push({
      x: x + width / 2 + (column - (columns - 1) / 2) * cellWidth,
      y: y + height / 2 + (row - (rows - 1) / 2) * cellHeight,
      glyph: rows === 1 ? '=' : '#',
    });
  }
  return cells;
}

export function applyAsciiGlyphs(plot, { cellSize = 9, lineMode = 'rotated' } = {}) {
  applied.get(plot)?.();
  const svg = plot.querySelector('svg');
  if (!svg) return () => {};
  const bounds = svg.getBoundingClientRect();
  if (![bounds.width, bounds.height].every(value => Number.isFinite(value) && value > 0)) return () => {};
  const doc = svg.ownerDocument, win = doc.defaultView;
  const svgStyle = win.getComputedStyle(svg);
  if (svgStyle.display === 'none' || ['hidden', 'collapse'].includes(svgStyle.visibility)) return () => {};
  const matrix = svg.getScreenCTM();
  if (!matrix) return () => {};
  const scaleX = Math.hypot(matrix.a, matrix.b), scaleY = Math.hypot(matrix.c, matrix.d);
  if (![scaleX, scaleY].every(value => Number.isFinite(value) && value > 0)) return () => {};
  cellSize = Number.isFinite(cellSize) ? Math.min(20, Math.max(3, cellSize)) : 9;
  lineMode = lineMode === 'grid' ? 'grid' : 'rotated';
  const cellWidth = cellSize / scaleX, cellHeight = cellSize * 1.55 / scaleY;
  const sparkline = svg.classList.contains('stat-sparkline');
  const paths = [...svg.querySelectorAll(sparkline ? ':scope > path[fill="none"]' : 'path[data-chart-series]')];
  const bars = [...svg.querySelectorAll('rect[data-chart-series]:not([data-chart-shape])')];
  const markerCells = new Map([...svg.querySelectorAll(':scope > [data-chart-shape][data-chart-series]')].map(marker => [marker, markerGlyphCell(marker)]).filter(([, cell]) => cell));
  const markers = [...markerCells.keys()];
  if (markers.length + paths.length + bars.length * 2 > MAX_GLYPHS) return () => {};
  const shapeBudget = Math.floor((MAX_GLYPHS - markers.length) / Math.max(1, paths.length + bars.length));
  const layer = doc.createElementNS(SVG_NS, 'g');
  layer.setAttribute('data-ascii-glyphs', '');
  layer.setAttribute('data-ascii-line-mode', lineMode);
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('pointer-events', 'none');
  layer.setAttribute('transform', `scale(${1 / scaleX} ${1 / scaleY})`);
  layer.setAttribute('font-family', 'var(--font-mono, monospace)');
  layer.setAttribute('font-size', String(cellSize / .62));
  layer.setAttribute('text-anchor', 'middle');
  layer.setAttribute('dominant-baseline', 'central');
  const converted = new Set();
  const work = generationBudget();
  for (const shape of [...paths, ...bars, ...markers]) {
    const style = win.getComputedStyle(shape), marker = markerCells.get(shape);
    const seriesMarkers = markers.filter(item => item.getAttribute('data-chart-series') === shape.getAttribute('data-chart-series')).map(item => markerCells.get(item));
    const lineOptions = { dashArray: shape.getAttribute('stroke-dasharray') || style.strokeDasharray, scaleX, scaleY, endpoints: !seriesMarkers.length, maxGlyphs: shapeBudget, _workBudget: work };
    const cells = (marker ? work.spend() ? [marker] : [] : shape.localName === 'rect' ? boundedSamples(barGlyphCells(shape, cellWidth, cellHeight, work), shapeBudget)
      : (lineMode === 'grid' ? lineGlyphCells(shape.getAttribute('d') || '', cellWidth, cellHeight, lineOptions)
        : rotatedLineGlyphs(shape.getAttribute('d') || '', cellSize, lineOptions))
        .filter(cell => seriesMarkers.every(point => ((point.x - cell.x) / cellWidth) ** 2 + ((point.y - cell.y) / cellHeight) ** 2 > .7 ** 2)))
        .filter(cell => Number.isFinite(cell.x * scaleX) && Number.isFinite(cell.y * scaleY));
    // The layer is still detached and no source opacity has changed. Keep the
    // entire original chart if generation would exceed the shared work cap.
    if (work.exhausted) return () => {};
    if (!cells.length) continue;
    const group = doc.createElementNS(SVG_NS, 'g');
    const paint = shape.localName === 'rect' && !marker ? 'fill' : 'stroke';
    group.setAttribute('fill', shape.style.getPropertyValue(paint) || shape.getAttribute(paint) || style[paint]);
    group.setAttribute('opacity', style.opacity);
    if (marker) group.setAttribute('data-ascii-point-shape', shape.getAttribute('data-chart-shape'));
    for (const cell of cells) {
      const glyph = doc.createElementNS(SVG_NS, 'text');
      glyph.setAttribute('x', String(cell.x * scaleX));
      glyph.setAttribute('y', String(cell.y * scaleY));
      if (cell.rotation) glyph.setAttribute('transform', `rotate(${cell.rotation} ${cell.x * scaleX} ${cell.y * scaleY})`);
      if (cell.width) {
        glyph.setAttribute('textLength', String(cell.width));
        glyph.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      }
      glyph.textContent = cell.glyph;
      group.append(glyph);
    }
    layer.append(group);
    converted.add(shape);
  }
  if (!layer.childElementCount) return () => {};
  // Keep the live selection above the character layer. Original hit targets
  // stay in place so pointer and keyboard inspection retain exact coordinates.
  svg.insertBefore(layer, svg.querySelector('.chart-selection'));
  const originals = new Set(converted);
  for (const path of paths.filter(path => converted.has(path))) {
    if (sparkline) {
      for (const shape of [...svg.children].filter(shape => shape.localName === 'path')) originals.add(shape);
    } else {
      const area = path.previousElementSibling;
      if (area?.localName === 'path' && !area.hasAttribute('data-chart-series') && area.hasAttribute('fill') && area.getAttribute('fill') !== 'none' && !area.hasAttribute('stroke')) originals.add(area);
    }
  }
  const styles = [...originals].map(shape => ({ shape, opacity: shape.style.getPropertyValue('opacity'), priority: shape.style.getPropertyPriority('opacity') }));
  for (const { shape } of styles) shape.style.setProperty('opacity', '0');
  let restored = false;
  const cleanup = () => {
    if (restored) return;
    restored = true;
    layer.remove();
    for (const { shape, opacity, priority } of styles) {
      if (opacity) shape.style.setProperty('opacity', opacity, priority);
      else shape.style.removeProperty('opacity');
    }
    if (applied.get(plot) === cleanup) applied.delete(plot);
  };
  applied.set(plot, cleanup);
  return cleanup;
}
