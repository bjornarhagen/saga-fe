import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/server/database.js';
import { applyOverrides, baseline, summarize } from '../src/lib/engine.js';
import { valueHistory } from '../src/lib/account-values.js';
import { accountStartingPoint } from '../src/scripts/accounts.js';

const canonical = data => ({ adapter: 'canonical-v1', sourceKey: 'example-bank', data });
function memory(t) { const store = createStore(); t.after(() => store.close()); return store; }
function seed(store) {
  store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Everyday', accountType: 'checking', institution: 'Example Bank', balance: 2000000, balanceDate: '2026-01-01' }], transactions: [
    { externalId: 'deposit', date: '2026-01-05', amount: -500000, accountExternalId: 'cash', fromAccountExternalId: 'cash', description: 'Example contribution', toExternalAccount: { externalId: 'platform-collection', name: 'Example platform' } },
    { externalId: 'withdrawal', date: '2026-01-10', amount: 100000, accountExternalId: 'cash', toAccountExternalId: 'cash', description: 'Example withdrawal', fromExternalAccount: { externalId: 'platform-collection', name: 'Example platform' } },
    { externalId: 'other-customer', date: '2026-01-15', amount: -500, accountExternalId: 'cash', fromAccountExternalId: 'cash', description: 'Unlinked example payment', toExternalAccount: { externalId: 'platform-collection', name: 'Example platform' } }
  ] }));
  const tx = store.getTransactions().transactions;
  return { cash: store.getAccounts().accounts[0], deposit: tx.find(t => t.amount === -500000), withdrawal: tx.find(t => t.amount === 100000), unlinked: tx.find(t => t.amount === -500) };
}

test('manual bank and investment values retain dated history without creating transactions; same-date saves correct an observation', t => {
  const store = memory(t);
  const bank = store.createAccount({ name: 'Other bank', institution: 'Example Bank', accountType: 'savings', role: 'reserve', balance: 0, balanceDate: '2026-01-01' }).account;
  const investment = store.createAccount({ name: 'Investments', institution: 'Example Platform', accountType: 'investment', balance: 10000000, balanceDate: '2026-01-01' }).account;
  assert.equal(investment.role, 'excluded');
  store.updateAccount({ id: bank.id, balance: 12345, balanceDate: '2026-02-01' });
  store.updateAccount({ id: bank.id, balance: 12400, balanceDate: '2026-02-01' });
  store.updateAccount({ id: bank.id, institution: 'Renamed institution' });
  const account = store.getAccounts().accounts.find(a => a.id === bank.id);
  assert.deepEqual(account.valueHistory.map(v => [v.date, v.amount]), [['2026-01-01', 0], ['2026-02-01', 12400]]);
  assert.equal(account.valueHistory[1].unexplainedChange, 12400);
  assert.equal(account.imported, false);
  assert.equal(store.getTransactions().transactions.length, 0);
  assert.equal(store.getAccounts().totals.available, 0);
  assert.equal(store.getAccounts().totals.reserve, 12400);
  assert.throws(() => store.updateAccount({ id: investment.id, role: 'reserve' }), /Investment/);
  assert.throws(() => store.createAccount({ name: 'Invalid', accountType: 'investment', role: 'available' }), /Investment/);
  assert.throws(() => store.updateAccount({ id: bank.id, name: 'Bad edit', accountType: 'invalid' }), /type/);
  assert.equal(store.getAccounts().accounts.find(a => a.id === bank.id).name, 'Other bank');
  assert.equal(accountStartingPoint([investment]).ready, false);
});

test('per-payment ownership links separate contributions, withdrawals and value change without globally claiming the platform recipient', t => {
  const store = memory(t), { deposit, withdrawal, unlinked } = seed(store);
  const investment = store.createAccount({ name: 'Investment holdings', accountType: 'investment', balance: 10000000, balanceDate: '2026-01-01' }).account;
  const originals = store.exportLedger().tables.transactions;
  store.updateOverride({ id: deposit.id, override: { toOwnedAccountId: investment.id } });
  store.updateOverride({ id: withdrawal.id, override: { fromOwnedAccountId: investment.id } });
  store.updateAccount({ id: investment.id, balance: 10700000, balanceDate: '2026-02-01' });
  const data = store.getTransactions();
  const effective = applyOverrides(data.transactions, data.overrides);
  assert.equal(effective.find(t => t.id === deposit.id).kind, 'saving');
  assert.equal(effective.find(t => t.id === withdrawal.id).kind, 'income');
  assert.equal(effective.find(t => t.id === withdrawal.id).regularIncome, false);
  assert.equal(effective.find(t => t.id === unlinked.id).kind, 'expense');
  const values = data.accountDetails.find(a => a.id === investment.id).valueHistory;
  assert.equal(values[1].change, 700000);
  assert.equal(values[1].recordedMovement, 400000);
  assert.equal(values[1].unexplainedChange, 300000);
  assert.equal(store.getEndpointActivity(investment.id).summary.payments, 2);
  assert.equal(store.getEndpointActivity(deposit.toEndpointId).summary.payments, 1);
  assert.deepEqual(store.exportLedger().tables.transactions, originals);
  const detail = store.getTransactionDetail(deposit.id);
  assert.equal(detail.original.kind, 'expense');
  assert.equal(detail.sourceTo.owned, false);
  assert.equal(detail.to.accountId, investment.id);
  const forecast = baseline(effective, '2026-02-14', 1, '2026-01-01');
  assert.equal(forecast.saving, 500000);
  assert.equal(forecast.income, 0, 'withdrawals do not become recurring income');
});

test('own-bank links follow the available cash boundary and preserve explicit classifications, reversibility and source facts', t => {
  const store = memory(t), { deposit, cash } = seed(store);
  const other = store.createAccount({ name: 'Other bank', accountType: 'checking' }).account;
  store.updateOverride({ id: deposit.id, override: { toOwnedAccountId: other.id, category: 'My transfers' } });
  assert.equal(store.getTransactionDetail(deposit.id).transaction.kind, 'transfer');
  store.updateAccount({ id: other.id, role: 'reserve' });
  assert.equal(store.getTransactionDetail(deposit.id).transaction.kind, 'saving');
  store.updateOverride({ id: deposit.id, override: { toOwnedAccountId: other.id, kind: 'transfer', excludeForecast: true } });
  assert.equal(store.getTransactionDetail(deposit.id).transaction.kind, 'transfer');
  const before = store.exportLedger().tables;
  for (const override of [{ toOwnedAccountId: 'missing' }, { fromOwnedAccountId: other.id }, { toOwnedAccountId: '' }]) assert.throws(() => store.updateOverride({ id: deposit.id, override }));
  assert.throws(() => store.saveOverrides({ [deposit.id]: { fromOwnedAccountId: other.id } }));
  assert.deepEqual(store.exportLedger().tables, before);
  store.updateOverride({ id: deposit.id, override: null });
  assert.equal(store.getTransactionDetail(deposit.id).transaction.kind, 'expense');
  assert.equal(store.getEndpointActivity(other.id).summary.payments, 0);
  assert.equal(store.getTransactionDetail(deposit.id).from.accountId, cash.id);
});

test('mirrored contributions from separate imports count once in manual value history and cash outflows', t => {
  const store = memory(t), { cash, deposit } = seed(store);
  const investment = store.createAccount({ name: 'Investments', accountType: 'investment', balance: 0, balanceDate: '2026-01-01' }).account;
  store.updateOverride({ id: deposit.id, override: { toOwnedAccountId: investment.id } });
  store.ingest({ adapter: 'canonical-v1', sourceKey: 'example-investments', data: {
    accounts: [{ externalId: 'portfolio', id: investment.id, name: 'Investments' }, { externalId: 'source-bank', id: cash.id, name: 'Everyday' }],
    transactions: [{ externalId: 'mirrored-deposit', date: '2026-01-05', amount: 500000, accountExternalId: 'portfolio', fromAccountExternalId: 'source-bank', toAccountExternalId: 'portfolio' }]
  } });
  store.updateAccount({ id: investment.id, balance: 600000, balanceDate: '2026-02-01' });
  const activity = store.getEndpointActivity(investment.id);
  assert.equal(activity.summary.incoming, 500000);
  assert.equal(activity.summary.payments, 1);
  assert.equal(activity.summary.transactionRows, 2);
  assert.equal(activity.endpoint.valueHistory[1].recordedMovement, 500000);
  const d = store.getTransactions(), totals = summarize(applyOverrides(d.transactions, d.overrides));
  assert.equal(totals.saving, 500000);
});

test('value change is unknown across unknown observations; dates bound recorded movement and large residuals remain exact or unknown', () => {
  const account = { accountId: 'investment' };
  const history = valueHistory([{ date: '2026-01-01', amount: 100 }, { date: '2026-01-02', amount: 200 }], [
    { date: '2026-01-01', amount: 500, to: account }, { date: '2026-01-02', amount: 50, to: account }, { date: '2026-01-03', amount: 1000, to: account }
  ], 'investment');
  assert.equal(history[1].unexplainedChange, 50);
  assert.equal(valueHistory([{ date: '2026-01-01', amount: null }, { date: '2026-01-02', amount: 100 }], [], 'investment')[1].change, null);
  assert.equal(valueHistory([{ date: '2026-01-01', amount: -Number.MAX_SAFE_INTEGER }, { date: '2026-01-02', amount: Number.MAX_SAFE_INTEGER }], [], 'investment')[1].change, null);
});

test('version-three migration, reimports, reopen and backup preserve owner profiles, value history and payment links', async t => {
  const root = mkdtempSync(join(tmpdir(), 'saga-fe-values-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.sqlite'), backup = join(root, 'backup.sqlite');
  let store = createStore(path); const { deposit } = seed(store);
  store.saveSettings({ fields: { cash: '123.45' } });
  store.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE account_profiles; DROP TABLE transaction_category_decisions; PRAGMA user_version=3'); legacy.close();
  store = createStore(path);
  assert.equal(store.getAccounts().accounts[0].accountType, 'other');
  assert.equal(store.getSettings().fields.cash, '123.45');
  const investment = store.createAccount({ name: 'Manual investment', accountType: 'investment', institution: 'Owner platform', balance: 100000, balanceDate: '2026-01-01' }).account;
  store.updateAccount({ id: investment.id, balance: 200000, balanceDate: '2026-02-01' });
  store.updateOverride({ id: deposit.id, override: { toOwnedAccountId: investment.id } });
  store.ingest(canonical({ accounts: [{ externalId: 'linked-investment', id: investment.id, name: 'Provider name', accountType: 'savings', institution: 'Provider bank' }] }));
  assert.equal(store.getAccounts().accounts.find(a => a.id === investment.id).institution, 'Owner platform');
  assert.equal(store.getAccounts().accounts.find(a => a.id === investment.id).accountType, 'investment');
  await store.backup(backup);
  const expected = store.exportLedger().tables; store.close();
  for (const location of [path, backup]) {
    const reopened = createStore(location);
    assert.deepEqual(reopened.exportLedger().tables, expected);
    assert.equal(reopened.getTransactionDetail(deposit.id).transaction.kind, 'saving');
    reopened.close();
  }
});


test('version-four category decisions survive account-profile migration and later category edits preserve owned-payment links', t => {
  const root = mkdtempSync(join(tmpdir(), 'saga-fe-values-v4-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.sqlite');
  let store = createStore(path); const { deposit } = seed(store);
  store.updateCategories({ transactionIds: [deposit.id], category: 'Owner savings category', status: 'user_applied' });
  store.saveSettings({ fields: { cash: '123.45' } });
  const before = store.exportLedger().tables; delete before.account_profiles; store.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE account_profiles; PRAGMA user_version=4'); legacy.close();
  store = createStore(path); t.after(() => store.close());
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(store.exportLedger().tables[table], rows);
  assert.equal(store.getTransactionDetail(deposit.id).transaction.category, 'Owner savings category');
  const investment = store.createAccount({ name: 'Investment account', accountType: 'investment' }).account;
  store.updateOverride({ id: deposit.id, override: { toOwnedAccountId: investment.id, excludeForecast: true } });
  store.updateCategories({ transactionIds: [deposit.id], category: 'Another chosen category', status: 'user_applied' });
  let detail = store.getTransactionDetail(deposit.id);
  assert.equal(detail.transaction.kind, 'saving');
  assert.equal(detail.transaction.category, 'Another chosen category');
  assert.equal(detail.to.accountId, investment.id);
  assert.equal(detail.transaction.excludeForecast, true);
  store.updateCategories({ transactionIds: [deposit.id], status: null });
  detail = store.getTransactionDetail(deposit.id);
  assert.equal(detail.to.accountId, investment.id);
  assert.equal(detail.transaction.kind, 'saving');
});
