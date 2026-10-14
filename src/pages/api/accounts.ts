import { endpoint } from '../../server/http.js';
export const GET = endpoint(({ store }) => store.getAccounts());
export const PATCH = endpoint(({ store, body }) => store.updateAccount(body), { body: true });
export const POST = endpoint(({ store, body }) => store.createAccount(body), { body: true, status: 201 });
