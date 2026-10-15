import { endpoint } from '../../server/http.js';
export const PATCH = endpoint(({ store, body }) => store.updateAccountOwnership(body), { body: true });
