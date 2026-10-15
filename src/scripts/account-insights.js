import { summarizeAccounts } from '../lib/account-statistics.js';
import { renderTimeSeriesChart } from './charts.js';
import { registerBlock } from './block-dialog.js';
import { CHART_SCALES, pageChartScale } from './page-chart-scale.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const groupChoices = [
  { value: 'role', label: 'Use in forecast' }, { value: 'type', label: 'Account type' },
  { value: 'institution', label: 'Bank or platform' }, { value: 'account', label: 'Individual accounts' },
];
const accountCount = count => `${count} account${count === 1 ? '' : 's'}`;
const valueLabel = (row, format) => row.total === null ? row.knownCount ? 'Total too large' : 'Not recorded' : format(row.total);

// Positive and negative values have separate bars, so offsets within a group
// remain visible. Unknown values never become zero-length known balances.
export function accountAllocationMarkup(rows, format, { scale = 'linear', bars = true } = {}) {
  rows = rows.filter(row => row.count);
  if (!rows.length) return '<p class="no-results">Add an account to see where your money sits.</p>';
  const transform = value => scale === 'sqrt' ? Math.sqrt(value) : scale === 'log' ? Math.log10(1 + value / 100) : value;
  const chartable = rows.filter(row => Number.isFinite(row.positiveTotal) && Number.isFinite(row.negativeTotal));
  const extent = Math.max(1, ...chartable.flatMap(row => [row.positiveTotal, row.negativeTotal]).map(value => transform(Math.abs(value))));
  const bar = (value, color) => {
    if (!Number.isFinite(value) || !value) return '';
    const width = transform(Math.abs(value)) / extent * 50;
    return `<span class="account-allocation-bar" style="left:${value < 0 ? 50 - width : 50}%;width:${width}%;background:${color}"></span>`;
  };
  return `${bars ? `<div class="account-allocation-axis" aria-hidden="true"><span>Negative</span><span>0</span><span>Positive</span></div>` : ''}${rows.map((row, index) => {
    const known = row.knownCount > 0;
    const overflow = known && (row.positiveTotal === null || row.negativeTotal === null);
    const offsets = row.positiveTotal > 0 && row.negativeTotal < 0 ? ` · ${format(row.positiveTotal)} positive · ${format(row.negativeTotal)} negative` : '';
    return `<div class="account-allocation-row"><div class="account-allocation-heading"><span>${row.href ? `<a class="ledger-link" href="${esc(row.href)}">${esc(row.label)}</a>` : esc(row.label)}</span><strong class="${row.total < 0 ? 'negative' : ''}">${esc(valueLabel(row, format))}</strong></div><p class="account-allocation-meta">${esc(accountCount(row.count))}${row.unknownCount ? ` · ${row.unknownCount} unknown` : ''}${esc(offsets)}${overflow ? ' · Positive or negative total too large to chart' : ''}</p>${bars && known && !overflow ? `<div class="account-allocation-track" aria-hidden="true"><span class="account-allocation-zero"></span>${bar(row.negativeTotal, 'var(--negative-text)')}${bar(row.positiveTotal, `var(--chart-${index % 8 + 1})`)}</div>` : ''}</div>`;
  }).join('')}`;
}

export function accountHistoryComparison(history) {
  const ordered = history.filter(row => Number.isSafeInteger(row.amount)).sort((a, b) => a.date.localeCompare(b.date));
  const first = ordered[0], last = ordered.at(-1);
  if (ordered.length < 2) return null;
  const change = BigInt(last.amount) - BigInt(first.amount);
  return { firstDate: first.date, lastDate: last.date, change: change > BigInt(Number.MAX_SAFE_INTEGER) || change < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(change) };
}

function allocationBlock(groups, format, group, scale) {
  const snapshot = Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.map(row => ({ ...row }))]));
  return {
    title: 'Where your money sits', initial: { group, scale, bars: true },
    controls: [
      { key: 'group', label: 'Group accounts by', choices: groupChoices },
      { key: 'scale', label: 'Chart scale', choices: CHART_SCALES.map(item => ({ value: item.id, label: item.label })) },
      { key: 'bars', label: 'Show bars', type: 'checkbox' },
    ],
    render(container, settings) {
      container.innerHTML = accountAllocationMarkup(snapshot[settings.group] || [], format, settings);
    },
  };
}

export function createAccountInsights({ money, valueText }) {
  const $ = id => document.getElementById(id);
  let accounts = [], summary = summarizeAccounts([]);
  const stat = (label, value, className) => `<div class="${className}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  function renderAllocation() {
    const individual = accounts.map(account => ({ ...summarizeAccounts([account]), id: account.id, label: account.name, href: `#accounts/${encodeURIComponent(account.id)}` }));
    const groups = { ...summary.groups, account: individual };
    const group = $('account-breakdown-group').value;
    const scale = pageChartScale($('account-allocation'));
    $('account-allocation').innerHTML = accountAllocationMarkup(groups[group] || [], valueText, { scale });
    $('account-allocation-note').textContent = 'Bars use the selected chart scale. Positive and negative balances are shown separately; the figure is their net value. Unknown values are omitted. Each account is counted once.';
    registerBlock($('account-allocation'), allocationBlock(groups, valueText, group, scale));
  }
  function renderHistory() {
    const account = accounts.find(row => row.id === $('account-history-account').value);
    const history = [...(account?.valueHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
    const comparison = accountHistoryComparison(history);
    $('account-history-change').innerHTML = comparison ? stat('Change across recorded history', comparison.change === null ? 'Change too large' : valueText(comparison.change), 'account-history-stat') : '';
    $('account-history-note').textContent = comparison
      ? `${comparison.firstDate} to ${comparison.lastDate}. Change includes payments, fees, and other value changes; it is not an investment return. Lines connect recorded observations. No balances are inferred between dates.`
      : 'Record at least two known values to compare the change. Each point is a dated observation; no balances are inferred between dates.';
    renderTimeSeriesChart($('account-history-chart'), {
      points: history, series: [{ key: 'amount', name: account?.name || 'Recorded value', color: 'var(--chart-4)' }],
      title: account ? `Recorded value · ${account.name}` : 'Recorded account values',
      format: valueText, label: point => point.date, timeSpacing: true,
      width: $('account-history-chart').clientWidth || 600,
      empty: 'Record a dated account value to start this chart.',
    });
  }
  $('account-breakdown-group').addEventListener('change', renderAllocation);
  $('account-history-account').addEventListener('change', renderHistory);
  $('accounts-scale').addEventListener('change', () => { renderAllocation(); renderHistory(); });
  return {
    setData(rows) {
      accounts = rows; summary = summarizeAccounts(accounts);
      $('account-total').textContent = summary.total === null ? summary.knownCount ? 'Total too large' : 'Not recorded' : valueText(summary.total);
      $('account-total').classList.toggle('negative', summary.total < 0);
      $('account-total-note').textContent = !accounts.length ? 'Add your bank accounts and investments to build your overview.'
        : `All tracked accounts, including those outside the cash forecast. Negative balances reduce this total.${summary.unknownCount ? ` Partial total: ${summary.knownCount} of ${accountCount(summary.count)} valued.` : ''}`;
      $('account-total-dates').textContent = !summary.oldestDate ? 'No dated balances recorded.'
        : summary.mixedDates ? `Mixed value dates: ${summary.oldestDate} to ${summary.newestDate}. This combines the latest observation for each account.`
        : `Values recorded on ${summary.newestDate}. Balances do not update automatically from transactions.`;
      const totalLabel = amount => amount === null ? summary.knownCount ? 'Total too large' : 'Not recorded' : money(amount);
      $('account-total-details').innerHTML = stat('Positive balances', totalLabel(summary.positiveTotal), 'account-total-stat')
        + stat('Negative balances', totalLabel(summary.negativeTotal), 'account-total-stat')
        + stat('Values recorded', `${summary.knownCount} / ${summary.count} accounts`, 'account-total-stat');
      const selected = $('account-history-account').value;
      $('account-history-account').innerHTML = accounts.length ? accounts.map(account => `<option value="${esc(account.id)}">${esc(account.name)}</option>`).join('') : '<option value="">No accounts yet</option>';
      $('account-history-account').disabled = !accounts.length;
      $('account-history-account').value = accounts.some(row => row.id === selected) ? selected
        : [...accounts].sort((a, b) => (b.valueHistory?.length || 0) - (a.valueHistory?.length || 0))[0]?.id || '';
      renderAllocation(); renderHistory();
    },
    redraw() { renderAllocation(); renderHistory(); },
  };
}
