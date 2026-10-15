import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, DATABASE_SCHEMA_VERSION } from '../src/server/database.js';
import { summarize } from '../src/lib/engine.js';

const canonical = (data, sourceKey = 'bank-a') => ({ adapter: 'canonical-v1', sourceKey, data });
function seed(store) {
  store.ingest(canonical({ accounts: [{ externalId: 'cash-a', name: 'Bank A cash' }], transactions: [
    { externalId: 'out', date: '2026-01-02', amount: -105, accountExternalId: 'cash-a', fromAccountExternalId: 'cash-a', toExternalAccount: { externalId: 'cash-b', name: 'Bank B cash' } },
    { externalId: 'in', date: '2026-01-03', amount: 210, accountExternalId: 'cash-a', toAccountExternalId: 'cash-a', fromExternalAccount: { externalId: 'cash-b', name: 'Bank B cash' }, regularIncome: true }
  ] }));
  const rows = store.getTransactions().transactions;
  return { out: rows.find(row => row.amount < 0), incoming: rows.find(row => row.amount > 0), cash: store.getAccounts().accounts[0] };
}
function memory(t) { const store = createStore(); t.after(() => store.close()); return store; }

test('account-wide ownership covers both directions, future imports and old URLs without changing source facts or edits', t => {
  const store = memory(t), { out, incoming } = seed(store);
  store.updateOverride({ id: out.id, override: { category: 'My category', excludeForecast: true } });
  const before = store.exportLedger().tables;
  const input = { endpointId: out.toEndpointId, account: { name: 'My Bank B account', institution: 'Bank B', accountType: 'checking' } };
  const result = store.updateAccountOwnership(input);
  assert.deepEqual(store.updateAccountOwnership(input), result, 'retry must not create another account');
  const detail = store.getTransactionDetail(out.id);
  assert.equal(detail.to.accountId, result.accountId);
  assert.equal(detail.transaction.toMembership.provenance, 'owner-account-ownership');
  assert.equal(detail.transaction.kind, 'transfer');
  assert.equal(detail.transaction.category, 'My category');
  assert.equal(detail.transaction.excludeForecast, true);
  assert.equal(store.getTransactionDetail(incoming.id).transaction.regularIncome, false);
  assert.equal(store.getTransactionDetail(incoming.id).from.accountId, result.accountId);
  const totals = summarize([out, incoming].map(row => store.getTransactionDetail(row.id).transaction));
  assert.equal(totals.income, 0); assert.equal(totals.expense, 0); assert.equal(totals.net, 0);
  assert.equal(store.getEndpointActivity(out.toEndpointId).endpoint.id, result.accountId);
  assert.equal(store.getEndpoints().endpoints.some(node => node.id === out.toEndpointId), false);
  assert.equal(store.getEndpointActivity(result.accountId).endpoint.ownershipLinks[0].endpointId, out.toEndpointId);
  assert.equal(store.getEndpointActivity(result.accountId).endpoint.ownershipLinks[0].identifierSuffix, 'sh-b');
  for (const table of ['transactions', 'ingest_rows', 'account_identifiers', 'transaction_edits', 'balance_snapshots']) assert.deepEqual(store.exportLedger().tables[table], before[table]);
  store.ingest(canonical({ transactions: [{ externalId: 'later', date: '2026-02-01', amount: -315, accountExternalId: 'cash-a', toExternalAccount: { externalId: 'cash-b' } }] }));
  assert.equal(store.getTransactions().transactions[0].toEndpoint.accountId, result.accountId);
  store.updateAccountOwnership({ endpointId: out.toEndpointId, accountId: null });
  assert.equal(store.getTransactionDetail(out.id).to.owned, false);
  assert.equal(store.getTransactionDetail(out.id).transaction.kind, 'expense');
  assert.deepEqual(store.getOverrides(), Object.fromEntries(before.transaction_edits.map(row => [row.transaction_id, JSON.parse(row.value_json)])));
  assert.equal(store.getAccounts().accounts.length, 2, 'undo keeps the tracked account');
});

test('linking an existing reserve or investment uses cash roles and keeps explicit transaction classifications', t => {
  const store = memory(t), { out, incoming } = seed(store);
  const reserve = store.createAccount({ name: 'Bank B reserve', accountType: 'savings', role: 'reserve', balance: 500, balanceDate: '2026-01-01' }).account;
  store.updateAccountOwnership({ endpointId: out.toEndpointId, accountId: reserve.id });
  assert.equal(store.getAccounts().accounts.length, 2);
  assert.equal(store.getTransactionDetail(out.id).transaction.kind, 'saving');
  assert.equal(store.getTransactionDetail(incoming.id).transaction.kind, 'income');
  assert.equal(store.getTransactionDetail(incoming.id).transaction.regularIncome, false);
  store.updateAccount({ id: reserve.id, accountType: 'investment', role: 'excluded', balance: 800, balanceDate: '2026-02-01' });
  assert.equal(store.getTransactionDetail(out.id).transaction.kind, 'saving');
  assert.equal(store.getEndpointActivity(reserve.id).endpoint.valueHistory[1].recordedMovement, -105);
  store.updateOverride({ id: out.id, override: { kind: 'expense' } });
  assert.equal(store.getTransactionDetail(out.id).transaction.kind, 'expense');
  store.updateAccountOwnership({ endpointId: out.toEndpointId, accountId: null });
  assert.equal(store.getAccounts().accounts.find(row => row.id === reserve.id).balance, 800);
});

test('cross-bank exports pair mirrored transfer legs once after both source identities are linked', t => {
  const store = memory(t), { out, cash } = seed(store);
  const bankB = store.updateAccountOwnership({ endpointId: out.toEndpointId, account: { name: 'Bank B' } }).accountId;
  store.ingest(canonical({ accounts: [{ externalId: 'bank-b-owned', id: bankB, name: 'Bank B imported' }], transactions: [{ externalId: 'credit-leg', date: out.date, amount: 105, accountExternalId: 'bank-b-owned', toAccountExternalId: 'bank-b-owned', fromExternalAccount: { externalId: 'bank-a-external' } }] }, 'bank-b'));
  const leg = store.getTransactions().transactions.find(row => row.amount === 105);
  store.updateAccountOwnership({ endpointId: leg.fromEndpointId, accountId: cash.id });
  const activity = store.getEndpointActivity(bankB);
  assert.equal(activity.summary.payments, 2, 'two movements, including the separate withdrawal');
  assert.equal(activity.summary.transactionRows, 3);
  const flow = activity.flows.find(flow => flow.date === out.date);
  assert.equal(flow.pairedRows, true); assert.equal(flow.internal, true);
  assert.equal(flow.amount, 105); assert.equal(flow.transactionIds.length, 2);
  assert.equal(store.getAccounts().accounts.length, 2);
});

test('ownership is source-scoped and a later account metadata import adopts the linked account', t => {
  const store = memory(t), { out } = seed(store);
  const accountId = store.updateAccountOwnership({ endpointId: out.toEndpointId, account: { name: 'Owner name', institution: 'Owner bank' } }).accountId;
  store.ingest(canonical({ transactions: [{ externalId: 'different-source', date: out.date, amount: -105, toExternalAccount: { externalId: 'cash-b' } }] }, 'other-bank'));
  const other = store.getTransactions().transactions.find(row => !row.accountId);
  assert.equal(other.toEndpoint.owned, false);
  store.ingest(canonical({ accounts: [{ externalId: 'cash-b', name: 'Provider name' }] }));
  assert.equal(store.getAccounts().accounts.length, 2);
  assert.equal(store.getTransactionDetail(out.id).to.name, 'Owner name');
  store.updateAccountOwnership({ endpointId: out.toEndpointId, accountId: null });
  assert.equal(store.getTransactionDetail(out.id).to.accountId, accountId, 'later imported ownership remains a source fact');
});

test('global ownership cannot turn an alternate confirmed recipient into invented owned money movement', t => {
  const store = memory(t), { out } = seed(store);
  store.ingest(canonical({ transactions: [{ externalId: 'other-recipient', date: out.date, amount: -500, toExternalAccount: { externalId: 'different' } }] }));
  const other = store.getTransactions().transactions.find(row => row.amount === -500);
  store.updateAccountMembership({ transactionId: other.id, side: 'to', endpointId: out.toEndpointId, status: 'confirmed' });
  const decisions = store.getAccountMemberships();
  store.updateAccountOwnership({ endpointId: out.toEndpointId, account: { name: 'Mine' } });
  const detail = store.getTransactionDetail(other.id);
  assert.equal(detail.to.id, other.toEndpointId);
  assert.equal(detail.transaction.toMembership.reviewRequired, true);
  assert.deepEqual(store.getAccountMemberships(), decisions);
  store.updateAccountOwnership({ endpointId: out.toEndpointId, accountId: null });
  assert.equal(store.getTransactionDetail(other.id).to.id, out.toEndpointId);
});

test('ownership rejects merchant hints, placeholders, unknown targets and invalid profiles atomically', t => {
  const store = memory(t), { out, cash } = seed(store);
  const head = 'Dato;Beløp;Fra konto;Til konto;Fra kontonummer;Til kontonummer;Type;Tekst;Hovedkategori;Underkategori';
  store.ingest({ adapter: 'norwegian-bank-csv', content: head + '\n2026-01-01;-1.05;Cash;;fixture-cash;Example Merchant;Betaling;Hint;Food;\n2026-01-02;-2.10;Cash;;fixture-cash;0;Betaling;Placeholder;Food;' });
  const rows = store.getTransactions().transactions;
  const before = store.exportLedger().tables;
  for (const endpointId of [rows.find(row => row.description === 'Hint').toEndpointId, rows.find(row => row.description === 'Placeholder').toEndpointId, 'missing', cash.id]) {
    assert.throws(() => store.updateAccountOwnership({ endpointId, account: { name: 'Invalid' } }), /external account/);
  }
  assert.throws(() => store.updateAccountOwnership({ endpointId: out.toEndpointId, accountId: 'missing' }), /does not exist/);
  assert.throws(() => store.updateAccountOwnership({ endpointId: out.toEndpointId, account: { name: 'Invalid', accountType: 'investment', role: 'available' } }), /Investment/);
  assert.throws(() => store.updateAccountOwnership({ endpointId: out.toEndpointId, accountId: cash.id, account: { name: 'Both' } }), /Choose/);
  assert.deepEqual(store.exportLedger().tables, before);
});

test('numeric CSV account identifiers can be marked as owned without leaking into the directory', t => {
  const store = memory(t), identifier = '1111' + '11' + '11111';
  const head = 'Dato;Beløp;Fra konto;Til konto;Fra kontonummer;Til kontonummer;Type;Tekst;Hovedkategori;Underkategori';
  const content = head + `\n2026-01-01;-1.05;Cash;;fixture-cash;${identifier};Overføring;Cross bank;;`;
  store.ingest({ adapter: 'norwegian-bank-csv', content });
  const out = store.getTransactions().transactions[0];
  store.updateAccountOwnership({ endpointId: out.toEndpointId, account: { name: 'My other bank' } });
  assert.equal(store.getTransactionDetail(out.id).transaction.kind, 'transfer');
  assert.equal(JSON.stringify(store.getEndpoints()).includes(identifier), false);
  assert.equal(JSON.stringify(store.getTransactions()).includes(identifier), false);
  store.ingest({ adapter: 'norwegian-bank-csv', content });
  assert.equal(store.getTransactionDetail(out.id).transaction.kind, 'transfer');
});

test('schema-five migration, reopen, JSON archive and SQLite backup preserve ownership independently', async t => {
  const root = mkdtempSync(join(tmpdir(), 'saga-fe-ownership-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.sqlite'), backup = join(root, 'backup.sqlite');
  let store = createStore(path); const { out } = seed(store);
  store.saveSettings({ fields: { cash: '1.05' } });
  const before = store.exportLedger().tables; delete before.account_ownership; store.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE account_ownership; PRAGMA user_version=5'); legacy.close();
  store = createStore(path);
  assert.equal(store.exportLedger().databaseSchemaVersion, DATABASE_SCHEMA_VERSION);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(store.exportLedger().tables[table], rows);
  const result = store.updateAccountOwnership({ endpointId: out.toEndpointId, account: { name: 'My Bank B' } });
  const expected = store.exportLedger().tables;
  assert.equal(expected.account_ownership[0].account_id, result.accountId);
  await store.backup(backup); store.close();
  for (const location of [path, backup]) {
    const reopened = createStore(location);
    try {
      assert.deepEqual(reopened.exportLedger().tables, expected);
      assert.equal(reopened.getTransactionDetail(out.id).transaction.kind, 'transfer');
    } finally { reopened.close(); }
  }
});
