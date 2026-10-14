import { endpoint, HttpError } from '../../../server/http.js';
export const GET = endpoint(({ store, params }) => {
  const result = store.getEndpointActivity(params.id);
  if (!result) throw new HttpError(404, 'This account or counterparty was not found.');
  return result;
});
