import { createAccountController } from './accounts.js';
import { createExplorer } from './explorer.js';
import { parseRoute, routeHash, parentView } from './routes.js';
import { applyOverrides, summarize, baseline, project, shiftMonth } from '../lib/engine.js';
import { periodStatistics, comparePeriods, ratio, activitySeries, automaticGrouping } from '../lib/statistics.js';
import { renderStatistics, renderMetricCards, percentage, changeText } from './statistics.js';
import { renderTimeSeriesChart } from './charts.js';
import { initializeChartTooltips } from './chart-tooltips.js';

initializeChartTooltips();

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 });
const money = cents => number.format(cents / 100) + ' kr';
const exactNumber = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const exactMoney = cents => exactNumber.format(cents / 100) + ' kr';
const dateText = date => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const monthText = (month, long = false) => new Intl.DateTimeFormat('en-GB', { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(month + '-01T12:00:00Z'));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const palette = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);
const storageKey = 'saga-fe-local-v1';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem('tally-local-v1') || '{}'); } catch { /* A fresh session works without storage. */ }
const state = { data: null, transactions: [], view: 'overview', page: 0, horizon: saved.horizon || 3, lookback: saved.lookback || 3, overrides: saved.overrides || {}, assumptions: saved.assumptions || {}, editId: null, imported: false, scenario: saved.scenario || 'same', balanceSource: saved.balanceSource || 'manual' };
let toastTimeout;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimeout); toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 4500); }
let loaded = false, saveTimer, pendingSettings, saveChain = Promise.resolve();
const pendingWrites = new Set();
function api(path, options = {}) {
  const operation = (async () => {
    const response = await fetch(path, { ...options, headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    const result = await response.json();
    if (response.status === 401) location.assign('/login');
    if (!response.ok) throw new Error(result.error || 'The ledger could not be updated.');
    return result;
  })();
  if (options.method && !['GET', 'HEAD'].includes(options.method)) {
    pendingWrites.add(operation);
    operation.then(() => pendingWrites.delete(operation), () => pendingWrites.delete(operation));
  }
  return operation;
}
function currentSettings() {
  return { fields: Object.fromEntries(['cash', 'savings', 'buffer', 'balance-date', 'adjustment', 'one-off'].map(id => [id, $(id).value])), horizon: state.horizon, lookback: state.lookback, assumptions: { ...state.assumptions }, scenario: state.scenario, balanceSource: state.balanceSource };
}
function applySettings(settings) {
  if (!settings) return;
  state.horizon = settings.horizon || 3; state.lookback = settings.lookback || 3; state.assumptions = settings.assumptions || {}; state.scenario = settings.scenario || 'same'; state.balanceSource = settings.balanceSource || 'manual';
  const defaults = { cash: '', savings: '', buffer: '', 'balance-date': today, adjustment: '0', 'one-off': '0' };
  for (const id of Object.keys(defaults)) $(id).value = settings.fields?.[id] ?? defaults[id];
}
function enqueueSettings(settings) {
  saveChain = saveChain.catch(() => {}).then(() => api('/api/settings', { method: 'PUT', body: { settings } })).then(() => { $('save-status').textContent = 'Saved'; });
  saveChain.catch(error => { $('save-status').textContent = 'Not saved'; toast(error.message); });
  return saveChain;
}
async function flushSavedWrites() {
  let saved = true;
  do {
    clearTimeout(saveTimer);
    if (pendingSettings) { const settings = pendingSettings; pendingSettings = null; enqueueSettings(settings); }
    // A finishing correction can schedule another settings save. Drain both
    // queues, including those follow-up writes, before reading the snapshot.
    const results = await Promise.allSettled([saveChain, ...pendingWrites]);
    if (results.some(result => result.status === 'rejected')) saved = false;
  } while (pendingSettings || pendingWrites.size);
  return saved;
}
function persist() {
  const settings = currentSettings();
  try { localStorage.setItem(storageKey, JSON.stringify({ ...settings, overrides: state.overrides })); } catch { /* The database remains authoritative. */ }
  if (!loaded) return;
  clearTimeout(saveTimer);
  pendingSettings = null;
  if (Object.values(state.assumptions).some(value => !Number.isSafeInteger(value)) || ['cash', 'savings', 'buffer', 'balance-date', 'adjustment', 'one-off'].some(id => !$(id).validity.valid)) { $('save-status').textContent = 'Check inputs to save'; return; }
  $('save-status').textContent = 'Saving…';
  pendingSettings = settings;
  saveTimer = setTimeout(() => {
    const next = pendingSettings; pendingSettings = null;
    if (next) enqueueSettings(next);
  }, 500);
}
const explorer = createExplorer({ api, exactMoney, dateText, getTransactions: () => state.transactions, editTransaction, reloadLedger: async () => { if (await loadLocal() === false) throw new Error('The saved detail could not be refreshed.'); }, notify: toast });
const accountController = createAccountController({ api, money, today, onChange: () => loadLocal(), onUse: () => { state.balanceSource = 'accounts'; renderForecast(); persist(); showView('forecast'); }, onError: handleError, toast,
  activityLink: account => { const node = explorer.endpointForAccount(account.id); return node ? `<p class="input-note">${explorer.endpointLink({ ...node, name: 'View payment history →' })}</p>` : ''; }
});
function syncAccountStartingPoint() {
  $('balance-source').value = state.balanceSource;
  for (const id of ['cash', 'savings', 'balance-date']) $(id).readOnly = state.balanceSource === 'accounts';
  if (state.balanceSource !== 'accounts') { $('balance-source-note').textContent = 'Combined starting balances are saved in your private ledger. Account snapshots remain unchanged.'; return true; }
  const starting = accountController.startingPoint();
  $('balance-source-note').textContent = starting.ready ? 'Starting point follows the included account balances. Change them in Accounts.' : starting.reason;
  if (starting.ready) { $('cash').value = (starting.cash / 100).toFixed(2); $('savings').value = (starting.savings / 100).toFixed(2); $('balance-date').value = starting.date; }
  else { $('cash').value = ''; $('savings').value = ''; }
  return starting.ready;
}
let currentRoute = parseRoute(location.hash);
const routePositions = new Map();
history.scrollRestoration = 'manual';
function activateRoute(route, { scroll = true, focus = false, restore = false } = {}) {
  currentRoute = route;
  const view = route.view, parent = parentView(route);
  state.view = view;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== view + '-view'; });
  document.querySelectorAll('.nav').forEach(el => {
    el.classList.toggle('active', el.dataset.view === parent);
    if (el.dataset.view === parent) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  $('topbar-view').textContent = { overview: 'Overview', forecast: 'Look ahead', transactions: 'Transactions', accounts: 'Accounts', data: 'Data & method', transaction: 'Transaction details', account: 'Account details' }[view];
  if (state.data && view === 'forecast') renderForecast();
  if (state.data && view === 'overview') renderOverview();
  if (state.data && view === 'transactions') renderTransactions();
  if (scroll) window.scrollTo({ top: restore ? routePositions.get(routeHash(route)) || 0 : 0, behavior: 'instant' });
  if (loaded) void explorer.openRoute(route, { focus }).then(() => {
    if (restore && ['account', 'transaction'].includes(view) && routeHash(currentRoute) === routeHash(route)) window.scrollTo({ top: routePositions.get(routeHash(route)) || 0, behavior: 'instant' });
  });
  if (focus && !['account', 'transaction'].includes(view)) {
    const heading = $(view + '-view').querySelector('h1');
    heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true });
  }
}
function navigateRoute(route, { scroll = true, focus = true } = {}) {
  routePositions.set(routeHash(currentRoute), window.scrollY);
  const hash = routeHash(route);
  if (location.hash !== hash) history.pushState(null, '', hash);
  activateRoute(route, { scroll, focus, restore: !['account', 'transaction'].includes(route.view) });
}
function showView(view, scroll = true) { navigateRoute(parseRoute('#' + view), { scroll, focus: scroll }); }
function restoreRoute() {
  if (location.hash === '#main-content') return;
  const next = parseRoute(location.hash);
  if (routeHash(next) === routeHash(currentRoute)) return;
  routePositions.set(routeHash(currentRoute), window.scrollY);
  activateRoute(next, { focus: true, restore: true });
}
window.addEventListener('popstate', restoreRoute);
window.addEventListener('hashchange', restoreRoute);
function range() {
  const endMonth = (state.data.metadata.lastDate || today).slice(0, 7);
  const choice = $('period').value;
  if (choice === 'all') return { start: state.data.metadata.firstDate || today, end: state.data.metadata.lastDate || today };
  if (choice === 'current') return { start: endMonth + '-01', end: state.data.metadata.lastDate || today };
  if (choice === 'custom') return { start: $('range-start').value || state.data.metadata.firstDate || today, end: $('range-end').value || state.data.metadata.lastDate || today };
  const end = shiftMonth(endMonth, -1);
  return { start: shiftMonth(end, 1 - Number(choice)) + '-01', end: new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).toISOString().slice(0, 10) };
}
function selectedTransactions() { const r = range(); return state.transactions.filter(t => t.date >= r.start && t.date <= r.end); }
function recalculate() {
  state.transactions = applyOverrides(state.data.transactions, state.overrides);
  state.base = state.transactions.length ? baseline(state.transactions, state.data.metadata.lastDate, state.lookback, state.data.metadata.firstDate) : { start: today.slice(0, 7), end: today.slice(0, 7), months: 0, income: 0, expense: 0, saving: 0 };
  renderOverview(); renderForecast(); renderTransactions(); renderData();
  return loaded ? explorer.openRoute(currentRoute) : Promise.resolve(true);
}
let overviewGroupingRange = null;
function renderOverview() {
  const r = range(); const tx = selectedTransactions(); const s = summarize(tx);
  const stats = periodStatistics(tx, r, state.data.metadata);
  const comparison = comparePeriods(state.transactions, r, $('period').value, state.data.metadata);
  const groupingRange = `${$('period').value}:${r.start}:${r.end}`;
  if (overviewGroupingRange !== groupingRange) {
    $('overview-grouping').value = automaticGrouping(r);
    overviewGroupingRange = groupingRange;
  }
  const history = activitySeries(tx, r, state.data.metadata, $('overview-grouping').value);
  const grouping = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[history.interval];
  const trendPoints = history.points;
  $('cashflow-grouping').textContent = grouping;
  $('spending-grouping').textContent = grouping;
  $('custom-range').hidden = $('period').value !== 'custom';
  $('period-caption').textContent = r.start > r.end ? 'Choose an end date on or after the start date.' : `${dateText(r.start)} – ${dateText(r.end)} · ${number.format(tx.length)} transactions · Period totals`;
  const metrics = [
    ['Money in', s.income, 'Salary and other incoming money', '', 'income'],
    ['Spending', s.expense, 'Bills, purchases & other outflows', '', 'expense'],
    ['External savings', s.saving, 'Money moved outside this export', '', 'saving'],
    ['Cash change', s.net, 'Money in − spending − external savings', s.net < 0 ? 'negative' : 'positive', 'net']
  ];
  renderMetricCards($('metrics'), metrics.map(([label, amount, note, color, key]) => ({ label, value: money(amount), note, color, icon: { income: 'income', expense: 'expense', saving: 'saving', net: 'trend' }[key], tone: key, values: trendPoints.map(point => point[key]), trendPoints, trendLabel: trendPoints.length > 1 ? `${grouping} totals · ${dateText(trendPoints[0].date)} – ${dateText(trendPoints.at(-1).end)}` : '', change: comparison ? { text: changeText(amount, comparison.totals[key], money), note: `from ${money(comparison.totals[key])}`, color: key === 'saving' || amount === comparison.totals[key] ? '' : (key === 'expense' ? amount < comparison.totals[key] : amount > comparison.totals[key]) ? 'positive' : 'negative' } : null })));
  $('comparison-caption').textContent = comparison ? `Compared with ${dateText(comparison.start)} – ${dateText(comparison.end)}. Arrows show the direction of change.` : $('period').value === 'all' ? 'All recorded history · no previous period comparison.' : 'Previous-period comparisons appear when the ledger covers both full date ranges.';
  const largest = stats.largestPayment;
  renderStatistics($('period-insights'), [
    { label: 'Average daily spending', value: stats.dailySpending === null ? '—' : money(stats.dailySpending), note: stats.days ? `Across ${number.format(stats.days)} recorded calendar days` : 'No recorded date coverage' },
    { label: 'Typical spending payment', value: stats.medianPayment === null ? '—' : exactMoney(stats.medianPayment), note: `Median of ${number.format(stats.spendingPayments)} spending payments` },
    { label: 'Largest spending payment', value: largest ? money(-largest.amount) : '—', note: largest ? `${largest.description} · ${dateText(largest.date)}` : 'No spending payments', href: largest ? routeHash({ view: 'transaction', id: largest.id }) : undefined },
    { label: 'External savings rate', value: percentage(stats.savingsRate), note: s.income > 0 ? 'External savings ÷ all money in' : 'Needs incoming money in this period' },
  ].map((item, i) => ({ ...item, icon: ['calendar', 'payment', 'expense', 'percent'][i], tone: ['expense', 'neutral', 'expense', 'saving'][i] })));
  $('period-insights-note').textContent = stats.days ? `Daily average uses ${dateText(stats.start)} – ${dateText(stats.end)}, including days without recorded spending. Savings and internal transfers stay out of spending statistics.` : 'Choose dates within your recorded history to see daily averages.';
  const labels = point => history.interval === 'month' ? monthText(point.date.slice(0, 7)) : dateText(point.date).replace(/ \d{4}$/, '');
  const historyNote = `${{ day: 'Daily', week: '7-day', month: 'Monthly' }[history.interval]} totals within recorded coverage. The first and last periods can be partial.`;
  renderTimeSeriesChart($('spending-trend-chart'), { points: tx.length ? history.points : [], series: [{ key: 'expense', name: 'Spending', color: 'var(--chart-out)' }], title: 'Spending over time in NOK', format: exactMoney, label: labels, width: $('spending-trend-chart').clientWidth });
  $('spending-trend-note').textContent = `${historyNote} Savings and internal transfers are excluded.`;
  let running = 0;
  const cumulative = history.points.map(point => ({ ...point, cashChange: running += point.net }));
  // Include the zero starting point so the first movement is visible.
  const cashPoints = cumulative.length ? [{ date: cumulative[0].date, cashChange: 0, starting: true }, ...cumulative.map(point => ({ ...point, date: point.end }))] : [];
  renderTimeSeriesChart($('cash-change-chart'), { points: tx.length ? cashPoints : [], series: [{ key: 'cashChange', name: 'Cumulative cash change', color: 'var(--chart-4)' }], title: 'Cumulative cash change in NOK', tooltipRows: point => Number.isFinite(point.net) ? [{ name: 'Cash change in this period', value: exactMoney(point.net) }] : [], format: exactMoney, label: point => point.starting ? 'Start' : dateText(point.date).replace(/ \d{4}$/, ''), width: $('cash-change-chart').clientWidth });
  renderCashflowChart(tx.length ? history.points : [], grouping, labels);
  const b = state.base; const net = b.income - b.expense - b.saving;
  $('outlook-title').textContent = b.months ? net < 0 ? 'Your current pace uses more cash.' : 'Your current pace leaves some room.' : 'A little more history is needed.';
  $('outlook-copy').textContent = b.months ? `${money(Math.abs(net))} ${net < 0 ? 'less' : 'more'} available cash per month, if recent regular income and outflows continue.` : 'There are no complete months to estimate a baseline. Enter your monthly assumptions in Look ahead.';
  $('outlook-basis').textContent = b.months ? `Based on ${monthText(b.start)}–${monthText(b.end)}. Enter your cash balance to see what that means for you.` : 'Current account balances are not included in the export.';
  const categories = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
  $('categories').innerHTML = categories.length ? categories.slice(0, 8).map(([name, amount], i) => `<button class="category-row" data-category="${esc(name)}"><div class="category-top"><span class="category-name"><i class="category-dot" style="background:${palette[i]}"></i>${esc(name)}</span><span class="category-amount">${money(amount)}<span class="category-share">${number.format(amount / s.expense * 100)}%</span></span></div><div class="bar-track"><div class="bar-fill" style="width:${amount / s.expense * 100}%;background:${palette[i]}"></div></div></button>`).join('') + (categories.length > 8 ? `<p class="input-note">${money(categories.slice(8).reduce((sum, x) => sum + x[1], 0))} in ${categories.length - 8} other categories. Explore all in Transactions.</p>` : '') : '<p class="no-results">No spending in this period.</p>';
  const merchants = Object.entries(s.merchants).sort((a, b) => b[1] - a[1]).slice(0, 6);
  $('merchants').innerHTML = merchants.length ? merchants.map(([name, amount]) => {
    const matches = tx.filter(t => t.description === name && t.amount < 0 && t.kind === 'expense');
    return `<button class="merchant-row" data-merchant="${esc(name)}"><span class="merchant-icon">${esc(name.replace(/^Fra: /, '').slice(0, 1).toUpperCase())}</span><span class="merchant-name">${esc(name)}<small>${matches.length} payment${matches.length !== 1 ? 's' : ''}</small></span><span class="merchant-amount">${money(amount)}</span></button>`;
  }).join('') : '<p class="no-results">No payments in this period.</p>';
  const review = state.transactions.filter(t => t.review).length;
  $('review-title').textContent = `${number.format(review)} transactions could use your context`;
  $('review-banner').hidden = review === 0;
}
function renderCashflowChart(series, grouping, label) {
  renderTimeSeriesChart($('cashflow-chart'), { points: series.map(point => ({ ...point, outgoing: point.expense + point.saving })), series: [{ key: 'income', name: 'Money in', color: 'var(--chart-in)' }, { key: 'outgoing', name: 'Money out', color: 'var(--chart-out)' }], title: `${grouping} incoming and outgoing cash in NOK`, format: exactMoney, label, width: $('cashflow-chart').clientWidth, type: 'bar' });
}
function fieldCents(id, allowBlank = false) {
  const input = $(id); const value = input.value.trim();
  if (value === '') return allowBlank ? null : 0;
  if (!input.validity.valid || !Number.isFinite(Number(value))) return NaN;
  return Math.round(Number(value) * 100);
}
function activeAssumptions() {
  return Object.fromEntries(['income', 'expense', 'saving'].map(key => [key, state.assumptions[key] ?? state.base[key]]));
}
function renderForecast() {
  const accountBalancesReady = syncAccountStartingPoint();
  const b = state.base, a = activeAssumptions();
  if (state.scenario === 'less' || state.scenario === 'more') $('adjustment').value = ((state.scenario === 'less' ? -1 : 1) * a.expense / 1000).toFixed(2);
  for (const key of ['income', 'expense', 'saving']) if (document.activeElement !== $(key)) $(key).value = (a[key] / 100).toFixed(2);
  $('lookback').value = String(state.lookback);
  $('baseline-caption').textContent = b.months ? `${monthText(b.start)}–${monthText(b.end)} · ${b.months} complete months. ${Object.keys(state.assumptions).length ? 'Custom amounts are active.' : 'Income uses salary rows only.'}` : 'No complete months available. Set all three monthly assumptions yourself.';
  const cash = fieldCents('cash', true), savings = fieldCents('savings'), buffer = fieldCents('buffer'), adjustment = fieldCents('adjustment'), oneOff = fieldCents('one-off');
  const balanceDate = $('balance-date').value;
  document.querySelectorAll('[data-horizon]').forEach(el => { const active = Number(el.dataset.horizon) === state.horizon; el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active)); });
  document.querySelectorAll('[data-scenario]').forEach(el => { const active = el.dataset.scenario === state.scenario; el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active)); });
  const invalid = !accountBalancesReady || [cash ?? 0, savings, buffer, adjustment, oneOff, ...Object.values(a)].some(n => !Number.isFinite(n)) || !/^\d{4}-\d{2}-\d{2}$/.test(balanceDate) || a.expense + adjustment < 0 || (!b.months && ['income', 'expense', 'saving'].some(key => state.assumptions[key] === undefined));
  const p = !invalid ? project({ cash, savings, buffer, ...a, adjustment, oneOff, horizon: state.horizon, asOf: balanceDate }) : null;
  state.projection = p;
  if (p) renderForecastChart(cash, p, buffer, balanceDate);
  else $('forecast-chart').innerHTML = `<div class="empty-state"><div class="empty-state-icon" aria-hidden="true">↗</div><h3>${invalid ? 'Check your assumptions.' : 'Start with what you have.'}</h3><p>${invalid ? 'Enter valid balances, a balance date, and nonnegative monthly amounts. A spending change cannot reduce total spending below zero. With no complete history, set all three monthly assumptions.' : 'Enter your available cash on the left. Then explore how your recent income and spending could shape the next few months.'}</p></div>`;
  const net = a.income - a.expense - a.saving - adjustment;
  renderStatistics($('forecast-stats'), [
    ['Monthly cash change', Number.isFinite(net) ? money(net) : '—', net < 0 ? 'negative' : 'positive'],
    [`Cash after ${state.horizon} month${state.horizon === 1 ? '' : 's'}`, p ? money(p.endBalance) : '—', p?.endBalance < 0 ? 'negative' : ''],
    ['Peak reserve needed', p ? money(p.reserveNeeded) : '—', p?.reserveNeeded > 0 ? 'negative' : '']
  ].map(([label, value, color], i) => ({ label, value, color, icon: ['trend', 'balance', 'saving'][i], tone: ['net', 'income', 'saving'][i], note: ['Regular monthly income minus planned outflows', 'Before any reserve withdrawals', 'At the lowest monthly checkpoint'][i], ...(p && i === 1 ? { values: [cash, ...p.points.map(point => point.balance)], trendPoints: [{ date: balanceDate, starting: true }, ...p.points] } : {}) })));
  const lowest = p ? p.points.reduce((low, point) => point.balance < low.balance ? point : low, { date: balanceDate, balance: cash }) : null;
  const impact = p ? -adjustment * state.horizon - oneOff : null;
  renderStatistics($('scenario-insights'), [
    { label: 'Income committed', value: p ? percentage(ratio(a.expense + a.saving + adjustment, a.income)) : '—', note: p && a.income <= 0 ? 'Needs positive regular monthly income' : 'Monthly spending + external savings ÷ regular income; excludes one-off expense' },
    { label: 'Scenario cash impact', value: impact === null ? '—' : money(impact), note: `Versus unchanged spending over ${state.horizon} months; includes the one-off expense`, color: impact === null || impact === 0 ? '' : impact < 0 ? 'negative' : 'positive' },
    { label: 'Lowest cash checkpoint', value: lowest ? money(lowest.balance) : '—', note: lowest ? `${dateText(lowest.date)} · includes starting cash; before reserve withdrawals` : 'Enter valid starting balances and assumptions' },
  ].map((item, i) => ({ ...item, icon: ['percent', 'trend', 'balance'][i], tone: ['expense', 'net', 'income'][i] })));
  $('forecast-message').classList.toggle('warning', !!p && (p.reserveNeeded > 0 || p.monthlyNet < 0));
  if (!p) $('forecast-message').textContent = invalid ? 'Correct the inputs above to calculate a forecast.' : 'Your balances and assumptions are saved in your private ledger. Public source and images contain no financial data.';
  else if (p.reserveNeeded > 0) $('forecast-message').textContent = `At the lowest monthly checkpoint, you would need ${money(p.reserveNeeded)} from your reserve to maintain your ${money(buffer)} buffer. ${p.uncovered > 0 ? `Your entered reserve falls short by ${money(p.uncovered)}.` : `Your reserve could cover it, leaving ${money(Math.max(0, savings - p.reserveNeeded))}.`} ${p.breakEvenCut > 0 ? `Reducing monthly outflows by ${money(p.breakEvenCut)} would stop the ongoing cash decline.` : ''}`;
  else if (p.monthlyNet < 0) $('forecast-message').textContent = `Your cash is decreasing by ${money(-p.monthlyNet)} per month. Your starting cash covers this ${state.horizon}-month scenario, with ${money(p.headroom)} above your chosen buffer at the end. Reducing monthly outflows by ${money(p.breakEvenCut)} would stop the ongoing cash decline.`;
  else $('forecast-message').textContent = `This scenario ends ${money(p.headroom)} above your chosen buffer. Monthly cash ${p.monthlyNet === 0 ? 'stays level' : `grows by ${money(p.monthlyNet)}`}. This is end-of-period headroom; payment timing within the month is not modeled.`;
  $('forecast-table').innerHTML = p ? `<div class="table-scroll"><table><thead><tr><th>Date</th><th class="numeric">Cash change</th><th class="numeric">Available cash*</th><th class="numeric">Reserve needed*</th></tr></thead><tbody>${p.points.map((point, i) => `<tr><td>${dateText(point.date)}</td><td class="numeric ${p.monthlyNet - (i === 0 ? oneOff : 0) < 0 ? 'negative' : 'positive'}">${money(p.monthlyNet - (i === 0 ? oneOff : 0))}</td><td class="numeric ${point.balance < 0 ? 'negative' : ''}">${money(point.balance)}</td><td class="numeric">${money(point.reserveNeeded)}</td></tr>`).join('')}</tbody></table></div><p class="input-note">*Cash before drawing from savings. Reserve needed is cumulative to restore the buffer at each date. Negative cash shows a shortfall. Do not add the reserve-needed rows together.</p>` : '<p class="no-results">Your monthly estimates will appear once your starting balance is entered.</p>';
}
function renderForecastChart(cash, projection, buffer, balanceDate) {
  const a = activeAssumptions();
  const unchanged = project({ cash, ...a, horizon: state.horizon, asOf: balanceDate, buffer });
  const points = [{ date: balanceDate, balance: cash, unchanged: cash }, ...projection.points.map((point, i) => ({ ...point, unchanged: unchanged.points[i].balance }))];
  renderTimeSeriesChart($('forecast-chart'), { points, series: [{ key: 'unchanged', name: 'Unchanged spending · no one-off', color: 'var(--chart-label)', dashed: true }, { key: 'balance', name: 'Your scenario', color: 'var(--chart-4)' }], references: [{ name: 'Cash buffer', value: buffer }], title: 'Forecast cash: your scenario and unchanged spending', tooltipRows: point => [{ name: 'Scenario difference', value: exactMoney(point.balance - point.unchanged) }], format: exactMoney, label: point => dateText(point.date), width: $('forecast-chart').clientWidth });
}
function filteredTransactions() {
  const query = $('search').value.toLocaleLowerCase().trim();
  const category = $('category-filter').value, kind = $('kind-filter').value;
  const tx = $('transaction-period').value === 'all' ? state.transactions : selectedTransactions();
  const result = tx.filter(t => (!query || `${t.description} ${t.category} ${t.subcategory} ${t.account} ${t.fromAccount} ${t.toAccount} ${t.counterparty} ${t.fromEndpoint?.name || ''} ${t.toEndpoint?.name || ''}`.toLocaleLowerCase().includes(query)) && (!category || t.category === category) && (!kind || t.kind === kind) && (!$('review-only').checked || t.review) && (!$('excluded-only').checked || t.excludeForecast));
  const sort = $('transaction-sort').value;
  return result.sort((a, b) => sort === 'outflow' ? a.amount - b.amount : sort === 'inflow' ? b.amount - a.amount : sort === 'oldest' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));
}
function renderTransactions() {
  const categories = [...new Set(state.transactions.map(t => t.category))].sort();
  const previous = $('category-filter').value;
  $('category-filter').innerHTML = '<option value="">All categories</option>' + categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('category-filter').value = categories.includes(previous) ? previous : '';
  const tx = filteredTransactions(); const perPage = 40;
  state.page = Math.max(0, Math.min(state.page, Math.ceil(tx.length / perPage) - 1));
  const shown = tx.slice(state.page * perPage, (state.page + 1) * perPage);
  $('transaction-count').textContent = `${number.format(tx.length)} matches`;
  const totals = summarize(tx);
  const transactionRange = $('transaction-period').value === 'all' ? { start: state.data.metadata.firstDate || today, end: state.data.metadata.lastDate || today } : range();
  const history = activitySeries(tx, transactionRange, state.data.metadata);
  renderStatistics($('transaction-statistics'), [
    { label: 'Money in', value: money(totals.income), note: 'Salary and other incoming money' },
    { label: 'Spending', value: money(totals.expense), note: 'Bills, purchases & other outflows' },
    { label: 'External savings', value: money(totals.saving), note: 'Money moved outside this export' },
    { label: 'Cash change', value: money(totals.net), note: `${number.format(tx.filter(t => t.kind === 'transfer').length)} internal transfer entries excluded`, color: totals.net < 0 ? 'negative' : totals.net > 0 ? 'positive' : '' },
  ].map((item, i) => ({ ...item, icon: ['income', 'expense', 'saving', 'trend'][i], tone: ['income', 'expense', 'saving', 'net'][i], values: history.points.map(point => point[['income', 'expense', 'saving', 'net'][i]]), trendPoints: history.points })));
  renderTimeSeriesChart($('transaction-trend-chart'), { points: tx.length ? history.points : [], series: [{ key: 'income', name: 'Money in', color: 'var(--chart-in)' }, { key: 'expense', name: 'Spending', color: 'var(--chart-out)' }, { key: 'saving', name: 'External savings', color: 'var(--chart-3)' }], title: 'Filtered transaction activity in NOK', format: exactMoney, label: point => history.interval === 'month' ? monthText(point.date.slice(0, 7)) : dateText(point.date).replace(/ \d{4}$/, ''), width: $('transaction-trend-chart').clientWidth, empty: 'No transactions match these filters.' });
  $('transaction-trend-note').textContent = `${{ day: 'Daily', week: '7-day', month: 'Monthly' }[history.interval]} totals for all matching pages. First and last periods may be partial. Internal transfers are excluded.`;
  const kindLabels = { expense: 'Spending', income: 'Money in', saving: 'Savings', transfer: 'Transfer' };
  $('transaction-rows').innerHTML = shown.length ? shown.map(t => { const node = explorer.endpointForAccount(t.accountId); return `<tr><td>${dateText(t.date)}<small>${node ? explorer.endpointLink(node) : esc(t.account || 'Unknown account')}</small></td><td><a class="ledger-link" href="${esc(routeHash({ view: 'transaction', id: t.id }))}">${esc(t.description || 'Untitled transaction')}</a>${t.review ? '<small class="review-tag">● Needs review</small>' : ''}${t.excludeForecast ? '<small>One-off · excluded from forecast</small>' : ''}</td><td>${esc(t.category)}<small>${esc(t.subcategory)}</small></td><td><span class="badge ${t.kind}">${kindLabels[t.kind]}</span></td><td class="numeric ${t.amount > 0 ? 'positive' : ''}">${t.amount > 0 ? '+' : ''}${money(t.amount)}</td><td><button class="edit-button" data-edit="${esc(t.id)}" aria-label="Review ${esc(t.description)}">Edit</button></td></tr>`; }).join('') : '<tr><td colspan="6" class="no-results">No transactions match these filters.</td></tr>';
  $('page-label').textContent = tx.length ? `${state.page * perPage + 1}–${Math.min((state.page + 1) * perPage, tx.length)} of ${number.format(tx.length)}` : '0 transactions';
  $('previous-page').disabled = state.page === 0;
  $('next-page').disabled = (state.page + 1) * perPage >= tx.length;
  $('category-options').innerHTML = categories.map(c => `<option value="${esc(c)}">`).join('');
}
function renderData() {
  const m = state.data.metadata;
  const info = [['Source', 'Private SQLite ledger'], ['Date range', m.firstDate ? `${dateText(m.firstDate)} – ${dateText(m.lastDate)}` : 'No transactions imported'], ['Rows', number.format(m.rows)], ['Internal transfer rows', number.format(state.transactions.filter(t => t.kind === 'transfer').length)], ['Repeated identical rows retained', number.format(m.duplicateRows)], ['Zero-amount rows', number.format(m.zeroRows)], ['Dated account balances', `${(state.data.accountDetails || []).filter(a => a.balance !== null).length} set`], ['Ingest sources', number.format(m.sources || 0)], ['Import batches', number.format(m.batches || 0)], ['Saved transaction edits', number.format(Object.keys(state.overrides).length)]];
  $('data-details').innerHTML = `<div class="data-list">${info.map(([key, value]) => `<div class="data-item"><span>${key}</span><strong>${esc(value)}</strong></div>`).join('')}</div>`;
  $('account-details').innerHTML = (state.data.accountDetails || []).map(account => { const node = explorer.endpointForAccount(account.id); return `<div class="account-item"><span class="account-symbol" aria-hidden="true">⊞</span>${node ? explorer.endpointLink(node) : esc(account.name)}</div>`; }).join('');
  $('data-status').textContent = m.lastDate ? `${number.format(m.rows)} rows · Through ${dateText(m.lastDate)}` : 'No data yet · Import a CSV or JSON file';
  $('footer-date').textContent = m.lastDate ? `Through ${dateText(m.lastDate)}` : 'Awaiting first import';
}
function editTransaction(id) {
  const tx = state.transactions.find(t => t.id === id); if (!tx) return;
  state.editId = id;
  $('edit-description').textContent = tx.description;
  $('edit-meta').textContent = `${dateText(tx.date)} · ${money(tx.amount)} · ${tx.account || 'Unknown account'}`;
  $('edit-kind').value = tx.kind; $('edit-category').value = tx.category; $('edit-exclude').checked = !!tx.excludeForecast;
  // Preserve cash direction while still allowing either direction to be an internal transfer.
  for (const option of $('edit-kind').options) option.disabled = tx.amount > 0 ? ['expense', 'saving'].includes(option.value) : tx.amount < 0 ? option.value === 'income' : false;
  $('edit-dialog').showModal();
}
function clearFilters() { $('search').value = ''; $('category-filter').value = ''; $('kind-filter').value = ''; $('review-only').checked = false; $('excluded-only').checked = false; $('transaction-sort').value = 'newest'; state.page = 0; }
let loadGeneration = 0;
async function loadLocal() {
  const generation = ++loadGeneration;
  const decisionReadVersion = explorer.decisionVersion();
  const payload = await api('/api/transactions');
  if (!loaded) {
    if (payload.settings === null && Object.keys(saved).length) {
      const migrated = { ...currentSettings(), ...(saved.fields ? { fields: saved.fields } : {}), ...(saved.balanceSource ? { balanceSource: saved.balanceSource } : {}) };
      try { await api('/api/settings', { method: 'PUT', body: { settings: migrated } }); payload.settings = migrated; } catch { /* Invalid legacy inputs stay local until corrected. */ }
      if (Object.keys(saved.overrides || {}).length) {
        const result = await api('/api/overrides', { method: 'PUT', body: { overrides: { ...saved.overrides, ...payload.overrides } } }); payload.overrides = result.overrides;
      }
    }
  }
  let directory;
  try { directory = (await api('/api/endpoints')).endpoints; } catch { /* Keep the main ledger usable if its directory fails. */ }
  let decisions;
  try { decisions = (await api('/api/relations')).decisions; } catch { /* Connection review remains disabled until saved decisions are available. */ }
  if (generation !== loadGeneration) return;
  if (!loaded) applySettings(payload.settings);
  state.data = payload; state.overrides = payload.overrides || {}; state.imported = false;
  if (directory) explorer.setEndpoints(directory); else explorer.directoryError();
  if (decisions) explorer.setDecisions(decisions, decisionReadVersion); else explorer.decisionError(decisionReadVersion);
  accountController.setData(payload.accountDetails || []);
  loaded = true; const detailReady = await initializeData();
  try {
    const history = await api('/api/ingest');
    if (generation !== loadGeneration) return;
    $('ingest-history').innerHTML = history.batches.length ? '<h3>Recent imports</h3>' + history.batches.slice(0, 8).map(batch => `<div class="data-item"><span>${esc(batch.adapter)} · ${esc(batch.importedAt.slice(0, 10))}</span><strong>${batch.inserted} added · ${batch.existing} existing</strong></div>`).join('') : '<p class="input-note">No imports yet.</p>';
  } catch { /* Transaction and account data remains usable. */ }
  return detailReady;
}
function initializeData() {
  $('range-start').value ||= state.data.metadata.firstDate || today; $('range-end').value = state.data.metadata.lastDate || today;
  state.page = 0;
  $('content').hidden = false; $('loading').hidden = true; $('error').hidden = true; return recalculate();
}
function handleError(error) { $('error').textContent = error.message; $('error').hidden = false; $('loading').hidden = true; }

document.addEventListener('click', event => {
  const el = event.target.closest('button, a'); if (!el) return;
  if (el.matches('a.ledger-link, a[data-detail-back]') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigateRoute(parseRoute(el.hash)); return; }
  if (el.classList.contains('skip-link')) { event.preventDefault(); $('main-content').focus(); return; }
  if (el.dataset.view) showView(el.dataset.view);
  if (el.classList.contains('brand')) { event.preventDefault(); showView('overview'); }
  if (el.dataset.category || el.dataset.merchant) {
    clearFilters(); $('transaction-period').value = 'selected';
    if (el.dataset.category) $('category-filter').value = el.dataset.category;
    if (el.dataset.merchant) $('search').value = el.dataset.merchant;
    renderTransactions(); showView('transactions');
  }
  if (el.dataset.edit) editTransaction(el.dataset.edit);
  if (el.dataset.horizon) { state.horizon = Number(el.dataset.horizon); renderForecast(); persist(); }
  if (el.dataset.scenario) {
    state.scenario = el.dataset.scenario;
    const expense = activeAssumptions().expense;
    $('adjustment').value = (state.scenario === 'less' ? -expense * .1 / 100 : state.scenario === 'more' ? expense * .1 / 100 : 0).toFixed(2);
    renderForecast(); persist();
  }
});
$('period').addEventListener('change', () => { state.page = 0; renderOverview(); renderTransactions(); });
$('overview-grouping').addEventListener('change', () => renderOverview());
$('overview-scale').addEventListener('change', () => renderOverview());
$('forecast-scale').addEventListener('change', () => renderForecast());
$('transactions-scale').addEventListener('change', () => renderTransactions());
for (const id of ['range-start', 'range-end']) $(id).addEventListener('change', () => { state.page = 0; renderOverview(); renderTransactions(); });
for (const id of ['search', 'category-filter', 'kind-filter', 'transaction-period', 'transaction-sort', 'review-only', 'excluded-only']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { state.page = 0; renderTransactions(); });
$('clear-filters').addEventListener('click', () => { clearFilters(); renderTransactions(); });
$('previous-page').addEventListener('click', () => { state.page--; renderTransactions(); });
$('next-page').addEventListener('click', () => { state.page++; renderTransactions(); });
$('review-button').addEventListener('click', () => { clearFilters(); $('review-only').checked = true; $('transaction-period').value = 'all'; renderTransactions(); showView('transactions'); });
$('large-payments').addEventListener('click', () => { clearFilters(); $('transaction-period').value = 'selected'; $('kind-filter').value = 'expense'; $('transaction-sort').value = 'outflow'; $('period').value = String(state.lookback); renderOverview(); renderTransactions(); showView('transactions'); });
for (const id of ['cash', 'savings', 'buffer', 'balance-date', 'adjustment', 'one-off']) $(id).addEventListener('input', () => { if (id === 'adjustment') state.scenario = 'custom'; renderForecast(); persist(); });
for (const id of ['income', 'expense', 'saving']) $(id).addEventListener('input', () => { state.assumptions[id] = fieldCents(id); if (id === 'expense') state.scenario = 'custom'; renderForecast(); persist(); });
$('lookback').addEventListener('change', () => { state.lookback = Number($('lookback').value); state.assumptions = {}; recalculate(); persist(); });
$('reset-baseline').addEventListener('click', () => { state.assumptions = {}; $('adjustment').value = '0'; state.scenario = 'same'; renderForecast(); persist(); toast('Monthly assumptions restored from your history.'); });
$('close-dialog').addEventListener('click', () => $('edit-dialog').close());
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const override = { kind: $('edit-kind').value, category: $('edit-category').value.trim(), excludeForecast: $('edit-exclude').checked };
  if (!override.category) return;
  try { const result = await api('/api/overrides', { method: 'PATCH', body: { id: state.editId, override } }); state.overrides = result.overrides; $('edit-dialog').close(); recalculate(); persist(); toast('Transaction updated in your ledger.'); } catch (error) { handleError(error); }
});
$('reset-transaction').addEventListener('click', async () => {
  try { const result = await api('/api/overrides', { method: 'PATCH', body: { id: state.editId, override: null } }); state.overrides = result.overrides; $('edit-dialog').close(); recalculate(); persist(); toast('Original source classification restored.'); } catch (error) { handleError(error); }
});
$('import-button').addEventListener('click', () => $('csv-input').click());
$('data-import-button').addEventListener('click', () => $('csv-input').click());
async function downloadLedger(format) {
  const buttons = [$('export-ledger-json'), $('export-ledger-sqlite')];
  buttons.forEach(button => { button.disabled = true; });
  const status = $('ledger-export-status'); status.textContent = 'Finishing saves and preparing your export…';
  try {
    const savesFinished = await flushSavedWrites();
    const response = await fetch(`/api/export?format=${format}`);
    if (response.status === 401) location.assign('/login');
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'The ledger could not be exported.'); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url;
    link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || `saga-fe-ledger-${today}.${format}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = savesFinished ? 'Download ready. Keep your ledger export private.' : 'Download ready. Some changes could not be saved; this file contains the saved ledger.';
  } catch (error) { status.textContent = 'Export failed. Your ledger is unchanged.'; toast(error.message); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
$('export-ledger-json').addEventListener('click', () => downloadLedger('json'));
$('export-ledger-sqlite').addEventListener('click', () => downloadLedger('sqlite'));
$('csv-input').addEventListener('change', async () => {
  const file = $('csv-input').files[0]; if (!file) return;
  $('ingest-status').textContent = 'Importing…';
  try {
    if (file.size > 24 * 1024 * 1024) throw new Error('Choose a file smaller than 24 MiB.');
    const selected = $('ingest-adapter').value;
    const adapter = selected === 'auto' ? (/\.json$/i.test(file.name) ? 'canonical-v1' : 'norwegian-bank-csv') : selected;
    const content = await file.text();
    const data = adapter === 'canonical-v1' ? JSON.parse(content) : null;
    const result = await api('/api/ingest', { method: 'POST', body: { adapter, filename: file.name, ...(adapter === 'canonical-v1' ? { data: data.data || data, ...(data.sourceKey ? { sourceKey: data.sourceKey } : {}) } : { content }) } });
    clearFilters(); await loadLocal();
    $('ingest-status').textContent = `${result.batch.inserted} transactions added; ${result.batch.existing} already in the ledger.`;
    toast('Import saved in the private database.');
  } catch (error) { $('ingest-status').textContent = 'Import failed. Existing data was preserved.'; handleError(error); }
  $('csv-input').value = '';
});
$('reload-button').addEventListener('click', async () => { try { await loadLocal(); toast('Ledger refreshed from the database.'); } catch (error) { handleError(error); } });
$('clear-saved').addEventListener('click', async () => {
  if (!confirm('Reset forecast settings and transaction edits? Transactions and account balances remain in the ledger.')) return;
  try {
    state.overrides = (await api('/api/overrides', { method: 'PUT', body: { overrides: {} } })).overrides;
    state.assumptions = {}; state.lookback = 3; state.horizon = 3; state.scenario = 'same'; state.balanceSource = 'manual';
    for (const id of ['cash', 'savings', 'buffer']) $(id).value = '';
    $('adjustment').value = '0'; $('one-off').value = '0'; $('balance-date').value = today;
    recalculate(); persist(); toast('Forecast settings and transaction edits reset.');
  } catch (error) { handleError(error); }
});
$('balance-source').addEventListener('change', () => { state.balanceSource = $('balance-source').value; renderForecast(); persist(); });
$('export-button').addEventListener('click', () => {
  const csvCell = value => '"' + String(value).replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
  const rows = [['Date', 'Amount NOK', 'Description', 'Category', 'Subcategory', 'Kind', 'Account', 'Excluded from forecast'], ...filteredTransactions().map(t => [t.date, (t.amount / 100).toFixed(2), t.description, t.category, t.subcategory, t.kind, t.account, t.excludeForecast ? 'Yes' : 'No'])];
  const csv = '\uFEFF' + rows.map((row, index) => row.map((value, i) => index > 0 && i === 1 ? value : csvCell(value)).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'saga-fe-transactions.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Filtered transactions exported.');
});

$('balance-date').value = saved.fields?.['balance-date'] || today;
for (const id of ['cash', 'savings', 'buffer', 'adjustment', 'one-off']) if (saved.fields?.[id] !== undefined) $(id).value = saved.fields[id];
if (!location.hash || location.hash !== routeHash(currentRoute)) history.replaceState(null, '', routeHash(currentRoute));
activateRoute(currentRoute, { scroll: false });
try { await loadLocal(); } catch (error) { handleError(error); }
let resizeTimeout;
window.addEventListener('resize', () => { clearTimeout(resizeTimeout); resizeTimeout = setTimeout(() => { if (!state.data) return; if (state.view === 'overview') renderOverview(); if (state.view === 'forecast') renderForecast(); if (state.view === 'transactions') renderTransactions(); if (state.view === 'account') explorer.redrawCharts(); }, 100); });
$('sign-out')?.addEventListener('click', async () => {
  try { await api('/api/session', { method: 'DELETE', body: {} }); location.assign('/login'); }
  catch (error) { toast(error.message); }
});

window.addEventListener('saga:themechange', () => { if (!state.data) return; if (state.view === 'overview') renderOverview(); if (state.view === 'forecast') renderForecast(); });

window.addEventListener('saga:chartscaledefaultchange', () => {
  if (!state.data) return;
  if (state.view === 'overview') renderOverview();
  if (state.view === 'forecast') renderForecast();
  if (state.view === 'transactions') renderTransactions();
  if (state.view === 'account') explorer.redrawCharts();
});
