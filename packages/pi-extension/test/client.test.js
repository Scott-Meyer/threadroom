import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, globalAgent as httpAgent } from 'node:http';
import { globalAgent as httpsAgent } from 'node:https';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { ThreadroomClient } from '../src/client.js';

async function server(t, handler) {
  const service = createServer(handler);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  return `http://127.0.0.1:${service.address().port}`;
}

test('shared client JSON and split-Unicode SSE work despite broken host fetch/QoS, without changing host network globals', { timeout: 8000 }, async (t) => {
  const fetch = globalThis.fetch, qos = Socket.prototype.setTypeOfService;
  const dispatcherSymbols = Object.getOwnPropertySymbols(globalThis).filter(key => String(key).includes('undici'));
  const dispatchers = new Map(dispatcherSymbols.map(key => [key, globalThis[key]]));
  let qosCalls = 0;
  globalThis.fetch = () => { throw new Error('The shared adapter must not use host fetch'); };
  const forbiddenFetch = globalThis.fetch;
  Socket.prototype.setTypeOfService = () => { qosCalls++; throw Object.assign(new Error('Injected macOS QoS failure'), { code: 'EINVAL' }); };
  t.after(() => { globalThis.fetch = fetch; Socket.prototype.setTypeOfService = qos; });
  const event = { id: 'event-1', sequence: 1, type: 'response.created', payload: { questionId: '日本語', responseId: '✨' } };
  const url = await server(t, async (request, response) => {
    if (request.url.startsWith('/api/stream')) {
      response.setHeader('Content-Type', 'text/event-stream');
      const bytes = Buffer.from(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
      const split = bytes.indexOf(Buffer.from('✨')) + 1;
      response.write(bytes.subarray(0, split));
      setImmediate(() => response.write(bytes.subarray(split)));
    } else {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ body: JSON.parse(Buffer.concat(chunks)), key: request.headers['idempotency-key'] }));
    }
  });
  const client = new ThreadroomClient(url); t.after(() => client.close());
  let opened = false;
  const live = client.events(0, undefined, () => { opened = true; });
  const next = live.next();
  const result = await client.publish({ question: '日本語 ✨' }, { key: 'unicode-once' });
  assert.deepEqual(result, { body: { question: '日本語 ✨' }, key: 'unicode-once' });
  assert.deepEqual((await next).value, event); assert.equal(opened, true);
  await live.return();
  assert.equal(qosCalls, 0); assert.equal(globalThis.fetch, forbiddenFetch);
  assert.equal((await import('node:http')).globalAgent, httpAgent);
  assert.equal((await import('node:https')).globalAgent, httpsAgent);
  assert.deepEqual(Object.getOwnPropertySymbols(globalThis).filter(key => String(key).includes('undici')), dispatcherSymbols);
  for (const [key, value] of dispatchers) assert.equal(globalThis[key], value);
});

test('client close cancels its held stream/body, is permanent/idempotent, and leaves another client usable; abort and timeout include body reads', { timeout: 8000 }, async (t) => {
  let streamReady;
  const ready = new Promise(resolve => { streamReady = resolve; });
  const url = await server(t, (request, response) => {
    if (request.url.startsWith('/api/stream')) {
      response.setHeader('Content-Type', 'text/event-stream'); response.flushHeaders(); streamReady();
    } else if (request.url === '/held') {
      response.setHeader('Content-Type', 'application/json'); response.write('{"unfinished":');
    } else {
      response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}');
    }
  });
  const first = new ThreadroomClient(url), second = new ThreadroomClient(url), short = new ThreadroomClient(url, { timeoutMs: 20 });
  t.after(() => Promise.all([first.close(), second.close(), short.close()]));
  const stream = first.events(0), reading = stream.next();
  const streamRejected = assert.rejects(reading);
  const bodyRejected = assert.rejects(first.request('/held'));
  await ready;
  await first.close(); await first.close();
  await Promise.all([streamRejected, bodyRejected]);
  await assert.rejects(first.request('/'), /client is closed/);
  assert.deepEqual(await second.request('/'), { ok: true });
  await assert.rejects(short.request('/held'), /Threadroom connection failed/);
  const abort = new AbortController();
  const cancelled = assert.rejects(second.request('/held', { signal: abort.signal }));
  abort.abort(); await cancelled;
  const streamAbort = new AbortController();
  let opened; const open = new Promise(resolve => { opened = resolve; });
  const held = second.events(0, streamAbort.signal, opened);
  const cancelledStream = assert.rejects(held.next());
  await open; streamAbort.abort(); await cancelledStream;
  assert.deepEqual(await second.request('/'), { ok: true });
});
