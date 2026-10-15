// Income amounts stay integer øre. This optional model estimates the change
// in recurring deposits; it does not infer an employer's future pay decisions.
export const incomeTrendDamping = 0.98;
export const incomeTrendWindow = 36;
export const incomeTrendMinimumMonths = 24;

const limit = BigInt(Number.MAX_SAFE_INTEGER);
const monthNumber = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
const monthText = value => `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
  && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;

function roundRatio(numerator, denominator) {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return numerator < 0n ? -rounded : rounded;
}

// Treat income growth as a shared assumption on top of each method's own
// income level. Seasonal peaks, manually chosen amounts and zero-income
// months retain their shape; the learned salary anchor is never substituted.
export function applyIncomeTrend({ flows, trend, enabled = false } = {}) {
  if (!enabled) return { ready: true, reason: '', flows };
  const unavailable = reason => ({ ready: false, reason, flows: null });
  if (!trend?.ready) return unavailable(trend?.reason || 'Income trend is unavailable.');
  if (!Number.isSafeInteger(trend.anchorIncome) || trend.anchorIncome <= 0) return unavailable('Income trend needs a positive safe integer øre anchor.');
  if (!Array.isArray(flows) || !Array.isArray(trend.futureIncome) || trend.futureIncome.length !== flows.length) return unavailable('Income trend needs an estimate for each projected month.');
  const adjusted = [];
  for (let index = 0; index < flows.length; index++) {
    const flow = flows[index], estimate = trend.futureIncome[index];
    if (!Number.isSafeInteger(flow?.income) || flow.income < 0 || !Number.isSafeInteger(estimate) || estimate < 0) return unavailable('Income trend amounts must be nonnegative safe integer øre values.');
    const income = roundRatio(BigInt(flow.income) * BigInt(estimate), BigInt(trend.anchorIncome));
    if (income > limit) return unavailable('Projected income exceeds the supported integer øre range.');
    adjusted.push({ ...flow, income: Number(income) });
  }
  return { ready: true, reason: '', flows: adjusted };
}

function medianRatio(values) {
  const ordered = [...values].sort((a, b) => {
    const difference = a.numerator * b.denominator - b.numerator * a.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2) return ordered[middle];
  const a = ordered[middle - 1], b = ordered[middle];
  return { numerator: a.numerator * b.denominator + b.numerator * a.denominator, denominator: 2n * a.denominator * b.denominator };
}

// Callers provide the same effective, available-cash transaction scope as the
// other forecast methods. Ownership is checked again so reserve withdrawals
// cannot become evidence of salary growth, even if they have an income flag.
export function incomeTrend({ transactions = [], firstDate, historyAsOf, asOf, horizon = 3 } = {}) {
  const result = {
    ready: false, reason: '', futureIncome: [], anchorIncome: null,
    monthlyTrend: null, damping: incomeTrendDamping, matchedPairs: 0,
    completeMonths: 0, incomeMonths: 0, start: null, end: null,
    basis: 'matched-year',
  };
  const unavailable = reason => ({ ...result, reason });
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 60) return unavailable('Income-trend horizon must be 1–60 months.');
  if (!validDate(asOf) || !validDate(historyAsOf || asOf)) return unavailable('Income trend needs valid history and forecast dates.');
  if (!validDate(firstDate)) return unavailable('Income trend needs dated transaction coverage.');
  if (!Array.isArray(transactions)) return unavailable('Income trend needs transaction history.');

  // A past balance date cannot borrow observations from its future. Complete
  // ledger months include zero-income months; a partial first month does not.
  const cutoff = (historyAsOf || asOf) < asOf ? (historyAsOf || asOf) : asOf;
  const end = monthNumber(cutoff) - 1;
  const firstComplete = monthNumber(firstDate) + (firstDate.slice(8) === '01' ? 0 : 1);
  const start = Math.max(firstComplete, end - incomeTrendWindow + 1);
  result.start = monthText(start); result.end = monthText(end);
  result.completeMonths = Math.max(0, end - start + 1);
  if (result.completeMonths < incomeTrendMinimumMonths) return unavailable(`Needs ${incomeTrendMinimumMonths} complete months of income history; ${result.completeMonths} available.`);

  const totals = Array.from({ length: result.completeMonths }, () => 0n);
  for (const row of transactions) {
    if (row.kind !== 'income' || !row.regularIncome || row.excludeForecast || row.ownedMovement
      || (row.fromEndpoint?.owned && row.toEndpoint?.owned)) continue;
    if (!validDate(row.date)) return unavailable('Regular-income history contains an invalid date.');
    const month = monthNumber(row.date);
    if (month < start || month > end) continue;
    if (!Number.isSafeInteger(row.amount) || row.amount < 0) return unavailable('Regular-income amounts must be nonnegative safe integer øre values.');
    totals[month - start] += BigInt(row.amount);
    if (totals[month - start] > limit) return unavailable('Regular-income totals exceed the supported integer øre range.');
  }
  result.incomeMonths = totals.filter(value => value > 0n).length;
  if (result.incomeMonths < 18) return unavailable(`Needs 18 complete months with regular income; ${result.incomeMonths} available.`);
  const recent = totals.slice(-3);
  if (recent.some(value => value <= 0n)) return unavailable('The latest 3 complete months need regular income. Review missing income or use a manual assumption.');

  // Restrict Theil–Sen pairs to the same calendar month in different years.
  // Annual holiday pay and bonuses then cannot create a within-year slope.
  // Zero-income months are coverage, not a usable salary-growth comparison.
  const slopes = [];
  for (let i = 0; i < totals.length; i++) {
    if (totals[i] <= 0n) continue;
    for (let j = i + 12; j < totals.length; j += 12) {
      if (totals[j] > 0n) slopes.push({ numerator: totals[j] - totals[i], denominator: BigInt(j - i) });
    }
  }
  result.matchedPairs = slopes.length;
  if (slopes.length < 6) return unavailable(`Needs 6 matched calendar-month income comparisons; ${slopes.length} available.`);
  const slope = medianRatio(slopes);
  result.monthlyTrend = Number(roundRatio(slope.numerator, slope.denominator));
  result.anchorIncome = Number([...recent].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[1]);

  const gap = monthNumber(asOf) - end;
  // Beyond ten years of missing observations the old salary is not a useful
  // estimate. This also bounds exact rational exponentiation for bad inputs.
  if (gap > 120) return unavailable('Income history is more than 10 years older than the forecast start. Review income before projecting it.');
  const futureIncome = [];
  for (let i = 1; i <= horizon; i++) {
    const step = gap + i;
    // phi + phi² + … + phi^step, with phi = 49/50. Exact integer
    // arithmetic avoids losing a cent while extrapolating fractional slopes.
    const denominator = 50n ** BigInt(step);
    const increment = roundRatio(slope.numerator * 49n * (denominator - 49n ** BigInt(step)), slope.denominator * denominator);
    const value = BigInt(result.anchorIncome) + increment;
    if (value > limit) return unavailable('Projected income exceeds the supported integer øre range.');
    futureIncome.push(Number(value < 0n ? 0n : value));
  }
  return { ...result, ready: true, futureIncome };
}
