// Spending pots allocate cash that is already inside the forecast. Funding is
// an internal movement; only purchases reduce total projected cash.
const limit = BigInt(Number.MAX_SAFE_INTEGER);
const money = value => Number.isSafeInteger(value) && value >= 0;
const categoryKey = value => typeof value === 'string' ? value.trim().toLocaleLowerCase('nb-NO') : '';
const categorySet = values => [...new Set(values.map(categoryKey).filter(Boolean))].sort();
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

function checkpointDates(asOf, horizon) {
  const start = new Date(`${asOf}T12:00:00Z`);
  return Array.from({ length: horizon }, (_, i) => {
    const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    return target.toISOString().slice(0, 10);
  });
}

function exact(value) {
  if (value < 0n || value > limit) throw new RangeError('Spending-pot amounts exceed the supported integer øre range.');
  return Number(value);
}

function roundedMean(values) {
  const count = BigInt(values.length);
  return exact((values.reduce((sum, value) => sum + BigInt(value), 0n) + count / 2n) / count);
}

export function spendingPlanForecast({ plans = [], accounts = [], asOf, horizon = 3 } = {}) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 60) throw new RangeError('Forecast horizon must be 1–60 months.');
  if (!Array.isArray(plans) || !Array.isArray(accounts)) throw new TypeError('Spending plans and accounts must be arrays.');
  const expenses = Array(horizon).fill(0);
  const managedCategories = [];
  const details = plans.map(plan => {
    const account = accounts.find(row => row.id === plan.accountId);
    const trackedOnly = plan.monthlySpending === null;
    const detail = { accountId: plan.accountId, category: plan.category, trackedOnly, ready: true, reason: '', balance: account?.balance ?? null, asOf: account?.balanceDate ?? null, points: [], review: null, endBalance: account?.balance ?? null };
    const fail = reason => ({ ...detail, ready: false, reason, points: [] });
    if (!plan.accountId || typeof plan.category !== 'string' || !plan.category.trim()) return fail('Choose an account and a spending category.');
    if (plans.filter(row => row.accountId === plan.accountId).length > 1) return fail('Each spending-pot account can have only one plan.');
    if (plans.filter(row => categoryKey(row.category) === categoryKey(plan.category)).length > 1) return fail('Each managed spending category can have only one pot.');
    if (!trackedOnly && !money(plan.monthlySpending)) return fail('Monthly spending must be a nonnegative integer øre amount or left unset.');
    if (!money(plan.monthlyFunding)) return fail('Monthly funding must be a nonnegative integer øre amount.');
    if (plan.reviewAtBalance !== null && !money(plan.reviewAtBalance)) return fail('The review balance must be a nonnegative integer øre amount or left unset.');
    if (!Array.isArray(plan.topUps) || plan.topUps.some(topUp => !validDate(topUp.date) || !money(topUp.amount) || topUp.amount === 0)) return fail('Each planned top-up needs a valid date and a positive integer øre amount.');
    if (!account) return fail('The spending-pot account is missing.');
    if (account.role !== 'available' || account.accountType === 'investment') return fail('The spending pot must be an available cash account, outside investments.');
    // An unset pace records the pot without claiming to know its spending.
    // Missing observations therefore cannot silently turn into a zero budget.
    if (trackedOnly) {
      if (plan.reviewAtBalance !== null && money(account?.balance)) detail.review = { threshold: plan.reviewAtBalance, balance: account.balance, date: account.balanceDate ?? null, due: account.balance <= plan.reviewAtBalance };
      return detail;
    }
    if (!money(account.balance)) return fail('Record a known, nonnegative spending-pot balance before projecting its spending.');
    if (!validDate(asOf)) return fail('Choose a valid forecast starting date.');
    if (account.balanceDate !== asOf) return fail('The spending-pot balance date must match the forecast starting date.');

    let balance = account.balance;
    let previousDate = asOf;
    let depletionDate = balance === 0 ? asOf : undefined;
    const threshold = plan.reviewAtBalance;
    let reviewPoint = threshold !== null && balance <= threshold ? { date: asOf, balance } : null;
    try {
      for (const date of checkpointDates(asOf, horizon)) {
        const funding = exact(BigInt(plan.monthlyFunding) + plan.topUps.filter(topUp => topUp.date > previousDate && topUp.date <= date).reduce((sum, topUp) => sum + BigInt(topUp.amount), 0n));
        const available = exact(BigInt(balance) + BigInt(funding));
        const spending = Math.min(plan.monthlySpending, available);
        balance = available - spending;
        detail.points.push({ date, funding, spending, balance });
        if (!depletionDate && balance === 0) depletionDate = date;
        if (!reviewPoint && threshold !== null && balance <= threshold) reviewPoint = { date, balance };
        previousDate = date;
      }
      // Check the combined plan before committing its category or expenses.
      const combined = expenses.map((amount, i) => exact(BigInt(amount) + BigInt(detail.points[i].spending)));
      expenses.splice(0, expenses.length, ...combined);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return fail(error.message);
    }
    managedCategories.push(plan.category);
    detail.endBalance = balance;
    if (depletionDate) detail.depletionDate = depletionDate;
    if (threshold !== null) detail.review = { threshold, balance: reviewPoint?.balance ?? balance, date: reviewPoint?.date ?? null, due: !!reviewPoint };
    return detail;
  });
  return { plans: details, managedCategories, expenses, monthlyExpense: roundedMean(expenses), hasPlannedSpending: expenses.some(amount => amount > 0), ready: details.every(detail => detail.trackedOnly || detail.ready) };
}

// Use only for the forecast's history input. Ledger rows and actual summaries
// remain unchanged, including purchases marked as exceptional one-offs.
export function spendingPlanTransactions(transactions, result) {
  const categories = new Set(result.managedCategories.map(categoryKey));
  return transactions.filter(row => row.kind !== 'expense' || !categories.has(categoryKey(row.category)));
}

// A custom ordinary-spending amount may still contain costs now managed by a
// pot. Ask for review again whenever the set of managed categories changes.
export function spendingPlanExpenseNeedsReview(result, customExpense, reviewedCategories = []) {
  if (customExpense === undefined) return false;
  const current = categorySet(result.managedCategories);
  const reviewed = categorySet(reviewedCategories);
  return current.length !== reviewed.length || current.some((category, i) => category !== reviewed[i]);
}
