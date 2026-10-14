import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRelationship, normalizePaymentDescription, relatedTransactions } from '../src/lib/relationships.js';

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
