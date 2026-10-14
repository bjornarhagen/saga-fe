import { endpoint, HttpError } from '../../../server/http.js';
export const GET = endpoint(({ store, params }) => {
  const result = store.getTransactionDetail(params.id);
  if (!result) throw new HttpError(404, 'This transaction was not found.');
  return result;
});
