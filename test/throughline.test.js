import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ThreadStore } from '../src/store.js';
import { createThreadroomServer } from '../src/server.js';

async function runningService(database) {
  const store = new ThreadStore(database);
  const server = createThreadroomServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    store,
    server,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    }
  };
}

async function request(service, path, options = {}) {
  const response = await fetch(`${service.url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return { status: response.status, result };
}

test('a client publishes two questions, answers one idempotently, and recovers the thread after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-'));
  const database = join(directory, 'records.sqlite');
  let service = await runningService(database);
  try {
    const published = await request(service, '/api/threads', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Creature movement review',
        project: 'MistFall',
        summary: 'A real consumer-boundary example',
        author: { name: 'Mara', role: 'Artist' },
        questions: [
          {
            prompt: 'Which movement direction reads best?',
            presentation: {
              kind: 'comparison-v1', revision: 'movement-r1',
              options: [{ id: 'float', label: 'Float', image: '/assets/mist-drift.svg' }]
            }
          },
          { prompt: 'Should the trail linger?', presentation: { kind: 'text-v1', revision: 'trail-r1' } }
        ]
      })
    });
    assert.equal(published.status, 201);
    const thread = published.result.thread;
    assert.equal(thread.counts.outstanding, 2);
    const [movement, trail] = thread.questions;

    const responseBody = JSON.stringify({
      kind: 'answer', body: 'Float, but keep a hint of the low posture.',
      selections: [{ id: 'float', label: 'Float' }], author: { name: 'Scott' }
    });
    const firstAnswer = await request(service, `/api/questions/${movement.id}/responses`, {
      method: 'POST', headers: { 'Idempotency-Key': 'answer-attempt-1' }, body: responseBody
    });
    const retriedAnswer = await request(service, `/api/questions/${movement.id}/responses`, {
      method: 'POST', headers: { 'Idempotency-Key': 'answer-attempt-1' }, body: responseBody
    });
    assert.equal(firstAnswer.status, 201);
    assert.equal(retriedAnswer.status, 200);
    assert.equal(retriedAnswer.result.deduplicated, true);
    assert.equal(retriedAnswer.result.responseId, firstAnswer.result.responseId);
    assert.equal(retriedAnswer.result.thread.counts.outstanding, 1);
    assert.equal(retriedAnswer.result.thread.questions.find(({ id }) => id === trail.id).status, 'outstanding');

    await service.close();
    service = await runningService(database);
    const recovered = await request(service, `/api/threads/${thread.id}`);
    const recoveredMovement = recovered.result.thread.questions.find(({ id }) => id === movement.id);
    assert.equal(recoveredMovement.presentation.revision, 'movement-r1');
    assert.equal(recoveredMovement.presentation.options[0].label, 'Float');
    assert.equal(recoveredMovement.responses.length, 1);
    assert.equal(recoveredMovement.responses[0].body, 'Float, but keep a hint of the low posture.');
    assert.equal(recovered.result.thread.counts.outstanding, 1);

    const events = await request(service, '/api/events?after=0');
    assert.deepEqual(events.result.events.map(({ type }) => type), ['thread.created', 'response.created']);
  } finally {
    if (service.server.listening) await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ask-back, team clarification, and deferral retain distinct responsibilities in one thread', async () => {
  const service = await runningService(':memory:');
  try {
    const { result: { thread } } = await request(service, '/api/threads', {
      method: 'POST', body: JSON.stringify({
        title: 'Direction and cost', project: 'MistFall',
        questions: [{ prompt: 'Which direction?' }, { prompt: 'What budget should we use?' }]
      })
    });
    const [direction, cost] = thread.questions;
    const clarification = await request(service, `/api/questions/${direction.id}/responses`, {
      method: 'POST', headers: { 'Idempotency-Key': 'clarification-1' },
      body: JSON.stringify({ kind: 'clarification', body: 'Show me the motion before I choose.' })
    });
    assert.equal(clarification.result.thread.counts.waitingOnTeam, 1);
    assert.equal(clarification.result.thread.counts.outstanding, 1);

    const deferred = await request(service, `/api/questions/${cost.id}/responses`, {
      method: 'POST', body: JSON.stringify({ kind: 'defer', body: 'Revisit after the motion pass.' })
    });
    assert.equal(deferred.result.thread.counts.waitingOnTeam, 1);
    assert.equal(deferred.result.thread.counts.deferred, 1);
    assert.equal(deferred.result.thread.counts.outstanding, 0);

    const teamReply = await request(service, `/api/questions/${direction.id}/responses`, {
      method: 'POST', body: JSON.stringify({ kind: 'team_reply', body: 'Here is the movement breakdown. Ready for your direction choice.', author: { name: 'Mara' } })
    });
    assert.equal(teamReply.result.thread.counts.waitingOnTeam, 0);
    assert.equal(teamReply.result.thread.counts.outstanding, 1);
    assert.equal(teamReply.result.thread.counts.deferred, 1);
    assert.equal(teamReply.result.thread.questions[0].responses.length, 2);
    assert.equal(teamReply.result.thread.questions[0].responses[0].body, 'Show me the motion before I choose.');

    const wrongKeyUse = await fetch(`${service.url}/api/questions/${cost.id}/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'clarification-1' },
      body: JSON.stringify({ kind: 'answer', body: 'A different answer must not recover an unrelated receipt.' })
    });
    assert.equal(wrongKeyUse.status, 409);

    const crossOrigin = await fetch(`${service.url}/api/questions/${direction.id}/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
      body: JSON.stringify({ kind: 'answer', body: 'This browser write is not authorized by its origin.' })
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await service.close();
  }
});
