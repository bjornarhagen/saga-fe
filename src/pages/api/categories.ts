import { endpoint } from '../../server/http.js';
export const PATCH = endpoint(({ store, body }) => store.updateCategories(body), { body: true });
