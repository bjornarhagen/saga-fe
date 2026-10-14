const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { owned: 'Your account', suggested: 'Suggested account', confirmed: 'Account confirmed by you', dismissed: 'Account dismissed', unknown: 'Account unknown' };

export function createMembershipController({ api, reloadLedger, notify, getRouteKey }) {
  let endpoints = [], busy = false, ready = true, revision = 0;
  const statusElements = () => ['account-membership-save-status', 'endpoint-membership-save-status'].map(id => document.getElementById(id)).filter(Boolean);
  function message(text) { statusElements().forEach(el => { el.textContent = text; }); }
  function updateControls() { document.querySelectorAll('[data-membership-control]').forEach(el => { el.disabled = busy || !ready; }); }
  function actions(row, node, membership) {
    if (!node || !membership?.side) return '';
    const status = membership.status, side = membership.side;
    const button = (action, text) => `<button type="button" class="outline-button" data-membership-control data-account-action="${action}" data-transaction-id="${esc(row.id)}" data-endpoint-id="${esc(action === 'reset' ? membership.decisionEndpointId || node.id : node.id)}" data-account-side="${side}" aria-label="${esc(text + ' for ' + row.description)}" ${busy || !ready ? 'disabled' : ''}>${text}</button>`;
    const explicit = membership.explicit ?? membership.provenance === 'owner';
    return `<div class="relation-actions">${!node.owned && node.evidence?.kind !== 'unknown' && status !== 'confirmed' ? button('confirmed', 'Confirm account') : ''}${!node.owned && status !== 'dismissed' ? button('dismissed', 'Dismiss account') : ''}${explicit ? button('reset', 'Reset account decision') : ''}</div>`;
  }
  function membershipNote(membership) {
    if (membership?.reviewRequired) return 'New source information conflicts with the saved decision. Review or reset the old account decision.';
    if (membership?.status === 'owned') return 'This is one of your imported balance accounts.';
    if (membership?.provenance === 'owner-other-target') return 'A different account is confirmed for this side of the payment.';
    return membership?.status === 'confirmed' ? 'Your account confirmation is saved independently of the category and payment connections.' : membership?.status === 'dismissed' ? 'The source suggestion is kept for review and excluded from this account’s active totals.' : 'Source evidence is a suggestion until you confirm this account or merchant.';
  }
  function transactionPanel(detail, endpointLink) {
    const row = detail.transaction;
    if (!row.fromMembership || !row.toMembership) return '<p class="input-note">Account confirmation could not be loaded. Refresh the ledger to try again.</p>';
    const sides = ['from', 'to'].map(side => {
      const source = row[side === 'from' ? 'sourceFromEndpoint' : 'sourceToEndpoint'] || detail[side === 'from' ? 'sourceFrom' : 'sourceTo'] || null;
      const effective = row[`${side}Endpoint`] || detail[side] || null;
      const membership = { ...(row[`${side}Membership`] || { status: source?.owned ? 'owned' : source ? 'suggested' : 'unknown', endpointId: effective?.id || source?.id }), side };
      const selected = effective || source;
      const title = side === 'from' ? 'Sender' : 'Receiver';
      const info = `<p class="membership-state ${esc(membership.status)}">${esc(labels[membership.status] || membership.status)}</p><dl><dt>Source observation</dt><dd>${source ? endpointLink(source) : 'No sender/receiver identity in the source.'}${source?.evidence?.reason ? `<small>${esc(source.evidence.reason)}</small>` : ''}</dd><dt>Current assignment</dt><dd>${effective ? endpointLink(effective) : 'Unassigned'}<small>${esc(membershipNote(membership))}</small></dd></dl>`;
      if (source?.owned || membership.status === 'owned') return `<section class="membership-side"><h3>${title}</h3>${info}${actions(row, selected, membership)}</section>`;
      const options = endpoints.filter(node => !node.owned && node.evidence?.kind !== 'unknown');
      return `<section class="membership-side"><h3>${title}</h3>${info}${actions(row, selected, membership)}<label>Assign ${title.toLowerCase()} to an external account or merchant<select id="membership-target-${side}" data-membership-control ${busy || !ready ? 'disabled' : ''}><option value="">Choose an account or merchant…</option>${options.map(node => `<option value="${esc(node.id)}" ${node.id === selected?.id ? 'selected' : ''}>${esc(node.name)}${node.kind === 'merchant-hint' ? ' · text hint' : ''}</option>`).join('')}</select></label><button type="button" class="outline-button membership-assign" data-membership-control data-account-action="assign" data-transaction-id="${esc(row.id)}" data-account-side="${side}" ${busy || !ready ? 'disabled' : ''}>Confirm selected ${title.toLowerCase()}</button></section>`;
    }).join('');
    return `<p class="input-note">Account confirmation and category are separate. Category groups follow the saved category: <strong>${esc(row.category)}</strong>. Use “Review this transaction” to change its category.</p><div class="detail-grid membership-grid">${sides}</div>`;
  }
  function accountRow(row, node) {
    const memberships = row.memberships || [{ side: row.membershipSide, status: row.membershipStatus, provenance: row.membershipProvenance }];
    if (node.owned && !memberships.some(member => member.explicit)) return '';
    return memberships.filter(member => ['from', 'to'].includes(member.side)).map(member => `<div class="account-membership-row"><small class="membership-state ${esc(member.status)}">${member.side === 'from' ? 'Sender' : 'Receiver'} · ${esc(labels[member.status] || member.status || 'Suggested account')}${member.provenance === 'owner-other-target' ? ' · confirmed elsewhere' : ''}</small>${actions(row, node, member)}</div>`).join('');
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('button[data-account-action]');
    if (!button || busy || !ready) return;
    const side = button.dataset.accountSide, transactionId = button.dataset.transactionId;
    const endpointId = button.dataset.accountAction === 'assign' ? document.getElementById('membership-target-' + side)?.value : button.dataset.endpointId;
    if (!endpointId) { notify('Choose an external account or merchant first.'); return; }
    const status = button.dataset.accountAction === 'reset' ? null : button.dataset.accountAction === 'assign' ? 'confirmed' : button.dataset.accountAction;
    const routeKey = getRouteKey();
    busy = true; revision++; updateControls(); message('Saving account confirmation…');
    let saved = false;
    try {
      await api('/api/account-memberships', { method: 'PATCH', body: { transactionId, side, endpointId, status } });
      saved = true; revision++;
      await reloadLedger();
      ready = true;
      const text = status === 'confirmed' ? 'Account confirmed. Category grouping now follows this assignment.' : status === 'dismissed' ? 'Account dismissed. Use the dismissed status filter to review it.' : 'Account decision reset. The source observation remains a suggestion.';
      message(text);
      if (getRouteKey() !== routeKey) notify('The account decision for your previous selection was saved.');
    } catch (error) {
      ready = false; revision++;
      const text = saved ? 'Account decision saved; the view could not be refreshed. Refresh the page.' : 'The account decision could not be verified. Refresh the page to check.';
      message(text); notify(text);
    } finally {
      busy = false; updateControls();
      if (getRouteKey() === routeKey) { const status = statusElements().find(el => !el.closest('.view')?.hidden); status?.setAttribute('tabindex', '-1'); status?.focus({ preventScroll: true }); }
    }
  });
  return {
    actions, accountRow, transactionPanel,
    setEndpoints(rows) { endpoints = rows; },
    version: () => revision,
    acceptRead(version) { if (version !== revision) return false; ready = true; updateControls(); return true; },
    clearMessage() { if (!busy && ready) message(''); }
  };
}
