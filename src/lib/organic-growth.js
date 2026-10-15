// Recorded values and capital movements are separate evidence. No balances,
// import completeness, or return classifications are inferred from silence.
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
const dayLength = 86400000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const day = value => Date.parse(`${value}T12:00:00Z`) / dayLength;
const exact = value => {
  if (value > maximum || value < -maximum) throw new RangeError('Observed growth exceeds the supported integer øre range.');
  return Number(value);
};
const money = value => {
  if (!Number.isSafeInteger(value)) throw new RangeError('Observed account values and movements must be safe integer øre.');
  return value;
};

function observations(account) {
  const values = new Map();
  for (const point of account.valueHistory || account.balanceHistory || []) {
    if (validDate(point.date)) values.set(point.date, point.amount == null ? null : money(point.amount));
  }
  if (validDate(account.balanceDate) && !values.has(account.balanceDate)) values.set(account.balanceDate, account.balance == null ? null : money(account.balance));
  return values;
}

/**
 * Estimate a group's historical return using Modified Dietz and end-of-day
 * external cash flows. `flows` must be canonical deduplicated activity flows.
 * Only dates with known observations for every included account are used.
 *
 * Coverage is an explicit assertion that all capital movements for these
 * accountIds are recorded from `from` through `to`; it is never inferred from
 * the first and last imported payment. Movements between owned accounts are
 * capital. Other external movements need flowKinds[id] = 'capital' or 'return'
 * so interest, dividends, and fees are not silently removed from return.
 *
 * `otherChange` is value change minus all recorded net movement. It remains
 * diagnostic only, even when coverage or classifications are missing.
 */
export function accountGrowthEvidence({ accounts = [], flows = [], coverage = null, flowKinds = {}, asOf, minimumDays = 365 } = {}) {
  if (!Array.isArray(accounts) || !Array.isArray(flows)) throw new TypeError('Observed growth needs account and movement arrays.');
  if (asOf !== undefined && !validDate(asOf)) throw new RangeError('Observed growth needs a valid cutoff date.');
  if (!Number.isSafeInteger(minimumDays) || minimumDays < 30 || minimumDays > 3660) throw new RangeError('Annualizing observed growth needs at least 30 days.');
  if (!flowKinds || typeof flowKinds !== 'object' || Array.isArray(flowKinds) || Object.values(flowKinds).some(value => !['capital', 'return'].includes(value))) throw new RangeError('Classify movements as capital or return.');
  if (accounts.some(account => typeof account.id !== 'string' || !account.id) || new Set(accounts.map(account => account.id)).size !== accounts.length) throw new RangeError('Observed growth needs distinct account IDs.');
  const accountIds = accounts.map(account => account.id), selected = new Set(accountIds);
  const result = { ready: false, code: '', reason: '', accountIds, observations: 0, from: null, to: null, days: 0, startValue: null, endValue: null, recordedNetMovement: null, otherChange: null, capitalNetMovement: null, returnMovement: null, unclassifiedMovements: 0, periodRate: null, annualGrowthBps: null, shortPeriod: false };
  const fail = (code, reason) => ({ ...result, code, reason });
  if (!accounts.length) return fail('accounts', 'No tracked accounts belong to this group.');
  const histories = accounts.map(observations);
  const covered = coverage?.complete === true && validDate(coverage.from) && validDate(coverage.to) && coverage.from <= coverage.to
    && Array.isArray(coverage.accountIds) && accountIds.every(id => coverage.accountIds.includes(id));
  const dates = [...histories[0].keys()].filter(date => (!asOf || date <= asOf) && (!covered || (date >= coverage.from && date <= coverage.to))
    && histories.every(history => history.has(date) && history.get(date) !== null)).sort();
  result.observations = dates.length;
  if (dates.length < 2) return fail('observations', 'Record every included account on at least two common dates before estimating growth.');
  result.from = dates[0]; result.to = dates.at(-1);
  result.days = day(result.to) - day(result.from);
  result.shortPeriod = result.days < 365;
  try {
    result.startValue = exact(histories.reduce((sum, history) => sum + BigInt(history.get(result.from)), 0n));
    result.endValue = exact(histories.reduce((sum, history) => sum + BigInt(history.get(result.to)), 0n));
    if (histories.some(history => history.get(result.from) < 0 || history.get(result.to) < 0)) return fail('values', 'Return estimates need nonnegative recorded asset values.');
    let recorded = 0n, capital = 0n, returned = 0n, weightedCapitalDays = BigInt(result.startValue) * BigInt(result.days);
    const seen = new Set();
    for (const flow of flows) {
      const incoming = selected.has(flow.to?.accountId), outgoing = selected.has(flow.from?.accountId);
      if (incoming === outgoing) continue;
      if (!validDate(flow.date)) return fail('movements', 'Every included movement needs a valid recorded date.');
      if (flow.date <= result.from || flow.date > result.to) continue;
      if (typeof flow.id !== 'string' || !flow.id) return fail('movements', 'Canonical movement IDs are needed to avoid counting a payment twice.');
      if (seen.has(flow.id)) continue;
      seen.add(flow.id);
      const magnitude = money(flow.amount);
      if (magnitude < 0) throw new RangeError('Canonical movement amounts must be nonnegative.');
      const amount = BigInt(magnitude) * (incoming ? 1n : -1n);
      recorded += amount;
      if (!magnitude) continue;
      const explicit = flowKinds[flow.id];
      const kind = explicit || (flow.from?.owned && flow.to?.owned ? 'capital' : null);
      if (kind === 'capital') {
        capital += amount;
        weightedCapitalDays += amount * BigInt(day(result.to) - day(flow.date));
      } else if (kind === 'return') returned += amount;
      else result.unclassifiedMovements++;
    }
    result.recordedNetMovement = exact(recorded);
    result.otherChange = exact(BigInt(result.endValue) - BigInt(result.startValue) - recorded);
    result.capitalNetMovement = exact(capital);
    result.returnMovement = exact(returned);
    if (!covered) return fail('coverage', 'Confirm complete capital-movement coverage for this group and observation period before estimating a return.');
    if (result.unclassifiedMovements) return fail('classification', 'Classify external movements as capital or return, including interest, dividends, and fees.');
    if (weightedCapitalDays <= 0n) return fail('capital', 'The period has no positive time-weighted capital base for a return estimate.');
    const gain = BigInt(result.endValue) - BigInt(result.startValue) - capital;
    const periodRate = Number(gain * BigInt(result.days)) / Number(weightedCapitalDays);
    if (!Number.isFinite(periodRate) || periodRate < -1) return fail('return', 'The observed cash flows and asset values cannot support a compound return estimate.');
    result.periodRate = periodRate;
    if (result.days < minimumDays) return fail('short-period', `Record at least ${minimumDays} days of values before annualizing observed growth.`);
    const annualRate = periodRate === -1 ? -1 : Math.expm1(Math.log1p(periodRate) * 365 / result.days);
    const annualGrowthBps = Math.round(annualRate * 10000) || 0;
    if (!Number.isSafeInteger(annualGrowthBps) || annualGrowthBps < -10000 || annualGrowthBps > 100000) return fail('range', 'The annualized observation is outside the supported growth-assumption range.');
    return { ...result, ready: true, annualGrowthBps };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return fail('amounts', error.message);
  }
}

// A confirmation covers an exact observed period and group. It never extends
// itself to a newly recorded value or an account added to the group.
export function growthReview({ accounts = [], flows = [], options = {}, asOf, minimumDays = 365 } = {}) {
  if (asOf !== undefined && !validDate(asOf)) {
    const empty = accountGrowthEvidence();
    return { evidence: { ...empty, code: 'date', reason: 'Choose a valid forecast starting date before reviewing observed growth.' }, movements: [], unclassified: [], candidateCoverage: null, coverageCurrent: false };
  }
  const flowKinds = options.flowKinds || {};
  const diagnostic = accountGrowthEvidence({ accounts, flows, flowKinds, asOf, minimumDays });
  const candidateCoverage = diagnostic.from && diagnostic.to ? { complete: true, from: diagnostic.from, to: diagnostic.to, accountIds: accounts.map(account => account.id) } : null;
  const confirmed = options.coverage;
  const coverageCurrent = !!(candidateCoverage && confirmed?.complete === true && confirmed.from === candidateCoverage.from && confirmed.to === candidateCoverage.to
    && Array.isArray(confirmed.accountIds) && confirmed.accountIds.length === candidateCoverage.accountIds.length && new Set(confirmed.accountIds).size === confirmed.accountIds.length && candidateCoverage.accountIds.every(id => confirmed.accountIds.includes(id)));
  const evidence = coverageCurrent ? accountGrowthEvidence({ accounts, flows, flowKinds, coverage: confirmed, asOf, minimumDays }) : diagnostic;
  const selected = new Set(accounts.map(account => account.id)), seen = new Set();
  const movements = candidateCoverage ? flows.flatMap(flow => {
    const incoming = selected.has(flow.to?.accountId), outgoing = selected.has(flow.from?.accountId);
    if (incoming === outgoing || (flow.from?.owned && flow.to?.owned) || !validDate(flow.date) || flow.date <= candidateCoverage.from || flow.date > candidateCoverage.to || !flow.amount || typeof flow.id !== 'string' || !flow.id || seen.has(flow.id)) return [];
    seen.add(flow.id);
    return [{ id: flow.id, date: flow.date, amount: money(flow.amount), direction: incoming ? 'incoming' : 'outgoing', label: String(flow.label || flow.description || `Recorded ${incoming ? 'incoming' : 'outgoing'} movement`).slice(0, 2000), kind: flowKinds[flow.id] || null }];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) : [];
  return { evidence, movements, unclassified: movements.filter(flow => !flow.kind), candidateCoverage, coverageCurrent };
}
