import { endpoint } from '../../server/http.js';
export const GET = endpoint(({ store }) => store.getHistory());
export const POST = endpoint(({ store, body }) => ({ batch: store.ingest(body), ...store.getTransactions() }), { body: true, limit: 30 * 1024 * 1024 });
