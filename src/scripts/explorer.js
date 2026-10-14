import { relatedTransactions } from '../lib/relationships.js';
import { routeHash } from './routes.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const perPage = 40;
const paymentsLabel = count => `${count} payment${count === 1 ? '' : 's'}`;
const kinds = { expense: 'Spending', income: 'Money in', saving: 'Savings', transfer: 'Transfer' };
const labelSources = { 'ledger-account': 'Saved account name', 'source-label': 'Name supplied by the import', 'masked-identifier': 'Masked source identifier; name unknown', 'counterparty-metadata': 'Imported counterparty name' };
const $ = id => document.getElementById(id);
const definition = fields => `<dl>${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${value}</dd>`).join('')}</dl>`;
const safeValue = value => esc(typeof value === 'object' && value !== null ? JSON.stringify(value) : value ?? 'Unknown');
const link = (view, id, name) => `<a class="ledger-link" href="${esc(routeHash({ view, id }))}">${esc(name)}</a>`;

export function createExplorer({ api, exactMoney, dateText, getTransactions, editTransaction }) {
  let endpoints = [], endpointById = new Map(), route = null, requestGeneration = 0;
  let directoryPage = 0, endpointPage = 0, relatedPage = 0, relatedMode = 'related';
  const detailStates = new Map();
  let accountDetail = null, transactionDetail = null, connections = [];
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
    $('endpoint-directory-list').innerHTML = page.shown.length ? page.shown.map(node => `<div class="endpoint-directory-item"><div class="endpoint-name">${endpointLink(node)}<small>${node.owned ? 'My account' : node.kind === 'counterparty' ? 'External party' : 'External account'}${node.counterpartyName && node.counterpartyName !== node.name ? ` · ${esc(node.counterpartyName)}` : ''}</small></div><div class="endpoint-meta">${paymentsLabel(node.summary.payments)} · ${node.summary.transactionRows} entries<small>In ${exactMoney(node.summary.incoming)} · Out ${exactMoney(node.summary.outgoing)}</small></div></div>`).join('') : '<p class="no-results">No saved identities match these filters.</p>';
  }
  function paymentRow(row, note = '', flow = false) {
    const amount = flow ? row.flowAmount : row.amount;
    const movement = flow ? { incoming: 'Incoming', outgoing: 'Outgoing', self: 'Between the same account', unknown: 'Direction unknown' }[row.flowDirection] : '';
    return `<tr><td>${esc(dateText(row.date))}${movement ? `<small>${movement}</small>` : ''}</td><td>${link('transaction', row.id, row.description || 'Untitled transaction')}<small>${esc(row.category)} · ${kinds[row.kind] || esc(row.kind)}</small>${note ? `<small>${note}</small>` : ''}</td><td>${rowRoute(row)}</td><td class="numeric ${amount > 0 ? 'positive' : ''}">${signed(amount)}${flow && row.amount !== amount ? `<small>Ledger entry ${signed(row.amount)}</small>` : ''}</td></tr>`;
  }
  function renderConnections() {
    document.querySelectorAll('[data-related-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.relatedMode === relatedMode)));
    const rows = relatedMode === 'duplicates' ? connections.filter(match => match.possibleDuplicate) : connections;
    const page = paginate(rows, relatedPage, 'related'); relatedPage = page.page;
    $('related-count').textContent = `${rows.length} ${relatedMode === 'duplicates' ? 'possible duplicates' : 'related entries'} · all saved history`;
    $('transaction-detail-related').innerHTML = page.shown.length ? page.shown.map(match => paymentRow(match.transaction, `${match.possibleDuplicate ? '<span class="review-tag">Possible duplicate · </span>' : ''}${esc(match.reasons.join(' · '))}`)).join('') : `<tr><td colspan="4" class="no-results">${relatedMode === 'duplicates' ? 'No possible duplicates found by these rules.' : 'No related payments found in the saved history.'}</td></tr>`;
  }
  function renderTransaction() {
    const { transaction: row, original, override = {}, from, to, provenance = [] } = transactionDetail;
    const sourceFields = transactionDetail.sourceFields || {};
    $('transaction-detail-title').textContent = row.description || 'Transaction details.';
    $('transaction-detail-status').textContent = 'One saved ledger entry · connections use all saved history.';
    $('edit-detail-transaction').disabled = false;
    const classification = value => `${esc(kinds[value.kind] || value.kind)} · ${esc(value.category)}${value.subcategory ? ` / ${esc(value.subcategory)}` : ''}`;
    const endpointInfo = (node, side) => node ? `${endpointLink(node)}<small>${node.owned ? 'My account' : 'External sender/receiver'} · ${esc(labelSources[node.labelSource] || 'Imported identity')}</small>${node.counterpartyName && node.counterpartyName !== node.name ? `<small>Counterparty label: ${esc(node.counterpartyName)}</small>` : ''}` : `<span class="muted">Unknown ${side}; no identity saved in the source.</span>`;
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
    connections = relatedTransactions(row, getTransactions(), { mode: 'all', limit: Infinity });
    renderConnections();
  }
  function renderEndpointRows() {
    if (!accountDetail) return;
    const query = $('endpoint-search').value.trim().toLocaleLowerCase(), direction = $('endpoint-direction').value;
    const rows = accountDetail.transactions.filter(row => (direction === 'all' || direction === row.flowDirection) && (!query || `${row.description} ${row.category} ${row.subcategory} ${row.fromEndpoint?.name || ''} ${row.toEndpoint?.name || ''}`.toLocaleLowerCase().includes(query))).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const page = paginate(rows, endpointPage, 'endpoint'); endpointPage = page.page;
    $('endpoint-count').textContent = `${rows.length} matching ledger entries`;
    $('endpoint-transactions').innerHTML = page.shown.length ? page.shown.map(row => paymentRow(row, row.pairedRows ? 'Paired internal transfer leg · totals count the two entries once' : '', true)).join('') : '<tr><td colspan="4" class="no-results">No saved entries match these filters.</td></tr>';
  }
  function renderEndpoint() {
    const { endpoint: node, summary, notes = [] } = accountDetail;
    $('account-detail-title').textContent = node.name;
    $('account-detail-status').textContent = `${node.owned ? 'My account' : node.kind === 'counterparty' ? 'External party' : 'External account'} · ${labelSources[node.labelSource] || 'Imported identity'}`;
    $('account-detail-summary').innerHTML = [['Money in', summary.incoming], ['Money out', summary.outgoing], ['Net movement', summary.net]].map(([label, amount]) => `<article class="metric"><div class="metric-label">${label}</div><div class="metric-value">${exactMoney(amount)}</div><div class="metric-note">All saved history · NOK</div></article>`).join('');
    $('account-detail-body').innerHTML = definition([
      ['Identity', esc(node.name)], ['Name source', esc(labelSources[node.labelSource] || 'Imported identity')],
      ...(node.counterpartyName && node.counterpartyName !== node.name ? [['Counterparty label', esc(node.counterpartyName)]] : []),
      ...(node.owned ? [['Forecast role', esc({ available: 'Available cash', reserve: 'Savings reserve', excluded: 'Excluded' }[node.role] || 'Unknown')], ['Saved balance', node.balance == null ? 'Not set' : `${exactMoney(node.balance)} as of ${esc(node.balanceDate)}`], ['Manage balance', '<a class="ledger-link" href="#accounts">Edit in Accounts →</a>']] : []),
      ['History', summary.firstDate ? `${esc(dateText(summary.firstDate))} – ${esc(dateText(summary.lastDate))}` : 'No transactions'],
      ['Payments', `${paymentsLabel(summary.payments)} · ${summary.transactionRows} ledger entries`]
    ]) + (node.balanceHistory?.length ? `<details class="source-fields"><summary>Saved balance history (${node.balanceHistory.length})</summary>${definition(node.balanceHistory.map(snapshot => [snapshot.date, snapshot.amount == null ? 'Not set' : exactMoney(snapshot.amount)]))}</details>` : '');
    $('account-detail-identifiers').innerHTML = node.identifiers?.length ? definition(node.identifiers.map(item => [item.adapter || 'Imported source', `<code>${esc(item.value)}</code>`])) : '<p class="input-note">No source identifier is saved. This identity is tracked by its private ledger ID.</p>';
    $('endpoint-scope-note').textContent = `${paymentsLabel(summary.payments)} across all saved history. ${notes.join(' ')} Amounts in this table follow the direction for this account; the signed source entry is also shown when it differs.`;
    renderEndpointRows();
  }
  async function openRoute(next, { focus = false } = {}) {
    const changed = routeHash(route || {}) !== routeHash(next);
    if (changed && route?.view === 'transaction') detailStates.set(routeHash(route), { relatedPage, relatedMode });
    if (changed && route?.view === 'account') detailStates.set(routeHash(route), { endpointPage, search: $('endpoint-search').value, direction: $('endpoint-direction').value });
    route = next; const generation = ++requestGeneration;
    if (!['account', 'transaction'].includes(next.view)) return;
    const transaction = next.view === 'transaction', prefix = transaction ? 'transaction-detail' : 'account-detail';
    if (changed) {
      const remembered = detailStates.get(routeHash(next));
      if (transaction) { relatedPage = remembered?.relatedPage || 0; relatedMode = remembered?.relatedMode || 'related'; }
      else { endpointPage = remembered?.endpointPage || 0; $('endpoint-search').value = remembered?.search || ''; $('endpoint-direction').value = remembered?.direction || 'all'; }
    }
    $(prefix + '-status').textContent = 'Reading saved details…';
    $(prefix + '-title').textContent = transaction ? 'Transaction details.' : 'Account details.';
    $(prefix + '-body').innerHTML = '';
    if (transaction) { transactionDetail = null; connections = []; $('edit-detail-transaction').disabled = true; const rememberedPage = relatedPage; renderConnections(); relatedPage = rememberedPage; $('related-count').textContent = ''; }
    else { accountDetail = null; $('account-detail-summary').innerHTML = ''; $('account-detail-identifiers').innerHTML = ''; $('endpoint-transactions').innerHTML = ''; $('endpoint-count').textContent = ''; $('endpoint-scope-note').textContent = ''; }
    try {
      const result = await api(`/api/${transaction ? 'transactions' : 'endpoints'}/${encodeURIComponent(next.id)}`);
      if (generation !== requestGeneration) return;
      if (transaction) { transactionDetail = result; renderTransaction(); }
      else { accountDetail = result; renderEndpoint(); }
    } catch {
      if (generation !== requestGeneration) return;
      $(prefix + '-status').textContent = 'These saved details could not be found or loaded. Return to the list and refresh the ledger.';
    }
    if (focus && generation === requestGeneration) $(prefix + '-title').focus({ preventScroll: true });
  }
  for (const id of ['endpoint-search-directory', 'endpoint-directory-scope']) $(id).addEventListener(id.includes('search') ? 'input' : 'change', () => { directoryPage = 0; renderDirectory(); });
  for (const id of ['endpoint-search', 'endpoint-direction']) $(id).addEventListener(id.includes('search') ? 'input' : 'change', () => { endpointPage = 0; renderEndpointRows(); });
  for (const [prefix, render, read, write] of [
    ['endpoint-directory', renderDirectory, () => directoryPage, value => { directoryPage = value; }],
    ['endpoint', renderEndpointRows, () => endpointPage, value => { endpointPage = value; }],
    ['related', renderConnections, () => relatedPage, value => { relatedPage = value; }]
  ]) for (const [suffix, change] of [['previous', -1], ['next', 1]]) $(prefix + '-' + suffix).addEventListener('click', () => { write(read() + change); render(); });
  document.querySelectorAll('[data-related-mode]').forEach(button => button.addEventListener('click', () => { relatedMode = button.dataset.relatedMode; relatedPage = 0; renderConnections(); }));
  $('edit-detail-transaction').addEventListener('click', () => { if (transactionDetail) editTransaction(transactionDetail.transaction.id); });
  return {
    setEndpoints(rows) { endpoints = rows; endpointById = new Map(rows.map(node => [node.id, node])); $('endpoint-directory-status').textContent = ''; renderDirectory(); },
    directoryError() { $('endpoint-directory-status').textContent = 'The identity directory could not be loaded. Refresh the ledger to try again.'; },
    endpointForAccount(id) { return endpoints.find(node => node.accountId === id); },
    endpointLink, openRoute,
    refresh() { return route ? openRoute(route) : Promise.resolve(); }
  };
}
