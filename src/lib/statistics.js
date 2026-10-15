import { shiftMonth, summarize } from './engine.js';

const day = 86400000;
const timestamp = date => Date.parse(date + 'T12:00:00Z');
const iso = time => new Date(time).toISOString().slice(0, 10);
export const calendarDays = (start, end) => Math.max(0, Math.round((timestamp(end) - timestamp(start)) / day) + 1);
export const ratio = (amount, total) => total > 0 ? amount / total * 100 : null;

// Choose chart density from the selected range, independently of its totals.
export function automaticGrouping(range) {
  const days = calendarDays(range.start, range.end);
  return days <= 45 ? 'day' : days <= 180 ? 'week' : 'month';
}

// Time buckets are clipped to recorded coverage. Empty buckets inside that
// coverage represent no recorded movement, never an inferred account balance.
export function activitySeries(transactions, range, coverage, interval = 'auto') {
  const start = coverage.firstDate && coverage.firstDate > range.start ? coverage.firstDate : range.start;
  const end = coverage.lastDate && coverage.lastDate < range.end ? coverage.lastDate : range.end;
  const days = coverage.firstDate && coverage.lastDate ? calendarDays(start, end) : 0;
  const cadence = interval === 'auto' ? automaticGrouping({ start, end }) : interval;
  const groups = new Map();
  for (const row of transactions) {
    if (row.date < start || row.date > end) continue;
    const date = cadence === 'month' ? row.date.slice(0, 7) + '-01' : cadence === 'week' ? iso(timestamp(start) + Math.floor((timestamp(row.date) - timestamp(start)) / (7 * day)) * 7 * day) : row.date;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(row);
  }
  const points = [];
  if (days) for (let date = cadence === 'month' ? start.slice(0, 7) + '-01' : start; date <= end;) {
    const next = cadence === 'month' ? shiftMonth(date.slice(0, 7), 1) + '-01' : iso(timestamp(date) + (cadence === 'week' ? 7 : 1) * day);
    points.push({ date: date < start ? start : date, end: next > end ? end : iso(timestamp(next) - day), ...summarize(groups.get(date) || []) });
    date = next;
  }
  return { points, interval: cadence };
}

// Whole months compare with whole months. Custom dates compare equal day counts;
// month-to-date compares the same dates in the previous month when they exist.
export function previousPeriod({ start, end }, mode) {
  if (!calendarDays(start, end) || mode === 'all') return null;
  if (/^\d+$/.test(mode)) {
    const months = Number(mode);
    const previousStart = shiftMonth(start.slice(0, 7), -months) + '-01';
    return { start: previousStart, end: iso(timestamp(start) - day) };
  }
  if (mode === 'current') {
    const month = shiftMonth(start.slice(0, 7), -1);
    const last = iso(timestamp(start) - day);
    // Do not compare a longer month-to-date with a shorter previous month.
    if (end.slice(8) > last.slice(8)) return null;
    return { start: month + '-01', end: month + end.slice(7) };
  }
  return { start: iso(timestamp(start) - calendarDays(start, end) * day), end: iso(timestamp(start) - day) };
}

export function periodStatistics(transactions, range, coverage = {}) {
  const start = coverage.firstDate && coverage.firstDate > range.start ? coverage.firstDate : range.start;
  const end = coverage.lastDate && coverage.lastDate < range.end ? coverage.lastDate : range.end;
  const days = coverage.firstDate && coverage.lastDate ? calendarDays(start, end) : 0;
  const rows = transactions.filter(row => row.date >= range.start && row.date <= range.end);
  const totals = summarize(rows);
  const spending = rows.filter(row => row.amount < 0 && !['transfer', 'saving'].includes(row.kind));
  const amounts = spending.map(row => -row.amount).sort((a, b) => a - b);
  const middle = Math.floor(amounts.length / 2);
  const median = amounts.length ? amounts.length % 2 ? amounts[middle] : amounts[middle - 1] + Math.round((amounts[middle] - amounts[middle - 1]) / 2) : null;
  return {
    totals, days, start, end,
    dailySpending: days ? Math.round(totals.expense / days) : null,
    medianPayment: median,
    spendingPayments: spending.length,
    largestPayment: spending.reduce((largest, row) => !largest || row.amount < largest.amount ? row : largest, null),
    savingsRate: ratio(totals.saving, totals.income),
  };
}

export function comparePeriods(transactions, range, mode, coverage) {
  const previous = previousPeriod(range, mode);
  if (!previous || !coverage.firstDate || !coverage.lastDate || range.start < coverage.firstDate || range.end > coverage.lastDate || previous.start < coverage.firstDate || previous.end > coverage.lastDate) return null;
  return { ...previous, totals: summarize(transactions.filter(row => row.date >= previous.start && row.date <= previous.end)) };
}
