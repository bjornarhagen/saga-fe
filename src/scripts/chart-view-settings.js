export const CHART_VIEWS = Object.freeze([
  { id: 'normal', label: 'Normal' },
  { id: 'ascii', label: 'ASCII' },
]);
export const ASCII_CELL_SIZES = Object.freeze([3, 5, 7, 10]);
export const DEFAULT_CHART_VIEW = 'ascii';
export const DEFAULT_ASCII_CELL_SIZE = 7;
export const normalizeChartView = value => CHART_VIEWS.some(view => view.id === value) ? value : DEFAULT_CHART_VIEW;
export const normalizeAsciiCellSize = value => ASCII_CELL_SIZES.find(size => size === value || String(size) === value) ?? DEFAULT_ASCII_CELL_SIZE;
