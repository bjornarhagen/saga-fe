import { accountTypes } from './account-values.js';

const maximum = BigInt(Number.MAX_SAFE_INTEGER);
const roleLabels = {
  available: 'Available cash',
  reserve: 'Savings reserve',
  investment: 'Investment values',
  excluded: 'Other excluded accounts'
};

const exactNumber = amount => amount > maximum || amount < -maximum ? null : Number(amount);
const accumulator = (id, label) => ({ id, label, count: 0, knownCount: 0, positive: 0n, negative: 0n });
const roleFor = account => account.accountType === 'investment' ? 'investment' : account.role === 'available' || account.role === 'reserve' ? account.role : 'excluded';

function add(group, account) {
  group.count += 1;
  // Unsafe or fractional numbers cannot be converted into an exact observation.
  if (!Number.isSafeInteger(account.balance)) return;
  group.knownCount += 1;
  const amount = BigInt(account.balance);
  if (amount >= 0n) group.positive += amount;
  else group.negative += amount;
}

function totals(group) {
  return {
    count: group.count,
    knownCount: group.knownCount,
    unknownCount: group.count - group.knownCount,
    positiveTotal: group.knownCount ? exactNumber(group.positive) : null,
    negativeTotal: group.knownCount ? exactNumber(group.negative) : null,
    total: group.knownCount ? exactNumber(group.positive + group.negative) : null
  };
}

const row = group => ({ id: group.id, label: group.label, ...totals(group) });

function institutionOrder(a, b) {
  // Unknown values have no numeric rank. Compare exact sums before conversion,
  // so overflow and large opposing balances cannot change the order.
  if (!a.knownCount || !b.knownCount) {
    if (a.knownCount !== b.knownCount) return a.knownCount ? -1 : 1;
  } else {
    const difference = a.positive + a.negative - b.positive - b.negative;
    if (difference !== 0n) return difference > 0n ? -1 : 1;
  }
  return a.label.localeCompare(b.label, 'en', { sensitivity: 'base', numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Summarize the latest recorded values; never infer values from payments. */
export function summarizeAccounts(accounts) {
  const overall = accumulator('', '');
  const cash = accumulator('', '');
  const roles = new Map(Object.entries(roleLabels).map(([id, label]) => [id, accumulator(id, label)]));
  const types = new Map(Object.entries(accountTypes).map(([id, label]) => [id, accumulator(id, label)]));
  const institutions = new Map();
  const dates = new Set();

  for (const account of accounts) {
    const role = roleFor(account);
    const type = Object.hasOwn(accountTypes, account.accountType) ? account.accountType : 'other';
    const institution = typeof account.institution === 'string' ? account.institution.trim() : '';
    if (!institutions.has(institution)) institutions.set(institution, accumulator(institution, institution || 'Institution not set'));
    add(overall, account);
    add(roles.get(role), account);
    add(types.get(type), account);
    add(institutions.get(institution), account);
    if (role === 'available' || role === 'reserve') add(cash, account);
    if (Number.isSafeInteger(account.balance) && /^\d{4}-\d{2}-\d{2}$/.test(account.balanceDate || '')) dates.add(account.balanceDate);
  }

  const orderedDates = [...dates].sort();
  return {
    ...totals(overall),
    oldestDate: orderedDates[0] || null,
    newestDate: orderedDates.at(-1) || null,
    mixedDates: dates.size > 1,
    cashTotal: totals(cash).total,
    groups: {
      role: [...roles.values()].map(row),
      type: [...types.values()].map(row),
      institution: [...institutions.values()].sort(institutionOrder).map(row)
    }
  };
}
