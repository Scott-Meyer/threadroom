import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};

export function createThreadroomServer(store) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://threadroom.local');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== `http://${request.headers.host}`)) {
          return json(response, 403, { error: 'Cross-origin browser writes are not permitted' });
        }
      }

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(response, 200, { ok: true, service: 'threadroom' });
      }
      if (url.pathname === '/api/threads' && request.method === 'GET') {
        return json(response, 200, { threads: store.listThreads(url.searchParams.get('view') || 'inbox') });
      }
      if (url.pathname === '/api/threads' && request.method === 'POST') {
        return json(response, 201, { thread: store.createThread(await body(request)) });
      }
      if (url.pathname === '/api/events' && request.method === 'GET') {
        return json(response, 200, {
          events: store.listEvents(Number(url.searchParams.get('after') || 0), url.searchParams.get('threadId'))
        });
      }

      const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (threadMatch && request.method === 'GET') {
        return json(response, 200, { thread: store.getThread(decodeURIComponent(threadMatch[1])) });
      }
      const questionMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/questions$/);
      if (questionMatch && request.method === 'POST') {
        return json(response, 201, { thread: store.addQuestion(decodeURIComponent(questionMatch[1]), await body(request)) });
      }
      const responseMatch = url.pathname.match(/^\/api\/questions\/([^/]+)\/responses$/);
      if (responseMatch && request.method === 'POST') {
        const result = store.addResponse(
          decodeURIComponent(responseMatch[1]), await body(request), request.headers['idempotency-key']
        );
        return json(response, result.deduplicated ? 200 : 201, result);
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
      return await staticFile(url.pathname, response, request.method === 'HEAD');
    } catch (error) {
      const status = error.statusCode || (error.name === 'SyntaxError' ? 400 : 500);
      if (status === 500) console.error(error);
      return json(response, status, { error: status === 500 ? 'Internal server error' : error.message });
    }
  });
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function staticFile(pathname, response, headOnly) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = normalize(decodeURIComponent(requested)).replace(/^(\.\.(\/|\\|$))+/, '');
  const filename = join(publicDir, normalized);
  if (!filename.startsWith(publicDir)) return json(response, 403, { error: 'Forbidden' });
  try {
    const details = await stat(filename);
    if (!details.isFile()) throw new Error('not a file');
    const content = await readFile(filename);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filename)] || 'application/octet-stream',
      'Cache-Control': extname(filename) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    response.end(headOnly ? undefined : content);
  } catch {
    if (extname(pathname)) return json(response, 404, { error: 'Not found' });
    const content = await readFile(join(publicDir, 'index.html'));
    response.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-cache' });
    response.end(headOnly ? undefined : content);
  }
}

function json(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
