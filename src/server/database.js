import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { adapt, adapters, digest } from './adapters.js';
import * as v from './validation.js';
import { projectActivity } from './activity.js';
import { valueHistory } from '../lib/account-values.js';
import { applyOverrides } from '../lib/engine.js';
import { similarCategoryTransactions } from '../lib/categorization.js';

const schema = `
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'NOK', role TEXT NOT NULL DEFAULT 'available' CHECK(role IN ('available','reserve','excluded')), name_override INTEGER NOT NULL DEFAULT 0, role_override INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES categories(id));
CREATE TABLE IF NOT EXISTS counterparties (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ingest_sources (id TEXT PRIMARY KEY, adapter TEXT NOT NULL, source_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(adapter,source_key));
CREATE TABLE IF NOT EXISTS account_identifiers (source_id TEXT NOT NULL REFERENCES ingest_sources(id), external_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), PRIMARY KEY(source_id,external_id));
CREATE TABLE IF NOT EXISTS category_identifiers (source_id TEXT NOT NULL REFERENCES ingest_sources(id), external_id TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), PRIMARY KEY(source_id,external_id));
CREATE TABLE IF NOT EXISTS counterparty_identifiers (source_id TEXT NOT NULL REFERENCES ingest_sources(id), external_id TEXT NOT NULL, counterparty_id TEXT NOT NULL REFERENCES counterparties(id), PRIMARY KEY(source_id,external_id));
CREATE TABLE IF NOT EXISTS balance_snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), as_of TEXT NOT NULL, amount INTEGER, origin TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(account_id,as_of));
CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, description TEXT NOT NULL, category_id TEXT REFERENCES categories(id), subcategory_id TEXT REFERENCES categories(id), bank_type TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('expense','income','saving','transfer')), regular_income INTEGER NOT NULL, needs_review INTEGER NOT NULL, micro_saving INTEGER NOT NULL, from_account_id TEXT REFERENCES accounts(id), to_account_id TEXT REFERENCES accounts(id), account_id TEXT REFERENCES accounts(id), counterparty_id TEXT REFERENCES counterparties(id), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS transactions_date ON transactions(date DESC);
CREATE TABLE IF NOT EXISTS source_transaction_keys (source_id TEXT NOT NULL REFERENCES ingest_sources(id), fingerprint TEXT NOT NULL, occurrence INTEGER NOT NULL, transaction_id TEXT NOT NULL REFERENCES transactions(id), PRIMARY KEY(source_id,fingerprint,occurrence));
CREATE TABLE IF NOT EXISTS ingest_batches (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES ingest_sources(id), imported_at TEXT NOT NULL, filename TEXT, content_hash TEXT NOT NULL, row_count INTEGER NOT NULL, inserted_count INTEGER NOT NULL, existing_count INTEGER NOT NULL, metadata_count INTEGER NOT NULL, UNIQUE(source_id,content_hash));
CREATE TABLE IF NOT EXISTS ingest_rows (batch_id TEXT NOT NULL REFERENCES ingest_batches(id), row_number INTEGER NOT NULL, transaction_id TEXT NOT NULL REFERENCES transactions(id), fingerprint TEXT NOT NULL, occurrence INTEGER NOT NULL, raw_json TEXT NOT NULL, PRIMARY KEY(batch_id,row_number));
CREATE TABLE IF NOT EXISTS transaction_edits (transaction_id TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
`;
const relationSchema = `
CREATE TABLE transaction_relations (
  transaction_a TEXT NOT NULL REFERENCES transactions(id),
  transaction_b TEXT NOT NULL REFERENCES transactions(id),
  status TEXT NOT NULL CHECK(status IN ('confirmed','dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(transaction_a,transaction_b),
  CHECK(transaction_a < transaction_b)
);`;
const membershipSchema = `
CREATE TABLE external_endpoint_refs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('external-account','merchant-hint','unknown-endpoint','counterparty')),
  source_id TEXT REFERENCES ingest_sources(id),
  provider_identifier TEXT,
  counterparty_id TEXT REFERENCES counterparties(id),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE transaction_account_memberships (
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  side TEXT NOT NULL CHECK(side IN ('from','to')),
  endpoint_id TEXT NOT NULL REFERENCES external_endpoint_refs(id),
  status TEXT NOT NULL CHECK(status IN ('confirmed','dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(transaction_id,side,endpoint_id)
);
CREATE UNIQUE INDEX one_confirmed_account_per_side ON transaction_account_memberships(transaction_id,side) WHERE status='confirmed';`;
const categorySchema = `CREATE TABLE transaction_category_decisions (
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('user_applied','user_rejected')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(transaction_id,category)
);
CREATE UNIQUE INDEX one_applied_category ON transaction_category_decisions(transaction_id) WHERE status='user_applied';`;
const profileSchema = `
CREATE TABLE account_profiles (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  account_type TEXT NOT NULL DEFAULT 'other' CHECK(account_type IN ('checking','savings','investment','credit','other')),
  institution TEXT NOT NULL DEFAULT '',
  type_override INTEGER NOT NULL DEFAULT 0,
  institution_override INTEGER NOT NULL DEFAULT 0
);
INSERT INTO account_profiles(account_id) SELECT id FROM accounts;`;
const ownershipSchema = `CREATE TABLE account_ownership (
  endpoint_id TEXT PRIMARY KEY REFERENCES external_endpoint_refs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
export const DATABASE_SCHEMA_VERSION = 6;
const migrations = [null, schema, relationSchema, membershipSchema, categorySchema, profileSchema, ownershipSchema];
const now = () => new Date().toISOString();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
export const LEDGER_TABLES = Object.freeze([
  'accounts', 'categories', 'counterparties', 'ingest_sources',
  'account_identifiers', 'category_identifiers', 'counterparty_identifiers',
  'balance_snapshots', 'transactions', 'source_transaction_keys',
  'ingest_batches', 'ingest_rows', 'transaction_edits', 'settings', 'transaction_relations', 'external_endpoint_refs', 'transaction_account_memberships', 'transaction_category_decisions', 'account_profiles', 'account_ownership'
]);

export function createStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > DATABASE_SCHEMA_VERSION) throw new Error('The database schema is newer than this application.');
    if (version < DATABASE_SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Another connection may finish a migration while this one waits for
        // the writer lock. Recheck before applying or changing the version.
        const lockedVersion = db.prepare('PRAGMA user_version').get().user_version;
        if (lockedVersion > DATABASE_SCHEMA_VERSION) throw new Error('The database schema is newer than this application.');
        for (let next = lockedVersion + 1; next <= DATABASE_SCHEMA_VERSION; next++) {
          db.exec(migrations[next]);
          db.exec(`PRAGMA user_version=${next}`);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  } catch (error) { db.close(); throw error; }
  const query = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const atomic = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const insertBalance = (accountId, balance, asOf, origin = 'manual') => {
    const checked = balance === null ? null : v.amount(balance);
    run(`INSERT INTO balance_snapshots(id,account_id,as_of,amount,origin,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,as_of) DO UPDATE SET amount=excluded.amount, origin=excluded.origin,created_at=excluded.created_at WHERE excluded.origin='manual' OR balance_snapshots.origin!='manual'`, randomUUID(), accountId, v.date(asOf), checked, origin, now());
  };
  const accountRows = () => all(`SELECT a.id,a.name,a.currency,a.role,p.account_type AS accountType,p.institution,b.amount AS balance,b.as_of AS balanceDate,EXISTS(SELECT 1 FROM account_identifiers WHERE account_id=a.id) AS imported FROM accounts a JOIN account_profiles p ON p.account_id=a.id LEFT JOIN balance_snapshots b ON b.id=(SELECT id FROM balance_snapshots WHERE account_id=a.id ORDER BY as_of DESC,created_at DESC LIMIT 1) ORDER BY a.created_at,a.id`).map(account => ({ ...account, imported: !!account.imported, balance: account.balance ?? null, balanceDate: account.balanceDate ?? null }));
  const snapshots = id => all('SELECT as_of AS date,amount FROM balance_snapshots WHERE account_id=? ORDER BY as_of', id);
  const accountPayload = () => {
    const accounts = accountRows();
    const totals = { available: 0, reserve: 0, excluded: 0, hasBalances: false, missingBalances: 0, missingAvailable: 0, missingReserve: 0, balanceDates: [], availableDates: [], reserveDates: [] };
    const dates = new Set(), availableDates = new Set(), reserveDates = new Set();
    const exactTotals = { available: 0n, reserve: 0n, excluded: 0n };
    for (const account of accounts) {
      if (account.role === 'excluded') { if (account.balance !== null) exactTotals.excluded += BigInt(account.balance); continue; }
      if (account.balance === null) { totals.missingBalances++; if (account.role === 'available') totals.missingAvailable++; else totals.missingReserve++; continue; }
      totals.hasBalances = true; exactTotals[account.role] += BigInt(account.balance); dates.add(account.balanceDate);
      (account.role === 'available' ? availableDates : reserveDates).add(account.balanceDate);
    }
    for (const key of ['available', 'reserve', 'excluded']) {
      if (exactTotals[key] > BigInt(Number.MAX_SAFE_INTEGER) || exactTotals[key] < BigInt(Number.MIN_SAFE_INTEGER)) throw new v.ValidationError('The combined balance exceeds the supported exact amount range.');
      totals[key] = Number(exactTotals[key]);
    }
    totals.balanceDates = [...dates].sort(); totals.availableDates = [...availableDates].sort(); totals.reserveDates = [...reserveDates].sort();
    return { accounts, totals };
  };
  const getOverrides = () => Object.fromEntries(all('SELECT transaction_id,value_json FROM transaction_edits ORDER BY transaction_id').map(row => [row.transaction_id, JSON.parse(row.value_json)]));
  const categoryDecisionRows = () => all('SELECT transaction_id AS transactionId,category,status,updated_at AS updatedAt FROM transaction_category_decisions ORDER BY transaction_id,category');
  const membershipRows = () => all('SELECT transaction_id AS transactionId,side,endpoint_id AS endpointId,status,created_at AS createdAt,updated_at AS updatedAt FROM transaction_account_memberships ORDER BY transaction_id,side,endpoint_id');
  const relationRows = () => all('SELECT transaction_a AS transactionId,transaction_b AS relatedTransactionId,status,created_at AS createdAt,updated_at AS updatedAt FROM transaction_relations ORDER BY transaction_a,transaction_b');
  const updateRelation = input => {
    v.object(input, 'Relationship decision');
    for (const key of Object.keys(input)) if (!['transactionId', 'relatedTransactionId', 'status'].includes(key)) throw new v.ValidationError('Unknown relationship decision field.');
    const transactionId = v.string(input.transactionId, 'Transaction ID', 200), relatedTransactionId = v.string(input.relatedTransactionId, 'Related transaction ID', 200);
    if (transactionId === relatedTransactionId) throw new v.ValidationError('A transaction cannot be connected to itself.');
    if (input.status !== null && !['confirmed', 'dismissed'].includes(input.status)) throw new v.ValidationError('Relationship status must be confirmed, dismissed, or null to reset.');
    const [first, second] = [transactionId, relatedTransactionId].sort();
    return atomic(() => {
      if (!query('SELECT id FROM transactions WHERE id=?', first) || !query('SELECT id FROM transactions WHERE id=?', second)) throw new v.ValidationError('Both transactions must exist in the ledger.');
      if (input.status === null) run('DELETE FROM transaction_relations WHERE transaction_a=? AND transaction_b=?', first, second);
      else {
        const timestamp = now();
        run('INSERT INTO transaction_relations(transaction_a,transaction_b,status,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(transaction_a,transaction_b) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at WHERE transaction_relations.status!=excluded.status', first, second, input.status, timestamp, timestamp);
      }
      return { decisions: relationRows() };
    });
  };
  const getSettings = () => { const row = query("SELECT value_json FROM settings WHERE key='forecast'"); return row ? { balanceSource: 'manual', ...JSON.parse(row.value_json) } : null; };
  const checkOwnedAccounts = (id, value) => {
    const transaction = query('SELECT amount FROM transactions WHERE id=?', id);
    if (transaction && value.kind) v.kindForAmount(value.kind, transaction.amount);
    const detail = transaction && (value.fromOwnedAccountId || value.toOwnedAccountId) ? activityProjection().transactionDetail(id) : null;
    for (const side of ['from', 'to']) if (value[`${side}OwnedAccountId`]) {
      const accountId = value[`${side}OwnedAccountId`];
      if (!transaction) throw new v.ValidationError('Link an owned account only to an existing transaction.');
      if (!query('SELECT id FROM accounts WHERE id=?', accountId)) throw new v.ValidationError('The owned account does not exist.');
      const source = detail[side === 'from' ? 'sourceFrom' : 'sourceTo'];
      if (source?.owned && source.accountId !== accountId) throw new v.ValidationError('An imported owned-account side cannot be assigned to a different account.');
    }
  };
  const checkOverrideMap = overrides => {
    v.object(overrides, 'Transaction edits');
    if (Object.keys(overrides).length > 100000) throw new v.ValidationError('Too many transaction edits.');
    return Object.entries(overrides).map(([id, value]) => {
      const checkedId = v.string(id, 'Transaction ID', 200), checkedValue = v.override(value);
      checkOwnedAccounts(checkedId, checkedValue);
      return [checkedId, checkedValue];
    });
  };
  const saveOverrides = (overrides, { resetCategories = false } = {}) => {
    return atomic(() => {
      v.boolean(resetCategories, 'Reset category decisions');
      const entries = checkOverrideMap(overrides);
      run('DELETE FROM transaction_edits');
      if (resetCategories) run('DELETE FROM transaction_category_decisions');
      for (const [id, value] of entries) run('INSERT INTO transaction_edits(transaction_id,value_json,updated_at) VALUES(?,?,?)', id, JSON.stringify(value), now());
      return getOverrides();
    });
  };
  const saveSettings = input => {
    const incoming = v.settings(input);
    return atomic(() => {
      const existing = getSettings() || {};
      const value = { balanceSource: 'manual', ...existing, ...incoming };
      // Fields merge to let different controls save independently; assumptions replace to allow reset.
      if (incoming.fields) value.fields = { ...(existing.fields || {}), ...incoming.fields };
      run("INSERT INTO settings(key,value_json,updated_at) VALUES('forecast',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", JSON.stringify(value), now());
      return value;
    });
  };
  const transactionRows = () => all(`SELECT t.*, c.name AS category,s.name AS subcategory,f.name AS fromAccount,a.name AS account,ta.name AS toAccount,cp.name AS counterparty FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories s ON s.id=t.subcategory_id LEFT JOIN accounts f ON f.id=t.from_account_id LEFT JOIN accounts ta ON ta.id=t.to_account_id LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN counterparties cp ON cp.id=t.counterparty_id ORDER BY t.date DESC,t.rowid`).map(row => ({ id: row.id, date: row.date, month: row.date.slice(0, 7), amount: row.amount, currency: row.currency, description: row.description, category: row.category || (row.amount > 0 ? 'Other money in' : 'Uncategorized'), subcategory: row.subcategory || '', type: row.bank_type, kind: row.kind, regularIncome: !!row.regular_income, review: !!row.needs_review, microSaving: !!row.micro_saving, fromAccount: row.fromAccount || '', toAccount: row.toAccount || '', account: row.account || '', accountId: row.account_id, fromAccountId: row.from_account_id, toAccountId: row.to_account_id, counterpartyId: row.counterparty_id, counterparty: row.counterparty || '' }));
  const activityProjection = (transactions = transactionRows(), overrides = getOverrides()) => projectActivity({
    transactions, overrides, accounts: accountRows(), membershipDecisions: membershipRows(),
    categoryDecisions: categoryDecisionRows(),
    ownershipLinks: all('SELECT o.*,r.source_id,r.provider_identifier,s.adapter FROM account_ownership o JOIN external_endpoint_refs r ON r.id=o.endpoint_id JOIN ingest_sources s ON s.id=r.source_id'),
    endpointReferences: all('SELECT r.*,s.adapter FROM external_endpoint_refs r LEFT JOIN ingest_sources s ON s.id=r.source_id'),
    accountIdentifiers: all('SELECT i.*,s.adapter FROM account_identifiers i JOIN ingest_sources s ON s.id=i.source_id'),
    counterparties: all('SELECT id,name FROM counterparties'),
    counterpartyIdentifiers: all('SELECT i.*,s.adapter FROM counterparty_identifiers i JOIN ingest_sources s ON s.id=i.source_id'),
    lineage: all(`WITH latest AS (SELECT r.*,b.source_id,s.adapter,b.rowid AS importOrder,ROW_NUMBER() OVER(PARTITION BY r.transaction_id ORDER BY b.rowid DESC,r.row_number DESC) AS rank FROM ingest_rows r JOIN ingest_batches b ON b.id=r.batch_id JOIN ingest_sources s ON s.id=b.source_id) SELECT * FROM latest WHERE rank=1`)
  });
  const readSnapshot = action => {
    db.exec('BEGIN');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const updateAccountMembership = input => {
    v.object(input, 'Account membership');
    for (const key of Object.keys(input)) if (!['transactionId', 'side', 'endpointId', 'status'].includes(key)) throw new v.ValidationError('Unknown account membership field.');
    const transactionId = v.string(input.transactionId, 'Transaction ID', 200), endpointId = v.string(input.endpointId, 'Endpoint ID', 200);
    if (!['from', 'to'].includes(input.side)) throw new v.ValidationError('Account membership side must be from or to.');
    if (input.status !== null && !['confirmed', 'dismissed'].includes(input.status)) throw new v.ValidationError('Account membership status must be confirmed, dismissed, or null to reset.');
    return atomic(() => {
      if (!query('SELECT id FROM transactions WHERE id=?', transactionId)) throw new v.ValidationError('The transaction must exist in the ledger.');
      const projection = activityProjection();
      const target = projection.endpointActivity(endpointId)?.endpoint;
      const stored = query('SELECT id FROM external_endpoint_refs WHERE id=?', endpointId);
      if (!target && !stored) throw new v.ValidationError('The external account or recipient must exist in the ledger.');
      if (input.status === null) {
        run('DELETE FROM transaction_account_memberships WHERE transaction_id=? AND side=? AND endpoint_id=?', transactionId, input.side, endpointId);
        return { decisions: membershipRows() };
      }
      if (!target || target.owned) throw new v.ValidationError('Choose an external account or recipient for this membership.');
      if (input.status === 'confirmed' && target.evidence?.kind === 'unknown') throw new v.ValidationError('Choose an identifiable external account or recipient. Unknown source placeholders cannot be confirmed.');
      const detail = projection.transactionDetail(transactionId);
      if ((input.side === 'from' ? detail.sourceFrom : detail.sourceTo)?.owned) throw new v.ValidationError('An imported owned-account side cannot be assigned to an external recipient.');
      const reference = projection.referenceSnapshot(endpointId);
      if (!reference) throw new v.ValidationError('The external endpoint reference is unavailable.');
      const timestamp = now();
      run('INSERT INTO external_endpoint_refs(id,kind,source_id,provider_identifier,counterparty_id,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,source_id=excluded.source_id,provider_identifier=excluded.provider_identifier,counterparty_id=excluded.counterparty_id,label=excluded.label,updated_at=excluded.updated_at WHERE external_endpoint_refs.kind IS NOT excluded.kind OR external_endpoint_refs.source_id IS NOT excluded.source_id OR external_endpoint_refs.provider_identifier IS NOT excluded.provider_identifier OR external_endpoint_refs.counterparty_id IS NOT excluded.counterparty_id OR external_endpoint_refs.label IS NOT excluded.label', reference.id, reference.kind, reference.sourceId, reference.providerIdentifier, reference.counterpartyId, reference.label, timestamp, timestamp);
      if (input.status === 'confirmed') run("UPDATE transaction_account_memberships SET status='dismissed',updated_at=? WHERE transaction_id=? AND side=? AND endpoint_id!=? AND status='confirmed'", timestamp, transactionId, input.side, endpointId);
      run('INSERT INTO transaction_account_memberships(transaction_id,side,endpoint_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(transaction_id,side,endpoint_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at WHERE transaction_account_memberships.status!=excluded.status', transactionId, input.side, endpointId, input.status, timestamp, timestamp);
      return { decisions: membershipRows() };
    });
  };
  const insertAccount = input => {
    v.object(input, 'Account');
    for (const key of Object.keys(input)) if (!['name', 'currency', 'role', 'balance', 'balanceDate', 'accountType', 'institution'].includes(key)) throw new v.ValidationError('Unknown account field.');
    const name = v.string(input.name, 'Account name'), currency = v.currency(input.currency), accountType = v.accountType(input.accountType || 'other'), accountRole = v.role(input.role || (accountType === 'investment' ? 'excluded' : 'available'));
    const institution = v.string(input.institution ?? '', 'Institution', 200, true);
    v.accountProfile(accountType, accountRole);
    if (own(input, 'balance') && input.balance !== null) v.amount(input.balance);
    const balanceDate = v.date(input.balanceDate || v.today());
    const id = randomUUID(); run('INSERT INTO accounts(id,name,currency,role,name_override,role_override,created_at) VALUES(?,?,?,?,1,1,?)', id, name, currency, accountRole, now());
    run('INSERT INTO account_profiles(account_id,account_type,institution,type_override,institution_override) VALUES(?,?,?,1,1)', id, accountType, institution);
    if (own(input, 'balance')) insertBalance(id, input.balance, balanceDate);
    return id;
  };
  const updateAccountOwnership = input => {
    v.object(input, 'Account ownership');
    for (const key of Object.keys(input)) if (!['endpointId', 'accountId', 'account'].includes(key)) throw new v.ValidationError('Unknown account ownership field.');
    const endpointId = v.string(input.endpointId, 'Endpoint ID', 200);
    if (own(input, 'accountId') === own(input, 'account')) throw new v.ValidationError('Choose an existing account or supply a new account.');
    if (own(input, 'accountId') && input.accountId !== null) v.string(input.accountId, 'Account ID', 200);
    return atomic(() => {
      const saved = query('SELECT account_id FROM account_ownership WHERE endpoint_id=?', endpointId);
      if (input.accountId === null) {
        if (!saved) throw new v.ValidationError('The ownership link does not exist.');
        run('DELETE FROM account_ownership WHERE endpoint_id=?', endpointId);
        return { endpointId, accountId: null };
      }
      // Repeated submissions are idempotent; do not create a second account.
      if (saved) {
        if (input.accountId && input.accountId !== saved.account_id) throw new v.ValidationError('Remove the existing ownership link before choosing another account.');
        return { endpointId, accountId: saved.account_id };
      }
      const projection = activityProjection(), target = projection.endpointActivity(endpointId)?.endpoint;
      if (!target || target.owned || !target.evidence?.isAccountIdentifier) throw new v.ValidationError('Choose an external account with a recorded account identifier. Use a per-payment link for merchant text or shared collection accounts.');
      const reference = projection.referenceSnapshot(endpointId);
      if (!reference?.sourceId || !reference.providerIdentifier) throw new v.ValidationError('The external account source reference is unavailable.');
      const accountId = own(input, 'account') ? insertAccount(input.account) : input.accountId;
      if (!query('SELECT id FROM accounts WHERE id=?', accountId)) throw new v.ValidationError('The owned account does not exist.');
      const timestamp = now();
      run('INSERT INTO external_endpoint_refs(id,kind,source_id,provider_identifier,counterparty_id,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', reference.id, reference.kind, reference.sourceId, reference.providerIdentifier, reference.counterpartyId, reference.label, timestamp, timestamp);
      run('INSERT INTO account_ownership(endpoint_id,account_id,created_at,updated_at) VALUES(?,?,?,?)', endpointId, accountId, timestamp, timestamp);
      accountPayload();
      return { endpointId, accountId };
    });
  };
  const accountValues = (accounts, projection = activityProjection()) => accounts.map(account => ({ ...account,
    valueHistory: valueHistory(snapshots(account.id), projection.endpointActivity(account.id)?.flows || [], account.id)
  }));
  const getTransactions = () => readSnapshot(() => {
    const projection = activityProjection();
    const transactions = projection.rows;
    const detail = accountPayload();
    const duplicateRows = query('SELECT COALESCE(SUM(CASE WHEN occurrence>0 THEN 1 ELSE 0 END),0) AS count FROM source_transaction_keys').count;
    return { transactions, accounts: detail.accounts.map(account => account.name), accountDetails: accountValues(detail.accounts, projection), accountTotals: detail.totals, overrides: getOverrides(), settings: getSettings(), metadata: { rows: transactions.length, duplicateRows, zeroRows: transactions.filter(tx => tx.amount === 0).length, firstDate: transactions.at(-1)?.date || null, lastDate: transactions[0]?.date || null, currency: 'NOK', hasBalances: detail.totals.hasBalances, sources: query('SELECT COUNT(*) AS count FROM ingest_sources').count, batches: query('SELECT COUNT(*) AS count FROM ingest_batches').count } };
  });
  const ingest = input => {
    const adapted = adapt(input);
    return atomic(() => {
      let source = query('SELECT id FROM ingest_sources WHERE adapter=? AND source_key=?', adapted.adapter, adapted.sourceKey);
      if (!source) { source = { id: randomUUID() }; run('INSERT INTO ingest_sources(id,adapter,source_key,created_at) VALUES(?,?,?,?)', source.id, adapted.adapter, adapted.sourceKey, now()); }
      const oldBatch = query('SELECT id,row_count AS rows,inserted_count AS inserted,existing_count AS existing,metadata_count AS metadata FROM ingest_batches WHERE source_id=? AND content_hash=?', source.id, adapted.contentHash);
      if (oldBatch) return { ...oldBatch, inserted: 0, existing: oldBatch.rows, duplicate: true, adapter: adapted.adapter };
      const entity = (type, item) => {
        const table = { account: 'accounts', category: 'categories', counterparty: 'counterparties' }[type], identifiers = `${type}_identifiers`, column = `${type}_id`;
        let found = query(`SELECT ${column} AS id FROM ${identifiers} WHERE source_id=? AND external_id=?`, source.id, item.externalId);
        if (type === 'account' && !found) {
          const declared = query('SELECT o.account_id AS id FROM account_ownership o JOIN external_endpoint_refs r ON r.id=o.endpoint_id WHERE r.source_id=? AND r.provider_identifier=?', source.id, item.externalId);
          if (declared && (!item.id || item.id === declared.id)) {
            found = declared;
            run('INSERT INTO account_identifiers(source_id,external_id,account_id) VALUES(?,?,?)', source.id, item.externalId, found.id);
          } else if (declared) throw new v.ValidationError('The account identifier is already linked to another record.');
        }
        if (item.id) {
          if (!query(`SELECT id FROM ${table} WHERE id=?`, item.id)) throw new v.ValidationError(`The linked ${type} does not exist.`);
          if (found && found.id !== item.id) throw new v.ValidationError(`The ${type} identifier is already linked to another record.`);
          if (!found) {
            found = { id: item.id };
            run(`INSERT INTO ${identifiers}(source_id,external_id,${column}) VALUES(?,?,?)`, source.id, item.externalId, found.id);
          }
        }
        if (!found) {
          found = { id: randomUUID() };
          if (type === 'account') {
            run('INSERT INTO accounts(id,name,currency,role,created_at) VALUES(?,?,?,?,?)', found.id, v.string(item.name, 'Account name'), v.currency(item.currency), item.role || (item.accountType === 'investment' ? 'excluded' : 'available'), now());
            run('INSERT INTO account_profiles(account_id) VALUES(?)', found.id);
          }
          else run(`INSERT INTO ${table}(id,name) VALUES(?,?)`, found.id, v.string(item.name, `${type} name`));
          run(`INSERT INTO ${identifiers}(source_id,external_id,${column}) VALUES(?,?,?)`, source.id, item.externalId, found.id);
        } else if (type === 'account') {
          run('UPDATE accounts SET name=CASE WHEN name_override=0 THEN ? ELSE name END WHERE id=?', v.string(item.name, 'Account name'), found.id);
          if (item.role) run('UPDATE accounts SET role=CASE WHEN role_override=0 THEN ? ELSE role END WHERE id=?', v.role(item.role), found.id);
        } else run(`UPDATE ${table} SET name=? WHERE id=?`, v.string(item.name, `${type} name`), found.id);
        if (type === 'account') {
          if (own(item, 'accountType')) run('UPDATE account_profiles SET account_type=CASE WHEN type_override=0 THEN ? ELSE account_type END WHERE account_id=?', item.accountType, found.id);
          if (own(item, 'institution')) run('UPDATE account_profiles SET institution=CASE WHEN institution_override=0 THEN ? ELSE institution END WHERE account_id=?', item.institution, found.id);
          const profile = query('SELECT p.account_type,a.role FROM accounts a JOIN account_profiles p ON p.account_id=a.id WHERE a.id=?', found.id);
          v.accountProfile(profile.account_type, profile.role);
          if (own(item, 'balance')) insertBalance(found.id, item.balance, item.balanceDate, source.id);
        }
        return found.id;
      };
      for (const account of adapted.accounts) entity('account', account);
      for (const category of adapted.categories) entity('category', category);
      for (const counterparty of adapted.counterparties) entity('counterparty', counterparty);
      const reference = (type, externalId) => {
        if (!externalId) return null;
        const row = query(`SELECT ${type}_id AS id FROM ${type}_identifiers WHERE source_id=? AND external_id=?`, source.id, externalId);
        if (!row) throw new v.ValidationError(`An imported ${type} reference is unknown. Import its metadata first or include it in this batch.`);
        return row.id;
      };
      for (const category of adapted.categories) if (category.parentExternalId) {
        const id = reference('category', category.externalId), parent = reference('category', category.parentExternalId);
        if (id === parent) throw new v.ValidationError('A category cannot be its own parent.');
        run('UPDATE categories SET parent_id=? WHERE id=?', parent, id);
      }
      const parents = new Map(all('SELECT id,parent_id FROM categories').map(category => [category.id, category.parent_id]));
      const visited = new Set();
      for (const id of parents.keys()) {
        let node = id; const path = new Set();
        while (node && !visited.has(node)) {
          if (path.has(node)) throw new v.ValidationError('Category parents must not form a cycle.');
          path.add(node); node = parents.get(node);
        }
        for (const ancestor of path) visited.add(ancestor);
      }
      const batchId = randomUUID(); let inserted = 0, existing = 0;
      const metadataCount = adapted.accounts.length + adapted.categories.length + adapted.counterparties.length;
      run('INSERT INTO ingest_batches(id,source_id,imported_at,filename,content_hash,row_count,inserted_count,existing_count,metadata_count) VALUES(?,?,?,?,?,?,0,0,?)', batchId, source.id, now(), adapted.filename, adapted.contentHash, adapted.sourceRows, metadataCount);
      for (const tx of adapted.transactions) {
        const prior = query('SELECT transaction_id AS id FROM source_transaction_keys WHERE source_id=? AND fingerprint=? AND occurrence=?', source.id, tx.sourceFingerprint, tx.occurrence);
        let id = prior?.id || tx.legacyId || `tx_${digest(`${source.id}:${tx.sourceFingerprint}:${tx.occurrence}`).slice(0, 32)}`;
        if (!prior && query('SELECT id FROM transactions WHERE id=?', id)) id = `tx_${digest(`${source.id}:${tx.sourceFingerprint}:${tx.occurrence}`).slice(0, 32)}`;
        const pendingEdit = query('SELECT value_json FROM transaction_edits WHERE transaction_id=?', id);
        const pendingKind = pendingEdit ? JSON.parse(pendingEdit.value_json).kind : null;
        if (pendingKind) v.kindForAmount(pendingKind, tx.amount);
        const args = [v.date(tx.date), v.amount(tx.amount), v.currency(tx.currency), v.string(tx.description, 'Description', 2000), reference('category', tx.categoryExternalId), reference('category', tx.subcategoryExternalId), tx.type, v.kindForAmount(tx.kind, tx.amount), Number(tx.regularIncome), Number(tx.review), Number(tx.microSaving), reference('account', tx.fromAccountExternalId), reference('account', tx.toAccountExternalId), reference('account', tx.accountExternalId), reference('counterparty', tx.counterpartyExternalId)];
        if (prior) {
          run('UPDATE transactions SET date=?,amount=?,currency=?,description=?,category_id=?,subcategory_id=?,bank_type=?,kind=?,regular_income=?,needs_review=?,micro_saving=?,from_account_id=?,to_account_id=?,account_id=?,counterparty_id=? WHERE id=?', ...args, id); existing++;
        } else {
          run('INSERT INTO transactions(date,amount,currency,description,category_id,subcategory_id,bank_type,kind,regular_income,needs_review,micro_saving,from_account_id,to_account_id,account_id,counterparty_id,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...args, id, now());
          run('INSERT INTO source_transaction_keys(source_id,fingerprint,occurrence,transaction_id) VALUES(?,?,?,?)', source.id, tx.sourceFingerprint, tx.occurrence, id); inserted++;
        }
        run('INSERT INTO ingest_rows(batch_id,row_number,transaction_id,fingerprint,occurrence,raw_json) VALUES(?,?,?,?,?,?)', batchId, tx.rowNumber, id, tx.sourceFingerprint, tx.occurrence, JSON.stringify(tx.raw));
      }
      run('UPDATE ingest_batches SET inserted_count=?,existing_count=? WHERE id=?', inserted, existing, batchId);
      accountPayload(); // Reject aggregate overflow before committing imported account balances.
      return { id: batchId, adapter: adapted.adapter, rows: adapted.sourceRows, inserted, existing, metadata: metadataCount, duplicate: false };
    });
  };
  return {
    ingest, getTransactions, getAccounts: () => readSnapshot(() => { const result = accountPayload(); return { ...result, accounts: accountValues(result.accounts) }; }),
    getRelations: () => ({ decisions: relationRows() }), updateRelation,
    updateAccountOwnership,
    getAccountMemberships: () => ({ decisions: membershipRows() }), updateAccountMembership,
    getEndpoints: () => readSnapshot(() => activityProjection().directory()),
    getEndpointActivity: id => readSnapshot(() => {
      v.string(id, 'Endpoint ID', 200); const result = activityProjection().endpointActivity(id);
      if (result?.endpoint.accountId) {
        const account = accountRows().find(row => row.id === result.endpoint.accountId);
        Object.assign(result.endpoint, { ownershipLinks: all('SELECT o.endpoint_id AS endpointId,substr(r.provider_identifier,-4) AS identifierSuffix,s.adapter FROM account_ownership o JOIN external_endpoint_refs r ON r.id=o.endpoint_id JOIN ingest_sources s ON s.id=r.source_id WHERE o.account_id=? ORDER BY o.created_at,o.endpoint_id', account.id), role: account.role, accountType: account.accountType, institution: account.institution, balance: account.balance, balanceDate: account.balanceDate, balanceHistory: snapshots(account.id).reverse(), valueHistory: valueHistory(snapshots(account.id), result.flows, account.id) });
      }
      return result;
    }),
    getTransactionDetail: id => readSnapshot(() => {
      v.string(id, 'Transaction ID', 200); const result = activityProjection().transactionDetail(id);
      if (!result) return null;
      result.provenance = all('SELECT b.id AS batchId,b.source_id AS sourceId,s.adapter,b.filename,b.imported_at AS importedAt,r.row_number AS rowNumber FROM ingest_rows r JOIN ingest_batches b ON b.id=r.batch_id JOIN ingest_sources s ON s.id=b.source_id WHERE r.transaction_id=? ORDER BY b.rowid DESC,r.row_number DESC', id);
      const latest = query('SELECT r.raw_json FROM ingest_rows r JOIN ingest_batches b ON b.id=r.batch_id WHERE r.transaction_id=? ORDER BY b.rowid DESC,r.row_number DESC LIMIT 1', id);
      result.sourceFields = latest ? JSON.parse(latest.raw_json) : null;
      return result;
    }),
    getCounterpartyActivity: id => readSnapshot(() => { v.string(id, 'Counterparty ID', 200); return activityProjection().counterpartyActivity(id); }),
    getSettings, saveSettings, getOverrides, saveOverrides,
    updateCategories: input => atomic(() => {
      v.object(input, 'Category decision');
      for (const key of Object.keys(input)) if (!['transactionIds', 'category', 'status', 'similarTo', 'minAmount', 'maxAmount', 'includeCategorized'].includes(key)) throw new v.ValidationError('Unknown category decision field.');
      const ids = v.list(input.transactionIds, 'Transactions', 10000).map(id => v.string(id, 'Transaction ID', 200));
      if (!ids.length || new Set(ids).size !== ids.length) throw new v.ValidationError('Select one or more distinct transactions.');
      if (input.status !== null && !['user_applied', 'user_rejected'].includes(input.status)) throw new v.ValidationError('Choose apply, reject, or reset for the category.');
      const category = input.status === null ? null : v.string(input.category, 'Category', 200);
      const minAmount = input.minAmount === undefined ? 0 : v.amount(input.minAmount), maxAmount = input.maxAmount === undefined ? Number.MAX_SAFE_INTEGER : v.amount(input.maxAmount);
      if (minAmount < 0 || maxAmount < minAmount) throw new v.ValidationError('Use a valid nonnegative amount range.');
      const includeCategorized = input.includeCategorized === undefined ? false : v.boolean(input.includeCategorized, 'Include categorized payments');
      const edits = getOverrides();
      const rows = applyOverrides(activityProjection(undefined, edits).rows, edits), byId = new Map(rows.map(row => [row.id, row]));
      if (ids.some(id => !byId.has(id))) throw new v.ValidationError('Every selected transaction must exist in the ledger.');
      if (input.similarTo !== undefined) {
        const anchor = byId.get(v.string(input.similarTo, 'Similar transaction ID', 200));
        if (!anchor) throw new v.ValidationError('The original transaction must exist in the ledger.');
        const matches = new Set(similarCategoryTransactions(anchor, rows, { status: input.status, category, minAmount, maxAmount, includeCategorized }).map(row => row.id));
        if (ids.some(id => !matches.has(id))) throw new v.ValidationError('The matching payments changed. Refresh the list before applying.');
      }
      for (const id of ids) {
        if (input.status === null) {
          run('DELETE FROM transaction_category_decisions WHERE transaction_id=?', id);
          const edit = edits[id];
          if (edit?.category) {
            delete edit.category;
            run('UPDATE transaction_edits SET value_json=?,updated_at=? WHERE transaction_id=?', JSON.stringify(edit), now(), id);
          }
        }
        else {
          if (input.status === 'user_rejected' && (byId.get(id).categorySuggestion?.category !== category || byId.get(id).categorySuggestion?.status === 'user_applied')) throw new v.ValidationError('This category suggestion changed. Review it again before rejecting.');
          if (input.status === 'user_applied') {
            run("DELETE FROM transaction_category_decisions WHERE transaction_id=? AND status='user_applied'", id);
            const edit = edits[id];
            if (edit?.category) {
              delete edit.category;
              run('UPDATE transaction_edits SET value_json=?,updated_at=? WHERE transaction_id=?', JSON.stringify(edit), now(), id);
            }
          }
          run('INSERT INTO transaction_category_decisions(transaction_id,category,status,updated_at) VALUES(?,?,?,?) ON CONFLICT(transaction_id,category) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at', id, category, input.status, now());
        }
      }
      return { updated: ids.length };
    }),
    exportLedger: () => {
      // A WAL reader sees one committed database state across every table,
      // including writes made by a different application connection.
      db.exec('BEGIN');
      try {
        const actual = all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => row.name);
        if (JSON.stringify(actual) !== JSON.stringify([...LEDGER_TABLES].sort())) throw new Error('The ledger export must be updated for this schema.');
        const tables = Object.fromEntries(LEDGER_TABLES.map(table => [table, all(`SELECT * FROM ${table} ORDER BY rowid`)]));
        const archive = { format: 'saga-fe-ledger', formatVersion: 1, exportedAt: now(), databaseSchemaVersion: query('PRAGMA user_version').user_version, currency: 'NOK', amountUnit: 'ore', tables };
        db.exec('COMMIT');
        return archive;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getMetadata: () => ({ accounts: accountRows(), categories: all('SELECT id,name,parent_id AS parentId FROM categories ORDER BY name'), counterparties: all('SELECT id,name FROM counterparties ORDER BY name') }),
    getHistory: () => ({ adapters, batches: all('SELECT b.id,s.adapter,b.imported_at AS importedAt,b.filename,b.row_count AS rows,b.inserted_count AS inserted,b.existing_count AS existing,b.metadata_count AS metadata FROM ingest_batches b JOIN ingest_sources s ON s.id=b.source_id ORDER BY b.imported_at DESC,b.rowid DESC LIMIT 100') }),
    createAccount: input => atomic(() => {
      const id = insertAccount(input);
      const result = accountPayload(); return { account: result.accounts.find(account => account.id === id), ...result };
    }),
    updateAccount: input => {
      v.object(input, 'Account'); const id = v.string(input.id, 'Account ID', 200);
      for (const key of Object.keys(input)) if (!['id', 'name', 'role', 'balance', 'balanceDate', 'accountType', 'institution'].includes(key)) throw new v.ValidationError('Unknown account field.');
      if (own(input, 'name')) v.string(input.name, 'Account name'); if (own(input, 'role')) v.role(input.role);
      if (own(input, 'accountType')) v.accountType(input.accountType);
      if (own(input, 'institution')) v.string(input.institution, 'Institution', 200, true);
      if (own(input, 'balance') && input.balance !== null) v.amount(input.balance);
      if (own(input, 'balanceDate')) v.date(input.balanceDate);
      return atomic(() => {
        const current = query('SELECT a.role,p.account_type FROM accounts a JOIN account_profiles p ON p.account_id=a.id WHERE a.id=?', id);
        if (!current) throw new v.ValidationError('The account does not exist.');
        v.accountProfile(input.accountType || current.account_type, input.role || current.role);
        if (own(input, 'name')) run('UPDATE accounts SET name=?,name_override=1 WHERE id=?', input.name.trim(), id);
        if (own(input, 'role')) run('UPDATE accounts SET role=?,role_override=1 WHERE id=?', input.role, id);
        if (own(input, 'accountType')) run('UPDATE account_profiles SET account_type=?,type_override=1 WHERE account_id=?', input.accountType, id);
        if (own(input, 'institution')) run('UPDATE account_profiles SET institution=?,institution_override=1 WHERE account_id=?', input.institution.trim(), id);
        if (own(input, 'balance')) insertBalance(id, input.balance, input.balanceDate || v.today());
        const result = accountPayload(); return { account: result.accounts.find(account => account.id === id), ...result };
      });
    },
    updateOverride: input => atomic(() => {
      v.object(input); const id = v.string(input.id, 'Transaction ID', 200);
      if (input.override === null) {
        run('DELETE FROM transaction_edits WHERE transaction_id=?', id);
        run('DELETE FROM transaction_category_decisions WHERE transaction_id=?', id);
      }
      else {
        const value = v.override(input.override || Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'id')));
        checkOwnedAccounts(id, value);
        run('INSERT INTO transaction_edits(transaction_id,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(transaction_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', id, JSON.stringify(value), now());
      }
      return getOverrides();
    }),
    health: () => { query('SELECT 1'); return { status: 'ok', database: 'ok' }; },
    backup: async destination => { const result = await backup(db, destination); chmodSync(destination, 0o600); return result; },
    close: () => db.close()
  };
}
let singleton;
export function getStore() {
  if (!singleton) {
    const store = createStore(process.env.DATABASE_PATH || '/data/saga-fe.sqlite');
    try {
      const source = process.env.TRANSACTIONS_FILE;
      if (source && existsSync(source) && store.getTransactions().metadata.rows === 0) store.ingest({ adapter: 'norwegian-bank-csv', content: readFileSync(source, 'utf8'), filename: 'Initial bank export' });
      singleton = store;
    } catch (error) { store.close(); throw error; }
  }
  return singleton;
}
