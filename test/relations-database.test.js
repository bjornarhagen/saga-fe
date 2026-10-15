import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, DATABASE_SCHEMA_VERSION, LEDGER_TABLES } from '../src/server/database.js';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'saga-fe-relations-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fixture(store) {
  const input = { adapter: 'canonical-v1', data: { accounts: [{ externalId: 'cash', name: 'Synthetic cash' }], transactions: [
    { externalId: 'payment-one', date: '2026-01-01', amount: -105, description: 'Synthetic first payment', accountExternalId: 'cash' },
    { externalId: 'payment-two', date: '2026-02-01', amount: -210, description: 'Different synthetic payment', accountExternalId: 'cash' },
    { externalId: 'payment-three', date: '2026-03-01', amount: 55, description: 'Synthetic refund', accountExternalId: 'cash' }
  ] } };
  store.ingest(input);
  return { input, ids: store.getTransactions().transactions.map(transaction => transaction.id).sort() };
}
function openMemory(t) { const store = createStore(); t.after(() => store.close()); return store; }

test('relationship decisions are undirected, idempotent, reversible, and independent of payment similarity', t => {
  const store = openMemory(t); const { ids } = fixture(store);
  assert.deepEqual(store.getRelations(), { decisions: [] });
  let result = store.updateRelation({ transactionId: ids[1], relatedTransactionId: ids[0], status: 'confirmed' });
  assert.equal(result.decisions.length, 1);
  const decision = result.decisions[0];
  assert.equal(decision.transactionId, ids[0]);
  assert.equal(decision.relatedTransactionId, ids[1]);
  assert.equal(decision.status, 'confirmed');
  assert.ok(Number.isFinite(Date.parse(decision.createdAt)));
  assert.equal(decision.createdAt, decision.updatedAt);
  assert.deepEqual(store.updateRelation({ transactionId: ids[0], relatedTransactionId: ids[1], status: 'confirmed' }), result, 'same decision retry changes no timestamps or row identity');
  result = store.updateRelation({ transactionId: ids[1], relatedTransactionId: ids[0], status: 'dismissed' });
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].status, 'dismissed');
  assert.equal(result.decisions[0].createdAt, decision.createdAt);
  assert.ok(result.decisions[0].updatedAt >= decision.updatedAt);
  assert.deepEqual(store.updateRelation({ transactionId: ids[0], relatedTransactionId: ids[1], status: null }), { decisions: [] });
  assert.deepEqual(store.updateRelation({ transactionId: ids[1], relatedTransactionId: ids[0], status: null }), { decisions: [] });
});

test('invalid relationship decisions reject self, unknown IDs, malformed values and extra fields atomically', t => {
  const store = openMemory(t); const { ids } = fixture(store);
  const valid = { transactionId: ids[0], relatedTransactionId: ids[1], status: 'confirmed' };
  store.updateRelation(valid); const before = store.getRelations();
  for (const input of [
    null, [], {}, { ...valid, transactionId: ids[1] }, { ...valid, relatedTransactionId: 'unknown' },
    { ...valid, transactionId: 'unknown', status: null }, { ...valid, status: 'duplicate' }, { ...valid, status: false },
    { ...valid, status: undefined }, { ...valid, transactionId: 123 }, { ...valid, amount: 105 },
    { ...valid, relatedTransactionId: 'x'.repeat(201) }
  ]) assert.throws(() => store.updateRelation(input));
  assert.deepEqual(store.getRelations(), before);
});

test('saved relations preserve all financial tables and survive corrections, reimports and database reopen', t => {
  const path = join(temporary(t), 'ledger.sqlite');
  let store = createStore(path); const { input, ids } = fixture(store);
  const before = store.exportLedger().tables;
  store.updateRelation({ transactionId: ids[0], relatedTransactionId: ids[1], status: 'confirmed' });
  store.updateRelation({ transactionId: ids[0], relatedTransactionId: ids[2], status: 'dismissed' });
  const after = store.exportLedger().tables;
  for (const table of LEDGER_TABLES.filter(table => table !== 'transaction_relations')) assert.deepEqual(after[table], before[table], `${table} must not change when connecting payments`);
  assert.equal(store.ingest(input).duplicate, true);
  store.ingest({ ...input, data: { transactions: [{ ...input.data.transactions[0], description: 'Corrected source memo' }] } });
  const decisions = store.getRelations();
  assert.equal(decisions.decisions.length, 2);
  store.close(); store = createStore(path); t.after(() => store.close());
  assert.deepEqual(store.getRelations(), decisions);
  assert.equal(store.getTransactions().transactions.length, 3);
});

test('schema one migrates atomically to the current version without changing saved financial data or import identity', t => {
  const path = join(temporary(t), 'schema-one.sqlite');
  let store = createStore(path); const { input, ids } = fixture(store);
  store.saveSettings({ fields: { cash: '1.05', 'balance-date': '2026-01-01' } });
  store.saveOverrides({ [ids[0]]: { category: 'Owner category', excludeForecast: true } });
  const original = store.exportLedger().tables; delete original.transaction_relations; delete original.transaction_account_memberships; delete original.external_endpoint_refs; delete original.transaction_category_decisions;
  store.close();
  // An actual version-one schema: every original table and saved record,
  // with neither the new table nor its schema version present.
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE transaction_category_decisions; DROP TABLE transaction_account_memberships; DROP TABLE external_endpoint_refs; DROP TABLE transaction_relations; PRAGMA user_version=1');
  legacy.close();
  store = createStore(path);
  const migrated = store.exportLedger();
  assert.equal(migrated.databaseSchemaVersion, DATABASE_SCHEMA_VERSION);
  assert.deepEqual(migrated.tables.transaction_relations, []);
  for (const table of Object.keys(original)) assert.deepEqual(migrated.tables[table], original[table]);
  assert.equal(store.ingest(input).duplicate, true);
  store.updateRelation({ transactionId: ids[0], relatedTransactionId: ids[1], status: 'confirmed' });
  const decision = store.getRelations(); store.close();
  store = createStore(path); t.after(() => store.close());
  assert.deepEqual(store.getRelations(), decision, 'reopening schema two must not rerun destructive initialization');
});

test('SQLite enforces sorted distinct foreign-key pairs and complete backups retain saved decisions', async t => {
  const directory = temporary(t), path = join(directory, 'source.sqlite'), destination = join(directory, 'snapshot.sqlite');
  const store = createStore(path); t.after(() => store.close()); const { ids } = fixture(store);
  store.updateRelation({ transactionId: ids[0], relatedTransactionId: ids[1], status: 'confirmed' });
  const db = new DatabaseSync(path); t.after(() => db.close()); db.exec('PRAGMA foreign_keys=ON');
  const insert = db.prepare('INSERT INTO transaction_relations(transaction_a,transaction_b,status,created_at,updated_at) VALUES(?,?,?,?,?)');
  const timestamp = '2026-01-01T00:00:00.000Z';
  assert.throws(() => insert.run(ids[2], ids[0], 'confirmed', timestamp, timestamp), /CHECK/);
  assert.throws(() => insert.run(ids[2], ids[2], 'confirmed', timestamp, timestamp), /CHECK/);
  assert.throws(() => insert.run('a-missing', 'z-missing', 'confirmed', timestamp, timestamp), /FOREIGN KEY/);
  assert.throws(() => insert.run(ids[1], ids[2], 'invalid', timestamp, timestamp), /CHECK/);
  const json = store.exportLedger();
  assert.equal(json.databaseSchemaVersion, DATABASE_SCHEMA_VERSION);
  assert.equal(json.tables.transaction_relations.length, 1);
  await store.backup(destination);
  const restored = createStore(destination); t.after(() => restored.close());
  assert.deepEqual(restored.getRelations(), store.getRelations());
  assert.deepEqual(restored.exportLedger().tables, json.tables);
});

test('newer unsupported schemas are refused without changing their version or contents', t => {
  const path = join(temporary(t), 'future.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES(\'synthetic-preserved\'); PRAGMA user_version=99');
  db.close();
  assert.throws(() => createStore(path), /newer/);
  const check = new DatabaseSync(path, { readOnly: true }); t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(check.prepare('SELECT value FROM future_data').get().value, 'synthetic-preserved');
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table'").get().count, 1);
});

test('a failed schema-two migration rolls back its new table and keeps version-one data intact', t => {
  const path = join(temporary(t), 'migration-failure.sqlite');
  const seed = createStore(path); fixture(seed);
  const original = seed.exportLedger().tables; delete original.transaction_relations; delete original.transaction_account_memberships; delete original.external_endpoint_refs; delete original.transaction_category_decisions; seed.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE transaction_category_decisions; DROP TABLE transaction_account_memberships; DROP TABLE external_endpoint_refs; DROP TABLE transaction_relations; PRAGMA user_version=1'); legacy.close();
  const originalExec = DatabaseSync.prototype.exec;
  try {
    DatabaseSync.prototype.exec = function (sql) {
      const result = originalExec.call(this, sql);
      if (sql.includes('CREATE TABLE transaction_relations')) throw new Error('Synthetic migration interruption after DDL.');
      return result;
    };
    assert.throws(() => createStore(path), /Synthetic migration interruption/);
  } finally { DatabaseSync.prototype.exec = originalExec; }
  const check = new DatabaseSync(path, { readOnly: true }); t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='transaction_relations'").get().count, 0);
  for (const table of Object.keys(original)) assert.deepEqual(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), original[table]);
  const recovered = createStore(path); t.after(() => recovered.close());
  assert.equal(recovered.exportLedger().databaseSchemaVersion, DATABASE_SCHEMA_VERSION, 'a later successful reopen must complete the migration');
});

test('concurrent connections can open and migrate one version-one database without losing financial state', async t => {
  const { Worker } = await import('node:worker_threads');
  const path = join(temporary(t), 'concurrent-migration.sqlite');
  const seed = createStore(path); const { ids } = fixture(seed);
  const original = seed.exportLedger().tables; delete original.transaction_relations; delete original.transaction_account_memberships; delete original.external_endpoint_refs; delete original.transaction_category_decisions; seed.close();
  const legacy = new DatabaseSync(path); legacy.exec('DROP TABLE transaction_category_decisions; DROP TABLE transaction_account_memberships; DROP TABLE external_endpoint_refs; DROP TABLE transaction_relations; PRAGMA user_version=1'); legacy.close();
  const source = `const {parentPort,workerData}=require('node:worker_threads'); import(workerData.module).then(({createStore})=>{ const store=createStore(workerData.path); try { parentPort.postMessage({version:store.exportLedger().databaseSchemaVersion,decisions:store.getRelations().decisions.length}); } finally {store.close();} });`;
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { path, module: new URL('../src/server/database.js', import.meta.url).href } });
    t.after(() => worker.terminate());
    worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code !== 0) reject(new Error('Synthetic migration worker failed.')); });
  });
  assert.deepEqual(await Promise.all([run(), run()]), [{ version: DATABASE_SCHEMA_VERSION, decisions: 0 }, { version: DATABASE_SCHEMA_VERSION, decisions: 0 }]);
  const final = createStore(path); t.after(() => final.close());
  const migrated = final.exportLedger().tables;
  for (const table of Object.keys(original)) assert.deepEqual(migrated[table], original[table]);
  assert.deepEqual(final.getTransactions().transactions.map(transaction => transaction.id).sort(), ids);
});

test('an unexpected relation-table collision on schema one is refused without advancing or overwriting state', t => {
  const path = join(temporary(t), 'schema-collision.sqlite');
  const seed = createStore(path); fixture(seed);
  const original = seed.exportLedger().tables; delete original.transaction_relations; delete original.transaction_account_memberships; delete original.external_endpoint_refs; delete original.transaction_category_decisions; seed.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE transaction_category_decisions; DROP TABLE transaction_account_memberships; DROP TABLE external_endpoint_refs; DROP TABLE transaction_relations; CREATE TABLE transaction_relations(unexpected TEXT); INSERT INTO transaction_relations VALUES('synthetic-preserved'); PRAGMA user_version=1");
  legacy.close();
  assert.throws(() => createStore(path), /already exists/);
  const check = new DatabaseSync(path, { readOnly: true }); t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(check.prepare('SELECT unexpected FROM transaction_relations').get().unexpected, 'synthetic-preserved');
  for (const table of Object.keys(original)) assert.deepEqual(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), original[table]);
});

test('unsupported future versions and failed connection setup close the opened database handle', t => {
  const directory = temporary(t), futurePath = join(directory, 'future-close.sqlite'), setupPath = join(directory, 'setup-close.sqlite');
  const future = new DatabaseSync(futurePath); future.exec('PRAGMA user_version=99'); future.close();
  const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
  let closed = 0;
  try {
    DatabaseSync.prototype.close = function () { closed++; return originalClose.call(this); };
    assert.throws(() => createStore(futurePath), /newer/);
    assert.equal(closed, 1);
    DatabaseSync.prototype.exec = function (sql) {
      if (sql.includes('PRAGMA foreign_keys=ON')) throw new Error('Synthetic setup failure.');
      return originalExec.call(this, sql);
    };
    assert.throws(() => createStore(setupPath), /Synthetic setup failure/);
    assert.equal(closed, 2, 'setup errors must also close the handle before returning');
  } finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.close = originalClose; }
  const check = new DatabaseSync(futurePath, { readOnly: true }); t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
});

test('simultaneous reversed-pair requests serialize into one decision and same-status retries preserve timestamps', async t => {
  const { Worker } = await import('node:worker_threads');
  const path = join(temporary(t), 'concurrent-decisions.sqlite');
  const store = createStore(path); t.after(() => store.close()); const { ids } = fixture(store);
  const financial = store.exportLedger().tables; delete financial.transaction_relations;
  const source = `
    const {parentPort,workerData}=require('node:worker_threads');
    import(workerData.module).then(({createStore})=>{
      const store=createStore(workerData.path);
      try {
        const start=new Int32Array(workerData.start);
        parentPort.postMessage('ready');
        while(Atomics.load(start,0)!==1) if(Atomics.wait(start,0,0,10000)==='timed-out') throw new Error('Synthetic request barrier timed out.');
        parentPort.postMessage(store.updateRelation(workerData.input));
      } finally {store.close();}
    });
  `;
  const phase = async statuses => {
    const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT), signal = new Int32Array(start);
    const workers = statuses.map((status, index) => {
      const worker = new Worker(source, { eval: true, workerData: { path, start, module: new URL('../src/server/database.js', import.meta.url).href, input: { transactionId: ids[index % 2], relatedTransactionId: ids[1 - index % 2], status } } });
      let readyResolve, readyReject, doneResolve, doneReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
      worker.on('message', message => message === 'ready' ? readyResolve() : doneResolve(message));
      worker.once('error', error => { readyReject(error); doneReject(error); });
      worker.once('exit', code => { if (code !== 0) { const error = new Error('Synthetic relationship worker failed.'); readyReject(error); doneReject(error); } });
      return { worker, ready, done };
    });
    try {
      await Promise.all(workers.map(item => item.ready));
      Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
      return await Promise.all(workers.map(item => item.done));
    } finally { await Promise.all(workers.map(item => item.worker.terminate())); }
  };
  const first = await phase(['confirmed', 'confirmed']);
  assert.deepEqual(first[0], first[1]);
  assert.equal(store.getRelations().decisions.length, 1);
  const initial = store.getRelations().decisions[0];
  assert.equal(initial.status, 'confirmed');
  const changed = await phase(['confirmed', 'dismissed']);
  assert.equal(changed[0].decisions[0].status, 'confirmed');
  assert.equal(changed[1].decisions[0].status, 'dismissed');
  const final = store.getRelations().decisions;
  assert.equal(final.length, 1);
  assert.equal(final[0].createdAt, initial.createdAt);
  assert.ok(['confirmed', 'dismissed'].includes(final[0].status));
  const after = store.exportLedger().tables;
  for (const table of Object.keys(financial)) assert.deepEqual(after[table], financial[table]);
});
