import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeChartTooltips } from '../src/scripts/chart-tooltips.js';

// A small event surface exercises the controller without a browser dependency.
function harness(inDialog = false, shapes = []) {
  const listeners = {}, windowListeners = {}, attributes = new Map();
  let observer;
  const tooltip = { addEventListener() {}, hidden: true, style: {}, innerHTML: '', setAttribute(name, value) { this[name] = value; }, contains: target => target === tooltip, getBoundingClientRect: () => ({ width: 240, height: 160 }) };
  const selection = { innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
  const matrix = { inverse() { return this; } };
  const svg = { getScreenCTM: () => matrix };
  const points = [10, 50, 90].map((x, i) => ({ x, period: `Synthetic month ${i + 1}`, rows: (shapes.length ? shapes : [undefined]).map((shape, seriesIndex) => ({ name: 'Spending', value: `${i + 1},05 kr`, color: 'var(--chart-out)', y: 50, shape, seriesIndex })), extra: [] }));
  const modal = { append(element) { element.parentElement = this; } };
  const chart = {
    dataset: { chartData: JSON.stringify({ title: 'Synthetic spending', left: 10, right: 90, top: 0, bottom: 100, points }) },
    isConnected: true,
    closest: selector => selector === '[data-chart-data]' ? chart : selector === 'dialog' && inDialog ? modal : null,
    querySelector: selector => selector === 'svg' ? svg : selection,
    contains: target => target === chart,
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    getBoundingClientRect: () => ({ top: 10, bottom: 110 }),
  };
  const win = {
    innerWidth: 335, innerHeight: 480,
    DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform() { return this; } },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    addEventListener: (name, callback) => { windowListeners[name] = callback; },
  };
  const doc = {
    elementsFromPoint: () => [chart], defaultView: win, activeElement: null, documentElement: { clientWidth: 320, clientHeight: 480 },
    body: { append() {} }, createElement: () => tooltip, getElementById: () => ({}),
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const send = (name, event = {}) => {
    if (name === 'focusin') doc.activeElement = event.target;
    listeners[name]({ target: chart, clientX: 50, clientY: 50, pointerType: 'mouse', ...event });
  };
  initializeChartTooltips(doc);
  return { chart, tooltip, modal, attributes, selection, send, windowListeners, observer: () => observer(), doc };
}

test('keyboard inspection supports endpoint keys, dismissal, and removal during redraw', () => {
  const h = harness();
  h.send('focusin', { target: h.chart });
  assert.equal(h.tooltip.hidden, false);
  assert.match(h.tooltip.innerHTML, /Synthetic month 1/);
  assert.equal(h.attributes.get('aria-describedby'), 'chart-tooltip');
  let prevented = false;
  h.send('keydown', { key: 'End', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(h.tooltip.innerHTML, /Synthetic month 3/);
  h.send('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.match(h.tooltip.innerHTML, /Synthetic month 2/);
  h.send('keydown', { key: 'Home', preventDefault() {} });
  assert.match(h.tooltip.innerHTML, /Synthetic month 1/);
  h.send('keydown', { key: 'Escape' });
  assert.equal(h.tooltip.hidden, true);
  assert.equal(h.attributes.has('aria-describedby'), false);
  h.send('keydown', { key: 'ArrowRight', preventDefault() {} });
  h.chart.isConnected = false; h.observer();
  assert.equal(h.tooltip.hidden, true);
  assert.equal(h.selection.innerHTML, '');
});

test('modal tooltips share the dialog top layer and Escape dismisses inspection before the dialog', () => {
  const h = harness(true);
  h.send('focusin', { target: h.chart });
  assert.equal(h.tooltip.parentElement, h.modal);
  let prevented = false, stopped = false;
  h.send('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.equal(h.tooltip.hidden, true);
  prevented = false;
  h.send('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test('pointer inspection picks the nearest point and Escape stays dismissed until selection changes', () => {
  const h = harness();
  h.send('pointermove', { clientX: 89 });
  assert.match(h.tooltip.innerHTML, /Synthetic month 3/);
  assert.equal(h.tooltip['aria-live'], 'off');
  assert.ok(parseFloat(h.tooltip.style.left) >= 8);
  assert.ok(parseFloat(h.tooltip.style.left) + 240 <= 312);
  h.send('keydown', { key: 'Escape' });
  h.send('pointermove', { clientX: 89 });
  assert.equal(h.tooltip.hidden, true);
  h.send('pointermove', { clientX: 49 });
  assert.equal(h.tooltip.hidden, false);
  assert.match(h.tooltip.innerHTML, /Synthetic month 2/);
  h.send('pointerdown', { target: {} });
  assert.equal(h.tooltip.hidden, true);
  assert.doesNotThrow(() => h.send('pointerout', { target: { closest: () => null }, relatedTarget: null }));
});

test('touch selects a point without blocking scrolling and shared initialization is idempotent', () => {
  const h = harness();
  h.send('pointerdown', { clientX: 90, pointerType: 'touch' });
  h.send('focusin', { target: h.chart });
  assert.equal(h.tooltip.hidden, false);
  assert.match(h.tooltip.innerHTML, /Synthetic month 3/);
  h.windowListeners.scroll({ target: h.doc });
  assert.equal(h.tooltip.hidden, true);
  const before = h.doc.createElement;
  h.doc.createElement = () => { throw new Error('A second tooltip must not be created.'); };
  assert.doesNotThrow(() => initializeChartTooltips(h.doc));
  h.doc.createElement = before;
});


test('a tooltip covering the next spike does not capture chart inspection', () => {
  const h = harness();
  h.send('pointermove', { clientX: 10, clientY: 90 });
  assert.match(h.tooltip.innerHTML, /Synthetic month 1/);
  h.send('pointermove', { target: h.tooltip, clientX: 90, clientY: 15 });
  assert.match(h.tooltip.innerHTML, /Synthetic month 3/);
  assert.equal(h.tooltip.hidden, false);
  assert.equal(h.tooltip['aria-live'], 'off');
  // On a narrow viewport there is no side large enough for the popup;
  // it must still stay within the available screen.
  assert.ok(parseFloat(h.tooltip.style.left) >= 8);
  assert.ok(parseFloat(h.tooltip.style.left) + 240 <= 312);
});

test('pointer tooltips stay beside the cursor when the screen has room', () => {
  const h = harness();
  h.doc.documentElement.clientWidth = 1200;
  h.send('pointermove', { clientX: 50, clientY: 50 });
  assert.ok(parseFloat(h.tooltip.style.left) > 50);
  assert.ok(parseFloat(h.tooltip.style.top) > 50);
  h.send('pointermove', { clientX: 50, clientY: 80 });
  assert.ok(parseFloat(h.tooltip.style.top) > 80);
});

test('keyboard and pointer selection retain each series marker shape', () => {
  const h = harness(false, ['circle', 'square', 'diamond', 'triangle']);
  h.send('focusin', { target: h.chart });
  for (const shape of ['circle', 'square', 'diamond', 'triangle']) {
    assert.match(h.selection.innerHTML, new RegExp(`data-chart-shape="${shape}"`));
    assert.match(h.tooltip.innerHTML, new RegExp(`data-chart-shape="${shape}"`));
  }
  h.send('pointermove', { clientX: 90 });
  assert.match(h.tooltip.innerHTML, /Synthetic month 3/);
  assert.match(h.selection.innerHTML, /<rect[^>]+data-chart-shape="square"/);
  assert.match(h.selection.innerHTML, /<polygon[^>]+data-chart-shape="triangle"/);
});
