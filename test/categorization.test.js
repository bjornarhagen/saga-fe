import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectCategories, categoryIdentity, similarCategoryTransactions, decimalAmount, isUncategorized } from '../src/lib/categorization.js';
import { applyOverrides, summarize } from '../src/lib/engine.js';
import { matchesCategoryStatus, categoryControls } from '../src/scripts/categorization.js';
import { createStore, DATABASE_SCHEMA_VERSION } from '../src/server/database.js';

const node = { id: 'synthetic-recipient', name: 'Example shop', owned: false, kind: 'external-account', evidence: { isAccountIdentifier: true } };
const row = (id, category = 'Uncategorized', extra = {}) => ({ id, date: '2026-01-01', amount: -105, kind: 'expense', currency: 'NOK', category, subcategory: '', description: 'Example payment', toEndpoint: node, ...extra });
const categorized = (count, extra = {}) => Array.from({ length: count }, (_, i) => row(`example-${i}`, 'Food', extra));

test('five unanimous independent examples auto apply while four and conflicting categories stay suggestions', () => {
  for (const count of [1, 4, 5]) {
    const projected = projectCategories([...categorized(count), row('target')]);
    const target = projected.at(-1), effective = applyOverrides(projected).at(-1);
    assert.equal(target.category, 'Uncategorized', 'source is untouched');
    assert.equal(target.categorySuggestion.support, count);
    assert.equal(target.categorySuggestion.status, count >= 5 ? 'auto_applied' : 'not_applied');
    assert.equal(effective.category, count >= 5 ? 'Food' : 'Uncategorized');
    assert.equal(matchesCategoryStatus(effective, 'pending'), true);
    assert.equal(isUncategorized(effective), count < 5);
    if (count >= 5) assert.equal(effective.review, true);
  }
  const conflict = projectCategories([...categorized(5), row('different-category', 'Transport'), row('target')]).at(-1);
  assert.equal(conflict.categorySuggestion.status, 'not_applied');
  assert.equal(conflict.categorySuggestion.total, 6);
  assert.equal(projectCategories([row('alone')])[0].categorySuggestion, null);
});

test('automatic applications never train further guesses, and text hints cannot auto apply', () => {
  const input = [...categorized(1), ...Array.from({ length: 20 }, (_, i) => row(`unknown-${i}`))];
  const once = projectCategories(input), twice = projectCategories(once);
  assert.ok(twice.slice(1).every(row => row.categorySuggestion.support === 1 && row.categorySuggestion.status === 'not_applied'));
  const hint = { ...node, kind: 'merchant-hint', evidence: { kind: 'merchant-hint', isAccountIdentifier: false } };
  assert.equal(projectCategories([...categorized(10, { toEndpoint: hint }), row('target', undefined, { toEndpoint: hint })]).at(-1).categorySuggestion.status, 'not_applied');
  const duplicates = projectCategories([...categorized(10, { categoryExampleKey: 'same-source-row' }), row('target')]).at(-1);
  assert.equal(duplicates.categorySuggestion.support, 1);
  assert.equal(duplicates.categorySuggestion.status, 'not_applied');
});

test('identity excludes owned accounts, placeholders, opposite directions, transfer types, currencies and other endpoints', () => {
  const examples = categorized(5);
  for (const extra of [
    { toEndpoint: { ...node, id: 'other' } }, { amount: 105, kind: 'income', fromEndpoint: node },
    { kind: 'saving' }, { kind: 'transfer' }, { currency: 'EUR' }, { amount: 0 },
    { toEndpoint: { ...node, owned: true } }, { toEndpoint: { ...node, kind: 'unknown-endpoint' } }, { toEndpoint: null },
  ]) assert.equal(projectCategories([...examples, row('target', undefined, extra)]).at(-1).categorySuggestion, null);
  assert.notEqual(categoryIdentity(row('a')).key, categoryIdentity(row('b', undefined, { kind: 'saving' })).key);
});

test('explicit accept, reject and manual overrides win without changing kind, amounts or forecast exclusions', () => {
  const input = [...categorized(5), row('target', undefined, { review: true, subcategory: 'Source subcategory' })];
  for (const status of ['user_applied', 'user_rejected']) {
    const projected = projectCategories(input, {}, [{ transactionId: 'target', category: 'Food', status }]);
    const target = applyOverrides(projected).at(-1);
    assert.equal(target.categorySuggestion.status, status);
    assert.equal(target.category, status === 'user_applied' ? 'Food' : 'Uncategorized');
    assert.equal(target.amount, -105);
    assert.equal(target.kind, 'expense');
    if (status === 'user_applied') { assert.equal(target.review, false); assert.equal(target.subcategory, ''); }
  }
  const override = { target: { category: 'My choice', kind: 'saving', excludeForecast: true } };
  const target = applyOverrides(projectCategories(input, override), override).at(-1);
  assert.equal(target.category, 'My choice'); assert.equal(target.categorySuggestion.status, 'user_applied');
  assert.equal(target.kind, 'saving'); assert.equal(target.excludeForecast, true);
  assert.equal(summarize(applyOverrides(projectCategories(input))).expense, 6 * 105);
});

test('similar preview honors exact absolute amount limits and protects imported and chosen categories by default', () => {
  const original = row('anchor');
  const rows = [original, row('low', undefined, { amount: -104 }), row('exact'), row('high', undefined, { amount: -106 }), row('imported', 'Food'), { ...row('chosen', 'Food'), categorySuggestion: { status: 'user_applied', category: 'Food' } }, { ...row('rejected'), categorySuggestion: { status: 'user_rejected', category: 'Food' } }];
  const filtered = similarCategoryTransactions(original, rows, { minAmount: 105, maxAmount: 105 });
  assert.deepEqual(filtered.map(row => row.id), ['exact']);
  assert.equal(similarCategoryTransactions(original, rows, { includeCategorized: true }).length, 6);
  assert.deepEqual(similarCategoryTransactions(original, rows, { status: 'user_rejected', category: 'Food' }), []);
  for (const [input, expected] of [['1.05', 105], ['1,05', 105], ['0', 0], ['100', 10000], ['0.01', 1], ['1.005', null], ['-1', null], ['Infinity', null], ['1e4', null]]) assert.equal(decimalAmount(input), expected);
  assert.equal(categoryControls({ ...row('escaped'), categorySuggestion: { category: '<script>', status: 'not_applied' } }).includes('<script>'), false);
});

function seed(store, count = 5) {
  const data = { accounts: [{ externalId: 'cash', name: 'Example cash' }], categories: [{ externalId: 'food', name: 'Food' }], transactions: [
    ...Array.from({ length: count }, (_, i) => ({ externalId: `known-${i}`, date: '2026-01-01', amount: -105, description: `Known example ${i}`, accountExternalId: 'cash', toExternalAccount: { externalId: 'example-shop', name: 'Example shop' }, categoryExternalId: 'food' })),
    ...Array.from({ length: 3 }, (_, i) => ({ externalId: `unknown-${i}`, date: '2026-02-01', amount: -(i + 1) * 105, description: `Unknown example ${i}`, accountExternalId: 'cash', toExternalAccount: { externalId: 'example-shop', name: 'Example shop' } })),
    { externalId: 'other', date: '2026-02-01', amount: -105, description: 'Other recipient', accountExternalId: 'cash', toExternalAccount: { externalId: 'other-shop', name: 'Other shop' } },
  ] };
  store.ingest({ adapter: 'canonical-v1', data });
  return { data, unknown: store.getTransactions().transactions.filter(row => row.description.startsWith('Unknown')) };
}
function memory(t) { const store = createStore(); t.after(() => store.close()); return store; }

test('category decisions persist separately, project consistently into ledger, details and account groups, and revert auto applications on rejection', t => {
  const store = memory(t), { unknown } = seed(store);
  const id = unknown[0].id, before = store.exportLedger().tables;
  assert.equal(store.getTransactionDetail(id).transaction.category, 'Food');
  const endpointId = store.getTransactionDetail(id).to.id;
  assert.equal(store.getEndpointActivity(endpointId).categorySummaries.active[0].category, 'Food');
  store.updateOverride({ id, override: { excludeForecast: true } });
  store.updateCategories({ transactionIds: [id], category: 'Food', status: 'user_rejected' });
  let detail = store.getTransactionDetail(id);
  assert.equal(detail.transaction.category, 'Uncategorized'); assert.equal(detail.transaction.excludeForecast, true);
  assert.equal(detail.transaction.categorySuggestion.status, 'user_rejected');
  assert.deepEqual(store.exportLedger().tables.transactions, before.transactions);
  assert.deepEqual(store.exportLedger().tables.ingest_rows, before.ingest_rows);
  store.updateCategories({ transactionIds: [id], category: 'Alternative', status: 'user_applied' });
  assert.equal(store.getTransactionDetail(id).transaction.category, 'Alternative');
  store.updateCategories({ transactionIds: [id], status: null });
  assert.equal(store.getTransactionDetail(id).transaction.categorySuggestion.status, 'auto_applied');
  assert.equal(store.getOverrides()[id].excludeForecast, true);
});

test('batch decisions validate current identity, eligibility, range and IDs atomically', t => {
  const store = memory(t), { unknown } = seed(store);
  const [anchor, target] = unknown;
  const input = { transactionIds: [target.id], category: 'Food', status: 'user_applied', similarTo: anchor.id };
  const other = store.getTransactions().transactions.find(row => row.description === 'Other recipient');
  const before = store.exportLedger().tables;
  for (const invalid of [
    { ...input, transactionIds: [target.id, other.id] }, { ...input, transactionIds: ['missing'] },
    { ...input, transactionIds: [target.id, target.id] }, { ...input, transactionIds: [] },
    { ...input, minAmount: 1.05 }, { ...input, maxAmount: 0 }, { ...input, status: 'auto_applied' },
    { ...input, status: 'user_rejected', category: 'Wrong' }, { ...input, includeCategorized: 'yes' }, { ...input, extra: true },
  ]) { assert.throws(() => store.updateCategories(invalid)); assert.deepEqual(store.exportLedger().tables, before); }
  assert.equal(store.updateCategories(input).updated, 1);
  assert.throws(() => store.updateCategories(input), /matching payments changed/);
  store.updateOverride({ id: target.id, override: { category: 'Manual', excludeForecast: true } });
  assert.equal(store.getTransactionDetail(target.id).transaction.category, 'Manual');
  store.updateCategories({ transactionIds: [target.id], category: 'New choice', status: 'user_applied' });
  assert.equal(store.getTransactionDetail(target.id).transaction.category, 'New choice');
  assert.equal(store.getOverrides()[target.id].excludeForecast, true);
  store.updateOverride({ id: target.id, override: null });
  assert.equal(store.getTransactionDetail(target.id).transaction.categorySuggestion.status, 'auto_applied');
  store.updateCategories({ transactionIds: [target.id], category: 'Food', status: 'user_rejected' });
  store.saveOverrides({}, { resetCategories: true });
  assert.deepEqual(store.exportLedger().tables.transaction_category_decisions, []);
  assert.equal(store.getTransactionDetail(target.id).transaction.categorySuggestion.status, 'auto_applied');
});

test('manual choices train fresh suggestions, rejections survive reimports and reopen, and version three migrates without source changes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-category-')), path = join(directory, 'ledger.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = createStore(path), { unknown, data } = seed(store, 1);
  store.updateCategories({ transactionIds: [unknown[0].id], category: 'Food', status: 'user_rejected' });
  store.updateCategories({ transactionIds: [unknown[1].id], category: 'Food', status: 'user_applied' });
  assert.equal(store.getTransactionDetail(unknown[2].id).transaction.categorySuggestion.support, 2);
  store.ingest({ adapter: 'canonical-v1', data });
  const saved = store.exportLedger().tables; store.close(); store = createStore(path);
  assert.deepEqual(store.exportLedger().tables, saved); store.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE account_profiles; DROP TABLE transaction_category_decisions; PRAGMA user_version=3'); legacy.close();
  store = createStore(path); t.after(() => store.close());
  assert.equal(store.exportLedger().databaseSchemaVersion, DATABASE_SCHEMA_VERSION);
  for (const [table, rows] of Object.entries(saved)) if (table !== 'transaction_category_decisions') assert.deepEqual(store.exportLedger().tables[table], rows);
  assert.deepEqual(store.exportLedger().tables.transaction_category_decisions, []);
});

test('repeated identical imported bank rows are one example and source corrections withdraw automatic guesses without withdrawing user choices', t => {
  const store = memory(t);
  const receiver = '1111' + '11' + '11111';
  const header = 'Dato;Beløp;Fra konto;Til konto;Fra kontonummer;Til kontonummer;Type;Tekst;Hovedkategori;Underkategori';
  const known = ['2026-01-01', '-1.05', 'Cash', '', 'synthetic-cash', receiver, 'Betaling', 'Synthetic shop', 'Food', ''].join(';');
  const unknown = ['2026-01-02', '-2.10', 'Cash', '', 'synthetic-cash', receiver, 'Betaling', 'Synthetic shop', '', ''].join(';');
  store.ingest({ adapter: 'norwegian-bank-csv', content: [header, ...Array(5).fill(known), unknown].join('\n') });
  const suggestion = store.getTransactions().transactions.find(row => row.date === '2026-01-02').categorySuggestion;
  assert.equal(suggestion.support, 1); assert.equal(suggestion.status, 'not_applied');
  assert.equal(JSON.stringify(store.getTransactions()).includes(receiver), false);

  const second = memory(t), fixture = seed(second);
  second.updateCategories({ transactionIds: [fixture.unknown[0].id], category: 'Food', status: 'user_applied' });
  second.ingest({ adapter: 'canonical-v1', data: { ...fixture.data, transactions: fixture.data.transactions.map(row => row.externalId.startsWith('known') ? { ...row, categoryExternalId: null } : row) } });
  assert.equal(second.getTransactionDetail(fixture.unknown[0].id).transaction.categorySuggestion.status, 'user_applied');
  const current = second.getTransactionDetail(fixture.unknown[1].id).transaction;
  assert.equal(current.categorySuggestion.status, 'not_applied'); assert.equal(current.category, 'Uncategorized');
});

test('a failed category migration keeps version three and every saved financial row intact', t => {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-category-migration-')), path = join(directory, 'ledger.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore(path); seed(store); const before = store.exportLedger().tables; store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE account_profiles; DROP TABLE transaction_category_decisions; CREATE TABLE transaction_category_decisions(unexpected TEXT); INSERT INTO transaction_category_decisions VALUES('synthetic-preserved'); PRAGMA user_version=3");
  legacy.close();
  assert.throws(() => createStore(path), /already exists/);
  const check = new DatabaseSync(path); t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(check.prepare('SELECT unexpected FROM transaction_category_decisions').get().unexpected, 'synthetic-preserved');
  assert.deepEqual(JSON.parse(JSON.stringify(check.prepare('SELECT * FROM transactions ORDER BY rowid').all())), JSON.parse(JSON.stringify(before.transactions)));
});
