import { endpoint } from '../../server/http.js';
export const GET = endpoint(({ store }) => store.getAccountMemberships());
export const PATCH = endpoint(({ store, body }) => store.updateAccountMembership(body), { body: true });
