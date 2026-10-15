import { renderMetricCards } from './statistics.js';
import { renderTimeSeriesChart } from './charts.js';
import { accountTypes, accountRoles } from '../lib/account-values.js';
import { summarizeAccounts } from '../lib/account-statistics.js';
import { createAccountInsights } from './account-insights.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const integerAmount = value => value === '' ? null : Math.round(Number(value) * 100);
const options = (labels, selected) => Object.entries(labels).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');

export function accountStartingPoint(accounts) {
  const included = accounts.filter(a => a.role !== 'excluded');
  if (included.some(a => a.accountType === 'investment')) return { ready: false, reason: 'Keep investment accounts outside available cash and savings reserves.' };
  if (!accounts.some(a => a.role === 'available')) return { ready: false, reason: 'Choose at least one account as available cash.' };
  if (included.some(a => a.balance === null)) return { ready: false, reason: 'Set balances for every available and reserve account, or exclude accounts you do not want to use.' };
  const dates = new Set(included.map(a => a.balanceDate));
  if (dates.size !== 1 || ![...dates][0]) return { ready: false, reason: 'Use the same balance date for all included accounts. Balances from different dates cannot form one starting point.' };
  const sum = role => Number(included.filter(a => a.role === role).reduce((total, a) => total + BigInt(a.balance), 0n));
  const cash = sum('available'), savings = sum('reserve');
  if (!Number.isSafeInteger(cash) || !Number.isSafeInteger(savings)) return { ready: false, reason: 'Combined balances exceed the supported exact amount range.' };
  if (savings < 0) return { ready: false, reason: 'The reserve total is negative. Review the included reserve accounts before forecasting.' };
  return { ready: true, date: [...dates][0], cash, savings };
}

export function createAccountController({ api, money, today, onChange, onUse, onError, toast, activityLink = () => '' }) {
  let accounts = [];
  const $ = id => document.getElementById(id);
  const exact = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const valueText = amount => amount === null ? '—' : exact.format(amount / 100) + ' kr';
  const insights = createAccountInsights({ money, valueText });
  function render() {
    insights.setData(accounts);
    renderMetricCards($('account-summary'), summarizeAccounts(accounts).groups.role.map(row => ({
      label: row.label,
      value: row.total === null ? row.knownCount ? 'Total too large' : row.count ? 'Not set' : money(0) : money(row.total),
      note: `${row.count} account${row.count === 1 ? '' : 's'} · latest recorded values${row.unknownCount ? ` · ${row.unknownCount} unknown` : ''}${row.id === 'investment' ? ' · outside cash forecast' : ''}`,
      icon: row.id === 'available' ? 'balance' : 'saving', tone: row.id === 'available' ? 'income' : 'neutral',
    })));
    const start = accountStartingPoint(accounts);
    $('account-readiness').textContent = start.ready ? `Balances ready as of ${start.date}. Available cash and reserves do not overlap.` : start.reason;
    $('use-account-balances').disabled = !start.ready;
    $('account-cards').innerHTML = accounts.length ? accounts.map(account => {
      const history = account.valueHistory || [];
      const investment = account.accountType === 'investment';
      return `<article class="card account-card"><div class="card-heading"><h2>${escape(account.name)}</h2><span class="badge">${escape(account.currency)}</span></div><p class="input-note">${escape(account.institution || 'Institution not set')} · ${escape(accountTypes[account.accountType] || 'Other account')}</p><p class="account-recorded-value">${account.balance === null ? 'Value unknown' : valueText(account.balance)}</p><p class="input-note">${account.balanceDate ? `Last valued on ${escape(account.balanceDate)}` : 'No value recorded.'} · ${account.imported ? 'Imported account' : 'Manually tracked account'}</p>${activityLink(account)}
      <form class="account-form" data-account-id="${escape(account.id)}" data-account-action="value"><div class="account-fields"><label>${investment ? 'Total investment value in NOK' : 'Account balance in NOK'}<input name="balance" type="number" step="0.01" placeholder="Enter observed value" required /></label><label>Value date<input name="balanceDate" type="date" value="${today}" required /></label></div><p class="input-note">${investment ? 'Include holdings and uninvested platform cash in one total. ' : ''}A new date adds history. The same date corrects that entry. Saving a value does not create a payment.</p><button class="outline-button" type="submit">Record value</button></form>
      <details class="account-value-history"><summary>Value history · ${history.length} observation${history.length === 1 ? '' : 's'}</summary><div data-value-chart="${escape(account.id)}"></div>${history.length ? `<div class="table-scroll"><table><caption class="sr-only">Recorded values and changes for ${escape(account.name)}</caption><thead><tr><th>Date</th><th class="numeric">Value</th><th class="numeric">Change</th><th class="numeric">Recorded net movement</th><th class="numeric">Other change*</th></tr></thead><tbody>${[...history].reverse().map(row => `<tr><td>${escape(row.date)}</td><td class="numeric">${valueText(row.amount)}</td><td class="numeric">${valueText(row.change)}</td><td class="numeric">${valueText(row.recordedMovement)}</td><td class="numeric">${valueText(row.unexplainedChange)}</td></tr>`).join('')}</tbody></table></div><p class="input-note">*Value change minus recorded net movement since the previous date, through the end of this value date. ${investment ? 'May include investment gains or losses, fees, and missing movements. It is not a return calculation.' : 'May include interest, fees, or missing payments.'} No balance is inferred between observations.</p>` : '<p class="input-note">Record a value to start the history.</p>'}</details>
      <details class="account-settings"><summary>Account settings</summary><form class="account-form" data-account-id="${escape(account.id)}" data-account-action="profile"><label>Account name<input name="name" value="${escape(account.name)}" maxlength="200" required /></label><label>Bank or platform<input name="institution" value="${escape(account.institution)}" maxlength="200" placeholder="Institution name" /></label><label>Account type<select name="accountType">${options(accountTypes, account.accountType)}</select></label><label>Use in forecast<select name="role">${options(accountRoles, account.role)}</select></label><p class="input-note">Investment values stay outside the cash forecast. Available-to-reserve or investment transfers reduce cash without counting as spending. Existing explicit transaction classifications take priority.</p><button class="outline-button" type="submit">Save account settings</button></form></details></article>`;
    }).join('') : '<article class="card no-results">No accounts yet. Import data or add an account.</article>';
    document.querySelectorAll('.account-settings form').forEach(form => syncType(form.elements.accountType, form.elements.role));
  }
  function syncType(type, role) {
    const investment = type.value === 'investment';
    for (const option of role.options) option.disabled = investment && option.value !== 'excluded';
    if (investment) role.value = 'excluded';
  }
  $('account-cards').addEventListener('change', event => {
    if (event.target.name === 'accountType') syncType(event.target, event.target.form.elements.role);
  });
  function renderValueChart(element) {
    const account = accounts.find(a => a.id === element.dataset.valueChart);
    if (!account) return;
    renderTimeSeriesChart(element, { points: account.valueHistory || [], series: [{ key: 'amount', name: 'Recorded value', color: 'var(--chart-4)' }], title: `Recorded value · ${account.name}`, format: valueText, label: point => point.date, timeSpacing: true, width: element.clientWidth, empty: 'No known values recorded.' });
  }
  function redrawOpenHistories() {
    $('account-cards').querySelectorAll('.account-value-history[open] [data-value-chart]').forEach(renderValueChart);
  }
  $('accounts-scale').addEventListener('change', redrawOpenHistories);
  $('account-cards').addEventListener('toggle', event => {
    if (!event.target.matches('.account-value-history') || !event.target.open) return;
    renderValueChart(event.target.querySelector('[data-value-chart]'));
  }, true);
  $('account-cards').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target.closest('form[data-account-id]'); if (!form) return;
    const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try {
      const values = new FormData(form);
      const body = form.dataset.accountAction === 'value' ? { balance: integerAmount(values.get('balance')), balanceDate: values.get('balanceDate') } : { name: values.get('name'), institution: values.get('institution'), accountType: values.get('accountType'), role: values.get('role') };
      await api('/api/accounts', { method: 'PATCH', body: { id: form.dataset.accountId, ...body } });
      await onChange(); toast(form.dataset.accountAction === 'value' ? 'Dated value saved in account history.' : 'Account settings saved.');
    } catch (error) { onError(error); button.disabled = false; }
  });
  $('add-account').addEventListener('click', () => { $('new-account-form').reset(); $('new-account-date').value = today; syncType($('new-account-type'), $('new-account-role')); $('account-dialog').showModal(); });
  $('new-account-type').addEventListener('change', () => syncType($('new-account-type'), $('new-account-role')));
  $('close-account-dialog').addEventListener('click', () => $('account-dialog').close());
  $('new-account-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button[type=submit]'); button.disabled = true;
    try {
      await api('/api/accounts', { method: 'POST', body: { name: $('new-account-name').value, institution: $('new-account-institution').value, accountType: $('new-account-type').value, currency: 'NOK', role: $('new-account-role').value, balance: integerAmount($('new-account-balance').value), balanceDate: $('new-account-date').value } });
      $('account-dialog').close(); await onChange(); toast('Account added to your ledger.');
    } catch (error) { onError(error); }
    finally { button.disabled = false; }
  });
  $('use-account-balances').addEventListener('click', () => onUse());
  return { setData(rows) { accounts = rows; render(); }, startingPoint() { return accountStartingPoint(accounts); }, redrawCharts() { insights.redraw(); redrawOpenHistories(); } };
}
