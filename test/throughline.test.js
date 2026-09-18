import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ThreadStore } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createWebsiteHandler } from '../src/site.js';
import { createThreadroomServer } from '../src/server.js';
import { ThreadroomClient } from '../public/client.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function runningService(database, options = {}) {
  const store = new ThreadStore(database);
  const server = createThreadroomServer(store, options);
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

async function nextStreamEvent(reader) {
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('Event stream closed before an event');
    buffer += new TextDecoder().decode(value);
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const block of blocks) {
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
    }
  }
}

test('one deep question call can block on a live answer, and that answer can own deeper threads', async () => {
  const service = await runningService(':memory:');
  const controller = new AbortController();
  try {
    const stream = await fetch(`${service.url}/api/stream?after=0`, { signal: controller.signal });
    assert.equal(stream.headers.get('content-type').split(';')[0], 'text/event-stream');
    const reader = stream.body.getReader();
    const path = ['MistFall', ...Array.from({ length: 24 }, (_, index) => `Nested discussion ${index + 1}`)];
    const question = { path, question: 'How should the deepest movement study feel?', choices: ['Quiet', 'Restless'], multiple: true };
    const waiting = request(service, '/api/ask', {
      method: 'POST', headers: { 'Idempotency-Key': 'deep-ask-1' },
      body: JSON.stringify({ ...question, wait: { timeoutMs: 2000 } })
    });
    const publishedEvent = await nextStreamEvent(reader);
    assert.equal(publishedEvent.type, 'node.created');
    const questionId = publishedEvent.payload.nodeId;
    const published = await request(service, `/api/nodes/${questionId}`);
    assert.equal(published.result.ancestors.length, path.length);
    assert.equal(published.result.node.status, 'outstanding');

    const answer = await request(service, `/api/nodes/${questionId}/respond`, {
      method: 'POST', headers: { 'Idempotency-Key': 'deep-answer-1' },
      body: JSON.stringify({ kind: 'answer', body: 'Quiet with restless edges.', selections: [{ id: 'mix', label: 'Quiet + Restless', value: ['Quiet', 'Restless'] }], author: { name: 'Scott' } })
    });
    const received = await waiting;
    assert.equal(received.result.outcome, 'answer');
    assert.equal(received.result.response.id, answer.result.node.id);
    assert.equal(received.result.response.body, 'Quiet with restless edges.');
    assert.equal(received.result.timedOut, false);

    const branch = await request(service, '/api/nodes', {
      method: 'POST', body: JSON.stringify({ parentId: answer.result.node.id, question: 'Can we apply that to the tail motion too?' })
    });
    assert.equal(branch.result.node.parentId, answer.result.node.id);
    assert.equal(branch.result.ancestors.at(-1).id, answer.result.node.id);
    assert.ok(!Object.hasOwn(branch.result.ancestors.at(-1), 'kind'));
    assert.equal(branch.result.ancestors.length, path.length + 2);
    assert.equal(branch.result.node.status, 'outstanding');

    const retried = await request(service, '/api/nodes', {
      method: 'POST', headers: { 'Idempotency-Key': 'deep-ask-1' }, body: JSON.stringify(question)
    });
    assert.equal(retried.result.node.id, questionId);
    assert.equal(retried.result.deduplicated, true);
    const replay = await request(service, `/api/events?after=${publishedEvent.sequence}`);
    assert.deepEqual(replay.result.events.map(({ type }) => type), ['response.created', 'node.created']);
    reader.releaseLock();
  } finally {
    controller.abort();
    await service.close();
  }
});

test('timing out a blocking ask leaves its question available for a later response', async () => {
  const service = await runningService(':memory:');
  try {
    const pending = await request(service, '/api/ask', {
      method: 'POST', body: JSON.stringify({ path: ['Later'], question: 'Still here after a timeout?', wait: { timeoutMs: 20 } })
    });
    assert.equal(pending.result.outcome, 'pending');
    assert.equal(pending.result.timedOut, true);
    const id = pending.result.published.node.id;
    const saved = await request(service, `/api/nodes/${id}`);
    assert.equal(saved.result.node.status, 'outstanding');
    const later = await request(service, `/api/nodes/${id}/respond`, {
      method: 'POST', body: JSON.stringify({ kind: 'answer', body: 'Yes, answered later.' })
    });
    assert.equal(later.result.node.body, 'Yes, answered later.');
  } finally { await service.close(); }
});

test('upgrading the initial spike preserves original IDs, presentation meaning, and response retry receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-upgrade-'));
  const database = join(directory, 'records.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE threads (id TEXT, title TEXT, project TEXT, summary TEXT, author_name TEXT, author_role TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE questions (id TEXT, thread_id TEXT, prompt TEXT, context TEXT, presentation_kind TEXT, presentation_revision TEXT, presentation_json TEXT, status TEXT, created_at TEXT);
    CREATE TABLE responses (id TEXT, thread_id TEXT, question_id TEXT, kind TEXT, body TEXT, selections_json TEXT, presentation_revision TEXT, author_name TEXT, idempotency_key TEXT, created_at TEXT);
    INSERT INTO threads VALUES ('thr_original','Creature review','MistFall','Original spike record','Mara','Artist','2026-09-17T00:00:00Z','2026-09-17T00:01:00Z');
    INSERT INTO questions VALUES ('q_original','thr_original','Which silhouette?','','text-v1','original-r1','{"choices":["A","B"]}','answered','2026-09-17T00:00:00Z');
    INSERT INTO responses VALUES ('rsp_original','thr_original','q_original','answer','B, keep the wider posture.','[{"id":"b","label":"B"}]','original-r1','Scott','original-answer-key','2026-09-17T00:01:00Z');
  `);
  legacy.close();
  const service = await runningService(database);
  try {
    const recovered = await request(service, '/api/nodes/q_original');
    assert.deepEqual(recovered.result.ancestors.map(({ title }) => title), ['MistFall', 'Creature review']);
    assert.equal(recovered.result.node.presentation.revision, 'original-r1');
    const retry = await request(service, '/api/questions/q_original/responses', {
      method: 'POST', headers: { 'Idempotency-Key': 'original-answer-key' },
      body: JSON.stringify({ kind: 'answer', body: 'B, keep the wider posture.', selections: [{ id: 'b', label: 'B' }], author: { name: 'Scott' } })
    });
    assert.equal(retry.result.responseId, 'rsp_original');
    assert.equal(retry.result.deduplicated, true);
    assert.equal(retry.result.thread.questions[0].responses.length, 1);
    assert.equal(retry.result.thread.questions[0].responses[0].presentationRevision, 'original-r1');
  } finally {
    await service.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('an independently hosted UI uses the API and authored question/answer records without database access', async () => {
  let website;
  const ui = createServer((req, res) => website(req, res));
  ui.listen(0, '127.0.0.1'); await once(ui, 'listening');
  const uiUrl = `http://127.0.0.1:${ui.address().port}`;
  const service = await runningService(':memory:', { allowedOrigins: [uiUrl] });
  website = createWebsiteHandler({ apiBaseUrl: service.url });
  try {
    const apiRoot = await fetch(service.url);
    assert.equal(apiRoot.status, 404);
    const page = await fetch(uiUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Threadroom<\/title>/);
    const configuration = await fetch(`${uiUrl}/threadroom-config.json`).then((response) => response.json());
    assert.equal(configuration.apiBaseUrl, service.url);

    const published = await request(service, '/api/nodes', {
      method: 'POST', headers: { Origin: uiUrl }, body: JSON.stringify({
        path: ['MistFall', 'Experiments'], question: 'Try this authored interaction?',
        html: '<h1>A custom scene</h1><canvas id="art"></canvas><script>window.Threadroom.propose({motion:"float"},"Float motion");</script>',
        fallback: 'A procedural motion study. The proposed response is Float motion.'
      })
    });
    const questionId = published.result.node.id;
    const document = await fetch(`${service.url}/api/nodes/${questionId}/presentation`);
    assert.match(document.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(await document.text(), /A custom scene/);
    const answer = await request(service, `/api/nodes/${questionId}/respond`, {
      method: 'POST', headers: { Origin: uiUrl }, body: JSON.stringify({ kind: 'answer', body: 'Here is an alternate scene.',
        presentation: { kind: 'html-v1', html: '<h2>My alternate composition</h2>', fallback: 'Alternate composition with a lower horizon.' } })
    });
    const answerRead = await request(service, `/api/nodes/${answer.result.node.id}`);
    assert.equal(answerRead.result.node.presentation.html, '<h2>My alternate composition</h2>');
    assert.equal(answerRead.result.node.presentation.fallback, 'Alternate composition with a lower horizon.');
    assert.equal(answerRead.result.node.parentId, questionId);
  } finally {
    await new Promise((resolve) => ui.close(resolve)); await service.close();
  }
});

test('a publish retry recovers its captured visual presentation even after the source image disappears', async () => {
  const filename = `retry-${Date.now()}.svg`;
  const source = new URL(`../public/assets/${filename}`, import.meta.url);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Original captured study</title></svg>';
  const service = await runningService(':memory:');
  try {
    await writeFile(source, svg);
    const input = JSON.stringify({ path: ['Visual history'], question: 'Which study?', presentation: {
      kind: 'comparison-v1', revision: 'captured-r1', options: [{ id: 'a', label: 'Original', image: `/assets/${filename}` }]
    }});
    const first = await request(service, '/api/nodes', { method: 'POST', headers: { 'Idempotency-Key': 'captured-study-1' }, body: input });
    await rm(source);
    const retry = await request(service, '/api/nodes', { method: 'POST', headers: { 'Idempotency-Key': 'captured-study-1' }, body: input });
    assert.equal(retry.result.deduplicated, true);
    assert.equal(retry.result.node.id, first.result.node.id);
    const image = retry.result.node.presentation.options[0].image;
    assert.match(image, /^data:image\/svg\+xml;base64,/);
    assert.equal(Buffer.from(image.split(',')[1], 'base64').toString(), svg);
  } finally { await rm(source, { force: true }); await service.close(); }
});


test('top placement, saved response context, and answer requests use one node shape', async () => {
  const service = await runningService(':memory:');
  try {
    const { result: top } = await request(service, '/api/nodes', {
      method: 'POST', body: JSON.stringify({ title: 'What motion works?', expectsAnswer: true })
    });
    const payload = { title: 'Which edge should we try next?', body: 'Keep the quiet center.', expectsAnswer: true };
    const { result: reply } = await request(service, `/api/nodes/${top.node.id}/respond`, {
      method: 'POST', headers: { 'Idempotency-Key': 'mixed-node-reply' }, body: JSON.stringify(payload)
    });
    const { result: note } = await request(service, '/api/nodes', {
      method: 'POST', body: JSON.stringify({ parentId: reply.node.id, title: 'Implementation notes', body: 'Try a softer tail.' })
    });
    assert.equal(top.node.parentId, null);
    assert.equal(reply.node.parentId, top.node.id);
    assert.equal(reply.node.response.targetId, top.node.id);
    assert.equal(reply.node.expectsAnswer, true);
    assert.equal(reply.node.status, 'outstanding');
    assert.equal(note.node.parentId, reply.node.id);
    assert.equal(note.node.expectsAnswer, false);
    for (const node of [top.node, reply.node, note.node]) {
      assert.ok(!Object.hasOwn(node, 'kind'));
      assert.deepEqual(Object.keys(node).sort(), Object.keys(top.node).sort());
    }
    const saved = await request(service, `/api/nodes/${top.node.id}`);
    assert.equal(saved.result.node.status, 'answered');
    assert.equal(saved.result.counts.nodes, 3);
    assert.equal(saved.result.counts.requests, 2);
    assert.equal(saved.result.counts.outstanding, 1);
    const tree = await request(service, '/api/tree');
    assert.equal(tree.result.nodes.length, 3);
    assert.ok(tree.result.nodes.every(node => !Object.hasOwn(node, 'kind')));
    const unchanged = await request(service, `/api/nodes/${top.node.id}/respond`, {
      method: 'POST', headers: { 'Idempotency-Key': 'mixed-node-reply' }, body: JSON.stringify(payload)
    });
    assert.equal(unchanged.result.node.id, reply.node.id);
    const titleChanged = await fetch(`${service.url}/api/nodes/${top.node.id}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'mixed-node-reply' },
      body: JSON.stringify({ ...payload, title: 'A different next question' })
    });
    assert.equal(titleChanged.status, 409);
    const countsAfterConflict = await request(service, `/api/nodes/${top.node.id}`);
    assert.equal(countsAfterConflict.result.counts.nodes, 3);
  } finally { await service.close(); }
});

test('removing second-spike node kinds preserves history and original publish/response retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-untyped-'));
  const database = join(directory, 'records.sqlite');
  const legacy = new DatabaseSync(database);
  // Frozen second-spike serialization, before node kinds were removed.
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const publish = { path: ['Old MistFall'], question: 'Which shape?', choices: ['A', 'B'], author: { name: 'Mara' } };
  const publishHash = hash({ kind: 'question', title: 'Which shape?', body: '', path: publish.path, parentId: null,
    author: publish.author, presentation: { kind: 'text-v1', choices: ['A', 'B'], multiple: false } });
  const answer = { kind: 'answer', body: 'B', selections: [], author: { name: 'Scott' } };
  const responseHash = hash({ nodeId: 'q_kind', ...answer, presentation: null });
  legacy.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, parent_id TEXT REFERENCES nodes(id), kind TEXT NOT NULL DEFAULT 'thread', title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', author_json TEXT NOT NULL, status TEXT, presentation_json TEXT, response_json TEXT,
    idempotency_key TEXT UNIQUE, request_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  const insert = legacy.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const timestamp = '2026-09-17T00:00:00Z';
  insert.run('thr_kind', null, 'thread', 'Old MistFall', '', JSON.stringify({ name: 'Mara' }), null, null, null, null, null, timestamp, timestamp);
  insert.run('q_kind', 'thr_kind', 'question', 'Which shape?', '', JSON.stringify({ name: 'Mara' }), 'answered',
    JSON.stringify({ kind: 'text-v1', choices: ['A', 'B'], multiple: false, revision: 'old-r1' }), null,
    'kind-publish-key', publishHash, timestamp, timestamp);
  insert.run('rsp_kind', 'q_kind', 'response', 'B', 'B', JSON.stringify({ name: 'Scott' }), null, null,
    JSON.stringify({ kind: 'answer', selections: [], presentationRevision: 'old-r1', targetId: 'q_kind' }),
    'kind-answer-key', responseHash, timestamp, timestamp);
  legacy.close();
  let service = await runningService(database);
  try {
    const restored = await request(service, '/api/nodes/q_kind');
    assert.equal(restored.result.node.expectsAnswer, true);
    assert.equal(restored.result.node.status, 'answered');
    assert.equal(restored.result.node.presentation.revision, 'old-r1');
    assert.equal(restored.result.children[0].id, 'rsp_kind');
    assert.equal(restored.result.children[0].response.targetId, 'q_kind');
    const retried = await request(service, '/api/nodes', {
      method: 'POST', headers: { 'Idempotency-Key': 'kind-publish-key' }, body: JSON.stringify(publish)
    });
    assert.equal(retried.result.node.id, 'q_kind');
    assert.equal(retried.result.deduplicated, true);
    const { question, ...explicit } = publish;
    const explicitRetry = await request(service, '/api/nodes', {
      method: 'POST', headers: { 'Idempotency-Key': 'kind-publish-key' },
      body: JSON.stringify({ ...explicit, kind: 'question', title: question })
    });
    assert.equal(explicitRetry.result.node.id, 'q_kind');
    assert.equal(explicitRetry.result.deduplicated, true);
    const replied = await request(service, '/api/nodes/q_kind/respond', {
      method: 'POST', headers: { 'Idempotency-Key': 'kind-answer-key' }, body: JSON.stringify(answer)
    });
    assert.equal(replied.result.node.id, 'rsp_kind');
    assert.equal(replied.result.deduplicated, true);
    await service.close(); service = await runningService(database);
    const tree = await request(service, '/api/tree');
    assert.equal(tree.result.nodes.length, 3);
    assert.ok(tree.result.nodes.every(node => !Object.hasOwn(node, 'kind')));
    assert.deepEqual(tree.result.nodes.map(node => node.id), ['thr_kind', 'q_kind', 'rsp_kind']);
  } finally {
    if (service.server.listening) await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('ordinary client asks in a named project and replies without describing a tree or node types', async () => {
  const service = await runningService(':memory:');
  const client = new ThreadroomClient(service.url);
  try {
    const input = { project: 'MistFall', question: 'Which direction?', choices: ['Wide', 'Narrow'] };
    const question = await client.ask(input, 'ordinary-project-ask');
    assert.deepEqual(question.ancestors.map(node => node.title), ['MistFall']);
    assert.equal(question.node.parentId, question.ancestors[0].id);
    assert.equal(question.node.status, 'outstanding');
    const reply = await client.reply(question.node.id, { body: 'Keep the wide silhouette.' });
    assert.equal(reply.node.parentId, question.node.id);
    const discussion = await client.ask({ parentId: reply.node.id, question: 'Should its tail keep that width?' });
    assert.equal(discussion.node.parentId, reply.node.id);
    const reloaded = await client.read(question.node.id);
    assert.equal(reloaded.children[0].body, 'Keep the wide silhouette.');
    const retry = await client.ask(input, 'ordinary-project-ask');
    assert.equal(retry.node.id, question.node.id);
    await assert.rejects(client.ask({ ...input, project: 'Another project' }, 'ordinary-project-ask'), /different content/);
    const nested = await client.ask({ project: 'MistFall', thread: 'Movement', question: 'Should the trail linger?' });
    assert.deepEqual(nested.ancestors.map(node => node.title), ['MistFall', 'Movement']);
    assert.ok(nested.ancestors.every(node => !Object.hasOwn(node, 'kind')));
    const tree = await client.tree();
    assert.ok(!tree.nodes.some(node => node.title === 'Another project'));
  } finally { await service.close(); }
});


test('caller correlation and watch event identities survive restart and idempotent replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-watch-contract-'));
  const database = join(directory, 'records.sqlite');
  let service = await runningService(database);
  const author = { name: 'Builder', id: 'agent-builder-01', sessionId: 'pi-session-alpha' };
  const responder = { name: 'Reviewer demo', id: 'human-demo-01', sessionId: 'browser-demo' };
  const ask = { project: 'Handoff', thread: 'Experiments', question: 'Which edge feels right?', author };
  const reply = { body: 'Keep the restless edges.', author: responder };
  try {
    const published = await request(service, '/api/ask', {
      method: 'POST', headers: { 'Idempotency-Key': 'watch-contract-ask' }, body: JSON.stringify(ask)
    });
    const question = published.result.node;
    const answered = await request(service, `/api/nodes/${question.id}/respond`, {
      method: 'POST', headers: { 'Idempotency-Key': 'watch-contract-reply' }, body: JSON.stringify(reply)
    });
    const events = (await request(service, '/api/events?after=0')).result.events;
    assert.deepEqual(events.map(event => event.type), ['node.created', 'response.created']);
    assert.equal(events[0].payload.nodeId, question.id);
    assert.equal(events[0].payload.parentId, question.parentId);
    assert.equal(events[1].payload.questionId, question.id);
    assert.equal(events[1].payload.responseId, answered.result.node.id);
    assert.equal(events[1].payload.kind, 'answer');
    await service.close(); service = await runningService(database);
    const recovered = (await request(service, `/api/nodes/${question.id}`)).result;
    assert.deepEqual(recovered.node.author, author);
    assert.ok(recovered.ancestors.every(node => JSON.stringify(node.author) === JSON.stringify(author)));
    assert.deepEqual(recovered.children[0].author, responder);
    const tree = (await request(service, '/api/tree')).result.nodes;
    assert.deepEqual(tree.find(node => node.id === question.id).author, author);
    await request(service, '/api/ask', {
      method: 'POST', headers: { 'Idempotency-Key': 'watch-contract-ask' }, body: JSON.stringify(ask)
    });
    await request(service, `/api/nodes/${question.id}/respond`, {
      method: 'POST', headers: { 'Idempotency-Key': 'watch-contract-reply' }, body: JSON.stringify(reply)
    });
    const replay = (await request(service, '/api/events?after=0')).result.events;
    assert.deepEqual(replay, events);
    const tail = (await request(service, `/api/events?after=${events[0].sequence}`)).result.events;
    assert.deepEqual(tail, [events[1]]);
  } finally {
    if (service.server.listening) await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('the interaction playground publishes reproducible rich requests and three actually nested questions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-playground-'));
  const database = join(directory, 'records.sqlite');
  let service = await runningService(database);
  const run = () => promisify(execFile)(process.execPath, ['examples/playground/publish.js'], {
    env: { ...process.env, THREADROOM_API_URL: service.url, THREADROOM_UI_URL: service.url }, timeout: 10000
  }).then(({stdout}) => JSON.parse(stdout));
  try {
    const first = await run();
    assert.equal(first.questions.length, 8);
    assert.deepEqual(await run(), first);
    const nodes = (await request(service, '/api/tree')).result.nodes;
    assert.equal(nodes.length, 9);
    assert.equal(nodes.filter(node => node.status === 'outstanding').length, 8);
    let parentId = first.root.id;
    for (const question of first.questions.filter(q => q.slug.startsWith('nested-'))) {
      const read = (await request(service, `/api/nodes/${question.id}`)).result;
      assert.equal(read.node.parentId, parentId);
      parentId = question.id;
    }
    const pictures = first.questions.find(q => q.slug === 'images');
    const before = (await request(service, `/api/nodes/${pictures.id}`)).result.node.presentation;
    await service.close(); service = await runningService(database);
    const after = (await request(service, `/api/nodes/${pictures.id}`)).result.node.presentation;
    assert.deepEqual(after, before);
    const multi = (await request(service, `/api/nodes/${first.questions.find(q=>q.slug==='multiple').id}`)).result.node;
    assert.equal(multi.presentation.multiple, true);
    assert.ok(multi.presentation.choices.includes('Drawing an answer'));
  } finally {
    if (service.server.listening) await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
