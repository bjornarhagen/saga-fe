// Scenario values are integer øre. Recorded account observations stay separate.
const max = BigInt(Number.MAX_SAFE_INTEGER);
function exact(value) {
  if (value > max || value < -max) throw new RangeError('Financial forecast exceeds the supported integer øre range.');
  return Number(value);
}
function amount(value, label, nonnegative = false) {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) throw new RangeError(`${label} must be ${nonnegative ? 'nonnegative ' : ''}safe integer øre.`);
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new RangeError('Financial forecast needs a valid date.');
  return value;
}
const add = (...values) => exact(values.reduce((sum, value) => sum + BigInt(value), 0n));

// Reallocate the current saving assumption in the observed destination proportions.
// A positive receiving leg never represents a second contribution.
export function contributionAllocation({ transactions = [], accounts = [], start, end, months = 0, saving = 0 }) {
  amount(saving, 'Saving', true);
  if (!Number.isSafeInteger(months) || months < 0) throw new RangeError('Contribution history months must be a nonnegative integer.');
  const empty = { reserve: 0, investment: 0, unallocated: saving };
  if (!saving || !months || !start || !end || start > end) return empty;
  const byId = new Map(accounts.map(account => [account.id, account]));
  const weights = { reserve: 0n, investment: 0n, unallocated: 0n };
  for (const row of transactions) {
    if (row.kind !== 'saving' || row.excludeForecast || row.amount >= 0) continue;
    const period = start.length === 7 && end.length === 7 ? (row.month || row.date?.slice(0, 7)) : row.date;
    if (!period || period < start || period > end) continue;
    amount(row.amount, 'Historical contribution');
    const endpoint = row.toEndpoint;
    const target = endpoint?.owned && byId.get(endpoint.accountId);
    const group = target?.accountType === 'investment' ? 'investment' : target?.role === 'reserve' ? 'reserve' : 'unallocated';
    weights[group] += -BigInt(row.amount);
  }
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0n);
  if (!total) return empty;
  const allocation = {}, remainders = [];
  let allocated = 0;
  for (const [group, weight] of Object.entries(weights)) {
    const product = BigInt(saving) * weight;
    allocation[group] = exact(product / total);
    allocated += allocation[group];
    remainders.push({ group, remainder: product % total });
  }
  remainders.sort((a, b) => a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < saving - allocated; index++) allocation[remainders[index].group]++;
  return allocation;
}

function contributions(value, count, label) {
  const values = Array.isArray(value) ? value : Array(count).fill(value);
  if (values.length !== count) throw new RangeError(`${label} needs a value for each projected month.`);
  values.forEach(entry => amount(entry, label, true));
  return values;
}

// Reserve use changes where money is held. It does not change total money.
// Growth applies to opening values; contributions arrive afterward.
export function financialProjection({ projection, cash, reserve, investments = 0, other = 0, buffer = 0, asOf, useReserve = true, reserveContribution = 0, investmentContribution = 0, annualGrowthBps = 0, annualReserveGrowthBps = 0 }) {
  if (!projection || !Array.isArray(projection.points) || !projection.points.length || projection.points.length > 60) throw new RangeError('Financial forecast needs 1–60 projected months.');
  amount(cash, 'Cash'); amount(reserve, 'Reserve', true); amount(investments, 'Investments', true); amount(other, 'Other balances'); amount(buffer, 'Buffer', true);
  date(asOf);
  if (typeof useReserve !== 'boolean') throw new RangeError('Reserve use must be a boolean.');
  if (!Number.isSafeInteger(annualGrowthBps) || annualGrowthBps < -10000 || annualGrowthBps > 100000) throw new RangeError('Annual growth must be between −100% and 1,000%, in integer basis points.');
  if (!Number.isSafeInteger(annualReserveGrowthBps) || annualReserveGrowthBps < -10000 || annualReserveGrowthBps > 100000) throw new RangeError('Annual reserve growth must be between −100% and 1,000%, in integer basis points.');
  const reserveFunding = contributions(reserveContribution, projection.points.length, 'Reserve contribution');
  const investmentFunding = contributions(investmentContribution, projection.points.length, 'Investment contribution');
  // expm1/log1p preserves small assumptions better than subtracting two close values.
  const monthlyGrowth = annualGrowthBps === -10000 ? -1 : Math.expm1(Math.log1p(annualGrowthBps / 10000) / 12);
  const monthlyReserveGrowth = annualReserveGrowthBps === -10000 ? -1 : Math.expm1(Math.log1p(annualReserveGrowthBps / 10000) / 12);
  const start = { date: asOf, cash, reserve, investments, other, total: add(cash, reserve, investments, other) };
  const points = [];
  let totalDraw = 0, totalGrowth = 0, totalUnallocated = 0, totalSpendingSurplus = 0, totalIncome = 0, totalExpense = 0, totalSaving = 0, maximumUncovered = 0, firstDrawDate = null;
  let previousDate = asOf;
  for (const [index, flow] of projection.points.entries()) {
    date(flow.date);
    if (flow.date <= previousDate) throw new RangeError('Financial forecast dates must increase from its starting date.');
    previousDate = flow.date;
    amount(flow.income, 'Projected income', true); amount(flow.expense, 'Projected expense'); amount(flow.saving, 'Projected saving', true);
    const allocated = add(reserveFunding[index], investmentFunding[index]);
    if (allocated > flow.saving) throw new RangeError('Allocated contributions cannot exceed projected saving.');
    const spendingSurplus = add(flow.income, -flow.expense);
    const cashChange = add(spendingSurplus, -flow.saving);
    if (flow.cashChange !== undefined && flow.cashChange !== cashChange) throw new RangeError('Projected cash change must equal income minus expense and saving.');
    const investmentGrowth = Math.round(investments * monthlyGrowth) || 0;
    const reserveGrowth = Math.round(reserve * monthlyReserveGrowth) || 0;
    amount(investmentGrowth, 'Projected investment growth');
    amount(reserveGrowth, 'Projected reserve growth');
    const growth = add(investmentGrowth, reserveGrowth);
    const previousTotal = add(cash, reserve, investments, other);
    const unallocated = add(flow.saving, -allocated);
    cash = add(cash, cashChange);
    reserve = add(reserve, reserveGrowth, reserveFunding[index]);
    investments = add(investments, investmentGrowth, investmentFunding[index]);
    const needed = exact(BigInt(buffer) > BigInt(cash) ? BigInt(buffer) - BigInt(cash) : 0n);
    const reserveDraw = useReserve ? Math.min(needed, reserve) : 0;
    cash = add(cash, reserveDraw);
    reserve = add(reserve, -reserveDraw);
    const uncovered = exact(BigInt(buffer) > BigInt(cash) ? BigInt(buffer) - BigInt(cash) : 0n);
    totalDraw = add(totalDraw, reserveDraw);
    totalGrowth = add(totalGrowth, growth);
    totalUnallocated = add(totalUnallocated, unallocated);
    totalSpendingSurplus = add(totalSpendingSurplus, spendingSurplus);
    totalIncome = add(totalIncome, flow.income);
    totalExpense = add(totalExpense, flow.expense);
    totalSaving = add(totalSaving, flow.saving);
    maximumUncovered = Math.max(maximumUncovered, uncovered);
    if (reserveDraw && !firstDrawDate) firstDrawDate = flow.date;
    const total = add(cash, reserve, investments, other);
    if (total !== add(previousTotal, spendingSurplus, -unallocated, growth)) throw new RangeError('Financial forecast does not reconcile.');
    points.push({ date: flow.date, cash, reserve, investments, other, total, income: flow.income, expense: flow.expense, saving: flow.saving, spendingSurplus, reserveDraw, cumulativeDraw: totalDraw, uncovered, growth, reserveGrowth, investmentGrowth, unallocated });
  }
  return { start, end: points.at(-1), points, firstDrawDate, totalDraw, totalGrowth, totalUnallocated, totalSpendingSurplus, totalIncome, totalExpense, totalSaving, endUncovered: points.at(-1).uncovered, maximumUncovered };
}

// Latest recorded values can describe current coverage, but mixed dates are not
// a historical trend or a same-date portfolio observation.
export function accountAssetSummary(accounts = []) {
  const group = rows => {
    const knownRows = rows.filter(account => account.balance !== null && account.balance !== undefined);
    knownRows.forEach(account => { amount(account.balance, 'Recorded account value'); if (account.balanceDate) date(account.balanceDate); });
    const dates = [...new Set(knownRows.map(account => account.balanceDate).filter(Boolean))].sort();
    return { total: add(...knownRows.map(account => account.balance)), known: knownRows.length, missing: rows.length - knownRows.length, count: rows.length, dateStart: dates[0] || null, dateEnd: dates.at(-1) || null, dates, undated: knownRows.filter(account => !account.balanceDate).length };
  };
  const cash = group(accounts.filter(account => account.accountType !== 'investment' && account.role === 'available'));
  const reserve = group(accounts.filter(account => account.accountType !== 'investment' && account.role === 'reserve'));
  const investments = group(accounts.filter(account => account.accountType === 'investment'));
  const other = group(accounts.filter(account => account.accountType !== 'investment' && account.role !== 'available' && account.role !== 'reserve'));
  const overall = group(accounts);
  return { cash, reserve, investments, other, ...overall, sameDate: overall.dates.length === 1 && overall.undated === 0, ready: overall.count > 0 && overall.missing === 0 && overall.undated === 0 && overall.dates.length === 1 };
}
