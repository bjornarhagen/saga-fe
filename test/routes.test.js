import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHash, parentView } from '../src/scripts/routes.js';

test('base views and opaque detail links survive a reload', () => {
  for (const view of ['overview', 'forecast', 'transactions', 'accounts', 'data']) assert.deepEqual(parseRoute(routeHash({ view })), { view });
  for (const route of [{ view: 'transaction', id: 'tx_abc-123' }, { view: 'account', id: 'ep_abc:123' }]) {
    assert.deepEqual(parseRoute(routeHash(route)), route);
    assert.equal(parentView(route), route.view === 'transaction' ? 'transactions' : 'accounts');
  }
});

test('malformed and untrusted detail URLs cannot become path components', () => {
  for (const hash of ['', '#missing', '#transactions/', '#transactions/%', '#accounts/../../data', '#accounts/%2Fsecret', '#transactions/%3Cscript%3E', '#accounts/' + 'a'.repeat(201)]) {
    assert.deepEqual(parseRoute(hash), { view: 'overview' });
  }
  assert.equal(routeHash({ view: 'account', id: 'bad/id' }), '#overview');
});
