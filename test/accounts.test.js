import test from 'node:test';
import assert from 'node:assert/strict';
import { accountStartingPoint } from '../src/scripts/accounts.js';

test('forecast balances require known aligned snapshots, distinguish zero, and exclude designated accounts', () => {
  const rows = [{ id: 'cash', role: 'available', balance: 0, balanceDate: '2026-01-01' }, { id: 'reserve', role: 'reserve', balance: 50000, balanceDate: '2026-01-01' }, { id: 'other', role: 'excluded', balance: null, balanceDate: null }];
  assert.deepEqual(accountStartingPoint(rows), { ready: true, date: '2026-01-01', cash: 0, savings: 50000 });
  assert.equal(accountStartingPoint(rows.map(a => a.id === 'cash' ? { ...a, balance: null } : a)).ready, false);
  assert.equal(accountStartingPoint(rows.map(a => a.id === 'reserve' ? { ...a, balanceDate: '2026-01-02' } : a)).ready, false);
  assert.equal(accountStartingPoint(rows.filter(a => a.id !== 'cash')).ready, false);
});

test('latest-value estimates preserve observations and keep unknown balances blocking', () => {
  const rows = [{ id: 'daily', role: 'available', balance: 10000, balanceDate: '2026-02-01' }, { id: 'reserve', role: 'reserve', balance: 20000, balanceDate: '2026-02-02' }, { id: 'holdings', role: 'excluded', accountType: 'investment', balance: 30000, balanceDate: '2026-02-03' }];
  const original = structuredClone(rows);
  assert.equal(accountStartingPoint(rows).ready, false);
  assert.deepEqual(accountStartingPoint(rows, { estimateLatest: true }), { ready: true, date: '2026-02-03', cash: 10000, savings: 20000, estimated: true });
  assert.deepEqual(rows, original);
  assert.equal(accountStartingPoint(rows.map(row => row.id === 'reserve' ? { ...row, balance: null } : row), { estimateLatest: true }).ready, false);
});
