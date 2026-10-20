import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeChartViews } from '../src/scripts/chart-views.js';

// A small DOM/observer harness exercises the manager's scheduling and cleanup.
// Child mutations are delivered separately from animation frames, as in a browser.
function harness() {
  const frames = new Map(), events = new Map(), pendingMutations = [];
  const observers = { resize: [], mutation: [] };
  let nextFrame = 0;
  const doc = {};
  class Element {
    constructor(tagName = 'div', className = '', width = 280, height = 120) {
      this.ownerDocument = doc; this.tagName = tagName.toUpperCase(); this.className = className;
      this.children = []; this.parentElement = null; this.attributes = new Map(); this.dataset = {};
      this.bounds = { width, height };
      const properties = new Map();
      this.style = { setProperty: (name, value) => properties.set(name, value), getPropertyValue: name => properties.get(name) || '', removeProperty: name => properties.delete(name) };
    }
    get isConnected() { return this === doc.documentElement || !!this.parentElement?.isConnected; }
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim();
        if (value.startsWith('.')) return this.className.split(/\s+/).includes(value.slice(1));
        if (value.startsWith('[')) return this.attributes.has(value.slice(1, -1));
        return this.tagName === value.toUpperCase();
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    append(...children) {
      for (const child of children) {
        child.remove(); child.parentElement = this; this.children.push(child);
        mutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
      }
    }
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;
      mutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
    }
    setAttribute(name, value) {
      this.attributes.set(name, value);
      mutation({ type: 'attributes', target: this, attributeName: name });
    }
    removeAttribute(name) {
      if (!this.attributes.delete(name)) return;
      mutation({ type: 'attributes', target: this, attributeName: name });
    }
    get hidden() { return this.attributes.has('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    getBoundingClientRect() {
      for (let node = this; node; node = node.parentElement) {
        if (node.hidden || node.tagName === 'DIALOG' && !node.attributes.has('open')) return { width: 0, height: 0 };
      }
      return this.bounds;
    }
  }
  function mutation(change) {
    if (!change.target.isConnected) return;
    for (const observer of observers.mutation) {
      if (!observer.connected) continue;
      if (change.type === 'attributes' && !observer.options.attributeFilter.includes(change.attributeName)) continue;
      pendingMutations.push({ observer, change });
    }
  }
  doc.documentElement = new Element('html');
  doc.documentElement.dataset = { chartView: 'ascii', asciiCellSize: '7' };
  doc.body = new Element('body'); doc.documentElement.append(doc.body);
  doc.createElement = tagName => new Element(tagName);
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  doc.defaultView = {
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.elements = new Set(); observers.resize.push(this); }
      observe(element) { this.elements.add(element); }
      unobserve(element) { this.elements.delete(element); }
      disconnect() { this.elements.clear(); this.disconnected = true; }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.mutation.push(this); }
      observe(target, options) { this.options = options; this.connected = true; }
      disconnect() { this.connected = false; }
    },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
    removeEventListener(name, callback) { events.get(name)?.delete(callback); },
  };
  function settle() {
    for (let turn = 0; turn < 20; turn++) {
      const changes = pendingMutations.splice(0), grouped = new Map();
      for (const { observer, change } of changes) if (observer.connected) {
        if (!grouped.has(observer)) grouped.set(observer, []);
        grouped.get(observer).push(change);
      }
      for (const [observer, records] of grouped) observer.callback(records);
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback();
      if (!pendingMutations.length && !frames.size) return;
    }
    assert.fail('Chart rendering kept scheduling itself');
  }
  function plot(parent = doc.body) {
    const element = new Element('div', 'chart-plot'), svg = new Element('svg');
    const source = new Element('path'), selection = new Element('g', 'chart-selection');
    source.style.setProperty('opacity', '.6'); svg.append(source, selection); element.append(svg); parent.append(element);
    return { element, svg, source, selection };
  }
  const calls = [], cleanups = [];
  function renderGlyphs(element, options) {
    const svg = element.querySelector('svg'), source = svg.querySelector('path');
    const original = source.style.getPropertyValue('opacity');
    const layer = new Element('g'); layer.setAttribute('data-ascii-glyphs', '');
    source.style.setProperty('opacity', '0'); svg.append(layer);
    calls.push({ element, options, layer });
    return () => { source.style.setProperty('opacity', original); layer.remove(); cleanups.push(element); };
  }
  return {
    doc, Element, plot, renderGlyphs, calls, cleanups, observers, frames, settle,
    start: () => initializeChartViews(doc, { renderGlyphs }),
    event(name = 'saga:chartviewchange') { for (const callback of events.get(name) || []) callback(); },
    resize(element, width, height = element.bounds.height) {
      element.bounds = { width, height };
      for (const observer of observers.resize) if (observer.elements.has(element)) observer.callback([{ target: element, contentRect: { width, height } }]);
    },
  };
}

test('Normal view restores SVG source paint and both kinds of character bars', () => {
  const h = harness(), chart = h.plot();
  const bars = ['bar-fill', 'account-allocation-bar'].map(className => {
    const bar = new h.Element('span', className, 70, 5); h.doc.body.append(bar); return bar;
  });
  const dispose = h.start(); h.settle();
  assert.equal(chart.source.style.getPropertyValue('opacity'), '0');
  for (const bar of bars) {
    assert.equal(bar.querySelector('.ascii-bar-glyphs').textContent, '##########');
    assert.equal(bar.attributes.has('data-ascii-bar'), true);
  }
  h.doc.documentElement.dataset.chartView = 'normal'; h.event(); h.settle();
  assert.equal(chart.source.style.getPropertyValue('opacity'), '.6');
  assert.equal(chart.svg.querySelector('[data-ascii-glyphs]'), null);
  assert.equal(h.cleanups.length, 1);
  for (const bar of bars) {
    assert.equal(bar.querySelector('.ascii-bar-glyphs'), null);
    assert.equal(bar.attributes.has('data-ascii-bar'), false);
  }
  h.doc.documentElement.dataset.chartView = 'ascii'; h.event(); h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(chart.source.style.getPropertyValue('opacity'), '0');
  dispose();
});

test('size changes and real resizes redraw once, while repeated resize reports do not', () => {
  const h = harness(), chart = h.plot(), dispose = h.start(); h.settle();
  assert.deepEqual(h.calls[0].options, { cellSize: 7, lineMode: 'rotated' });
  h.doc.documentElement.dataset.asciiCellSize = '3'; h.event(); h.event(); h.settle();
  assert.equal(h.calls.length, 2); assert.equal(h.calls.at(-1).options.cellSize, 3);
  assert.equal(h.cleanups.length, 1);
  h.resize(chart.element, 360); h.settle();
  assert.equal(h.calls.length, 3); assert.equal(h.cleanups.length, 2);
  h.resize(chart.element, 360); h.settle();
  assert.equal(h.calls.length, 3);
  h.event('saga:themechange'); h.settle();
  assert.equal(h.calls.length, 4, 'A theme change must refresh the glyph paint at the same size');
  assert.equal(h.doc.documentElement.style.getPropertyValue('--ascii-cell-size'), '3px');
  dispose();
});

test('hidden sections and closed dialogs render when opened and release paint when hidden', () => {
  const h = harness(), section = new h.Element('section'), dialog = new h.Element('dialog');
  section.hidden = true; h.doc.body.append(section, dialog);
  const sectionChart = h.plot(section), dialogChart = h.plot(dialog), dispose = h.start(); h.settle();
  assert.equal(h.calls.length, 0);
  section.hidden = false; h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].element, sectionChart.element);
  dialog.setAttribute('open', ''); h.settle();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].element, dialogChart.element);
  section.hidden = true; dialog.removeAttribute('open'); h.settle();
  assert.equal(h.cleanups.length, 2);
  assert.equal(sectionChart.source.style.getPropertyValue('opacity'), '.6');
  assert.equal(dialogChart.source.style.getPropertyValue('opacity'), '.6');
  dispose();
});

test('new charts, same-size SVG replacements and detached charts have independent lifecycles', () => {
  const h = harness(), first = h.plot(), dispose = h.start(); h.settle();
  const second = h.plot(); h.settle();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].element, second.element);
  const nextSvg = new h.Element('svg'), nextSource = new h.Element('path');
  nextSource.style.setProperty('opacity', '.4'); nextSvg.append(nextSource);
  first.svg.remove(); first.element.append(nextSvg); h.settle();
  assert.equal(h.calls.length, 3);
  assert.equal(first.source.style.getPropertyValue('opacity'), '.6');
  assert.equal(nextSource.style.getPropertyValue('opacity'), '0');
  second.element.remove(); h.settle();
  assert.equal(h.calls.length, 3);
  assert.equal(second.source.style.getPropertyValue('opacity'), '.6');
  assert.equal(h.observers.resize[0].elements.has(second.element), false);
  dispose();
});

test('hover and glyph mutations do not redraw, but changed source geometry does', () => {
  const h = harness(), chart = h.plot(), dispose = h.start(); h.settle();
  assert.equal(h.calls.length, 1, 'Appending the generated layer must not start a redraw loop');
  const selectionMarker = new h.Element('circle'); chart.selection.append(selectionMarker); h.settle();
  selectionMarker.remove(); h.settle();
  const character = new h.Element('text'); h.calls[0].layer.append(character); h.settle();
  character.remove(); h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.cleanups.length, 0);
  const sourceDetail = new h.Element('path'); chart.svg.append(sourceDetail); h.settle();
  assert.equal(h.calls.length, 2, 'A source replacement at unchanged dimensions must redraw');
  assert.equal(h.cleanups.length, 1);
  dispose();
});

test('disposal cancels pending work, disconnects observers and allows fresh initialization', () => {
  const h = harness(), chart = h.plot(), dispose = h.start();
  assert.equal(h.start(), dispose, 'Repeated initialization must share one manager');
  h.settle();
  h.event(); assert.equal(h.frames.size, 1); dispose(); h.settle();
  assert.equal(h.frames.size, 0);
  assert.equal(h.cleanups.length, 1);
  assert.equal(chart.source.style.getPropertyValue('opacity'), '.6');
  assert.equal(h.observers.resize[0].disconnected, true);
  assert.equal(h.observers.mutation[0].connected, false);
  h.event(); h.event('saga:themechange'); h.resize(chart.element, 400); h.settle();
  assert.equal(h.calls.length, 1);
  const nextDispose = h.start(); assert.notEqual(nextDispose, dispose); h.settle();
  assert.equal(h.calls.length, 2); nextDispose();
});
