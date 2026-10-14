import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { DEFAULT_THEME, THEMES, normalizeTheme, normalizeMode, resolveMode } from '../src/scripts/themes.js';

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
  for (const path of ['src/styles/dashboard.css', 'src/layouts/DashboardLayout.astro', 'src/scripts/dashboard.js']) {
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

function beforePaint(saved, systemIsDark = false, storageThrows = false) {
  const dataset = { theme: DEFAULT_THEME, mode: 'dark', modePreference: 'dark', themeOptions: THEMES.map(theme => theme.id).join(',') };
  vm.runInNewContext(readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8'), {
    document: { documentElement: { dataset } },
    localStorage: { getItem(key) { if (storageThrows) throw new Error('Storage unavailable'); return saved[key] ?? null; } },
    window: { matchMedia() { return { matches: systemIsDark }; } },
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
