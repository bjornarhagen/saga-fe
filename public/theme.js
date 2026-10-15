// Runs before paint so saved appearance preferences do not flash another
// palette. The server renders the available IDs from the shared theme registry.
// Keep the existing saga-fe-mode key so previous light/dark choices survive.
try {
  const root = document.documentElement;
  const themes = (root.dataset.themeOptions || '').split(',');
  const theme = localStorage.getItem('saga-fe-theme');
  const preference = localStorage.getItem('saga-fe-mode');
  if (themes.includes(theme)) root.dataset.theme = theme;
  if (['light', 'dark', 'system'].includes(preference)) {
    root.dataset.modePreference = preference;
    root.dataset.mode = preference === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : preference;
  }
} catch { /* Use the default palette when storage is unavailable. */ }

// Motion defaults to the OS even when browser storage is unavailable.
{
  const root = document.documentElement;
  let preference = 'system';
  try {
    const saved = localStorage.getItem('saga-fe-motion');
    if (['system', 'full', 'reduce'].includes(saved)) preference = saved;
  } catch { /* Follow the device setting. */ }
  root.dataset.motionPreference = preference;
  root.dataset.motion = preference === 'system'
    ? (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'full')
    : preference;
}

// Resolve the default chart scale before any charts are drawn.
{
  const root = document.documentElement;
  let scale = root.dataset.chartScaleDefault || 'sqrt';
  try {
    const saved = localStorage.getItem('saga-fe-chart-scale');
    if ((root.dataset.chartScaleOptions || 'linear,sqrt,log').split(',').includes(saved)) scale = saved;
  } catch { /* Keep square root when browser storage is unavailable. */ }
  root.dataset.chartScaleDefault = scale;
}
