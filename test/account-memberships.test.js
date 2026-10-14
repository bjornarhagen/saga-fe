import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, LEDGER_TABLES } from '../src/server/database.js';

function memory(t) { const store = createStore(); t.after(() => store.close()); return store; }
function directory(t) { const path = mkdtempSync(join(tmpdir(), 'saga-fe-membership-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function seed(store) {
  const transactions = [
    { externalId: 'payment-a', date: '2026-01-01', amount: -105, description: 'Example A', categoryExternalId: 'food', accountExternalId: 'cash', toExternalAccount: { externalId: 'recipient-a', name: 'Recipient A' } },
    { externalId: 'payment-b', date: '2026-02-01', amount: -210, description: 'Example B', categoryExternalId: 'other', accountExternalId: 'cash', toExternalAccount: { externalId: 'recipient-b', name: 'Recipient B' } },
    { externalId: 'refund', date: '2026-03-01', amount: 55, description: 'Example refund', categoryExternalId: 'food', accountExternalId: 'cash', fromExternalAccount: { externalId: 'recipient-a', name: 'Recipient A' } }
  ];
  const input = { adapter: 'canonical-v1', data: { accounts: [{ externalId: 'cash', name: 'Cash' }], categories: [{ externalId: 'food', name: 'Food' }, { externalId: 'other', name: 'Other' }], transactions } };
  store.ingest(input);
  const rows = store.getTransactions().transactions;
  return { input, a: rows.find(row => row.description === 'Example A'), b: rows.find(row => row.description === 'Example B'), refund: rows.find(row => row.description === 'Example refund') };
}

test('explicit external account decisions are separate from source evidence, categories and pair confirmations', t => {
  const store = memory(t), { a, b } = seed(store);
  assert.deepEqual(store.getAccountMemberships(), { decisions: [] });
  assert.equal(a.toMembership.status, 'suggested');
  assert.equal(a.toEndpoint.evidence.isAccountIdentifier, true);
  assert.equal(a.toEndpoint.evidence.requiresConfirmation, true);
  store.updateRelation({ transactionId: a.id, relatedTransactionId: b.id, status: 'confirmed' });
  assert.equal(store.getTransactionDetail(a.id).transaction.toMembership.status, 'suggested');
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: 'confirmed' });
  const detail = store.getTransactionDetail(a.id);
  assert.equal(detail.transaction.toMembership.status, 'confirmed');
  assert.equal(detail.transaction.toMembership.provenance, 'owner');
  assert.equal(detail.transaction.category, 'Food');
  assert.equal(store.getTransactionDetail(b.id).transaction.toMembership.status, 'suggested');
  assert.equal(store.getEndpointActivity(a.toEndpointId).summaries.confirmed.payments, 1);
});

test('confirmation of an alternate recipient preserves source facts and excludes the superseded hint from active totals', t => {
  const store = memory(t), { a, b } = seed(store);
  store.updateOverride({ id: a.id, override: { category: 'Owner groceries' } });
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: b.toEndpointId, status: 'confirmed' });
  const detail = store.getTransactionDetail(a.id);
  assert.equal(detail.to.id, b.toEndpointId);
  assert.equal(detail.sourceTo.id, a.toEndpointId);
  assert.equal(detail.transaction.sourceToEndpointId, a.toEndpointId);
  assert.equal(detail.transaction.toEndpointId, b.toEndpointId);
  assert.equal(detail.transaction.amount, -105);
  const old = store.getEndpointActivity(a.toEndpointId);
  const superseded = old.transactions.find(row => row.id === a.id);
  assert.equal(superseded.membershipStatus, 'dismissed');
  assert.equal(superseded.memberships[0].provenance, 'owner-other-target');
  assert.equal(superseded.memberships[0].explicit, false);
  assert.equal(old.summaries.dismissed.incoming, 105);
  assert.equal(old.summary.incoming, 0); // Only the refund still belongs to this source recipient.
  assert.equal(old.summary.outgoing, 55);
  const target = store.getEndpointActivity(b.toEndpointId);
  assert.equal(target.summary.incoming, 315);
  assert.equal(target.summaries.confirmed.incoming, 105);
  assert.equal(target.categorySummaries.confirmed[0].category, 'Owner groceries');
  assert.equal(target.categorySummaries.confirmed[0].incoming, 105);
});

test('confirming a new target dismisses a previous direct target; resetting affects only the selected decision', t => {
  const store = memory(t), { a, b } = seed(store);
  const first = store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: 'confirmed' });
  assert.deepEqual(store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: 'confirmed' }), first);
  const result = store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: b.toEndpointId, status: 'confirmed' });
  assert.equal(result.decisions.filter(decision => decision.status === 'confirmed').length, 1);
  assert.equal(result.decisions.find(decision => decision.endpointId === a.toEndpointId).status, 'dismissed');
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: b.toEndpointId, status: null });
  assert.equal(store.getAccountMemberships().decisions.length, 1);
  assert.equal(store.getTransactionDetail(a.id).transaction.toMembership.status, 'dismissed');
  assert.equal(store.getTransactionDetail(a.id).to, null);
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: null });
  assert.equal(store.getTransactionDetail(a.id).transaction.toMembership.status, 'suggested');
});

test('sender and receiver decisions are independent and invalid or owned-side targets are rejected atomically', t => {
  const store = memory(t), { a, b, refund } = seed(store);
  store.updateAccountMembership({ transactionId: refund.id, side: 'from', endpointId: b.toEndpointId, status: 'confirmed' });
  assert.equal(store.getTransactionDetail(refund.id).from.id, b.toEndpointId);
  const valid = { transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: 'confirmed' }, before = store.exportLedger().tables;
  for (const invalid of [null, {}, { ...valid, status: 'yes' }, { ...valid, side: 'sender' }, { ...valid, transactionId: 'missing' }, { ...valid, endpointId: 'missing' }, { ...valid, endpointId: a.fromEndpointId }, { ...valid, side: 'from' }, { ...valid, extra: true }]) assert.throws(() => store.updateAccountMembership(invalid));
  assert.deepEqual(store.exportLedger().tables, before);
});

test('decisions persist after source corrections, reimports, reopening and full SQLite/JSON recovery without changing financial rows', async t => {
  const root = directory(t), path = join(root, 'ledger.sqlite'), snapshot = join(root, 'snapshot.sqlite');
  let store = createStore(path); const { input, a, b } = seed(store);
  const before = store.exportLedger().tables;
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: 'confirmed' });
  for (const table of LEDGER_TABLES.filter(table => !['external_endpoint_refs', 'transaction_account_memberships'].includes(table))) assert.deepEqual(store.exportLedger().tables[table], before[table]);
  assert.equal(store.ingest(input).duplicate, true);
  store.ingest({ adapter: 'canonical-v1', data: { transactions: [{ ...input.data.transactions[0], toExternalAccount: { externalId: 'recipient-b', name: 'Recipient B' } }, { ...input.data.transactions[2], fromExternalAccount: { externalId: 'recipient-b', name: 'Recipient B' } }] } });
  assert.equal(store.getTransactionDetail(a.id).to.id, a.toEndpointId);
  assert.equal(store.getTransactionDetail(a.id).sourceTo.id, b.toEndpointId);
  assert.equal(store.getEndpointActivity(a.toEndpointId).summaries.confirmed.payments, 1);
  const decisions = store.getAccountMemberships(), archive = store.exportLedger();
  assert.equal(archive.databaseSchemaVersion, 3);
  assert.equal(Object.keys(archive.tables).length, 17);
  assert.equal(archive.tables.external_endpoint_refs.length, 1);
  await store.backup(snapshot); store.close(); store = createStore(path); t.after(() => store.close());
  assert.deepEqual(store.getAccountMemberships(), decisions);
  const recovered = createStore(snapshot); t.after(() => recovered.close());
  assert.deepEqual(recovered.getAccountMemberships(), decisions);
  assert.deepEqual(recovered.exportLedger().tables, archive.tables);
});

test('version-two migration preserves existing pair decisions and creates no inferred account memberships', t => {
  const path = join(directory(t), 'version-two.sqlite');
  let store = createStore(path); const { a, b } = seed(store);
  store.updateRelation({ transactionId: a.id, relatedTransactionId: b.id, status: 'confirmed' });
  const pairs = store.getRelations(), original = store.exportLedger().tables;
  delete original.external_endpoint_refs; delete original.transaction_account_memberships; store.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE transaction_account_memberships; DROP TABLE external_endpoint_refs; PRAGMA user_version=2'); legacy.close();
  store = createStore(path); t.after(() => store.close());
  assert.deepEqual(store.getRelations(), pairs);
  assert.deepEqual(store.getAccountMemberships(), { decisions: [] });
  for (const table of Object.keys(original)) assert.deepEqual(store.exportLedger().tables[table], original[table]);
  assert.equal(store.getTransactionDetail(a.id).transaction.toMembership.status, 'suggested');
});

test('recorded numeric bank identifiers stay private while alphabetic fields remain explicitly unconfirmed merchant hints', t => {
  const store = memory(t);
  const identifier = '1111' + '11' + '11111'; // Deliberately invalid account checksum; source-format test only.
  const head = 'Dato;Beløp;Fra konto;Til konto;Fra kontonummer;Til kontonummer;Type;Tekst;Hovedkategori;Underkategori';
  store.ingest({ adapter: 'norwegian-bank-csv', content: [head, ['2026-01-01', '-1.05', 'Cash', '', 'fixture-cash', identifier, 'Betaling', 'Numeric recipient', 'Food', ''].join(';'), ['2026-01-02', '-2.10', 'Cash', '', 'fixture-cash', 'Example Market', 'Betaling', 'Example Market', 'Food', ''].join(';')].join('\n') });
  const rows = store.getTransactions().transactions, numeric = rows.find(row => row.description === 'Numeric recipient'), hint = rows.find(row => row.description === 'Example Market');
  assert.equal(numeric.toEndpoint.evidence.kind, 'source-account-identifier');
  assert.equal(JSON.stringify(store.getTransactions()).includes(identifier), false);
  assert.equal(hint.toEndpoint.kind, 'merchant-hint');
  assert.equal(hint.toEndpoint.name, 'Example Market');
  assert.equal(hint.toMembership.status, 'suggested');
  assert.ok(store.getTransactionDetail(numeric.id).sourceTo.identifiers.some(item => item.value === identifier));
});

test('saved decision references remain resettable through the original ID after promotion to an owned account', t => {
  const store = memory(t), { a } = seed(store);
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: 'confirmed' });
  store.ingest({ adapter: 'canonical-v1', data: { accounts: [{ externalId: 'recipient-a', name: 'Newly identified owned reserve' }] } });
  const detail = store.getTransactionDetail(a.id);
  assert.ok(detail.to.owned);
  assert.notEqual(detail.to.id, a.toEndpointId);
  assert.equal(detail.transaction.toMembership.decisionEndpointId, a.toEndpointId);
  assert.equal(store.getEndpointActivity(a.toEndpointId).endpoint.id, detail.to.id);
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: detail.transaction.toMembership.decisionEndpointId, status: null });
  assert.deepEqual(store.getAccountMemberships(), { decisions: [] });
});

test('a zero-valued associated owned row remains in its history after adding an external membership', t => {
  const store = memory(t), { a } = seed(store);
  store.ingest({ adapter: 'canonical-v1', data: { transactions: [{ externalId: 'zero', date: '2026-04-01', amount: 0, accountExternalId: 'cash' }] } });
  const zero = store.getTransactions().transactions.find(row => row.amount === 0), cash = store.getAccounts().accounts[0];
  store.updateAccountMembership({ transactionId: zero.id, side: 'from', endpointId: a.toEndpointId, status: 'confirmed' });
  const activity = store.getEndpointActivity(cash.id);
  assert.ok(activity.transactions.some(row => row.id === zero.id && row.flowDirection === 'unknown'));
  assert.equal(store.getTransactionDetail(zero.id).transaction.amount, 0);
  assert.ok(store.getEndpointActivity(a.toEndpointId).transactions.some(row => row.id === zero.id && row.membershipStatus === 'confirmed'));
});

test('a reserved endpoint-reference table collision leaves version two and all previous saved decisions intact', t => {
  const path = join(directory(t), 'collision.sqlite');
  let store = createStore(path); const { a, b } = seed(store);
  store.updateRelation({ transactionId: a.id, relatedTransactionId: b.id, status: 'confirmed' });
  const original = store.exportLedger().tables; delete original.external_endpoint_refs; delete original.transaction_account_memberships; store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE transaction_account_memberships; DROP TABLE external_endpoint_refs; CREATE TABLE external_endpoint_refs(unexpected TEXT); INSERT INTO external_endpoint_refs VALUES('synthetic-preserved'); PRAGMA user_version=2"); legacy.close();
  assert.throws(() => createStore(path), /already exists/);
  const check = new DatabaseSync(path, { readOnly: true }); t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(check.prepare('SELECT unexpected FROM external_endpoint_refs').get().unexpected, 'synthetic-preserved');
  for (const table of Object.keys(original)) assert.deepEqual(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), original[table]);
});

test('unknown source placeholders cannot be confirmed but can be dismissed and reset without financial changes', t => {
  const store = memory(t);
  const head = 'Dato;Beløp;Fra konto;Til konto;Fra kontonummer;Til kontonummer;Type;Tekst;Hovedkategori;Underkategori';
  store.ingest({ adapter: 'norwegian-bank-csv', content: head + '\n2026-01-01;-1.05;Cash;;fixture-cash;0;Betaling;Placeholder source;Food;' });
  const row = store.getTransactions().transactions[0], before = store.exportLedger().tables;
  const input = { transactionId: row.id, side: 'to', endpointId: row.toEndpointId };
  assert.equal(row.toEndpoint.evidence.kind, 'unknown');
  assert.throws(() => store.updateAccountMembership({ ...input, status: 'confirmed' }), /Unknown source placeholders/);
  assert.deepEqual(store.exportLedger().tables, before);
  store.updateAccountMembership({ ...input, status: 'dismissed' });
  assert.equal(store.getEndpointActivity(row.toEndpointId).summary.payments, 0);
  store.updateAccountMembership({ ...input, status: null });
  assert.equal(store.getTransactionDetail(row.id).transaction.toMembership.status, 'suggested');
});

test('a source side newly identified as owned suspends a conflicting historical external assignment', t => {
  const store = memory(t), { a, b } = seed(store);
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: b.toEndpointId, status: 'confirmed' });
  const saved = store.getAccountMemberships();
  store.ingest({ adapter: 'canonical-v1', data: { accounts: [{ externalId: 'recipient-a', name: 'Actual owned reserve' }] } });
  const detail = store.getTransactionDetail(a.id);
  assert.ok(detail.sourceTo.owned);
  assert.equal(detail.to.id, detail.sourceTo.id);
  assert.equal(detail.transaction.toMembership.status, 'owned');
  assert.equal(detail.transaction.toMembership.reviewRequired, true);
  assert.equal(detail.transaction.toMembership.decisionStatus, 'confirmed');
  assert.equal(detail.transaction.toMembership.decisionEndpointId, b.toEndpointId);
  assert.deepEqual(store.getAccountMemberships(), saved, 'suspension is a read-only projection; historical decisions stay exported');
  const oldTarget = store.getEndpointActivity(b.toEndpointId), candidate = oldTarget.transactions.find(row => row.id === a.id);
  assert.equal(candidate.membershipStatus, 'dismissed');
  assert.equal(candidate.memberships[0].reviewRequired, true);
  assert.equal(candidate.memberships[0].decisionStatus, 'confirmed');
  assert.equal(oldTarget.summaries.confirmed.incoming, 0);
  const sourceActivity = store.getEndpointActivity(detail.sourceTo.id);
  assert.ok(sourceActivity.transactions.some(row => row.id === a.id && row.membershipStatus === 'owned'));
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: detail.transaction.toMembership.decisionEndpointId, status: null });
  assert.equal(store.getTransactionDetail(a.id).transaction.toMembership.reviewRequired, false);
});

test('promoting a different confirmed target to owned cannot invent money movement into that owned account', t => {
  const store = memory(t), { a, b } = seed(store);
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: b.toEndpointId, status: 'confirmed' });
  store.ingest({ adapter: 'canonical-v1', data: { accounts: [{ externalId: 'recipient-b', name: 'Owned account B' }] } });
  const detail = store.getTransactionDetail(a.id), promoted = store.getEndpointActivity(b.toEndpointId);
  assert.equal(detail.to.id, a.toEndpointId);
  assert.equal(detail.transaction.toMembership.reviewRequired, true);
  assert.equal(detail.transaction.toMembership.decisionStatus, 'confirmed');
  assert.equal(detail.transaction.toMembership.status, 'suggested');
  const candidate = promoted.transactions.find(row => row.id === a.id);
  assert.equal(candidate.membershipStatus, 'dismissed');
  assert.equal(candidate.memberships[0].isEffective, false);
  assert.equal(promoted.summary.incoming, 210, 'only the actual source payment B reaches this owned account');
  assert.equal(promoted.summaries.dismissed.incoming, 105);
});

test('direct dismissals stay explicit ahead of derived other-target dismissals, with representative category totals once per flow', t => {
  const store = memory(t), { a, b } = seed(store);
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: 'dismissed' });
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: b.toEndpointId, status: 'confirmed' });
  let row = store.getEndpointActivity(a.toEndpointId).transactions.find(row => row.id === a.id);
  assert.equal(row.memberships[0].explicit, true);
  assert.equal(row.memberships[0].provenance, 'owner');
  store.updateAccountMembership({ transactionId: a.id, side: 'to', endpointId: a.toEndpointId, status: null });
  row = store.getEndpointActivity(a.toEndpointId).transactions.find(row => row.id === a.id);
  assert.equal(row.memberships[0].explicit, false);
  assert.equal(row.memberships[0].provenance, 'owner-other-target');
  const target = store.getEndpointActivity(b.toEndpointId);
  assert.equal(target.summaries.active.payments, 2);
  assert.equal(target.categorySummaries.active.reduce((sum, category) => sum + category.payments, 0), 2);
  assert.equal(new Set(target.transactions.map(row => row.flowId)).size, 2);
});
