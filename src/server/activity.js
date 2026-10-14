import { digest } from './adapters.js';
import { applyOverrides } from '../lib/engine.js';
import { ValidationError } from './validation.js';

const masked = value => value ? `••••${String(value).slice(-4)}` : '';
const exactNumber = value => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new ValidationError('Activity totals exceed the supported exact amount range.');
  return Number(value);
};
const safeText = value => typeof value === 'string' && value.length <= 2000 && !value.includes('\u0000') ? value : '';
const publicEndpoint = node => node ? { id: node.id, name: node.name, owned: node.owned, accountId: node.accountId, counterpartyId: node.counterpartyId, counterpartyName: node.counterpartyName || null, kind: node.kind, labelSource: node.labelSource, currency: 'NOK' } : null;

/** Derive browseable endpoints from existing private provider mappings/lineage.
 * This read-only projection never creates balance accounts or changes identity. */
export function projectActivity({ transactions, overrides, accounts, accountIdentifiers, counterparties, counterpartyIdentifiers, lineage }) {
  const nodes = new Map(), accountRefs = new Map(), partyRefs = new Map(), nodeParties = new Map(), endpointAliases = new Map();
  const parties = new Map(counterparties.map(party => [party.id, party]));
  const sourceKey = (sourceId, externalId) => JSON.stringify([sourceId, externalId]);
  const addIdentifier = (node, sourceId, adapter, value) => {
    if (value && !node.identifiers.some(identifier => identifier.sourceId === sourceId && identifier.value === value)) node.identifiers.push({ sourceId, adapter, value });
  };
  for (const account of accounts) nodes.set(account.id, { ...publicEndpoint({ id: account.id, name: account.name, owned: true, accountId: account.id, counterpartyId: null, kind: 'owned-account', labelSource: 'ledger-account' }), identifiers: [] });
  for (const identifier of accountIdentifiers) {
    accountRefs.set(sourceKey(identifier.source_id, identifier.external_id), identifier.account_id);
    // An identifier first seen on an external side may later be identified as
    // owned. Keep its old opaque drill-down URL usable without duplicate nodes.
    endpointAliases.set(`ep_${digest(JSON.stringify([identifier.source_id, 'account', identifier.external_id])).slice(0, 32)}`, identifier.account_id);
    const node = nodes.get(identifier.account_id);
    if (node) addIdentifier(node, identifier.source_id, identifier.adapter, identifier.external_id);
  }
  for (const identifier of counterpartyIdentifiers) partyRefs.set(sourceKey(identifier.source_id, identifier.external_id), identifier.counterparty_id);
  const latest = new Map(lineage.map(row => [row.transaction_id, row]));
  const external = (sourceId, adapter, identifier, name = '', counterpartyId = null, observation = {}) => {
    const namespace = 'account';
    if (!identifier) return null;
    const knownAccount = namespace === 'account' ? accountRefs.get(sourceKey(sourceId, identifier)) : null;
    if (knownAccount) return nodes.get(knownAccount) || null;
    const id = `ep_${digest(JSON.stringify([sourceId, namespace, identifier])).slice(0, 32)}`;
    const partyId = counterpartyId || partyRefs.get(sourceKey(sourceId, identifier)) || null;
    const partyName = parties.get(partyId)?.name;
    if (!nodes.has(id)) nodes.set(id, { id, name: safeText(name) || `External account ${masked(identifier)}`, owned: false, accountId: null, counterpartyId: partyId, counterpartyName: partyName || null, kind: 'external-account', labelSource: safeText(name) ? 'source-label' : 'masked-identifier', currency: 'NOK', identifiers: [] });
    const node = nodes.get(id);
    if (!nodeParties.has(id)) nodeParties.set(id, new Set());
    if (partyId) nodeParties.get(id).add(partyId);
    if (safeText(name)) {
      const rank = { order: Number.isSafeInteger(observation.order) ? observation.order : 0, date: observation.date || '', name };
      const current = node.labelRank;
      if (!current || rank.order > current.order || (rank.order === current.order && (rank.date > current.date || (rank.date === current.date && rank.name > current.name)))) {
        node.name = name; node.labelSource = 'source-label'; node.labelRank = rank;
      }
    }
    addIdentifier(node, sourceId, adapter, identifier);
    return node;
  };
  const partyEndpoint = (partyId, sourceId, adapter) => {
    if (!partyId || !parties.has(partyId)) return null;
    const id = `party_${partyId}`;
    if (!nodes.has(id)) nodes.set(id, { id, name: parties.get(partyId).name, owned: false, accountId: null, counterpartyId: partyId, counterpartyName: parties.get(partyId).name, kind: 'counterparty', labelSource: 'counterparty-metadata', currency: 'NOK', identifiers: [] });
    const node = nodes.get(id);
    for (const identifier of counterpartyIdentifiers) if (identifier.counterparty_id === partyId) addIdentifier(node, identifier.source_id, identifier.adapter, identifier.external_id);
    return node;
  };
  const rows = transactions.map(transaction => {
    const source = latest.get(transaction.id); let raw = {};
    if (source) { try { raw = JSON.parse(source.raw_json); } catch { /* Missing lineage does not invent endpoints. */ } }
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
    if (transaction.amount < 0 && !to) to = partyEndpoint(transaction.counterpartyId, source?.source_id, source?.adapter);
    else if (transaction.amount > 0 && !from) from = partyEndpoint(transaction.counterpartyId, source?.source_id, source?.adapter);
    return { ...transaction, fromEndpointId: from?.id || null, toEndpointId: to?.id || null, fromEndpoint: publicEndpoint(from), toEndpoint: publicEndpoint(to), sourceId: source?.source_id || null, sourceAdapter: source?.adapter || null };
  });
  // An external account may serve several parties. Its account identity is
  // still known, but one transaction's party must not become a claim about all
  // other payments through that account (for example a payment processor).
  for (const [id, partyIds] of nodeParties) {
    const node = nodes.get(id);
    node.counterpartyId = partyIds.size === 1 ? [...partyIds][0] : null;
    node.counterpartyName = parties.get(node.counterpartyId)?.name || null;
  }
  for (const row of rows) {
    row.fromEndpoint = publicEndpoint(nodes.get(row.fromEndpointId));
    row.toEndpoint = publicEndpoint(nodes.get(row.toEndpointId));
  }
  const flowByTransaction = new Map(), flows = [], mirrored = new Map();
  const makeFlow = members => {
    const representative = members.find(row => row.amount < 0) || members[0];
    const ids = members.map(row => row.id).sort();
    const flow = { id: `flow_${digest(JSON.stringify(ids)).slice(0, 32)}`, date: representative.date, amount: Math.abs(representative.amount), from: representative.fromEndpoint, to: representative.toEndpoint, transactionIds: members.map(row => row.id), associatedAccountId: representative.accountId || null, internal: !!(representative.fromEndpoint?.owned && representative.toEndpoint?.owned), pairedRows: members.length === 2, pairing: members.length === 2 ? 'matched-bank-export-legs' : null, description: representative.description };
    flows.push(flow); for (const member of members) flowByTransaction.set(member.id, flow);
  };
  for (const row of rows) {
    // Pair only the two signed ledger legs of the same-direction internal
    // bank transfer. Canonical provider IDs always remain distinct payments.
    if (row.sourceAdapter === 'norwegian-bank-csv' && row.amount !== 0 && row.fromEndpoint?.owned && row.toEndpoint?.owned ) {
      const key = JSON.stringify([row.sourceId, row.date, Math.abs(row.amount), row.fromEndpointId, row.toEndpointId, row.currency]);
      if (!mirrored.has(key)) mirrored.set(key, { outgoing: [], incoming: [] });
      mirrored.get(key)[row.amount < 0 ? 'outgoing' : 'incoming'].push(row);
    } else makeFlow([row]);
  }
  for (const group of mirrored.values()) {
    const count = Math.max(group.outgoing.length, group.incoming.length);
    for (let i = 0; i < count; i++) makeFlow([group.outgoing[i], group.incoming[i]].filter(Boolean));
  }
  flows.sort((a, b) => b.date.localeCompare(a.date));
  const effective = applyOverrides(rows, overrides);
  const effectiveById = new Map(effective.map(row => [row.id, row]));
  const rowById = new Map(rows.map(row => [row.id, row]));
  const nodeFlows = new Map([...nodes.keys()].map(id => [id, []]));
  const nodeRows = new Map([...nodes.keys()].map(id => [id, []]));
  for (const flow of flows) for (const id of new Set([flow.from?.id, flow.to?.id, !flow.from && !flow.to ? flow.associatedAccountId : null].filter(Boolean))) nodeFlows.get(id)?.push(flow);
  for (const row of effective) for (const id of new Set([row.fromEndpointId, row.toEndpointId, !row.fromEndpointId && !row.toEndpointId ? row.accountId : null].filter(Boolean))) nodeRows.get(id)?.push(row);
  const summary = selectedFlows => {
    let incoming = 0n, outgoing = 0n; const ids = new Set();
    for (const flow of selectedFlows.flows) {
      if (selectedFlows.ids.has(flow.to?.id)) incoming += BigInt(flow.amount);
      if (selectedFlows.ids.has(flow.from?.id)) outgoing += BigInt(flow.amount);
      for (const id of flow.transactionIds) ids.add(id);
    }
    return { incoming: exactNumber(incoming), outgoing: exactNumber(outgoing), net: exactNumber(incoming - outgoing), payments: selectedFlows.flows.length, transactionRows: ids.size, internalPayments: selectedFlows.flows.filter(flow => flow.internal).length, firstDate: selectedFlows.flows.at(-1)?.date || null, lastDate: selectedFlows.flows[0]?.date || null };
  };
  const detailEndpoint = node => node ? { ...publicEndpoint(node), identifiers: node.identifiers } : null;
  const endpointActivity = id => {
    id = endpointAliases.get(id) || id;
    const node = nodes.get(id); if (!node) return null;
    const selected = nodeFlows.get(id) || [], totals = summary({ ids: new Set([id]), flows: selected });
    const activityRows = (nodeRows.get(id) || []).map(row => {
      const direction = row.fromEndpointId === id && row.toEndpointId === id ? 'self' : row.toEndpointId === id ? 'incoming' : row.fromEndpointId === id ? 'outgoing' : 'unknown';
      const flow = flowByTransaction.get(row.id);
      return { ...row, flowId: flow.id, flowDirection: direction, flowAmount: ['self', 'unknown'].includes(direction) ? 0 : Math.abs(row.amount) * (direction === 'incoming' ? 1 : -1), pairedRows: flow.pairedRows };
    });
    return { endpoint: detailEndpoint(node), summary: totals, transactions: activityRows, flows: selected, coverage: { firstDate: totals.firstDate, lastDate: totals.lastDate, allHistory: true }, notes: ['Totals describe imported movement, not an opening or current balance.', 'Matched debit and credit rows of an internal bank transfer count as one payment in totals; both original transaction rows remain visible. Without bank transaction IDs, same-day same-amount transfer leg matching is inferred.'] };
  };
  return {
    rows: rows.map(({ sourceId, sourceAdapter, ...row }) => row),
    directory: () => ({ endpoints: [...nodes.values()].map(node => ({ ...publicEndpoint(node), summary: summary({ ids: new Set([node.id]), flows: nodeFlows.get(node.id) || [] }) })).sort((a, b) => Number(b.owned) - Number(a.owned) || b.summary.payments - a.summary.payments || a.name.localeCompare(b.name)) }),
    endpointActivity,
    transactionDetail: id => {
      const original = rowById.get(id); if (!original) return null;
      const clean = row => { const { sourceId, sourceAdapter, ...value } = row; return value; };
      return { transaction: clean(effectiveById.get(id)), original: clean(original), override: overrides[id] || {}, from: detailEndpoint(nodes.get(original.fromEndpointId)), to: detailEndpoint(nodes.get(original.toEndpointId)) };
    },
    counterpartyActivity: id => {
      const party = parties.get(id); if (!party) return null;
      const partyRows = effective.filter(row => row.counterpartyId === id || (!row.counterpartyId && (row.fromEndpoint?.counterpartyId === id || row.toEndpoint?.counterpartyId === id)));
      const transactionIds = new Set(partyRows.map(row => row.id));
      const endpointIds = new Set(partyRows.flatMap(row => [row.fromEndpoint, row.toEndpoint].filter(node => node && !node.owned).map(node => node.id)));
      const selected = flows.filter(flow => flow.transactionIds.some(transactionId => transactionIds.has(transactionId)));
      return { counterparty: { id: party.id, name: party.name }, endpoints: [...endpointIds].map(endpointId => publicEndpoint(nodes.get(endpointId))), summary: summary({ ids: endpointIds, flows: selected }), transactions: partyRows, flows: selected, coverage: { allHistory: true } };
    }
  };
}
