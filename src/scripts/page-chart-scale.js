export const CHART_SCALES = Object.freeze([
  { id: 'linear', label: 'Linear', note: '' },
  { id: 'sqrt', label: 'Square root', note: 'Compresses large outliers while giving everyday amounts more room.' },
  { id: 'log', label: 'Logarithmic', note: 'Signed log scale keeps zero and negative amounts visible.' },
]);
export const DEFAULT_CHART_SCALE = 'sqrt';
export const normalizeDefaultChartScale = value => CHART_SCALES.some(scale => scale.id === value) ? value : DEFAULT_CHART_SCALE;
export const normalizeChartScale = value => CHART_SCALES.some(scale => scale.id === value) ? value : 'linear';
export const chartScaleLabel = value => CHART_SCALES.find(scale => scale.id === normalizeChartScale(value)).label;

// The header control owns the scale for both full charts and statistic trends.
export function pageChartScale(container) {
  const page = container.closest?.('.view');
  const preference = page?.querySelector('[data-page-chart-scale]')?.value;
  const fallback = normalizeDefaultChartScale(container.ownerDocument?.documentElement?.dataset?.chartScaleDefault);
  const scale = !preference || preference === 'default' ? fallback : normalizeChartScale(preference);
  const note = page?.querySelector('.page-scale-note');
  if (note) {
    const description = CHART_SCALES.find(item => item.id === scale).note;
    note.hidden = !description;
    if (note.textContent !== description) note.textContent = description;
  }
  return scale;
}
