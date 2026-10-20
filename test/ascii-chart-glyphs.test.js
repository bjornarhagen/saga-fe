import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAsciiGlyphs, lineGlyphCells, rotatedLineGlyphs } from '../src/scripts/ascii-chart-glyphs.js';

test('ASCII strokes use a stable character grid and preserve missing-data gaps', () => {
  const path = 'M0,20 L20,20 M60,20 L80,0';
  const cells = lineGlyphCells(path, 10, 10);
  assert.deepEqual(cells, lineGlyphCells(path, 10, 10));
  assert.ok(cells.every(cell => cell.x % 10 === 0 && cell.y % 10 === 0));
  assert.ok(cells.some(cell => cell.glyph === '-'));
  assert.ok(cells.some(cell => cell.glyph === '/'));
  assert.ok(cells.every(cell => cell.x <= 20 || cell.x >= 60));
  assert.deepEqual(lineGlyphCells('M-15,5', 10, 10), [{ x: -10, y: 10, glyph: '+' }]);
  assert.deepEqual(lineGlyphCells('M0,0 C1,2 3,4 5,6', 10, 10), []);

  const dashed = lineGlyphCells('M0,0 L30,0 L60,0', 5, 5, { dashArray: '10 10' });
  assert.ok(dashed.length < lineGlyphCells('M0,0 L60,0', 5, 5).length);
  assert.ok(dashed.some(cell => cell.x === 5));
  assert.ok(dashed.every(cell => cell.x !== 15 && cell.x !== 35 && cell.x !== 55));
  assert.deepEqual(dashed, lineGlyphCells('M0,0 L60,0', 5, 5, { dashArray: [10, 10] }));
  const stretched = lineGlyphCells('M0,0 L120,0', 10, 5, { dashArray: [10, 10], scaleX: .5 });
  assert.deepEqual(stretched.map(cell => ({ ...cell, x: cell.x / 2 })), dashed);
});

test('rotated strokes follow shallow and steep screen slopes without turning text upside down', () => {
  const cases = [
    { path: 'M0,20 L40,0', dx: 40, dy: -20 },
    { path: 'M0,40 L10,0', dx: 10, dy: -40 },
    { path: 'M0,0 L40,20', dx: 40, dy: 20 },
    { path: 'M0,0 L10,40', dx: 10, dy: 40 },
  ];
  for (const { path, dx, dy } of cases) {
    const samples = rotatedLineGlyphs(path, 3, { endpoints: false });
    assert.ok(samples.length > 1);
    assert.ok(samples.every(sample => sample.glyph === '-' && sample.width <= 3));
    assert.ok(samples.every(sample => Math.abs(sample.rotation - Math.atan2(dy, dx) * 180 / Math.PI) < 1e-9));
  }
  const reversed = rotatedLineGlyphs('M40,20 L0,0', 5, { endpoints: false });
  assert.ok(reversed.every(sample => sample.rotation >= -90 && sample.rotation <= 90));
  assert.ok(reversed.every(sample => Math.abs(sample.rotation - Math.atan2(20, 40) * 180 / Math.PI) < 1e-9));

  const stretched = rotatedLineGlyphs('M0,0 L40,10', 5, { scaleX: .5, scaleY: 2, endpoints: false });
  assert.ok(stretched.every(sample => sample.rotation === 45));
  assert.ok(stretched.every(sample => sample.y === sample.x / 4));
  assert.deepEqual(rotatedLineGlyphs('M3,7', 3), [{ x: 3, y: 7, glyph: '+', rotation: 0 }]);
});

test('rotated strokes keep screen-space dash phase across segments and reset at missing-data gaps', () => {
  const options = { dashArray: '10 10', endpoints: false };
  const dashed = rotatedLineGlyphs('M0,0 L15,0 L40,0', 5, options);
  assert.deepEqual(dashed, rotatedLineGlyphs('M0,0 L40,0', 5, options));
  assert.deepEqual(dashed.map(sample => sample.x), [2.5, 7.5, 22.5, 27.5]);
  assert.ok(dashed.every(sample => sample.x % 20 < 10));
  const stretched = rotatedLineGlyphs('M0,0 L80,0', 5, { ...options, scaleX: .5 });
  assert.deepEqual(stretched.map(sample => ({ ...sample, x: sample.x / 2 })), dashed);

  const gaps = rotatedLineGlyphs('M0,0 L10,0 M50,10 L60,10', 3, options);
  assert.ok(gaps.every(sample => sample.x <= 10 || sample.x >= 50));
  assert.ok(gaps.some(sample => sample.x > 50));
  assert.ok(gaps.every(sample => sample.width <= 3));
  assert.deepEqual(rotatedLineGlyphs('M0,0 C1,2 3,4 5,6', 3), []);
});

test('dense histories have a bounded glyph sample without joining dash or missing-data gaps', () => {
  const path = 'M0,0 L1000,0 M1200,0 L2200,0';
  const options = { dashArray: '10 10', endpoints: false, maxGlyphs: 20 };
  const samples = rotatedLineGlyphs(path, 3, options);
  assert.equal(samples.length, 20);
  assert.deepEqual(samples, rotatedLineGlyphs(path, 3, options));
  assert.ok(samples.every(sample => sample.x <= 1000 || sample.x >= 1200));
  assert.ok(samples.every(sample => sample.x % 20 < 10));
  assert.equal(lineGlyphCells(path, 3, 3, options).length, 20);
  assert.deepEqual(rotatedLineGlyphs('M1e308,0 l1e308,0', 3), []);
  assert.deepEqual(lineGlyphCells('M1e308,0 l1e308,0', 3, 3), []);
});

test('generation rejects expensive strokes before producing their full sample arrays', () => {
  const dense = Array.from({ length: 10000 }, (_, i) => `${i ? 'L' : 'M'}${720 * i / 9999},${i % 2 ? 250 : 0}`).join(' ');
  assert.deepEqual(rotatedLineGlyphs(dense, 3, { maxGlyphs: 6000 }), []);
  assert.deepEqual(lineGlyphCells(dense, 3, 4.65, { maxGlyphs: 6000 }), []);
  assert.deepEqual(rotatedLineGlyphs('M0,0 L1000000000,0', 3, { maxWork: 8 }), []);
  assert.deepEqual(lineGlyphCells('M0,0 L1000000000,0', 3, 3, { maxWork: 8 }), []);
  assert.deepEqual(rotatedLineGlyphs('M0,0 L10,0', 3, { dashArray: '0 0 .001 .001', maxWork: 8 }), []);
  assert.ok(rotatedLineGlyphs('M0,0 L30,0', 3, { maxWork: 100 }).length);
  assert.ok(lineGlyphCells('M0,0 L30,0', 3, 3, { maxWork: 100 }).length);
});

test('a shared generation cap keeps the whole source chart when paths or bars exceed it', () => {
  function chart(shapes) {
    let inserted = false, sourceChanged = false;
    const style = { getPropertyValue: () => '', getPropertyPriority: () => '', setProperty: () => { sourceChanged = true; } };
    const sources = shapes.map((shape, index) => ({
      localName: shape.type || 'path', style,
      getAttribute: name => name === 'data-chart-series' ? String(index) : shape[name] ?? null,
    }));
    const svg = {
      getBoundingClientRect: () => ({ width: 720, height: 250 }),
      getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1 }),
      classList: { contains: () => false },
      querySelectorAll: selector => selector === 'path[data-chart-series]' ? sources.filter(shape => shape.localName === 'path')
        : selector === 'rect[data-chart-series]:not([data-chart-shape])' ? sources.filter(shape => shape.localName === 'rect') : [],
      insertBefore: () => { inserted = true; },
    };
    svg.ownerDocument = {
      defaultView: { getComputedStyle: () => ({ visibility: 'visible', strokeDasharray: 'none', opacity: '1', stroke: 'var(--chart-1)', fill: 'var(--chart-1)' }) },
      createElementNS: () => ({ childElementCount: 0, setAttribute() {}, append() { this.childElementCount++; } }),
    };
    return { plot: { querySelector: () => svg }, unchanged: () => !inserted && !sourceChanged };
  }
  // Each path fits on its own. Together they exceed the chart's shared cap.
  const path = Array.from({ length: 100 }, (_, i) => `${i ? 'L' : 'M'}${720 * i / 99},${i % 2 ? 250 : 0}`).join(' ');
  assert.ok(rotatedLineGlyphs(path, 3).length);
  for (const lineMode of ['rotated', 'grid']) {
    const source = chart([{ d: path }, { d: path }, { d: path }]);
    assert.doesNotThrow(() => applyAsciiGlyphs(source.plot, { cellSize: 3, lineMode })());
    assert.ok(source.unchanged());
  }
  const bars = chart([{ type: 'rect', x: '0', y: '0', width: '1000000000', height: '1000000000' }]);
  assert.doesNotThrow(() => applyAsciiGlyphs(bars.plot, { cellSize: 3 })());
  assert.ok(bars.unchanged());
});

test('hidden and zero-size charts retain their source without reading or changing geometry', () => {
  for (const bounds of [{ width: 0, height: 250 }, { width: 720, height: 0 }, { width: Infinity, height: 250 }]) {
    const svg = { getBoundingClientRect: () => bounds, getScreenCTM() { assert.fail('Hidden chart geometry must not be read'); } };
    assert.doesNotThrow(() => applyAsciiGlyphs({ querySelector: () => svg })());
  }
  const svg = {
    getBoundingClientRect: () => ({ width: 720, height: 250 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'hidden' }) } },
    getScreenCTM() { assert.fail('Hidden chart geometry must not be read'); },
  };
  assert.doesNotThrow(() => applyAsciiGlyphs({ querySelector: () => svg })());
});
