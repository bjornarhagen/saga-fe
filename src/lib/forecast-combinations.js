// Account groups are disjoint. Combined paths sum positions, never cumulative
// reserve withdrawals or transfers, which would count the same money twice.
export const forecastScopes = [
  { id: 'cash', name: 'Available cash', groups: ['cash'] },
  { id: 'reserve', name: 'Savings reserve', groups: ['reserve'] },
  { id: 'investments', name: 'Investments', groups: ['investments'] },
  { id: 'cash-reserve', name: 'Cash + savings', groups: ['cash', 'reserve'] },
  { id: 'cash-investments', name: 'Cash + investments', groups: ['cash', 'investments'] },
  { id: 'cash-reserve-investments', name: 'Cash + savings + investments', groups: ['cash', 'reserve', 'investments'] },
];
export const defaultForecastScopes = ['cash', 'cash-reserve-investments'];
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const groupFor = account => account.accountType === 'investment' ? 'investments' : account.role === 'available' ? 'cash' : account.role === 'reserve' ? 'reserve' : 'other';

function sum(values) {
  if (!values.every(Number.isSafeInteger)) throw new RangeError('Forecast account values must be safe integer øre.');
  const total = values.reduce((value, amount) => value + BigInt(amount), 0n);
  if (total > maximum || total < -maximum) throw new RangeError('Combined forecast exceeds the supported integer øre range.');
  return Number(total);
}

function observations(account) {
  const values = new Map();
  // valueHistory and balanceHistory describe observations. Movement and
  // unexplained-change fields are deliberately ignored.
  for (const point of account.valueHistory || account.balanceHistory || []) {
    if (!validDate(point.date)) continue;
    values.set(point.date, point.amount == null ? null : sum([point.amount]));
  }
  // A dated current balance is also an observation. Do not replace an explicit
  // unknown history observation with a carried-forward current balance.
  if (validDate(account.balanceDate) && !values.has(account.balanceDate)) values.set(account.balanceDate, account.balance == null ? null : sum([account.balance]));
  return values;
}

function completeTotal(rows, date) {
  if (!rows.length || rows.some(row => !row.observations.has(date) || row.observations.get(date) === null)) return null;
  return sum(rows.map(row => row.observations.get(date)));
}

function projectionReason(scope, rows, projection, asOf, startMode) {
  if (!projection?.start || !Array.isArray(projection.points)) return 'No projection is available for this method.';
  if (projection.start.date !== asOf) return 'The projection starting date does not match the chart.';
  const needed = startMode === 'manual' ? rows.filter(row => row.group === 'investments') : rows;
  if (startMode === 'latest') {
    if (needed.some(row => row.account.balance == null || !validDate(row.account.balanceDate))) return 'Some accounts have no known dated value for the estimated starting point.';
  } else if (needed.some(row => row.observations.get(asOf) == null)) return 'Record all included account values on the starting date, or explicitly use a latest-value estimate.';
  // An absent account group is a known empty set, not permission to invent a
  // starting asset value. Cash/reserve can instead be entered in manual mode.
  for (const group of scope.groups) {
    if (!rows.some(row => row.group === group) && projection.start[group] !== 0 && !(startMode === 'manual' && group !== 'investments')) return 'The projected starting value has no matching tracked accounts.';
    if (startMode === 'manual' && group !== 'investments') continue;
    const groupRows = rows.filter(row => row.group === group);
    const recorded = sum(groupRows.map(row => startMode === 'latest' ? row.account.balance : row.observations.get(asOf)));
    if (recorded !== projection.start[group]) return 'The projected starting value differs from the included account observations.';
  }
  return '';
}

/**
 * Build independently toggleable account combinations without fabricating
 * historical investment performance. Each scope has separate observation,
 * reconstructed-cash and projection segments. Null observations are gaps.
 *
 * `paths` supplies financialProjection results as { id, name, projection }.
 * `startMode` must describe the already-authorized scenario starting values:
 * observed = same-date observations; latest = labelled latest-value estimate;
 * manual = manually entered cash/reserve, with observed investments.
 */
export function forecastCombinations({ accounts = [], asOf, historyStart, reconstructedCash = [], paths = [], scopes = defaultForecastScopes, startMode = 'observed' } = {}) {
  if (!validDate(asOf) || (historyStart !== undefined && !validDate(historyStart))) throw new RangeError('Forecast combinations need valid chart dates.');
  if (!['observed', 'latest', 'manual'].includes(startMode)) throw new RangeError('Choose an observed, latest, or manual forecast starting point.');
  if (!Array.isArray(scopes) || scopes.some(id => !forecastScopes.some(scope => scope.id === id))) throw new RangeError('Choose supported forecast account combinations.');
  const rows = accounts.map(account => ({ account, group: groupFor(account), observations: observations(account) }));
  const selected = new Set(scopes);
  return { scopes: forecastScopes.filter(scope => selected.has(scope.id)).map(scope => {
    const included = rows.filter(row => scope.groups.includes(row.group));
    const dates = [...new Set(included.flatMap(row => [...row.observations.keys()]))].filter(date => date <= asOf && (!historyStart || date >= historyStart)).sort();
    const history = dates.map(date => ({ date, value: completeTotal(included, date), kind: 'observed' }));
    const reconstructedHistory = scope.id === 'cash' ? reconstructedCash.filter(point => validDate(point.date) && point.date < asOf && (!historyStart || point.date >= historyStart)).map(point => ({ date: point.date, value: sum([point.history ?? point.value]), kind: 'reconstructed' })).sort((a, b) => a.date.localeCompare(b.date)) : [];
    const atStart = completeTotal(included, asOf);
    const projections = paths.map(path => {
      let reason = path.reason || path.scopeReasons?.[scope.id] || projectionReason(scope, included, path.projection, asOf, startMode);
      let points = [], startKind = startMode === 'latest' ? 'estimated' : startMode === 'manual' && scope.groups.some(group => group !== 'investments') ? 'manual' : 'observed';
      if (!reason) {
        try {
          let previous = asOf;
          points = [path.projection.start, ...path.projection.points].map((point, index) => {
            if (!validDate(point.date) || (index && point.date <= previous)) throw new RangeError('Combined forecast dates must increase from its starting date.');
            previous = point.date;
            return { date: point.date, value: sum(scope.groups.map(group => point[group])), kind: index ? 'projected' : 'starting' };
          });
        } catch (error) { if (!(error instanceof RangeError)) throw error; reason = error.message; points = []; }
      }
      return { id: path.id, name: path.name, points, reason, startKind, matchesHistory: !!points.length && atStart !== null && points[0].value === atStart };
    });
    const first = projections.find(path => path.points.length);
    const reference = first ? { date: asOf, value: first.points[0].value, kind: first.startKind, label: `${scope.name} at start` } : atStart === null ? null : { date: asOf, value: atStart, kind: 'observed', label: `${scope.name} recorded at start` };
    const knownAtStart = included.filter(row => row.observations.get(asOf) != null).length;
    const currentMissing = included.filter(row => row.account.balance == null).length;
    const currentUndated = included.filter(row => row.account.balance != null && !validDate(row.account.balanceDate)).length;
    const currentDates = [...new Set(included.filter(row => row.account.balance != null && validDate(row.account.balanceDate)).map(row => row.account.balanceDate))].sort();
    const status = !included.length ? 'empty' : atStart === null ? 'partial' : 'complete';
    const reason = status === 'empty' ? 'No tracked accounts belong to these groups.' : status === 'partial' ? 'Some included accounts have no known observation on the starting date. Only complete same-date historical totals are shown.' : '';
    return { ...scope, history, reconstructedHistory, projections, reference, coverage: { accounts: included.length, knownAtStart, missingAtStart: included.length - knownAtStart, observedAtStart: atStart !== null, observedPoints: history.filter(point => point.value !== null).length, currentMissing, currentUndated, currentDates, status, reason } };
  }) };
}
