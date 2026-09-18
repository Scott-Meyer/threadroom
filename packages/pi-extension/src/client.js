// Rendering-independent transport; no Pi, website, or database dependencies.
export class ThreadroomError extends Error {
  constructor(message, { status, ambiguous = false } = {}) {
    super(message); this.name = 'ThreadroomError'; this.status = status; this.ambiguous = ambiguous;
  }
}

export class ThreadroomClient {
  constructor(baseUrl = 'http://127.0.0.1:4310', { uiUrl = baseUrl, timeoutMs = 15000 } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Threadroom needs an HTTP(S) address without embedded credentials.');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    this.uiUrl = new URL(uiUrl).href.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }
  link(id) { return `${this.uiUrl}/threads/${encodeURIComponent(id)}`; }
  async request(path, { method = 'GET', input, key, signal } = {}) {
    const combined = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method, signal: combined,
        redirect: 'error', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
      const result = await response.json();
      if (!response.ok) throw new ThreadroomError(result.error || `HTTP ${response.status}`, { status: response.status });
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

  // Fetch-based SSE works in Node and supports cancellation/replay without EventSource.
  async *events(after, signal, onOpen = () => {}) {
    const response = await fetch(`${this.baseUrl}/api/stream?after=${after}`, { signal, redirect: 'error',
      headers: { Accept: 'text/event-stream' } });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new ThreadroomError(`Threadroom stream failed (HTTP ${response.status})`);
    }
    onOpen();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', data = [], eventType = '', frameSize = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new ThreadroomError('Threadroom stream disconnected');
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
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
