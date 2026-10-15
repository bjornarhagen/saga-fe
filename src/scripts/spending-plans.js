import { decimalAmount } from '../lib/categorization.js';
import { spendingPlanForecast } from '../lib/spending-plans.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decimal = amount => amount == null ? '' : `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

export function createSpendingPlanController({ api, money, today, onChange, onError, toast }) {
  const $ = id => document.getElementById(id);
  let plans = [], accounts = [], categories = [], editing = null, busy = false;
  const available = () => accounts.filter(account => account.role === 'available' && account.accountType !== 'investment');
  const exactFormat = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const exact = amount => `${exactFormat.format(amount / 100)} kr`;

  function status(detail, plan) {
    if (!detail.ready) return `<p class="spending-plan-status warning">${esc(detail.reason || 'Record an account balance to see this pot.')}</p>`;
    if (detail.review?.due) return `<p class="spending-plan-status warning">${detail.review.date > detail.asOf ? 'Review projected on' : 'Review this pot as of'} ${esc(detail.review.date)} · ${esc(exact(detail.review.balance))} is at or below your review threshold.</p>`;
    if (detail.depletionDate) return `<p class="spending-plan-status warning">Pot reaches zero on ${esc(detail.depletionDate)} at this pace. Review funding or spending before then.</p>`;
    if (!detail.review && plan.reviewAtBalance != null) return '<p class="spending-plan-status">Record a balance to evaluate your review threshold.</p>';
    if (!detail.review) return '<p class="spending-plan-status">No review threshold set.</p>';
    if (detail.trackedOnly) return '<p class="spending-plan-status">Recorded balance is above the review threshold. Set a spending pace to estimate a future review date.</p>';
    return '<p class="spending-plan-status">No review threshold reached in the projection.</p>';
  }

  function render() {
    $('spending-plan-list').innerHTML = plans.length ? plans.map((plan, index) => {
      const account = accounts.find(row => row.id === plan.accountId);
      const detail = spendingPlanForecast({ plans: [plan], accounts, asOf: account?.balanceDate, horizon: 12 }).plans[0];
      const balance = detail.balance ?? account?.balance;
      const date = detail.asOf || account?.balanceDate;
      const funding = `${exact(plan.monthlyFunding || 0)}/month${plan.topUps?.length ? ` + ${plan.topUps.length} dated top-up${plan.topUps.length === 1 ? '' : 's'}` : ''}`;
      const pace = plan.monthlySpending == null ? 'No spending pace set' : `${exact(plan.monthlySpending)}/month`;
      const points = detail.points || [];
      return `<section class="spending-plan-card" aria-labelledby="spending-plan-title-${index}"><div class="card-heading"><h3 id="spending-plan-title-${index}">${esc(account?.name || 'Account unavailable')}</h3><button type="button" class="text-button" data-spending-plan-edit="${index}">Edit pot</button></div><dl class="spending-plan-facts"><div><dt>Recorded balance</dt><dd>${balance == null ? 'Not recorded' : esc(exact(balance))}<small>${date ? `As of ${esc(date)}` : 'No balance date recorded'}</small></dd></div><div><dt>Spending category</dt><dd>${esc(plan.category)}</dd></div><div><dt>Spending pace</dt><dd>${esc(pace)}</dd></div><div><dt>Planned funding</dt><dd>${esc(funding)}</dd></div></dl>${plan.monthlySpending == null ? '<p class="input-note">Tracking the remaining pot. No future spending pace is assumed here; existing category history still feeds the main forecast.</p>' : '<p class="input-note">This pace replaces historical spending for this category in the forecast, including purchases made from another account.</p>'}${status(detail, plan)}${detail.ready && points.length ? `<details class="spending-plan-projection"><summary>View 12-month pot projection</summary><p class="input-note">From the recorded balance on ${esc(date)}. These are planned amounts, not observed balances. Monthly amounts are applied at each monthly checkpoint; spending stops when the pot runs out. Planned funding comes from other available-cash accounts included in the forecast. It adds no income and does not draw from reserves or investments.</p><div class="table-scroll"><table><caption class="sr-only">Pot projection for ${esc(account?.name || plan.category)}</caption><thead><tr><th scope="col">Date</th><th scope="col" class="numeric">Planned funding</th><th scope="col" class="numeric">Planned spending</th><th scope="col" class="numeric">Remaining</th></tr></thead><tbody>${points.map(point => `<tr><th scope="row">${esc(point.date)}</th><td class="numeric">${esc(exact(point.funding))}</td><td class="numeric">${esc(exact(point.spending))}</td><td class="numeric">${esc(exact(point.balance))}</td></tr>`).join('')}</tbody></table></div></details>` : ''}</section>`;
    }).join('') : '<p class="no-results">No spending pots tracked yet. Choose an available-cash account and the category it funds.</p>';
    $('add-spending-plan').disabled = busy || !available().some(account => !plans.some(plan => plan.accountId === account.id));
  }

  function topUpRow(topUp = { date: today, amount: null }) {
    return `<div class="spending-top-up"><label>Transfer date<input name="topUpDate" type="date" value="${esc(topUp.date)}" required /></label><label>Transfer amount in NOK<input name="topUpAmount" inputmode="decimal" value="${esc(decimal(topUp.amount))}" placeholder="0.00" required /></label><button type="button" class="text-button" data-spending-top-up-remove aria-label="Remove this planned top-up">Remove</button></div>`;
  }

  function openEditor(index = -1) {
    editing = index;
    const plan = plans[index] || { accountId: '', category: '', monthlySpending: null, monthlyFunding: 0, topUps: [], reviewAtBalance: null };
    const options = available().filter(account => account.id === plan.accountId || !plans.some(row => row.accountId === account.id));
    const invalidAccount = plan.accountId && !options.some(account => account.id === plan.accountId);
    $('spending-plan-editor').innerHTML = `<form id="spending-plan-form"><fieldset><legend>${index < 0 ? 'Track a spending pot' : 'Edit spending pot'}</legend><div class="spending-plan-fields"><label>Pot account<select name="accountId" required><option value="">Choose an available-cash account</option>${invalidAccount ? `<option value="${esc(plan.accountId)}" selected disabled>Account unavailable · choose another account</option>` : ''}${options.map(account => `<option value="${esc(account.id)}" ${account.id === plan.accountId ? 'selected' : ''}>${esc(account.name)}</option>`).join('')}</select></label><label>Spending category<input name="category" list="spending-plan-categories" value="${esc(plan.category)}" maxlength="200" required placeholder="For example: House upgrades" /><datalist id="spending-plan-categories">${categories.map(category => `<option value="${esc(category)}"></option>`).join('')}</datalist></label><label>Monthly spending pace in NOK · optional<input name="monthlySpending" inputmode="decimal" value="${esc(decimal(plan.monthlySpending))}" placeholder="Leave blank to track the pot only" /></label><label>Review when balance reaches NOK · optional<input name="reviewAtBalance" inputmode="decimal" value="${esc(decimal(plan.reviewAtBalance))}" placeholder="Leave blank for no threshold" /></label></div><p class="input-note">Use one account and one spending category per pot. A blank pace tracks the balance and keeps historical category spending in the main forecast. An explicit zero means no planned spending for this category.</p><p class="input-note">A review threshold shows a status here. You decide whether to add funding, change spending, or stop using the account.</p><div class="form-divider"></div><h3>Planned transfers into this pot</h3><label>Monthly transfer in NOK<input name="monthlyFunding" inputmode="decimal" value="${esc(decimal(plan.monthlyFunding || 0))}" placeholder="0.00" /></label><p class="input-note">Set 0 for no regular transfer. Add dated top-ups below as well, if needed. Only transfers after the recorded balance date appear in the projection. Funding must come from other available-cash accounts included in the forecast. Reserve and investment funding is outside this plan. These plans do not execute transfers, add income, or increase your total cash.</p><div id="spending-plan-top-ups">${(plan.topUps || []).map(topUpRow).join('')}</div><button id="add-spending-top-up" type="button" class="text-button">+ Add a dated top-up</button><p id="spending-plan-error" class="spending-plan-error" role="alert"></p><div class="spending-plan-actions"><button type="submit" class="primary-button">Save spending pot</button><button id="cancel-spending-plan" type="button" class="outline-button">Cancel</button>${index >= 0 ? '<button id="remove-spending-plan" type="button" class="text-button danger">Stop tracking this pot</button>' : ''}</div><p class="input-note">Stopping tracking removes this plan. The account, its balances, and its payments stay in your ledger.</p></fieldset></form>`;
    $('spending-plan-editor').hidden = false;
    $('spending-plan-form').elements.accountId.focus();
  }

  function closeEditor({ focus = true } = {}) {
    editing = null;
    $('spending-plan-editor').hidden = true;
    $('spending-plan-editor').innerHTML = '';
    if (focus) $('add-spending-plan').focus();
  }

  function amount(form, name, { optional = false, zero = false } = {}) {
    const text = form.elements[name].value.trim();
    if (!text && optional) return null;
    if (!text && zero) return 0;
    const value = decimalAmount(text);
    if (value === null) throw new Error('Enter amounts in NOK with up to two decimal places, for example 1250.50. Amounts must be zero or positive.');
    return value;
  }

  function readPlan(form) {
    const accountId = form.elements.accountId.value;
    const enteredCategory = form.elements.category.value.trim();
    const category = categories.find(value => value.toLocaleLowerCase('nb-NO') === enteredCategory.toLocaleLowerCase('nb-NO')) || enteredCategory;
    if (!available().some(account => account.id === accountId)) throw new Error('Choose an available-cash account. Investments and reserves cannot be spending pots.');
    if (!category) throw new Error('Enter the spending category this pot funds.');
    if (plans.some((plan, index) => index !== editing && plan.accountId === accountId)) throw new Error('This account already has a spending pot. Edit its existing plan.');
    if (plans.some((plan, index) => index !== editing && plan.category.toLocaleLowerCase('nb-NO') === category.toLocaleLowerCase('nb-NO'))) throw new Error('This category already has a spending pot. Choose a different category to avoid counting its plan twice.');
    const topUps = [...form.querySelectorAll('.spending-top-up')].map(row => {
      const date = row.querySelector('[name="topUpDate"]').value;
      const value = decimalAmount(row.querySelector('[name="topUpAmount"]').value.trim());
      if (!validDate(date)) throw new Error('Choose a valid date for each planned top-up.');
      if (value === null || value <= 0) throw new Error('Each planned top-up needs an amount greater than zero, with up to two decimal places.');
      return { date, amount: value };
    }).sort((a, b) => a.date.localeCompare(b.date));
    return { accountId, category, monthlySpending: amount(form, 'monthlySpending', { optional: true }), monthlyFunding: amount(form, 'monthlyFunding', { zero: true }), topUps, reviewAtBalance: amount(form, 'reviewAtBalance', { optional: true }) };
  }

  async function save(nextPlans, message) {
    busy = true;
    const fieldset = $('spending-plan-form')?.querySelector('fieldset');
    if (fieldset) fieldset.disabled = true;
    $('add-spending-plan').disabled = true;
    try {
      const result = await api('/api/settings', { method: 'PUT', body: { settings: { spendingPlans: nextPlans } } });
      plans = result.settings.spendingPlans || [];
      await onChange(plans);
      closeEditor();
      toast(message);
    } catch (error) {
      if ($('spending-plan-error')) $('spending-plan-error').textContent = error.message;
      onError(error);
    } finally {
      busy = false;
      if (fieldset?.isConnected) fieldset.disabled = false;
      render();
    }
  }

  $('add-spending-plan').addEventListener('click', () => { if (!busy) openEditor(); });
  $('spending-plan-list').addEventListener('click', event => {
    const button = event.target.closest('[data-spending-plan-edit]');
    if (button && !busy) openEditor(Number(button.dataset.spendingPlanEdit));
  });
  $('spending-plan-editor').addEventListener('click', event => {
    if (busy) return;
    if (event.target.closest('#cancel-spending-plan')) closeEditor();
    if (event.target.closest('#add-spending-top-up')) {
      $('spending-plan-top-ups').insertAdjacentHTML('beforeend', topUpRow());
      $('spending-plan-top-ups').lastElementChild.querySelector('input').focus();
    }
    const remove = event.target.closest('[data-spending-top-up-remove]');
    if (remove) {
      const row = remove.closest('.spending-top-up');
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      (next?.querySelector('input') || $('add-spending-top-up')).focus();
    }
    if (event.target.closest('#remove-spending-plan') && editing >= 0) save(plans.filter((_, index) => index !== editing), 'Spending pot tracking stopped. Your account and payments are unchanged.');
  });
  $('spending-plan-editor').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    $('spending-plan-error').textContent = '';
    try {
      const plan = readPlan(event.target);
      const nextPlans = [...plans];
      if (editing < 0) nextPlans.push(plan); else nextPlans[editing] = plan;
      save(nextPlans, 'Spending pot saved. Planned transfers do not move money at your bank.');
    } catch (error) {
      $('spending-plan-error').textContent = error.message;
    }
  });
  return { setData(data) { plans = data.plans || []; accounts = data.accounts || []; categories = data.categories || []; render(); } };
}
