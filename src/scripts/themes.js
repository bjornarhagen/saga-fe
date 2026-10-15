import { DEFAULT_CHART_SCALE, normalizeDefaultChartScale, chartScaleLabel } from './page-chart-scale.js';
import { normalizeMotion, resolveMotion } from './motion.js';

// The theme registry is shared by the server-rendered controls and the client.
// Theme additions need one manifest here, a CSS import, and a complete token set.
export const THEMES = Object.freeze([
  { id: 'bjornarhagen', label: 'Bjørnarhagen', description: 'Charcoal, ivory, amber and crimson. The original Saga palette.' },
  { id: 'girlypop', label: 'Girlypop', description: 'Blush, plum, pink and gold, with botanical and bow details.' },
  { id: 'matrix', label: 'Matrix', description: 'Phosphor green, terminal typography and digital linework.' },
]);
export const MODES = Object.freeze(['light', 'dark', 'system']);
export const DEFAULT_THEME = 'bjornarhagen';
export const DEFAULT_MODE = 'dark';

export function normalizeTheme(value) {
  return THEMES.some(theme => theme.id === value) ? value : DEFAULT_THEME;
}

export function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

export function resolveMode(preference, systemIsDark) {
  const mode = normalizeMode(preference);
  return mode === 'system' ? (systemIsDark ? 'dark' : 'light') : mode;
}

export function initializeThemes() {
  const root = document.documentElement;
  const select = document.getElementById('theme-select');
  const modeSelect = document.getElementById('mode-select');
  const motionSelect = document.getElementById('motion-select');
  const chartScaleSelect = document.getElementById('default-chart-scale-select');
  const description = document.getElementById('theme-description');
  const appearance = document.getElementById('appearance-control');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!select || !modeSelect || !motionSelect || !chartScaleSelect || !appearance) return;

  let theme = normalizeTheme(root.dataset.theme);
  let preference = normalizeMode(root.dataset.modePreference || root.dataset.mode);
  let motion = normalizeMotion(root.dataset.motionPreference);
  let chartScale = normalizeDefaultChartScale(root.dataset.chartScaleDefault);

  function applyChartScale() {
    root.dataset.chartScaleDefault = chartScale;
    chartScaleSelect.value = chartScale;
    for (const option of document.querySelectorAll('[data-default-chart-scale]')) option.textContent = `Default: ${chartScaleLabel(chartScale)}`;
    window.dispatchEvent(new CustomEvent('saga:chartscaledefaultchange'));
  }

  function applyMotion() {
    root.dataset.motionPreference = motion;
    root.dataset.motion = resolveMotion(motion, motionMedia.matches);
    motionSelect.value = motion;
    window.dispatchEvent(new CustomEvent('saga:motionchange'));
  }

  function apply() {
    root.dataset.theme = theme;
    root.dataset.modePreference = preference;
    root.dataset.mode = resolveMode(preference, media.matches);
    select.value = theme;
    modeSelect.value = preference;
    description.textContent = THEMES.find(item => item.id === theme).description;
    // Charts read semantic CSS tokens when drawing. Notify after the new
    // palette has reached the document so their cached SVG colors update too.
    requestAnimationFrame(() => {
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
      window.dispatchEvent(new CustomEvent('saga:themechange', { detail: { theme, mode: root.dataset.mode, preference } }));
    });
  }

  function save(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Keep session preferences when storage is unavailable. */ }
  }

  select.addEventListener('change', () => {
    theme = normalizeTheme(select.value);
    save('saga-fe-theme', theme);
    apply();
  });
  modeSelect.addEventListener('change', () => {
    preference = normalizeMode(modeSelect.value);
    save('saga-fe-mode', preference);
    apply();
  });
  motionSelect.addEventListener('change', () => {
    motion = normalizeMotion(motionSelect.value);
    save('saga-fe-motion', motion);
    applyMotion();
  });
  chartScaleSelect.addEventListener('change', () => {
    chartScale = normalizeDefaultChartScale(chartScaleSelect.value);
    save('saga-fe-chart-scale', chartScale);
    applyChartScale();
  });
  motionMedia.addEventListener('change', () => { if (motion === 'system') applyMotion(); });
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === 'saga-fe-theme') theme = normalizeTheme(event.newValue);
    else if (event.key === 'saga-fe-mode') preference = normalizeMode(event.newValue);
    else if (event.key === 'saga-fe-motion') { motion = normalizeMotion(event.newValue); applyMotion(); return; }
    else if (event.key === 'saga-fe-chart-scale') { chartScale = normalizeDefaultChartScale(event.newValue); applyChartScale(); return; }
    else if (event.key === null) { theme = DEFAULT_THEME; preference = DEFAULT_MODE; motion = 'system'; chartScale = DEFAULT_CHART_SCALE; applyMotion(); applyChartScale(); }
    else return;
    apply();
  });
  document.addEventListener('click', event => {
    if (appearance.open && !appearance.contains(event.target)) appearance.open = false;
  });
  appearance.addEventListener('keydown', event => {
    if (event.key === 'Escape' && appearance.open) {
      event.preventDefault();
      appearance.open = false;
      appearance.querySelector('summary').focus();
    }
  });
  applyMotion();
  applyChartScale();
  apply();
}
