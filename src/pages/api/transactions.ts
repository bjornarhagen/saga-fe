import { endpoint } from '../../server/http.js';
export const GET = endpoint(({ store }) => store.getTransactions());
