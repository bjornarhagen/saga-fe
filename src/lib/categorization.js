const emptyCategories = new Set(['', 'uncategorized', 'ukategorisert', 'other money in']);
export const CATEGORY_STATES = Object.freeze(['not_applied', 'auto_applied', 'user_applied', 'user_rejected']);
export const isUncategorized = transaction => emptyCategories.has(String(transaction.category || '').trim().toLowerCase());

// Direction, type and currency are part of the identity: a refund or transfer
// must never teach the category of an outgoing purchase.
export function categoryIdentity(transaction) {
  if (!transaction.amount || transaction.kind === 'transfer') return null;
  const side = transaction.amount < 0 ? 'to' : 'from';
  const node = transaction[`${side}Endpoint`];
  if (!node || node.owned || node.evidence?.kind === 'unknown' || node.kind === 'unknown-endpoint') return null;
  return {
    key: JSON.stringify([node.id, Math.sign(transaction.amount), transaction.kind, transaction.currency || 'NOK']),
    name: node.name,
    strong: !!node.evidence?.isAccountIdentifier || node.kind === 'counterparty' || transaction[`${side}Membership`]?.status === 'confirmed',
  };
}

/** Learn only from imported categories and explicit user decisions. Automatic
 * applications and unaccepted suggestions never become training examples. */
export function projectCategories(transactions, overrides = {}, decisions = []) {
  const byId = new Map(), groups = new Map(), examples = new Map();
  for (const decision of decisions) {
    if (!byId.has(decision.transactionId)) byId.set(decision.transactionId, []);
    byId.get(decision.transactionId).push(decision);
  }
  for (const original of transactions) {
    const edit = overrides[original.id] || {};
    const accepted = byId.get(original.id)?.find(d => d.status === 'user_applied');
    const row = { ...original, ...edit, category: edit.category || accepted?.category || original.category };
    const identity = categoryIdentity(row);
    if (!identity || isUncategorized(row)) continue;
    // Repeated identical bank-export rows are retained in the ledger, but they
    // are one piece of evidence. Conflicting edits on those copies stay votes
    // for both categories and therefore cannot create unanimous confidence.
    const exampleKey = JSON.stringify([identity.key, original.categoryExampleKey || original.id]);
    if (!examples.has(exampleKey)) examples.set(exampleKey, { identity: identity.key, categories: new Set() });
    examples.get(exampleKey).categories.add(row.category);
  }
  for (const example of examples.values()) {
    if (!groups.has(example.identity)) groups.set(example.identity, new Map());
    const counts = groups.get(example.identity);
    for (const category of example.categories) counts.set(category, (counts.get(category) || 0) + 1);
  }
  return transactions.map(original => {
    const edit = overrides[original.id] || {}, saved = byId.get(original.id) || [];
    const accepted = saved.find(d => d.status === 'user_applied');
    const identity = categoryIdentity({ ...original, ...edit });
    const row = { ...original, categoryIdentity: identity, categorySuggestion: null };
    if (edit.category || accepted) {
      row.categorySuggestion = { category: edit.category || accepted.category, status: 'user_applied', support: 0, total: 0, reason: 'Category chosen by you.' };
      return row;
    }
    if (!isUncategorized(original) || !identity) return row;
    const counts = new Map(groups.get(identity.key) || []);
    const ownExample = examples.get(JSON.stringify([identity.key, original.categoryExampleKey || original.id]));
    for (const category of ownExample?.categories || []) counts.set(category, counts.get(category) - 1);
    const ranked = [...counts].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!ranked.length) {
      const rejected = saved.find(d => d.status === 'user_rejected');
      if (rejected) row.categorySuggestion = { category: rejected.category, status: 'user_rejected', support: 0, total: 0, reason: 'Suggestion rejected by you.' };
      return row;
    }
    const [category, support] = ranked[0], total = ranked.reduce((sum, [, count]) => sum + count, 0);
    const rejected = saved.some(d => d.category === category && d.status === 'user_rejected');
    const automatic = identity.strong && support >= 5 && support === total && !saved.some(d => d.status === 'user_rejected');
    row.categorySuggestion = {
      category, support, total, status: rejected ? 'user_rejected' : automatic ? 'auto_applied' : 'not_applied',
      reason: `${support} of ${total} categorized payments with the same ${original.amount < 0 ? 'receiver' : 'sender'} and type use this category.`,
    };
    return row;
  });
}

export function similarCategoryTransactions(anchor, transactions, { status, category, minAmount = 0, maxAmount = Number.MAX_SAFE_INTEGER, includeCategorized = false } = {}) {
  const identity = categoryIdentity(anchor);
  if (!identity) return [];
  return transactions.filter(row => {
    if (row.id === anchor.id || categoryIdentity(row)?.key !== identity.key || Math.abs(row.amount) < minAmount || Math.abs(row.amount) > maxAmount) return false;
    const suggestion = row.categorySuggestion;
    if (status === 'user_rejected') return suggestion?.category === category && ['not_applied', 'auto_applied'].includes(suggestion.status);
    return includeCategorized || (!['user_applied', 'user_rejected'].includes(suggestion?.status) && (isUncategorized(row) || suggestion?.status === 'auto_applied'));
  });
}

export function decimalAmount(value) {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}
