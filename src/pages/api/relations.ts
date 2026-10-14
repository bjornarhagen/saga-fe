import { endpoint } from '../../server/http.js';
export const GET = endpoint(({ store }) => store.getRelations());
export const PATCH = endpoint(({ store, body }) => store.updateRelation(body), { body: true });
