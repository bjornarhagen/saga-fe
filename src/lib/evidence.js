// Source evidence describes what an import contains. It never establishes an
// owner-confirmed account membership, and it never changes a source identity.
export const EVIDENCE_KINDS = Object.freeze([
  'source-account-identifier', 'provider-account-identifier', 'merchant-hint', 'unknown',
]);

const placeholders = new Set([
  '', '-', '--', '?', 'null', 'undefined', 'none', 'unknown', 'unknown account',
  'ukjent', 'ukjent konto', 'n/a', 'na', 'not available', 'not supplied',
  'ikke oppgitt', 'ikke tilgjengelig', 'ingen', 'ingen konto',
]);
function text(value) {
  return typeof value === 'string' && value.length <= 2000 && !value.includes('\u0000')
    ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
}
function placeholder(value) {
  return placeholders.has(value.toLowerCase()) || /^[0.\s]+$/u.test(value) || /^[*•?\s-]+$/u.test(value);
}

/** Canonical external account declarations can use arbitrary opaque provider
 * IDs. A Norwegian bank CSV field has a narrower contract: eleven digits,
 * optional dots/spaces, and at least one nonzero digit. This classifies source
 * format only; it does not verify a bank account or check its ownership. */
export function classifyEndpointEvidence(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const adapter = text(source.adapter) || null;
  const identifier = text(source.identifier);
  const suppliedLabel = text(source.label);
  const label = placeholder(suppliedLabel) ? '' : suppliedLabel;
  const result = (kind, displayName, reason, basis) => ({
    kind, isAccountIdentifier: kind === 'source-account-identifier' || kind === 'provider-account-identifier',
    requiresConfirmation: true, displayName, reason, basis, adapter,
  });

  // An opaque provider identifier such as "0" is valid when the adapter
  // explicitly declares it as an external account. CSV placeholders do not
  // constrain another provider's identifier namespace.
  if (adapter !== 'norwegian-bank-csv' && source.declaredAccount === true && identifier) {
    return result('provider-account-identifier', label || `External provider account ••••${identifier.slice(-4)}`,
      'The import explicitly declares a provider account identifier. Membership confirmation is separate.', 'declared-provider-account');
  }
  if (placeholder(identifier)) {
    return result('unknown', label || 'Unknown external identity',
      'The source account field is missing or contains a placeholder. It supplies no account identifier.', 'missing-or-placeholder');
  }
  if (adapter === 'norwegian-bank-csv') {
    const digits = identifier.replace(/[.\s]/gu, '');
    if (/^[\d.\s]+$/u.test(identifier) && /^\d{11}$/u.test(digits) && /[1-9]/u.test(digits)) {
      return result('source-account-identifier', label || `External account ••••${digits.slice(-4)}`,
        'The bank export records an eleven-digit account identifier. Membership confirmation is separate.', 'bank-account-field');
    }
    if (/\p{L}/u.test(identifier)) {
      return result('merchant-hint', label || identifier,
        'The bank account field contains text. It is a merchant or sender/receiver hint, not a verified bank account identifier.', 'source-text');
    }
    return result('unknown', label || 'Unknown external identity',
      'The source value does not establish a recognized account identifier.', 'unrecognized-account-field');
  }
  // Descriptions and category labels do not upgrade an undeclared value to
  // account proof. The calling adapter must declare provider account semantics.
  return result('unknown', label || 'Unknown external identity',
    'This source does not declare an account identifier. Membership confirmation is separate.', 'undeclared-identity');
}
