import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { ThreadroomClient, ThreadroomError } from '../src/client.js';
import { Participation } from '../src/participation.js';

const fixtureParticipants = new WeakMap();
async function deadline(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), ms);
  })]); } finally { clearTimeout(timer); }
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function service(t) {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-pi-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((r) => reservation.close(r));
  let child, childLog = '';
  async function start() {
    childLog = '';
    child = spawn(process.execPath, [fileURLToPath(new URL('../../../src/main.js', import.meta.url))], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), THREADROOM_SERVE_UI: '0', THREADROOM_DB: join(directory, 'records.sqlite') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await deadline(new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => { childLog = (childLog + data).slice(-16000);
        if (childLog.includes('is ready at')) resolve(); });
      child.stderr.on('data', (data) => { childLog = (childLog + data).slice(-16000); });
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Service exited (${code}/${signal}): ${childLog}`)));
    }), 3000, () => `Service startup deadline: ${childLog}`);
  }
  async function stop() {
    // A child that exited by signal still has exitCode=null. Waiting for its
    // already-emitted exit event would hide the original test failure forever.
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const current = child, exit = once(current, 'exit');
    current.kill('SIGTERM');
    try { await deadline(exit, 3000, () => `Service shutdown deadline: ${childLog}`); }
    catch (error) {
      current.kill('SIGKILL');
      await deadline(exit, 1000, () => `Service did not exit after SIGKILL (PID ${current.pid}): ${childLog}`);
      throw error;
    }
  }
  const client = new ThreadroomClient(`http://127.0.0.1:${port}`), participants = new Set();
  fixtureParticipants.set(client, participants);
  t.after(async () => {
    try { await deadline(Promise.all([...participants].map((room) => room.close())), 3000, () => 'Participation shutdown deadline'); }
    finally { try { await client.close(); } finally { try { await stop(); } finally { await rm(directory, { recursive: true, force: true }); } } }
  });
  await start();
  return { client, start, stop };
}
function participant(t, client, options = {}) {
  const room = new Participation(client, { author: { name: 'Artist', id: 'pi:artist', sessionId: 'artist' }, ...options });
  fixtureParticipants.get(client).add(room); return room;
}
const human = { name: 'Artist', sessionId: 'another-session' }; // same name does not determine routing

test('an authored async ask continues, receives a correlated reply, and replay does not duplicate queued or persisted feedback', { timeout: 10000 }, async (t) => {
  const { client } = await service(t);
  const delivered = [], firstDelivery = deferred(); let checkpoint;
  const room = participant(t, client, { checkpoint: (value) => { checkpoint = value; },
    deliver: (value) => { delivered.push(value); firstDelivery.resolve(value); } });
  const ask = await room.publish({ path: ['Pi throughline', 'An experiment'], question: 'What feels right?',
    html: '<h1>An invented interaction</h1><canvas></canvas>', fallback: 'Compare the movement.', revision: 'movement-r1' });
  assert.equal(ask.node.status, 'outstanding'); assert.equal(ask.node.presentation.revision, 'movement-r1');
  assert.ok(ask.url.endsWith(ask.node.id)); assert.deepEqual(checkpoint.watches, [ask.node.id]);
  assert.equal((await room.read(ask.node.id)).children.length, 0); // independent work before any response
  const saved = await client.respond(ask.node.id, { kind: 'clarification', body: 'Show a slower variant.', author: human }, { key: 'human-1' });
  const feedback = await firstDelivery.promise;
  assert.equal(feedback.response.node.id, saved.responseId);
  assert.equal(feedback.target.node.status, 'waiting_on_team');
  assert.equal(feedback.response.node.response.presentationRevision, 'movement-r1');
  const second = await room.publish({ question: 'Another independent question?' });
  // Explicitly replay through the public transport while the first reply is queued.
  const events = await client.request('/api/events?after=0');
  const responseEvent = events.events.find((event) => event.payload.responseId === saved.responseId);
  room.cursor = responseEvent.sequence - 1;
  await room.consume(responseEvent, new AbortController().signal);
  assert.equal(delivered.length, 1);
  room.acknowledge([saved.responseId]);
  await room.close();
  const resumedDeliveries = [];
  const resumed = participant(t, client, { state: { ...checkpoint, cursor: 0 }, received: [saved.responseId], deliver: (value) => resumedDeliveries.push(value) });
  await resumed.consume(responseEvent, new AbortController().signal);
  assert.equal(resumedDeliveries.length, 0); // transcript receipt survives an interrupted checkpoint
  assert.equal((await client.read(second.node.id)).node.status, 'outstanding');
});

test('waiting returns the saved answer; timeout/cancel leave a watch and durable question for later feedback', { timeout: 10000 }, async (t) => {
  const { client } = await service(t); const delivered = [], later = deferred();
  const room = participant(t, client, { deliver: (value) => { delivered.push(value); later.resolve(value); } });
  const asked = await room.publish({ question: 'Wait on this decision?', choices: ['A', 'B'] });
  const waiting = room.wait(asked.node.id, { timeoutMs: 2000 });
  const response = await client.respond(asked.node.id, { body: 'Neither: explore C.', author: human });
  const outcome = await waiting;
  assert.equal(outcome.outcome, 'answer'); assert.equal(outcome.response.id, response.responseId);
  assert.equal(outcome.response.body, 'Neither: explore C.');
  room.acknowledge(outcome.receivedResponseIds);
  assert.equal(delivered.length, 0); // not both a tool response and a notification
  await room.respond(asked.node.id, { kind: 'answer', body: 'Not a reopen.' });
  const another = await room.publish({ question: 'Can be answered later?' });
  const expired = await room.wait(another.node.id, { timeoutMs: 10 });
  assert.equal(expired.outcome, 'timeout');
  const abort = new AbortController(); const cancelled = room.wait(another.node.id, { timeoutMs: 2000, signal: abort.signal });
  abort.abort(); assert.equal((await cancelled).outcome, 'cancelled');
  assert.equal((await client.read(another.node.id)).node.status, 'outstanding');
  const saved = await client.respond(another.node.id, { kind: 'reject', body: 'Wrong premise.', author: human });
  const receipt = await later.promise;
  assert.equal(receipt.responseId, saved.responseId); assert.equal(receipt.target.node.status, 'rejected');
});

test('an ordinary ask that waits returns its answer and matching request snapshot', { timeout: 10000 }, async (t) => {
  const { client } = await service(t); const created = deferred(), delivered = [];
  const room = participant(t, client, { checkpoint: (state) => { if (state.watches.length) created.resolve(state.watches[0]); },
    deliver: (receipt) => delivered.push(receipt) });
  const asking = room.publish({ question: 'Return useful context after answering?' }, { key: 'ordinary-wait-1', waitMs: 2000 });
  const id = await created.promise;
  const saved = await client.respond(id, { body: 'The returned request should now be answered.', author: human });
  const result = await asking;
  assert.equal(result.node.id, id); assert.equal(result.outcome, 'answer');
  assert.equal(result.response.id, saved.responseId); assert.equal(result.node.status, 'answered');
  assert.equal(result.counts.outstanding, 0); assert.equal(result.children.at(-1).id, saved.responseId);
  assert.equal(result.contextSnapshot, 'wait_read');
  room.acknowledge(result.receivedResponseIds); assert.equal(delivered.length, 0);
});

test('a paused host can decline delivery, then flush exactly one saved response when ready', { timeout: 10000 }, async (t) => {
  const { client } = await service(t); let paused = true, checkpoint; const attempted = deferred(), delivered = [];
  const room = participant(t, client, { checkpoint: (value) => { checkpoint = value; }, deliver: (value) => {
    attempted.resolve(); if (paused) return false; delivered.push(value);
  } });
  const asked = await room.publish({ question: 'While compacting?' });
  const saved = await client.respond(asked.node.id, { body: 'Still saved.', author: human });
  await attempted.promise;
  assert.equal(delivered.length, 0); assert.equal(room.pending.get(saved.responseId).sent, false);
  paused = false; room.flush(); room.flush();
  assert.equal(delivered.length, 1); assert.ok(checkpoint.cursor < delivered[0].sequence);
  room.acknowledge([saved.responseId]); room.flush();
  assert.equal(room.pending.size, 0); assert.equal(delivered.length, 1);
});

test('a read finishing after wait timeout cannot silently consume the later answer', { timeout: 10000 }, async (t) => {
  const { client } = await service(t); const gate = deferred(), entered = deferred(), delivered = deferred();
  const room = participant(t, client, { deliver: (value) => delivered.resolve(value) });
  const asked = await room.publish({ question: 'Network-late read?' });
  const original = client.read.bind(client); let held = true;
  client.read = async (id, options) => {
    if (held && id === asked.node.id) { held = false; entered.resolve(); await gate.promise; return original(id); }
    return original(id, options);
  };
  const waiting = room.wait(asked.node.id, { timeoutMs: 30 });
  await entered.promise; assert.equal((await waiting).outcome, 'timeout');
  const response = await client.respond(asked.node.id, { body: 'Answer after timeout.', author: human });
  gate.resolve();
  const receipt = await delivered.promise;
  assert.equal(receipt.responseId, response.responseId); assert.equal(room.offered.has(response.responseId), false);
});

test('service disconnect/restart catches up, and an ambiguous saved write is recovered with the same key', { timeout: 15000 }, async (t) => {
  const host = await service(t); const { client } = host; const delivery = deferred();
  let savedWrite;
  const realPublish = client.publish.bind(client); let interrupt = true;
  client.publish = async (input, options) => {
    savedWrite = await realPublish(input, options);
    if (interrupt) { interrupt = false; throw new ThreadroomError('Lost the write receipt', { ambiguous: true }); }
    return savedWrite;
  };
  const room = participant(t, client, { deliver: (receipt) => delivery.resolve(receipt) });
  let key;
  await assert.rejects(room.publish({ question: 'Recover rather than ask twice?' }, { key: 'stable-publish' }), (error) => {
    key = error.retryKey; return error.ambiguous && key === 'stable-publish';
  });
  const recovered = await room.publish({ question: 'Recover rather than ask twice?' }, { key });
  assert.equal(recovered.node.id, savedWrite.node.id); assert.equal(recovered.deduplicated, true);
  const priorState = room.snapshot(); await room.close(); await host.stop(); await host.start();
  const saved = await client.respond(recovered.node.id, { body: 'Answered while the asker was gone.', author: human });
  const resumed = participant(t, client, { state: priorState, deliver: (receipt) => delivery.resolve(receipt) }); resumed.start();
  assert.equal((await delivery.promise).responseId, saved.responseId);
  const replacement = participant(t, client);
  const read = await replacement.read(recovered.node.id);
  assert.equal(read.children.at(-1).body, 'Answered while the asker was gone.');
  assert.equal(read.participation.watching.length, 0); // reading does not silently adopt another session's watch
});

test('a still-live participant reconnects to a restarted service and receives the missed response', { timeout: 15000 }, async (t) => {
  const host = await service(t); const live = deferred(), disconnected = deferred(), caughtUp = deferred();
  const room = participant(t, host.client, { deliver: (receipt) => caughtUp.resolve(receipt),
    connection: (state) => {
      if (state.status === 'live') live.resolve();
      if (state.status === 'reconnecting') disconnected.resolve();
    } });
  const asked = await room.publish({ question: 'Survive a service restart?' });
  // Publication starts the stream asynchronously. Establish it before stopping
  // the service so this promises reconnection, not an initial-connect retry.
  await live.promise;
  await host.stop(); await disconnected.promise; await host.start();
  const saved = await host.client.respond(asked.node.id, { body: 'Recovered through replay.', author: human });
  assert.equal((await caughtUp.promise).responseId, saved.responseId);
  assert.equal(room.status, 'live');
});

test('reply receipts omit captured source while keeping answered revision and target context', { timeout: 10000 }, async (t) => {
  const { client } = await service(t); const room = participant(t, client);
  const asked = await room.publish({ question: 'Review a large authored document?',
    html: `<h1>Captured source</h1><!--${'x'.repeat(100000)}-->`, fallback: 'A source-heavy presentation.', revision: 'large-r1' });
  const reply = await room.respond(asked.node.id, { body: 'Keep its readable meaning.' });
  assert.equal(reply.target.id, asked.node.id);
  assert.equal(reply.target.presentation.revision, 'large-r1');
  assert.equal(reply.node.response.presentationRevision, 'large-r1');
  assert.equal(reply.target.presentation.html, undefined);
  assert.ok(JSON.stringify(reply).length < 10000);
});

test('a team reply reopens a clarification without returning the prior human turn to a new waiter', { timeout: 10000 }, async (t) => {
  const { client } = await service(t); const room = participant(t, client);
  const asked = await room.publish({ question: 'Can this discussion develop?' });
  const clarification = await client.respond(asked.node.id, { kind: 'clarification', body: 'What about cost?', author: human });
  const first = await room.wait(asked.node.id, { timeoutMs: 2000 });
  assert.equal(first.outcome, 'clarification'); room.acknowledge(first.receivedResponseIds);
  await room.respond(asked.node.id, { kind: 'team_reply', body: 'Here is the cost breakdown.' });
  const next = await room.wait(asked.node.id, { timeoutMs: 20 });
  assert.equal(next.outcome, 'timeout');
  assert.equal((await client.read(asked.node.id)).node.status, 'outstanding');
  assert.notEqual(next.response?.id, clarification.responseId);
});

test('a wait receipt acknowledged during a delayed event read cannot reenter the unconfirmed queue', { timeout: 10000 }, async (t) => {
  const { client } = await service(t); const gate = deferred(), entered = deferred(), delivered = [];
  const asked = await client.publish({ question: 'Acknowledge before SSE read completes?' });
  const saved = await client.respond(asked.node.id, { body: 'Only one receipt.', author: human });
  const events = await client.request('/api/events?after=0');
  const event = events.events.find((candidate) => candidate.payload.responseId === saved.responseId);
  const room = participant(t, client, { state: { watches: [asked.node.id], cursor: event.sequence - 1 },
    deliver: (receipt) => delivered.push(receipt) });
  const original = client.read.bind(client);
  client.read = async (id, options) => { if (id === saved.responseId) { entered.resolve(); await gate.promise; } return original(id, options); };
  const consuming = room.consume(event, new AbortController().signal);
  await entered.promise;
  const result = await room.wait(asked.node.id, { timeoutMs: 2000 });
  assert.equal(result.response.id, saved.responseId); room.acknowledge(result.receivedResponseIds);
  gate.resolve(); await consuming;
  assert.equal(room.pending.size, 0); assert.equal(room.snapshot().cursor, event.sequence);
  assert.equal(delivered.length, 0);
});
