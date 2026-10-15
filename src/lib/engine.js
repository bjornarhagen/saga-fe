// All amounts are integer øre until formatted in the UI.
export function csvRows(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  return rows;
}
function cents(value) {
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) throw new Error('Invalid NOK amount.');
  return Math.round(Number(normalized) * 100);
}
function hash(value) { let h = 2166136261; for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); }
export function parseExport(text) {
  const [headers, ...rows] = csvRows(text);
  const required = ['Dato', 'Beløp', 'Fra konto', 'Til konto', 'Fra kontonummer', 'Til kontonummer', 'Type', 'Tekst', 'Hovedkategori', 'Underkategori'];
  if (!headers || required.some(key => !headers.includes(key))) throw new Error('Expected the Norwegian bank export columns: ' + required.join(', '));
  const raw = rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Row ${index + 2} has the wrong number of columns.`);
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
  if (!raw.length) throw new Error('The CSV has no transactions.');
  const owned = new Map();
  for (const r of raw) for (const side of ['Fra', 'Til']) if (r[side + ' konto'] && r[side + ' kontonummer']) owned.set(r[side + ' kontonummer'], r[side + ' konto']);
  const occurrences = new Map(); let duplicateRows = 0;
  const transactions = raw.map((r, index) => {
    const date = r.Dato;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date) throw new Error(`Invalid date on row ${index + 2}.`);
    const amount = cents(r.Beløp);
    const fromOwned = owned.has(r['Fra kontonummer']), toOwned = owned.has(r['Til kontonummer']);
    const internal = fromOwned && toOwned;
    const microSaving = /^Mikrospar til /i.test(r.Tekst) && !internal;
    const savings = !internal && (microSaving || r.Hovedkategori === 'Sparing');
    const description = r.Tekst.trim() || (internal ? `${r['Fra konto']} → ${r['Til konto']}` : 'Bank transfer');
    const fingerprint = JSON.stringify(headers.map(h => r[h]));
    const occurrence = occurrences.get(fingerprint) || 0;
    occurrences.set(fingerprint, occurrence + 1); if (occurrence) duplicateRows++;
    const kind = internal ? 'transfer' : savings && amount < 0 ? 'saving' : amount > 0 ? 'income' : 'expense';
    const regularIncome = amount > 0 && !internal && (r.Type === 'Inntekt' || r.Underkategori === 'Lønn');
    const review = !internal && !microSaving && (r.Type === 'Overføring' || !r.Hovedkategori || r.Hovedkategori === 'Ukategorisert') && amount !== 0 && !regularIncome && r.Type !== 'Renter';
    return {
      id: hash(fingerprint) + '-' + occurrence, date, month: date.slice(0, 7), amount, description,
      category: internal ? 'Internal transfers' : microSaving ? 'Micro-savings' : r.Hovedkategori || (amount > 0 ? 'Other money in' : 'Uncategorized'),
      subcategory: r.Underkategori, type: r.Type, kind, regularIncome, review, microSaving,
      fromAccount: fromOwned ? owned.get(r['Fra kontonummer']) : '', toAccount: toOwned ? owned.get(r['Til kontonummer']) : '',
      account: amount < 0 ? (owned.get(r['Fra kontonummer']) || r['Fra konto']) : (owned.get(r['Til kontonummer']) || r['Til konto'])
    };
  });
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  return { transactions, accounts: [...new Set(owned.values())], metadata: { rows: raw.length, duplicateRows, zeroRows: transactions.filter(t => !t.amount).length, firstDate: transactions.at(-1).date, lastDate: transactions[0].date, currency: 'NOK', hasBalances: false } };
}
export function applyOverrides(transactions, overrides = {}) {
  return transactions.map(t => {
    const o = overrides[t.id] || {};
    const from = t.fromEndpoint, to = t.toEndpoint;
    const ownedMovement = from?.owned && to?.owned;
    let movementKind;
    if (ownedMovement) {
      // The cash boundary is separate from ownership. Investments are never cash.
      const available = node => node.role === 'available' && node.accountType !== 'investment';
      movementKind = available(from) === available(to) ? 'transfer' : t.amount < 0 && available(from) ? 'saving' : t.amount > 0 && available(to) ? 'income' : 'transfer';
    }
    const kind = o.kind || movementKind || t.kind;
    const suggestion = t.categorySuggestion;
    const applied = suggestion && ['auto_applied', 'user_applied'].includes(suggestion.status);
    const category = o.category || (applied ? suggestion.category : t.category);
    return { ...t, ...(applied ? { category } : {}), ...o, kind, ownedMovement: !!ownedMovement,
      subcategory: category !== t.category ? '' : t.subcategory,
      review: suggestion?.status === 'auto_applied' || (t.review && !o.kind && !ownedMovement && suggestion?.status !== 'user_applied'),
      regularIncome: !ownedMovement && kind === 'income' && t.regularIncome };
  });
}
export function summarize(transactions) {
  const result = { income: 0, expense: 0, saving: 0, transfer: 0, net: 0, count: 0, categories: {}, merchants: {} };
  for (const t of transactions) {
    result.count++;
    if (t.kind === 'transfer') { if (t.amount < 0) result.transfer += -t.amount; continue; }
    result.net += t.amount;
    if (t.amount > 0) result.income += t.amount;
    if (t.amount < 0) {
      const amount = -t.amount;
      if (t.kind === 'saving') result.saving += amount;
      else {
        result.expense += amount;
        result.categories[t.category] = (result.categories[t.category] || 0) + amount;
        result.merchants[t.description] = (result.merchants[t.description] || 0) + amount;
      }
    }
  }
  return result;
}
export function shiftMonth(month, amount) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + amount, 1)).toISOString().slice(0, 7);
}
export function monthlySeries(transactions, start, end) {
  const result = [];
  for (let month = start; month <= end; month = shiftMonth(month, 1)) result.push({ month, ...summarize(transactions.filter(t => t.month === month)) });
  return result;
}
export function baseline(transactions, asOf, months = 3, firstDate = transactions.at(-1)?.date) {
  const end = shiftMonth(asOf.slice(0, 7), -1);
  const start = shiftMonth(end, 1 - months);
  // Never treat a partial first export month as a complete month.
  const firstComplete = firstDate?.slice(8) === '01' ? firstDate.slice(0, 7) : shiftMonth(firstDate?.slice(0, 7) || start, 1);
  const actualStart = start > firstComplete ? start : firstComplete;
  const series = actualStart <= end ? monthlySeries(transactions.filter(t => !t.excludeForecast), actualStart, end) : [];
  const divisor = series.length;
  const eligible = transactions.filter(t => !t.excludeForecast && t.month >= actualStart && t.month <= end);
  const salary = eligible.filter(t => t.regularIncome && t.kind === 'income').reduce((sum, t) => sum + t.amount, 0);
  return { start: actualStart, end, months: divisor, income: divisor ? Math.round(salary / divisor) : 0, expense: divisor ? Math.round(series.reduce((s, m) => s + m.expense, 0) / divisor) : 0, saving: divisor ? Math.round(series.reduce((s, m) => s + m.saving, 0) / divisor) : 0 };
}
export function project({ cash, savings = 0, income, expense, saving = 0, adjustment = 0, oneOff = 0, horizon = 3, asOf, buffer = 0 }) {
  if (cash === null || !Number.isFinite(cash)) return null;
  let balance = cash; const monthlyNet = income - expense - saving - adjustment;
  const start = new Date(asOf + 'T12:00:00Z');
  const dates = [];
  for (let i = 1; i <= horizon; i++) {
    const targetMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
    targetMonth.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    balance += monthlyNet - (i === 1 ? oneOff : 0);
    const needed = Math.max(0, buffer - balance);
    dates.push({ date: targetMonth.toISOString().slice(0, 10), balance, reserveNeeded: needed, savingsAfter: Math.max(0, savings - needed), uncovered: Math.max(0, needed - savings) });
  }
  const end = dates.at(-1);
  const reserveNeeded = Math.max(...dates.map(point => point.reserveNeeded));
  return { monthlyNet, points: dates, endBalance: end.balance, reserveNeeded, endReserveNeeded: end.reserveNeeded, uncovered: Math.max(0, reserveNeeded - savings), headroom: Math.max(0, end.balance - buffer), breakEvenCut: Math.max(0, -monthlyNet) };
}
