import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, LEDGER_TABLES } from '../src/server/database.js';

test('complete JSON archive covers every schema table and preserves all saved ledger state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-archive-test-'));
  const path = join(directory, 'source.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore(path); t.after(() => store.close());
  const data = {
    accounts: [{ externalId: 'fixture-account', name: 'Fé · øre', balance: 105, balanceDate: '2026-01-01' }],
    categories: [{ externalId: 'parent', name: 'Parent' }, { externalId: 'child', name: 'Child', parentExternalId: 'parent' }],
    counterparties: [{ externalId: 'fixture-party', name: 'Example sender / receiver' }],
    transactions: [{ externalId: 'fixture-payment', date: '2026-01-01', amount: -105, description: 'Example payment', accountExternalId: 'fixture-account', categoryExternalId: 'parent', subcategoryExternalId: 'child', counterpartyExternalId: 'fixture-party' }]
  };
  store.ingest({ adapter: 'canonical-v1', sourceKey: 'archive-fixture', data });
  const account = store.getAccounts().accounts[0];
  store.updateAccount({ id: account.id, name: 'Owner label', role: 'reserve', balance: null, balanceDate: '2026-01-02' });
  const id = store.getTransactions().transactions[0].id;
  store.updateOverride({ id, override: { category: 'Owner category', excludeForecast: true } });
  store.saveSettings({ fields: { cash: '-1.05', 'balance-date': '2026-01-02' }, assumptions: { income: 10000 }, balanceSource: 'manual' });
  const archive = JSON.parse(JSON.stringify(store.exportLedger()));
  assert.equal(archive.format, 'saga-fe-ledger');
  assert.equal(archive.formatVersion, 1);
  assert.equal(archive.databaseSchemaVersion, 1);
  assert.equal(archive.amountUnit, 'ore');
  assert.equal(archive.currency, 'NOK');
  assert.ok(Number.isFinite(Date.parse(archive.exportedAt)));
  const db = new DatabaseSync(path, { readOnly: true }); t.after(() => db.close());
  const actualTables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  assert.deepEqual([...LEDGER_TABLES].sort(), actualTables);
  assert.deepEqual(Object.keys(archive.tables).sort(), actualTables);
  for (const table of LEDGER_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    assert.ok(rows.length > 0, `${table} fixture must cover saved data`);
    assert.deepEqual(archive.tables[table], JSON.parse(JSON.stringify(rows)));
  }
  assert.deepEqual(archive.tables.balance_snapshots.map(row => row.amount), [105, null]);
  assert.equal(archive.tables.accounts[0].name_override, 1);
  assert.equal(archive.tables.transactions[0].amount, -105);
  assert.equal(JSON.parse(archive.tables.ingest_rows[0].raw_json).externalId, 'fixture-payment');
  assert.equal(JSON.parse(archive.tables.transaction_edits[0].value_json).category, 'Owner category');
  assert.equal(JSON.parse(archive.tables.settings[0].value_json).fields.cash, '-1.05');
  assert.deepEqual(Object.keys(archive).sort(), ['format', 'formatVersion', 'exportedAt', 'databaseSchemaVersion', 'currency', 'amountUnit', 'tables'].sort());
  const before = store.exportLedger().tables;
  store.exportLedger();
  assert.deepEqual(store.exportLedger().tables, before, 'export must not modify saved rows');
});

test('an empty ledger exports a valid complete archive without invented balances or settings', t => {
  const store = createStore(); t.after(() => store.close());
  const archive = store.exportLedger();
  assert.equal(Object.keys(archive.tables).length, LEDGER_TABLES.length);
  assert.ok(Object.values(archive.tables).every(rows => Array.isArray(rows) && rows.length === 0));
});

test('JSON archives keep one cross-table snapshot while a separate connection commits related updates', async t => {
  const { Worker } = await import('node:worker_threads');
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-archive-concurrent-'));
  const path = join(directory, 'ledger.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore(path); t.after(() => store.close());
  const account = store.createAccount({ name: 'Revision 0', balance: 0, balanceDate: '2026-01-01' }).account;
  const originalTables = store.exportLedger().tables;
  const rounds = 6, shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3), control = new Int32Array(shared);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const control = new Int32Array(workerData.shared);
    let db;
    try {
      db = new DatabaseSync(workerData.path);
      db.exec('PRAGMA busy_timeout=10000');
      parentPort.postMessage('ready');
      for (let revision = 1; revision <= workerData.rounds; revision++) {
        while (Atomics.load(control, 0) < revision) {
          if (Atomics.wait(control, 0, revision - 1, 10000) === 'timed-out') throw new Error('No export requested.');
        }
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE accounts SET name=? WHERE id=?').run('Revision ' + revision, workerData.id);
        db.prepare('UPDATE balance_snapshots SET amount=? WHERE account_id=?').run(revision, workerData.id);
        db.exec('COMMIT');
        Atomics.store(control, 1, revision);
        Atomics.notify(control, 1);
      }
    } catch {
      Atomics.store(control, 2, 1);
      Atomics.notify(control, 1);
      parentPort.postMessage('failed');
      process.exitCode = 1;
    } finally { if (db) db.close(); }
  `, { eval: true, workerData: { path, id: account.id, rounds, shared } });
  t.after(() => worker.terminate());
  await new Promise((resolve, reject) => {
    worker.once('message', message => message === 'ready' ? resolve() : reject(new Error('Synthetic writer failed to initialize.')));
    worker.once('error', reject);
  });

  const originalPrepare = DatabaseSync.prototype.prepare;
  let revision = 0;
  try {
    // Force a commit after the first table read. A collection of independent
    // SELECTs would now mix two revisions; a read transaction must retain one.
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      const statement = originalPrepare.call(this, sql, ...args);
      if (sql !== 'SELECT * FROM accounts ORDER BY rowid') return statement;
      return { all: (...parameters) => {
        const rows = statement.all(...parameters);
        const requested = ++revision;
        Atomics.store(control, 0, requested);
        Atomics.notify(control, 0);
        while (Atomics.load(control, 1) < requested) {
          if (Atomics.load(control, 2)) throw new Error('Synthetic writer failed.');
          if (Atomics.wait(control, 1, requested - 1, 10000) === 'timed-out') throw new Error('Synthetic writer did not complete its transaction.');
        }
        return rows;
      } };
    };
    for (let expected = 0; expected < rounds; expected++) {
      const archive = store.exportLedger();
      assert.equal(archive.tables.accounts[0].name, `Revision ${expected}`);
      assert.equal(archive.tables.balance_snapshots[0].amount, expected, 'related rows must come from the same committed revision');
      assert.equal(Atomics.load(control, 1), expected + 1, 'writer must commit during each export');
    }
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    await worker.terminate();
  }

  const expectedTables = structuredClone(originalTables);
  expectedTables.accounts[0].name = `Revision ${rounds}`;
  expectedTables.balance_snapshots[0].amount = rounds;
  assert.deepEqual(JSON.parse(JSON.stringify(store.exportLedger().tables)), expectedTables, 'exports must leave only the writer\'s intended changes');
});
