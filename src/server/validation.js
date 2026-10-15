import { normalizeIncomeGrowthSettings } from '../lib/forecast-settings.js';

export class ValidationError extends Error {}
export function object(value, label = 'Value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label} must be an object.`);
  return value;
}
export function string(value, label, max = 300, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000]/.test(value)) throw new ValidationError(`${label} must be valid text (maximum ${max} characters).`);
  return value.trim();
}
export function amount(value, label = 'Amount') {
  if (!Number.isSafeInteger(value)) throw new ValidationError(`${label} must be an integer amount in øre.`);
  return value;
}
export function date(value, label = 'Date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new ValidationError(`${label} must be a valid date in YYYY-MM-DD format.`);
  return value;
}
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function role(value) {
  if (!['available', 'reserve', 'excluded'].includes(value)) throw new ValidationError('Account role must be available, reserve, or excluded.');
  return value;
}
export function accountType(value) {
  if (!['checking', 'savings', 'investment', 'credit', 'other'].includes(value)) throw new ValidationError('Account type is invalid.');
  return value;
}
export function accountProfile(type, accountRole) {
  if (type === 'investment' && accountRole !== 'excluded') throw new ValidationError('Investment values must stay outside available cash and savings reserves.');
}
export function currency(value = 'NOK') {
  if (value !== 'NOK') throw new ValidationError('Only NOK is supported for calculations.');
  return value;
}
export function boolean(value, label) {
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be true or false.`);
  return value;
}
export function list(value, label, max = 100000) {
  if (!Array.isArray(value) || value.length > max) throw new ValidationError(`${label} must be an array with at most ${max} entries.`);
  return value;
}
export function kind(value) {
  if (!['income', 'expense', 'saving', 'transfer'].includes(value)) throw new ValidationError('Transaction kind is invalid.');
  return value;
}
export function kindForAmount(value, transactionAmount) {
  kind(value); amount(transactionAmount);
  if ((transactionAmount < 0 && value === 'income') || (transactionAmount > 0 && ['expense', 'saving'].includes(value))) throw new ValidationError('The transaction kind does not match the amount.');
  return value;
}
export function settings(value) {
  object(value, 'Settings'); const result = {};
  for (const key of Object.keys(value)) if (!['fields', 'horizon', 'historyMonths', 'methods', 'lookback', 'assumptions', 'scenario', 'balanceSource', 'spendingPlans', 'expensePlanCategories', 'financialView', 'forecastChart', 'incomeGrowth'].includes(key)) throw new ValidationError('Unknown forecast setting.');
  if ('incomeGrowth' in value) result.incomeGrowth = boolean(value.incomeGrowth, 'Income growth');
  if ('forecastChart' in value) result.forecastChart = forecastChart(value.forecastChart);
  if ('financialView' in value) result.financialView = financialView(value.financialView);
  if ('spendingPlans' in value) result.spendingPlans = spendingPlans(value.spendingPlans);
  if ('expensePlanCategories' in value) {
    result.expensePlanCategories = list(value.expensePlanCategories, 'Reviewed spending categories', 100).map(category => string(category, 'Reviewed spending category', 200));
    if (new Set(result.expensePlanCategories.map(category => category.toLocaleLowerCase('nb-NO'))).size !== result.expensePlanCategories.length) throw new ValidationError('Reviewed spending categories must not repeat.');
  }
  if ('historyMonths' in value) {
    if (![0, 1, 3, 6, 12, 24].includes(value.historyMonths)) throw new ValidationError('Unknown chart history window.');
    result.historyMonths = value.historyMonths;
  }
  if ('methods' in value) {
    const supported = ['unchanged', 'average', 'recent', 'smoothed', 'seasonal', 'income-trend'];
    if (!Array.isArray(value.methods) || value.methods.length > supported.length || value.methods.some(id => !supported.includes(id)) || new Set(value.methods).size !== value.methods.length) throw new ValidationError('Unknown or repeated forecast comparison method.');
    result.methods = [...value.methods];
  }
  if ('balanceSource' in value) {
    if (!['manual', 'accounts', 'latest'].includes(value.balanceSource)) throw new ValidationError('Balance source must be manual, accounts, or latest.');
    result.balanceSource = value.balanceSource;
  }
  for (const [key, max] of [['horizon', 60], ['lookback', 60]]) if (key in value) {
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > max) throw new ValidationError(`${key} is outside the supported range.`);
    result[key] = value[key];
  }
  if ('scenario' in value) {
    result.scenario = string(value.scenario, 'Scenario', 40);
    if (!['same', 'spend-less', 'spend-more', 'less', 'more', 'custom'].includes(result.scenario)) throw new ValidationError('Unknown forecast scenario.');
  }
  if ('assumptions' in value) {
    result.assumptions = {}; object(value.assumptions, 'Assumptions');
    for (const [key, val] of Object.entries(value.assumptions)) {
      if (!['income', 'expense', 'saving'].includes(key) || amount(val) < 0) throw new ValidationError('Monthly assumptions must be nonnegative integer amounts in øre.');
      result.assumptions[key] = val;
    }
  }
  if ('fields' in value) {
    object(value.fields, 'Fields'); result.fields = {};
    for (const [key, val] of Object.entries(value.fields)) {
      if (!['cash', 'savings', 'buffer', 'balance-date', 'adjustment', 'one-off'].includes(key)) throw new ValidationError('Unknown forecast field.');
      if (key === 'balance-date') { result.fields[key] = val === '' ? '' : date(val); continue; }
      if (typeof val !== 'string' || val.length > 30 || (val !== '' && (!/^-?\d+(?:\.\d{0,2})?$/.test(val) || !Number.isSafeInteger(Math.round(Number(val) * 100))))) throw new ValidationError('Forecast amounts must be valid NOK decimal strings.');
      if (val !== '' && !['adjustment', 'cash'].includes(key) && Number(val) < 0) throw new ValidationError('This forecast field cannot be negative.');
      result.fields[key] = val;
    }
  }
  return normalizeIncomeGrowthSettings(result);
}
export function financialView(value) {
  object(value, 'Financial view');
  for (const key of Object.keys(value)) if (!['view', 'useReserve', 'assetGroups', 'growthBps', 'reserveGrowthBps', 'assetGrowth', 'reserveContribution', 'investmentContribution'].includes(key)) throw new ValidationError('Unknown financial view setting.');
  const view = value.view ?? 'budget';
  if (!['budget', 'liquidity', 'wealth'].includes(view)) throw new ValidationError('Unknown financial view.');
  const groups = value.assetGroups ?? ['cash', 'reserve', 'investments', 'other'];
  list(groups, 'Asset groups', 4);
  if (groups.some(group => !['cash', 'reserve', 'investments', 'other'].includes(group)) || new Set(groups).size !== groups.length) throw new ValidationError('Unknown or repeated asset group.');
  const growthBps = amount(value.growthBps ?? 0, 'Annual investment growth');
  if (growthBps < -10000 || growthBps > 100000) throw new ValidationError('Annual investment growth must be between -100% and 1000%.');
  const reserveGrowthBps = amount(value.reserveGrowthBps ?? 0, 'Annual savings growth');
  if (reserveGrowthBps < -10000 || reserveGrowthBps > 100000) throw new ValidationError('Annual savings growth must be between -100% and 1000%.');
  const contribution = key => {
    if (value[key] == null) return null;
    const result = amount(value[key], 'Monthly contribution');
    if (result < 0) throw new ValidationError('Monthly contributions cannot be negative.');
    return result;
  };
  return { view, useReserve: boolean(value.useReserve ?? true, 'Use savings reserve'), assetGroups: [...groups], growthBps, reserveGrowthBps, assetGrowth: assetGrowth(value.assetGrowth === undefined ? {} : value.assetGrowth), reserveContribution: contribution('reserveContribution'), investmentContribution: contribution('investmentContribution') };
}
export function assetGrowth(value) {
  object(value, 'Asset growth');
  for (const key of Object.keys(value)) if (!['reserve', 'investments'].includes(key)) throw new ValidationError('Unknown asset growth group.');
  return Object.fromEntries(['reserve', 'investments'].map(group => {
    const input = value[group] === undefined ? {} : object(value[group], 'Asset growth options');
    for (const key of Object.keys(input)) if (!['source', 'coverage', 'flowKinds'].includes(key)) throw new ValidationError('Unknown asset growth option.');
    const source = input.source === undefined ? 'manual' : input.source;
    if (!['manual', 'history'].includes(source)) throw new ValidationError('Choose manual or historical asset growth.');
    let coverage = null;
    if (input.coverage != null) {
      const confirmed = object(input.coverage, 'Asset movement coverage');
      for (const key of Object.keys(confirmed)) if (!['complete', 'from', 'to', 'accountIds'].includes(key)) throw new ValidationError('Unknown asset movement coverage field.');
      if (confirmed.complete !== true) throw new ValidationError('Asset movement coverage must be explicitly confirmed complete.');
      const from = date(confirmed.from, 'Coverage starting date'), to = date(confirmed.to, 'Coverage ending date');
      if (from >= to) throw new ValidationError('Coverage ending date must be after its starting date.');
      const accountIds = list(confirmed.accountIds, 'Coverage account IDs', 200).map(id => string(id, 'Coverage account ID', 200));
      if (!accountIds.length || new Set(accountIds).size !== accountIds.length) throw new ValidationError('Coverage needs distinct account IDs.');
      coverage = { complete: true, from, to, accountIds };
    }
    const classifications = input.flowKinds === undefined ? {} : object(input.flowKinds, 'Growth movement classifications');
    const entries = Object.entries(classifications);
    if (entries.length > 1000) throw new ValidationError('Growth movement classifications allow at most 1000 entries per group.');
    const flowKinds = Object.fromEntries(entries.map(([id, kind]) => {
      const checked = string(id, 'Growth movement ID', 200);
      if (checked !== id || ['__proto__', 'prototype', 'constructor'].includes(id)) throw new ValidationError('Growth movement ID is invalid.');
      if (!['capital', 'return'].includes(kind)) throw new ValidationError('Classify growth movements as capital or return.');
      return [id, kind];
    }));
    return [group, { source, coverage, flowKinds }];
  }));
}
export function forecastChart(value) {
  object(value, 'Forecast chart');
  for (const key of Object.keys(value)) if (!['scopes', 'methods', 'startingGuides', 'fundingLimits', 'points'].includes(key)) throw new ValidationError('Unknown forecast chart setting.');
  const choices = (key, allowed, defaults) => {
    const values = value[key] ?? defaults;
    list(values, `Chart ${key}`, allowed.length);
    if (!values.length || values.some(item => !allowed.includes(item)) || new Set(values).size !== values.length) throw new ValidationError(`Choose distinct supported chart ${key}.`);
    return [...values];
  };
  return {
    scopes: choices('scopes', ['cash', 'reserve', 'investments', 'cash-reserve', 'cash-investments', 'cash-reserve-investments'], ['cash', 'cash-reserve-investments']),
    methods: choices('methods', ['scenario', 'unchanged', 'average', 'recent', 'smoothed', 'seasonal', 'income-trend'], ['scenario']),
    startingGuides: boolean(value.startingGuides ?? false, 'Starting balance guides'),
    fundingLimits: boolean(value.fundingLimits ?? false, 'Funding thresholds'),
    points: boolean(value.points ?? true, 'Chart point markers'),
  };
}
export function spendingPlans(value) {
  const accountIds = new Set(), categories = new Set();
  const nonnegative = (value, label) => {
    amount(value, label);
    if (value < 0) throw new ValidationError(`${label} cannot be negative.`);
    return value;
  };
  return list(value, 'Spending plans', 100).map(input => {
    object(input, 'Spending plan');
    for (const key of Object.keys(input)) if (!['accountId', 'category', 'monthlySpending', 'monthlyFunding', 'topUps', 'reviewAtBalance'].includes(key)) throw new ValidationError('Unknown spending plan field.');
    const accountId = string(input.accountId, 'Spending pot account ID', 200);
    const category = string(input.category, 'Spending pot category', 200);
    const categoryKey = category.toLocaleLowerCase('nb-NO');
    if (accountIds.has(accountId) || categories.has(categoryKey)) throw new ValidationError('Use each account and category in only one spending plan.');
    accountIds.add(accountId); categories.add(categoryKey);
    return {
      accountId, category,
      monthlySpending: input.monthlySpending == null ? null : nonnegative(input.monthlySpending, 'Monthly pot spending'),
      monthlyFunding: nonnegative(input.monthlyFunding ?? 0, 'Monthly pot funding'),
      topUps: list(input.topUps ?? [], 'Planned top-ups', 120).map(topUp => {
        object(topUp, 'Planned top-up');
        for (const key of Object.keys(topUp)) if (!['date', 'amount'].includes(key)) throw new ValidationError('Unknown planned top-up field.');
        const topUpAmount = nonnegative(topUp.amount, 'Planned top-up amount');
        if (!topUpAmount) throw new ValidationError('A planned top-up must have a positive amount.');
        return { date: date(topUp.date, 'Planned top-up date'), amount: topUpAmount };
      }),
      reviewAtBalance: input.reviewAtBalance == null ? null : nonnegative(input.reviewAtBalance, 'Review balance'),
    };
  });
}
export function override(value) {
  object(value, 'Transaction edit'); const result = {};
  for (const key of Object.keys(value)) if (!['kind', 'category', 'excludeForecast', 'fromOwnedAccountId', 'toOwnedAccountId'].includes(key)) throw new ValidationError('Unknown transaction edit field.');
  if ('kind' in value) result.kind = kind(value.kind);
  if ('category' in value) result.category = string(value.category, 'Category', 200);
  if ('excludeForecast' in value) result.excludeForecast = boolean(value.excludeForecast, 'Exclude from forecast');
  for (const key of ['fromOwnedAccountId', 'toOwnedAccountId']) if (key in value) result[key] = string(value[key], 'Owned account ID', 200);
  return result;
}
