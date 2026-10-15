import test from 'node:test';
import assert from 'node:assert/strict';
import { accountGrowthEvidence, growthReview } from '../src/lib/organic-growth.js';

const from = '2026-01-01', to = '2027-01-01';
const account = (id = 'portfolio', start = 100000, end = 110000, dates = [from, to]) => ({ id, valueHistory: [{ date: dates[0], amount: start }, { date: dates[1], amount: end }] });
const endpoint = accountId => ({ owned: true, accountId });
const deposit = (id, date, amount, accountId = 'portfolio') => ({ id, date, amount, from: endpoint('cash'), to: endpoint(accountId) });
const coverage = (accountIds = ['portfolio'], first = from, last = to) => ({ complete: true, from: first, to: last, accountIds });
const evidence = options => accountGrowthEvidence({ accounts: [account()], coverage: coverage(), ...options });

test('a full-year observation with confirmed movement coverage estimates return without inventing contributions', () => {
  const result = evidence();
  assert.equal(result.ready, true);
  assert.equal(result.days, 365);
  assert.equal(result.periodRate, 0.1);
  assert.equal(result.annualGrowthBps, 1000);
  assert.equal(result.otherChange, 10000);
  assert.equal(result.shortPeriod, false);
});

test('unknown or incomplete coverage never interprets missing movements as zero', () => {
  for (const missing of [null, { complete: false }, coverage([]), coverage(['different']), { ...coverage(), from: '2026-02-30' }]) {
    const result = evidence({ coverage: missing });
    assert.equal(result.ready, false);
    assert.equal(result.code, 'coverage');
    assert.equal(result.periodRate, null);
    assert.equal(result.annualGrowthBps, null);
    assert.equal(result.otherChange, 10000);
  }
});

test('end-of-day contribution timing weights capital instead of calling injections growth', () => {
  const dates = ['2026-01-01', '2026-04-11'];
  const result = evidence({ accounts: [account('portfolio', 100000, 215000, dates)], coverage: coverage(['portfolio'], ...dates), flows: [deposit('funding', '2026-02-20', 100000)], minimumDays: 90 });
  assert.equal(result.ready, true);
  assert.equal(result.days, 100);
  assert.equal(result.capitalNetMovement, 100000);
  assert.equal(result.otherChange, 15000);
  assert.equal(result.periodRate, 0.1);
  assert.equal(result.annualGrowthBps, Math.round(Math.expm1(Math.log1p(0.1) * 365 / 100) * 10000));
});

test('withdrawals are negative capital, not investment losses', () => {
  const dates = ['2026-01-01', '2026-04-11'];
  const result = evidence({ accounts: [account('portfolio', 100000, 68000, dates)], coverage: coverage(['portfolio'], ...dates), flows: [{ id: 'withdrawal', date: '2026-02-20', amount: 40000, from: endpoint('portfolio'), to: endpoint('cash') }], minimumDays: 90 });
  assert.equal(result.ready, true);
  assert.equal(result.capitalNetMovement, -40000);
  assert.equal(result.otherChange, 8000);
  assert.equal(result.periodRate, 0.1);
});

test('group transfers cancel; canonical IDs guard against repeated copies of the same movement', () => {
  const flows = [deposit('funding', '2026-06-01', 10000), deposit('funding', '2026-06-01', 10000), { id: 'rebalance', date: '2026-06-02', amount: 50000, from: endpoint('portfolio'), to: endpoint('second') }];
  const result = evidence({ accounts: [account('portfolio', 100000, 60000), account('second', 100000, 160000)], flows, coverage: coverage(['portfolio', 'second']) });
  assert.equal(result.ready, true);
  assert.equal(result.startValue, 200000);
  assert.equal(result.endValue, 220000);
  assert.equal(result.recordedNetMovement, 10000);
  assert.equal(result.otherChange, 10000);
});

test('interest, dividends, and fees require explicit return classification and stay in the numerator', () => {
  const interest = { id: 'interest', date: '2026-12-31', amount: 2000, from: { owned: false }, to: endpoint('portfolio') };
  const fee = { id: 'fee', date: '2026-12-31', amount: 1000, from: endpoint('portfolio'), to: { owned: false } };
  const unclassified = evidence({ flows: [interest, fee] });
  assert.equal(unclassified.code, 'classification');
  assert.equal(unclassified.unclassifiedMovements, 2);
  assert.equal(unclassified.otherChange, 9000);
  assert.equal(unclassified.annualGrowthBps, null);
  const classified = evidence({ flows: [interest, fee], flowKinds: { interest: 'return', fee: 'return' } });
  assert.equal(classified.ready, true);
  assert.equal(classified.capitalNetMovement, 0);
  assert.equal(classified.returnMovement, 1000);
  assert.equal(classified.annualGrowthBps, 1000);
});

test('external capital funding can be classified without promoting its counterparty to an owned account', () => {
  const flow = { id: 'capital', date: '2026-12-31', amount: 10000, from: { owned: false }, to: endpoint('portfolio') };
  const result = evidence({ flows: [flow], flowKinds: { capital: 'capital' } });
  assert.equal(result.ready, true);
  assert.equal(result.otherChange, 0);
  assert.equal(result.periodRate, 0);
  assert.equal(result.annualGrowthBps, 0);
});

test('opening value includes opening-date movements while closing-date funding receives zero weight', () => {
  const result = evidence({ accounts: [account('portfolio', 100000, 120000)], flows: [deposit('opening', from, 99999), deposit('closing', to, 10000), deposit('future', '2027-01-02', 50000)] });
  assert.equal(result.ready, true);
  assert.equal(result.recordedNetMovement, 10000);
  assert.equal(result.periodRate, 0.1);
});

test('short histories expose only a period return and do not annualize a noisy observation', () => {
  const dates = ['2026-01-01', '2026-01-31'];
  const result = evidence({ accounts: [account('portfolio', 100000, 101000, dates)], coverage: coverage(['portfolio'], ...dates) });
  assert.equal(result.ready, false);
  assert.equal(result.code, 'short-period');
  assert.equal(result.days, 30);
  assert.equal(result.periodRate, 0.01);
  assert.equal(result.annualGrowthBps, null);
  assert.equal(result.shortPeriod, true);
});

test('only matching known dates enter group values, with no carried-forward or future values', () => {
  const first = account();
  first.valueHistory.push({ date: '2028-01-01', amount: 9999999 });
  const second = account('second', 100000, 110000, ['2026-01-02', to]);
  let result = evidence({ accounts: [first, second], coverage: coverage(['portfolio', 'second']), asOf: to });
  assert.equal(result.code, 'observations');
  second.valueHistory.push({ date: from, amount: null });
  result = evidence({ accounts: [first, second], coverage: coverage(['portfolio', 'second']), asOf: to });
  assert.equal(result.code, 'observations');
  assert.equal(result.observations, 1);
});

test('coverage dates bound the actual estimate rather than blessing uncovered history', () => {
  const result = evidence({ coverage: coverage(['portfolio'], '2026-02-01', to) });
  assert.equal(result.code, 'observations');
  assert.equal(result.observations, 1);
});

test('same-date current balances are observations and never overwrite an explicit unknown value', () => {
  const current = { id: 'portfolio', balance: 110000, balanceDate: to, valueHistory: [{ date: from, amount: 100000 }] };
  assert.equal(evidence({ accounts: [current] }).annualGrowthBps, 1000);
  current.valueHistory.push({ date: to, amount: null });
  assert.equal(evidence({ accounts: [current] }).code, 'observations');
});

test('complete losses, zero capital, and negative values have explicit outcomes', () => {
  assert.equal(evidence({ accounts: [account('portfolio', 100000, 0)] }).annualGrowthBps, -10000);
  assert.equal(evidence({ accounts: [account('portfolio', 0, 100000)] }).code, 'capital');
  assert.equal(evidence({ accounts: [account('portfolio', -1, 100000)] }).code, 'values');
});

test('unsupported annual rates, exact-amount overflow, and malformed flows never become assumptions', () => {
  assert.equal(evidence({ accounts: [account('portfolio', 1, 100000)] }).code, 'range');
  assert.equal(evidence({ accounts: [account('portfolio', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), account('second', 1000, 1000)], coverage: coverage(['portfolio', 'second']) }).code, 'amounts');
  assert.equal(evidence({ flows: [{ ...deposit('bad', '2026-02-01', 100), id: '' }] }).code, 'movements');
  assert.equal(evidence({ flows: [deposit('bad', '2026-02-30', 100)] }).code, 'movements');
  assert.equal(evidence({ flows: [deposit('bad', '2026-02-01', -100)] }).code, 'amounts');
});

test('caller data stays unchanged and invalid model configuration fails clearly', () => {
  const row = account(), flow = deposit('funding', '2026-12-31', 1000), input = { accounts: [row], flows: [flow], coverage: coverage() };
  const before = structuredClone(input);
  accountGrowthEvidence(input);
  assert.deepEqual(input, before);
  for (const invalid of [{ asOf: '2026-02-30' }, { minimumDays: 1 }, { minimumDays: 30.5 }, { flowKinds: { sample: 'unknown' } }, { accounts: [account(), account()] }]) assert.throws(() => evidence(invalid), RangeError);
});

test('growth review offers exact dated coverage and classifiable external movements without assuming completeness', () => {
  const income = { id: 'interest', date: '2026-12-31', amount: 1000, from: { owned: false }, to: endpoint('portfolio'), label: 'Example interest' };
  const result = growthReview({ accounts: [account()], flows: [deposit('funding', '2026-06-01', 10000), income, income] });
  assert.deepEqual(result.candidateCoverage, coverage());
  assert.equal(result.coverageCurrent, false);
  assert.equal(result.evidence.code, 'coverage');
  assert.deepEqual(result.unclassified, [{ id: 'interest', date: '2026-12-31', amount: 1000, direction: 'incoming', label: 'Example interest', kind: null }]);
  const confirmed = growthReview({ accounts: [account()], flows: [income], options: { coverage: result.candidateCoverage, flowKinds: { interest: 'return' } } });
  assert.equal(confirmed.coverageCurrent, true);
  assert.equal(confirmed.evidence.ready, true);
  assert.equal(confirmed.unclassified.length, 0);
  assert.equal(confirmed.movements[0].kind, 'return');
});

test('new observations and group membership require renewed coverage confirmation', () => {
  const changed = account(); changed.valueHistory.push({ date: '2027-02-01', amount: 112000 });
  const result = growthReview({ accounts: [changed], options: { coverage: coverage() } });
  assert.equal(result.coverageCurrent, false);
  assert.equal(result.candidateCoverage.to, '2027-02-01');
  assert.equal(result.evidence.code, 'coverage');
  assert.equal(result.evidence.annualGrowthBps, null);
  const group = growthReview({ accounts: [account(), account('second')], options: { coverage: coverage() } });
  assert.equal(group.coverageCurrent, false);
  assert.equal(group.evidence.annualGrowthBps, null);
});

test('growth review requires a full year by default and has no candidate for one observation', () => {
  const dates = ['2026-01-01', '2026-04-11'];
  const review = growthReview({ accounts: [account('portfolio', 100000, 110000, dates)], options: { coverage: coverage(['portfolio'], ...dates) } });
  assert.equal(review.coverageCurrent, true);
  assert.equal(review.evidence.code, 'short-period');
  assert.equal(review.evidence.annualGrowthBps, null);
  const single = growthReview({ accounts: [{ id: 'portfolio', balance: 100000, balanceDate: from }] });
  assert.equal(single.candidateCoverage, null);
  assert.deepEqual(single.movements, []);
});
