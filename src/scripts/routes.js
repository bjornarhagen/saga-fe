const views = new Set(['overview', 'forecast', 'transactions', 'accounts', 'data']);
const opaqueId = /^[A-Za-z0-9_:-]{1,200}$/;

export function parseRoute(hash = '') {
  const value = String(hash).replace(/^#/, '');
  if (views.has(value)) return { view: value };
  const match = /^(transactions|accounts)\/([^/]+)$/.exec(value);
  if (match) {
    try {
      const id = decodeURIComponent(match[2]);
      if (opaqueId.test(id)) return { view: match[1] === 'transactions' ? 'transaction' : 'account', id };
    } catch { /* A malformed URL opens the overview. */ }
  }
  return { view: 'overview' };
}

export function routeHash(route) {
  if (['transaction', 'account'].includes(route?.view) && opaqueId.test(route.id || '')) {
    return `#${route.view === 'transaction' ? 'transactions' : 'accounts'}/${encodeURIComponent(route.id)}`;
  }
  return `#${views.has(route?.view) ? route.view : 'overview'}`;
}

export function parentView(route) {
  return route.view === 'transaction' ? 'transactions' : route.view === 'account' ? 'accounts' : route.view;
}
