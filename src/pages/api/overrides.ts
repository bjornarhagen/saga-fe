import { endpoint } from '../../server/http.js';
export const GET = endpoint(({ store }) => ({ overrides: store.getOverrides() }));
export const PUT = endpoint(({ store, body }) => ({ overrides: store.saveOverrides(body.overrides) }), { body: true });
export const PATCH = endpoint(({ store, body }) => ({ overrides: store.updateOverride(body) }), { body: true });
