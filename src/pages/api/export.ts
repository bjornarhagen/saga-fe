import type { APIRoute } from 'astro';
import { getStore } from '../../server/database.js';
import { createExportResponse } from '../../server/export.js';

export const GET: APIRoute = ({ request, url }) => createExportResponse({ request, url, store: getStore });
export const HEAD = GET;
