import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastChartModel, forecastScopeColors } from '../src/lib/forecast-chart-model.js';
import { forecastCombinations, forecastScopes } from '../src/lib/forecast-combinations.js';

const asOf = '2026-01-31';
const nextDate = '2026-02-28';
const ids = forecastScopes.map(scope => scope.id);
const allMethods = ['scenario', 'unchanged', 'average', 'recent', 'smoothed', 'seasonal'];
const account = (id, role, accountType, balance, history = []) => ({ id, role, accountType, balance, balanceDate: asOf, valueHistory: history });
const accounts = [account('daily', 'available', 'checking', 100, [{ date: '2025-12-31', amount: 200 }]), account('savings', 'reserve', 'savings', 1000, [{ date: '2025-12-31', amount: 900 }]), account('portfolio', 'excluded', 'investment', 2000, [{ date: '2025-12-31', amount: 2100 }])];
function combinations(options = {}) {
  return forecastCombinations({ accounts, asOf, scopes: ids, paths: allMethods.map((id, index) => ({ id, name: id === 'scenario' ? 'Your scenario' : id, projection: { start: { date: asOf, cash: 100, reserve: 1000, investments: 2000 }, points: [{ date: nextDate, cash: -100 - index, reserve: 1000, investments: 2000 }] } })), ...options });
}
const build = (options = {}) => forecastChartModel({ combinations: combinations(), settings: { scopes: ids, methods: allMethods }, asOf, ...options });

test('scope colors stay fixed while patterns and shapes identify methods', () => {
  const model = build();
  assert.equal(model.projectedCount, 36);
  const scenario = model.series.find(series => series.key === 'projected_cash_scenario');
  assert.equal(scenario.color, forecastScopeColors.cash);
  assert.equal(scenario.strokeWidth, 3);
  assert.equal(scenario.shape, 'circle');
  assert.deepEqual(allMethods.map(id => model.series.find(series => series.key === `projected_reserve_${id}`).dashArray), ['solid', 'long-dash', 'dashed', 'dotted', 'dash-dot', '12 3 2 3']);
  assert.deepEqual(allMethods.map(id => model.series.find(series => series.key === `projected_reserve_${id}`).shape), ['circle', 'square', 'diamond', 'triangle', 'diamond', 'square']);
  assert.deepEqual(Object.values(forecastScopeColors), [1, 4, 3, 6, 5, 2].map(number => `var(--chart-${number})`));
});

test('history is a separate muted series and projections retain negative cash', () => {
  const model = build({ settings: { scopes: ['cash'], methods: ['scenario'] } });
  const history = model.series.find(series => series.key === 'observed_cash');
  assert.equal(history.opacity, .65);
  assert.equal(history.shape, 'square');
  assert.equal(history.dashArray, 'solid');
  assert.equal(model.points[0].projected_cash_scenario, undefined);
  assert.equal(model.points.at(-1).observed_cash, undefined);
  assert.equal(model.points.at(-1).projected_cash_scenario, -100);
  assert.equal(model.projectedCount, 1);
});

test('missing observed dates break that history without breaking future paths', () => {
  const data = combinations();
  data.scopes.find(scope => scope.id === 'cash').history.splice(1, 0, { date: '2026-01-15', value: null, kind: 'observed' });
  data.scopes.find(scope => scope.id === 'reserve').history.push({ date: '2026-01-20', value: 950, kind: 'observed' });
  const model = build({ combinations: data });
  assert.equal(model.points.find(point => point.date === '2026-01-15').observed_cash, null);
  const unrelated = model.points.find(point => point.date === '2026-01-20');
  assert.equal(Object.hasOwn(unrelated, 'observed_cash'), false);
  assert.equal(Object.hasOwn(model.points.find(point => point.date === '2026-01-15'), 'observed_cash'), true);
  assert.ok(model.series.every(series => series.skipMissingDates === true));
  assert.ok(model.points.filter(point => point.date >= asOf).every(point => Number.isSafeInteger(point.projected_cash_scenario)));
  assert.ok(model.notes.some(note => note.includes('gaps mark')));
});

test('cash reconstruction gets its own estimated anchor and never creates wealth history', () => {
  const data = combinations({ reconstructedCash: [{ date: '2025-11-30', history: 350 }] });
  const model = build({ combinations: data });
  const reconstructed = model.series.find(series => series.key === 'reconstructed_cash');
  assert.match(reconstructed.name, /estimate/);
  assert.equal(reconstructed.dashArray, 'dotted');
  assert.equal(reconstructed.showPoints, false);
  assert.equal(reconstructed.opacity, .5);
  assert.equal(model.points.find(point => point.date === asOf).reconstructed_cash, 100);
  assert.equal(model.series.filter(series => series.key.startsWith('reconstructed')).length, 1);
  assert.ok(model.notes.some(note => note.includes('investment history is never inferred')));
});

test('an unavailable combination does not hide other histories or method projections', () => {
  const data = combinations();
  const unavailable = data.scopes.find(scope => scope.id === 'cash-investments');
  unavailable.history = [{ date: asOf, value: null }];
  unavailable.projections.forEach(path => { path.reason = 'Investment values need the starting date.'; path.points = []; });
  const model = build({ combinations: data, settings: { scopes: ['cash', 'cash-investments'], methods: ['scenario', 'recent'] } });
  assert.equal(model.projectedCount, 2);
  assert.equal(model.series.filter(series => series.key.startsWith('projected_cash_investments')).length, 0);
  assert.ok(model.series.some(series => series.key === 'projected_cash_scenario'));
  assert.ok(model.notes.some(note => note.includes('Cash + investments: no complete')));
  assert.ok(model.notes.some(note => note.includes('Investment values need')));
  assert.equal(new Set(model.notes).size, model.notes.length);
});

test('manual and estimated starts are visible in series names and notes', () => {
  const data = combinations();
  data.scopes.find(scope => scope.id === 'cash').projections.forEach(path => { path.startKind = 'manual'; path.matchesHistory = false; });
  data.scopes.find(scope => scope.id === 'investments').projections.forEach(path => { path.startKind = 'estimated'; path.matchesHistory = false; });
  const model = build({ combinations: data, settings: { scopes: ['cash', 'investments'], methods: ['scenario'] } });
  assert.match(model.series.find(series => series.key === 'projected_cash_scenario').name, /manual starting totals/);
  assert.match(model.series.find(series => series.key === 'projected_investments_scenario').name, /latest-value starting estimate/);
  assert.ok(model.notes.some(note => note.includes('different dates')));
  assert.ok(model.notes.some(note => note.includes('entered cash or reserve')));
});

test('optional starting guides use scope opening totals and enter the chart range', () => {
  const model = build({ settings: { scopes: ['cash', 'cash-reserve'], methods: ['scenario'], startingGuides: true }, buffer: 50 });
  assert.equal(model.references.find(reference => reference.name === 'Zero').value, 0);
  assert.equal(model.references.find(reference => reference.name === 'Minimum cash buffer').value, 50);
  assert.equal(model.references.find(reference => reference.scopeId === 'cash-reserve').value, 1100);
  assert.ok(model.references.every(reference => reference.includeInRange));
  assert.equal(model.references.filter(reference => reference.scopeId).length, 2);
  assert.equal(build().references.length, 1);
});

test('cash funding guides are informational negative thresholds without changing projected money', () => {
  const settings = { scopes: ['cash'], methods: ['scenario'], fundingLimits: true };
  const model = build({ settings, openingReserve: 1000, openingInvestments: 2000 });
  assert.deepEqual(model.references.map(reference => reference.value), [0, -1000, -2000, -3000]);
  assert.ok(model.references.find(reference => reference.value === -3000).name.includes('starting savings + investments'));
  assert.equal(model.points.at(-1).projected_cash_scenario, -100);
  assert.ok(model.notes.some(note => note.includes('do not transfer savings')));
  const noCash = build({ settings: { ...settings, scopes: ['investments'] }, openingReserve: 1000, openingInvestments: 2000 });
  assert.equal(noCash.references.length, 1);
});

test('coincident funding limits do not duplicate drawn threshold lines', () => {
  const settings = { scopes: ['cash'], methods: ['scenario'], fundingLimits: true };
  const equal = build({ settings, openingReserve: 1000, openingInvestments: 1000 });
  assert.deepEqual(equal.references.map(reference => reference.value), [0, -1000, -2000]);
  assert.match(equal.references.find(reference => reference.value === -1000).name, /savings \/ starting investments/);
  const empty = build({ settings, openingReserve: 0, openingInvestments: 0 });
  assert.deepEqual(empty.references.map(reference => reference.value), [0]);
});

test('unsafe funding totals are omitted while independently safe guides and projections remain', () => {
  const settings = { scopes: ['cash'], methods: ['scenario'], fundingLimits: true };
  const model = build({ settings, openingReserve: Number.MAX_SAFE_INTEGER, openingInvestments: 1000 });
  assert.deepEqual(model.references.map(reference => reference.value), [0, -Number.MAX_SAFE_INTEGER, -1000]);
  assert.ok(model.notes.some(note => note.includes('combined funding limit exceeds')));
  assert.equal(model.projectedCount, 1);
  const missing = build({ settings, openingReserve: null, openingInvestments: 1000 });
  assert.deepEqual(missing.references.map(reference => reference.value), [0, -1000]);
});

test('data-point symbols toggle independently from the forecast-start date guide', () => {
  const model = build({ settings: { scopes: ['cash'], methods: ['scenario'], points: false } });
  assert.ok(model.series.every(series => series.showPoints === false));
  assert.deepEqual(model.markers, [{ index: 1, name: 'Forecast starts' }]);
  assert.equal(model.points[model.markers[0].index].date, asOf);
  assert.equal(model.points[model.markers[0].index].starting, true);
});

test('selection uses constant keys and ignores unsupported scope or method identifiers', () => {
  const model = build({ settings: { scopes: ['cash', '<script>'], methods: ['scenario', 'constructor', 'unknown'] } });
  assert.equal(model.projectedCount, 1);
  assert.ok(model.series.every(series => /^[a-z_]+$/.test(series.key)));
  assert.equal(model.series.length, 2);
  assert.throws(() => build({ asOf: '2026-02-30' }), RangeError);
});
