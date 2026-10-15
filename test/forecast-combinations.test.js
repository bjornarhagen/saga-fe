import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCombinations, forecastScopes, defaultForecastScopes } from '../src/lib/forecast-combinations.js';
import { financialProjection } from '../src/lib/financial-forecast.js';
import { project } from '../src/lib/engine.js';

const asOf = '2026-01-31';
const account = (id, group, balance, extra = {}) => ({ id, role: group === 'cash' ? 'available' : group === 'reserve' ? 'reserve' : 'excluded', accountType: group === 'investments' ? 'investment' : 'checking', balance, balanceDate: asOf, ...extra });
const accounts = [account('daily', 'cash', 100), account('savings', 'reserve', 1000), account('portfolio', 'investments', 4000), account('other', 'other', 9000)];
function path({ useReserve = true, cash = 100, reserve = 1000, investments = 4000, id = 'scenario' } = {}) {
  const projection = project({ cash, savings: reserve, income: 0, expense: 200, saving: 100, horizon: 2, asOf });
  return { id, name: id, projection: financialProjection({ projection, cash, reserve, investments, asOf, useReserve, reserveContribution: 60, investmentContribution: 40 }) };
}
const allScopes = forecastScopes.map(scope => scope.id);
const build = (options = {}) => forecastCombinations({ accounts, asOf, paths: [path()], scopes: allScopes, ...options });
const scope = (result, id) => result.scopes.find(entry => entry.id === id);

test('all six combinations sum disjoint positions and ignore outside accounts', () => {
  assert.deepEqual(defaultForecastScopes, ['cash', 'cash-reserve-investments']);
  const result = build();
  assert.deepEqual(result.scopes.map(entry => entry.projections[0].points[0].value), [100, 1000, 4000, 1100, 4100, 5100]);
  assert.deepEqual(result.scopes.map(entry => entry.projections[0].points[1].value), [0, 860, 4040, 860, 4040, 4900]);
  assert.equal(scope(result, 'cash-reserve-investments').coverage.accounts, 3);
  assert.ok(result.scopes.every(entry => entry.projections[0].matchesHistory));
});

test('reserve support changes positions once and preserves negative cash without it', () => {
  const drawn = build(), untouched = build({ paths: [path({ useReserve: false })] });
  assert.deepEqual(scope(untouched, 'cash').projections[0].points.map(point => point.value), [100, -200, -500]);
  for (const id of ['cash-reserve', 'cash-reserve-investments']) assert.deepEqual(scope(drawn, id).projections[0].points, scope(untouched, id).projections[0].points);
  assert.equal(scope(drawn, 'cash-reserve-investments').projections[0].points.at(-1).value, 4700);
});

test('an asset allocation error leaves an independently valid cash path visible', () => {
  const cashPath = path({ useReserve: false });
  cashPath.scopeReasons = { reserve: 'Review contribution allocation.', investments: 'Review contribution allocation.', 'cash-reserve': 'Review contribution allocation.', 'cash-investments': 'Review contribution allocation.', 'cash-reserve-investments': 'Review contribution allocation.' };
  const result = build({ paths: [cashPath] });
  assert.equal(scope(result, 'cash').projections[0].reason, '');
  assert.deepEqual(scope(result, 'cash').projections[0].points.map(point => point.value), [100, -200, -500]);
  for (const id of allScopes.filter(id => id !== 'cash')) {
    assert.equal(scope(result, id).projections[0].reason, 'Review contribution allocation.');
    assert.deepEqual(scope(result, id).projections[0].points, []);
  }
});

test('observed combinations require a known same-date snapshot from every included account', () => {
  const rows = [
    account('daily', 'cash', null, { balanceDate: '2026-03-31', valueHistory: [{ date: asOf, amount: 100 }, { date: '2026-02-28', amount: 110 }, { date: '2026-03-31', amount: null }] }),
    account('second', 'cash', 30, { balanceDate: '2026-03-31', valueHistory: [{ date: asOf, amount: 20 }, { date: '2026-03-31', amount: 30 }] }),
    account('savings', 'reserve', 300, { balanceDate: '2026-03-31', balanceHistory: [{ date: asOf, amount: 200 }, { date: '2026-02-28', amount: 250 }, { date: '2026-03-31', amount: 300 }] }),
    account('portfolio', 'investments', 450, { balanceDate: '2026-03-31', valueHistory: [{ date: asOf, amount: 400 }, { date: '2026-02-28', amount: 500 }, { date: '2026-03-31', amount: 450 }] }),
  ];
  const result = build({ accounts: rows, asOf: '2026-03-31', paths: [] });
  assert.deepEqual(scope(result, 'cash').history.map(point => point.value), [120, null, null]);
  assert.deepEqual(scope(result, 'cash-reserve-investments').history.map(point => point.value), [720, null, null]);
  assert.deepEqual(scope(result, 'investments').history.map(point => point.value), [400, 500, 450]);
  assert.deepEqual(scope(result, 'reserve').history.map(point => point.value), [200, 250, 300]);
  assert.equal(scope(result, 'cash').coverage.status, 'partial');
  assert.equal(scope(result, 'cash').coverage.missingAtStart, 1);
});

test('reconstructed cash is labelled separately and never becomes inferred investment history', () => {
  const result = build({ reconstructedCash: [{ date: '2025-12-31', history: 500 }, { date: '2025-11-30', history: 300 }], historyStart: '2025-12-01' });
  assert.deepEqual(scope(result, 'cash').reconstructedHistory, [{ date: '2025-12-31', value: 500, kind: 'reconstructed' }]);
  assert.ok(result.scopes.filter(entry => entry.id !== 'cash').every(entry => !entry.reconstructedHistory.length));
  assert.deepEqual(scope(result, 'investments').history, [{ date: asOf, value: 4000, kind: 'observed' }]);
});

test('a mixed-date starting estimate must be explicit and never adds historical observations', () => {
  const rows = accounts.map(row => row.id === 'portfolio' ? { ...row, balanceDate: '2026-01-30' } : row);
  const observed = build({ accounts: rows });
  assert.equal(scope(observed, 'cash').projections[0].reason, '');
  assert.ok(scope(observed, 'cash-reserve-investments').projections[0].reason.includes('starting date'));
  const estimated = build({ accounts: rows, startMode: 'latest' });
  const combined = scope(estimated, 'cash-reserve-investments');
  assert.equal(combined.projections[0].startKind, 'estimated');
  assert.equal(combined.projections[0].points[0].value, 5100);
  assert.equal(combined.projections[0].matchesHistory, false);
  assert.ok(combined.history.every(point => point.value === null));
  assert.deepEqual(combined.coverage.currentDates, ['2026-01-30', asOf]);
});

test('unknown or undated latest values block only the affected account combinations', () => {
  for (const change of [{ balance: null }, { balanceDate: null }]) {
    const result = build({ accounts: accounts.map(row => row.id === 'portfolio' ? { ...row, ...change } : row), startMode: 'latest' });
    assert.equal(scope(result, 'cash-reserve').projections[0].reason, '');
    assert.ok(scope(result, 'cash-investments').projections[0].reason);
    assert.equal(scope(result, 'cash-investments').projections[0].points.length, 0);
  }
});

test('manual totals remain separate from observed history and require observed investments', () => {
  const manual = build({ startMode: 'manual', paths: [path({ cash: 500, reserve: 2000 })] });
  assert.equal(scope(manual, 'cash-reserve-investments').projections[0].points[0].value, 6500);
  assert.equal(scope(manual, 'cash-reserve-investments').projections[0].matchesHistory, false);
  assert.equal(scope(manual, 'cash-reserve-investments').projections[0].startKind, 'manual');
  assert.equal(scope(manual, 'investments').projections[0].startKind, 'observed');
  const missing = build({ startMode: 'manual', accounts: accounts.map(row => row.id === 'portfolio' ? { ...row, balanceDate: '2026-01-30' } : row) });
  assert.ok(scope(missing, 'investments').projections[0].reason);
  assert.equal(scope(missing, 'cash').projections[0].reason, '');
  const mismatched = build({ paths: [path({ cash: 500 })] });
  assert.ok(scope(mismatched, 'cash').projections[0].reason.includes('differs'));
});

test('empty groups are structurally zero but do not invent standalone history', () => {
  const result = build({ accounts: [accounts[0]], paths: [path({ reserve: 0, investments: 0 })] });
  assert.equal(scope(result, 'reserve').history.length, 0);
  assert.equal(scope(result, 'reserve').coverage.status, 'empty');
  assert.equal(scope(result, 'cash-reserve-investments').projections[0].points[0].value, 100);
  const invented = build({ accounts: [accounts[0]] });
  assert.ok(scope(invented, 'investments').projections[0].reason.includes('matching tracked accounts'));
});

test('each method keeps independent projected segments and starting references', () => {
  const result = build({ paths: [path(), path({ id: 'other-method', useReserve: false }), { id: 'unavailable', reason: 'Needs more complete months.' }] });
  const cash = scope(result, 'cash');
  assert.equal(cash.projections.length, 3);
  assert.deepEqual(cash.reference, { date: asOf, value: 100, kind: 'observed', label: 'Available cash at start' });
  assert.equal(cash.projections[1].points[1].value, -200);
  assert.equal(cash.projections[2].reason, 'Needs more complete months.');
  assert.deepEqual(scope(build({ paths: [] }), 'cash').reference, { date: asOf, value: 100, kind: 'observed', label: 'Available cash recorded at start' });
});

test('movement fields, growth assumptions and future snapshots never fabricate observations', () => {
  const rows = accounts.map(row => ({ ...row, valueHistory: [{ date: '2025-12-31', amount: row.balance, recordedMovement: 500, unexplainedChange: -400 }, { date: '2026-02-28', amount: 99999 }] }));
  const result = build({ accounts: rows });
  assert.deepEqual(scope(result, 'investments').history.map(point => [point.date, point.value]), [['2025-12-31', 4000], [asOf, 4000]]);
  assert.deepEqual(scope(build({ historyStart: asOf }), 'cash').history.map(point => point.date), [asOf]);
});

test('combined amounts use exact safe integer arithmetic and reject overflow', () => {
  assert.throws(() => build({ accounts: [...accounts, account('extra', 'cash', Number.MAX_SAFE_INTEGER)] }), RangeError);
  const unsafePath = path();
  unsafePath.projection.points[0] = { ...unsafePath.projection.points[0], investments: Number.MAX_SAFE_INTEGER };
  const result = build({ paths: [unsafePath] });
  assert.equal(scope(result, 'cash').projections[0].reason, '');
  assert.match(scope(result, 'cash-reserve-investments').projections[0].reason, /integer øre range/);
  assert.equal(scope(result, 'cash-reserve-investments').projections[0].points.length, 0);
});

test('invalid chart dates, method date sequences and unknown scopes fail clearly', () => {
  assert.throws(() => build({ asOf: '2026-02-30' }), RangeError);
  assert.throws(() => build({ scopes: ['everything'] }), RangeError);
  assert.throws(() => build({ startMode: 'silently-latest' }), RangeError);
  const wrong = path();
  wrong.projection.points[0].date = asOf;
  assert.match(scope(build({ paths: [wrong] }), 'cash').projections[0].reason, /dates must increase/);
  assert.deepEqual(build({ scopes: [] }).scopes, []);
});
