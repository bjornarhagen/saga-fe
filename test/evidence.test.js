import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEndpointEvidence, EVIDENCE_KINDS } from '../src/lib/evidence.js';

test('bank source format is recorded evidence and never an owner confirmation', () => {
  // Deliberately synthetic account-format values assembled at runtime; no
  // personal identifiers enter these fixtures or source files.
  const number = '1'.repeat(11);
  const result = classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier: number });
  assert.equal(result.kind, 'source-account-identifier');
  assert.equal(result.isAccountIdentifier, true);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.displayName, 'External account ••••1111');
  assert.equal(result.basis, 'bank-account-field');
  assert.match(result.reason, /Membership confirmation is separate/);
  assert.doesNotMatch(result.reason, /not confirmed by you/);
  assert.equal(JSON.stringify(result).includes(number), false);
  const formatted = `${number.slice(0, 4)}.${number.slice(4, 6)}.${number.slice(6)}`;
  assert.equal(classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier: formatted, label: 'Supplied recipient label' }).displayName, 'Supplied recipient label');
  assert.equal(classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier: number.split('').join(' ') }).kind, 'source-account-identifier');
});

test('alphabetic bank account fields stay text hints and keep a readable supplied label', () => {
  const result = classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier: 'Example Market', description: 'Example Market' });
  assert.equal(result.kind, 'merchant-hint');
  assert.equal(result.isAccountIdentifier, false);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.displayName, 'Example Market');
  assert.equal(result.basis, 'source-text');
  assert.doesNotMatch(result.displayName, /••••|External account/);
  assert.match(result.reason, /not a verified bank account identifier/);
  const reference = classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier: 'Market #24 REF ABC-789' });
  assert.equal(reference.kind, 'merchant-hint');
  assert.equal(reference.displayName, 'Market #24 REF ABC-789');
  assert.equal(classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier: 'Example Market', label: 'Name from import' }).displayName, 'Name from import');
});

test('empty, placeholder and incomplete numeric bank fields remain unknown rather than invented accounts', () => {
  const formattedZero = `${'0'.repeat(4)}.${'0'.repeat(2)}.${'0'.repeat(5)}`;
  for (const identifier of ['', ' ', '0', '0'.repeat(11), formattedZero, '-', '???', 'UNKNOWN', 'ukjent konto', 'N/A', 'null', '*'.repeat(5), '1'.repeat(10), '1'.repeat(12)]) {
    const result = classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier, description: 'A meaningful merchant description' });
    assert.equal(result.kind, 'unknown', `Incorrect account evidence for placeholder/format: ${identifier.length}`);
    assert.equal(result.isAccountIdentifier, false);
    assert.equal(result.displayName, 'Unknown external identity');
  }
});

test('declared provider external account IDs retain their own namespace without the bank format requirement', () => {
  for (const identifier of ['provider-account:example-market', '0', 'unknown']) {
    const result = classifyEndpointEvidence({ adapter: 'canonical-v1', identifier, label: 'Provider account label', declaredAccount: true });
    assert.equal(result.kind, 'provider-account-identifier');
    assert.equal(result.isAccountIdentifier, true);
    assert.equal(result.requiresConfirmation, true);
    assert.equal(result.displayName, 'Provider account label');
    assert.equal(result.basis, 'declared-provider-account');
  }
  assert.equal(classifyEndpointEvidence({ adapter: 'future-provider', identifier: 'account:example', declaredAccount: true }).kind, 'provider-account-identifier');
  assert.equal(classifyEndpointEvidence({ adapter: 'canonical-v1', identifier: 'provider-account:example-market' }).kind, 'unknown');
  assert.equal(classifyEndpointEvidence({ adapter: 'canonical-v1', identifier: '', declaredAccount: true }).kind, 'unknown');
});

test('descriptions, asserted confirmations and invalid input cannot promote account evidence', () => {
  assert.equal(classifyEndpointEvidence({ adapter: 'norwegian-bank-csv', identifier: 'Example Market', declaredAccount: true, confirmed: true }).kind, 'merchant-hint');
  assert.equal(classifyEndpointEvidence({ adapter: 'canonical-v1', identifier: '', description: '1'.repeat(11), confirmed: true }).kind, 'unknown');
  for (const input of [null, undefined, [], 'account', { identifier: 123 }, { identifier: 'x\u0000y' }]) {
    const result = classifyEndpointEvidence(input);
    assert.equal(result.kind, 'unknown');
    assert.equal(result.requiresConfirmation, true);
  }
});

test('evidence classification is pure and does not rewrite source strings or endpoint IDs', () => {
  const input = Object.freeze({ adapter: 'norwegian-bank-csv', identifier: '  Example   Market #24 ', label: '', endpointId: 'ep_existing', confirmed: true });
  const before = JSON.stringify(input);
  const result = classifyEndpointEvidence(input);
  assert.equal(result.displayName, 'Example Market #24');
  assert.equal(JSON.stringify(input), before);
  assert.equal('endpointId' in result, false);
  assert.equal('confirmed' in result, false);
  assert.ok(EVIDENCE_KINDS.includes(result.kind));
});
