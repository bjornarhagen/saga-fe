import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const exportError = () => Response.json({ error: 'The export could not be created. Please try again.' }, { status: 500, headers: privateHeaders });
const cancelled = () => new Response(null, { status: 499, headers: privateHeaders });
let snapshotInProgress = false;

/** Store may be lazy so HEAD and invalid formats never open the database. */
export async function createExportResponse({ request, url = new URL(request.url), store }, { temporaryRoot = tmpdir() } = {}) {
  const format = url.searchParams.get('format') ?? 'json';
  if (!['json', 'sqlite'].includes(format)) return Response.json({ error: 'Choose json or sqlite for this export.' }, { status: 400, headers: privateHeaders });
  const filename = `saga-fe-ledger-${new Date().toISOString().slice(0, 10)}.${format}`;
  const headers = {
    ...privateHeaders,
    'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'application/vnd.sqlite3',
    'Content-Disposition': `attachment; filename="${filename}"`,
  };
  if (request.method === 'HEAD') return new Response(null, { headers });
  if (request.signal.aborted) return cancelled();
  if (format === 'json') {
    try {
      const ledger = typeof store === 'function' ? store() : store;
      return new Response(JSON.stringify(ledger.exportLedger()), { headers });
    } catch { return exportError(); }
  }
  // Bound both snapshot work and temporary disk use, including slow downloads.
  if (snapshotInProgress) return Response.json({ error: 'Another database export is in progress. Try again shortly.' }, { status: 429, headers: { ...privateHeaders, 'Retry-After': '5' } });
  snapshotInProgress = true;
  let directory, file, controller, disposed;
  let stopped = false;
  const dispose = () => {
    if (!disposed) {
      stopped = true;
      request.signal.removeEventListener('abort', onAbort);
      disposed = (async () => {
        try {
          try { if (file) await file.close(); }
          finally { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }); }
        } finally { snapshotInProgress = false; }
      })();
    }
    return disposed;
  };
  const onAbort = () => {
    // A native SQLite backup cannot be interrupted safely. During preparation
    // the checks below wait for it to settle, then remove its private snapshot.
    if (!controller || stopped) return;
    controller.error(new Error('The export was cancelled.'));
    void dispose().catch(() => {});
  };
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const ledger = typeof store === 'function' ? store() : store;
    directory = await mkdtemp(join(temporaryRoot, 'saga-fe-export-'));
    await chmod(directory, 0o700);
    if (request.signal.aborted) { await dispose(); return cancelled(); }
    const snapshot = join(directory, 'ledger.sqlite');
    await ledger.backup(snapshot);
    if (request.signal.aborted) { await dispose(); return cancelled(); }
    await chmod(snapshot, 0o600);
    file = await open(snapshot, 'r');
    const { size } = await file.stat();
    if (request.signal.aborted) { await dispose(); return cancelled(); }
    headers['Content-Length'] = String(size);
    let position = 0;
    const body = new ReadableStream({
      start(value) { controller = value; },
      async pull(value) {
        if (stopped) return;
        try {
          const chunk = new Uint8Array(64 * 1024);
          const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
          if (stopped) return;
          if (!bytesRead) {
            await dispose();
            value.close();
          } else {
            position += bytesRead;
            value.enqueue(chunk.subarray(0, bytesRead));
          }
        } catch {
          try { await dispose(); } catch { /* Expose no filesystem details. */ }
          value.error(new Error('The export could not be completed. Please try again.'));
        }
      },
      async cancel() {
        try { await dispose(); }
        catch { throw new Error('The export could not be completed. Please try again.'); }
      },
    });
    return new Response(body, { headers });
  } catch {
    try { await dispose(); } catch { /* Expose no filesystem details. */ }
    return request.signal.aborted ? cancelled() : exportError();
  }
}
