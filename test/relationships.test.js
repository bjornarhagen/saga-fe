import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRelationshipDecisions, describeRelationship, normalizePaymentDescription, relatedTransactions } from '../src/lib/relationships.js';

const transaction = overrides => ({
  id: 'selected', date: '2026-01-15', amount: -12000, currency: 'NOK',
  description: 'North Harbor Café', kind: 'expense', category: 'Food',
  accountId: 'cash', fromAccountId: 'cash', toAccountId: null,
  counterpartyId: null, ...overrides,
});

test('description normalization ignores limited bank wrappers without discarding references or branch numbers', () => {
  assert.equal(normalizePaymentDescription('  VAREKJØP:  North  Harbor Café  '), 'north harbor café');
  assert.equal(normalizePaymentDescription('Card purchase - North Harbor Café'), 'north harbor café');
  assert.equal(normalizePaymentDescription('Kortkjøp NORTH HARBOR CAFÉ'), 'north harbor café');
  assert.equal(normalizePaymentDescription('Shop #24 Ref ABC-789'), 'shop #24 ref abc-789');
  assert.notEqual(normalizePaymentDescription('Shop #24'), normalizePaymentDescription('Shop #42'));
  assert.notEqual(normalizePaymentDescription('Invoice REF ABC-789'), normalizePaymentDescription('Invoice REF ABC-987'));
  assert.notEqual(normalizePaymentDescription('Studio 4-2'), normalizePaymentDescription('Studio 42'));
  assert.equal(normalizePaymentDescription(undefined), '');
});

test('shared counterparty identity relates varying payments and refunds across dates and owning accounts', () => {
  const selected = transaction({ counterpartyId: 'party-cafe' });
  const payment = transaction({ id: 'next', date: '2026-02-15', amount: -13500, accountId: 'card', fromAccountId: 'card', counterpartyId: 'party-cafe', description: 'Receipt reference XX-123' });
  const refund = transaction({ id: 'refund', date: '2026-02-18', amount: 12000, fromAccountId: null, toAccountId: 'cash', counterpartyId: 'party-cafe', description: 'Refund' });
  const result = relatedTransactions(selected, [payment, refund]);
  assert.equal(result.length, 2);
  assert.ok(result.every(item => item.relation === 'counterparty' && item.certainty === 'identity-match'));
  assert.ok(result.every(item => item.reasons.includes('Same counterparty identity')));
  assert.ok(result.every(item => !item.possibleDuplicate));
});

test('primary opaque endpoint IDs and optional endpoint objects identify the same external party', () => {
  const selected = transaction({ toEndpointId: 'endpoint-external-cafe', description: 'Counter receipt A' });
  const candidate = transaction({ id: 'next', date: '2026-02-01', accountId: 'card', fromAccountId: 'card', toEndpoint: { id: 'endpoint-external-cafe', name: 'Label changed', owned: false }, description: 'Counter receipt B' });
  const result = describeRelationship(selected, candidate);
  assert.equal(result.relation, 'counterparty');
  assert.ok(result.reasons.includes('Same external sender or receiver'));
  assert.equal(result.possibleDuplicate, false);
});

test('sharing only an owned sender, amount, category or generic transfer text does not relate unrelated payments', () => {
  const selected = transaction({ description: 'Bank transfer', toEndpointId: 'recipient-a' });
  const others = [
    transaction({ id: 'b', description: 'Bank transfer', toEndpointId: 'recipient-b' }),
    transaction({ id: 'c', description: 'Transfer', toEndpointId: 'recipient-c' }),
    transaction({ id: 'd', description: 'Different merchant' }),
  ];
  assert.deepEqual(relatedTransactions(selected, others), []);
  const unlabelled = transaction({ accountId: null, fromAccountId: null, description: 'Payment #123' });
  assert.deepEqual(relatedTransactions(unlabelled, [transaction({ ...unlabelled, id: 'numeric-reference' })]), []);
});

test('owned route identities relate internal transfers in both directions without using account labels', () => {
  const selected = transaction({ description: 'Cash → Reserve', kind: 'transfer', toAccountId: 'reserve' });
  const same = transaction({ id: 'same', description: 'Monthly move', kind: 'transfer', toAccountId: 'reserve', date: '2026-02-15' });
  const reverse = transaction({ id: 'reverse', amount: 12000, description: 'Return cash', kind: 'transfer', accountId: 'cash', fromAccountId: 'reserve', toAccountId: 'cash' });
  const otherNames = transaction({ id: 'different-identity', description: 'Cash → Reserve', kind: 'transfer', accountId: 'other-cash', fromAccountId: 'other-cash', toAccountId: 'other-reserve', fromEndpoint: { id: 'other-cash', name: 'Cash', owned: true }, toEndpoint: { id: 'other-reserve', name: 'Reserve', owned: true } });
  const result = relatedTransactions(selected, [otherNames, reverse, same]);
  assert.deepEqual(result.map(item => item.transaction.id), ['same', 'reverse']);
  assert.ok(result[0].reasons.includes('Same sender and receiver'));
  assert.ok(result[1].reasons.includes('Same two endpoints in opposite directions'));
  assert.ok(result.every(item => !item.possibleDuplicate));
});

test('meaningful normalized descriptions provide clearly marked suggestions without claiming identity or cadence', () => {
  const selected = transaction({ description: 'Varekjøp: North Harbor Café' });
  const candidate = transaction({ id: 'again', date: '2026-03-19', amount: -16700, description: 'NORTH HARBOR CAFÉ' });
  const result = describeRelationship(selected, candidate);
  assert.equal(result.relation, 'description');
  assert.equal(result.certainty, 'description-suggestion');
  assert.equal(result.possibleDuplicate, false);
  assert.deepEqual(result.reasons, ['Same normalized merchant description']);
});

test('numbers and references are not erased to match unrelated descriptions', () => {
  const selected = transaction({ description: 'Market #24 REF A123' });
  assert.equal(describeRelationship(selected, transaction({ id: 'branch', description: 'Market #42 REF A123' })), null);
  assert.equal(describeRelationship(selected, transaction({ id: 'reference', description: 'Market #24 REF A789' })), null);
});

test('same date and signed amount with the same complete route are only possible duplicates', () => {
  const selected = transaction({ toEndpointId: 'cafe-endpoint' });
  const repeated = transaction({ id: 'repeated', toEndpointId: 'cafe-endpoint', description: 'A different source memo' });
  const result = describeRelationship(selected, repeated);
  assert.equal(result.possibleDuplicate, true);
  assert.equal(result.certainty, 'identity-match');
  assert.ok(result.reasons.includes('Same sender and receiver'));
  assert.ok(result.reasons.includes('Same signed amount and currency'));
  assert.ok(result.reasons.includes('Same booking date'));
  assert.equal(result.transaction, repeated);
});

test('same meaningful description, amount and date can suggest duplicates when route metadata is missing', () => {
  const selected = transaction({ accountId: null, fromAccountId: null, description: 'Harbor Bookshop' });
  const result = describeRelationship(selected, transaction({ ...selected, id: 'repeat' }));
  assert.equal(result.possibleDuplicate, true);
  assert.equal(result.relation, 'description');
  assert.equal(result.certainty, 'description-suggestion');
});

test('known conflicting endpoints or owning accounts prevent description-based duplicate flags', () => {
  const selected = transaction({ toEndpointId: 'branch-a' });
  const candidates = [
    transaction({ id: 'other-recipient', toEndpointId: 'branch-b' }),
    transaction({ id: 'other-owner', accountId: 'other-cash', fromAccountId: 'other-cash' }),
  ];
  const result = relatedTransactions(selected, candidates);
  assert.equal(result.length, 2);
  assert.ok(result.every(item => !item.possibleDuplicate && item.reasons.includes('Account route differs')));
  assert.deepEqual(relatedTransactions(selected, candidates, { mode: 'duplicates' }), []);
});

test('shared party metadata does not erase different known bank account endpoints for duplicate checks', () => {
  const selected = transaction({
    counterpartyId: 'party-cafe', toEndpointId: 'recipient-bank-a',
    toEndpoint: { id: 'recipient-bank-a', owned: false, counterpartyId: 'party-cafe' },
  });
  const other = transaction({
    id: 'other-bank-account', counterpartyId: 'party-cafe', toEndpointId: 'recipient-bank-b',
    toEndpoint: { id: 'recipient-bank-b', owned: false, counterpartyId: 'party-cafe' },
  });
  const result = describeRelationship(selected, other);
  assert.equal(result.relation, 'counterparty');
  assert.ok(result.reasons.includes('Same counterparty identity'));
  assert.ok(!result.reasons.includes('Same sender and receiver'));
  assert.equal(result.possibleDuplicate, false);
  assert.deepEqual(relatedTransactions(selected, [other], { mode: 'duplicates' }), []);
});

test('owned endpoints recovered from source metadata do not relate every payment sharing that sender', () => {
  const owner = Object.freeze({ id: 'recovered-owner', owned: true, accountId: 'recovered-owner' });
  const selected = transaction({
    accountId: null, fromAccountId: null, fromEndpointId: owner.id, fromEndpoint: owner,
    toEndpointId: 'shop-a', description: 'First receipt',
  });
  const other = transaction({
    id: 'other-recipient', accountId: null, fromAccountId: null, fromEndpointId: owner.id, fromEndpoint: owner,
    toEndpointId: 'shop-b', description: 'Different receipt',
  });
  assert.equal(describeRelationship(selected, other), null);
});

test('bank text endpoint and derived party IDs remain text suggestions rather than account identity proof', () => {
  const node = { id: 'merchant-hint', kind: 'merchant-hint', owned: false, counterpartyId: 'party-from-text', evidence: { kind: 'merchant-hint', requiresConfirmation: true } };
  const selected = transaction({ counterpartyId: 'party-from-text', toEndpointId: node.id, toEndpoint: node });
  const other = transaction({ id: 'same-hint', counterpartyId: 'party-from-text', toEndpointId: node.id, toEndpoint: node, description: 'Another purchase memo' });
  const result = describeRelationship(selected, other);
  assert.equal(result.certainty, 'text-hint-suggestion');
  assert.equal(result.relation, 'description');
  assert.equal(result.possibleDuplicate, true);
  assert.ok(result.reasons.includes('Same merchant text hint; account membership is unconfirmed'));
  assert.ok(!result.reasons.includes('Same counterparty identity'));
  const confirmedPair = applyRelationshipDecisions(selected, [other], [{ transactionId: selected.id, relatedTransactionId: other.id, status: 'confirmed' }])[0];
  assert.equal(confirmedPair.decisionStatus, 'confirmed');
  assert.equal(confirmedPair.certainty, 'text-hint-suggestion');
});

test('recorded source identifiers do not become owner confirmations and retain strict duplicate criteria', () => {
  const node = { id: 'recorded-account', kind: 'external-account', owned: false, evidence: { kind: 'source-account-identifier', requiresConfirmation: true } };
  const selected = transaction({ toEndpointId: node.id, toEndpoint: node });
  const other = transaction({ id: 'same-account', toEndpointId: node.id, toEndpoint: node });
  const result = describeRelationship(selected, other);
  assert.equal(result.certainty, 'recorded-source-match');
  assert.ok(result.reasons.includes('Same recorded external account identifier'));
  assert.ok(result.reasons.every(reason => !/confirmed by you/.test(reason)));
  assert.equal(result.possibleDuplicate, true);
  assert.equal(describeRelationship(selected, { ...other, amount: -12001 }).possibleDuplicate, false);
  assert.equal(describeRelationship(selected, { ...other, date: '2026-01-16' }).possibleDuplicate, false);
});

test('unknown placeholders and explicit source-membership denials cannot imply a shared external account', () => {
  const unknown = { id: 'unknown-placeholder', kind: 'unknown-endpoint', owned: false, counterpartyId: 'placeholder-party', evidence: { kind: 'unknown' } };
  const selected = transaction({ counterpartyId: 'placeholder-party', toEndpointId: unknown.id, toEndpoint: unknown, description: 'First unique memo' });
  const other = transaction({ id: 'unknown-peer', counterpartyId: 'placeholder-party', toEndpointId: unknown.id, toEndpoint: unknown, description: 'Different unique memo' });
  assert.equal(describeRelationship(selected, other), null);
  const recorded = { ...unknown, id: 'recorded-account', kind: 'external-account', evidence: { kind: 'source-account-identifier' } };
  const denied = { ...selected, toEndpointId: recorded.id, toEndpoint: recorded, toMembership: { status: 'dismissed', isEffective: false, endpointId: recorded.id } };
  assert.equal(describeRelationship(denied, { ...other, toEndpointId: recorded.id, toEndpoint: recorded }), null);
});

test('only direct confirmation of both account memberships upgrades their shared association', () => {
  const node = { id: 'hint-account', kind: 'merchant-hint', owned: false, evidence: { kind: 'merchant-hint' } };
  const membership = { status: 'confirmed', provenance: 'owner', endpointId: node.id, isEffective: true };
  const selected = transaction({ toEndpointId: node.id, toEndpoint: node, toMembership: membership });
  const other = transaction({ id: 'other', toEndpointId: node.id, toEndpoint: node });
  assert.equal(describeRelationship(selected, other).certainty, 'text-hint-suggestion');
  const result = describeRelationship(selected, { ...other, toMembership: membership });
  assert.equal(result.certainty, 'owner-membership-match');
  assert.ok(result.reasons.includes('Same external account membership confirmed by you'));
  const reassigned = transaction({ description: 'First unique memo', counterpartyId: 'old-source-party', toEndpointId: node.id, toEndpoint: node, toMembership: membership });
  const oldParty = transaction({ id: 'old-party', description: 'Different unique memo', counterpartyId: 'old-source-party', toEndpointId: 'old-source-account' });
  assert.equal(describeRelationship(reassigned, oldParty), null);
});

test('refund mirrors, another date, another currency and invalid dates are not duplicate evidence', () => {
  const selected = transaction({ counterpartyId: 'party-cafe' });
  const candidates = [
    transaction({ id: 'refund', counterpartyId: 'party-cafe', amount: 12000, fromAccountId: null, toAccountId: 'cash' }),
    transaction({ id: 'another-date', counterpartyId: 'party-cafe', date: '2026-01-16' }),
    transaction({ id: 'another-currency', counterpartyId: 'party-cafe', currency: 'EUR' }),
  ];
  assert.ok(relatedTransactions(selected, candidates).every(item => !item.possibleDuplicate));
  const invalid = transaction({ date: '2026-02-30' });
  assert.equal(describeRelationship(invalid, transaction({ ...invalid, id: 'invalid-date' })).possibleDuplicate, false);
});

test('related and duplicate tabs overlap intentionally, keep repeated rows separate and exclude the selected transaction', () => {
  const selected = transaction({ counterpartyId: 'party-cafe' });
  const one = transaction({ id: 'one', counterpartyId: 'party-cafe' });
  const two = transaction({ id: 'two', counterpartyId: 'party-cafe' });
  const later = transaction({ id: 'later', counterpartyId: 'party-cafe', date: '2026-02-01' });
  const rows = [selected, one, two, later, { ...selected }];
  assert.deepEqual(relatedTransactions(selected, rows, { mode: 'duplicates' }).map(item => item.transaction.id), ['one', 'two']);
  assert.equal(relatedTransactions(selected, rows, { mode: 'related' }).length, 3);
  assert.equal(relatedTransactions(selected, rows, { mode: 'all' }).length, 3);
});

test('ordering and optional limits are deterministic and input data remains unchanged', () => {
  const selected = Object.freeze(transaction({ counterpartyId: 'party-cafe' }));
  const rows = [
    Object.freeze(transaction({ id: 'z', date: '2026-03-01', counterpartyId: 'party-cafe' })),
    Object.freeze(transaction({ id: 'a', date: '2026-03-01', counterpartyId: 'party-cafe' })),
    Object.freeze(transaction({ id: 'd', counterpartyId: 'party-cafe' })),
    Object.freeze(transaction({ id: 'description-only', date: '2026-04-01' })),
  ];
  const snapshot = JSON.stringify(rows);
  const ids = input => relatedTransactions(selected, input).map(item => item.transaction.id);
  assert.deepEqual(ids(rows), ['d', 'a', 'z', 'description-only']);
  assert.deepEqual(ids([...rows].reverse()), ids(rows));
  assert.equal(relatedTransactions(selected, rows, { limit: 2 }).length, 2);
  assert.deepEqual(relatedTransactions(selected, rows, { limit: 0 }), []);
  assert.equal(JSON.stringify(rows), snapshot);
  assert.deepEqual(relatedTransactions(null, rows), []);
  assert.deepEqual(relatedTransactions(selected, null), []);
});

test('saved connection decisions apply in either pair order and filter active, suggested, confirmed and dismissed views', () => {
  const selected = transaction({ counterpartyId: 'party-cafe' });
  const rows = [
    selected,
    transaction({ id: 'suggestion', counterpartyId: 'party-cafe' }),
    transaction({ id: 'confirmed', counterpartyId: 'party-cafe' }),
    transaction({ id: 'dismissed', counterpartyId: 'party-cafe' }),
  ];
  const decisions = [
    { transactionId: 'confirmed', relatedTransactionId: selected.id, status: 'confirmed' },
    { transactionId: selected.id, relatedTransactionId: 'dismissed', status: 'dismissed' },
  ];
  const read = status => applyRelationshipDecisions(selected, rows, decisions, { status });
  assert.deepEqual(read('active').map(row => [row.transaction.id, row.decisionStatus]), [['confirmed', 'confirmed'], ['suggestion', 'suggested']]);
  assert.deepEqual(read('suggested').map(row => row.transaction.id), ['suggestion']);
  assert.deepEqual(read('confirmed').map(row => row.transaction.id), ['confirmed']);
  assert.deepEqual(read('dismissed').map(row => row.transaction.id), ['dismissed']);
  assert.equal(read('all').length, 3);
  assert.equal(read('confirmed')[0].reasons[0], 'Connection confirmed by you');
  assert.equal(read('dismissed')[0].reasons[0], 'Connection dismissed by you');
  const reversed = decisions.map(row => ({ ...row, transactionId: row.relatedTransactionId, relatedTransactionId: row.transactionId }));
  assert.deepEqual(applyRelationshipDecisions(selected, rows, reversed), read('active'));
});

test('saved confirmed and dismissed pairs stay inspectable after heuristic evidence no longer matches', () => {
  const selected = transaction({ description: 'Bank transfer', toEndpointId: 'recipient-a' });
  const rows = [
    transaction({ id: 'confirmed', description: 'Different transaction', fromAccountId: 'other-cash', accountId: 'other-cash', toEndpointId: 'recipient-b' }),
    transaction({ id: 'dismissed', description: 'Another transfer', kind: 'transfer', toEndpointId: 'recipient-c' }),
  ];
  assert.deepEqual(relatedTransactions(selected, rows), []);
  const decisions = rows.map(row => ({ transactionId: selected.id, relatedTransactionId: row.id, status: row.id }));
  const confirmed = applyRelationshipDecisions(selected, rows, decisions, { status: 'confirmed' })[0];
  const dismissed = applyRelationshipDecisions(selected, rows, decisions, { status: 'dismissed' })[0];
  for (const row of [confirmed, dismissed]) {
    assert.equal(row.relation, 'manual');
    assert.equal(row.certainty, 'owner-decision');
    assert.equal(row.possibleDuplicate, false);
    assert.equal(row.reasons.length, 1);
  }
  assert.equal(applyRelationshipDecisions(selected, rows, decisions).length, 1);
  assert.deepEqual(applyRelationshipDecisions(selected, rows, decisions, { mode: 'duplicates', status: 'all' }), []);
});

test('connection confirmation never creates or confirms a duplicate finding', () => {
  const selected = transaction({ counterpartyId: 'party-cafe' });
  const rows = [
    transaction({ id: 'repeat', counterpartyId: 'party-cafe' }),
    transaction({ id: 'later', counterpartyId: 'party-cafe', date: '2026-02-01' }),
  ];
  const decisions = rows.map(row => ({ transactionId: selected.id, relatedTransactionId: row.id, status: 'confirmed' }));
  const duplicates = applyRelationshipDecisions(selected, rows, decisions, { mode: 'duplicates' });
  assert.deepEqual(duplicates.map(row => row.transaction.id), ['repeat']);
  assert.equal(duplicates[0].possibleDuplicate, true);
  assert.equal(duplicates[0].decisionStatus, 'confirmed');
  assert.equal(duplicates[0].reasons[0], 'Connection confirmed by you');
  assert.ok(duplicates[0].reasons.every(reason => !/duplicate.*confirmed|confirmed.*duplicate/i.test(reason)));
  assert.equal(applyRelationshipDecisions(selected, rows, decisions).find(row => row.transaction.id === 'later').possibleDuplicate, false);
});

test('dismissal hides a possible duplicate from active suggestions while retaining its review history', () => {
  const selected = transaction();
  const other = transaction({ id: 'repeat' });
  const decisions = [{ transactionId: other.id, relatedTransactionId: selected.id, status: 'dismissed' }];
  assert.deepEqual(applyRelationshipDecisions(selected, [other], decisions, { mode: 'duplicates' }), []);
  const history = applyRelationshipDecisions(selected, [other], decisions, { mode: 'duplicates', status: 'dismissed' });
  assert.equal(history.length, 1);
  assert.equal(history[0].possibleDuplicate, true);
  assert.equal(history[0].decisionStatus, 'dismissed');
  const reset = applyRelationshipDecisions(selected, [other], []);
  assert.equal(reset[0].decisionStatus, 'suggested');
});

test('orphan, self, unrelated, malformed and contradictory decisions are ignored deterministically', () => {
  const selected = transaction();
  const other = transaction({ id: 'suggestion' });
  const invalid = [
    null, 'confirmed', {},
    { transactionId: selected.id, relatedTransactionId: 'missing', status: 'confirmed' },
    { transactionId: selected.id, relatedTransactionId: selected.id, status: 'confirmed' },
    { transactionId: 'different', relatedTransactionId: other.id, status: 'confirmed' },
    { transactionId: selected.id, relatedTransactionId: other.id, status: 'invalid' },
    { transactionId: selected.id, relatedTransactionId: other.id, status: null },
    { transactionId: selected.id, relatedTransactionId: ` ${other.id}`, status: 'dismissed' },
    { transactionId: selected.id, relatedTransactionId: ['suggestion'], status: 'dismissed' },
    { transactionId: selected.id, relatedTransactionId: other.id, status: 'confirmed' },
    { transactionId: other.id, relatedTransactionId: selected.id, status: 'dismissed' },
  ];
  const expected = applyRelationshipDecisions(selected, [other], []);
  assert.deepEqual(applyRelationshipDecisions(selected, [other], invalid), expected);
  assert.deepEqual(applyRelationshipDecisions(selected, [other], [...invalid].reverse()), expected);
  assert.deepEqual(applyRelationshipDecisions(selected, [other], 'invalid'), expected);
  assert.deepEqual(applyRelationshipDecisions(null, [other], invalid), []);
  assert.deepEqual(applyRelationshipDecisions({ id: 'bad/id' }, [other], invalid), []);
  assert.deepEqual(applyRelationshipDecisions({ id: 'trailing-newline\n' }, [other], invalid), []);
  assert.deepEqual(applyRelationshipDecisions(selected, [transaction({ id: 'trailing-newline\n' })], []), []);
  assert.deepEqual(applyRelationshipDecisions(selected, null, invalid), []);
});

test('saved decisions are specific to a pair and do not create transitive connections or collapse repeated rows', () => {
  const selected = transaction({ description: 'First unique merchant', toEndpointId: 'first-merchant' });
  const second = transaction({ id: 'second', description: 'Second unique merchant', toEndpointId: 'second-merchant' });
  const third = transaction({ id: 'third', description: 'Third unique merchant', toEndpointId: 'third-merchant' });
  const repeated = transaction({ id: 'repeat-first' });
  const rows = [second, third, repeated];
  const decisions = [
    { transactionId: selected.id, relatedTransactionId: second.id, status: 'confirmed' },
    { transactionId: second.id, relatedTransactionId: third.id, status: 'confirmed' },
  ];
  const result = applyRelationshipDecisions(selected, rows, decisions);
  assert.deepEqual(result.map(row => row.transaction.id), [second.id]);
  assert.equal(rows.length, 3);
  assert.equal(result[0].transaction, second);
});

test('decision ordering, limits and frozen inputs preserve financial rows and existing heuristic output', () => {
  const selected = Object.freeze(transaction());
  const rows = Object.freeze([
    Object.freeze(transaction({ id: 'strong-suggestion' })),
    Object.freeze(transaction({ id: 'manual-confirmed', date: '2025-01-01', description: 'Another merchant', toEndpointId: 'another-recipient' })),
    Object.freeze(transaction({ id: 'second-suggestion', date: '2026-02-01' })),
  ]);
  const decisions = Object.freeze([Object.freeze({ transactionId: selected.id, relatedTransactionId: 'manual-confirmed', status: 'confirmed', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' })]);
  const snapshot = JSON.stringify({ selected, rows, decisions });
  const heuristic = relatedTransactions(selected, rows);
  const result = applyRelationshipDecisions(selected, rows, decisions);
  assert.deepEqual(result.map(row => row.transaction.id), ['manual-confirmed', 'strong-suggestion', 'second-suggestion']);
  assert.deepEqual(applyRelationshipDecisions(selected, [...rows].reverse(), decisions), result);
  assert.equal(applyRelationshipDecisions(selected, rows, decisions, { limit: 1 })[0].transaction.id, 'manual-confirmed');
  assert.deepEqual(applyRelationshipDecisions(selected, rows, decisions, { limit: 0 }), []);
  assert.equal(JSON.stringify({ selected, rows, decisions }), snapshot);
  assert.deepEqual(relatedTransactions(selected, rows), heuristic);
});
