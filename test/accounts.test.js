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
