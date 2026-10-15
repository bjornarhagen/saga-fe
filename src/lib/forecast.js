import { forecastHistory, project, shiftMonth } from './engine.js';
import { incomeTrend, applyIncomeTrend } from './income-trend.js';

export const forecastMethods = [
  { id: 'unchanged', name: 'Unchanged assumptions', description: 'Your monthly inputs, without a spending change or one-off expense.', color: 'var(--chart-label)', dashed: true },
  { id: 'average', name: 'Historical average', description: 'Repeats the mean income, spending and savings in your selected history.', color: 'var(--chart-1)' },
  { id: 'recent', name: 'Last month', description: 'Repeats the most recent complete month (the naïve method).', color: 'var(--chart-2)', dashed: true },
  { id: 'smoothed', name: 'Exponential smoothing', description: 'Gives recent months more weight. Each month gets 30% weight; the previous estimate gets 70%.', color: 'var(--chart-3)' },
  { id: 'seasonal', name: 'Seasonal repeat', description: 'Repeats the last complete 12-month cycle, matched to each future calendar month (seasonal naïve). Uses 12 months regardless of lookback.', color: 'var(--chart-5)', dashed: true },
];
export const defaultForecastMethods = ['unchanged', 'average', 'recent'];
const keys = ['income', 'expense', 'saving'];

// The ledger coverage determines complete months, even when every row in a
// month is excluded. Missing activity within that coverage remains zero.
export function methodForecasts({ transactions, firstDate, historyAsOf, lookback, assumptions, incomeGrowth = false, trend: suppliedTrend, ...inputs }) {
  const history = forecastHistory(transactions, historyAsOf, lookback, firstDate);
  const annual = forecastHistory(transactions, historyAsOf, 12, firstDate);
  const trend = incomeGrowth ? suppliedTrend || incomeTrend({ transactions, firstDate, historyAsOf, asOf: inputs.asOf, horizon: inputs.horizon }) : null;
  return forecastMethods.map(method => {
    const extra = trend ? { trend } : {};
    const unavailable = reason => ({ ...method, ...extra, reason, projection: null });
    const series = method.id === 'seasonal' ? annual.series : history.series;
    const required = method.id === 'seasonal' ? 12 : method.id === 'smoothed' ? 2 : 1;
    const reason = trend && !trend.ready ? trend.reason : method.id !== 'unchanged' && series.length < required ? `Needs ${required} complete month${required === 1 ? '' : 's'}; ${series.length} available.` : '';
    if (reason) return unavailable(reason);
    if (inputs.cash == null) return unavailable('');
    try {
      let amounts = assumptions, monthlyFlows;
      if (method.id === 'average') amounts = Object.fromEntries(keys.map(key => [key, Math.round(series.reduce((sum, point) => sum + point[key], 0) / series.length)]));
      if (method.id === 'recent') amounts = series.at(-1);
      if (method.id === 'smoothed') amounts = Object.fromEntries(keys.map(key => [key, series.slice(1).reduce((level, point) => Math.round((3 * point[key] + 7 * level) / 10), series[0][key])]));
      if (method.id === 'seasonal') monthlyFlows = Array.from({ length: inputs.horizon }, (_, i) => {
        const month = shiftMonth(inputs.asOf.slice(0, 7), i + 1).slice(5);
        return series.find(point => point.month.slice(5) === month);
      });
      if (incomeGrowth) {
        const adjusted = applyIncomeTrend({ flows: monthlyFlows || Array.from({ length: inputs.horizon }, () => amounts), trend, enabled: true });
        if (!adjusted.ready) return unavailable(adjusted.reason);
        monthlyFlows = adjusted.flows;
      }
      // Scenario changes apply equally to all history methods. The unchanged
      // reference deliberately omits them. Never invent negative spending.
      const flows = monthlyFlows || [amounts];
      if (method.id !== 'unchanged' && flows.some(flow => flow.expense + (inputs.adjustment || 0) < 0)) return unavailable('Spending change would make projected spending negative.');
      const projection = project({ ...inputs, ...amounts, monthlyFlows, ...(incomeGrowth ? { plannedExpenses: inputs.plannedExpenses ?? Array.from({ length: inputs.horizon }, () => 0) } : {}), ...(method.id === 'unchanged' ? { adjustment: 0, oneOff: 0 } : {}) });
      return { ...method, ...extra, reason: '', projection };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return unavailable(error.message);
    }
  });
}

// Reconstruct end-of-day cash, not observed balances. Historical one-offs and
// nonrecurring income remain real cash movements, regardless of forecast flags.
export function historicalCash({ transactions, firstDate, lastDate, cash, asOf, months }) {
  if (!months || cash == null || !firstDate || !lastDate || firstDate >= asOf) return [];
  const start = new Date(asOf + 'T12:00:00Z');
  const dates = [];
  let windowStart;
  for (let i = months; i >= 1; i--) {
    const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - i, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    const date = target.toISOString().slice(0, 10);
    if (i === months) windowStart = date;
    if (date >= firstDate && date <= lastDate) dates.push(date);
  }
  // Show the available partial history when it starts inside the chosen window.
  if (firstDate >= windowStart && firstDate < (dates[0] || asOf) && firstDate <= lastDate) dates.unshift(firstDate);
  return dates.map(date => ({ date, historical: true, history: cash - transactions.filter(tx => tx.kind !== 'transfer' && tx.date > date && tx.date <= asOf).reduce((sum, tx) => sum + tx.amount, 0) }));
}
