import { isUncategorized, similarCategoryTransactions, decimalAmount } from '../lib/categorization.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { not_applied: 'Suggested · not applied', auto_applied: 'Auto applied · unconfirmed', user_applied: 'Chosen by you', user_rejected: 'Suggestion rejected' };

export function matchesCategoryStatus(row, status) {
  if (!status) return true;
  if (status === 'uncategorized') return isUncategorized(row);
  if (status === 'pending') return ['not_applied', 'auto_applied'].includes(row.categorySuggestion?.status);
  return row.categorySuggestion?.status === status;
}

export function categoryControls(row, expanded = false, busy = false) {
  const suggestion = row.categorySuggestion;
  if (!suggestion) return '';
  const pending = ['not_applied', 'auto_applied'].includes(suggestion.status);
  const action = (value, label) => `<button type="button" class="text-button" data-category-id="${esc(row.id)}" data-category-action="${value}" ${busy ? 'disabled' : ''}>${label}</button>`;
  return `<div class="category-suggestion ${suggestion.status}"><small>${labels[suggestion.status]}${['not_applied', 'user_rejected'].includes(suggestion.status) ? `: ${esc(suggestion.category)}` : ''}</small>${expanded ? `<p class="input-note">${esc(suggestion.reason)}${suggestion.status === 'auto_applied' ? ' Included in totals; still awaiting your confirmation.' : ''}</p>` : ''}<div class="category-suggestion-actions">${pending ? action('accept', 'Accept') + action('reject', 'Reject') : suggestion.status === 'user_rejected' ? action('accept', 'Use this category') + action('reset', 'Reset suggestion') : expanded ? action('reset', 'Reset category') : ''}</div></div>`;
}

export function createCategorizationController({ api, getTransactions, reload, notify, onError, exactMoney, dateText }) {
  let busy = false, context = null, selection = new Set(), matches = [], validRange = true;
  function renderReview(row) { $('edit-category-suggestion').innerHTML = categoryControls(row, true, busy); }
  function amountRange() {
    const minText = $('similar-min-amount').value.trim(), maxText = $('similar-max-amount').value.trim();
    const minAmount = minText ? decimalAmount(minText) : 0, maxAmount = maxText ? decimalAmount(maxText) : Number.MAX_SAFE_INTEGER;
    validRange = minAmount !== null && maxAmount !== null && maxAmount >= minAmount;
    return { minAmount, maxAmount };
  }
  function updateSelection() {
    $('similar-category-status').textContent = validRange ? `${matches.length} matches · ${selection.size} selected${$('similar-include-categorized').checked ? ' · Existing categories will be replaced on selected payments.' : ''}` : 'Enter a valid amount range with up to two decimal places.';
    $('apply-similar-category').disabled = busy || !validRange || !selection.size;
    $('apply-similar-category').textContent = `${context.status === 'user_rejected' ? 'Reject for' : 'Apply to'} ${selection.size} selected`;
  }
  function renderMatches({ selectAll = false } = {}) {
    if (!context) return;
    const range = amountRange();
    matches = validRange ? similarCategoryTransactions(context.anchor, getTransactions(), { ...context, ...range, includeCategorized: $('similar-include-categorized').checked }) : [];
    if (selectAll) selection = new Set(matches.map(row => row.id));
    else selection = new Set(matches.filter(row => selection.has(row.id)).map(row => row.id));
    $('similar-category-rows').innerHTML = matches.length ? matches.map(row => `<tr><td><input type="checkbox" data-similar-id="${esc(row.id)}" aria-label="Select ${esc(row.description)} on ${esc(dateText(row.date))}" ${selection.has(row.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}></td><td>${esc(row.description)}<small>${esc(dateText(row.date))}</small><small class="similar-mobile-category">Category: ${esc(row.category)} · ${esc(labels[row.categorySuggestion?.status] || 'Imported category')}</small></td><td>${esc(row.category)}<small>${esc(labels[row.categorySuggestion?.status] || 'Imported category')}</small></td><td class="numeric">${esc(exactMoney(row.amount))}</td></tr>`).join('') : `<tr><td colspan="4" class="no-results">${context.status === 'user_applied' && !$('similar-include-categorized').checked ? 'No eligible payments. Existing categories and user decisions are excluded by default.' : 'No matching payments in this range.'}</td></tr>`;
    updateSelection();
    for (const id of ['similar-min-amount', 'similar-max-amount', 'similar-select-all', 'similar-select-none', 'similar-refresh', 'similar-include-categorized']) $(id).disabled = busy || (id === 'similar-include-categorized' && context.status === 'user_rejected');
  }
  function offerSimilar(anchor, category, status) {
    context = { anchor, category, status };
    $('similar-category-error').textContent = '';
    $('similar-include-categorized').parentElement.hidden = status === 'user_rejected';
    $('similar-min-amount').value = ''; $('similar-max-amount').value = ''; $('similar-include-categorized').checked = false;
    const candidates = similarCategoryTransactions(anchor, getTransactions(), { ...context, includeCategorized: status === 'user_applied' });
    if (!candidates.length) { context = null; return; }
    $('similar-category-title').textContent = status === 'user_rejected' ? 'Reject similar suggestions?' : 'Apply to similar payments?';
    $('similar-category-description').textContent = `${status === 'user_rejected' ? 'Reject' : 'Use'} “${category}” for payments with ${anchor.categoryIdentity?.name || 'the same sender or receiver'}.`;
    renderMatches({ selectAll: true });
    $('similar-category-dialog').showModal();
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-category-action]');
    if (!button || busy) return;
    const row = getTransactions().find(item => item.id === button.dataset.categoryId);
    if (!row?.categorySuggestion) return;
    const category = row.categorySuggestion.category, action = button.dataset.categoryAction;
    const status = action === 'reset' ? null : action === 'accept' ? 'user_applied' : 'user_rejected';
    busy = true;
    document.querySelectorAll('[data-category-action]').forEach(control => { control.disabled = true; });
    try {
      await api('/api/categories', { method: 'PATCH', body: { transactionIds: [row.id], category, status } });
      $('edit-dialog').close();
      await reload();
      notify(status === null ? 'Category choice reset.' : status === 'user_applied' ? 'Category confirmed.' : 'Suggestion rejected.');
      if (status) offerSimilar(row, category, status);
    } catch (error) { onError(error); }
    finally { busy = false; document.querySelectorAll('[data-category-action]').forEach(control => { control.disabled = false; }); if ($('similar-category-dialog').open) renderMatches(); }
  });
  for (const id of ['close-similar-category', 'skip-similar-category']) $(id).addEventListener('click', () => $('similar-category-dialog').close());
  for (const id of ['similar-min-amount', 'similar-max-amount']) $(id).addEventListener('input', () => renderMatches({ selectAll: true }));
  $('similar-include-categorized').addEventListener('change', () => renderMatches({ selectAll: true }));
  $('similar-select-all').addEventListener('click', () => renderMatches({ selectAll: true }));
  $('similar-select-none').addEventListener('click', () => { selection.clear(); renderMatches(); });
  $('similar-refresh').addEventListener('click', async () => {
    if (busy || !context) return;
    busy = true; renderMatches();
    try {
      await reload();
      context.anchor = getTransactions().find(row => row.id === context.anchor.id) || context.anchor;
      $('similar-category-error').textContent = '';
    } catch (error) { $('similar-category-error').textContent = error.message; }
    finally { busy = false; renderMatches(); }
  });
  $('similar-category-rows').addEventListener('change', event => {
    const id = event.target.dataset.similarId;
    if (!id) return;
    if (event.target.checked) selection.add(id); else selection.delete(id);
    updateSelection();
  });
  $('apply-similar-category').addEventListener('click', async () => {
    if (busy || !context || !validRange || !selection.size) return;
    busy = true; renderMatches();
    try {
      await api('/api/categories', { method: 'PATCH', body: { transactionIds: [...selection], category: context.category, status: context.status, similarTo: context.anchor.id, ...amountRange(), includeCategorized: $('similar-include-categorized').checked } });
      $('similar-category-dialog').close();
      await reload(); notify('Selected category decisions saved.');
    } catch (error) { $('similar-category-error').textContent = error.message; }
    finally { busy = false; renderMatches(); }
  });
  return { renderReview, offerSimilar };
}
