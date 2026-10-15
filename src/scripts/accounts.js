import { renderMetricCards } from './statistics.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const integerAmount = value => value === '' ? null : Math.round(Number(value) * 100);

export function accountStartingPoint(accounts) {
  const included = accounts.filter(a => a.role !== 'excluded');
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
  function render() {
    const group = role => accounts.filter(a => a.role === role);
    const totals = ['available', 'reserve', 'excluded'].map(role => {
      const rows = group(role), known = rows.filter(a => a.balance !== null);
      const total = Number(known.reduce((sum, a) => sum + BigInt(a.balance), 0n));
      return { role, total, known: known.length, missing: rows.length - known.length, rows: rows.length };
    });
    renderMetricCards($('account-summary'), totals.map(({ role, total, known, missing, rows }) => ({ label: { available: 'Available cash', reserve: 'Savings reserve', excluded: 'Excluded accounts' }[role], value: known || !rows ? money(total) : 'Not set', note: missing ? `${missing} balance${missing === 1 ? '' : 's'} unknown · known subtotal only` : `${rows} account${rows === 1 ? '' : 's'}`, icon: { available: 'balance', reserve: 'saving', excluded: 'payment' }[role], tone: { available: 'income', reserve: 'saving', excluded: 'neutral' }[role] })));
    const start = accountStartingPoint(accounts);
    $('account-readiness').textContent = start.ready ? `Balances ready as of ${start.date}. Available cash and reserves do not overlap.` : start.reason;
    $('use-account-balances').disabled = !start.ready;
    $('account-cards').innerHTML = accounts.length ? accounts.map(account => `<form class="card account-form" data-account-id="${escape(account.id)}"><div class="card-heading"><h2>${escape(account.name)}</h2><span class="badge">${escape(account.currency)}</span></div>${activityLink(account)}<label>Account name<input name="name" value="${escape(account.name)}" maxlength="200" required /></label><label>Use in forecast<select name="role">${[['available', 'Available cash'], ['reserve', 'Savings reserve'], ['excluded', 'Excluded']].map(([value, label]) => `<option value="${value}" ${account.role === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="account-fields"><label>Balance in NOK<input name="balance" type="number" step="0.01" value="${account.balance === null ? '' : (account.balance / 100).toFixed(2)}" placeholder="Unknown" /></label><label>Balance date<input name="balanceDate" type="date" value="${escape(account.balanceDate || today)}" required /></label></div><div class="account-save-row"><span class="input-note">${account.balance === null ? 'No balance has been set.' : `Saved snapshot: ${escape(account.balanceDate)}`}</span><button class="outline-button" type="submit">Save account</button></div></form>`).join('') : '<article class="card no-results">No accounts yet. Import data or add an account.</article>';
  }
  $('account-cards').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target.closest('form[data-account-id]'); if (!form) return;
    const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try {
      const values = new FormData(form);
      await api('/api/accounts', { method: 'PATCH', body: { id: form.dataset.accountId, name: values.get('name'), role: values.get('role'), balance: integerAmount(values.get('balance')), balanceDate: values.get('balanceDate') } });
      await onChange(); toast('Account and dated balance saved.');
    } catch (error) { onError(error); button.disabled = false; }
  });
  $('add-account').addEventListener('click', () => { $('new-account-form').reset(); $('new-account-date').value = today; $('account-dialog').showModal(); });
  $('close-account-dialog').addEventListener('click', () => $('account-dialog').close());
  $('new-account-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button[type=submit]'); button.disabled = true;
    try {
      await api('/api/accounts', { method: 'POST', body: { name: $('new-account-name').value, currency: 'NOK', role: $('new-account-role').value, balance: integerAmount($('new-account-balance').value), balanceDate: $('new-account-date').value } });
      $('account-dialog').close(); await onChange(); toast('Account added to your ledger.');
    } catch (error) { onError(error); }
    finally { button.disabled = false; }
  });
  $('use-account-balances').addEventListener('click', () => onUse());
  return { setData(rows) { accounts = rows; render(); }, startingPoint() { return accountStartingPoint(accounts); } };
}
