// Suggestions only. Shared identities and similar descriptions never change,
// merge or remove transactions. Strength is a sort rank, not a probability.

const genericWords = new Set([
  'bank', 'transfer', 'overføring', 'overforing', 'payment', 'betaling',
  'purchase', 'varekjøp', 'kortkjøp', 'kortbetaling', 'card', 'incoming',
  'outgoing', 'salary', 'lønn', 'interest', 'renter', 'fee', 'fees', 'gebyr',
  'gebyrer', 'savings', 'sparing', 'mikrospar', 'unknown', 'ukjent', 'account',
  'konto', 'from', 'to', 'fra', 'til', 'on', 'på',
]);
const identity = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const intersects = (left, right) => [...left].some(key => right.has(key));

export function normalizePaymentDescription(value) {
  if (typeof value !== 'string') return '';
  // Keep numbers, references and branch identifiers. Removing them would turn
  // distinct merchants, recipients or invoices into the same suggestion.
  return value.normalize('NFKC').toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:varekjøp|kortkjøp|kortbetaling|card purchase|card payment)(?:\s*[:-]\s*|\s+)/u, '')
    .replace(/^[\s:;,.]+|[\s:;,.]+$/g, '')
    .replace(/\s+/g, ' ').trim();
}

function merchantDescription(transaction) {
  const description = normalizePaymentDescription(transaction.description);
  // A transfer label or account name is not a merchant identity. Use the
  // actual endpoint identities for these instead of matching their labels.
  if (transaction.kind === 'transfer' || /(?:→|->)/u.test(description)
    || /^(?:fra|til|from|to)\s*:/u.test(description)
    || /^(?:bank\s+transfer|transfer|overføring|overforing|mikrospar)\b/u.test(description)) return '';
  const words = description.match(/\p{L}+/gu) || [];
  return words.join('').length >= 3 && words.some(word => !genericWords.has(word)) ? description : '';
}

function endpoint(transaction, side) {
  const object = transaction[`${side}Endpoint`] || {};
  const endpointId = identity(transaction[`${side}EndpointId`]) || identity(object.id) || identity(transaction[`${side}EndpointKey`]);
  let accountId = identity(transaction[`${side}AccountId`]) || identity(object.accountId);
  let counterpartyId = identity(object.counterpartyId);
  const ownerSide = transaction.amount < 0 ? 'from' : transaction.amount > 0 ? 'to' : null;
  if (!accountId && side === ownerSide) accountId = identity(transaction.accountId);
  if (!accountId && side !== ownerSide && ownerSide) counterpartyId ||= identity(transaction.counterpartyId);
  const keys = new Set();
  if (endpointId) keys.add(`endpoint:${endpointId}`);
  if (accountId) keys.add(`account:${accountId}`);
  if (counterpartyId) keys.add(`counterparty:${counterpartyId}`);
  // A shared owned account alone would relate every purchase paid from it.
  // Only external endpoint identities count as a shared payment party.
  const external = !accountId && object.owned !== true;
  return { keys, endpointId, accountId, counterpartyId, external };
}

function profile(transaction) {
  const from = endpoint(transaction, 'from'), to = endpoint(transaction, 'to');
  const counterparties = new Set([identity(transaction.counterpartyId), from.counterpartyId, to.counterpartyId].filter(Boolean));
  const peers = new Set([...(from.external ? from.keys : []), ...(to.external ? to.keys : [])]);
  return { from, to, counterparties, peers, description: merchantDescription(transaction) };
}

function sameSide(left, right) {
  // A shared party can own several actual bank accounts. Do not let the
  // broader party identity erase a known, different sender/receiver route.
  if (left.accountId && right.accountId) return left.accountId === right.accountId;
  if (left.endpointId && right.endpointId) return left.endpointId === right.endpointId;
  return intersects(left.keys, right.keys);
}
function conflictingSide(left, right) { return left.keys.size > 0 && right.keys.size > 0 && !sameSide(left, right); }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

function compare(selected, transaction, left, right) {
  const sameCounterparty = intersects(left.counterparties, right.counterparties);
  const sameExternal = intersects(left.peers, right.peers);
  const sameRoute = sameSide(left.from, right.from) && sameSide(left.to, right.to);
  const reverseRoute = !sameRoute && sameSide(left.from, right.to) && sameSide(left.to, right.from);
  const sameDescription = !!left.description && left.description === right.description;
  if (!sameCounterparty && !sameExternal && !sameRoute && !reverseRoute && !sameDescription) return null;

  const conflictingRoute = conflictingSide(left.from, right.from) || conflictingSide(left.to, right.to);
  const sameFinancialValue = Number.isSafeInteger(selected.amount) && selected.amount === transaction.amount
    && (selected.currency || 'NOK') === (transaction.currency || 'NOK');
  const sameDate = validDate(selected.date) && selected.date === transaction.date;
  // A description can suggest a duplicate when route metadata is absent, but
  // a known contradictory route must never be dismissed as bank noise.
  const possibleDuplicate = sameFinancialValue && sameDate && (sameRoute || (sameDescription && !conflictingRoute));
  const reasons = [];
  if (sameCounterparty) reasons.push('Same counterparty identity');
  else if (sameExternal) reasons.push('Same external sender or receiver');
  if (sameRoute) reasons.push('Same sender and receiver');
  else if (reverseRoute) reasons.push('Same two endpoints in opposite directions');
  if (sameDescription) reasons.push('Same normalized merchant description');
  if (sameDescription && conflictingRoute && !sameRoute && !reverseRoute) reasons.push('Account route differs');
  if (possibleDuplicate) reasons.push('Same signed amount and currency', 'Same booking date');

  const relation = sameCounterparty || sameExternal ? 'counterparty' : sameRoute || reverseRoute ? 'route' : 'description';
  const rank = sameCounterparty ? 95 : sameExternal ? 92 : sameRoute ? 90 : reverseRoute ? 85 : 55;
  return {
    transaction, reasons, relation, possibleDuplicate,
    certainty: relation === 'description' ? 'description-suggestion' : 'identity-match',
    strength: rank + (possibleDuplicate ? 5 : 0),
  };
}

export function describeRelationship(selected, transaction) {
  if (!selected || !transaction || selected === transaction || (selected.id && selected.id === transaction.id)) return null;
  return compare(selected, transaction, profile(selected), profile(transaction));
}

export function relatedTransactions(selected, transactions, { mode = 'related', limit = Infinity } = {}) {
  if (!selected || !Array.isArray(transactions)) return [];
  const left = profile(selected);
  const matches = transactions.flatMap(transaction => {
    if (!transaction || selected === transaction || (selected.id && selected.id === transaction.id)) return [];
    const result = compare(selected, transaction, left, profile(transaction));
    return result && (mode !== 'duplicates' || result.possibleDuplicate) ? [result] : [];
  });
  matches.sort((a, b) => b.strength - a.strength
    || compareText(b.transaction.date, a.transaction.date)
    || compareText(a.transaction.id, b.transaction.id));
  return matches.slice(0, Number.isInteger(limit) && limit >= 0 ? limit : Infinity);
}

/** Apply saved, undirected connection decisions to the current suggestions.
 * Decisions concern a connection, never whether two financial rows are the
 * same payment. Duplicate suggestions always come from the current matcher.
 * A saved pair remains inspectable after its heuristic evidence changes. */
export function applyRelationshipDecisions(selected, transactions, decisions = [], { mode = 'related', status = 'active', limit = Infinity } = {}) {
  if (!validTransactionId(selected?.id) || !Array.isArray(transactions)) return [];
  const known = new Map(transactions.filter(row => validTransactionId(row?.id)).map(row => [row.id, row]));
  const selectedId = selected.id, saved = new Map(), conflicts = new Set();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!decision || !validTransactionId(decision.transactionId) || !validTransactionId(decision.relatedTransactionId)
      || !['confirmed', 'dismissed'].includes(decision.status) || decision.transactionId === decision.relatedTransactionId) continue;
    const otherId = decision.transactionId === selectedId ? decision.relatedTransactionId
      : decision.relatedTransactionId === selectedId ? decision.transactionId : null;
    if (!otherId || !known.has(otherId) || conflicts.has(otherId)) continue;
    // The database has one decision per pair. Ignore contradictory duplicate
    // input instead of letting array order invent an owner's preference.
    if (saved.has(otherId) && saved.get(otherId) !== decision.status) {
      saved.delete(otherId); conflicts.add(otherId);
    } else saved.set(otherId, decision.status);
  }
  const matches = new Map(relatedTransactions(selected, [...known.values()], { mode: 'related', limit: Infinity })
    .map(match => [match.transaction.id, { ...match, reasons: [...match.reasons], decisionStatus: 'suggested' }]));
  for (const [id, decisionStatus] of saved) {
    const match = matches.get(id) || {
      transaction: known.get(id), reasons: [], relation: 'manual',
      possibleDuplicate: false, certainty: 'owner-decision', strength: 0,
    };
    matches.set(id, {
      ...match, decisionStatus,
      reasons: [`Connection ${decisionStatus} by you`, ...match.reasons],
    });
  }
  const filter = ['active', 'suggested', 'confirmed', 'dismissed', 'all'].includes(status) ? status : 'active';
  const rank = { confirmed: 0, suggested: 1, dismissed: 2 };
  const results = [...matches.values()].filter(match => (mode !== 'duplicates' || match.possibleDuplicate)
    && (filter === 'all' || (filter === 'active' ? match.decisionStatus !== 'dismissed' : match.decisionStatus === filter)));
  results.sort((a, b) => rank[a.decisionStatus] - rank[b.decisionStatus] || b.strength - a.strength
    || compareText(b.transaction.date, a.transaction.date) || compareText(a.transaction.id, b.transaction.id));
  return results.slice(0, Number.isInteger(limit) && limit >= 0 ? limit : Infinity);
}

function validTransactionId(value) { return typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9_:-]{1,200}$/.test(value); }

function compareText(left, right) {
  const a = String(left || ''), b = String(right || '');
  return a < b ? -1 : a > b ? 1 : 0;
}
