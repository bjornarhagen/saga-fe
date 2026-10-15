import { defaultForecastScopes, forecastScopes } from './forecast-combinations.js';

export const forecastScopeColors = {
  cash: 'var(--chart-1)',
  reserve: 'var(--chart-4)',
  investments: 'var(--chart-3)',
  'cash-reserve': 'var(--chart-6)',
  'cash-investments': 'var(--chart-5)',
  'cash-reserve-investments': 'var(--chart-2)',
};
const methods = {
  scenario: { name: 'Your scenario', dashArray: 'solid', shape: 'circle', strokeWidth: 3 },
  unchanged: { name: 'Unchanged assumptions', dashArray: 'long-dash', shape: 'square' },
  average: { name: 'Historical average', dashArray: 'dashed', shape: 'diamond' },
  recent: { name: 'Last month', dashArray: 'dotted', shape: 'triangle' },
  smoothed: { name: 'Exponential smoothing', dashArray: 'dash-dot', shape: 'diamond' },
  seasonal: { name: 'Seasonal repeat', dashArray: '12 3 2 3', shape: 'square' },
};
const safe = Number.isSafeInteger;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const startLabel = kind => kind === 'estimated' ? ' · latest-value starting estimate' : kind === 'manual' ? ' · manual starting totals' : '';
const keyPart = value => value.replaceAll('-', '_');

// Presentation only: account roles, observations, method arithmetic and saved
// scenario values have already been handled by the combination data builder.
export function forecastChartModel({ combinations = { scopes: [] }, settings = {}, asOf, buffer = 0, openingReserve = 0, openingInvestments = 0 } = {}) {
  if (!validDate(asOf)) throw new RangeError('The forecast chart needs a valid starting date.');
  const selectedScopes = new Set(settings.scopes || defaultForecastScopes);
  const selectedMethods = [...new Set(settings.methods || ['scenario'])].filter(id => Object.hasOwn(methods, id));
  const visibleScopes = (combinations.scopes || []).filter(scope => selectedScopes.has(scope.id) && Object.hasOwn(forecastScopeColors, scope.id));
  const series = [], records = new Map(), notes = new Set(), references = [], dates = new Set([asOf]);
  const showPoints = settings.points !== false;
  let projectedCount = 0;

  function addSeries(descriptor, source) {
    const values = new Map();
    for (const point of source) {
      if (!validDate(point.date)) continue;
      dates.add(point.date);
      values.set(point.date, safe(point.value) ? point.value : null);
    }
    if (![...values.values()].some(safe)) return;
    // A date sampled by another series is not evidence of a gap in this one.
    // The renderer skips absent keys, but an explicit unknown remains null.
    series.push({ strokeWidth: 2.5, opacity: 1, showPoints, skipMissingDates: true, ...descriptor });
    records.set(descriptor.key, values);
  }

  for (const scope of visibleScopes) {
    const prefix = keyPart(scope.id), color = forecastScopeColors[scope.id];
    const name = forecastScopes.find(item => item.id === scope.id).name;
    const history = (scope.history || []).filter(point => point.date <= asOf);
    const observed = history.filter(point => safe(point.value));
    if (observed.length) addSeries({ key: `observed_${prefix}`, name: `${name} · observed history`, color, dashArray: 'solid', shape: 'square', opacity: .65 }, history);
    if (!observed.length) notes.add(`${name}: no complete same-date recorded history is available.`);
    else if (observed.length === 1) notes.add(`${name}: only one complete dated observation is available; more observations are needed for a historical line.`);
    if (history.some(point => point.value == null)) notes.add(`${name}: gaps mark dates without a known observation for every included account.`);

    const paths = scope.projections || [];
    const reconstructed = scope.id === 'cash' ? (scope.reconstructedHistory || []).filter(point => point.date < asOf && safe(point.value)) : [];
    if (reconstructed.length) {
      const anchor = paths.find(path => !path.reason && path.points?.some(point => point.date === asOf && safe(point.value)))?.points.find(point => point.date === asOf);
      addSeries({ key: 'reconstructed_cash', name: 'Available cash · reconstructed history (estimate)', color, dashArray: 'dotted', shape: 'circle', showPoints: false, opacity: .5 }, [...reconstructed, ...(anchor ? [{ date: asOf, value: anchor.value }] : [])]);
      notes.add('Reconstructed cash history is an estimate from recorded cash movements and the scenario starting balance. It is separate from observed account values; savings and investment history is never inferred from transfers.');
    }

    for (const id of selectedMethods) {
      const path = paths.find(item => item.id === id);
      const style = methods[id];
      const projected = (path?.points || []).filter(point => validDate(point.date) && point.date >= asOf);
      if (!path || path.reason || !projected.some(point => safe(point.value))) {
        notes.add(`${name} · ${style.name}: ${path?.reason || 'No projection is available for this method.'}`);
        continue;
      }
      addSeries({ ...style, key: `projected_${prefix}_${id}`, name: `${name} · ${path.name || style.name}${startLabel(path.startKind)}`, color, showPoints }, projected);
      projectedCount++;
      if (path.startKind === 'estimated') notes.add('Projected paths labelled latest-value starting estimate use recorded values from different dates; their starting point is separate from same-date observed history.');
      if (path.startKind === 'manual') notes.add('Projected paths labelled manual starting totals use entered cash or reserve totals, which can differ from observed account history.');
    }
    // A recorded starting guide remains useful if a method is unavailable.
    if (settings.startingGuides && scope.reference && safe(scope.reference.value) && !references.some(reference => reference.scopeId === scope.id)) references.push({ scopeId: scope.id, name: `Starting ${name.toLowerCase()}${startLabel(scope.reference.kind)}`, value: scope.reference.value, color, dashArray: 'long-dash', strokeWidth: 1, opacity: .55, includeInRange: true });
  }

  references.unshift({ name: 'Zero', value: 0, color: 'var(--chart-label)', dashArray: 'solid', strokeWidth: 1.5, opacity: .75, includeInRange: true });
  if (safe(buffer) && buffer !== 0) references.push({ name: 'Minimum cash buffer', value: buffer, color: 'var(--chart-7)', dashArray: 'dashed', strokeWidth: 1.5, opacity: .8, includeInRange: true });
  else if (!safe(buffer)) notes.add('The cash buffer guide is unavailable because its value is outside the supported integer øre range.');

  if (settings.fundingLimits && visibleScopes.some(scope => scope.id === 'cash')) {
    const funding = new Map();
    function fundingGuide(value, name, color) {
      if (!safe(value) || value <= 0) return;
      const level = -value, existing = funding.get(level);
      if (existing) existing.name += ` / ${name.replace('Cash shortfall = ', '')}`;
      else funding.set(level, { name, value: level, color, dashArray: 'dash-dot', strokeWidth: 1, opacity: .65, includeInRange: true });
    }
    const reserveReady = safe(openingReserve) && openingReserve >= 0;
    const investmentsReady = safe(openingInvestments) && openingInvestments >= 0;
    if (reserveReady) fundingGuide(openingReserve, 'Cash shortfall = starting savings', forecastScopeColors.reserve);
    if (investmentsReady) fundingGuide(openingInvestments, 'Cash shortfall = starting investments', forecastScopeColors.investments);
    if (reserveReady && investmentsReady) {
      const total = BigInt(openingReserve) + BigInt(openingInvestments);
      if (total <= BigInt(Number.MAX_SAFE_INTEGER)) fundingGuide(Number(total), 'Cash shortfall = starting savings + investments', forecastScopeColors['cash-reserve-investments']);
      else notes.add('The combined funding limit exceeds the supported integer øre range and is omitted.');
    } else notes.add('Funding limits need known, nonnegative starting savings and investment values; unavailable limits are omitted.');
    references.push(...funding.values());
    notes.add('Funding limits compare a cash shortfall with opening savings and investment values. They are informational; the guides do not transfer savings or assume investments can be sold. Cash paths are shown before reserve transfers; other views model reserve support.');
  }

  const points = [...dates].sort().map(date => ({ date, ...(date === asOf ? { starting: true } : {}), ...Object.fromEntries(series.filter(item => records.get(item.key).has(date)).map(item => [item.key, records.get(item.key).get(date)])) }));
  const startIndex = points.findIndex(point => point.date === asOf);
  return { points, series, references, markers: startIndex < 0 ? [] : [{ index: startIndex, name: 'Forecast starts' }], notes: [...notes], projectedCount };
}
