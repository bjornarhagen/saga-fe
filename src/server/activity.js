import { digest } from './adapters.js';
import { applyOverrides, shiftMonth } from '../lib/engine.js';
import { classifyEndpointEvidence } from '../lib/evidence.js';
import { ValidationError } from './validation.js';

const exactNumber = value => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new ValidationError('Activity totals exceed the supported exact amount range.');
  return Number(value);
};
const safeText = value => typeof value === 'string' && value.length <= 2000 && !value.includes('\u0000') ? value : '';
const publicEndpoint = node => node ? { id: node.id, name: node.name, owned: node.owned, accountId: node.accountId, counterpartyId: node.counterpartyId, counterpartyName: node.counterpartyName || null, kind: node.kind, labelSource: node.labelSource, evidence: node.evidence || null, currency: 'NOK' } : null;
const statuses = ['active', 'all', 'confirmed', 'suggested', 'dismissed'];
const accepted = (status, filter) => filter === 'all' || (filter === 'active' ? status !== 'dismissed' : filter === 'confirmed' ? ['confirmed', 'owned'].includes(status) : status === filter);

/** Projection only: source facts, owner decisions and financial rows stay distinct. */
export function projectActivity({ transactions, overrides, accounts, accountIdentifiers, counterparties, counterpartyIdentifiers, lineage, endpointReferences = [], membershipDecisions = [] }) {
  const nodes = new Map(), accountRefs = new Map(), partyRefs = new Map(), nodeParties = new Map(), endpointAliases = new Map();
  const parties = new Map(counterparties.map(party => [party.id, party]));
  const sourceKey = (sourceId, externalId) => JSON.stringify([sourceId, externalId]);
  const addIdentifier = (node, sourceId, adapter, value) => {
    if (value && !node.identifiers.some(identifier => identifier.sourceId === sourceId && identifier.value === value)) node.identifiers.push({ sourceId, adapter, value });
  };
  for (const account of accounts) nodes.set(account.id, { ...publicEndpoint({ id: account.id, name: account.name, owned: true, accountId: account.id, counterpartyId: null, kind: 'owned-account', labelSource: 'ledger-account' }), identifiers: [] });
  for (const identifier of accountIdentifiers) {
    accountRefs.set(sourceKey(identifier.source_id, identifier.external_id), identifier.account_id);
    endpointAliases.set(`ep_${digest(JSON.stringify([identifier.source_id, 'account', identifier.external_id])).slice(0, 32)}`, identifier.account_id);
    const node = nodes.get(identifier.account_id);
    if (node) addIdentifier(node, identifier.source_id, identifier.adapter, identifier.external_id);
  }
  for (const identifier of counterpartyIdentifiers) partyRefs.set(sourceKey(identifier.source_id, identifier.external_id), identifier.counterparty_id);
  const latest = new Map(lineage.map(row => [row.transaction_id, row]));
  const external = (sourceId, adapter, identifier, name = '', counterpartyId = null, observation = {}) => {
    if (!identifier) return null;
    const knownAccount = accountRefs.get(sourceKey(sourceId, identifier));
    if (knownAccount) return nodes.get(knownAccount) || null;
    const id = `ep_${digest(JSON.stringify([sourceId, 'account', identifier])).slice(0, 32)}`;
    const partyId = counterpartyId || partyRefs.get(sourceKey(sourceId, identifier)) || null;
    const evidence = classifyEndpointEvidence({ adapter, identifier, label: name, declaredAccount: adapter !== 'norwegian-bank-csv' });
    if (!nodes.has(id)) nodes.set(id, { id, name: evidence.displayName, owned: false, accountId: null, counterpartyId: partyId, counterpartyName: parties.get(partyId)?.name || null, kind: evidence.isAccountIdentifier ? 'external-account' : evidence.kind === 'merchant-hint' ? 'merchant-hint' : 'unknown-endpoint', labelSource: evidence.kind === 'merchant-hint' ? 'provider-text' : name ? 'source-label' : 'masked-identifier', evidence, identifiers: [], reference: { id, sourceId, providerIdentifier: identifier, counterpartyId: partyId, label: '' } });
    const node = nodes.get(id);
    if (!nodeParties.has(id)) nodeParties.set(id, new Set());
    if (partyId) nodeParties.get(id).add(partyId);
    if (safeText(name)) {
      const rank = { order: Number.isSafeInteger(observation.order) ? observation.order : 0, date: observation.date || '', name };
      const current = node.labelRank;
      if (!current || rank.order > current.order || (rank.order === current.order && (rank.date > current.date || (rank.date === current.date && rank.name > current.name)))) {
        node.name = evidence.displayName; node.labelSource = 'source-label'; node.labelRank = rank; node.evidence = evidence; node.reference.label = name;
      }
    }
    addIdentifier(node, sourceId, adapter, identifier);
    return node;
  };
  const partyEndpoint = partyId => {
    if (!partyId || !parties.has(partyId)) return null;
    const id = `party_${partyId}`;
    if (!nodes.has(id)) nodes.set(id, { id, name: parties.get(partyId).name, owned: false, accountId: null, counterpartyId: partyId, counterpartyName: parties.get(partyId).name, kind: 'counterparty', labelSource: 'counterparty-metadata', evidence: { kind: 'merchant-hint', isAccountIdentifier: false, requiresConfirmation: true, reason: 'The source names a counterparty without declaring its bank account.', basis: 'counterparty-metadata', adapter: null, displayName: parties.get(partyId).name }, identifiers: [], reference: { id, sourceId: null, providerIdentifier: null, counterpartyId: partyId, label: parties.get(partyId).name } });
    const node = nodes.get(id);
    for (const identifier of counterpartyIdentifiers) if (identifier.counterparty_id === partyId) addIdentifier(node, identifier.source_id, identifier.adapter, identifier.external_id);
    return node;
  };
  // References are materialized only by owner decisions, allowing a chosen
  // endpoint to remain inspectable after later provider corrections omit it.
  for (const reference of endpointReferences) {
    if (reference.kind === 'counterparty') partyEndpoint(reference.counterparty_id);
    else external(reference.source_id, reference.adapter, reference.provider_identifier, reference.label, reference.counterparty_id);
  }
  const rows = transactions.map(transaction => {
    const source = latest.get(transaction.id); let raw = {};
    if (source) { try { raw = JSON.parse(source.raw_json); } catch { /* Missing facts remain unknown. */ } }
    let from = nodes.get(transaction.fromAccountId) || null, to = nodes.get(transaction.toAccountId) || null;
    const observation = { order: source?.importOrder, date: transaction.date };
    if (source?.adapter === 'norwegian-bank-csv') {
      from = external(source.source_id, source.adapter, safeText(raw['Fra kontonummer']), safeText(raw['Fra konto']), null, observation) || from;
      to = external(source.source_id, source.adapter, safeText(raw['Til kontonummer']), safeText(raw['Til konto']), null, observation) || to;
    } else if (source) {
      for (const side of ['from', 'to']) {
        const supplied = raw[`${side}ExternalAccount`];
        if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
          const partyId = (side === 'from' && transaction.amount > 0) || (side === 'to' && transaction.amount < 0) ? transaction.counterpartyId : null;
          const node = external(source.source_id, source.adapter, safeText(supplied.externalId).trim(), safeText(supplied.name).trim(), partyId, observation);
          if (side === 'from') from ||= node; else to ||= node;
        }
      }
    }
    const owned = nodes.get(transaction.accountId) || null;
    if (transaction.amount < 0) from ||= owned; else if (transaction.amount > 0) to ||= owned;
    if (transaction.amount < 0 && !to) to = partyEndpoint(transaction.counterpartyId);
    else if (transaction.amount > 0 && !from) from = partyEndpoint(transaction.counterpartyId);
    return { ...transaction, sourceFromEndpointId: from?.id || null, sourceToEndpointId: to?.id || null, sourceId: source?.source_id || null, sourceAdapter: source?.adapter || null };
  });
  for (const [id, partyIds] of nodeParties) {
    const node = nodes.get(id); node.counterpartyId = partyIds.size === 1 ? [...partyIds][0] : null;
    node.counterpartyName = parties.get(node.counterpartyId)?.name || null;
  }
  const decisionsByTransaction = new Map();
  for (const decision of membershipDecisions) {
    if (!decisionsByTransaction.has(decision.transactionId)) decisionsByTransaction.set(decision.transactionId, []);
    decisionsByTransaction.get(decision.transactionId).push({ ...decision, decisionEndpointId: decision.endpointId, endpointId: endpointAliases.get(decision.endpointId) || decision.endpointId });
  }
  const candidatesByTransaction = new Map();
  for (const row of rows) {
    const candidates = [];
    for (const side of ['from', 'to']) {
      const cap = side === 'from' ? 'From' : 'To', sourceId = row[`source${cap}EndpointId`];
      const source = nodes.get(sourceId) || null;
      row[`source${cap}Endpoint`] = publicEndpoint(source);
      const decisions = (decisionsByTransaction.get(row.id) || []).filter(decision => decision.side === side);
      const savedConfirmed = decisions.find(decision => decision.status === 'confirmed');
      const confirmedNode = nodes.get(savedConfirmed?.endpointId);
      const confirmedConflict = !!(savedConfirmed && ((source?.owned && savedConfirmed.endpointId !== sourceId) || (confirmedNode?.owned && savedConfirmed.endpointId !== sourceId)));
      const confirmed = confirmedConflict ? null : savedConfirmed;
      const sourceDecision = decisions.filter(decision => decision.endpointId === sourceId).sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed') || b.updatedAt.localeCompare(a.updatedAt))[0];
      // External membership decisions cannot rewrite a side which later source
      // metadata identifies as owned, or manufacture movement into a different
      // owned account after the chosen external target is promoted.
      const target = source?.owned ? source : confirmed ? confirmedNode : sourceDecision?.status === 'dismissed' ? null : source;
      const reviewRequired = confirmedConflict || !!(source?.owned && sourceDecision);
      const storedDecision = savedConfirmed || sourceDecision;
      row[`${side}EndpointId`] = target?.id || null; row[`${side}Endpoint`] = publicEndpoint(target);
      const membership = { status: source?.owned ? 'owned' : confirmed ? 'confirmed' : sourceDecision?.status === 'dismissed' ? 'dismissed' : source ? 'suggested' : 'unknown', endpointId: target?.id || sourceId, sourceEndpointId: sourceId, provenance: source?.owned ? 'source' : confirmed || sourceDecision ? 'owner' : source ? 'source' : 'none', explicit: !!storedDecision, decisionEndpointId: storedDecision?.decisionEndpointId || null, decisionStatus: storedDecision?.status || null, reviewRequired, isEffective: !!target };
      row[`${side}Membership`] = membership;
      if (source) {
        const sourceReviewDecision = sourceDecision || (source.owned && confirmedConflict ? savedConfirmed : null);
        candidates.push({ side, endpointId: sourceId, sourceEndpointId: sourceId, status: source.owned ? 'owned' : sourceDecision?.status || (confirmed && confirmed.endpointId !== sourceId ? 'dismissed' : 'suggested'), provenance: source.owned ? 'source' : sourceDecision ? 'owner' : confirmed && confirmed.endpointId !== sourceId ? 'owner-other-target' : 'source', explicit: !!sourceReviewDecision, decisionEndpointId: sourceReviewDecision?.decisionEndpointId || null, decisionStatus: sourceReviewDecision?.status || null, reviewRequired: source.owned && reviewRequired, isEffective: target?.id === sourceId });
      }
      for (const decision of decisions) if (decision.endpointId !== sourceId && nodes.has(decision.endpointId)) {
        const conflict = decision.status === 'confirmed' && confirmedConflict;
        candidates.push({ side, endpointId: decision.endpointId, sourceEndpointId: sourceId, status: conflict ? 'dismissed' : decision.status, provenance: conflict ? 'membership-conflict' : 'owner', explicit: true, decisionEndpointId: decision.decisionEndpointId, decisionStatus: decision.status, reviewRequired: conflict, isEffective: target?.id === decision.endpointId });
      }
    }
    if (!row.sourceFromEndpointId && !row.sourceToEndpointId && row.accountId && nodes.has(row.accountId)) candidates.push({ side: 'unknown', endpointId: row.accountId, sourceEndpointId: null, status: 'owned', provenance: 'source', explicit: false, isEffective: true });
    candidatesByTransaction.set(row.id, candidates);
  }
  const effective = applyOverrides(rows, overrides), effectiveById = new Map(effective.map(row => [row.id, row])), rowById = new Map(rows.map(row => [row.id, row]));
  const flowByTransaction = new Map(), flows = [], mirrored = new Map();
  const makeFlow = members => {
    const row = members.find(item => item.amount < 0) || members[0], ids = members.map(item => item.id).sort();
    const flow = { id: `flow_${digest(JSON.stringify(ids)).slice(0, 32)}`, date: row.date, amount: Math.abs(row.amount), from: row.fromEndpoint, to: row.toEndpoint, sourceFrom: row.sourceFromEndpoint, sourceTo: row.sourceToEndpoint, transactionIds: members.map(item => item.id), associatedAccountId: row.accountId || null, internal: !!(row.sourceFromEndpoint?.owned && row.sourceToEndpoint?.owned), pairedRows: members.length === 2, pairing: members.length === 2 ? 'matched-bank-export-legs' : null, description: row.description, category: effectiveById.get(row.id).category };
    flows.push(flow); for (const member of members) flowByTransaction.set(member.id, flow);
  };
  for (const row of rows) {
    if (row.sourceAdapter === 'norwegian-bank-csv' && row.amount !== 0 && row.sourceFromEndpoint?.owned && row.sourceToEndpoint?.owned) {
      const key = JSON.stringify([row.sourceId, row.date, Math.abs(row.amount), row.sourceFromEndpointId, row.sourceToEndpointId, row.currency]);
      if (!mirrored.has(key)) mirrored.set(key, { outgoing: [], incoming: [] });
      mirrored.get(key)[row.amount < 0 ? 'outgoing' : 'incoming'].push(row);
    } else makeFlow([row]);
  }
  for (const group of mirrored.values()) for (let i = 0; i < Math.max(group.outgoing.length, group.incoming.length); i++) makeFlow([group.outgoing[i], group.incoming[i]].filter(Boolean));
  flows.sort((a, b) => b.date.localeCompare(a.date));
  const detailEndpoint = node => node ? { ...publicEndpoint(node), identifiers: node.identifiers } : null;
  const clean = row => { const { sourceId, sourceAdapter, ...value } = row; return value; };
  const candidatesFor = (flow, endpointIds) => flow.transactionIds.flatMap(id => candidatesByTransaction.get(id) || []).filter(candidate => endpointIds.has(candidate.endpointId));
  const summary = (selectedFlows, endpointIds, filter = 'active', includeMonthly = false) => {
    let incoming = 0n, outgoing = 0n, incomingPayments = 0, outgoingPayments = 0, largestPayment = 0; const ids = new Set(), selected = [];
    const byMonth = new Map();
    for (const flow of selectedFlows) {
      const candidates = candidatesFor(flow, endpointIds).filter(candidate => accepted(candidate.status, filter));
      if (!candidates.length) continue;
      selected.push(flow);
      const comesIn = candidates.some(candidate => candidate.side === 'to'), goesOut = candidates.some(candidate => candidate.side === 'from');
      if (comesIn) { incoming += BigInt(flow.amount); if (flow.amount > 0) incomingPayments++; }
      if (goesOut) { outgoing += BigInt(flow.amount); if (flow.amount > 0) outgoingPayments++; }
      largestPayment = Math.max(largestPayment, flow.amount);
      if (includeMonthly) {
        const month = flow.date.slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, { month, incoming: 0, outgoing: 0, payments: 0 });
        const item = byMonth.get(month);
        item.incoming += comesIn ? flow.amount : 0;
        item.outgoing += goesOut ? flow.amount : 0;
        item.payments++;
      }
      for (const id of flow.transactionIds) ids.add(id);
    }
    const monthly = [];
    if (includeMonthly && selected.length) for (let month = selected.at(-1).date.slice(0, 7); month <= selected[0].date.slice(0, 7); month = shiftMonth(month, 1)) {
      monthly.push(byMonth.get(month) || { month, incoming: 0, outgoing: 0, payments: 0 });
    }
    return { incoming: exactNumber(incoming), outgoing: exactNumber(outgoing), net: exactNumber(incoming - outgoing), incomingPayments, outgoingPayments, largestPayment, payments: selected.length, transactionRows: ids.size, internalPayments: selected.filter(flow => flow.internal).length, firstDate: selected.at(-1)?.date || null, lastDate: selected[0]?.date || null, ...(includeMonthly ? { monthly } : {}) };
  };
  const nodeFlows = new Map([...nodes.keys()].map(id => [id, []])), nodeRows = new Map([...nodes.keys()].map(id => [id, []]));
  for (const flow of flows) for (const id of new Set(flow.transactionIds.flatMap(transactionId => (candidatesByTransaction.get(transactionId) || []).map(candidate => candidate.endpointId)))) nodeFlows.get(id)?.push(flow);
  for (const row of effective) for (const id of new Set((candidatesByTransaction.get(row.id) || []).map(candidate => candidate.endpointId))) nodeRows.get(id)?.push(row);
  const summariesFor = (id, includeMonthly = false) => Object.fromEntries(statuses.map(status => [status, summary(nodeFlows.get(id) || [], new Set([id]), status, includeMonthly)]));
  const endpointActivity = requestedId => {
    const id = endpointAliases.get(requestedId) || requestedId, node = nodes.get(id); if (!node) return null;
    const selected = nodeFlows.get(id) || [], summaries = summariesFor(id, true), totals = summaries.active;
    const activityRows = (nodeRows.get(id) || []).map(row => {
      const memberships = (candidatesByTransaction.get(row.id) || []).filter(candidate => candidate.endpointId === id);
      const flow = flowByTransaction.get(row.id), sides = new Set(memberships.map(member => member.side));
      const direction = sides.has('from') && sides.has('to') ? 'self' : sides.has('to') ? 'incoming' : sides.has('from') ? 'outgoing' : 'unknown';
      const chosen = memberships.find(item => item.status === 'confirmed') || memberships.find(item => item.status === 'owned') || memberships.find(item => item.status === 'suggested') || memberships[0];
      return { ...clean(row), flowId: flow.id, flowCategory: flow.category, flowDirection: direction, flowAmount: ['self', 'unknown'].includes(direction) ? 0 : Math.abs(row.amount) * (direction === 'incoming' ? 1 : -1), pairedRows: flow.pairedRows, memberships, membershipStatus: chosen.status, membershipSide: sides.size > 1 ? 'both' : chosen.side, membershipProvenance: chosen.provenance, membershipExplicit: chosen.explicit };
    });
    const categorySummaries = Object.fromEntries(statuses.map(status => [status, [...new Set(selected.map(flow => flow.category))].map(category => ({ category, ...summary(selected.filter(flow => flow.category === category), new Set([id]), status, true) })).filter(category => category.payments > 0)]));
    return { endpoint: detailEndpoint(node), summary: totals, summaries, categorySummaries, transactions: activityRows, flows: selected, coverage: { firstDate: selected.at(-1)?.date || null, lastDate: selected[0]?.date || null, allHistory: true }, notes: ['Totals describe imported movement, not an opening or current balance. Source suggestions are separate from account memberships confirmed by you.', 'Matched debit and credit rows of an internal bank transfer count as one payment in totals; both original transaction rows remain visible. Without bank transaction IDs, same-day same-amount transfer leg matching is inferred.'] };
  };
  return {
    rows: rows.map(clean),
    directory: () => ({ endpoints: [...nodes.values()].map(node => { const summaries = summariesFor(node.id); return { ...publicEndpoint(node), summary: summaries.active, summaries }; }).sort((a, b) => Number(b.owned) - Number(a.owned) || b.summary.payments - a.summary.payments || a.name.localeCompare(b.name)) }),
    endpointActivity,
    referenceSnapshot: id => {
      const node = nodes.get(endpointAliases.get(id) || id); if (!node || node.owned || !node.reference) return null;
      return { ...node.reference, kind: node.kind, counterpartyId: node.counterpartyId };
    },
    transactionDetail: id => {
      const original = rowById.get(id); if (!original) return null;
      return { transaction: clean(effectiveById.get(id)), original: clean(original), override: overrides[id] || {}, from: detailEndpoint(nodes.get(original.fromEndpointId)), to: detailEndpoint(nodes.get(original.toEndpointId)), sourceFrom: detailEndpoint(nodes.get(original.sourceFromEndpointId)), sourceTo: detailEndpoint(nodes.get(original.sourceToEndpointId)) };
    },
    counterpartyActivity: id => {
      const party = parties.get(id); if (!party) return null;
      const partyRows = effective.filter(row => row.counterpartyId === id || (!row.counterpartyId && (row.sourceFromEndpoint?.counterpartyId === id || row.sourceToEndpoint?.counterpartyId === id)));
      const ids = new Set(partyRows.map(row => row.id)), selected = flows.filter(flow => flow.transactionIds.some(transactionId => ids.has(transactionId)));
      const endpointIds = new Set(partyRows.flatMap(row => [row.sourceFromEndpoint, row.sourceToEndpoint].filter(node => node && !node.owned).map(node => node.id)));
      return { counterparty: { id: party.id, name: party.name }, endpoints: [...endpointIds].map(endpointId => publicEndpoint(nodes.get(endpointId))), summary: summary(selected, endpointIds), transactions: partyRows.map(clean), flows: selected, coverage: { allHistory: true } };
    }
  };
}
