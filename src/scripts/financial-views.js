import { renderTimeSeriesChart } from './charts.js';
import { renderStatistics } from './statistics.js';
import { accountTypes, accountRoles } from '../lib/account-values.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const groupNames = { cash: 'Available cash', reserve: 'Savings reserve', investments: 'Investments', other: 'Other tracked accounts' };
const groupColors = { cash: 'var(--chart-1)', reserve: 'var(--chart-4)', investments: 'var(--chart-3)', other: 'var(--chart-7)' };
const groupFor = account => account.accountType === 'investment' ? 'investments' : account.role === 'available' ? 'cash' : account.role === 'reserve' ? 'reserve' : 'other';
const decimal = amount => {
  if (!Number.isSafeInteger(amount)) return '';
  const absolute = BigInt(amount < 0 ? -amount : amount);
  return `${amount < 0 ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};
const exactSum = amounts => {
  if (!amounts.every(Number.isSafeInteger)) return null;
  const sum = amounts.reduce((total, value) => total + BigInt(value), 0n);
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) && sum >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(sum) : null;
};
const growthGroups = ['reserve', 'investments'];
const percent = rate => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(rate / 100);
const growthOptions = value => ({ source: value?.source === 'history' ? 'history' : 'manual', coverage: value?.coverage || null, flowKinds: value?.flowKinds || {} });

// Confirmation belongs to one exact period and account set. A later value must
// not silently extend the period the owner has reviewed.
export function sameGrowthCoverage(first, second) {
  if (!first?.complete || !second?.complete || first.from !== second.from || first.to !== second.to) return false;
  if (!Array.isArray(first.accountIds) || !Array.isArray(second.accountIds) || first.accountIds.length !== second.accountIds.length) return false;
  const expected = [...second.accountIds].sort();
  return [...first.accountIds].sort().every((id, index) => id === expected[index]);
}

export function patchAssetGrowth(current, group, patch) {
  return Object.fromEntries(growthGroups.map(key => {
    const options = growthOptions(current?.[key]);
    return [key, key === group ? { ...options, ...patch, flowKinds: patch.flowKinds ? { ...options.flowKinds, ...patch.flowKinds } : options.flowKinds } : options];
  }));
}

// The financial view is a presentation filter. Account roles stay in Accounts.
export function createFinancialViewsController({ money, exactMoney = money, dateText = value => value, onChange, onManageAccounts, onEditAssumptions }) {
  const $ = id => document.getElementById(id);
  let data = null;
  const value = amount => Number.isSafeInteger(amount) ? money(amount) : '—';
  const exact = amount => Number.isSafeInteger(amount) ? exactMoney(amount) : '—';
  const tone = amount => amount > 0 ? 'positive' : amount < 0 ? 'negative' : '';
  const movementRows = new Map(growthGroups.map(group => [group, new Map()]));

  function growthChange(group, patch) {
    error();
    onChange({ assetGrowth: patchAssetGrowth(data?.assetGrowth, group, patch) });
  }

  function effectiveGrowth(group) {
    const supplied = data.effectiveGrowth?.[group];
    if (Number.isSafeInteger(supplied)) return supplied;
    const options = growthOptions(data.assetGrowth?.[group]);
    if (options.source === 'history') return data.growthReview?.[group]?.evidence?.ready ? data.growthReview[group].evidence.annualGrowthBps : 0;
    return group === 'reserve' ? data.reserveGrowthBps || 0 : data.growthBps || 0;
  }

  function renderGrowthMovements(group, review, options) {
    const target = $(`financial-growth-movements-${group}`);
    const movements = review.movements || review.unclassified || [];
    const cached = movementRows.get(group);
    const wanted = new Set(movements.map(row => row.id));
    for (const [id, row] of cached) {
      if (!wanted.has(id)) { row.root.remove(); cached.delete(id); }
    }
    if (!movements.length) { target.hidden = true; return; }
    target.hidden = false;
    if (!target.querySelector('.financial-growth-movement-note')) {
      const note = document.createElement('p');
      note.className = 'input-note financial-growth-movement-note';
      note.textContent = 'Review external movements: deposits and withdrawals are capital. Interest, dividends and fees are investment or savings returns.';
      target.prepend(note);
    }
    for (const movement of movements) {
      let row = cached.get(movement.id);
      if (!row) {
        const root = document.createElement('label');
        root.className = 'financial-growth-movement';
        const description = document.createElement('span');
        const select = document.createElement('select');
        for (const [value, text] of [['', 'Choose movement type'], ['capital', 'Deposit or withdrawal'], ['return', 'Interest, dividend or fee']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; option.disabled = !value; select.append(option);
        }
        select.dataset.growthMovement = movement.id;
        select.dataset.growthGroup = group;
        root.append(description, select); target.append(root);
        row = { root, description, select }; cached.set(movement.id, row);
      }
      const description = `${dateText(movement.date)} · ${movement.label || 'External movement'} · ${movement.direction === 'outgoing' ? 'outgoing' : 'incoming'} ${exact(movement.amount)}`;
      row.description.textContent = description;
      row.select.setAttribute('aria-label', `Movement type: ${description}`);
      if (document.activeElement !== row.select) row.select.value = options.flowKinds[movement.id] || movement.kind || '';
    }
  }

  function renderGrowth() {
    for (const group of growthGroups) {
      const options = growthOptions(data.assetGrowth?.[group]);
      const review = data.growthReview?.[group] || {};
      const evidence = review.evidence || {};
      const source = $(`financial-growth-source-${group}`);
      if (document.activeElement !== source) source.value = options.source;
      const rateId = group === 'reserve' ? 'financial-reserve-growth' : 'financial-growth';
      inputValue(rateId, decimal(options.source === 'history' ? effectiveGrowth(group) : group === 'reserve' ? data.reserveGrowthBps || 0 : data.growthBps || 0));
      $(rateId).disabled = options.source === 'history';
      const from = evidence.from || review.candidateCoverage?.from;
      const to = evidence.to || review.candidateCoverage?.to;
      const period = from && to ? `Observed period: ${dateText(from)} to ${dateText(to)}${Number.isFinite(evidence.days) ? ` (${evidence.days} days)` : ''}. ` : '';
      let message = `${period}${evidence.ready ? 'Historical evidence is complete.' : evidence.reason || 'Record dated account values to review historical growth.'}`;
      if (evidence.ready && Number.isSafeInteger(evidence.annualGrowthBps)) {
        message += ` Cash-flow-adjusted annual rate: ${percent(evidence.annualGrowthBps)}%.`;
        if (Number.isFinite(evidence.periodRate)) message += ` Return over the observed period: ${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(evidence.periodRate * 100)}%.`;
      }
      if (options.source === 'history') message += evidence.ready ? ` Projection uses ${percent(effectiveGrowth(group))}% per year from this history.` : ' Historical growth is unavailable, so this group is held at 0% growth until the evidence is complete.';
      $(`financial-growth-evidence-${group}`).textContent = message;
      $(`financial-growth-history-${group}`).hidden = options.source !== 'history';
      const candidate = review.candidateCoverage;
      const confirmation = $(`financial-growth-coverage-${group}`);
      confirmation.checked = sameGrowthCoverage(options.coverage, candidate);
      confirmation.disabled = !candidate;
      $(`financial-growth-coverage-label-${group}`).textContent = candidate ? `All contributions and withdrawals from ${dateText(candidate.from)} to ${dateText(candidate.to)} are recorded` : 'Record at least two common dated values before confirming movement coverage';
      $(`financial-growth-confirmed-${group}`).textContent = options.coverage && !sameGrowthCoverage(options.coverage, candidate) ? `Previous confirmation covers ${dateText(options.coverage.from)} to ${dateText(options.coverage.to)}. Confirm the current period separately after reviewing its movements.` : '';
      renderGrowthMovements(group, review, options);
    }
  }

  function inputValue(id, next) {
    const input = $(id);
    if (document.activeElement !== input) input.value = next;
  }

  function error(message = '') {
    $('financial-input-error').textContent = message;
    $('financial-input-error').hidden = !message;
  }

  function decimalInput(input, { signed = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const text = input.value.trim().replace(',', '.');
    if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(text)) return null;
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
    const scaled = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n);
    return scaled >= BigInt(min) && scaled <= BigInt(max) ? Number(scaled) : null;
  }

  function statistics(id, rows) { renderStatistics($(id), rows); }
  function noChart(id, message) { $(id).innerHTML = `<p class="no-results">${esc(message)}</p>`; }
  function points() {
    if (!data.projection) return [];
    return [{ ...data.projection.start, date: data.asOf, starting: true }, ...data.projection.points];
  }
  function chart(id, plotPoints, series, title) {
    renderTimeSeriesChart($(id), { points: plotPoints, series, title, format: exactMoney, label: point => dateText(point.date), timeSpacing: true, width: $(id).clientWidth || 720 });
  }

  function renderBudget() {
    const assumptions = data.assumptions || {};
    const trending = !!data.incomeGrowth;
    const horizon = data.horizon || 3;
    const averageNote = trending ? `Monthly average over ${horizon} ${horizon === 1 ? 'month' : 'months'}. ` : '';
    const spending = exactSum([assumptions.expense, assumptions.adjustment, assumptions.plannedMonthlyExpense]);
    const suppliedNet = Number.isSafeInteger(data.monthlyCashChange) ? data.monthlyCashChange : null;
    const surplus = suppliedNet === null ? spending == null ? null : exactSum([assumptions.income, -spending]) : exactSum([suppliedNet, assumptions.saving]);
    const cashChange = suppliedNet ?? (surplus == null ? null : exactSum([surplus, -assumptions.saving]));
    const ready = data.monthlyReady && [spending, surplus, cashChange, assumptions.income, assumptions.saving].every(Number.isSafeInteger);
    statistics('financial-budget-stats', [
      { label: trending ? 'Average monthly income' : 'Regular monthly income', value: ready ? value(assumptions.income) : '—', note: `${averageNote}Recurring income in your scenario`, icon: 'income', tone: 'income' },
      { label: trending ? 'Average monthly spending & bills' : 'Monthly spending & bills', value: ready ? value(spending) : '—', note: `${averageNote}Purchases, bills and planned pot spending`, icon: 'expense', tone: 'expense' },
      { label: trending ? 'Average income minus spending' : 'Income minus spending', value: ready ? value(surplus) : '—', color: ready ? tone(surplus) : '', note: `${averageNote}Before savings and investment contributions`, icon: 'balance', tone: 'net' },
      { label: trending ? 'Average monthly contributions' : 'Savings & investment contributions', value: ready ? value(assumptions.saving) : '—', note: `${averageNote}Savings and investment transfers from everyday cash, separate from spending`, icon: 'saving', tone: 'saving' },
      { label: trending ? 'Average cash after contributions' : 'Cash after contributions', value: ready ? value(cashChange) : '—', color: ready ? tone(cashChange) : '', note: `${averageNote}Monthly cash change before the month-one expense`, icon: 'trend', tone: 'net' },
    ]);
    const message = $('financial-budget-message');
    message.classList.toggle('warning', ready && surplus < 0);
    if (!ready) message.textContent = trending && data.forecastError ? `${data.forecastError} Switch off income growth to compare the fixed monthly assumptions. No starting account balance is needed for this view.` : 'Set valid monthly income, spending and contribution assumptions below to compare your budget. No starting account balance is needed for this view.';
    else if (trending) {
      const prefix = `Monthly averages over ${horizon} ${horizon === 1 ? 'month' : 'months'}: `;
      if (surplus < 0) message.textContent = `${prefix}spending exceeds income by ${exact(-surplus)} per month. Contributions then reduce available cash by another ${exact(assumptions.saving)} per month.`;
      else if (cashChange < 0) message.textContent = `${prefix}income exceeds spending by ${exact(surplus)} per month. Planned contributions are higher than that average surplus, so everyday cash falls by ${exact(-cashChange)} per month on average.`;
      else message.textContent = `${prefix}income exceeds spending by ${exact(surplus)} per month. After planned contributions, everyday cash ${cashChange === 0 ? 'is unchanged on average' : `rises by ${exact(cashChange)} per month on average`}.`;
      if ([data.incomeRange?.first, data.incomeRange?.last].every(Number.isSafeInteger)) message.textContent += ` Projected monthly income goes from ${exact(data.incomeRange.first)} in month one to ${exact(data.incomeRange.last)} in month ${horizon}.`;
      message.textContent += ' Individual months can differ from these averages.';
    }
    else if (surplus < 0) message.textContent = `Spending exceeds regular income by ${exact(-surplus)} per month in this scenario. Contributions then reduce available cash by another ${exact(assumptions.saving)} per month.`;
    else if (cashChange < 0) message.textContent = `Regular income covers spending with ${exact(surplus)} left per month. Planned savings and investment contributions are higher than that surplus, so everyday cash falls by ${exact(-cashChange)} per month.`;
    else message.textContent = `Regular income covers spending with ${exact(surplus)} left per month. After planned contributions, everyday cash ${cashChange === 0 ? 'stays level' : `rises by ${exact(cashChange)} per month`}.`;
    if (ready && assumptions.oneOff > 0) message.textContent += ` A separate ${exact(assumptions.oneOff)} expense is applied in month one.`;
  }

  function renderLiquidity() {
    const projection = data.projection;
    const end = projection?.end;
    $('financial-use-reserve').checked = !!data.useReserve;
    statistics('financial-liquidity-stats', [
      { label: 'Projected available cash', value: projection ? value(end.cash) : '—', note: 'At the end of the selected horizon', icon: 'balance', tone: 'income' },
      { label: 'Projected reserve withdrawals', value: projection ? value(projection.totalDraw) : '—', note: data.useReserve ? 'Hypothetical transfers to maintain the cash buffer' : 'Reserve support is switched off', icon: 'saving', tone: 'saving' },
      { label: 'Remaining cash-buffer shortfall', value: projection ? value(projection.endUncovered) : '—', color: projection?.endUncovered > 0 ? 'negative' : '', note: 'Amount needed to reach your minimum cash buffer', icon: 'balance', tone: 'neutral' },
    ]);
    const message = $('financial-liquidity-message');
    message.classList.toggle('warning', !projection || projection.endUncovered > 0);
    if (!projection) {
      noChart('financial-liquidity-chart', data.forecastError || 'Choose starting balances and a balance date to project cash and reserves.');
      message.textContent = data.forecastError || 'The monthly budget above can still show income versus spending while starting balances are being completed.';
      $('financial-liquidity-table').innerHTML = '';
      return;
    }
    chart('financial-liquidity-chart', points(), [
      { key: 'cash', name: 'Available cash', color: groupColors.cash },
      { key: 'reserve', name: 'Savings reserve', color: groupColors.reserve },
    ], 'Projected available cash and savings reserve in NOK');
    const firstDraw = projection.firstDrawDate;
    message.textContent = data.useReserve ? firstDraw ? `This scenario first draws from the reserve on ${dateText(firstDraw)}. Total projected withdrawals are ${exact(projection.totalDraw)}; ${exact(end.reserve)} remains in reserve.` : 'No reserve withdrawals are needed to maintain the cash buffer over this horizon.' : 'Reserve support is off. The reserve is shown separately and everyday cash can fall below its buffer.';
    if (projection.endUncovered > 0) message.textContent += ` At the end, available cash is ${exact(projection.endUncovered)} below the cash buffer.`;
    if (data.estimateLatest) message.textContent += ' The starting point uses latest recorded values as an explicit estimate.';
    if (data.manualStartingPoint) message.textContent += ' Available cash and reserve start from your manually entered totals, which can differ from recorded account values.';
    $('financial-liquidity-table').innerHTML = `<table><caption class="sr-only">Projected cash, reserve withdrawals and buffer shortfall by month</caption><thead><tr><th scope="col">Checkpoint</th><th scope="col" class="numeric">Available cash</th><th scope="col" class="numeric">Reserve withdrawal</th><th scope="col" class="numeric">Reserve remaining</th><th scope="col" class="numeric">Buffer shortfall</th></tr></thead><tbody>${projection.points.map(point => `<tr><th scope="row">${esc(dateText(point.date))}</th><td class="numeric">${esc(exact(point.cash))}</td><td class="numeric">${esc(exact(point.reserveDraw))}</td><td class="numeric">${esc(exact(point.reserve))}</td><td class="numeric">${esc(exact(point.uncovered))}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderWealth() {
    const selected = Array.isArray(data.assetGroups) ? data.assetGroups : Object.keys(groupNames);
    const summary = data.summary || {};
    const accounts = summary.accounts || [];
    const selectedAccounts = accounts.filter(account => selected.includes(groupFor(account)));
    const missing = selectedAccounts.filter(account => account.balance == null).length;
    const undated = selectedAccounts.filter(account => account.balance != null && !account.balanceDate).length;
    const misdated = !data.estimateLatest && selectedAccounts.some(account => ['investments', 'other'].includes(groupFor(account)) && account.balance != null && account.balanceDate && account.balanceDate !== data.asOf);
    const coverageError = missing || undated ? 'Some selected accounts have no recorded value or balance date. Their known subtotal is shown, but the selected wealth projection needs those missing observations.' : misdated ? 'Selected investment or other account values do not match the scenario balance date. Record values on that date, or explicitly choose latest recorded values as an estimate in the starting-balance controls.' : '';
    const projection = coverageError ? null : data.projection;
    document.querySelectorAll('[name="financial-asset-group"]').forEach(input => { input.checked = selected.includes(input.value); });
    const starting = selected.length ? exactSum(selected.map(key => summary[key])) : 0;
    const projected = projection ? exactSum(selected.map(key => projection.end[key])) : null;
    const projectedStart = projection ? exactSum(selected.map(key => projection.start[key])) : null;
    const change = projected == null || projectedStart == null ? null : exactSum([projected, -projectedStart]);
    statistics('financial-wealth-stats', [
      { label: `${missing || undated ? 'Known recorded subtotal' : 'Latest recorded total'} · selected groups`, value: value(starting), note: missing || undated ? 'Incomplete recorded coverage; unknown values are not zero' : 'Sum of known account values; see dates below', icon: 'balance', tone: 'neutral' },
      { label: 'Projected total · selected groups', value: value(projected), note: 'At the end of the selected horizon', icon: 'saving', tone: 'saving' },
      { label: 'Projected change · selected groups', value: value(change), color: tone(change), note: 'From the scenario starting point', icon: 'trend', tone: 'net' },
    ]);
    const dates = [...new Set(selectedAccounts.filter(account => account.balance != null && account.balanceDate).map(account => account.balanceDate))].sort();
    $('financial-snapshot-note').textContent = `${selectedAccounts.length} accounts in the selected groups. ${dates.length ? dates.length === 1 ? `Recorded on ${dateText(dates[0])}.` : `Latest recorded values span ${dateText(dates[0])} to ${dateText(dates.at(-1))}; this is a mixed-date snapshot.` : 'No dated account values recorded.'}${missing ? ` ${missing} account${missing === 1 ? ' has' : 's have'} no recorded value and ${missing === 1 ? 'is' : 'are'} missing from the total.` : ''}${undated ? ` ${undated} known value${undated === 1 ? ' has' : 's have'} no recorded date.` : ''}`;
    const message = $('financial-wealth-message');
    message.classList.toggle('warning', !projection);
    if (!selected.length) {
      noChart('financial-wealth-chart', 'Select at least one asset group to see the projected total.');
      message.textContent = 'Choose which groups to display above. The cash scenario still uses the account roles set in Accounts.';
    } else if (!projection) {
      noChart('financial-wealth-chart', coverageError || data.forecastError || 'Complete the scenario starting balances to project these account groups.');
      message.textContent = `${coverageError || data.forecastError || 'The recorded account snapshot is available above; a projection needs valid starting balances.'} No historical wealth path is inferred from a single recorded value.`;
    } else {
      const wealthPoints = points().map(point => ({ ...point, selectedTotal: exactSum(selected.map(key => point[key])) }));
      chart('financial-wealth-chart', wealthPoints, [
        { key: 'selectedTotal', name: 'Selected total', color: 'var(--chart-2)' },
        ...selected.map(key => ({ key, name: groupNames[key], color: groupColors[key] })),
      ], 'Projected tracked account values in NOK');
      const growthDescription = growthGroups.map(group => {
        const rate = effectiveGrowth(group);
        const name = group === 'reserve' ? 'Savings reserve' : 'Investments';
        return rate ? `${name} uses ${percent(rate)}% annual growth (${growthOptions(data.assetGrowth?.[group]).source === 'history' ? 'cash-flow-adjusted history' : 'manual assumption'}).` : `${name} has 0% growth.`;
      }).join(' ');
      message.textContent = `${growthDescription} Contributions transfer value from cash to the chosen destination; they do not increase the combined total by themselves. Other tracked accounts stay at their starting values.`;
      if (projection.totalUnallocated > 0) message.textContent += ` ${exact(projection.totalUnallocated)} of contributions over this horizon has no tracked destination and leaves this tracked total.`;
      if (data.estimateLatest) message.textContent += ' This projection uses latest recorded balances as an explicit estimate.';
      if (data.manualStartingPoint) message.textContent += ' Projected available cash and reserve start from your manually entered totals, rather than the recorded account snapshot above.';
    }
  }

  function renderAllocation() {
    const allocation = data.allocation || {};
    inputValue('financial-reserve-contribution', decimal(allocation.reserve));
    inputValue('financial-investment-contribution', decimal(allocation.investment));
    $('financial-reset-allocation').disabled = !data.customAllocation;
    $('financial-allocation-note').textContent = `${data.customAllocation ? 'Custom allocation.' : 'Allocation from linked history.'} ${value(allocation.unallocated)} per month has no tracked destination. Unallocated contributions reduce cash and leave the tracked wealth total; link their destination or set the split if they belong to accounts you track.`;
  }

  function renderCoverage() {
    const accounts = data.summary?.accounts || [];
    $('financial-coverage-rows').innerHTML = accounts.map(account => `<tr><th scope="row">${esc(account.name)}</th><td>${esc(groupNames[groupFor(account)])}</td><td>${esc(accountTypes[account.accountType] || 'Other account')}<br /><span class="muted">${esc(accountRoles[account.role] || 'Outside cash forecast')}</span></td><td>${account.balanceDate ? esc(dateText(account.balanceDate)) : 'Not recorded'}</td><td class="numeric">${account.balance == null ? 'Unknown' : esc(exact(account.balance))}</td></tr>`).join('') || '<tr><td colspan="5">No accounts tracked yet.</td></tr>';
    const missing = accounts.filter(account => account.balance == null).length;
    $('financial-coverage-note').textContent = `${accounts.length} tracked account${accounts.length === 1 ? '' : 's'}${missing ? ` · ${missing} without a known value` : ''}. ${data.estimateLatest ? 'Using latest recorded values as an explicit estimate.' : 'A projection needs the relevant account values dated at its starting point.'}`;
  }

  function render() {
    if (!data) return;
    const view = ['budget', 'liquidity', 'wealth'].includes(data.view) ? data.view : 'budget';
    inputValue('financial-horizon', String(data.horizon || 3));
    document.querySelectorAll('[data-financial-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.financialView === view)));
    for (const id of ['budget', 'liquidity', 'wealth']) $(`financial-${id}-panel`).hidden = id !== view;
    $('financial-allocation').hidden = view === 'budget';
    $('financial-growth-assumptions').hidden = view === 'budget';
    $('financial-account-coverage').hidden = view === 'budget';
    // All panels keep current figures, so changing views cannot show stale data.
    renderBudget();
    renderAllocation();
    renderCoverage();
    renderGrowth();
    if (view === 'liquidity') renderLiquidity();
    if (view === 'wealth') renderWealth();
  }

  $('financial-views').addEventListener('click', event => {
    const button = event.target.closest('[data-financial-view]');
    if (button) { error(); onChange({ view: button.dataset.financialView }); }
    if (event.target.closest('#financial-reset-allocation')) { error(); onChange({ resetAllocation: true }); }
    if (event.target.closest('#financial-manage-accounts')) onManageAccounts();
    if (event.target.closest('#financial-edit-assumptions')) onEditAssumptions?.();
  });
  $('financial-horizon').addEventListener('change', event => { error(); onChange({ horizon: Number(event.target.value) }); });
  $('financial-use-reserve').addEventListener('change', event => { error(); onChange({ useReserve: event.target.checked }); });
  document.querySelectorAll('[name="financial-asset-group"]').forEach(input => input.addEventListener('change', () => {
    error(); onChange({ assetGroups: [...document.querySelectorAll('[name="financial-asset-group"]:checked')].map(row => row.value) });
  }));
  for (const [id, key, label] of [['financial-growth', 'growthBps', 'investment'], ['financial-reserve-growth', 'reserveGrowthBps', 'savings']]) {
    $(id).addEventListener('input', event => {
      const rate = decimalInput(event.target, { signed: true, min: -10000, max: 100000 });
      if (rate == null) { error(`Enter annual ${label} growth between −100% and 1000%, with up to two decimal places.`); return; }
      error(); onChange({ [key]: rate });
    });
  }
  for (const group of growthGroups) {
    $(`financial-growth-source-${group}`).addEventListener('change', event => growthChange(group, { source: event.target.value }));
    $(`financial-growth-coverage-${group}`).addEventListener('change', event => {
      const candidate = data?.growthReview?.[group]?.candidateCoverage;
      if (event.target.checked && !candidate) return;
      growthChange(group, { coverage: event.target.checked ? { ...candidate, accountIds: [...candidate.accountIds] } : null });
    });
    $(`financial-growth-movements-${group}`).addEventListener('change', event => {
      const input = event.target.closest('[data-growth-movement]');
      if (input && ['capital', 'return'].includes(input.value)) growthChange(group, { flowKinds: { [input.dataset.growthMovement]: input.value } });
    });
  }
  for (const [id, key] of [['financial-reserve-contribution', 'reserveContribution'], ['financial-investment-contribution', 'investmentContribution']]) {
    $(id).addEventListener('input', event => {
      const amount = decimalInput(event.target);
      if (amount == null) { error('Enter a contribution of zero or more NOK, with up to two decimal places.'); return; }
      const other = key === 'reserveContribution' ? data?.allocation?.investment : data?.allocation?.reserve;
      const total = exactSum([amount, other]);
      if (total == null || !Number.isSafeInteger(data?.assumptions?.saving) || total > data.assumptions.saving) { error('The reserve and investment allocation together cannot exceed your monthly savings and investment contributions. Change the total in the monthly assumptions below if needed.'); return; }
      error(); onChange({ [key]: amount });
    });
  }
  return { setData(next) { data = next; render(); } };
}
