import { initializeChartTooltips } from './chart-tooltips.js';
import { applyAsciiBackdrop } from './ascii-lab-backdrop.js';
import { applyAsciiGlyphs } from './ascii-chart-glyphs.js';
import { labCategories, labMoney } from '../lib/ascii-lab.js';

const root = document.documentElement;
const theme = document.getElementById('lab-theme');
const mode = document.getElementById('lab-mode');
const cell = document.getElementById('lab-cell');
const lineMode = document.getElementById('lab-line-mode');
const mix = document.getElementById('lab-mix');
const effects = document.getElementById('lab-effects');
const status = document.getElementById('lab-render-status');
const form = document.querySelector('.lab-controls');
const initial = { theme: root.dataset.theme, mode: root.dataset.mode };
theme.value = initial.theme;
mode.value = initial.mode;
const plots = [...document.querySelectorAll('[data-lab-method]:not([data-lab-method="original"]) .chart-plot')];
mix.disabled = !document.querySelector('[data-lab-method="backdrop"]');
lineMode.disabled = !document.querySelector('[data-lab-method="glyphs"]');
cell.disabled = effects.disabled = !plots.length;
let cleanups = [], generation = 0, timer;

async function render() {
  const current = ++generation;
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  document.body.dataset.labEffects = effects.checked ? 'on' : 'off';
  document.getElementById('lab-mix-value').value = `${mix.value}%`;
  status.textContent = '';
  if (!effects.checked) return;
  const results = await Promise.allSettled(plots.map(async plot => {
    const options = { cellSize: Number(cell.value), mix: 1 - Number(mix.value) / 100, lineMode: lineMode.value };
    const cleanup = plot.closest('[data-lab-method]').dataset.labMethod === 'backdrop'
      ? await applyAsciiBackdrop(plot, options) : applyAsciiGlyphs(plot, options);
    if (current !== generation) cleanup();
    else cleanups.push(cleanup);
  }));
  if (current === generation && results.some(result => result.status === 'rejected')) status.textContent = 'One treatment could not render. Its original chart is still available.';
}

function schedule() { clearTimeout(timer); timer = setTimeout(render, 100); }
form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('input', event => {
  document.getElementById('lab-mix-value').value = `${mix.value}%`;
  if (event.target === theme || event.target === mode) {
    root.dataset.theme = theme.value;
    root.dataset.mode = mode.value;
  }
  schedule();
});
form.addEventListener('reset', () => {
  setTimeout(() => {
    theme.value = initial.theme; mode.value = initial.mode;
    root.dataset.theme = initial.theme; root.dataset.mode = initial.mode;
    render();
  }, 0);
});

const sizes = new WeakMap();
const resize = new ResizeObserver(entries => {
  let changed = false;
  for (const entry of entries) {
    const size = `${entry.contentRect.width.toFixed(1)},${entry.contentRect.height.toFixed(1)}`;
    if (sizes.get(entry.target) !== size) { sizes.set(entry.target, size); changed = true; }
  }
  if (changed) schedule();
});
for (const plot of plots) resize.observe(plot);
initializeChartTooltips();
await document.fonts.ready;
await render();

const dialog = document.getElementById('lab-category-dialog');
document.addEventListener('click', event => {
  const button = event.target.closest('[data-lab-category]');
  if (!button) return;
  const category = labCategories[Number(button.dataset.labCategory)];
  document.getElementById('lab-dialog-title').textContent = category.name;
  document.getElementById('lab-dialog-copy').textContent = `${labMoney(category.amount)} in the six-month sample.`;
  dialog.showModal();
});
document.getElementById('lab-dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
