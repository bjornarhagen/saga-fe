import { categoryControls } from './categorization.js';
import { applyRelationshipDecisions } from '../lib/relationships.js';
import { routeHash } from './routes.js';
import { createMembershipController } from './memberships.js';
import { renderStatistics, renderMetricCards } from './statistics.js';
import { renderTimeSeriesChart } from './charts.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const perPage = 40;
const paymentsLabel = count => `${count} payment${count === 1 ? '' : 's'}`;
const kinds = { expense: 'Spending', income: 'Money in', saving: 'Savings', transfer: 'Transfer' };
const labelSources = { 'ledger-account': 'Saved account name', 'source-label': 'Name supplied by the import', 'masked-identifier': 'Masked source identifier; name unknown', 'counterparty-metadata': 'Imported counterparty name', 'source-text': 'Merchant text hint from the import', 'provider-text': 'Merchant text hint from the import' };
const endpointType = node => node.owned ? 'My account' : node.kind === 'counterparty' ? 'External party' : node.evidence?.kind === 'merchant-hint' || node.kind === 'merchant-hint' ? 'Merchant text hint' : node.evidence?.kind === 'unknown' ? 'Unknown external identity' : 'External account';
const $ = id => document.getElementById(id);
const definition = fields => `<dl>${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${value}</dd>`).join('')}</dl>`;
const safeValue = value => esc(typeof value === 'object' && value !== null ? JSON.stringify(value) : value ?? 'Unknown');
const link = (view, id, name) => `<a class="ledger-link" href="${esc(routeHash({ view, id }))}">${esc(name)}</a>`;

export function createExplorer({ api, exactMoney, dateText, getTransactions, editTransaction, reloadLedger, notify = () => {} }) {
  let endpoints = [], endpointById = new Map(), route = null, requestGeneration = 0;
  let directoryPage = 0, endpointPage = 0, relatedPage = 0, relatedMode = 'related';
  const detailStates = new Map();
  let accountDetail = null, transactionDetail = null, decisions = [];
  let decisionVersion = 0, decisionsAvailable = false, decisionBusy = false;
  const memberships = createMembershipController({ api, reloadLedger, notify, getRouteKey: () => routeHash(route || {}) });
  const endpoint = id => endpointById.get(id);
  const endpointLink = (node, unknown = 'Unknown') => node ? link('account', node.id, node.name) : `<span class="muted">${unknown}</span>`;
  const rowRoute = row => `${endpointLink(row.fromEndpoint || endpoint(row.fromEndpointId), 'Unknown sender')} <span aria-hidden="true">→</span> ${endpointLink(row.toEndpoint || endpoint(row.toEndpointId), 'Unknown receiver')}`;
  const signed = amount => `${amount > 0 ? '+' : ''}${exactMoney(amount)}`;
  function paginate(rows, page, prefix) {
    const next = Math.max(0, Math.min(page, Math.ceil(rows.length / perPage) - 1));
    $(prefix + '-previous').disabled = next === 0;
    $(prefix + '-next').disabled = (next + 1) * perPage >= rows.length;
    $(prefix + '-page-label').textContent = rows.length ? `${next * perPage + 1}–${Math.min((next + 1) * perPage, rows.length)} of ${rows.length}` : '0 results';
    return { page: next, shown: rows.slice(next * perPage, (next + 1) * perPage) };
  }
  function renderDirectory() {
    const query = $('endpoint-search-directory').value.trim().toLocaleLowerCase();
    const scope = $('endpoint-directory-scope').value;
    const rows = endpoints.filter(node => (scope === 'all' || (scope === 'owned' ? node.owned : !node.owned)) && (!query || `${node.name} ${node.counterpartyName || ''}`.toLocaleLowerCase().includes(query)));
    const page = paginate(rows, directoryPage, 'endpoint-directory'); directoryPage = page.page;
    $('endpoint-directory-count').textContent = `${rows.length} identities`;
    $('endpoint-directory-list').innerHTML = page.shown.length ? page.shown.map(node => `<div class="endpoint-directory-item"><div class="endpoint-name">${endpointLink(node)}<small>${esc(endpointType(node))}${node.counterpartyName && node.counterpartyName !== node.name ? ` · ${esc(node.counterpartyName)}` : ''}</small></div><div class="endpoint-meta">${paymentsLabel(node.summary.payments)} · ${node.summary.transactionRows} entries<small>In ${exactMoney(node.summary.incoming)} · Out ${exactMoney(node.summary.outgoing)}</small></div></div>`).join('') : '<p class="no-results">No saved identities match these filters.</p>';
  }
  function paymentRow(row, note = '', flow = false, actions = '') {
    const amount = flow ? row.flowAmount : row.amount;
    const movement = flow ? { incoming: 'Incoming', outgoing: 'Outgoing', self: 'Between the same account', unknown: 'Direction unknown' }[row.flowDirection] : '';
    return `<tr><td>${esc(dateText(row.date))}${movement ? `<small>${movement}</small>` : ''}</td><td>${link('transaction', row.id, row.description || 'Untitled transaction')}<small>${esc(row.category)} · ${kinds[row.kind] || esc(row.kind)}</small>${note ? `<small>${note}</small>` : ''}${actions}</td><td>${rowRoute(row)}</td><td class="numeric ${amount > 0 ? 'positive' : ''}">${signed(amount)}${flow && row.amount !== amount ? `<small>Ledger entry ${signed(row.amount)}</small>` : ''}</td></tr>`;
  }
  function renderConnections() {
    document.querySelectorAll('[data-related-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.relatedMode === relatedMode)));
    $('related-status').disabled = !decisionsAvailable;
    if (!transactionDetail) {
      $('transaction-detail-related').innerHTML = ''; $('related-count').textContent = ''; $('related-page-label').textContent = '';
      $('related-previous').disabled = true; $('related-next').disabled = true;
      return;
    }
    if (!decisionsAvailable) {
      $('transaction-detail-related').innerHTML = '<tr><td colspan="4" class="no-results">Saved connection decisions are unavailable. Refresh the page to review connections.</td></tr>';
      $('related-count').textContent = 'Connection status unknown'; $('related-page-label').textContent = '';
      $('related-previous').disabled = true; $('related-next').disabled = true;
      return;
    }
    const rows = applyRelationshipDecisions(transactionDetail.transaction, getTransactions(), decisions, { mode: relatedMode, status: $('related-status').value });
    const page = paginate(rows, relatedPage, 'related'); relatedPage = page.page;
    $('related-count').textContent = `${rows.length} ${relatedMode === 'duplicates' ? 'possible duplicates' : 'related entries'} · all saved history`;
    $('transaction-detail-related').innerHTML = page.shown.length ? page.shown.map(match => {
      const status = match.decisionStatus;
      const stateLabel = { suggested: 'Suggested connection', confirmed: 'Connection confirmed by you', dismissed: 'Connection dismissed by you' }[status];
      const reasons = match.reasons.filter(reason => !['Connection confirmed by you', 'Connection dismissed by you'].includes(reason));
      const actions = [['confirmed', 'Confirm connection'], ['dismissed', 'Dismiss connection'], ['reset', 'Reset to suggestion']].filter(([action]) => action === 'reset' ? status !== 'suggested' : action !== status);
      const controls = `<div class="relation-actions">${actions.map(([action, label]) => `<button type="button" class="outline-button" data-relation-id="${esc(match.transaction.id)}" data-relation-action="${action}" aria-label="${esc(label + ' with ' + match.transaction.description)}" ${decisionBusy || !decisionsAvailable ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
      return paymentRow(match.transaction, `<span class="relation-state ${status}">${stateLabel}</span><br>${match.possibleDuplicate ? '<span class="review-tag">Possible duplicate · </span>' : ''}${reasons.length ? esc(reasons.join(' · ')) : 'Saved decision; the current rules do not suggest this pair.'}`, false, controls);
    }).join('') : '<tr><td colspan="4" class="no-results">No connections match this view and status filter.</td></tr>';
  }
  function renderTransaction() {
    const categoryPanel = $('transaction-category-assistance');
    categoryPanel.innerHTML = transactionDetail ? categoryControls(transactionDetail.transaction, true) : '';
    categoryPanel.hidden = !categoryPanel.innerHTML;
    const { transaction: row, original, override = {}, from, to, provenance = [] } = transactionDetail;
    const sourceFields = transactionDetail.sourceFields || {};
    $('transaction-detail-title').textContent = row.description || 'Transaction details.';
    $('transaction-detail-status').textContent = 'One saved ledger entry · connections use all saved history.';
    $('edit-detail-transaction').disabled = false;
    const classification = value => `${esc(kinds[value.kind] || value.kind)} · ${esc(value.category)}${value.subcategory ? ` / ${esc(value.subcategory)}` : ''}`;
    const endpointInfo = (node, side) => node ? `${endpointLink(node)}<small>${esc(endpointType(node))} · ${esc(labelSources[node.labelSource] || 'Imported identity')}</small>${node.evidence?.reason && !node.owned ? `<small>${esc(node.evidence.reason)}</small>` : ''}` : `<span class="muted">Unknown ${side}; no current account assignment.</span>`;
    $('transaction-detail-body').innerHTML = `<div class="detail-grid"><article class="card detail-info-card"><div class="card-heading"><h2>Payment</h2><span class="badge ${esc(row.kind)}">${esc(kinds[row.kind] || row.kind)}</span></div>${definition([
      ['Booked amount', `<strong class="detail-amount">${signed(row.amount)}</strong> · ${esc(row.currency || 'NOK')}`],
      ['Booking date', esc(dateText(row.date))], ['Sender', endpointInfo(from, 'sender')], ['Receiver', endpointInfo(to, 'receiver')],
      ['Recorded on', esc(row.account || 'Unknown account')], ['Source type', esc(row.type || 'Unknown')]
    ])}</article><article class="card detail-info-card"><div class="card-heading"><h2>Classification</h2></div>${definition([
      ['Current', classification(row)], ['Source classification', classification(original)],
      ['Saved correction', Object.keys(override).length ? 'A correction is saved for this entry.' : 'No correction saved.'],
      ['Forecast', row.excludeForecast ? 'Excluded from forecast averages' : row.kind === 'transfer' ? 'Internal transfer; excluded from income and spending' : 'Included when its classification and the baseline rules apply'],
      ['Review', row.review ? 'Needs your context' : 'No review flag']
    ])}<p class="input-note">Changing the classification keeps the imported payment and its identities.</p></article></div>
    <article class="card detail-info-card"><div class="card-heading"><h2>Import history</h2></div>${provenance.length ? definition(provenance.map(item => [item.importedAt?.slice(0, 10) || 'Import', `${esc(item.adapter)} · ${esc(item.filename || 'Unnamed input')} · row ${esc(item.rowNumber ?? 'unknown')}`])) : '<p class="input-note">No source row history is saved for this entry.</p>'}
    <details class="source-fields"><summary>Original source fields from the latest import</summary>${Object.keys(sourceFields).length ? definition(Object.entries(sourceFields).map(([key, value]) => [key, safeValue(value)])) : '<p class="input-note">No original fields are available.</p>'}</details></article>`;
    $('transaction-membership-body').innerHTML = memberships.transactionPanel(transactionDetail, endpointLink);
    renderConnections();
  }
  function membershipMatches(row, status) {
    const states = row.memberships || [{ status: row.membershipStatus || (accountDetail.endpoint.owned ? 'owned' : 'suggested'), isEffective: true }];
    return status === 'all' || states.some(member => status === 'active' ? member.status !== 'dismissed' && member.isEffective !== false : status === 'confirmed' ? ['confirmed', 'owned'].includes(member.status) : member.status === status);
  }
  function renderAccountGroups() {
    if (!accountDetail) return;
    const status = $('endpoint-status').value;
    const categories = accountDetail.categorySummaries?.[status] || [];
    const selected = $('endpoint-category').value;
    $('endpoint-category').innerHTML = '<option value="">All categories</option>' + categories.map(item => `<option value="${esc(item.category)}">${esc(item.category)}</option>`).join('') + (selected && !categories.some(item => item.category === selected) ? `<option value="${esc(selected)}">${esc(selected)} · 0 payments</option>` : '');
    $('endpoint-category').value = selected;
    const category = $('endpoint-category').value;
    const summary = (category ? categories.find(item => item.category === category) : accountDetail.summaries?.[status] || accountDetail.summary) || { incoming: 0, outgoing: 0, net: 0, payments: 0, transactionRows: 0 };
    const scope = `${accountDetail.endpoint.owned ? 'Recorded account' : $('endpoint-status').selectedOptions[0].textContent}${category ? ' · ' + category : ''}`;
    const monthly = summary.monthly || [];
    renderMetricCards($('account-detail-summary'), [
      { label: accountDetail.endpoint.owned ? 'Money in' : 'Paid to this recipient', value: exactMoney(summary.incoming), icon: 'income', tone: 'income', values: monthly.map(point => point.incoming) },
      { label: accountDetail.endpoint.owned ? 'Money out' : 'Received from this sender', value: exactMoney(summary.outgoing), icon: 'expense', tone: 'expense', values: monthly.map(point => point.outgoing) },
      { label: accountDetail.endpoint.owned ? 'Net movement' : 'Net paid', value: exactMoney(summary.net), icon: 'trend', tone: 'net', values: monthly.map(point => point.incoming - point.outgoing) },
      { label: 'Payments', value: String(summary.payments), icon: 'payment', note: `${summary.transactionRows} ledger entries · ${scope}` },
    ].map(item => ({ note: `${scope} · all saved dates`, trendLabel: 'Monthly movement', trendPoints: monthly, ...item })));
    renderStatistics($('account-activity-insights'), [
      { label: accountDetail.endpoint.owned ? 'Average incoming payment' : 'Average paid to recipient', value: summary.incomingPayments ? exactMoney(Math.round(summary.incoming / summary.incomingPayments)) : '—', note: `${summary.incomingPayments || 0} nonzero payments` },
      { label: accountDetail.endpoint.owned ? 'Average outgoing payment' : 'Average received from sender', value: summary.outgoingPayments ? exactMoney(Math.round(summary.outgoing / summary.outgoingPayments)) : '—', note: `${summary.outgoingPayments || 0} nonzero payments` },
      { label: 'Largest payment', value: summary.payments ? exactMoney(summary.largestPayment) : '—', note: 'Either direction · one payment counted once' },
    ].map((item, i) => ({ ...item, icon: ['income', 'expense', 'payment'][i], tone: ['income', 'expense', 'net'][i] })));
    const monthLabel = point => new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(point.month + '-01T12:00:00Z'));
    // Measure the visible card; a hidden card reports zero and produces a
    // narrow SVG that becomes oversized when stretched across a desktop.
    $('account-activity-chart-card').hidden = false;
    renderTimeSeriesChart($('account-activity-chart'), { points: monthly, series: [{ key: 'incoming', name: accountDetail.endpoint.owned ? 'Money in' : 'Paid to recipient', color: 'var(--chart-in)' }, { key: 'outgoing', name: accountDetail.endpoint.owned ? 'Money out' : 'Received from sender', color: 'var(--chart-out)' }], title: 'Monthly account or recipient activity in NOK', format: exactMoney, label: monthLabel, width: $('account-activity-chart').clientWidth, empty: 'No payments in this account confirmation and category scope.' });
    $('account-activity-statistics').hidden = false;
    $('endpoint-category-groups').innerHTML = categories.length ? categories.map(item => `<button type="button" class="endpoint-category-button" data-endpoint-category="${esc(item.category)}" aria-pressed="${item.category === category}"><span>${esc(item.category)} <small>${paymentsLabel(item.payments)}</small></span><span>${accountDetail.endpoint.owned ? 'In' : 'Paid'} ${exactMoney(item.incoming)} · ${accountDetail.endpoint.owned ? 'Out' : 'Received'} ${exactMoney(item.outgoing)}</span></button>`).join('') : '<p class="no-results">No category groups for this confirmation status.</p>';
    $('endpoint-scope-note').textContent = `${paymentsLabel(summary.payments)} · ${summary.transactionRows} ledger entries. Totals follow account confirmation and category across all saved dates. Search and direction filter the history below. ${(accountDetail.notes || []).join(' ')}`;
  }
  function renderEndpointRows() {
    if (!accountDetail) return;
    const query = $('endpoint-search').value.trim().toLocaleLowerCase(), direction = $('endpoint-direction').value;
    const status = $('endpoint-status').value, category = $('endpoint-category').value;
    const rows = accountDetail.transactions.filter(row => membershipMatches(row, status) && (!category || (row.flowCategory || row.category) === category) && (direction === 'all' || direction === row.flowDirection) && (!query || `${row.description} ${row.category} ${row.subcategory} ${row.fromEndpoint?.name || ''} ${row.toEndpoint?.name || ''}`.toLocaleLowerCase().includes(query))).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const page = paginate(rows, endpointPage, 'endpoint'); endpointPage = page.page;
    $('endpoint-count').textContent = `${rows.length} matching ledger entries`;
    $('endpoint-transactions').innerHTML = page.shown.length ? page.shown.map(row => paymentRow(row, row.pairedRows ? 'Paired internal transfer leg · totals count the two entries once' : '', true, memberships.accountRow(row, accountDetail.endpoint))).join('') : '<tr><td colspan="4" class="no-results">No saved entries match these filters.</td></tr>';
  }
  function renderEndpoint() {
    const { endpoint: node, summary, coverage = {} } = accountDetail;
    $('account-detail-title').textContent = node.name;
    $('account-detail-status').textContent = `${endpointType(node)} · ${node.evidence?.reason || labelSources[node.labelSource] || 'Imported identity'}`;
    $('endpoint-status-label').hidden = node.owned;
    $('account-detail-body').innerHTML = definition([
      ['Identity', esc(node.name)], ['Name source', esc(labelSources[node.labelSource] || 'Imported identity')],
      ...(node.evidence ? [['Source evidence', esc(node.evidence.reason)]] : []),
      ...(node.counterpartyName && node.counterpartyName !== node.name ? [['Counterparty label', esc(node.counterpartyName)]] : []),
      ...(node.owned ? [['Forecast role', esc({ available: 'Available cash', reserve: 'Savings reserve', excluded: 'Excluded' }[node.role] || 'Unknown')], ['Saved balance', node.balance == null ? 'Not set' : `${exactMoney(node.balance)} as of ${esc(node.balanceDate)}`], ['Manage balance', '<a class="ledger-link" href="#accounts">Edit in Accounts →</a>']] : []),
      ['History', coverage.firstDate || summary.firstDate ? `${esc(dateText(coverage.firstDate || summary.firstDate))} – ${esc(dateText(coverage.lastDate || summary.lastDate))}` : 'No transactions'],
      ['Active payments', `${paymentsLabel(summary.payments)} · ${summary.transactionRows} ledger entries`]
    ]) + (node.balanceHistory?.length ? `<details class="source-fields"><summary>Saved balance history (${node.balanceHistory.length})</summary>${definition(node.balanceHistory.map(snapshot => [snapshot.date, snapshot.amount == null ? 'Not set' : exactMoney(snapshot.amount)]))}</details>` : '');
    $('account-detail-identifiers').innerHTML = node.identifiers?.length ? definition(node.identifiers.map(item => [item.adapter || 'Imported source', `<code>${esc(item.value)}</code>`])) : '<p class="input-note">No source identifier is saved. This identity is tracked by its private ledger ID.</p>';
    renderAccountGroups();
    renderEndpointRows();
  }
  async function openRoute(next, { focus = false } = {}) {
    const changed = routeHash(route || {}) !== routeHash(next);
    if (changed && route?.view === 'transaction') detailStates.set(routeHash(route), { relatedPage, relatedMode, status: $('related-status').value });
    if (changed && route?.view === 'account') detailStates.set(routeHash(route), { endpointPage, search: $('endpoint-search').value, direction: $('endpoint-direction').value, category: $('endpoint-category').value, status: $('endpoint-status').value });
    route = next; const generation = ++requestGeneration;
    if (!['account', 'transaction'].includes(next.view)) return true;
    const transaction = next.view === 'transaction', prefix = transaction ? 'transaction-detail' : 'account-detail';
    if (changed) {
      const remembered = detailStates.get(routeHash(next));
      if (transaction) { relatedPage = remembered?.relatedPage || 0; relatedMode = remembered?.relatedMode || 'related'; $('related-status').value = remembered?.status || 'active'; if (decisionsAvailable && !decisionBusy) $('relation-save-status').textContent = ''; }
      else { endpointPage = remembered?.endpointPage || 0; $('endpoint-search').value = remembered?.search || ''; $('endpoint-direction').value = remembered?.direction || 'all'; $('endpoint-status').value = remembered?.status || 'active'; $('endpoint-category').innerHTML = '<option value="">All categories</option>' + (remembered?.category ? `<option value="${esc(remembered.category)}">${esc(remembered.category)}</option>` : ''); $('endpoint-category').value = remembered?.category || ''; }
      memberships.clearMessage();
    }
    $(prefix + '-status').textContent = 'Reading saved details…';
    $(prefix + '-title').textContent = transaction ? 'Transaction details.' : 'Account details.';
    $(prefix + '-body').innerHTML = '';
    if (transaction) { transactionDetail = null; $('transaction-membership-body').innerHTML = ''; $('edit-detail-transaction').disabled = true; renderConnections(); }
    else { accountDetail = null; $('account-detail-summary').innerHTML = ''; $('account-activity-insights').innerHTML = ''; $('account-activity-statistics').hidden = true; $('account-activity-chart').innerHTML = ''; $('account-activity-chart-card').hidden = true; $('account-detail-identifiers').innerHTML = ''; $('endpoint-category-groups').innerHTML = ''; $('endpoint-transactions').innerHTML = ''; $('endpoint-count').textContent = ''; $('endpoint-scope-note').textContent = ''; }
    const membershipReadVersion = memberships.version();
    try {
      const result = await api(`/api/${transaction ? 'transactions' : 'endpoints'}/${encodeURIComponent(next.id)}`);
      if (generation !== requestGeneration) return;
      if (!memberships.acceptRead(membershipReadVersion)) return openRoute(next, { focus });
      if (transaction) { transactionDetail = result; renderTransaction(); }
      else { accountDetail = result; renderEndpoint(); }
    } catch {
      if (generation !== requestGeneration) return;
      $(prefix + '-status').textContent = 'These saved details could not be found or loaded. Return to the list and refresh the ledger.';
      return false;
    }
    if (focus && generation === requestGeneration) $(prefix + '-title').focus({ preventScroll: true });
    return true;
  }
  for (const id of ['endpoint-search-directory', 'endpoint-directory-scope']) $(id).addEventListener(id.includes('search') ? 'input' : 'change', () => { directoryPage = 0; renderDirectory(); });
  for (const id of ['endpoint-search', 'endpoint-direction']) $(id).addEventListener(id.includes('search') ? 'input' : 'change', () => { endpointPage = 0; renderEndpointRows(); });
  $('account-scale').addEventListener('change', () => renderAccountGroups());
  for (const id of ['endpoint-status', 'endpoint-category']) $(id).addEventListener('change', () => { endpointPage = 0; renderAccountGroups(); renderEndpointRows(); });
  $('endpoint-category-groups').addEventListener('click', event => { const button = event.target.closest('[data-endpoint-category]'); if (!button) return; $('endpoint-category').value = $('endpoint-category').value === button.dataset.endpointCategory ? '' : button.dataset.endpointCategory; endpointPage = 0; renderAccountGroups(); renderEndpointRows(); });
  for (const [prefix, render, read, write] of [
    ['endpoint-directory', renderDirectory, () => directoryPage, value => { directoryPage = value; }],
    ['endpoint', renderEndpointRows, () => endpointPage, value => { endpointPage = value; }],
    ['related', renderConnections, () => relatedPage, value => { relatedPage = value; }]
  ]) for (const [suffix, change] of [['previous', -1], ['next', 1]]) $(prefix + '-' + suffix).addEventListener('click', () => { write(read() + change); render(); });
  document.querySelectorAll('[data-related-mode]').forEach(button => button.addEventListener('click', () => { relatedMode = button.dataset.relatedMode; relatedPage = 0; renderConnections(); }));
  $('related-status').addEventListener('change', () => { relatedPage = 0; renderConnections(); });
  $('transaction-detail-related').addEventListener('click', async event => {
    const button = event.target.closest('button[data-relation-id]');
    if (!button || !transactionDetail || decisionBusy || !decisionsAvailable) return;
    const selectedId = transactionDetail.transaction.id, relatedId = button.dataset.relationId;
    const status = button.dataset.relationAction === 'reset' ? null : button.dataset.relationAction;
    decisionBusy = true; decisionVersion++; renderConnections();
    $('relation-save-status').textContent = 'Saving your connection decision…';
    try {
      const result = await api('/api/relations', { method: 'PATCH', body: { transactionId: selectedId, relatedTransactionId: relatedId, status } });
      decisions = result.decisions; decisionsAvailable = true;
      $('relation-save-status').textContent = status === 'confirmed' ? 'Connection confirmed for both transactions.' : status === 'dismissed' ? 'Connection dismissed. Use the dismissed filter to review or undo it.' : 'Decision reset. The connection is suggested again if the matching rules still apply.';
      if (route?.view !== 'transaction' || route.id !== selectedId) $('relation-save-status').textContent = 'Your previous connection decision was saved.';
    } catch (error) {
      decisionsAvailable = false;
      const previous = route?.view !== 'transaction' || route.id !== selectedId;
      const message = `The ${previous ? 'previous connection decision' : 'save'} could not be verified. Refresh the page to check. ${error.message}`;
      $('relation-save-status').textContent = message;
      if (previous) notify(message);
    }
    finally { decisionBusy = false; decisionVersion++; renderConnections(); }
    if (route?.view === 'transaction' && route.id === selectedId) $('relation-save-status').focus({ preventScroll: true });
  });
  $('edit-detail-transaction').addEventListener('click', () => { if (transactionDetail) editTransaction(transactionDetail.transaction.id); });
  return {
    setEndpoints(rows) { endpoints = rows; endpointById = new Map(rows.map(node => [node.id, node])); memberships.setEndpoints(rows); $('endpoint-directory-status').textContent = ''; renderDirectory(); },
    directoryError() { $('endpoint-directory-status').textContent = 'The identity directory could not be loaded. Refresh the ledger to try again.'; },
    decisionVersion: () => decisionVersion,
    setDecisions(rows, expectedVersion = decisionVersion) { if (expectedVersion !== decisionVersion) return; decisions = rows; decisionsAvailable = true; if (!decisionBusy) $('relation-save-status').textContent = ''; renderConnections(); },
    decisionError(expectedVersion = decisionVersion) { if (expectedVersion !== decisionVersion) return; decisionsAvailable = false; $('relation-save-status').textContent = 'Saved connection decisions could not be loaded. Refresh the ledger before reviewing suggestions.'; renderConnections(); },
    endpointForAccount(id) { return endpoints.find(node => node.accountId === id); },
    endpointLink, openRoute,
    redrawCharts: renderAccountGroups,
    refresh() { return route ? openRoute(route) : Promise.resolve(); }
  };
}
