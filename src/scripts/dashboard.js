import { createCategorizationController, categoryControls, matchesCategoryStatus } from './categorization.js';
import { isUncategorized } from '../lib/categorization.js';
import { createAccountController } from './accounts.js';
import { createSpendingPlanController } from './spending-plans.js';
import { createFinancialViewsController } from './financial-views.js';
import { createForecastChartControls } from './forecast-chart-controls.js';
import { createExplorer } from './explorer.js';
import { parseRoute, routeHash, parentView } from './routes.js';
import { applyOverrides, summarize, baseline, project, monthlyAverage, shiftMonth, forecastHistory } from '../lib/engine.js';
import { methodForecasts, historicalCash, defaultForecastMethods } from '../lib/forecast.js';
import { incomeTrend, applyIncomeTrend } from '../lib/income-trend.js';
import { normalizeIncomeGrowthSettings } from '../lib/forecast-settings.js';
import { spendingPlanForecast, spendingPlanTransactions, spendingPlanExpenseNeedsReview } from '../lib/spending-plans.js';
import { contributionAllocation, financialProjection, accountAssetSummary } from '../lib/financial-forecast.js';
import { cashForecastTransactions } from '../lib/cash-scope.js';
import { forecastCombinations } from '../lib/forecast-combinations.js';
import { forecastChartModel } from '../lib/forecast-chart-model.js';
import { growthReview } from '../lib/organic-growth.js';
import { periodStatistics, comparePeriods, ratio, activitySeries, automaticGrouping } from '../lib/statistics.js';
import { renderStatistics, renderMetricCards, percentage, changeText } from './statistics.js';
import { renderTimeSeriesChart } from './charts.js';
import { initializeChartTooltips } from './chart-tooltips.js';
import { initializeChartViews } from './chart-views.js';
import { initializeBlockDialog, registerReadOnlyBlock } from './block-dialog.js';
import { registerRanking } from './ranking-dialog.js';

initializeChartTooltips();
initializeBlockDialog();
initializeChartViews();

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
const defaultFinancialView = () => ({ view: 'budget', useReserve: true, assetGroups: ['cash', 'reserve', 'investments', 'other'], growthBps: 0, reserveGrowthBps: 0, assetGrowth: { reserve: { source: 'manual', coverage: null, flowKinds: {} }, investments: { source: 'manual', coverage: null, flowKinds: {} } }, reserveContribution: null, investmentContribution: null });
const defaultForecastChart = () => ({ scopes: ['cash', 'cash-reserve-investments'], methods: ['scenario'], startingGuides: false, fundingLimits: false, points: true });
let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem('tally-local-v1') || '{}'); } catch { /* A fresh session works without storage. */ }
saved = normalizeIncomeGrowthSettings(saved);
const state = { data: null, transactions: [], view: 'overview', page: 0, horizon: saved.horizon || 3, incomeGrowth: saved.incomeGrowth ?? false, methods: saved.methods || [...defaultForecastMethods], historyMonths: saved.historyMonths ?? 3, lookback: saved.lookback || 3, overrides: saved.overrides || {}, assumptions: saved.assumptions || {}, spendingPlans: saved.spendingPlans || [], expensePlanCategories: saved.expensePlanCategories || [], financialView: { ...defaultFinancialView(), ...saved.financialView }, forecastChart: { ...defaultForecastChart(), ...saved.forecastChart }, editId: null, imported: false, scenario: saved.scenario || 'same', balanceSource: saved.balanceSource || 'manual' };
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
  return { fields: Object.fromEntries(['cash', 'savings', 'buffer', 'balance-date', 'adjustment', 'one-off'].map(id => [id, $(id).value])), horizon: state.horizon, incomeGrowth: state.incomeGrowth, methods: [...state.methods], historyMonths: state.historyMonths, lookback: state.lookback, assumptions: { ...state.assumptions }, spendingPlans: structuredClone(state.spendingPlans), expensePlanCategories: [...state.expensePlanCategories], financialView: structuredClone(state.financialView), forecastChart: structuredClone(state.forecastChart), scenario: state.scenario, balanceSource: state.balanceSource };
}
function applySettings(settings) {
  if (!settings) return;
  settings = normalizeIncomeGrowthSettings(settings);
  state.incomeGrowth = settings.incomeGrowth ?? false;
  state.horizon = settings.horizon || 3; state.methods = settings.methods || [...defaultForecastMethods]; state.historyMonths = settings.historyMonths ?? 3; state.lookback = settings.lookback || 3; state.assumptions = settings.assumptions || {}; state.scenario = settings.scenario || 'same'; state.balanceSource = settings.balanceSource || 'manual';
  state.spendingPlans = settings.spendingPlans || [];
  state.expensePlanCategories = settings.expensePlanCategories || [];
  state.financialView = { ...defaultFinancialView(), ...settings.financialView };
  state.forecastChart = { ...defaultForecastChart(), ...settings.forecastChart };
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
const categorization = createCategorizationController({ api, getTransactions: () => state.transactions, reload: async () => { await loadLocal(); persist(); }, notify: toast, onError: handleError, exactMoney, dateText });
const accountController = createAccountController({ api, money, today, onChange: () => loadLocal(), onUse: () => { state.balanceSource = 'accounts'; renderForecast(); persist(); showView('forecast'); }, onError: handleError, toast,
  activityLink: account => { const node = explorer.endpointForAccount(account.id); return node ? `<p class="input-note">${explorer.endpointLink({ ...node, name: 'View payment history →' })}</p>` : ''; }
});
const spendingPlanController = createSpendingPlanController({
  api: async (path, options) => {
    if (!await flushSavedWrites()) throw new Error('Finish saving your forecast inputs before changing spending pots.');
    return api(path, options);
  }, money, today, onError: handleError, toast,
  onChange: async plans => { state.spendingPlans = plans; await loadLocal(); persist(); },
});
const financialViews = createFinancialViewsController({ money, exactMoney, dateText,
  onChange: patch => {
    if (patch.horizon !== undefined) state.horizon = patch.horizon;
    else if (patch.resetAllocation) { state.financialView.reserveContribution = null; state.financialView.investmentContribution = null; }
    else Object.assign(state.financialView, patch);
    renderForecast(); persist();
  },
  onManageAccounts: () => showView('accounts'),
  onEditAssumptions: () => { document.querySelector('.assumptions').scrollIntoView({ block: 'start' }); $('balance-source').focus({ preventScroll: true }); },
});
const forecastChartControls = createForecastChartControls({ onChange: patch => { Object.assign(state.forecastChart, patch); renderForecast(); persist(); } });
function syncAccountStartingPoint() {
  $('balance-source').value = state.balanceSource;
  for (const id of ['cash', 'savings', 'balance-date']) $(id).readOnly = state.balanceSource !== 'manual';
  if (state.balanceSource === 'manual') { $('balance-source-note').textContent = 'Combined starting balances are saved in your private ledger. Account snapshots remain unchanged.'; return true; }
  const starting = accountController.startingPoint({ estimateLatest: state.balanceSource === 'latest' });
  $('balance-source-note').textContent = starting.ready ? state.balanceSource === 'latest' ? `Estimated starting point on ${dateText(starting.date)} using each account’s latest recorded value. Earlier values are carried forward unchanged; intervening payments are not inferred. Original dates remain intact.` : 'Starting point follows matching dated account balances. Change them in Accounts.' : starting.reason;
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
  if (state.data && view === 'accounts') accountController.redrawCharts();
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
  state.base = state.transactions.length ? baseline(cashForecastTransactions(state.transactions, state.data.accountDetails || []), state.data.metadata.lastDate, state.lookback, state.data.metadata.firstDate) : { start: today.slice(0, 7), end: today.slice(0, 7), months: 0, income: 0, expense: 0, saving: 0 };
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
    ['Savings & investments', s.saving, 'Contributions to reserves and investments', '', 'saving'],
    ['Cash change', s.net, 'Money in − spending − savings contributions', s.net < 0 ? 'negative' : 'positive', 'net']
  ];
  renderMetricCards($('metrics'), metrics.map(([label, amount, note, color, key]) => ({ label, value: money(amount), note, color, icon: { income: 'income', expense: 'expense', saving: 'saving', net: 'trend' }[key], tone: key, values: trendPoints.map(point => point[key]), trendPoints, trendLabel: trendPoints.length > 1 ? `${grouping} totals · ${dateText(trendPoints[0].date)} – ${dateText(trendPoints.at(-1).end)}` : '', change: comparison ? { text: changeText(amount, comparison.totals[key], money), note: `from ${money(comparison.totals[key])}`, color: key === 'saving' || amount === comparison.totals[key] ? '' : (key === 'expense' ? amount < comparison.totals[key] : amount > comparison.totals[key]) ? 'positive' : 'negative' } : null })));
  $('comparison-caption').textContent = comparison ? `Compared with ${dateText(comparison.start)} – ${dateText(comparison.end)}. Arrows show the direction of change.` : $('period').value === 'all' ? 'All recorded history · no previous period comparison.' : 'Previous-period comparisons appear when the ledger covers both full date ranges.';
  const largest = stats.largestPayment;
  renderStatistics($('period-insights'), [
    { label: 'Average daily spending', value: stats.dailySpending === null ? '—' : money(stats.dailySpending), note: stats.days ? `Across ${number.format(stats.days)} recorded calendar days` : 'No recorded date coverage' },
    { label: 'Typical spending payment', value: stats.medianPayment === null ? '—' : exactMoney(stats.medianPayment), note: `Median of ${number.format(stats.spendingPayments)} spending payments` },
    { label: 'Largest spending payment', value: largest ? money(-largest.amount) : '—', note: largest ? `${largest.description} · ${dateText(largest.date)}` : 'No spending payments', href: largest ? routeHash({ view: 'transaction', id: largest.id }) : undefined },
    { label: 'Savings contribution rate', value: percentage(stats.savingsRate), note: s.income > 0 ? 'Savings & investments ÷ all money in' : 'Needs incoming money in this period' },
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
  const overviewPlans = forecastPlans();
  const b = state.spendingPlans.length ? forecastBaseline(overviewPlans) : state.base;
  const net = b.income - b.expense - b.saving - overviewPlans.monthlyExpense;
  $('outlook-title').textContent = !overviewPlans.ready ? 'Review your spending plans.' : b.months ? net < 0 ? 'Your current pace uses more cash.' : 'Your current pace leaves some room.' : 'A little more history is needed.';
  $('outlook-copy').textContent = !overviewPlans.ready ? overviewPlans.plans.filter(plan => plan.reason && !plan.trackedOnly).map(plan => plan.reason).join(' ') : b.months ? `${money(Math.abs(net))} ${net < 0 ? 'less' : 'more'} available cash per month, ${overviewPlans.managedCategories.length ? `averaged over ${state.horizon} months with planned pot spending` : 'if recent regular income and outflows continue'}.` : 'There are no complete months to estimate a baseline. Enter your monthly assumptions in Look ahead.';
  $('outlook-basis').textContent = b.months ? `Based on ${monthText(b.start)}–${monthText(b.end)}${overviewPlans.managedCategories.length ? '; spending plans replace their categories in the history estimate' : ''}. Enter your cash balance to see what that means for you.` : 'Current account balances are not included in the export.';
  const categories = Object.entries(s.categories).sort((a, b) => b[1] - a[1]);
  $('categories').innerHTML = categories.length ? categories.slice(0, 8).map(([name, amount], i) => `<button class="category-row" data-category="${esc(name)}"><div class="category-top"><span class="category-name"><i class="category-dot" style="background:${palette[i]}"></i>${esc(name)}</span><span class="category-amount">${money(amount)}<span class="category-share">${number.format(amount / s.expense * 100)}%</span></span></div><div class="bar-track"><div class="bar-fill" style="width:${amount / s.expense * 100}%;background:${palette[i]}"></div></div></button>`).join('') + (categories.length > 8 ? `<p class="input-note">${money(categories.slice(8).reduce((sum, x) => sum + x[1], 0))} in ${categories.length - 8} other categories. Explore all in Transactions.</p>` : '') : '<p class="no-results">No spending in this period.</p>';
  const merchants = Object.entries(s.merchants).sort((a, b) => b[1] - a[1]).slice(0, 6);
  $('merchants').innerHTML = merchants.length ? merchants.map(([name, amount]) => {
    const matches = tx.filter(t => t.description === name && t.amount < 0 && t.kind === 'expense');
    return `<button class="merchant-row" data-merchant="${esc(name)}"><span class="merchant-icon">${esc(name.replace(/^Fra: /, '').slice(0, 1).toUpperCase())}</span><span class="merchant-name">${esc(name)}<small>${matches.length} payment${matches.length !== 1 ? 's' : ''}</small></span><span class="merchant-amount">${money(amount)}</span></button>`;
  }).join('') : '<p class="no-results">No payments in this period.</p>';
  registerRanking($('categories'), 'Spending by category', s.categories, exactMoney);
  registerRanking($('merchants'), 'Top places & payments', s.merchants, exactMoney);
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
function forecastHistoryDate() {
  const latest = state.data.metadata.lastDate || today;
  const balanceDate = $('balance-date').value;
  return balanceDate && balanceDate < latest ? balanceDate : latest;
}
function forecastPlans() {
  return spendingPlanForecast({ plans: state.spendingPlans, accounts: state.data?.accountDetails || [], asOf: $('balance-date').value || state.data?.metadata.lastDate || today, horizon: state.horizon });
}
function forecastBaseline(plans = forecastPlans()) {
  return baseline(spendingPlanTransactions(cashForecastTransactions(state.transactions, state.data.accountDetails || []), plans), forecastHistoryDate(), state.lookback, state.data.metadata.firstDate);
}
function activeAssumptions(base = forecastBaseline()) {
  return Object.fromEntries(['income', 'expense', 'saving'].map(key => [key, state.assumptions[key] ?? base[key]]));
}
function renderForecast() {
  const accountBalancesReady = syncAccountStartingPoint();
  const plans = forecastPlans(), b = forecastBaseline(plans), a = activeAssumptions(b);
  const hasPotSpending = plans.managedCategories.length > 0;
  const expenseNeedsReview = spendingPlanExpenseNeedsReview(plans, state.assumptions.expense, state.expensePlanCategories);
  $('expense-label').textContent = hasPotSpending ? 'Ordinary spending & bills' : 'Spending & bills';
  $('plan-expense-review').hidden = !expenseNeedsReview;
  $('plan-expense-review-copy').textContent = `Your spending plans changed which categories are estimated separately. Review your custom monthly spending amount${hasPotSpending ? `: it must exclude ${plans.managedCategories.join(', ')}` : ': it must now include all ordinary categories'}. Choose history or explicitly confirm the amount before projecting it.`;
  const notes = [];
  if (hasPotSpending) notes.push(`Planned pot spending averages ${money(plans.monthlyExpense)} per month over this ${state.horizon}-month horizon. It replaces historical spending in ${plans.managedCategories.join(', ')} and is included in every projection method. Spending stops when a pot runs out unless planned transfers replenish it. Spending-change scenarios affect ordinary spending; pot schedules stay as entered.`);
  if (state.spendingPlans.some(plan => plan.monthlySpending == null)) notes.push('Pots without a spending pace track their recorded balance only. Their categories still follow history and individual one-off exclusions.');
  if (hasPotSpending && state.assumptions.expense !== undefined) notes.push('Custom spending is active: enter ordinary spending without the categories covered by your pot plans.');
  if (!plans.ready) notes.push(...plans.plans.filter(plan => plan.reason && !plan.trackedOnly).map(plan => plan.reason));
  $('forecast-spending-plans-note').textContent = notes.join(' ');
  $('forecast-spending-plans-note').hidden = !notes.length;
  if (state.scenario === 'less' || state.scenario === 'more') $('adjustment').value = ((state.scenario === 'less' ? -1 : 1) * a.expense / 1000).toFixed(2);
  for (const key of ['income', 'expense', 'saving']) if (document.activeElement !== $(key)) $(key).value = (a[key] / 100).toFixed(2);
  $('lookback').value = String(state.lookback);
  $('baseline-caption').textContent = b.months ? `${monthText(b.start)}–${monthText(b.end)} · ${b.months} complete months. ${Object.keys(state.assumptions).length ? 'Custom amounts are active.' : 'Income uses salary rows only.'}` : 'No complete months available. Set all three monthly assumptions yourself.';
  const cash = fieldCents('cash', true), savings = fieldCents('savings'), buffer = fieldCents('buffer'), adjustment = fieldCents('adjustment'), oneOff = fieldCents('one-off');
  const balanceDate = $('balance-date').value;
  $('forecast-horizon').value = String(state.horizon);
  $('forecast-history').value = String(state.historyMonths);
  document.querySelectorAll('[data-scenario]').forEach(el => { const active = el.dataset.scenario === state.scenario; el.classList.toggle('selected', active); el.setAttribute('aria-pressed', String(active)); });
  const invalidAmounts = [cash ?? 0, savings, buffer, adjustment, oneOff, ...Object.values(a)].some(n => !Number.isSafeInteger(n));
  const cashTransactions = cashForecastTransactions(state.transactions, state.data.accountDetails || []);
  const trend = incomeTrend({ transactions: cashTransactions, firstDate: state.data.metadata.firstDate, historyAsOf: forecastHistoryDate(), asOf: balanceDate, horizon: state.horizon });
  const baseFlows = Array.from({ length: state.horizon }, () => ({ ...a }));
  const grownIncome = applyIncomeTrend({ flows: baseFlows, trend, enabled: state.incomeGrowth });
  const incomeGrowthError = grownIncome.ready ? '' : grownIncome.reason;
  const meanIncome = grownIncome.ready && grownIncome.flows.every(flow => Number.isSafeInteger(flow.income)) ? monthlyAverage(grownIncome.flows.reduce((sum, flow) => sum + BigInt(flow.income), 0n), state.horizon) : null;
  let monthlyCashChange = null;
  if (grownIncome.ready && plans.ready && !invalidAmounts) {
    try { monthlyCashChange = monthlyAverage(grownIncome.flows.reduce((sum, flow, index) => sum + BigInt(flow.income) - BigInt(flow.expense) - BigInt(flow.saving) - BigInt(adjustment) - BigInt(hasPotSpending ? plans.expenses[index] : 0), 0n), state.horizon); }
    catch (error) { if (!(error instanceof RangeError)) throw error; }
  }
  const incomeRange = state.incomeGrowth && grownIncome.ready ? { first: grownIncome.flows[0].income, last: grownIncome.flows.at(-1).income } : null;
  const invalid = !accountBalancesReady || !plans.ready || expenseNeedsReview || invalidAmounts || !!incomeGrowthError || !/^\d{4}-\d{2}-\d{2}$/.test(balanceDate) || a.expense + adjustment < 0 || (!b.months && ['income', 'expense', 'saving'].some(key => state.assumptions[key] === undefined));
  let p = null, projectionError = incomeGrowthError;
  if (!invalid) {
    try { p = project({ cash, savings, buffer, ...a, adjustment, oneOff, horizon: state.horizon, asOf: balanceDate, monthlyFlows: state.incomeGrowth ? grownIncome.flows : undefined, plannedExpenses: hasPotSpending ? plans.expenses : state.incomeGrowth ? Array(state.horizon).fill(0) : undefined }); }
    catch (error) { if (!(error instanceof RangeError)) throw error; projectionError = error.message; }
  }
  state.projection = p;
  const methods = methodForecasts({ transactions: spendingPlanTransactions(cashTransactions, plans), incomeGrowth: state.incomeGrowth, trend, plannedExpenses: hasPotSpending ? plans.expenses : undefined, firstDate: state.data.metadata.firstDate, historyAsOf: forecastHistoryDate(), lookback: state.lookback, assumptions: a, cash: p ? cash : null, savings, buffer, adjustment, oneOff, horizon: state.horizon, asOf: balanceDate });
  $('income-growth').checked = state.incomeGrowth;
  $('income-growth').disabled = !trend.ready && !state.incomeGrowth;
  const preview = applyIncomeTrend({ flows: baseFlows, trend, enabled: true });
  $('income-trend-note').textContent = trend.ready ? `Based on ${trend.completeMonths} complete months (${monthText(trend.start)}–${monthText(trend.end)}) and ${trend.matchedPairs} matching calendar-month comparisons. The learned trend gradually softens and adjusts each method’s own income estimate proportionally. Spending and contribution estimates stay with each method.${preview.ready ? ` Your scenario’s monthly income ${state.incomeGrowth ? 'runs' : 'would run'} from ${exactMoney(preview.flows[0].income)} in month 1 to ${exactMoney(preview.flows.at(-1).income)} in month ${state.horizon}.` : ''} Reimbursements included in salary can affect the estimate.` : trend.reason;
  const monthlyReady = plans.ready && !expenseNeedsReview && !incomeGrowthError && [meanIncome, ...Object.values(a), adjustment, plans.monthlyExpense].every(Number.isSafeInteger) && a.expense + adjustment >= 0 && (b.months > 0 || ['income', 'expense', 'saving'].every(key => state.assumptions[key] !== undefined));
  const financialContext = renderFinancialViews({ p, a: { ...a, income: meanIncome }, monthlyCashChange, incomeRange, b, plans, cashTransactions, monthlyReady, cash, savings, buffer, adjustment, oneOff, balanceDate, error: projectionError || (expenseNeedsReview ? 'Review your custom monthly spending after changing spending pots.' : !accountBalancesReady ? $('balance-source-note').textContent : invalid ? 'Enter valid starting balances, dates, and monthly assumptions below.' : cash === null ? 'Enter a starting cash balance to project cash and reserves.' : '') });
  renderForecastMethods(methods);
  const comparisons = methods.filter(method => state.methods.includes(method.id) && method.projection);
  const paths = p ? [{ id: 'balance', name: 'Your scenario', color: 'var(--chart-4)', projection: p }, ...comparisons] : [];
  $('forecast-history-note').textContent = b.months ? `History: ${monthText(b.start)}–${monthText(b.end)} · ${b.months} complete months. Historical methods use their own estimates; manual monthly inputs affect your scenario and unchanged assumptions. The spending change and one-off apply to all except unchanged assumptions.` : 'No complete history at this balance date. Enter all three monthly assumptions to use your scenario and unchanged assumptions.';
  $('forecast-history-note').textContent += state.incomeGrowth ? ' Income trend is on for every projection method.' : ' Income trend is off.';
  renderForecastChart({ cash, savings, buffer, balanceDate, p, methods, b, cashTransactions, financialContext });
  const net = plans.ready && !expenseNeedsReview && !invalidAmounts && !projectionError ? monthlyCashChange ?? NaN : NaN;
  renderStatistics($('forecast-stats'), [
    [hasPotSpending || state.incomeGrowth ? 'Average monthly cash change' : 'Monthly cash change', Number.isFinite(net) ? money(net) : '—', net < 0 ? 'negative' : 'positive'],
    [`Cash after ${state.horizon} month${state.horizon === 1 ? '' : 's'}`, p ? money(p.endBalance) : '—', p?.endBalance < 0 ? 'negative' : ''],
    ['Peak reserve needed', p ? money(p.reserveNeeded) : '—', p?.reserveNeeded > 0 ? 'negative' : '']
  ].map(([label, value, color], i) => ({ label, value, color, icon: ['trend', 'balance', 'saving'][i], tone: ['net', 'income', 'saving'][i], note: [hasPotSpending || state.incomeGrowth ? `Average over ${state.horizon} months${hasPotSpending ? ', including finite pot spending' : ', including the income trend'}` : 'Regular monthly income minus planned outflows', 'Before any reserve withdrawals', 'At the lowest monthly checkpoint'][i], ...(p && i === 1 ? { values: [cash, ...p.points.map(point => point.balance)], trendPoints: [{ date: balanceDate, starting: true }, ...p.points] } : {}) })));
  const lowest = p ? p.points.reduce((low, point) => point.balance < low.balance ? point : low, { date: balanceDate, balance: cash }) : null;
  const impact = p ? -adjustment * state.horizon - oneOff : null;
  renderStatistics($('scenario-insights'), [
    { label: 'Income committed', value: p ? percentage(ratio(a.expense + plans.monthlyExpense + a.saving + adjustment, meanIncome)) : '—', note: p && meanIncome <= 0 ? 'Needs positive regular monthly income' : 'Average spending + savings contributions ÷ average projected income; includes pot plans, excludes month-one expense' },
    { label: 'Scenario cash impact', value: impact === null ? '—' : money(impact), note: `Versus unchanged spending over ${state.horizon} months; includes the one-off expense`, color: impact === null || impact === 0 ? '' : impact < 0 ? 'negative' : 'positive' },
    { label: 'Lowest cash checkpoint', value: lowest ? money(lowest.balance) : '—', note: lowest ? `${dateText(lowest.date)} · includes starting cash; before reserve withdrawals` : 'Enter valid starting balances and assumptions' },
  ].map((item, i) => ({ ...item, icon: ['percent', 'trend', 'balance'][i], tone: ['expense', 'net', 'income'][i] })));
  $('forecast-message').classList.toggle('warning', !!p && (p.reserveNeeded > 0 || p.monthlyNet < 0));
  if (!p) $('forecast-message').textContent = projectionError || (expenseNeedsReview ? 'Review your custom spending amount above before calculating this scenario.' : invalid ? 'Correct the inputs above to calculate a forecast.' : 'Your balances and assumptions are saved in your private ledger. Public source and images contain no financial data.');
  else if (p.reserveNeeded > 0) $('forecast-message').textContent = `Before reserve support, the cash path reaches ${money(p.reserveNeeded)} below your ${money(buffer)} buffer. The Cash & reserves view above models withdrawals, planned contributions, and the remaining reserve month by month.`;
  else if (p.monthlyNet < 0) $('forecast-message').textContent = `This scenario averages a cash decrease of ${money(-p.monthlyNet)} per month over ${state.horizon} months. Your starting cash covers the scenario, with ${money(p.headroom)} above your chosen buffer at the end.`;
  else $('forecast-message').textContent = `This scenario ends ${money(p.headroom)} above your chosen buffer. Average monthly cash ${p.monthlyNet === 0 ? 'stays level' : `grows by ${money(p.monthlyNet)}`}. This is end-of-period headroom; payment timing within the month is not modeled.`;
  renderForecastComparison(paths, cash, balanceDate);
  $('forecast-table').innerHTML = p ? `<div class="table-scroll"><table><caption class="sr-only">Monthly cash projections by method</caption><thead><tr><th scope="col">Date</th>${paths.map(path => `<th scope="col" class="numeric">${esc(path.name)}</th>`).join('')}<th scope="col" class="numeric">Scenario cash change</th><th scope="col" class="numeric">Scenario reserve needed</th></tr></thead><tbody>${p.points.map((point, i) => `<tr><th scope="row">${dateText(point.date)}</th>${paths.map(path => `<td class="numeric ${path.projection.points[i].balance < 0 ? 'negative' : ''}">${exactMoney(path.projection.points[i].balance)}</td>`).join('')}<td class="numeric">${exactMoney(point.cashChange)}</td><td class="numeric">${exactMoney(point.reserveNeeded)}</td></tr>`).join('')}</tbody></table></div><p class="input-note">Cash before drawing from savings. Reserve needed is cumulative to restore the buffer at each date. Negative cash shows a shortfall. Do not add reserve-needed rows together.</p>` : '<p class="no-results">Your monthly estimates will appear once your starting balance is entered.</p>';
  registerReadOnlyBlock($('forecast-comparison'), 'Compare outcomes');
  registerReadOnlyBlock($('forecast-table'), 'Month by month');
}
function renderFinancialViews({ p, a, monthlyCashChange, incomeRange, b, plans, cashTransactions, monthlyReady, cash, savings, buffer, adjustment, oneOff, balanceDate, error }) {
  const accounts = state.data.accountDetails || [];
  const reviews = Object.fromEntries(['reserve', 'investments'].map(group => [group, growthReview({ accounts: accounts.filter(account => group === 'investments' ? account.accountType === 'investment' : account.accountType !== 'investment' && account.role === 'reserve'), flows: state.data.growthFlows || [], options: state.financialView.assetGrowth?.[group], asOf: /^\d{4}-\d{2}-\d{2}$/.test(balanceDate) ? balanceDate : undefined, minimumDays: 365 })]));
  const effectiveGrowth = Object.fromEntries(['reserve', 'investments'].map(group => [group, state.financialView.assetGrowth?.[group]?.source === 'history' ? reviews[group].evidence.annualGrowthBps ?? 0 : (group === 'reserve' ? state.financialView.reserveGrowthBps : state.financialView.growthBps) || 0]));
  let totals, summaryError = '';
  try { totals = accountAssetSummary(accounts); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    summaryError = error.message;
    totals = { ...Object.fromEntries(['cash', 'reserve', 'investments', 'other'].map(key => [key, { total: null }])), total: null, missing: 0 };
  }
  const automatic = contributionAllocation({ transactions: cashTransactions, accounts, start: b.start, end: b.end, months: b.months, saving: Number.isSafeInteger(a.saving) && a.saving >= 0 ? a.saving : 0 });
  const allocation = { reserve: state.financialView.reserveContribution ?? automatic.reserve, investment: state.financialView.investmentContribution ?? automatic.investment };
  allocation.unallocated = a.saving - allocation.reserve - allocation.investment;
  let projection = null, forecastError = summaryError || error;
  if (p && !summaryError) {
    try { projection = financialProjection({ projection: p, cash, reserve: savings, investments: totals.investments.total, other: totals.other.total, buffer, asOf: balanceDate, useReserve: state.financialView.useReserve, reserveContribution: allocation.reserve, investmentContribution: allocation.investment, annualGrowthBps: effectiveGrowth.investments, annualReserveGrowthBps: effectiveGrowth.reserve }); }
    catch (error) { if (!(error instanceof RangeError)) throw error; forecastError = error.message; }
  }
  const groupKeys = ['cash', 'reserve', 'investments', 'other'];
  const dates = [...new Set(accounts.filter(account => account.balance !== null && account.balanceDate).map(account => account.balanceDate))].sort();
  financialViews.setData({ ...state.financialView, incomeGrowth: state.incomeGrowth, incomeRange, monthlyCashChange, growthReview: reviews, effectiveGrowth, allocation, customAllocation: state.financialView.reserveContribution !== null || state.financialView.investmentContribution !== null,
    assumptions: { ...a, adjustment, plannedMonthlyExpense: plans.monthlyExpense, oneOff },
    summary: { ...Object.fromEntries(groupKeys.map(key => [key, totals[key].total])), total: totals.total, accounts, dates, missing: totals.missing, groupStatus: Object.fromEntries(groupKeys.map(key => [key, totals[key]])) },
    projection, forecastError, asOf: balanceDate, horizon: state.horizon, estimateLatest: state.balanceSource === 'latest', manualStartingPoint: state.balanceSource === 'manual', monthlyReady,
  });
  return { accounts, totals, allocation, summaryError, forecastError, effectiveGrowth };
}
function renderForecastMethods(methods) {
  const container = $('forecast-method-options');
  $('forecast-method-count').textContent = state.methods.length ? `${state.methods.length} selected` : 'Scenario only';
  // Keep the focused checkbox in place while chart and outcomes redraw.
  if (!container.children.length) container.innerHTML = methods.map(method => `<label class="forecast-method"><input type="checkbox" data-forecast-method="${method.id}" aria-describedby="method-${method.id}-note"><span><strong>${esc(method.name)}</strong><small id="method-${method.id}-note"></small></span></label>`).join('');
  for (const method of methods) {
    const checkbox = container.querySelector(`[data-forecast-method="${method.id}"]`);
    checkbox.checked = state.methods.includes(method.id);
    checkbox.disabled = !!method.reason;
    $('method-' + method.id + '-note').textContent = `${method.description}${method.reason ? ' ' + method.reason : ''}`;
  }
}
function renderForecastComparison(paths, cash, balanceDate) {
  $('forecast-comparison').innerHTML = paths.length ? `<div class="table-scroll"><table><caption class="sr-only">Projection outcomes after ${state.horizon} months</caption><thead><tr><th scope="col">Method</th><th scope="col" class="numeric">Final cash</th><th scope="col" class="numeric">Vs. your scenario</th><th scope="col" class="numeric">Lowest cash*</th><th scope="col" class="numeric">Peak reserve needed</th></tr></thead><tbody>${paths.map(path => {
    const projection = path.projection;
    const lowest = projection.points.reduce((low, point) => point.balance < low.balance ? point : low, { date: balanceDate, balance: cash });
    return `<tr><th scope="row">${esc(path.name)}</th><td class="numeric ${projection.endBalance < 0 ? 'negative' : ''}">${exactMoney(projection.endBalance)}</td><td class="numeric">${exactMoney(projection.endBalance - paths[0].projection.endBalance)}</td><td class="numeric">${exactMoney(lowest.balance)}<small>${dateText(lowest.date)}</small></td><td class="numeric">${exactMoney(projection.reserveNeeded)}</td></tr>`;
  }).join('')}</tbody></table></div><p class="input-note">*Includes starting cash and monthly checkpoints. Summary cards and scenario insights describe your scenario. Each method uses the same starting cash, reserve, buffer, and horizon. Methods can overlap on the chart.</p>` : '<p class="no-results">Enter valid starting balances and assumptions to compare outcomes.</p>';
}
function renderForecastChart({ cash, savings, buffer, balanceDate, p, methods, b, cashTransactions, financialContext }) {
  const settings = state.forecastChart;
  const sourcePaths = [{ id: 'scenario', name: 'Your scenario', projection: p, reason: p ? '' : financialContext.forecastError }, ...methods];
  const chartNotes = state.incomeGrowth ? ['Income trend is on for every projection method, including your scenario and unchanged assumptions. It adjusts each method’s income proportionally; spending and contribution estimates are preserved.'] : [];
  const financialPaths = sourcePaths.filter(path => settings.methods.includes(path.id)).map(path => {
    if (!path.projection) return { ...path, projection: null, reason: path.reason || 'Complete the starting balances and monthly assumptions to project this method.' };
    try {
      const history = forecastHistory(cashTransactions, forecastHistoryDate(), path.id === 'seasonal' ? 12 : state.lookback, state.data.metadata.firstDate);
      const allocations = path.projection.points.map(point => ['scenario', 'unchanged'].includes(path.id) ? financialContext.allocation : contributionAllocation({ transactions: cashTransactions, accounts: financialContext.accounts, start: history.start, end: history.end, months: history.series.length, saving: point.saving }));
      const projection = financialProjection({ projection: path.projection, cash, reserve: savings, investments: financialContext.totals.investments.total ?? 0, other: 0, buffer, asOf: balanceDate, useReserve: false, reserveContribution: allocations.map(row => row.reserve), investmentContribution: allocations.map(row => row.investment), annualGrowthBps: financialContext.effectiveGrowth.investments, annualReserveGrowthBps: financialContext.effectiveGrowth.reserve });
      return { id: path.id, name: path.name, projection };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      try {
        const projection = financialProjection({ projection: path.projection, cash, reserve: 0, investments: 0, other: 0, buffer, asOf: balanceDate, useReserve: false });
        chartNotes.push(`${path.name}: cash remains available; review the asset allocation (${error.message}).`);
        return { id: path.id, name: path.name, projection, scopeReasons: Object.fromEntries(['reserve', 'investments', 'cash-reserve', 'cash-investments', 'cash-reserve-investments'].map(scope => [scope, error.message])) };
      } catch (cashError) {
        if (!(cashError instanceof RangeError)) throw cashError;
        return { id: path.id, name: path.name, projection: null, reason: cashError.message };
      }
    }
  });
  try {
    const start = new Date(balanceDate + 'T12:00:00Z');
    const targetMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - state.historyMonths, 1));
    const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
    targetMonth.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    const historyStart = targetMonth.toISOString().slice(0, 10);
    const reconstructedCash = historicalCash({ transactions: cashTransactions, firstDate: state.data.metadata.firstDate, lastDate: state.data.metadata.lastDate, cash, asOf: balanceDate, months: state.historyMonths });
    const combinations = forecastCombinations({ accounts: financialContext.accounts, asOf: balanceDate, historyStart, reconstructedCash, paths: financialPaths, scopes: settings.scopes, startMode: state.balanceSource === 'latest' ? 'latest' : state.balanceSource === 'manual' ? 'manual' : 'observed' });
    const investmentGroup = financialContext.totals.investments;
    const investmentFundingKnown = !financialContext.summaryError && !investmentGroup.missing && !investmentGroup.undated && (state.balanceSource === 'latest' || !investmentGroup.count || (investmentGroup.dates?.length === 1 && investmentGroup.dates[0] === balanceDate));
    const model = forecastChartModel({ combinations, settings, asOf: balanceDate, buffer, openingReserve: savings, openingInvestments: investmentFundingKnown ? investmentGroup.total : null });
    const width = $('forecast-chart').clientWidth;
    renderTimeSeriesChart($('forecast-chart'), { ...model, title: 'Account combinations and forecast methods', format: exactMoney, label: point => dateText(point.date), timeSpacing: true, width, height: width < 600 ? 440 : 560, empty: 'No complete history or valid projections for the selected layers. Review their account coverage and starting balances.' });
    chartNotes.push(...model.notes);
    forecastChartControls.setData({ settings, methods, seriesCount: model.series.length, notes: [...new Set(chartNotes)] });
    $('forecast-chart-history-note').textContent = `${state.historyMonths ? 'Square history markers show complete same-date observations; dotted cash history is reconstructed. Unknown values leave gaps, and investment history is never inferred.' : 'Future projections and their starting values only.'} ${state.balanceSource === 'latest' ? 'Projected starts use your latest-value estimate, preserving the original observation dates.' : state.balanceSource === 'manual' ? 'Projected cash and savings start from your entered totals.' : 'Projected starts use matching dated observations.'} Cash paths are before reserve transfers; contributions enter their allocated groups once.`;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    $('forecast-chart').innerHTML = `<p class="no-results">${esc(error.message)}</p>`;
    $('forecast-chart-history-note').textContent = '';
    forecastChartControls.setData({ settings, methods, seriesCount: 0, notes: [error.message] });
    registerReadOnlyBlock($('forecast-chart'), 'Funds over time');
  }
}

function filteredTransactions() {
  const query = $('search').value.toLocaleLowerCase().trim();
  const category = $('category-filter').value, kind = $('kind-filter').value;
  const tx = $('transaction-period').value === 'all' ? state.transactions : selectedTransactions();
  const result = tx.filter(t => (!query || `${t.description} ${t.category} ${t.subcategory} ${t.account} ${t.fromAccount} ${t.toAccount} ${t.counterparty} ${t.fromEndpoint?.name || ''} ${t.toEndpoint?.name || ''}`.toLocaleLowerCase().includes(query)) && (!category || t.category === category) && (!kind || t.kind === kind) && (!$('review-only').checked || t.review) && (!$('excluded-only').checked || t.excludeForecast) && matchesCategoryStatus(t, $('category-status-filter').value));
  const sort = $('transaction-sort').value;
  return result.sort((a, b) => sort === 'outflow' ? a.amount - b.amount : sort === 'inflow' ? b.amount - a.amount : sort === 'oldest' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));
}
function renderTransactions() {
  const categories = [...new Set(state.transactions.map(t => t.category))].sort();
  const previous = $('category-filter').value;
  $('category-filter').innerHTML = '<option value="">All categories</option>' + categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('category-filter').value = categories.includes(previous) ? previous : '';
  $('show-uncategorized').textContent = `Uncategorized (${state.transactions.filter(isUncategorized).length})`;
  $('show-category-review').textContent = `Review suggestions (${state.transactions.filter(t => matchesCategoryStatus(t, 'pending')).length})`;
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
    { label: 'Savings & investments', value: money(totals.saving), note: 'Contributions to reserves and investments' },
    { label: 'Cash change', value: money(totals.net), note: `${number.format(tx.filter(t => t.kind === 'transfer').length)} internal transfer entries excluded`, color: totals.net < 0 ? 'negative' : totals.net > 0 ? 'positive' : '' },
  ].map((item, i) => ({ ...item, icon: ['income', 'expense', 'saving', 'trend'][i], tone: ['income', 'expense', 'saving', 'net'][i], values: history.points.map(point => point[['income', 'expense', 'saving', 'net'][i]]), trendPoints: history.points })));
  renderTimeSeriesChart($('transaction-trend-chart'), { points: tx.length ? history.points : [], series: [{ key: 'income', name: 'Money in', color: 'var(--chart-in)' }, { key: 'expense', name: 'Spending', color: 'var(--chart-out)' }, { key: 'saving', name: 'Savings & investments', color: 'var(--chart-3)' }], title: 'Filtered transaction activity in NOK', format: exactMoney, label: point => history.interval === 'month' ? monthText(point.date.slice(0, 7)) : dateText(point.date).replace(/ \d{4}$/, ''), width: $('transaction-trend-chart').clientWidth, empty: 'No transactions match these filters.' });
  $('transaction-trend-note').textContent = `${{ day: 'Daily', week: '7-day', month: 'Monthly' }[history.interval]} totals for all matching pages. First and last periods may be partial. Internal transfers are excluded.`;
  const kindLabels = { expense: 'Spending', income: 'Money in', saving: 'Savings', transfer: 'Transfer' };
  $('transaction-rows').innerHTML = shown.length ? shown.map(t => { const node = explorer.endpointForAccount(t.accountId); return `<tr><td>${dateText(t.date)}<small>${node ? explorer.endpointLink(node) : esc(t.account || 'Unknown account')}</small></td><td><a class="ledger-link" href="${esc(routeHash({ view: 'transaction', id: t.id }))}">${esc(t.description || 'Untitled transaction')}</a>${t.review ? '<small class="review-tag">● Needs review</small>' : ''}${t.excludeForecast ? '<small>One-off · excluded from forecast</small>' : ''}</td><td>${esc(t.category)}<small>${esc(t.subcategory)}</small>${categoryControls(t)}</td><td><span class="badge ${t.kind}">${kindLabels[t.kind]}</span></td><td class="numeric ${t.amount > 0 ? 'positive' : ''}">${t.amount > 0 ? '+' : ''}${money(t.amount)}</td><td><button class="edit-button" data-edit="${esc(t.id)}" aria-label="Review ${esc(t.description)}">Edit</button></td></tr>`; }).join('') : '<tr><td colspan="6" class="no-results">No transactions match these filters.</td></tr>';
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
  $('edit-kind').value = state.overrides[id]?.kind || 'auto'; $('edit-category').value = tx.category; $('edit-exclude').checked = !!tx.excludeForecast;
  // Preserve cash direction while still allowing either direction to be an internal transfer.
  for (const option of $('edit-kind').options) option.disabled = tx.amount > 0 ? ['expense', 'saving'].includes(option.value) : tx.amount < 0 ? option.value === 'income' : false;
  for (const side of ['from', 'to']) {
    const control = $('edit-' + side + '-owned');
    const source = tx[side === 'from' ? 'sourceFromEndpoint' : 'sourceToEndpoint'];
    control.innerHTML = '<option value="">Use source sender / receiver</option>' + (state.data.accountDetails || []).map(account => `<option value="${esc(account.id)}">${esc(account.name)}${account.institution ? ` · ${esc(account.institution)}` : ''}</option>`).join('');
    control.value = source?.owned ? source.accountId : state.overrides[id]?.[`${side}OwnedAccountId`] || '';
    control.disabled = !!source?.owned;
  }
  categorization.renderReview(tx);
  $('edit-dialog').showModal();
}
function clearFilters() { $('category-status-filter').value = ''; $('search').value = ''; $('category-filter').value = ''; $('kind-filter').value = ''; $('review-only').checked = false; $('excluded-only').checked = false; $('transaction-sort').value = 'newest'; state.page = 0; }
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
  spendingPlanController.setData({ plans: state.spendingPlans, accounts: payload.accountDetails || [], categories: [...new Set(applyOverrides(payload.transactions, payload.overrides).map(tx => tx.category))] });
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
$('forecast-history').addEventListener('change', () => { state.historyMonths = Number($('forecast-history').value); renderForecast(); persist(); });
$('forecast-horizon').addEventListener('change', () => { state.horizon = Number($('forecast-horizon').value); renderForecast(); persist(); });
$('open-forecast-methods').addEventListener('click', () => $('forecast-method-dialog').showModal());
$('income-growth').addEventListener('change', event => { state.incomeGrowth = event.target.checked; renderForecast(); persist(); });
$('forecast-method-options').addEventListener('change', event => {
  const method = event.target.dataset.forecastMethod;
  if (!method) return;
  state.methods = event.target.checked ? [...new Set([...state.methods, method])] : state.methods.filter(id => id !== method);
  renderForecast(); persist();
});
$('forecast-scale').addEventListener('change', () => renderForecast());
$('transactions-scale').addEventListener('change', () => renderTransactions());
for (const id of ['range-start', 'range-end']) $(id).addEventListener('change', () => { state.page = 0; renderOverview(); renderTransactions(); });
for (const id of ['search', 'category-filter', 'category-status-filter', 'kind-filter', 'transaction-period', 'transaction-sort', 'review-only', 'excluded-only']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { state.page = 0; renderTransactions(); });
$('clear-filters').addEventListener('click', () => { clearFilters(); renderTransactions(); });
$('previous-page').addEventListener('click', () => { state.page--; renderTransactions(); });
$('next-page').addEventListener('click', () => { state.page++; renderTransactions(); });
$('review-button').addEventListener('click', () => { clearFilters(); $('review-only').checked = true; $('transaction-period').value = 'all'; renderTransactions(); showView('transactions'); });
$('large-payments').addEventListener('click', () => { clearFilters(); $('transaction-period').value = 'selected'; $('kind-filter').value = 'expense'; $('transaction-sort').value = 'outflow'; $('period').value = String(state.lookback); renderOverview(); renderTransactions(); showView('transactions'); });
$('manage-spending-plans').addEventListener('click', () => { showView('accounts'); $('spending-plans').scrollIntoView({ block: 'start' }); });
for (const id of ['cash', 'savings', 'buffer', 'balance-date', 'adjustment', 'one-off']) $(id).addEventListener('input', () => { if (id === 'adjustment') state.scenario = 'custom'; renderForecast(); persist(); });
for (const id of ['income', 'expense', 'saving']) $(id).addEventListener('input', () => { state.assumptions[id] = fieldCents(id); if (id === 'expense') { state.scenario = 'custom'; state.expensePlanCategories = [...forecastPlans().managedCategories]; } renderForecast(); persist(); });
$('lookback').addEventListener('change', () => { state.lookback = Number($('lookback').value); state.assumptions = {}; recalculate(); persist(); });
$('reset-baseline').addEventListener('click', () => { state.assumptions = {}; state.expensePlanCategories = []; $('adjustment').value = '0'; state.scenario = 'same'; renderForecast(); persist(); toast('Monthly assumptions restored from your history.'); });
$('reset-plan-expense').addEventListener('click', async () => { delete state.assumptions.expense; state.expensePlanCategories = []; renderForecast(); persist(); await flushSavedWrites(); });
$('confirm-plan-expense').addEventListener('click', async () => { state.expensePlanCategories = [...forecastPlans().managedCategories]; renderForecast(); persist(); await flushSavedWrites(); });
for (const [id, status] of [['show-uncategorized', 'uncategorized'], ['show-category-review', 'pending']]) $(id).addEventListener('click', () => { clearFilters(); $('transaction-period').value = 'all'; $('category-status-filter').value = status; renderTransactions(); });
$('close-dialog').addEventListener('click', () => $('edit-dialog').close());
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const override = { category: $('edit-category').value.trim(), excludeForecast: $('edit-exclude').checked };
  if ($('edit-kind').value !== 'auto') override.kind = $('edit-kind').value;
  for (const side of ['from', 'to']) {
    const control = $('edit-' + side + '-owned');
    if (!control.disabled && control.value) override[`${side}OwnedAccountId`] = control.value;
  }
  if (!override.category) return;
  const anchor = state.transactions.find(t => t.id === state.editId);
  const submit = event.submitter; if (submit) submit.disabled = true;
  try {
    await api('/api/overrides', { method: 'PATCH', body: { id: state.editId, override } });
    $('edit-dialog').close(); await loadLocal(); persist(); toast('Transaction updated in your ledger.');
    if (anchor && (override.category !== anchor.category || matchesCategoryStatus(anchor, 'pending'))) categorization.offerSimilar(state.transactions.find(row => row.id === anchor.id) || anchor, override.category, 'user_applied');
  } catch (error) { handleError(error); }
  finally { if (submit) submit.disabled = false; }
});
$('reset-transaction').addEventListener('click', async () => {
  try { const result = await api('/api/overrides', { method: 'PATCH', body: { id: state.editId, override: null } }); state.overrides = result.overrides; $('edit-dialog').close(); await loadLocal(); persist(); toast('Transaction edits reset. Suggestions recalculated.'); } catch (error) { handleError(error); }
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
    state.overrides = (await api('/api/overrides', { method: 'PUT', body: { overrides: {}, resetCategories: true } })).overrides;
    state.assumptions = {}; state.incomeGrowth = false; state.spendingPlans = []; state.expensePlanCategories = []; state.financialView = defaultFinancialView(); state.forecastChart = defaultForecastChart(); state.lookback = 3; state.horizon = 3; state.methods = [...defaultForecastMethods]; state.historyMonths = 3; state.scenario = 'same'; state.balanceSource = 'manual';
    for (const id of ['cash', 'savings', 'buffer']) $(id).value = '';
    $('adjustment').value = '0'; $('one-off').value = '0'; $('balance-date').value = today;
    await loadLocal(); persist(); toast('Forecast settings and transaction edits reset.');
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
window.addEventListener('resize', () => { clearTimeout(resizeTimeout); resizeTimeout = setTimeout(() => { if (!state.data) return; if (state.view === 'overview') renderOverview(); if (state.view === 'forecast') renderForecast(); if (state.view === 'transactions') renderTransactions(); if (state.view === 'accounts') accountController.redrawCharts(); if (state.view === 'account') explorer.redrawCharts(); }, 100); });
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
  if (state.view === 'accounts') accountController.redrawCharts();
  if (state.view === 'account') explorer.redrawCharts();
});
