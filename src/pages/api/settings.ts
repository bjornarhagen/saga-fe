import { endpoint } from '../../server/http.js';
export const GET = endpoint(({ store }) => ({ settings: store.getSettings() }));
export const PUT = endpoint(({ store, body }) => ({ settings: store.saveSettings(body.settings === undefined ? body : body.settings) }), { body: true });
