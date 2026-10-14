import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { csvRows, parseExport, applyOverrides, summarize, baseline, project, shiftMonth } from '../src/lib/engine.js';

const headers = 'Dato;Beløp;Originalt Beløp;Original Valuta;Til konto;Til kontonummer;Fra konto;Fra kontonummer;Type;Tekst;KID;Hovedkategori;Underkategori';
function row({ date = '2026-09-01', amount = '-100.00', to = '', toNumber = 'shop', from = 'Cash', fromNumber = 'cash', type = 'Betaling', text = 'Shop', category = 'Food', sub = '' } = {}) {
  return [date, amount, amount, 'NOK', to, toNumber, from, fromNumber, type, text, '', category, sub].join(';');
}
const fixture = [headers,
  row({ amount: '3000.00', from: '', fromNumber: 'employer', to: 'Cash', toNumber: 'cash', type: 'Inntekt', category: 'Inntekter', sub: 'Lønn' }),
  row(),
  row({ amount: '-500.00', to: 'Reserve', toNumber: 'reserve', type: 'Overføring', category: '', text: '' }),
  row({ amount: '500.00', from: 'Cash', fromNumber: 'cash', to: 'Reserve', toNumber: 'reserve', type: 'Overføring', category: '', text: '' }),
  row({ amount: '-20.00', toNumber: 'outside', text: 'Mikrospar til Holiday', category: '', type: 'Overføring' }),
  row({ amount: '-200.00', text: 'Investment', category: 'Sparing' }),
  row({ amount: '10.00', text: 'Refund', from: '', fromNumber: 'shop', to: 'Cash', toNumber: 'cash' })
].join('\n');

test('CSV handles BOM, quoted delimiters, escaped quotes, CRLF, and quoted newlines', () => {
  assert.deepEqual(csvRows('\uFEFFA;B\r\n"a;b";"say ""hi""\nnext"\r\n'), [['A', 'B'], ['a;b', 'say "hi"\nnext']]);
  assert.throws(() => csvRows('a;b\n"unclosed;b'), /unclosed/);
});
test('classifies internal transfers independently from the direction and does not double count them', () => {
  const data = parseExport(fixture), result = summarize(data.transactions);
  assert.equal(data.transactions.filter(t => t.kind === 'transfer').length, 2);
  assert.equal(result.income, 301000);
  assert.equal(result.expense, 10000);
  assert.equal(result.saving, 22000);
  assert.equal(result.net, 269000);
  assert.deepEqual(data.accounts.sort(), ['Cash', 'Reserve']);
  assert.ok(!JSON.stringify(data).includes('fromNumber'));
});
test('keeps repeated rows with distinct stable identifiers and preserves integer øre', () => {
  const text = [headers, row({ amount: '-1.05' }), row({ amount: '-1.05' })].join('\n');
  const data = parseExport(text);
  assert.equal(data.metadata.duplicateRows, 1);
  assert.equal(summarize(data.transactions).expense, 210);
  assert.notEqual(data.transactions[0].id, data.transactions[1].id);
  assert.deepEqual(parseExport(text).transactions.map(t => t.id), data.transactions.map(t => t.id));
});
test('rejects malformed amounts, dates, missing columns, and row widths instead of dropping data', () => {
  assert.throws(() => parseExport('Date;Amount\n2026-01-01;1'), /columns/);
  assert.throws(() => parseExport(headers + '\n2026-01-01;1'), /columns/);
  assert.throws(() => parseExport(headers + '\n' + row({ amount: 'not-a-number' })), /amount/);
  assert.throws(() => parseExport(headers + '\n' + row({ date: '2026-02-30' })), /date/);
});
test('baseline excludes partial first and current months, averages calendar months, and uses salary only', () => {
  const tx = [
    { date: '2026-06-15', month: '2026-06', amount: -999999, kind: 'expense' },
    { date: '2026-07-01', month: '2026-07', amount: 300000, kind: 'income', regularIncome: true },
    { date: '2026-07-02', month: '2026-07', amount: 9000000, kind: 'income', regularIncome: false },
    { date: '2026-07-03', month: '2026-07', amount: -90000, kind: 'expense', category: 'Food', description: 'Shop' },
    { date: '2026-09-03', month: '2026-09', amount: -30000, kind: 'saving' },
    { date: '2026-10-03', month: '2026-10', amount: -999999, kind: 'expense' }
  ];
  assert.deepEqual(baseline(tx, '2026-10-14', 6, '2026-06-15'), { start: '2026-07', end: '2026-09', months: 3, income: 100000, expense: 30000, saving: 10000 });
});
test('one-off exclusion changes the forecast baseline and preserves historical totals', () => {
  const d = parseExport([headers, row({ date: '2026-08-01', amount: '-1000.00' }), row({ date: '2026-09-01', amount: '-2000.00' })].join('\n'));
  const id = d.transactions[0].id;
  const edited = applyOverrides(d.transactions, { [id]: { excludeForecast: true } });
  assert.equal(summarize(edited).expense, 300000);
  assert.equal(baseline(edited, '2026-10-14', 3, d.metadata.firstDate).expense, 50000);
  const transfer = applyOverrides(d.transactions, { [id]: { kind: 'transfer', category: 'Own accounts' } });
  assert.equal(summarize(transfer).expense, 100000);
});
test('empty balance differs from zero; future dates clamp to month end and do not drift', () => {
  const base = { income: 100000, expense: 120000, saving: 10000, asOf: '2026-01-31', horizon: 3 };
  assert.equal(project({ ...base, cash: null }), null);
  const p = project({ ...base, cash: 0 });
  assert.equal(p.endBalance, -90000);
  assert.deepEqual(p.points.map(p => p.date), ['2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});
test('scenario includes savings, spending changes, one-off payment, buffer, and reserve shortfall', () => {
  const p = project({ cash: 500000, savings: 100000, income: 400000, expense: 450000, saving: 10000, adjustment: -20000, oneOff: 300000, horizon: 3, asOf: '2026-10-14', buffer: 100000 });
  assert.equal(p.monthlyNet, -40000);
  assert.deepEqual(p.points.map(p => p.balance), [160000, 120000, 80000]);
  assert.equal(p.reserveNeeded, 20000);
  assert.equal(p.uncovered, 0);
  assert.equal(p.breakEvenCut, 40000);
});
test('detects a temporary reserve need even when the final cash balance recovers', () => {
  const p = project({ cash: 100000, savings: 20000, income: 200000, expense: 100000, oneOff: 250000, horizon: 3, asOf: '2026-10-14' });
  assert.equal(p.endBalance, 150000);
  assert.equal(p.reserveNeeded, 50000);
  assert.equal(p.endReserveNeeded, 0);
  assert.equal(p.uncovered, 30000);
});
test('local export has unique transaction identifiers and exact cash-flow reconciliation', async (t) => {
  let text;
  try { text = await readFile(process.env.TRANSACTIONS_FILE || new URL('../transactions.csv', import.meta.url), 'utf8'); } catch { t.skip('No private local export'); return; }
  const d = parseExport(text), s = summarize(d.transactions);
  assert.equal(new Set(d.transactions.map(t => t.id)).size, d.transactions.length);
  assert.ok(d.transactions.every(t => Number.isSafeInteger(t.amount)));
  assert.equal(s.income - s.expense - s.saving, s.net);
});
