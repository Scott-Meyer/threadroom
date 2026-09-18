import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

/** Node HTTP connections owned by one client, not the host's fetch/dispatcher.
 * Agents are allocated only on first use. close() cancels owned work, releases
 * sockets, and permanently rejects further opens; it never closes another client.
 */
export class HttpTransport {
  constructor() { this.agents = new Map(); this.requests = new Map(); this.closed = false; }
  async open(url, { method = 'GET', headers, body, signal } = {}) {
    if (this.closed) throw new Error('Threadroom client is closed.');
    const address = new URL(url);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
      throw new Error('Threadroom needs an HTTP(S) address without embedded credentials.');
    }
    signal?.throwIfAborted();
    let agent = this.agents.get(address.protocol);
    if (!agent) {
      agent = new (address.protocol === 'https:' ? HttpsAgent : HttpAgent)({ keepAlive: true });
      this.agents.set(address.protocol, agent);
    }
    return new Promise((resolve, reject) => {
      const request = (address.protocol === 'https:' ? httpsRequest : httpRequest)(address, { method, headers, agent, signal });
      const closed = new Promise(resolve => request.once('close', () => { this.requests.delete(request); resolve(); }));
      this.requests.set(request, closed);
      request.once('error', reject);
      request.once('response', response => {
        // A cancellation can race the consumer attaching its body iterator.
        // Keep that gap safe; the iterator still observes the stream's error.
        response.once('error', () => {});
        resolve(response);
      });
      request.end(body);
    });
  }
  async close() {
    this.closed = true;
    const active = [...this.requests];
    for (const [request] of active) request.destroy(new Error('Threadroom client is closed.'));
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
    await Promise.all(active.map(([, closed]) => closed));
  }
}
