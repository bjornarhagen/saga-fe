import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinancialViewsController, sameGrowthCoverage } from '../src/scripts/financial-views.js';

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
    this.textContent = ''; this.innerHTML = ''; this.dataset = {}; this.children = [];
    this.listeners = {}; this.classList = { toggle() {} };
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  querySelector(selector) { return this.children.find(child => `.${child.className}` === selector) || null; }
  querySelectorAll() { return []; }
  closest(selector) { return selector === '[data-growth-movement]' && this.dataset.growthMovement ? this : null; }
  dispatch(type, target = this) { this.listeners[type]?.({ target }); }
}

function setup(t, overrides = {}) {
  const previous = globalThis.document;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  globalThis.document = { activeElement: null, getElementById: element, querySelectorAll: () => [], createElement: () => new Element() };
  t.after(() => { globalThis.document = previous; });
  const changes = [];
  const controller = createFinancialViewsController({ money: value => `${value} øre`, onChange: patch => changes.push(patch) });
  const data = {
    view: 'liquidity', assumptions: {}, allocation: {}, summary: { accounts: [] }, growthBps: 0, reserveGrowthBps: 0,
    assetGrowth: { reserve: { source: 'manual', coverage: null, flowKinds: {} }, investments: { source: 'manual', coverage: null, flowKinds: {} } },
    growthReview: { reserve: { evidence: { ready: false, reason: 'Two dated values are needed.' } }, investments: { evidence: { ready: false, reason: 'Two dated values are needed.' } } },
    ...overrides,
  };
  controller.setData(data);
  return { controller, data, changes, element };
}

const coverage = { complete: true, from: '2025-01-01', to: '2026-01-01', accountIds: ['example-a', 'example-b'] };

test('manual growth remains optional and unavailable history explains the flat projection', t => {
  const { controller, data, element } = setup(t);
  assert.equal(element('financial-growth-assumptions').hidden, false);
  assert.equal(element('financial-growth').disabled, false);
  assert.equal(element('financial-reserve-growth').value, '0.00');
  assert.match(element('financial-growth-evidence-reserve').textContent, /Two dated values/);
  assert.equal(element('financial-growth-history-reserve').hidden, true);
  controller.setData({ ...data, assetGrowth: { ...data.assetGrowth, reserve: { source: 'history', coverage: null, flowKinds: {} } } });
  assert.equal(element('financial-reserve-growth').disabled, true);
  assert.equal(element('financial-growth-history-reserve').hidden, false);
  assert.equal(element('financial-growth-coverage-reserve').disabled, true);
  assert.match(element('financial-growth-evidence-reserve').textContent, /held at 0%/);
  assert.doesNotMatch(element('financial-growth-evidence-reserve').textContent, /annual rate:/);
});

test('source and rate changes preserve the other group and accept exact signed percentages', t => {
  const reserve = { source: 'manual', coverage, flowKinds: { 'example-flow': 'return' } };
  const investments = { source: 'manual', coverage: null, flowKinds: { 'example-capital': 'capital' } };
  const { element, changes } = setup(t, { assetGrowth: { reserve, investments } });
  const source = element('financial-growth-source-reserve'); source.value = 'history'; source.dispatch('change');
  assert.deepEqual(changes.at(-1).assetGrowth, { reserve: { ...reserve, source: 'history' }, investments });
  assert.equal(reserve.source, 'manual');
  const rate = element('financial-reserve-growth'); rate.value = '-1.25'; rate.dispatch('input');
  assert.deepEqual(changes.at(-1), { reserveGrowthBps: -125 });
  const count = changes.length; rate.value = '1.001'; rate.dispatch('input');
  assert.equal(changes.length, count);
  assert.match(element('financial-input-error').textContent, /two decimal places/);
});

test('confirmation is tied to exact dates and accounts and never silently extends', t => {
  assert.equal(sameGrowthCoverage(coverage, { ...coverage, accountIds: ['example-b', 'example-a'] }), true);
  assert.equal(sameGrowthCoverage(coverage, { ...coverage, to: '2026-02-01' }), false);
  assert.equal(sameGrowthCoverage(coverage, { ...coverage, accountIds: ['example-a', 'example-c'] }), false);
  const { element, changes, controller, data } = setup(t, {
    assetGrowth: { reserve: { source: 'history', coverage, flowKinds: {} } },
    growthReview: { reserve: { evidence: { ready: false, reason: 'Review the new period.' }, candidateCoverage: { ...coverage, to: '2026-02-01' } } },
  });
  const input = element('financial-growth-coverage-reserve');
  assert.equal(input.checked, false);
  assert.equal(input.disabled, false);
  assert.match(element('financial-growth-confirmed-reserve').textContent, /Previous confirmation covers 2025-01-01 to 2026-01-01/);
  input.checked = true; input.dispatch('change');
  const confirmed = changes.at(-1).assetGrowth.reserve.coverage;
  assert.deepEqual(confirmed, { ...coverage, to: '2026-02-01' });
  assert.notEqual(confirmed.accountIds, data.growthReview.reserve.candidateCoverage.accountIds);
  controller.setData({ ...data, assetGrowth: changes.at(-1).assetGrowth });
  assert.equal(input.checked, true);
  input.checked = false; input.dispatch('change');
  assert.equal(changes.at(-1).assetGrowth.reserve.coverage, null);
});

test('movement review preserves classifications and focus and renders imported labels as text', t => {
  const movement = { id: 'example-interest', date: '2025-12-31', amount: 305, direction: 'incoming', label: '<img src=x>' };
  const review = { evidence: { ready: false, reason: 'Review external movements.' }, candidateCoverage: coverage, movements: [movement] };
  const { element, changes, controller, data } = setup(t, {
    assetGrowth: { reserve: { source: 'history', coverage, flowKinds: { previous: 'capital' } }, investments: { source: 'manual', coverage: null, flowKinds: { investment: 'return' } } },
    growthReview: { reserve: review },
  });
  const target = element('financial-growth-movements-reserve');
  const row = target.children.find(child => child.className === 'financial-growth-movement');
  const select = row.children[1];
  assert.match(row.children[0].textContent, /<img src=x>/);
  assert.equal(row.children[0].innerHTML, '');
  select.value = 'return'; target.dispatch('change', select);
  assert.deepEqual(changes.at(-1).assetGrowth.reserve.flowKinds, { previous: 'capital', 'example-interest': 'return' });
  assert.deepEqual(changes.at(-1).assetGrowth.investments.flowKinds, { investment: 'return' });
  document.activeElement = select;
  controller.setData({ ...data, assetGrowth: changes.at(-1).assetGrowth });
  assert.equal(target.children.find(child => child.className === 'financial-growth-movement').children[1], select);
  assert.equal(document.activeElement, select);
});

test('available historical growth displays its observed and annual rates', t => {
  const { element } = setup(t, {
    assetGrowth: { reserve: { source: 'history', coverage, flowKinds: {} } }, effectiveGrowth: { reserve: 425, investments: 0 },
    growthReview: { reserve: { candidateCoverage: coverage, evidence: { ready: true, reason: 'Cash flows have been adjusted.', from: coverage.from, to: coverage.to, days: 365, annualGrowthBps: 425, periodRate: 0.0425 } } },
  });
  const text = element('financial-growth-evidence-reserve').textContent;
  assert.equal(element('financial-reserve-growth').value, '4.25');
  assert.match(text, /Observed period: 2025-01-01 to 2026-01-01 \(365 days\)/);
  assert.match(text, /annual rate: 4.25%/);
  assert.match(text, /observed period: 4.25%/);
  assert.match(text, /Projection uses 4.25%/);
});

const budgetAssumptions = { income: 1500000, expense: 1200000, saving: 200000, adjustment: 0, plannedMonthlyExpense: 0, oneOff: 50000 };

test('fixed monthly budget remains available without starting balances', t => {
  const { element } = setup(t, { view: 'budget', horizon: 3, monthlyReady: true, assumptions: budgetAssumptions, projection: null, forecastError: 'Starting balances are missing.' });
  assert.match(element('financial-budget-stats').innerHTML, /Regular monthly income/);
  assert.doesNotMatch(element('financial-budget-stats').innerHTML, /Average monthly income/);
  assert.match(element('financial-budget-message').textContent, /Regular income covers spending with 300000 øre left per month/);
  assert.match(element('financial-budget-message').textContent, /rises by 100000 øre per month/);
  assert.match(element('financial-budget-message').textContent, /separate 50000 øre expense is applied in month one/);
  assert.doesNotMatch(element('financial-budget-message').textContent, /Starting balances are missing/);
});

test('growing income budget labels horizon averages and shows the varying income range', t => {
  const { controller, data, element } = setup(t, {
    view: 'budget', horizon: 12, incomeGrowth: true, incomeRange: { first: 1100000, last: 1900000 },
    monthlyReady: true, assumptions: budgetAssumptions, projection: null,
  });
  const stats = element('financial-budget-stats').innerHTML;
  const text = element('financial-budget-message').textContent;
  assert.match(stats, /Average monthly income/);
  assert.match(stats, /Average income minus spending/);
  assert.match(stats, /Monthly average over 12 months/);
  assert.match(text, /^Monthly averages over 12 months:/);
  assert.match(text, /rises by 100000 øre per month on average/);
  assert.match(text, /1100000 øre in month one to 1900000 øre in month 12/);
  assert.match(text, /Individual months can differ/);
  assert.match(text, /separate 50000 øre expense is applied in month one/);
  assert.doesNotMatch(text, /income covers spending/);

  controller.setData({ ...data, incomeGrowth: false });
  assert.doesNotMatch(element('financial-budget-stats').innerHTML, /Average monthly income/);
  assert.doesNotMatch(element('financial-budget-message').textContent, /1100000 øre|averages/);
});

test('unavailable income trend explains why the budget cannot use growing income', t => {
  const { element } = setup(t, {
    view: 'budget', horizon: 3, incomeGrowth: true, incomeRange: null, monthlyReady: false,
    assumptions: budgetAssumptions, forecastError: 'Income trend needs at least 24 complete months.',
  });
  assert.match(element('financial-budget-message').textContent, /Income trend needs at least 24 complete months/);
  assert.match(element('financial-budget-message').textContent, /Switch off income growth/);
  assert.match(element('financial-budget-message').textContent, /No starting account balance is needed/);
  assert.doesNotMatch(element('financial-budget-message').textContent, /income covers spending|Monthly averages/);
  assert.doesNotMatch(element('financial-budget-stats').innerHTML, /1500000 øre/);
});

test('budget uses the projected monthly net when independently rounded averages differ', t => {
  const { element } = setup(t, {
    view: 'budget', horizon: 2, incomeGrowth: true, monthlyReady: true,
    assumptions: { income: 101, expense: 1, saving: 0, adjustment: 0, plannedMonthlyExpense: 0 },
    monthlyCashChange: 99, projection: null,
  });
  assert.match(element('financial-budget-message').textContent, /income exceeds spending by 99 øre/);
  assert.match(element('financial-budget-message').textContent, /rises by 99 øre per month on average/);
});
