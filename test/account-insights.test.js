import test from 'node:test';
import assert from 'node:assert/strict';
import { accountAllocationMarkup, accountHistoryComparison } from '../src/scripts/account-insights.js';
import { summarizeAccounts } from '../src/lib/account-statistics.js';

const account = balance => ({ balance, balanceDate: '2026-10-15', accountType: 'checking', role: 'available', institution: 'Example Bank' });
const format = amount => `${amount} øre`;
const roleRows = amounts => summarizeAccounts(amounts.map(account)).groups.role;
const bars = markup => [...markup.matchAll(/class="account-allocation-bar" style="left:([^%]+)%;width:([^%]+)%/g)].map(match => ({ left: Number(match[1]), width: Number(match[2]) }));

test('allocation labels and internal account links cannot become imported markup', () => {
  const row = {
    ...roleRows([105])[0],
    label: '<img src=x onerror="example()"> & \'Account\'',
    href: `#accounts/${encodeURIComponent('example "< & \'')}`,
  };
  const output = accountAllocationMarkup([row], format);
  assert.doesNotMatch(output, /<img| onerror="|href="[^"]*"</);
  assert.match(output, /&lt;img src=x onerror=&quot;example\(\)&quot;&gt; &amp; &#39;Account&#39;/);
  assert.match(output, /href="#accounts\/example%20%22%3C%20%26%20&#39;"/);
  assert.match(output, /105 øre/);
});

test('allocation shows both sides of signed groups and retains exact totals on every scale', () => {
  const rows = roleRows([125, -50, null, 0]);
  for (const scale of ['linear', 'sqrt', 'log']) {
    const output = accountAllocationMarkup(rows, format, { scale });
    assert.match(output, />75 øre<\/strong>/);
    assert.match(output, /125 øre positive/);
    assert.match(output, /-50 øre negative/);
    assert.match(output, /4 accounts · 1 unknown/);
    assert.doesNotMatch(output, /NaN|Infinity|undefined/);
    const plotted = bars(output);
    assert.equal(plotted.length, 2);
    const negative = plotted.find(bar => bar.left < 50);
    const positive = plotted.find(bar => bar.left === 50);
    assert.ok(negative && positive);
    assert.ok(plotted.every(bar => bar.width > 0 && bar.width <= 50));
    assert.ok(Math.abs(negative.left + negative.width - 50) < 1e-9);
  }
});

test('unknown observations stay distinct from known zero and bars can be hidden', () => {
  const unknown = accountAllocationMarkup(roleRows([null]), format);
  assert.match(unknown, /Not recorded/);
  assert.match(unknown, /1 unknown/);
  assert.doesNotMatch(unknown, /account-allocation-track|>0 øre<\/strong>/);
  const zero = accountAllocationMarkup(roleRows([0]), format);
  assert.match(zero, />0 øre<\/strong>/);
  assert.match(zero, /account-allocation-track/);
  assert.equal(bars(zero).length, 0);
  assert.doesNotMatch(zero, /unknown|Not recorded|NaN|Infinity/);
  const figuresOnly = accountAllocationMarkup(roleRows([125, -50]), format, { bars: false });
  assert.match(figuresOnly, /75 øre/);
  assert.doesNotMatch(figuresOnly, /account-allocation-track|account-allocation-axis/);
  assert.match(accountAllocationMarkup([], format), /Add an account/);
});

test('allocation discloses overflowing bar totals even when the net total stays exact', () => {
  const max = Number.MAX_SAFE_INTEGER;
  for (const values of [[max, max, -max], [max, max, -max, -max, 7]]) {
    const rows = roleRows(values);
    const output = accountAllocationMarkup(rows, format);
    assert.match(output, new RegExp(`>${rows[0].total} øre<\\/strong>`));
    assert.match(output, /too large/i);
    assert.doesNotMatch(output, /NaN|Infinity/);
    // A lone remaining side would suggest that the omitted side was zero.
    assert.equal(bars(output).length, 0);
  }
});

test('history comparison uses dated known observations around unknown endpoints', () => {
  const history = [
    { date: '2026-10-01', amount: null },
    { date: '2026-10-05', amount: -105 },
    { date: '2026-10-08', amount: null },
    { date: '2026-10-10', amount: 205 },
    { date: '2026-10-15', amount: null },
  ];
  assert.deepEqual(accountHistoryComparison(history), { firstDate: '2026-10-05', lastDate: '2026-10-10', change: 310 });
  assert.equal(accountHistoryComparison(history.filter(row => row.date !== '2026-10-10')), null);
  assert.equal(accountHistoryComparison([]), null);
});

test('history comparison sorts without mutation and retains zero, signed and overflow changes', () => {
  const history = Object.freeze([
    Object.freeze({ date: '2026-10-15', amount: -105 }),
    Object.freeze({ date: '2026-10-01', amount: 0 }),
  ]);
  assert.deepEqual(accountHistoryComparison(history), { firstDate: '2026-10-01', lastDate: '2026-10-15', change: -105 });
  assert.equal(history[0].date, '2026-10-15');
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(accountHistoryComparison([{ date: '2026-10-01', amount: -max }, { date: '2026-10-15', amount: max }]), {
    firstDate: '2026-10-01', lastDate: '2026-10-15', change: null,
  });
});
