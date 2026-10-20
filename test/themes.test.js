import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { normalizeMotion, resolveMotion, reducedMotion } from '../src/scripts/motion.js';
import { CHART_SCALES, DEFAULT_CHART_SCALE, normalizeDefaultChartScale, chartScaleLabel } from '../src/scripts/page-chart-scale.js';
import { DEFAULT_THEME, DEFAULT_MODE, THEMES, normalizeTheme, normalizeMode, resolveMode, initializeThemes } from '../src/scripts/themes.js';
import { CHART_VIEWS, ASCII_CELL_SIZES, DEFAULT_CHART_VIEW, DEFAULT_ASCII_CELL_SIZE, normalizeChartView, normalizeAsciiCellSize } from '../src/scripts/chart-view-settings.js';

const styles = new URL('../src/styles/', import.meta.url);
const themeDirectory = new URL('themes/', styles);
const tokens = [
  '--bg', '--bg-1', '--bg-2', '--panel', '--panel-2', '--hairline', '--border', '--border-strong', '--rule-line',
  '--fg', '--fg-1', '--fg-dim', '--fg-muted', '--fg-faint', '--accent', '--link', '--accent-dim', '--accent-2', '--accent-2-dim',
  '--ok', '--warn', '--err', '--button-ink', '--theme-font-display', '--theme-font-mono', '--theme-font-body',
  '--flavor-grid-line', '--flavor-bullet', '--flavor-sep', '--flavor-arrow', '--ornament-divider', '--ornament-divider-cap',
  '--ornament-corner', '--ornament-corner-small', '--ornament-separator', '--ornament-mark', '--ornament-header', '--ornament-header-ratio',
];

function palettes(css) {
  const base = {}, dark = {};
  for (const block of css.matchAll(/\[data-theme="[^"]+"\](\[data-mode="dark"\])?\s*\{([^}]*)\}/g)) {
    const target = block[1] ? dark : base;
    for (const declaration of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) target[declaration[1]] = declaration[2].trim();
  }
  return { light: base, dark: { ...base, ...dark } };
}

function color(palette, token, seen = new Set()) {
  assert.ok(!seen.has(token), `Cyclic token: ${token}`);
  seen.add(token);
  const value = palette[token];
  const alias = /^var\((--[\w-]+)\)$/.exec(value || '');
  if (alias) return color(palette, alias[1], seen);
  assert.match(value || '', /^#[\da-f]{6}$/i, `Expected a color for ${token}`);
  return value;
}

function luminance(hex) {
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test('theme registry, imports and token files stay in sync', () => {
  assert.deepEqual(readdirSync(themeDirectory).sort(), THEMES.map(theme => `${theme.id}.css`).sort());
  const entrypoint = readFileSync(new URL('theme.css', styles), 'utf8');
  for (const theme of THEMES) {
    assert.ok(entrypoint.includes(`./themes/${theme.id}.css`));
    const css = readFileSync(new URL(`${theme.id}.css`, themeDirectory), 'utf8');
    assert.ok(css.includes(`[data-theme="${theme.id}"]`));
    assert.doesNotMatch(css, /^\s*:root\s*\{/m);
    const modes = palettes(css);
    for (const [mode, palette] of Object.entries(modes)) {
      assert.deepEqual(tokens.filter(token => !palette[token]), [], `${theme.id} ${mode}: incomplete palette`);
    }
    for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      assert.ok(match[1].startsWith('/ornaments/'), 'Theme art must use local decorative assets');
      assert.ok(existsSync(new URL(`../public${match[1]}`, import.meta.url)), `Missing theme asset: ${match[1]}`);
    }
  }
});

for (const theme of THEMES) {
  const css = readFileSync(new URL(`${theme.id}.css`, themeDirectory), 'utf8');
  for (const [mode, palette] of Object.entries(palettes(css))) {
    test(`${theme.label} ${mode} preserves text, status and primary button contrast`, () => {
      for (const ink of ['--fg', '--fg-1', '--fg-dim']) {
        for (const surface of ['--bg', '--bg-1', '--bg-2', '--panel', '--panel-2']) {
          const ratio = contrast(color(palette, ink), color(palette, surface));
          assert.ok(ratio >= 4.5, `${ink} on ${surface}: ${ratio.toFixed(2)}:1`);
        }
      }
      for (const surface of ['--bg', '--bg-1']) {
        assert.ok(contrast(color(palette, '--link'), color(palette, surface)) >= 4.5, `Link contrast on ${surface}`);
      }
      for (const status of ['--ok', '--warn', '--err', '--accent', '--accent-2']) {
        assert.ok(contrast(color(palette, status), color(palette, '--bg')) >= 3, `${status} contrast`);
      }
      assert.ok(contrast(color(palette, '--button-ink'), color(palette, '--accent')) >= 4.5, 'Primary button text contrast');
    });
  }
}

test('dashboard components consume semantic colors', () => {
  for (const path of ['src/styles/dashboard.css', 'src/layouts/DashboardLayout.astro', 'src/scripts/dashboard.js', 'src/scripts/charts.js', 'src/scripts/chart-tooltips.js', 'src/scripts/statistics.js', 'src/scripts/accounts.js', 'src/scripts/explorer.js']) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const rawColorLines = source.split('\n').filter(line => /#[\da-f]{3}(?:[\da-f]{3})?\b|rgba?\(|hsla?\(/i.test(line));
    assert.deepEqual(rawColorLines, [], `${path} contains a raw color`);
  }
});

test('unknown saved preferences recover to the default and system mode resolves', () => {
  assert.equal(normalizeTheme('unknown-theme'), DEFAULT_THEME);
  assert.equal(normalizeTheme(null), DEFAULT_THEME);
  for (const theme of THEMES) assert.equal(normalizeTheme(theme.id), theme.id);
  assert.equal(normalizeMode('invalid'), 'dark');
  assert.equal(resolveMode('system', true), 'dark');
  assert.equal(resolveMode('system', false), 'light');
  assert.equal(resolveMode('light', true), 'light');
  assert.equal(resolveMode('dark', false), 'dark');
});

function beforePaint(saved, systemIsDark = false, storageThrows = false, systemReducesMotion = false) {
  const dataset = { theme: DEFAULT_THEME, mode: 'dark', modePreference: 'dark', themeOptions: THEMES.map(theme => theme.id).join(',') };
  vm.runInNewContext(readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8'), {
    document: { documentElement: { dataset } },
    localStorage: { getItem(key) { if (storageThrows) throw new Error('Storage unavailable'); return saved[key] ?? null; } },
    window: { matchMedia(query) { return { matches: query.includes('reduced-motion') ? systemReducesMotion : systemIsDark }; } },
  });
  return dataset;
}

test('before-paint initialization preserves existing modes and validates saved themes', () => {
  assert.equal(beforePaint({ 'saga-fe-mode': 'light' }).mode, 'light');
  const saved = { 'saga-fe-theme': 'girlypop', 'saga-fe-mode': 'system' };
  assert.equal(beforePaint(saved, true).theme, 'girlypop');
  assert.equal(beforePaint(saved, true).mode, 'dark');
  assert.equal(beforePaint(saved, false).mode, 'light');
  assert.equal(beforePaint({ 'saga-fe-theme': 'unexpected', 'saga-fe-mode': 'unexpected' }).theme, DEFAULT_THEME);
  assert.equal(beforePaint(saved, false, true).mode, 'dark');
});


test('motion preferences follow the OS by default and explicit choices override it before paint', () => {
  assert.equal(normalizeMotion('unexpected'), 'system');
  assert.equal(resolveMotion('system', true), 'reduce');
  assert.equal(resolveMotion('system', false), 'full');
  assert.equal(resolveMotion('full', true), 'full');
  assert.equal(resolveMotion('reduce', false), 'reduce');
  assert.equal(beforePaint({}, false, false, true).motion, 'reduce');
  assert.equal(beforePaint({ 'saga-fe-motion': 'full' }, false, false, true).motion, 'full');
  assert.equal(beforePaint({ 'saga-fe-motion': 'reduce' }).motion, 'reduce');
  assert.equal(beforePaint({ 'saga-fe-motion': 'invalid' }).motionPreference, 'system');
  assert.equal(beforePaint({}, false, true, true).motion, 'reduce');
  const win = motion => ({ document: { documentElement: { dataset: { motion } } }, matchMedia: () => ({ matches: true }) });
  assert.equal(reducedMotion(win('full')), false);
  assert.equal(reducedMotion(win('reduce')), true);
  assert.equal(reducedMotion(win(undefined)), true);
});


function appearanceHarness({ dataset = {}, storageThrows = false } = {}) {
  const controls = new Map(), saved = new Map(), events = {}, dispatched = [];
  const root = { dataset: { theme: DEFAULT_THEME, mode: 'dark', motionPreference: 'system', ...dataset } };
  const defaultOption = { textContent: '' };
  const element = id => {
    if (!controls.has(id)) controls.set(id, { value: '', addEventListener(name, callback) { this[name] = callback; } });
    return controls.get(id);
  };
  const media = { matches: false, addEventListener(name, callback) { this.change = callback; } };
  const colorMedia = { matches: true, addEventListener() {} };
  vm.runInNewContext(`(${initializeThemes.toString()})()`, {
    document: { documentElement: root, getElementById: element, querySelectorAll: () => [defaultOption], addEventListener() {} },
    window: { matchMedia: query => query.includes('reduced-motion') ? media : colorMedia, dispatchEvent(event) { dispatched.push({ type: event.type, chartView: root.dataset.chartView, asciiCellSize: root.dataset.asciiCellSize }); }, addEventListener: (name, callback) => { events[name] = callback; } },
    localStorage: { setItem(key, value) { if (storageThrows) throw new Error('Storage unavailable'); saved.set(key, value); } },
    requestAnimationFrame() {}, CustomEvent: class { constructor(type) { this.type = type; } },
    THEMES, DEFAULT_THEME, DEFAULT_MODE, DEFAULT_CHART_SCALE, normalizeTheme, normalizeMode, resolveMode, normalizeMotion, resolveMotion, normalizeDefaultChartScale, chartScaleLabel,
    DEFAULT_CHART_VIEW, DEFAULT_ASCII_CELL_SIZE, normalizeChartView, normalizeAsciiCellSize,
  });
  return { root, element, saved, events, media, defaultOption, dispatched };
}

test('motion controls save choices, follow live OS changes only in system mode, and sync across tabs', () => {
  const { root, element, saved, events, media } = appearanceHarness();
  const motion = element('motion-select');
  assert.equal(root.dataset.motion, 'full');
  motion.value = 'full'; motion.change();
  assert.equal(saved.get('saga-fe-motion'), 'full');
  media.matches = true; media.change();
  assert.equal(root.dataset.motion, 'full');
  motion.value = 'system'; motion.change();
  assert.equal(root.dataset.motion, 'reduce');
  media.matches = false; media.change();
  assert.equal(root.dataset.motion, 'full');
  events.storage({ key: 'saga-fe-motion', newValue: 'reduce' });
  assert.equal(motion.value, 'reduce');
  assert.equal(root.dataset.motion, 'reduce');
  events.storage({ key: null });
  assert.equal(motion.value, 'system');
  assert.equal(root.dataset.motion, 'full');
});


test('default chart scale starts at square root and saved choices are validated before drawing', () => {
  assert.equal(beforePaint({}).chartScaleDefault, 'sqrt');
  assert.equal(beforePaint({}, false, true).chartScaleDefault, 'sqrt');
  assert.equal(beforePaint({ 'saga-fe-chart-scale': 'unknown' }).chartScaleDefault, 'sqrt');
  for (const scale of CHART_SCALES) {
    assert.equal(beforePaint({ 'saga-fe-chart-scale': scale.id }).chartScaleDefault, scale.id);
  }
});

test('Appearance saves the default scale, updates Default labels, and syncs across tabs', () => {
  const { root, element, saved, events, defaultOption } = appearanceHarness();
  const control = element('default-chart-scale-select');
  assert.equal(control.value, 'sqrt');
  assert.equal(root.dataset.chartScaleDefault, 'sqrt');
  assert.equal(defaultOption.textContent, 'Default: Square root');
  control.value = 'log'; control.change();
  assert.equal(saved.get('saga-fe-chart-scale'), 'log');
  assert.equal(root.dataset.chartScaleDefault, 'log');
  assert.equal(defaultOption.textContent, 'Default: Logarithmic');
  events.storage({ key: 'saga-fe-chart-scale', newValue: 'linear' });
  assert.equal(control.value, 'linear');
  assert.equal(defaultOption.textContent, 'Default: Linear');
  events.storage({ key: 'saga-fe-chart-scale', newValue: null });
  assert.equal(control.value, 'sqrt');
  events.storage({ key: null });
  assert.equal(control.value, 'sqrt');
});

test('chart appearance defaults to ASCII with 7 px characters and validates saved values before paint', () => {
  assert.equal(DEFAULT_CHART_VIEW, 'ascii');
  assert.equal(DEFAULT_ASCII_CELL_SIZE, 7);
  for (const view of CHART_VIEWS) {
    assert.equal(normalizeChartView(view.id), view.id);
    assert.equal(beforePaint({ 'saga-fe-chart-view': view.id }).chartView, view.id);
  }
  for (const size of ASCII_CELL_SIZES) {
    assert.equal(normalizeAsciiCellSize(size), size);
    assert.equal(normalizeAsciiCellSize(String(size)), size);
    assert.equal(beforePaint({ 'saga-fe-ascii-cell-size': String(size) }).asciiCellSize, String(size));
  }
  for (const invalid of [null, undefined, '', 'unexpected', '5px', '5.0', 6, 0, -3]) {
    assert.equal(normalizeAsciiCellSize(invalid), 7);
    assert.equal(beforePaint({ 'saga-fe-ascii-cell-size': invalid }).asciiCellSize, '7');
  }
  assert.equal(normalizeChartView('unexpected'), 'ascii');
  const fallback = beforePaint({ 'saga-fe-chart-view': 'unexpected' });
  assert.equal(fallback.chartView, 'ascii');
  assert.equal(fallback.asciiCellSize, '7');
  const blocked = beforePaint({ 'saga-fe-chart-view': 'normal', 'saga-fe-ascii-cell-size': '10' }, false, true);
  assert.equal(blocked.chartView, 'ascii');
  assert.equal(blocked.asciiCellSize, '7');
});

test('Appearance saves chart view and size, restores them on reload, and retains size in Normal view', () => {
  const { root, element, saved, dispatched } = appearanceHarness();
  const view = element('chart-view-select'), size = element('ascii-cell-size-select');
  const sizeControl = element('ascii-cell-size-control');
  assert.equal(view.value, 'ascii');
  assert.equal(size.value, '7');
  assert.equal(sizeControl.hidden, false);
  assert.equal(size.disabled, false);
  size.value = '10'; size.change();
  assert.equal(saved.get('saga-fe-ascii-cell-size'), '10');
  assert.equal(root.dataset.asciiCellSize, '10');
  view.value = 'normal'; view.change();
  assert.equal(saved.get('saga-fe-chart-view'), 'normal');
  assert.equal(root.dataset.chartView, 'normal');
  assert.equal(sizeControl.hidden, true);
  assert.equal(size.disabled, true);
  assert.equal(size.value, '10');

  const reload = appearanceHarness({ dataset: beforePaint(Object.fromEntries(saved)) });
  assert.equal(reload.element('chart-view-select').value, 'normal');
  assert.equal(reload.element('ascii-cell-size-select').value, '10');
  assert.equal(reload.element('ascii-cell-size-control').hidden, true);
  reload.element('chart-view-select').value = 'ascii';
  reload.element('chart-view-select').change();
  assert.equal(reload.root.dataset.asciiCellSize, '10');
  assert.equal(reload.element('ascii-cell-size-select').disabled, false);
  assert.deepEqual(dispatched.filter(event => event.type === 'saga:chartviewchange'), [
    { type: 'saga:chartviewchange', chartView: 'ascii', asciiCellSize: '7' },
    { type: 'saga:chartviewchange', chartView: 'ascii', asciiCellSize: '10' },
    { type: 'saga:chartviewchange', chartView: 'normal', asciiCellSize: '10' },
  ]);
});

test('chart appearance syncs storage changes, key removal and clear across tabs', () => {
  const { root, element, events, saved, dispatched } = appearanceHarness();
  const view = element('chart-view-select'), size = element('ascii-cell-size-select');
  events.storage({ key: 'saga-fe-chart-view', newValue: 'normal' });
  assert.equal(view.value, 'normal');
  assert.equal(element('ascii-cell-size-control').hidden, true);
  events.storage({ key: 'saga-fe-ascii-cell-size', newValue: '3' });
  assert.equal(size.value, '3');
  assert.equal(root.dataset.asciiCellSize, '3');
  events.storage({ key: 'saga-fe-chart-view', newValue: null });
  assert.equal(view.value, 'ascii');
  assert.equal(size.disabled, false);
  assert.equal(size.value, '3');
  events.storage({ key: 'saga-fe-ascii-cell-size', newValue: null });
  assert.equal(size.value, '7');
  events.storage({ key: 'saga-fe-chart-view', newValue: 'unsupported' });
  events.storage({ key: 'saga-fe-ascii-cell-size', newValue: '9' });
  assert.equal(view.value, 'ascii');
  assert.equal(size.value, '7');
  events.storage({ key: 'saga-fe-chart-view', newValue: 'normal' });
  events.storage({ key: 'saga-fe-ascii-cell-size', newValue: '5' });
  events.storage({ key: null });
  assert.equal(view.value, 'ascii');
  assert.equal(size.value, '7');
  assert.equal(root.dataset.chartView, 'ascii');
  assert.equal(root.dataset.asciiCellSize, '7');
  assert.equal(size.disabled, false);
  assert.equal(saved.size, 0, 'Storage events must not write preferences back to another tab');
  assert.deepEqual(dispatched.at(-1), { type: 'saga:chartviewchange', chartView: 'ascii', asciiCellSize: '7' });
});

test('chart appearance choices remain usable when browser storage is unavailable', () => {
  const { root, element } = appearanceHarness({ storageThrows: true });
  element('chart-view-select').value = 'normal'; element('chart-view-select').change();
  element('ascii-cell-size-select').value = '5'; element('ascii-cell-size-select').change();
  assert.equal(root.dataset.chartView, 'normal');
  assert.equal(root.dataset.asciiCellSize, '5');
});
