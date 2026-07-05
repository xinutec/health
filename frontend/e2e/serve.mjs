// Minimal static server for the production bundle, used by the Playwright e2e
// run (the L2 phone-width layout harness — see
// @xinutec/ui-harness + dev-lint/docs/layout-quality-architecture.md). Serves
// dist/frontend/browser with SPA fallback to index.html and correct content
// types. No deps; Node stdlib only. The specs mock every /api/ call via
// page.route, so the tiny API stub below is only a fallback for anything they
// leave unrouted. Matches life/fleetwatch/messages' e2e/serve.mjs.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist', 'frontend', 'browser');
const PORT = Number(process.argv[2] ?? 4273);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function fileFor(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidate = join(ROOT, clean);
  try {
    if ((await stat(candidate)).isFile()) return candidate;
  } catch {
    /* fall through to SPA fallback */
  }
  return join(ROOT, 'index.html');
}

// Fallback stub only — the specs page.route everything. Real prod is the Rust
// backend. Signed-in + Fitbit-linked so an un-mocked run still leaves the shell.
const API = {
  '/api/me': {
    userId: 'test',
    displayName: 'Test',
    fitbitLinked: true,
    connections: { nextcloud: { status: 'active' }, fitbit: { status: 'active' } },
    shareWindow: null,
  },
  '/api/location/latest': null,
};

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(path in API ? API[path] : []));
    return;
  }
  const file = await fileFor(req.url ?? '/');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
