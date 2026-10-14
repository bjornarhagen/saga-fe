import { createHash } from 'node:crypto';
import { csvRows, parseExport } from '../lib/engine.js';
import * as v from './validation.js';

export const digest = value => createHash('sha256').update(value).digest('hex');
const legacyHash = value => { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); };
export const adapters = [{ id: 'norwegian-bank-csv', name: 'Norwegian bank CSV', version: 1 }, { id: 'canonical-v1', name: 'Canonical transactions and metadata', version: 1 }];

function bankCSV(content) {
  if (typeof content !== 'string' || !content.length || Buffer.byteLength(content) > 25 * 1024 * 1024) throw new v.ValidationError('The CSV must contain text and be at most 25 MiB.');
  let parsed, rows;
  try { parsed = parseExport(content); rows = csvRows(content); } catch { throw new v.ValidationError('The CSV is invalid. Check its Norwegian bank columns, amounts, dates, and quoted fields.'); }
  const [headers, ...values] = rows;
  if (new Set(headers).size !== headers.length) throw new v.ValidationError('CSV column names must be unique.');
  const raw = values.map(value => Object.fromEntries(headers.map((header, i) => [header, value[i]])));
  const accounts = new Map();
  for (const row of raw) for (const side of ['Fra', 'Til']) if (row[`${side} konto`] && row[`${side} kontonummer`]) accounts.set(row[`${side} kontonummer`], { externalId: row[`${side} kontonummer`], name: row[`${side} konto`], currency: 'NOK' });
  // Match the parser's stable date sort by row position. Its legacy IDs use a
  // 32-bit hash, so indexing by ID could silently select the wrong row on a collision.
  const sortedIndices = raw.map((_, index) => index).sort((a, b) => raw[b].Dato.localeCompare(raw[a].Dato));
  const byRow = new Map(sortedIndices.map((rawIndex, parsedIndex) => [rawIndex, parsed.transactions[parsedIndex]]));
  const legacyOccurrences = new Map(), occurrences = new Map();
  const categories = new Map(), counterparties = new Map();
  const transactions = raw.map((row, index) => {
    const legacyFingerprint = JSON.stringify(headers.map(header => row[header]));
    const legacyOccurrence = legacyOccurrences.get(legacyFingerprint) || 0;
    legacyOccurrences.set(legacyFingerprint, legacyOccurrence + 1);
    const legacyId = `${legacyHash(legacyFingerprint)}-${legacyOccurrence}`;
    const tx = byRow.get(index);
    // Account labels and bank category metadata can change without creating a new payment.
    const identity = ['Dato', 'Beløp', 'Originalt Beløp', 'Original Valuta', 'Fra kontonummer', 'Til kontonummer', 'Type', 'Tekst', 'KID'].map(key => row[key] || '');
    const sourceFingerprint = digest(JSON.stringify(identity));
    const occurrence = occurrences.get(sourceFingerprint) || 0; occurrences.set(sourceFingerprint, occurrence + 1);
    const categoryExternalId = `category:${tx.category}`;
    categories.set(categoryExternalId, { externalId: categoryExternalId, name: tx.category });
    let subcategoryExternalId = null;
    if (tx.subcategory) {
      subcategoryExternalId = `${categoryExternalId}\u001f${tx.subcategory}`;
      categories.set(subcategoryExternalId, { externalId: subcategoryExternalId, name: tx.subcategory, parentExternalId: categoryExternalId });
    }
    const externalNumber = tx.amount < 0 ? row['Til kontonummer'] : row['Fra kontonummer'];
    const counterpartyExternalId = externalNumber && !accounts.has(externalNumber) ? externalNumber : null;
    if (counterpartyExternalId) counterparties.set(counterpartyExternalId, { externalId: counterpartyExternalId, name: tx.description });
    const fromAccountExternalId = accounts.has(row['Fra kontonummer']) ? row['Fra kontonummer'] : null;
    const toAccountExternalId = accounts.has(row['Til kontonummer']) ? row['Til kontonummer'] : null;
    return { ...tx, legacyId, sourceFingerprint, occurrence, categoryExternalId, subcategoryExternalId, counterpartyExternalId, fromAccountExternalId, toAccountExternalId, accountExternalId: tx.amount < 0 ? fromAccountExternalId : toAccountExternalId, currency: 'NOK', raw: row, rowNumber: index + 2 };
  });
  return { accounts: [...accounts.values()], categories: [...categories.values()], counterparties: [...counterparties.values()], transactions, contentHash: digest(content), sourceRows: transactions.length };
}
function canonical(data) {
  v.object(data, 'Canonical data');
  for (const key of Object.keys(data)) if (!['accounts', 'categories', 'counterparties', 'transactions'].includes(key)) throw new v.ValidationError('Unknown canonical data field.');
  const accounts = v.list(data.accounts === undefined ? [] : data.accounts, 'Accounts', 10000).map(item => {
    v.object(item); const result = { externalId: v.string(item.externalId, 'Account external ID', 300), name: v.string(item.name, 'Account name'), currency: v.currency(item.currency) };
    if (item.id) result.id = v.string(item.id, 'Account ID', 200);
    if ('role' in item) result.role = v.role(item.role);
    if ('balance' in item) { result.balance = item.balance === null ? null : v.amount(item.balance); result.balanceDate = v.date(item.balanceDate, 'Balance date'); }
    return result;
  });
  const categories = v.list(data.categories === undefined ? [] : data.categories, 'Categories', 10000).map(item => {
    v.object(item); return { id: item.id ? v.string(item.id, 'Category ID', 200) : null, externalId: v.string(item.externalId, 'Category external ID'), name: v.string(item.name, 'Category name', 200), parentExternalId: item.parentExternalId ? v.string(item.parentExternalId, 'Parent category ID') : null };
  });
  const counterparties = v.list(data.counterparties === undefined ? [] : data.counterparties, 'Counterparties', 10000).map(item => {
    v.object(item); return { id: item.id ? v.string(item.id, 'Counterparty ID', 200) : null, externalId: v.string(item.externalId, 'Counterparty external ID'), name: v.string(item.name, 'Counterparty name') };
  });
  // A metadata batch must not depend on input order to resolve contradictory
  // records for one provider identity. Multiple aliases may still link one ID.
  for (const [label, items] of [['Account', accounts], ['Category', categories], ['Counterparty', counterparties]]) {
    const identities = new Set();
    for (const item of items) {
      if (identities.has(item.externalId)) throw new v.ValidationError(`${label} external IDs must be unique within a batch.`);
      identities.add(item.externalId);
    }
  }
  const seen = new Set();
  const transactions = v.list(data.transactions === undefined ? [] : data.transactions, 'Transactions').map((item, index) => {
    v.object(item); const externalId = v.string(item.externalId, 'Transaction external ID', 500);
    if (seen.has(externalId)) throw new v.ValidationError('Canonical transaction external IDs must be unique within a batch.'); seen.add(externalId);
    const amount = v.amount(item.amount);
    const tx = { externalId, sourceFingerprint: digest(externalId), occurrence: 0, date: v.date(item.date), amount, currency: v.currency(item.currency), description: v.string(item.description || 'Bank transfer', 'Description', 2000), kind: v.kindForAmount(item.kind || (amount > 0 ? 'income' : 'expense'), amount), regularIncome: item.regularIncome === undefined ? false : v.boolean(item.regularIncome, 'Regular income'), review: item.review === undefined ? false : v.boolean(item.review, 'Review'), microSaving: item.microSaving === undefined ? false : v.boolean(item.microSaving, 'Micro-saving'), type: v.string(item.type || '', 'Transaction type', 200, true), rowNumber: index + 1, raw: item };
    for (const key of ['categoryExternalId', 'subcategoryExternalId', 'fromAccountExternalId', 'toAccountExternalId', 'accountExternalId', 'counterpartyExternalId']) tx[key] = item[key] ? v.string(item[key], key, 500) : null;
    for (const key of ['fromExternalAccount', 'toExternalAccount']) if (item[key] !== undefined) {
      v.object(item[key], key); v.string(item[key].externalId, 'External account identity', 500);
      const ownedReference = key === 'fromExternalAccount' ? tx.fromAccountExternalId : tx.toAccountExternalId;
      if (ownedReference) throw new v.ValidationError('One transaction side cannot specify both an owned account and an external account.');
      if (item[key].name !== undefined) v.string(item[key].name, 'External account label', 300);
    }
    if (!tx.accountExternalId) tx.accountExternalId = amount < 0 ? tx.fromAccountExternalId : tx.toAccountExternalId;
    return tx;
  });
  if (![accounts, categories, counterparties, transactions].some(items => items.length)) throw new v.ValidationError('The batch contains no data.');
  return { accounts, categories, counterparties, transactions, contentHash: digest(JSON.stringify(data)), sourceRows: transactions.length };
}
export function adapt(input) {
  v.object(input, 'Import');
  const adapter = v.string(input.adapter, 'Adapter', 100);
  const sourceKey = v.string(input.sourceKey === undefined ? 'default' : input.sourceKey, 'Source key', 200);
  const filename = input.filename ? v.string(input.filename, 'Filename', 255).split(/[\\/]/).at(-1) : null;
  const data = adapter === 'norwegian-bank-csv' ? bankCSV(input.content) : adapter === 'canonical-v1' ? canonical(input.data) : null;
  if (!data) throw new v.ValidationError('Unknown ingestion adapter.');
  return { adapter, sourceKey, filename, ...data };
}
