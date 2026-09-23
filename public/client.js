// A UI-independent HTTP client. Persistence, hierarchy, and lifecycle are service concerns.
export class ThreadroomClient {
  constructor(baseUrl = '') { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  url(path) { return `${this.baseUrl}${path}`; }
  async request(path, options = {}) {
    const response = await fetch(this.url(path), { ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }
  tree() { return this.request('/api/tree'); }
  attention() { return this.request('/api/attention'); }
  read(id) { return this.request(`/api/nodes/${encodeURIComponent(id)}`); }
  publish(input, key) { return this.request('/api/nodes', { method: 'POST',
    headers: key ? { 'Idempotency-Key': key } : {}, body: JSON.stringify(input) }); }
  ask(input, key) { return this.request('/api/ask', { method: 'POST',
    headers: key ? { 'Idempotency-Key': key } : {}, body: JSON.stringify(input) }); }
  respond(id, input, key) { return this.request(`/api/nodes/${encodeURIComponent(id)}/respond`, { method: 'POST',
    headers: key ? { 'Idempotency-Key': key } : {}, body: JSON.stringify(input) }); }
  reply(id, input, key) { return this.respond(id, input, key); }
  subscribe(onEvent, { after = 0, onState = () => {} } = {}) {
    const stream = new EventSource(this.url(`/api/stream?after=${after}`));
    stream.addEventListener('open', () => onState('live'));
    stream.addEventListener('error', () => onState('reconnecting'));
    stream.addEventListener('change', (event) => {
      try { onEvent(JSON.parse(event.data)); } catch (error) { console.error('Bad Threadroom event:', error); }
    });
    return () => stream.close();
  }
}
