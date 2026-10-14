import { getStore } from './database.js';
import { ValidationError, object } from './validation.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function readJSON(request, limit = 2 * 1024 * 1024) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Use application/json for this request.');
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON request body is required.');
  let bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new HttpError(413, 'The request is too large.'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'The request must contain valid JSON.');
  } finally { reader.releaseLock(); }
}
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export function endpoint(action, { body = false, limit, status = 200 } = {}) {
  return async context => {
    try {
      const data = body ? object(await readJSON(context.request, limit), 'Request') : undefined;
      const result = await action({ ...context, body: data, store: getStore() });
      return Response.json(result, { status, headers });
    } catch (error) {
      if (error instanceof ValidationError) return Response.json({ error: error.message }, { status: 400, headers });
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers });
      // Never expose SQL, paths, account identifiers, or source rows in error responses/logs.
      return Response.json({ error: 'The data could not be saved or loaded. Please try again.' }, { status: 500, headers });
    }
  };
}
