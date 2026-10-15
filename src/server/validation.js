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
  for (const key of Object.keys(value)) if (!['fields', 'horizon', 'historyMonths', 'methods', 'lookback', 'assumptions', 'scenario', 'balanceSource'].includes(key)) throw new ValidationError('Unknown forecast setting.');
  if ('historyMonths' in value) {
    if (![0, 1, 3, 6, 12, 24].includes(value.historyMonths)) throw new ValidationError('Unknown chart history window.');
    result.historyMonths = value.historyMonths;
  }
  if ('methods' in value) {
    const supported = ['unchanged', 'average', 'recent', 'smoothed', 'seasonal'];
    if (!Array.isArray(value.methods) || value.methods.length > supported.length || value.methods.some(id => !supported.includes(id)) || new Set(value.methods).size !== value.methods.length) throw new ValidationError('Unknown or repeated forecast comparison method.');
    result.methods = [...value.methods];
  }
  if ('balanceSource' in value) {
    if (!['manual', 'accounts'].includes(value.balanceSource)) throw new ValidationError('Balance source must be manual or accounts.');
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
  return result;
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
