import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/server/database.js';
import { parseExport } from '../src/lib/engine.js';
import { readJSON } from '../src/server/http.js';

const headers = 'Dato;Beløp;Originalt Beløp;Original Valuta;Til konto;Til kontonummer;Fra konto;Fra kontonummer;Type;Tekst;KID;Hovedkategori;Underkategori';
const row = ({ amount = '-1.05', category = 'Food', name = 'Everyday', text = 'Synthetic shop' } = {}) => ['2026-10-01', amount, amount, 'NOK', '', 'synthetic-shop', name, 'synthetic-owned', 'Betaling', text, '', category, ''].join(';');
const csv = rows => [headers, ...rows].join('\n');
function memory(t) { const store = createStore(); t.after(() => store.close()); return store; }
const canonical = data => ({ adapter: 'canonical-v1', data });

test('CSV import is idempotent, retains identical legitimate rows, and preserves legacy IDs', t => {
  const store = memory(t); const content = csv([row(), row()]);
  assert.equal(store.ingest({ adapter: 'norwegian-bank-csv', content, filename: 'first.csv' }).inserted, 2);
  const ids = store.getTransactions().transactions.map(tx => tx.id);
  assert.deepEqual(ids, parseExport(content).transactions.map(tx => tx.id));
  const repeated = store.ingest({ adapter: 'norwegian-bank-csv', content, filename: 'renamed.csv' });
  assert.equal(repeated.inserted, 0); assert.equal(repeated.duplicate, true);
  assert.equal(store.getHistory().batches.length, 1);
  store.ingest({ adapter: 'norwegian-bank-csv', content: csv([row(), row(), row()]) });
  const data = store.getTransactions();
  assert.equal(data.transactions.length, 3); assert.equal(data.metadata.duplicateRows, 2);
  assert.equal(data.transactions.reduce((sum, tx) => sum + tx.amount, 0), -315);
  assert.deepEqual(data.transactions.slice(0, 2).map(tx => tx.id), ids);
  const publicJSON = JSON.stringify(data);
  assert.equal(publicJSON.includes('synthetic-owned'), false);
  assert.equal(publicJSON.includes('synthetic-shop'), false);
});
test('overlapping CSV metadata updates preserve transaction IDs and manual account labels', t => {
  const store = memory(t);
  store.ingest({ adapter: 'norwegian-bank-csv', content: csv([row()]) });
  const before = store.getTransactions().transactions[0];
  const account = store.getAccounts().accounts[0];
  store.updateAccount({ id: account.id, name: 'My everyday account', role: 'reserve', balance: 105, balanceDate: '2026-10-14' });
  store.saveOverrides({ [before.id]: { kind: 'saving', category: 'My override' } });
  const batch = store.ingest({ adapter: 'norwegian-bank-csv', content: csv([row({ category: 'Groceries', name: 'Bank renamed' })]) });
  assert.equal(batch.inserted, 0); assert.equal(batch.existing, 1);
  const after = store.getTransactions().transactions[0];
  assert.equal(after.id, before.id); assert.equal(after.category, 'Groceries');
  assert.equal(after.account, 'My everyday account');
  assert.equal(store.getAccounts().accounts[0].role, 'reserve');
  assert.equal(store.getOverrides()[before.id].category, 'My override');
});
test('canonical ingestion supports metadata-only batches and stable transaction corrections', t => {
  const store = memory(t);
  store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Cash', balance: 12345, balanceDate: '2026-10-14' }], categories: [{ externalId: 'food', name: 'Food' }], counterparties: [{ externalId: 'shop', name: 'Shop' }] }));
  const payment = { externalId: 'payment-1', date: '2026-10-01', amount: -105, description: 'Shopping', accountExternalId: 'cash', categoryExternalId: 'food', counterpartyExternalId: 'shop' };
  store.ingest(canonical({ transactions: [payment] })); const id = store.getTransactions().transactions[0].id;
  store.ingest(canonical({ transactions: [{ ...payment, amount: -106 }] }));
  assert.equal(store.getTransactions().transactions.length, 1);
  assert.equal(store.getTransactions().transactions[0].id, id);
  assert.equal(store.getTransactions().transactions[0].amount, -106);
  store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Everyday' }], categories: [{ externalId: 'food', name: 'Groceries' }], counterparties: [{ externalId: 'shop', name: 'Local shop' }] }));
  assert.equal(store.getTransactions().transactions[0].category, 'Groceries');
  assert.equal(store.getTransactions().transactions[0].account, 'Everyday');
  assert.equal(store.getTransactions().transactions[0].counterparty, 'Local shop');
});
test('bad imported reference rolls back metadata, transactions, batches, and lineage together', t => {
  const store = memory(t);
  assert.throws(() => store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Cash' }], transactions: [ { externalId: 'a', date: '2026-10-01', amount: -105, accountExternalId: 'cash' }, { externalId: 'b', date: '2026-10-01', amount: -105, accountExternalId: 'missing' } ] })), /reference/);
  assert.equal(store.getAccounts().accounts.length, 0);
  assert.equal(store.getTransactions().metadata.rows, 0);
  assert.equal(store.getTransactions().metadata.sources, 0);
  assert.equal(store.getHistory().batches.length, 0);
});
test('adapter source identities are isolated and an ingest cannot overwrite a manual balance', t => {
  const store = memory(t);
  const metadata = { accounts: [{ externalId: 'cash', name: 'Cash', balance: 100, balanceDate: '2026-10-14' }] };
  store.ingest(canonical(metadata)); const first = store.getAccounts().accounts[0];
  store.updateAccount({ id: first.id, balance: 105, balanceDate: '2026-10-14' });
  store.ingest(canonical({ accounts: [{ ...metadata.accounts[0], balance: 200 }] }));
  assert.equal(store.getAccounts().accounts[0].balance, 105);
  store.ingest({ ...canonical(metadata), sourceKey: 'another-bank' });
  assert.equal(store.getAccounts().accounts.length, 2);
});
test('JSON ingestion rejects wrong media types, malformed JSON, and oversized streamed bodies', async () => {
  await assert.rejects(readJSON(new Request('http://localhost/api', { method: 'POST', body: '{}' })), /application\/json/);
  await assert.rejects(readJSON(new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })), /valid JSON/);
  await assert.rejects(readJSON(new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"oversized":true}' }), 4), /too large/);
});

test('metadata adapters can link existing opaque entity IDs across different sources', t => {
  const store = memory(t);
  store.ingest({ adapter: 'norwegian-bank-csv', content: csv([row()]) });
  const original = store.getAccounts().accounts[0];
  const category = store.getMetadata().categories[0];
  store.ingest(canonical({ accounts: [{ externalId: 'new-account-reference', id: original.id, name: 'Updated account' }], categories: [{ externalId: 'food-reference', id: category.id, name: 'Updated category' }] }));
  assert.equal(store.getAccounts().accounts.length, 1);
  assert.equal(store.getTransactions().transactions[0].account, 'Updated account');
  assert.equal(store.getTransactions().transactions[0].category, 'Updated category');
  store.ingest(canonical({ transactions: [{ externalId: 'new-payment', date: '2026-10-02', amount: -100, fromAccountExternalId: 'new-account-reference', categoryExternalId: 'food-reference' }] }));
  assert.equal(store.getTransactions().transactions[0].accountId, original.id);
});
test('category parent cycles roll back without retaining partial metadata', t => {
  const store = memory(t);
  assert.throws(() => store.ingest(canonical({ categories: [{ externalId: 'a', name: 'A', parentExternalId: 'b' }, { externalId: 'b', name: 'B', parentExternalId: 'a' }] })), /cycle/);
  assert.equal(store.getMetadata().categories.length, 0);
});

test('simultaneous imports from separate database connections commit one logical batch', async t => {
  const { Worker } = await import('node:worker_threads');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-concurrent-')); const path = join(directory, 'shared.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = createStore(path); initial.close();
  const source = `const { parentPort, workerData } = require('node:worker_threads'); import(workerData.module).then(({createStore}) => { const store=createStore(workerData.path); try { parentPort.postMessage(store.ingest(workerData.input)); } finally { store.close(); } });`;
  const workerData = { module: new URL('../src/server/database.js', import.meta.url).href, path, input: { adapter: 'norwegian-bank-csv', content: csv([row(), row()]) } };
  const runWorker = () => new Promise((resolve, reject) => { const worker = new Worker(source, { eval: true, workerData }); worker.on('message', resolve); worker.on('error', reject); worker.on('exit', code => { if (code !== 0) reject(new Error('Import worker failed.')); }); });
  const results = await Promise.all([runWorker(), runWorker()]);
  const store = createStore(path); t.after(() => store.close());
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 2);
  assert.equal(store.getTransactions().transactions.length, 2);
  assert.equal(store.getHistory().batches.length, 1);
});

test('canonical transactions and API override operations reject inconsistent kinds without changing data', t => {
  const store = memory(t);
  const payment = { externalId: 'expense', date: '2026-10-01', amount: -105 };
  const income = { externalId: 'income', date: '2026-10-01', amount: 105 };
  for (const invalid of [{ ...payment, kind: 'income' }, { ...income, kind: 'expense' }, { ...income, kind: 'saving' }]) assert.throws(() => store.ingest(canonical({ transactions: [invalid] })), /does not match/);
  store.ingest(canonical({ transactions: [payment, income, { externalId: 'zero', date: '2026-10-01', amount: 0, kind: 'income' }] }));
  const transactions = store.getTransactions().transactions;
  const negative = transactions.find(tx => tx.amount < 0), positive = transactions.find(tx => tx.amount > 0), zero = transactions.find(tx => tx.amount === 0);
  store.updateOverride({ id: negative.id, override: { kind: 'saving', category: 'Savings' } });
  assert.throws(() => store.updateOverride({ id: negative.id, override: { kind: 'income' } }), /does not match/);
  assert.throws(() => store.saveOverrides({ [positive.id]: { kind: 'expense' } }), /does not match/);
  assert.equal(store.getOverrides()[negative.id].kind, 'saving');
  store.updateOverride({ id: positive.id, override: { kind: 'transfer' } });
  store.updateOverride({ id: zero.id, override: { kind: 'expense' } });
  assert.throws(() => store.ingest(canonical({ transactions: [{ ...payment, amount: 105 }] })), /does not match/);
  assert.equal(store.getTransactions().transactions.find(tx => tx.id === negative.id).amount, -105);
  store.updateOverride({ id: negative.id, override: null });
  assert.equal(store.getOverrides()[negative.id], undefined);
});
test('canonical classification metadata corrections keep transaction identity and preserve row lineage', t => {
  const store = memory(t);
  const tx = { externalId: 'payment', date: '2026-10-01', amount: -105, kind: 'expense' };
  store.ingest(canonical({ categories: [{ externalId: 'one', name: 'First category' }], transactions: [{ ...tx, categoryExternalId: 'one' }] }));
  const id = store.getTransactions().transactions[0].id;
  const result = store.ingest(canonical({ categories: [{ externalId: 'two', name: 'Second category' }], transactions: [{ ...tx, kind: 'saving', categoryExternalId: 'two' }] }));
  assert.equal(result.inserted, 0); assert.equal(result.existing, 1);
  assert.equal(store.getTransactions().transactions.length, 1);
  assert.equal(store.getTransactions().transactions[0].id, id);
  assert.equal(store.getTransactions().transactions[0].kind, 'saving');
  assert.equal(store.getTransactions().transactions[0].category, 'Second category');
  assert.equal(store.getHistory().batches.length, 2);
});

test('imported account balance overflow rolls back the complete ingestion batch', t => {
  const store = memory(t);
  assert.throws(() => store.ingest(canonical({ accounts: [
    { externalId: 'one', name: 'One', balance: Number.MAX_SAFE_INTEGER, balanceDate: '2026-10-14' },
    { externalId: 'two', name: 'Two', balance: 1, balanceDate: '2026-10-14' }
  ] })), /exact amount/);
  assert.equal(store.getAccounts().accounts.length, 0);
  assert.equal(store.getHistory().batches.length, 0);
});

test('legacy hash collisions cannot silently replace the data of a different source row', t => {
  const store = memory(t);
  const descriptions = ['Synthetic shop 069d1132', 'Synthetic shop 6f762ca1'];
  const content = csv(descriptions.map(text => row({ text })));
  const legacy = parseExport(content).transactions;
  assert.equal(legacy[0].id, legacy[1].id); // Deliberate collision in the old 32-bit identifier.
  store.ingest({ adapter: 'norwegian-bank-csv', content });
  const imported = store.getTransactions().transactions;
  assert.deepEqual(imported.map(tx => tx.description), descriptions);
  assert.equal(new Set(imported.map(tx => tx.id)).size, 2);
  assert.equal(store.ingest({ adapter: 'norwegian-bank-csv', content }).inserted, 0);
});
