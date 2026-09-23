import { createServer } from 'node:http';
import { streamEvents, waitForResponse } from './live.js';
import { renderPresentationDocument, PRESENTATION_CSP } from './presentations.js';

// The service has no website dependency. A static website handler can be injected for convenience.
export function createThreadroomServer(store, { websiteHandler = null, allowedOrigins = [], runtimeIdentity = {} } = {}) {
  const origins = new Set(allowedOrigins);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://threadroom.local');
      const hostname = new URL(`http://${request.headers.host || 'unknown'}`).hostname;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return json(response, 403, { error: 'This local spike accepts loopback hostnames only' });
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const origin = request.headers.origin;
      const sameOrigin = origin === `http://${request.headers.host}`;
      const allowed = !origin || sameOrigin || origins.has(origin);
      if (origin && origins.has(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        if (!allowed) return json(response, 403, { error: 'Browser origin is not allowed' });
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
          'Access-Control-Max-Age': '60'
        });
        return response.end();
      }
      if (request.method === 'POST' && (!allowed || (request.headers['sec-fetch-site'] === 'cross-site' && !origins.has(origin)))) {
        return json(response, 403, { error: 'Cross-origin browser writes are not permitted' });
      }

      if (url.pathname === '/api/health' && request.method === 'GET') return json(response, 200, {
        ok: true, service: 'threadroom', apiVersion: 2, website: !!websiteHandler, ...runtimeIdentity
      });
      if (url.pathname === '/api/attention' && request.method === 'GET') {
        return json(response, 200, { items: store.listAttention() });
      }
      if (url.pathname === '/api/tree' && request.method === 'GET') {
        const nodes = store.listNodes().map(({ presentation, response: savedResponse, body: savedBody, ...summary }) => ({
          ...summary, responseKind: savedResponse?.kind || null, hasPresentation: !!presentation
        }));
        return json(response, 200, { nodes });
      }
      if ((url.pathname === '/api/nodes' || url.pathname === '/api/ask') && request.method === 'POST') {
        const input = await body(request);
        // A blocking ask is still publication first, but malformed transport
        // options must not turn a rejected request into a durable question.
        const wait = url.pathname === '/api/ask' ? waitOptions(input) : null;
        const published = store.createNode(input, request.headers['idempotency-key']);
        if (wait) {
          waitForResponse(request, response, store, published.node.id, { published, timeoutMs: wait.timeoutMs });
          return;
        }
        return json(response, published.deduplicated ? 200 : 201, published);
      }
      const nodeMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
      if (nodeMatch && request.method === 'GET') return json(response, 200, store.getNode(decodeURIComponent(nodeMatch[1])));
      const respondMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/respond$/);
      if (respondMatch && request.method === 'POST') {
        const result = store.respond(decodeURIComponent(respondMatch[1]), await body(request), request.headers['idempotency-key']);
        return json(response, result.deduplicated ? 200 : 201, result);
      }
      const presentationMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/presentation$/);
      if (presentationMatch && request.method === 'GET') {
        const { node } = store.getNode(decodeURIComponent(presentationMatch[1]));
        if (node.presentation?.kind !== 'html-v1') return json(response, 404, { error: 'No authored HTML presentation on this thread' });
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PRESENTATION_CSP,
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          'Cache-Control': 'no-store'
        });
        response.end(renderPresentationDocument(node.presentation));
        return;
      }
      if (url.pathname === '/api/stream' && request.method === 'GET') {
        streamEvents(request, response, store, { after: Number(url.searchParams.get('after') || 0) });
        return;
      }
      if (url.pathname === '/api/events' && request.method === 'GET') return json(response, 200, {
        events: store.listEvents(Number(url.searchParams.get('after') || 0), url.searchParams.get('threadId'))
      });

      // First-spike compatibility endpoints. All adapters use the same recursive records.
      if (url.pathname === '/api/threads' && request.method === 'GET') return json(response, 200, { threads: store.listThreads(url.searchParams.get('view') || 'history') });
      if (url.pathname === '/api/threads' && request.method === 'POST') return json(response, 201, { thread: store.createThread(await body(request)) });
      const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (threadMatch && request.method === 'GET') return json(response, 200, { thread: store.getThread(decodeURIComponent(threadMatch[1])) });
      const questionMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/questions$/);
      if (questionMatch && request.method === 'POST') return json(response, 201, { thread: store.addQuestion(decodeURIComponent(questionMatch[1]), await body(request)) });
      const responseMatch = url.pathname.match(/^\/api\/questions\/([^/]+)\/responses$/);
      if (responseMatch && request.method === 'POST') {
        const result = store.addResponse(decodeURIComponent(responseMatch[1]), await body(request), request.headers['idempotency-key']);
        return json(response, result.deduplicated ? 200 : 201, result);
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found' });
      if (websiteHandler) return await websiteHandler(request, response);
      return json(response, 404, { error: 'API-only service; this host does not serve a website' });
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
    if (size > 5_000_000) {
      const error = new Error('Request body is too large'); error.statusCode = 413; throw error;
    }
    chunks.push(chunk);
  }
  const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw clientError('Request body must be a JSON object');
  return value;
}

function waitOptions(input) {
  if (!Object.hasOwn(input, 'wait') || input.wait === undefined) return null;
  const wait = input.wait;
  if (!wait || typeof wait !== 'object' || Array.isArray(wait)) throw clientError('wait must be an object');
  const timeoutMs = wait.timeoutMs ?? 60_000;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw clientError('timeoutMs must be a non-negative number');
  }
  return { timeoutMs: Math.min(timeoutMs, 120_000) };
}

function clientError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function json(response, status, value) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
