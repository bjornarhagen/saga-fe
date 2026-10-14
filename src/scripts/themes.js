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
  const description = document.getElementById('theme-description');
  const appearance = document.getElementById('appearance-control');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  if (!select || !modeSelect || !appearance) return;

  let theme = normalizeTheme(root.dataset.theme);
  let preference = normalizeMode(root.dataset.modePreference || root.dataset.mode);

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
  media.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key === 'saga-fe-theme') theme = normalizeTheme(event.newValue);
    else if (event.key === 'saga-fe-mode') preference = normalizeMode(event.newValue);
    else if (event.key === null) { theme = DEFAULT_THEME; preference = DEFAULT_MODE; }
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
  apply();
}
