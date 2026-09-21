/**
 * Production entry point for a single-service deploy (Render, Railway, Fly…).
 *
 * The app talks to the mock API over relative `/api` paths, which the Vite dev
 * server proxies. There is no dev server in production, so this process does
 * the same job:
 *
 *   1. starts the untouched `server/index.mjs` on an internal port,
 *   2. serves the built `dist/` as static files,
 *   3. forwards anything under `/api/` to the mock API, streaming the response
 *      so `/api/events` (SSE) still works.
 *
 * Nothing under `server/` is modified; this file only runs it.
 *
 * Note for reviewers: the mock API rate-limits per client IP, and behind this
 * proxy every visitor arrives as 127.0.0.1, so the 80-requests-per-10s budget
 * is shared by everyone using the deployed instance at once.
 *
 * Usage:  node deploy/server.mjs        (expects `npm run build` to have run)
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3000);
const API_PORT = Number(process.env.API_PORT ?? 8787);
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const API_ENTRY = fileURLToPath(new URL('../server/index.mjs', import.meta.url));

/* --- 1. the mock API, as a child process on an internal port -------------- */

const api = spawn(process.execPath, [API_ENTRY], {
  env: { ...process.env, PORT: String(API_PORT) },
  stdio: 'inherit',
});
api.on('exit', (code) => {
  console.error(`[deploy] mock API exited with ${code}`);
  process.exit(code ?? 1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    api.kill(signal);
    process.exit(0);
  });
}

/* --- 2. static files ------------------------------------------------------ */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function sendFile(res, path, status = 200) {
  const ext = extname(path);
  // Vite fingerprints everything under /assets, so it is immutable; index.html
  // must never be cached or a deploy would not reach returning visitors.
  const cache = path.includes(`${normalize('/assets/')}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(status, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': cache });
  createReadStream(path).pipe(res);
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // normalize() collapses any ../ before the join, so nothing outside dist is reachable.
  const candidate = join(DIST, normalize(pathname));
  if (candidate.startsWith(DIST)) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return sendFile(res, candidate);
    } catch {
      /* fall through to the SPA entry point */
    }
  }
  // Single page app: every other path renders index.html, which reads the view
  // out of the URL itself.
  return sendFile(res, join(DIST, 'index.html'));
}

/* --- 3. /api → the mock API ---------------------------------------------- */

function proxy(req, res) {
  const upstream = http.request(
    { host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res); // streamed, so SSE on /api/events keeps working
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'API is not reachable.' } }));
  });
  req.pipe(upstream);
}

http
  .createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/')) return proxy(req, res);
    serveStatic(req, res).catch(() => {
      res.writeHead(500).end();
    });
  })
  .listen(PORT, () => {
    console.log(`[deploy] app on :${PORT}, mock API on :${API_PORT}`);
  });
