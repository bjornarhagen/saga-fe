// Runs before paint so saved theme and mode preferences do not flash another
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
