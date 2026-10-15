import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/server/database.js';

const headers = 'Dato;Beløp;Originalt Beløp;Original Valuta;Til konto;Til kontonummer;Fra konto;Fra kontonummer;Type;Tekst;KID;Hovedkategori;Underkategori';
function row({ amount = '-1.05', from = 'Everyday', fromId = 'fixture-cash', to = '', toId = 'fixture-shop', type = 'Betaling', text = 'Synthetic payment', category = 'Food', date = '2026-01-01' } = {}) {
  return [date, amount, amount, 'NOK', to, toId, from, fromId, type, text, 'fixture-reference', category, ''].join(';');
}
const bank = rows => ({ adapter: 'norwegian-bank-csv', content: [headers, ...rows].join('\n') });
const canonical = data => ({ adapter: 'canonical-v1', data });
function memory(t) { const store = createStore(); t.after(() => store.close()); return store; }
function fixture(store) {
  store.ingest(bank([
    row(), row(),
    row({ amount: '0.55', from: '', fromId: 'fixture-shop', to: 'Everyday', toId: 'fixture-cash', text: 'Synthetic refund' }),
    row({ amount: '1000.00', from: '', fromId: 'fixture-employer', to: 'Everyday', toId: 'fixture-cash', type: 'Inntekt', text: 'Synthetic salary', category: 'Income' }),
    row({ amount: '-50.00', to: 'Reserve', toId: 'fixture-reserve', type: 'Overføring', text: 'Debit transfer leg' }),
    row({ amount: '50.00', to: 'Reserve', toId: 'fixture-reserve', type: 'Overføring', text: 'Credit transfer leg' })
  ]));
}

test('account endpoint directory covers both owned and external directions without adding balance accounts', t => {
  const store = memory(t); fixture(store);
  const owned = store.getAccounts().accounts;
  assert.equal(owned.length, 2);
  const directory = store.getEndpoints().endpoints;
  assert.equal(directory.length, 4);
  const cash = directory.find(endpoint => endpoint.name === 'Everyday');
  const reserve = directory.find(endpoint => endpoint.name === 'Reserve');
  const shop = directory.find(endpoint => endpoint.counterpartyName === 'Synthetic refund');
  assert.ok(shop && !shop.owned);
  assert.equal(shop.labelSource, 'provider-text');
  assert.equal(shop.kind, 'merchant-hint');
  assert.equal(shop.evidence.isAccountIdentifier, false);
  assert.equal(shop.name, 'fixture-shop');
  assert.deepEqual(cash.summary, { incoming: 100055, outgoing: 5210, net: 94845, incomingPayments: 2, outgoingPayments: 3, largestPayment: 100000, payments: 5, transactionRows: 6, internalPayments: 1, firstDate: '2026-01-01', lastDate: '2026-01-01' });
  assert.equal(reserve.summary.incoming, 5000);
  assert.equal(reserve.summary.outgoing, 0);
  assert.equal(reserve.summary.payments, 1);
  assert.equal(reserve.summary.transactionRows, 2);
  assert.equal(shop.summary.incoming, 210);
  assert.equal(shop.summary.outgoing, 55);
  assert.equal(shop.summary.payments, 3);
  const normalData = JSON.stringify([directory, store.getTransactions()]);
  for (const identifier of ['fixture-cash', 'fixture-reserve']) assert.equal(normalData.includes(identifier), false);
  assert.ok(store.getTransactions().transactions.every(transaction => transaction.fromEndpointId && transaction.toEndpointId));
});

test('transaction detail exposes both endpoints, effective edits, original facts, and source provenance', t => {
  const store = memory(t); fixture(store);
  const tx = store.getTransactions().transactions.find(transaction => transaction.amount === -105);
  store.updateOverride({ id: tx.id, override: { kind: 'saving', category: 'Owner category', excludeForecast: true } });
  const detail = store.getTransactionDetail(tx.id);
  assert.equal(detail.transaction.id, tx.id);
  assert.equal(detail.transaction.amount, -105);
  assert.equal(detail.transaction.kind, 'saving');
  assert.equal(detail.original.kind, 'expense');
  assert.equal(detail.override.category, 'Owner category');
  assert.ok(detail.from.owned);
  assert.equal(detail.to.owned, false);
  assert.equal(detail.from.id, tx.fromEndpointId);
  assert.equal(detail.to.id, tx.toEndpointId);
  assert.ok(detail.from.identifiers.some(identifier => identifier.value === 'fixture-cash'));
  assert.ok(detail.to.identifiers.some(identifier => identifier.value === 'fixture-shop'));
  assert.equal(detail.sourceFields.KID, 'fixture-reference');
  assert.equal(detail.sourceFields['Original Valuta'], 'NOK');
  assert.equal(detail.provenance.length, 1);
  assert.equal(detail.provenance[0].adapter, 'norwegian-bank-csv');
  assert.ok(Number.isInteger(detail.provenance[0].rowNumber));
  assert.equal(store.getTransactionDetail('missing'), null);
});

test('endpoint activity spans all imported dates and keeps every mirrored row while counting movements once', t => {
  const store = memory(t); fixture(store);
  store.ingest(bank([row({ date: '2025-01-01', amount: '-2.05', text: 'Earlier synthetic payment' })]));
  const cash = store.getAccounts().accounts.find(account => account.name === 'Everyday');
  store.updateAccount({ id: cash.id, balance: 105, balanceDate: '2026-01-01', role: 'available' });
  store.updateAccount({ id: cash.id, balance: null, balanceDate: '2026-01-02' });
  const activity = store.getEndpointActivity(cash.id);
  assert.equal(activity.coverage.allHistory, true);
  assert.equal(activity.coverage.firstDate, '2025-01-01');
  assert.equal(activity.summary.payments, 6);
  assert.equal(activity.summary.transactionRows, 7);
  assert.equal(activity.transactions.length, 7);
  const transfer = activity.flows.find(flow => flow.internal);
  assert.equal(transfer.amount, 5000);
  assert.equal(transfer.pairedRows, true);
  assert.equal(transfer.transactionIds.length, 2);
  assert.equal(transfer.pairing, 'matched-bank-export-legs');
  assert.equal(activity.transactions.filter(transaction => transaction.pairedRows).length, 2);
  assert.equal(activity.endpoint.balance, null);
  assert.deepEqual(activity.endpoint.balanceHistory.map(snapshot => ({ ...snapshot })), [{ date: '2026-01-02', amount: null }, { date: '2026-01-01', amount: 105 }]);
  assert.equal(store.getEndpointActivity('missing'), null);
});

test('leg pairing preserves repeated internal payments and does not pair opposite directions or canonical provider IDs', t => {
  const store = memory(t);
  const debit = row({ amount: '-50.00', to: 'Reserve', toId: 'fixture-reserve', type: 'Overføring' });
  const credit = row({ amount: '50.00', to: 'Reserve', toId: 'fixture-reserve', type: 'Overføring' });
  store.ingest(bank([debit, debit, credit, row({ amount: '-50.00', from: 'Reserve', fromId: 'fixture-reserve', to: 'Everyday', toId: 'fixture-cash', type: 'Overføring' })]));
  const cash = store.getAccounts().accounts.find(account => account.name === 'Everyday');
  const activity = store.getEndpointActivity(cash.id);
  assert.equal(activity.summary.payments, 3);
  assert.equal(activity.summary.outgoing, 10000);
  assert.equal(activity.summary.incoming, 5000);
  assert.equal(activity.summary.transactionRows, 4);
  store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Canonical cash' }, { externalId: 'reserve', name: 'Canonical reserve' }], transactions: [
    { externalId: 'debit-id', date: '2026-01-01', amount: -5000, kind: 'transfer', fromAccountExternalId: 'cash', toAccountExternalId: 'reserve' },
    { externalId: 'credit-id', date: '2026-01-01', amount: 5000, kind: 'transfer', fromAccountExternalId: 'cash', toAccountExternalId: 'reserve' }
  ] }));
  const canonicalCash = store.getAccounts().accounts.find(account => account.name === 'Canonical cash');
  assert.equal(store.getEndpointActivity(canonicalCash.id).summary.payments, 2);
});

test('canonical external account metadata remains outside owned balances and survives idempotent import', t => {
  const store = memory(t);
  const input = canonical({ accounts: [{ externalId: 'cash', name: 'Cash' }], counterparties: [{ externalId: 'shop-party', name: 'Example shop party' }], transactions: [
    { externalId: 'payment', date: '2026-01-01', amount: -105, accountExternalId: 'cash', counterpartyExternalId: 'shop-party', toExternalAccount: { externalId: 'shop-account', name: 'Recipient supplied label' } },
    { externalId: 'refund', date: '2026-01-02', amount: 55, accountExternalId: 'cash', counterpartyExternalId: 'shop-party', fromExternalAccount: { externalId: 'shop-account', name: 'Recipient supplied label' } }
  ] });
  store.ingest(input);
  const directory = store.getEndpoints().endpoints;
  const external = directory.find(endpoint => !endpoint.owned);
  assert.equal(directory.length, 2);
  assert.equal(external.name, 'Recipient supplied label');
  assert.equal(external.labelSource, 'source-label');
  assert.equal(external.counterpartyName, 'Example shop party');
  assert.equal(external.summary.net, 50);
  assert.equal(store.getAccounts().accounts.length, 1);
  assert.equal(store.getAccounts().totals.missingAvailable, 1);
  assert.equal(store.ingest(input).duplicate, true);
  assert.equal(store.getEndpoints().endpoints.find(endpoint => !endpoint.owned).id, external.id);
  const party = store.getMetadata().counterparties[0];
  assert.equal(store.getCounterpartyActivity(party.id).summary.net, 50);
  assert.equal(store.getCounterpartyActivity('missing'), null);
  assert.throws(() => store.ingest(canonical({ transactions: [{ externalId: 'invalid', date: '2026-01-01', amount: -105, toExternalAccount: { name: 'Missing ID' } }] })), /identity/);
});

test('party-only and unknown zero direction remain inspectable without invented account endpoints', t => {
  const store = memory(t);
  store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Cash' }], counterparties: [{ externalId: 'shop', name: 'Shop' }], transactions: [
    { externalId: 'payment', date: '2026-01-01', amount: -105, accountExternalId: 'cash', counterpartyExternalId: 'shop' },
    { externalId: 'zero', date: '2026-01-02', amount: 0, accountExternalId: 'cash' },
    { externalId: 'unknown', date: '2026-01-03', amount: -100 }
  ] }));
  const transactions = store.getTransactions().transactions;
  const payment = transactions.find(transaction => transaction.amount === -105);
  assert.ok(payment.toEndpointId.startsWith('party_'));
  const unknown = transactions.find(transaction => transaction.amount === -100);
  assert.equal(unknown.fromEndpointId, null);
  assert.equal(unknown.toEndpointId, null);
  const cash = store.getAccounts().accounts[0];
  const activity = store.getEndpointActivity(cash.id);
  assert.equal(activity.transactions.length, 2);
  assert.equal(activity.transactions.find(transaction => transaction.amount === 0).flowDirection, 'unknown');
  assert.equal(activity.summary.outgoing, 105);
});

test('activity projections are read-only, reflect later metadata edits, and retain endpoint identity across overlap', t => {
  const store = memory(t); fixture(store);
  const before = store.exportLedger().tables;
  const tx = store.getTransactions().transactions.find(transaction => transaction.amount === -105);
  const originalEndpoint = tx.toEndpointId;
  store.getEndpoints(); store.getEndpointActivity(originalEndpoint); store.getTransactionDetail(tx.id);
  assert.deepEqual(store.exportLedger().tables, before);
  store.ingest(bank([row({ category: 'Groceries' }), row({ category: 'Groceries' })]));
  assert.equal(store.getTransactionDetail(tx.id).to.id, originalEndpoint);
  assert.equal(store.getTransactionDetail(tx.id).provenance.length, 2);
  const cash = store.getAccounts().accounts.find(account => account.name === 'Everyday');
  store.updateAccount({ id: cash.id, name: 'Owner renamed account' });
  assert.equal(store.getTransactionDetail(tx.id).from.name, 'Owner renamed account');
  assert.equal(store.getTransactions().transactions.length, 6);
});

test('previously known owned identifiers remain browseable when a later source row omits account labels', t => {
  const store = memory(t); fixture(store);
  const cash = store.getAccounts().accounts.find(account => account.name === 'Everyday');
  store.ingest(bank([row({ amount: '-20.00', from: '', to: '', toId: 'fixture-reserve', text: 'Metadata-light transfer', date: '2026-01-02' })]));
  const transaction = store.getTransactions().transactions.find(row => row.description === 'Metadata-light transfer');
  assert.equal(transaction.fromAccountId, null);
  assert.equal(transaction.fromEndpointId, cash.id);
  assert.ok(store.getTransactionDetail(transaction.id).to.owned);
  assert.ok(store.getEndpointActivity(cash.id).transactions.some(row => row.id === transaction.id));
});

test('conflicting sender or receiver declarations are rejected instead of silently choosing an endpoint', t => {
  const store = memory(t);
  for (const side of ['from', 'to']) assert.throws(() => store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Cash' }], transactions: [{
    externalId: 'conflicting', date: '2026-01-01', amount: -105,
    [`${side}AccountExternalId`]: 'cash', [`${side}ExternalAccount`]: { externalId: 'elsewhere' }
  }] })), /both an owned account and an external account/);
  assert.equal(store.getAccounts().accounts.length, 0);
});

test('resolved owned endpoints keep relationship matching from treating missing legacy account labels as an external party', async t => {
  const { relatedTransactions } = await import('../src/lib/relationships.js');
  const store = memory(t); fixture(store);
  store.ingest(bank([
    row({ from: '', toId: 'fixture-unrelated-one', text: 'First distinct legacy transfer', date: '2026-01-02' }),
    row({ from: '', toId: 'fixture-unrelated-two', text: 'Second distinct legacy transfer', date: '2026-01-03' })
  ]));
  const rows = store.getTransactions().transactions;
  const first = rows.find(row => row.description === 'First distinct legacy transfer');
  const second = rows.find(row => row.description === 'Second distinct legacy transfer');
  assert.equal(first.fromAccountId, null);
  assert.ok(first.fromEndpoint.owned);
  assert.ok(first.fromEndpoint.accountId);
  assert.deepEqual(relatedTransactions(first, [second]), []);
});

test('newer source labels on older-dated transactions refresh the directory and every endpoint object consistently', t => {
  const store = memory(t);
  const older = { externalId: 'older', date: '2026-01-01', amount: -105, accountExternalId: 'cash', toExternalAccount: { externalId: 'recipient', name: 'Initial label' } };
  const newer = { ...older, externalId: 'newer', date: '2026-02-01' };
  store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Cash' }], transactions: [older, newer] }));
  store.ingest(canonical({ transactions: [{ ...older, toExternalAccount: { externalId: 'recipient', name: 'Corrected label' } }] }));
  const rows = store.getTransactions().transactions;
  assert.ok(rows.every(row => row.toEndpoint.name === 'Corrected label'));
  assert.equal(store.getEndpoints().endpoints.find(endpoint => !endpoint.owned).name, 'Corrected label');
  assert.equal(store.getTransactionDetail(rows.find(row => row.date === '2026-02-01').id).to.name, 'Corrected label');
  const id = rows[0].toEndpointId;
  store.ingest(canonical({ transactions: [{ ...older, externalId: 'omitted-label', date: '2026-03-01', toExternalAccount: { externalId: 'recipient' } }] }));
  assert.equal(store.getEndpointActivity(id).endpoint.name, 'Corrected label', 'omitted optional label does not erase a supplied label');
});

test('a shared external account does not attribute different parties\' payments to one inferred party', t => {
  const store = memory(t);
  store.ingest(canonical({ accounts: [{ externalId: 'cash', name: 'Cash' }], counterparties: [{ externalId: 'one', name: 'Merchant one' }, { externalId: 'two', name: 'Merchant two' }], transactions: [
    { externalId: 'one-payment', date: '2026-01-01', amount: -105, accountExternalId: 'cash', counterpartyExternalId: 'one', toExternalAccount: { externalId: 'processor-account' } },
    { externalId: 'two-payment', date: '2026-01-02', amount: -210, accountExternalId: 'cash', counterpartyExternalId: 'two', toExternalAccount: { externalId: 'processor-account' } }
  ] }));
  const external = store.getEndpoints().endpoints.find(endpoint => !endpoint.owned);
  assert.equal(external.counterpartyId, null);
  assert.equal(external.counterpartyName, null);
  assert.equal(external.summary.incoming, 315);
  const parties = store.getMetadata().counterparties;
  const one = store.getCounterpartyActivity(parties.find(party => party.name === 'Merchant one').id);
  const two = store.getCounterpartyActivity(parties.find(party => party.name === 'Merchant two').id);
  assert.equal(one.summary.incoming, 105);
  assert.equal(one.transactions.length, 1);
  assert.equal(two.summary.incoming, 210);
  assert.equal(two.transactions.length, 1);
  assert.equal(one.endpoints[0].id, two.endpoints[0].id);
});

test('an external endpoint promoted to a known owned account retains its old opaque drill-down URL', t => {
  const store = memory(t);
  store.ingest(bank([row({ text: 'Original recipient payment' })]));
  const original = store.getTransactions().transactions[0];
  const externalId = original.toEndpointId;
  assert.equal(store.getEndpointActivity(externalId).endpoint.owned, false);
  store.ingest(bank([row({ to: 'Newly identified owned account', text: 'New metadata payment', date: '2026-01-02' })]));
  const canonical = store.getTransactionDetail(original.id).to;
  assert.ok(canonical.owned);
  assert.notEqual(canonical.id, externalId);
  assert.equal(store.getEndpointActivity(externalId).endpoint.id, canonical.id);
  assert.equal(store.getEndpointActivity(externalId).transactions.length, 2);
  assert.equal(store.getEndpoints().endpoints.filter(endpoint => endpoint.accountId === canonical.id).length, 1);
});

test('mirrored self-transfer legs remain visible but count as one zero-net movement', t => {
  const store = memory(t);
  store.ingest(bank([
    row({ amount: '-1.05', from: 'Cash', fromId: 'fixture-cash', to: 'Cash', toId: 'fixture-cash', type: 'Overføring', text: 'Self debit' }),
    row({ amount: '1.05', from: 'Cash', fromId: 'fixture-cash', to: 'Cash', toId: 'fixture-cash', type: 'Overføring', text: 'Self credit' })
  ]));
  const account = store.getAccounts().accounts[0];
  const activity = store.getEndpointActivity(account.id);
  assert.equal(activity.summary.payments, 1);
  assert.equal(activity.summary.transactionRows, 2);
  assert.equal(activity.summary.incoming, 105);
  assert.equal(activity.summary.outgoing, 105);
  assert.equal(activity.summary.net, 0);
  assert.equal(activity.summary.incomingPayments, 1);
  assert.equal(activity.summary.outgoingPayments, 1);
  assert.equal(activity.summary.largestPayment, 105);
  assert.ok(activity.transactions.every(transaction => transaction.flowDirection === 'self' && transaction.flowAmount === 0));
  assert.equal(activity.flows[0].pairedRows, true);
});


test('payment statistics follow confirmation and category, counting mirrored transfers once', t => {
  const store = memory(t); fixture(store);
  const cash = store.getEndpoints().endpoints.find(endpoint => endpoint.name === 'Everyday');
  const activity = store.getEndpointActivity(cash.id);
  assert.equal(activity.summary.incomingPayments, 2);
  assert.equal(activity.summary.outgoingPayments, 3);
  assert.equal(activity.summary.largestPayment, 100000);
  const food = activity.categorySummaries.active.find(category => category.category === 'Food');
  assert.equal(food.outgoingPayments, 2);
  assert.equal(food.incomingPayments, 1);
  assert.equal(food.largestPayment, 105);
  const reserve = store.getEndpoints().endpoints.find(endpoint => endpoint.name === 'Reserve');
  assert.equal(reserve.summary.incomingPayments, 1);
  assert.equal(reserve.summary.largestPayment, 5000);
  const row = store.getTransactions().transactions.find(row => row.amount === -105);
  store.updateAccountMembership({ transactionId: row.id, side: 'to', endpointId: row.toEndpointId, status: 'dismissed' });
  const recipient = store.getEndpointActivity(row.toEndpointId);
  assert.equal(recipient.summary.incomingPayments, 1);
  assert.equal(recipient.summaries.dismissed.incomingPayments, 1);
});


test('zero-valued payments remain counted without becoming an average denominator', t => {
  const store = memory(t);
  store.ingest(bank([row({ amount: '0.00' })]));
  const account = store.getAccounts().accounts[0];
  const summary = store.getEndpointActivity(account.id).summary;
  assert.equal(summary.payments, 1);
  assert.equal(summary.incomingPayments, 0);
  assert.equal(summary.outgoingPayments, 0);
  assert.equal(summary.largestPayment, 0);
});

test('monthly endpoint history reconciles totals across gaps, categories and account confirmations', t => {
  const store = memory(t); fixture(store);
  store.ingest(bank([row({ date: '2026-03-05', amount: '-3.15' })]));
  const cash = store.getAccounts().accounts.find(account => account.name === 'Everyday');
  const detail = store.getEndpointActivity(cash.id);
  assert.deepEqual(detail.summary.monthly.map(point => point.month), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(detail.summary.monthly[1], { month: '2026-02', incoming: 0, outgoing: 0, payments: 0 });
  assert.equal(detail.summary.monthly.reduce((sum, point) => sum + point.incoming, 0), detail.summary.incoming);
  assert.equal(detail.summary.monthly.reduce((sum, point) => sum + point.outgoing, 0), detail.summary.outgoing);
  assert.equal(detail.summary.monthly.reduce((sum, point) => sum + point.payments, 0), detail.summary.payments);
  assert.equal(detail.summary.monthly[0].payments, 5, 'paired transfer rows contribute one payment');
  const payment = store.getTransactions().transactions.find(row => row.amount === -315);
  store.updateAccountMembership({ transactionId: payment.id, side: 'to', endpointId: payment.toEndpointId, status: 'confirmed' });
  const recipient = store.getEndpointActivity(payment.toEndpointId);
  assert.deepEqual(recipient.summaries.confirmed.monthly, [{ month: '2026-03', incoming: 315, outgoing: 0, payments: 1 }]);
  const category = recipient.categorySummaries.confirmed.find(item => item.category === 'Food');
  assert.deepEqual(category.monthly, recipient.summaries.confirmed.monthly);
  store.updateAccountMembership({ transactionId: payment.id, side: 'to', endpointId: payment.toEndpointId, status: 'dismissed' });
  const dismissed = store.getEndpointActivity(payment.toEndpointId);
  assert.equal(dismissed.summaries.confirmed.monthly.length, 0);
  assert.deepEqual(dismissed.summaries.dismissed.monthly, [{ month: '2026-03', incoming: 315, outgoing: 0, payments: 1 }]);
});
