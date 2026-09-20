// Rendering-independent Node transport; no Pi, website, database or fetch globals.
import { HttpTransport } from './http-transport.js';
export class ThreadroomError extends Error {
  constructor(message, { status, ambiguous = false } = {}) {
    super(message); this.name = 'ThreadroomError'; this.status = status; this.ambiguous = ambiguous;
  }
}

export class ThreadroomClient {
  constructor(baseUrl = 'http://127.0.0.1:4310', { uiUrl = baseUrl, timeoutMs = 15000, beforeConnect } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Threadroom needs an HTTP(S) address without embedded credentials.');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    this.uiUrl = new URL(uiUrl).href.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.beforeConnect = beforeConnect;
    this.lifetime = new AbortController();
    this.transport = new HttpTransport();
  }
  /** Cancel this client's requests/streams and release its sockets. Permanent,
   * idempotent, and independent of Participation.close() and other clients. */
  close() { this.lifetime.abort(new Error('Threadroom client is closed.')); return this.transport.close(); }
  link(id) { return `${this.uiUrl}/threads/${encodeURIComponent(id)}`; }
  async ready(signal) {
    signal.throwIfAborted();
    if (!this.beforeConnect) return;
    const work = Promise.resolve().then(() => this.beforeConnect({ signal }));
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      work.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
        (error) => { signal.removeEventListener('abort', abort); reject(error); });
    });
    signal.throwIfAborted();
  }
  async request(path, { method = 'GET', input, key, signal } = {}) {
    const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    await this.ready(combined);
    let response;
    try {
      response = await this.transport.open(`${this.baseUrl}${path}`, { method, signal: combined,
        headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        throw new Error('Threadroom redirects are not followed.');
      }
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ThreadroomError(result.error || `HTTP ${response.statusCode}`, { status: response.statusCode });
      }
      return result;
    } catch (error) {
      if (error instanceof ThreadroomError) throw error;
      throw new ThreadroomError(`Threadroom connection failed: ${error.message}`, { ambiguous: method !== 'GET' });
    }
  }
  publish(input, options = {}) { return this.request('/api/ask', { ...options, method: 'POST', input }); }
  read(id, options) { return this.request(`/api/nodes/${encodeURIComponent(id)}`, options); }
  respond(id, input, options = {}) { return this.request(`/api/nodes/${encodeURIComponent(id)}/respond`, { ...options, method: 'POST', input }); }
  tree(options) { return this.request('/api/tree', options); }

  // Owned Node SSE supports cancellation/replay without EventSource or fetch.
  async *events(after, signal, onOpen = () => {}) {
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    await this.ready(combined);
    const response = await this.transport.open(`${this.baseUrl}/api/stream?after=${after}`, { signal: combined,
      headers: { Accept: 'text/event-stream' } });
    if (response.statusCode < 200 || response.statusCode >= 300 ||
        !response.headers['content-type']?.includes('text/event-stream')) {
      response.destroy();
      throw new ThreadroomError(`Threadroom stream failed (HTTP ${response.statusCode})`);
    }
    const decoder = new TextDecoder();
    let buffer = '', data = [], eventType = '', frameSize = 0;
    try {
      onOpen();
      for await (const value of response) {
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new ThreadroomError('Threadroom stream frame exceeded 1 MiB');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line) {
            if (data.length && eventType === 'change') yield JSON.parse(data.join('\n'));
            data = []; eventType = ''; frameSize = 0;
          } else {
            frameSize += line.length;
            if (frameSize > 1024 * 1024) throw new ThreadroomError('Threadroom stream frame exceeded 1 MiB');
            if (line.startsWith('event:')) eventType = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
        }
      }
      throw new ThreadroomError('Threadroom stream disconnected');
    } finally { response.destroy(); }
  }
}

// Readable records never require executing an old authored document. Large source,
// image data and arbitrary values remain at their durable address, not in every turn.
export function readable(record, client) {
  const node = record.node;
  const summarize = (n) => ({ id: n.id, parentId: n.parentId, title: n.title,
    body: clip(n.body, n === node ? 8000 : 1500), expectsAnswer: n.expectsAnswer, status: n.status,
    author: n.author, createdAt: n.createdAt, url: client.link(n.id),
    ...(n.presentation ? { presentation: { kind: n.presentation.kind,
      revision: n.presentation.revision, fallback: clip(n.presentation.fallback, 4000),
      url: `${client.baseUrl}/api/nodes/${encodeURIComponent(n.id)}/presentation` } } : {}),
    ...(n.response ? { response: { ...n.response,
      selections: compactValues(n.response.selections, n === node ? 6000 : 1500) } } : {}) });
  return { node: summarize(node), ancestors: (record.ancestors || []).map((ancestor) => ({
      id: ancestor.id, parentId: ancestor.parentId, title: clip(ancestor.title, 2000),
      expectsAnswer: ancestor.expectsAnswer, status: ancestor.status, author: ancestor.author,
    })), counts: record.counts,
    children: (record.children || []).slice(-10).map(summarize),
    ...(record.children?.length > 10 ? { omittedChildren: record.children.length - 10 } : {}),
    url: client.link(node.id), ...(record.deduplicated !== undefined ? { deduplicated: record.deduplicated } : {}) };
}
function clip(value, length) {
  return typeof value === 'string' && value.length > length ? `${value.slice(0, length)}\n[Truncated; full content at the node URL]` : value;
}
function compactValues(values, limit) {
  if (JSON.stringify(values || []).length <= limit) return values;
  return { omitted: true, reason: 'Large semantic values or images; retrieve the durable node for the full selections.' };
}
