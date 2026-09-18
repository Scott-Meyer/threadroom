import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readable } from './client.js';

// Session participation, not another conversation store. Checkpoints contain only
// watched identities and a replay position. The host confirms persisted receipts.
export class Participation {
  constructor(client, { state, received = [], author, checkpoint = () => {},
    deliver = () => {}, connection = () => {} } = {}) {
    this.client = client; this.author = author; this.checkpoint = checkpoint;
    this.deliver = deliver; this.connection = connection;
    this.watches = new Set(state?.watches || []);
    this.cursor = state?.cursor || 0; this.received = new Set(received); this.offered = new Set();
    this.pending = new Map(); this.waiters = new Map(); this.status = 'disconnected';
    this.closed = false; this.generation = 0;
  }
  snapshot() {
    const unconfirmed = [...this.pending.values()].map((p) => p.sequence - 1);
    return { watches: [...this.watches], cursor: Math.min(this.cursor, ...unconfirmed) };
  }
  save() { if (!this.closed) this.checkpoint(this.snapshot()); }
  adjacent() { return { connection: this.status, watching: [...this.watches].slice(-12),
    ...(this.watches.size > 12 ? { otherWatches: this.watches.size - 12 } : {}),
    unconfirmedDeliveries: this.pending.size }; }
  start() {
    if (this.closed || !this.watches.size) return;
    this.controller?.abort();
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.task = this.run(generation, this.controller.signal);
  }
  async close() {
    if (this.closed) return;
    this.closed = true; ++this.generation; this.controller?.abort();
    for (const inspect of this.waiters.values()) inspect('cancelled');
    await this.task;
  }
  async run(generation, signal) {
    let backoff = 250;
    while (!signal.aborted && generation === this.generation) {
      try {
        this.setStatus('connecting');
        for await (const event of this.client.events(this.cursor, signal, () => {
          if (!signal.aborted && generation === this.generation) this.setStatus('live');
        })) {
          if (signal.aborted || generation !== this.generation) return;
          this.setStatus('live'); backoff = 250;
          await this.consume(event, signal);
        }
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        this.setStatus('reconnecting', error.message);
        await delay(backoff, undefined, { signal, ref: false }).catch(() => {});
        backoff = Math.min(backoff * 2, 10000);
      }
    }
  }
  setStatus(status, error) {
    this.status = status; this.connection({ status, ...(error ? { error } : {}) });
  }
  async consume(event, signal) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.cursor) return;
    if (event.type === 'response.created' && this.watches.has(event.payload.questionId)) {
      const id = event.payload.responseId;
      if (!this.received.has(id)) {
        // Do not advance past a response until its readable record is available.
        const response = await this.client.read(id, { signal });
        const target = await this.client.read(event.payload.questionId, { signal });
        if (this.closed || signal.aborted) return;
        if (!this.closed && !signal.aborted && !this.received.has(id) && this.watches.has(target.node.id) &&
            !(this.author?.sessionId && response.node.author?.sessionId === this.author.sessionId)) {
          this.pending.set(id, { eventId: event.id, sequence: event.sequence, responseId: id,
            target: readable({ ...target, children: [] }, this.client), response: readable(response, this.client), sent: this.offered.has(id) || this.pending.get(id)?.sent || false });
          if (this.waiters.has(target.node.id)) this.waiters.get(target.node.id)();
          else this.flush();
        }
      }
    }
    this.cursor = event.sequence; this.save();
  }
  flush() {
    if (this.closed) return;
    for (const [id, receipt] of this.pending) {
      if (receipt.sent || this.received.has(id) || this.waiters.has(receipt.target.node.id)) continue;
      receipt.sent = true;
      try { if (this.deliver(receipt) === false) receipt.sent = false; }
      catch (error) { receipt.sent = false; this.setStatus('delivery_failed', error.message); }
    }
  }
  // Called for actual transcript receipts, not merely sendMessage acceptance.
  acknowledge(ids) {
    for (const id of ids) { this.received.add(id); this.offered.delete(id); this.pending.delete(id); }
    this.save();
  }
  async watch(id, { signal } = {}) {
    const record = await this.client.read(id, { signal });
    if (this.closed) throw new Error('Threadroom session has ended.');
    if (!this.watches.has(id)) {
      this.watches.add(id); this.cursor = 0; this.save(); this.start();
    }
    return { ...readable(record, this.client), participation: this.adjacent() };
  }
  unwatch(id) {
    this.waiters.get(id)?.('cancelled');
    this.watches.delete(id);
    for (const [responseId, receipt] of this.pending) {
      if (receipt.target.node.id === id) { this.offered.delete(responseId); this.pending.delete(responseId); }
    }
    this.save();
    if (!this.watches.size) { this.controller?.abort(); this.setStatus('disconnected'); }
    return { id, participation: this.adjacent(), note: 'Only this session stopped watching; shared history is unchanged.' };
  }
  async publish(input, { key = randomUUID(), waitMs, signal } = {}) {
    let published;
    try { published = await this.client.publish({ ...input, author: input.author || this.author }, { key, signal }); }
    catch (error) { error.retryKey = key; throw error; }
    if (this.closed) return { ...readable(published, this.client), retryKey: key };
    // Publication is already durable. Watching before waiting closes the answer race.
    if (!this.watches.has(published.node.id)) {
      this.watches.add(published.node.id); this.cursor = 0; this.save(); this.start();
    }
    const result = waitMs !== undefined ? await this.wait(published.node.id, { timeoutMs: waitMs, signal }) : {};
    return { ...readable(published, this.client), ...result, retryKey: key, participation: this.adjacent() };
  }
  async respond(id, input, { key = randomUUID(), signal } = {}) {
    let response;
    try { response = await this.client.respond(id, { ...input, author: input.author || this.author }, { key, signal }); }
    catch (error) { error.retryKey = key; throw error; }
    return { ...readable(response, this.client),
      target: response.target ? readable({ node: response.target, children: [], ancestors: [] }, this.client).node : undefined,
      responseId: response.responseId, retryKey: key, participation: this.adjacent() };
  }
  async read(id, { signal } = {}) {
    return { ...readable(await this.client.read(id, { signal }), this.client), participation: this.adjacent() };
  }
  async wait(id, { timeoutMs = 120000, signal } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw new Error('Wait timeout is 0–120000 ms; later replies remain available.');
    if (this.waiters.has(id)) throw new Error('This session is already waiting on that node.');
    if (!this.watches.has(id)) await this.watch(id, { signal });
    let finish, inspecting = false, inspectAgain = false, settled = false;
    const controller = new AbortController();
    const waitSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const outcome = new Promise((resolve) => { finish = (value) => {
      if (settled) return;
      settled = true; resolve(value); controller.abort();
    }; });
    const inspect = async (end) => {
      if (end) return finish({ outcome: end, response: null });
      if (settled) return;
      if (inspecting) { inspectAgain = true; return; }
      inspecting = true;
      try {
        do {
          inspectAgain = false;
          const record = await this.client.read(id, { signal: waitSignal });
          if (settled || this.closed) return;
          if (!record.node.expectsAnswer) throw new Error('This node does not request an answer.');
          const latest = record.children.filter((child) => child.response).at(-1);
          if (latest && ['answer', 'clarification', 'defer', 'reject'].includes(latest.response.kind)) {
            const savedResponse = readable({ node: latest,
              ancestors: [...record.ancestors, record.node], children: [] }, this.client);
            this.offered.add(latest.id);
            // Hold replay until the host persists the tool result, even when
            // this read found the answer before its SSE event arrived.
            if (!this.pending.has(latest.id)) this.pending.set(latest.id, { sequence: 1,
              responseId: latest.id, target: readable(record, this.client), response: savedResponse, sent: true });
            else this.pending.get(latest.id).sent = true;
            this.save();
            finish({ outcome: latest.response.kind, response: savedResponse.node,
              receivedResponseIds: [latest.id] });
          }
        } while (inspectAgain && !this.closed);
      } catch (error) {
        finish({ outcome: signal?.aborted ? 'cancelled' : 'unavailable', response: null, error: error.message });
      } finally { inspecting = false; }
    };
    this.waiters.set(id, inspect);
    const timer = setTimeout(() => inspect('timeout'), timeoutMs);
    const abort = () => inspect('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || this.closed) abort(); else void inspect();
    try {
      const result = await outcome;
      return { ...result, timedOut: result.outcome === 'timeout', participation: this.adjacent() };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      this.waiters.delete(id); this.flush();
    }
  }
}
