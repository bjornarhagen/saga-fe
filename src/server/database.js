import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { adapt, adapters, digest } from './adapters.js';
import * as v from './validation.js';
import { projectActivity } from './activity.js';

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
PRAGMA user_version=1;`;
const now = () => new Date().toISOString();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
export const LEDGER_TABLES = Object.freeze([
  'accounts', 'categories', 'counterparties', 'ingest_sources',
  'account_identifiers', 'category_identifiers', 'counterparty_identifiers',
  'balance_snapshots', 'transactions', 'source_transaction_keys',
  'ingest_batches', 'ingest_rows', 'transaction_edits', 'settings'
]);

export function createStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('The database schema is newer than this application.'); }
  db.exec(schema);
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
  const accountRows = () => all(`SELECT a.id,a.name,a.currency,a.role,b.amount AS balance,b.as_of AS balanceDate FROM accounts a LEFT JOIN balance_snapshots b ON b.id=(SELECT id FROM balance_snapshots WHERE account_id=a.id ORDER BY as_of DESC,created_at DESC LIMIT 1) ORDER BY a.created_at,a.id`).map(account => ({ ...account, balance: account.balance ?? null, balanceDate: account.balanceDate ?? null }));
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
  const getSettings = () => { const row = query("SELECT value_json FROM settings WHERE key='forecast'"); return row ? { balanceSource: 'manual', ...JSON.parse(row.value_json) } : null; };
  const checkOverrideMap = overrides => {
    v.object(overrides, 'Transaction edits');
    if (Object.keys(overrides).length > 100000) throw new v.ValidationError('Too many transaction edits.');
    return Object.entries(overrides).map(([id, value]) => {
      const checkedId = v.string(id, 'Transaction ID', 200), checkedValue = v.override(value);
      const transaction = query('SELECT amount FROM transactions WHERE id=?', checkedId);
      if (transaction && checkedValue.kind) v.kindForAmount(checkedValue.kind, transaction.amount);
      return [checkedId, checkedValue];
    });
  };
  const saveOverrides = overrides => {
    return atomic(() => {
      const entries = checkOverrideMap(overrides);
      run('DELETE FROM transaction_edits');
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
    transactions, overrides, accounts: accountRows(),
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
  const getTransactions = () => readSnapshot(() => {
    const transactions = activityProjection().rows;
    const detail = accountPayload();
    const duplicateRows = query('SELECT COALESCE(SUM(CASE WHEN occurrence>0 THEN 1 ELSE 0 END),0) AS count FROM source_transaction_keys').count;
    return { transactions, accounts: detail.accounts.map(account => account.name), accountDetails: detail.accounts, accountTotals: detail.totals, overrides: getOverrides(), settings: getSettings(), metadata: { rows: transactions.length, duplicateRows, zeroRows: transactions.filter(tx => tx.amount === 0).length, firstDate: transactions.at(-1)?.date || null, lastDate: transactions[0]?.date || null, currency: 'NOK', hasBalances: detail.totals.hasBalances, sources: query('SELECT COUNT(*) AS count FROM ingest_sources').count, batches: query('SELECT COUNT(*) AS count FROM ingest_batches').count } };
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
          if (type === 'account') run('INSERT INTO accounts(id,name,currency,role,created_at) VALUES(?,?,?,?,?)', found.id, v.string(item.name, 'Account name'), v.currency(item.currency), item.role || 'available', now());
          else run(`INSERT INTO ${table}(id,name) VALUES(?,?)`, found.id, v.string(item.name, `${type} name`));
          run(`INSERT INTO ${identifiers}(source_id,external_id,${column}) VALUES(?,?,?)`, source.id, item.externalId, found.id);
        } else if (type === 'account') {
          run('UPDATE accounts SET name=CASE WHEN name_override=0 THEN ? ELSE name END WHERE id=?', v.string(item.name, 'Account name'), found.id);
          if (item.role) run('UPDATE accounts SET role=CASE WHEN role_override=0 THEN ? ELSE role END WHERE id=?', v.role(item.role), found.id);
        } else run(`UPDATE ${table} SET name=? WHERE id=?`, v.string(item.name, `${type} name`), found.id);
        if (type === 'account' && own(item, 'balance')) insertBalance(found.id, item.balance, item.balanceDate, source.id);
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
    ingest, getTransactions, getAccounts: accountPayload,
    getEndpoints: () => readSnapshot(() => activityProjection().directory()),
    getEndpointActivity: id => readSnapshot(() => {
      v.string(id, 'Endpoint ID', 200); const result = activityProjection().endpointActivity(id);
      if (result?.endpoint.accountId) {
        const account = accountRows().find(row => row.id === result.endpoint.accountId);
        Object.assign(result.endpoint, { role: account.role, balance: account.balance, balanceDate: account.balanceDate, balanceHistory: all('SELECT as_of AS date,amount FROM balance_snapshots WHERE account_id=? ORDER BY as_of DESC,created_at DESC', account.id) });
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
    createAccount: input => {
      v.object(input, 'Account');
      for (const key of Object.keys(input)) if (!['name', 'currency', 'role', 'balance', 'balanceDate'].includes(key)) throw new v.ValidationError('Unknown account field.');
      const name = v.string(input.name, 'Account name'), currency = v.currency(input.currency), accountRole = v.role(input.role || 'available');
      if (own(input, 'balance') && input.balance !== null) v.amount(input.balance);
      const balanceDate = v.date(input.balanceDate || v.today());
      return atomic(() => {
        const id = randomUUID(); run('INSERT INTO accounts(id,name,currency,role,name_override,role_override,created_at) VALUES(?,?,?,?,1,1,?)', id, name, currency, accountRole, now());
        if (own(input, 'balance')) insertBalance(id, input.balance, balanceDate);
        const result = accountPayload(); return { account: result.accounts.find(account => account.id === id), ...result };
      });
    },
    updateAccount: input => {
      v.object(input, 'Account'); const id = v.string(input.id, 'Account ID', 200);
      for (const key of Object.keys(input)) if (!['id', 'name', 'role', 'balance', 'balanceDate'].includes(key)) throw new v.ValidationError('Unknown account field.');
      if (own(input, 'name')) v.string(input.name, 'Account name'); if (own(input, 'role')) v.role(input.role);
      if (own(input, 'balance') && input.balance !== null) v.amount(input.balance);
      if (own(input, 'balanceDate')) v.date(input.balanceDate);
      return atomic(() => {
        if (!query('SELECT id FROM accounts WHERE id=?', id)) throw new v.ValidationError('The account does not exist.');
        if (own(input, 'name')) run('UPDATE accounts SET name=?,name_override=1 WHERE id=?', input.name.trim(), id);
        if (own(input, 'role')) run('UPDATE accounts SET role=?,role_override=1 WHERE id=?', input.role, id);
        if (own(input, 'balance')) insertBalance(id, input.balance, input.balanceDate || v.today());
        const result = accountPayload(); return { account: result.accounts.find(account => account.id === id), ...result };
      });
    },
    updateOverride: input => atomic(() => {
      v.object(input); const id = v.string(input.id, 'Transaction ID', 200);
      if (input.override === null) run('DELETE FROM transaction_edits WHERE transaction_id=?', id);
      else {
        const value = v.override(input.override || Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'id')));
        const transaction = query('SELECT amount FROM transactions WHERE id=?', id);
        if (transaction && value.kind) v.kindForAmount(value.kind, transaction.amount);
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
