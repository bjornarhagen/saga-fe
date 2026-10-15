// Convert the former income-trend comparison into the shared option without
// writing saved data or filling absent fields in partial settings updates.
export function normalizeIncomeGrowthSettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const result = { ...settings };
  const legacySelected = (Array.isArray(settings.methods) && settings.methods.includes('income-trend'))
    || (Array.isArray(settings.forecastChart?.methods) && settings.forecastChart.methods.includes('income-trend'));
  if (!Object.hasOwn(settings, 'incomeGrowth') && legacySelected) result.incomeGrowth = true;
  if (Array.isArray(settings.methods)) result.methods = settings.methods.filter(id => id !== 'income-trend');
  if (Array.isArray(settings.forecastChart?.methods)) {
    const methods = settings.forecastChart.methods.filter(id => id !== 'income-trend');
    result.forecastChart = { ...settings.forecastChart, methods: methods.length ? methods : ['scenario'] };
  }
  return result;
}
