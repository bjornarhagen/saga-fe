import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAccounts } from '../src/lib/account-statistics.js';

const account = (balance, fields = {}) => ({ balance, balanceDate: '2026-10-15', accountType: 'checking', role: 'available', institution: 'Example Bank', ...fields });
const group = (summary, kind, id) => summary.groups[kind].find(row => row.id === id);

test('account totals include signed balances and disclose unknown observations', () => {
  const summary = summarizeAccounts([account(1200), account(-350), account(null), account(0)]);
  assert.equal(summary.count, 4);
  assert.equal(summary.knownCount, 3);
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.positiveTotal, 1200);
  assert.equal(summary.negativeTotal, -350);
  assert.equal(summary.total, 850);
  assert.equal(summary.cashTotal, 850);
  assert.equal(summary.oldestDate, '2026-10-15');
  assert.equal(summary.newestDate, '2026-10-15');
  assert.equal(summary.mixedDates, false);
  assert.equal(group(summary, 'role', 'available').unknownCount, 1);
});

test('empty and unknown values stay unknown while a known zero stays zero', () => {
  for (const accounts of [[], [account(null), account(undefined)]]) {
    const summary = summarizeAccounts(accounts);
    assert.equal(summary.total, null);
    assert.equal(summary.positiveTotal, null);
    assert.equal(summary.negativeTotal, null);
    assert.equal(summary.cashTotal, null);
    assert.equal(summary.oldestDate, null);
    assert.equal(summary.newestDate, null);
    assert.equal(summary.mixedDates, false);
  }
  const zero = summarizeAccounts([account(0)]);
  assert.equal(zero.knownCount, 1);
  assert.equal(zero.total, 0);
  assert.equal(zero.positiveTotal, 0);
  assert.equal(zero.negativeTotal, 0);
  assert.equal(zero.cashTotal, 0);
  assert.equal(group(zero, 'role', 'reserve').total, null);
});

test('role groups do not double count investments and cash includes reserves only once', () => {
  const summary = summarizeAccounts([
    account(100),
    account(200, { role: 'reserve', accountType: 'savings' }),
    account(300, { role: 'available', accountType: 'investment' }),
    account(400, { role: 'reserve', accountType: 'investment' }),
    account(-50, { role: 'excluded', accountType: 'credit' })
  ]);
  assert.equal(summary.total, 950);
  assert.equal(summary.cashTotal, 300);
  assert.deepEqual(summary.groups.role.map(row => [row.id, row.total]), [
    ['available', 100], ['reserve', 200], ['investment', 700], ['excluded', -50]
  ]);
  assert.equal(summary.groups.role.reduce((sum, row) => sum + row.count, 0), 5);
  assert.equal(summary.groups.type.reduce((sum, row) => sum + row.count, 0), 5);
  assert.equal(group(summary, 'type', 'investment').total, 700);
});

test('date coverage reflects known values rather than unknown or inferred observations', () => {
  const summary = summarizeAccounts([
    account(100, { balanceDate: '2026-10-01' }),
    account(200, { balanceDate: '2026-10-15' }),
    account(null, { balanceDate: '2020-01-01' }),
    account(300, { balanceDate: null, valueHistory: [{ date: '2019-01-01', amount: 1000 }] })
  ]);
  assert.equal(summary.oldestDate, '2026-10-01');
  assert.equal(summary.newestDate, '2026-10-15');
  assert.equal(summary.mixedDates, true);
  assert.equal(summary.total, 600);
});

test('institution groups sort by exact net total, use stable ties and name absent institutions', () => {
  const summary = summarizeAccounts([
    account(100, { institution: 'Zeta' }),
    account(100, { institution: 'Alpha' }),
    account(500, { institution: 'Largest' }),
    account(-200, { institution: 'Largest' }),
    account(-50, { institution: ' ' }),
    account(null, { institution: 'Unknown' })
  ]);
  assert.deepEqual(summary.groups.institution.map(row => [row.label, row.total]), [
    ['Largest', 300], ['Alpha', 100], ['Zeta', 100], ['Institution not set', -50], ['Unknown', null]
  ]);
  assert.equal(group(summary, 'institution', 'Largest').negativeTotal, -200);
});

test('overflow is unknown without losing exact cancellation or sorting precision', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const overflowing = summarizeAccounts([
    account(max, { institution: 'Biggest' }), account(max, { institution: 'Biggest' }),
    account(max, { institution: 'Smaller' })
  ]);
  assert.equal(overflowing.total, null);
  assert.equal(overflowing.positiveTotal, null);
  assert.equal(overflowing.negativeTotal, 0);
  assert.equal(overflowing.cashTotal, null);
  assert.equal(group(overflowing, 'role', 'available').total, null);
  assert.deepEqual(overflowing.groups.institution.map(row => row.id), ['Biggest', 'Smaller']);
  const cancelling = summarizeAccounts([account(max), account(max), account(-max), account(-max), account(7)]);
  assert.equal(cancelling.total, 7);
  assert.equal(cancelling.cashTotal, 7);
  assert.equal(cancelling.positiveTotal, null);
  assert.equal(cancelling.negativeTotal, null);
  assert.equal(cancelling.knownCount, 5);
});

test('unsafe and fractional observations cannot silently become precise balances', () => {
  const summary = summarizeAccounts([account(Number.MAX_SAFE_INTEGER + 1), account(1.5), account(NaN), account(10)]);
  assert.equal(summary.total, 10);
  assert.equal(summary.knownCount, 1);
  assert.equal(summary.unknownCount, 3);
});

test('summaries leave input accounts and histories unchanged', () => {
  const input = [account(250, { valueHistory: [{ date: '2026-10-15', amount: 250 }] }), account(null, { institution: '' })];
  const original = structuredClone(input);
  Object.freeze(input);
  for (const item of input) {
    if (item.valueHistory) { Object.freeze(item.valueHistory[0]); Object.freeze(item.valueHistory); }
    Object.freeze(item);
  }
  summarizeAccounts(input);
  assert.deepEqual(input, original);
});
