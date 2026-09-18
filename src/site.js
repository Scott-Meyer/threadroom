import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Website hosting is optional plumbing. This module knows nothing about persistence or thread semantics.
export function createWebsiteHandler({ apiBaseUrl = '' } = {}) {
  return async function website(request, response) {
    const url = new URL(request.url, 'http://threadroom.local');
    if (url.pathname === '/threadroom-config.json') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ apiBaseUrl }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405); response.end('Method not allowed'); return;
    }
    let filename = resolve(publicDir, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!filename.startsWith(resolve(publicDir) + '/')) { response.writeHead(403); response.end('Forbidden'); return; }
    try {
      if (!(await stat(filename)).isFile()) throw new Error('not a file');
    } catch {
      if (extname(url.pathname)) { response.writeHead(404); response.end('Not found'); return; }
      filename = resolve(publicDir, 'index.html');
    }
    const bytes = await readFile(filename);
    const apiOrigin = apiBaseUrl ? new URL(apiBaseUrl).origin : `http://${request.headers.host}`;
    response.writeHead(200, {
      'Content-Type': types[extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ${apiOrigin}; frame-src ${apiOrigin}/api/nodes/; object-src 'none'; base-uri 'none'; form-action 'self'`
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  };
}
