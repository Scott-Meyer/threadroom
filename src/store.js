import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const now = () => new Date().toISOString();
const parse = (value, fallback = null) => value ? JSON.parse(value) : fallback;
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assetsDir = fileURLToPath(new URL('../public/assets/', import.meta.url));

// One node primitive. Requests, response context, and authored content are independent capabilities.
export class ThreadStore {
  constructor(filename) {
    this.changes = new EventEmitter();
    this.changes.setMaxListeners(0);
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES nodes(id),
        expects_answer INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        author_json TEXT NOT NULL,
        status TEXT,
        presentation_json TEXT,
        response_json TEXT,
        idempotency_key TEXT UNIQUE,
        request_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nodes_parent_idx ON nodes(parent_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.#migrateNodeKinds();
    this.#migrateLegacy();
  }

  close() { this.db.close(); }

  listNodes() {
    return this.db.prepare('SELECT * FROM nodes ORDER BY created_at, rowid').all().map((row) => this.#node(row));
  }

  getNode(nodeId) {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!row) throw new NotFoundError('node not found');
    const node = this.#node(row);
    const ancestors = [];
    let parentId = row.parent_id;
    while (parentId) {
      const parent = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(parentId);
      if (!parent) break;
      // Navigation context stays bounded: don't echo every ancestor's HTML/images back to a publisher.
      ancestors.unshift({ id: parent.id, parentId: parent.parent_id, title: parent.title,
        author: parse(parent.author_json, {}), expectsAnswer: !!parent.expects_answer, status: parent.status });
      parentId = parent.parent_id;
    }
    const children = this.db.prepare('SELECT * FROM nodes WHERE parent_id = ? ORDER BY created_at, rowid').all(nodeId).map((child) => this.#node(child));
    return { node, ancestors, children, counts: this.#counts(nodeId), url: `/threads/${nodeId}` };
  }

  createNode(input, key) {
    const normalized = this.#normalizeInput(input);
    const requestHash = fingerprint(normalized);
    // Previously published receipts survive the removal of the structural kind field.
    const { expectsAnswer, ...content } = normalized;
    const oldHashes = (expectsAnswer ? ['question'] : ['thread', 'note'])
      .map((kind) => fingerprint({ kind, ...content }));
    const existing = this.#existing(key, requestHash, ...oldHashes);
    if (existing) return { ...this.getNode(existing.id), createdAncestorIds: [], deduplicated: true };
    let createdAncestorIds = [];
    let id;
    this.#atomic(() => {
      let parentId = normalized.parentId || null;
      if (normalized.path) {
        const resolved = this.#resolvePath(normalized.path, normalized.author);
        parentId = resolved.parentId;
        createdAncestorIds = resolved.createdIds;
      }
      if (parentId) this.#require(parentId);
      id = this.#insert({ ...normalized, presentation: normalized.presentation ? this.#presentation(normalized.presentation) : null, parentId, key, requestHash });
      this.#event('node.created', id, { nodeId: id, parentId, createdAncestorIds });
    });
    return { ...this.getNode(id), createdAncestorIds, deduplicated: false };
  }

  respond(nodeId, input, key) {
    const target = this.#require(nodeId);
    const kind = input.kind || 'answer';
    if (!['answer', 'clarification', 'defer', 'reject', 'team_reply'].includes(kind)) throw new InputError('invalid response kind');
    const body = text(input.body, 'body', false);
    const selections = Array.isArray(input.selections) ? input.selections : [];
    if (kind !== 'defer' && !body && selections.length === 0 && !input.presentation) throw new InputError('a response needs feedback, a selection, or an authored presentation');
    if (['clarification', 'reject', 'team_reply'].includes(kind) && !body) throw new InputError(`${kind} needs written context`);
    const author = input.author || { name: kind === 'team_reply' ? 'AI teammate' : 'Scott' };
    const expectsAnswer = answerRequest(input);
    const requestedTitle = text(input.title, 'title', false);
    const title = requestedTitle || body.split('\n')[0].slice(0, 100) || selections.map((selection) => selection.label || selection.id).join(', ') || (kind === 'defer' ? 'Deferred for later' : 'Authored response');
    const content = { nodeId, kind, body, selections, author, presentation: input.presentation || null };
    const normalized = { ...content, expectsAnswer, title };
    const existing = this.#existing(key, fingerprint(normalized), fingerprint(content),
      !expectsAnswer ? `legacy:${fingerprint({ nodeId, kind, body, selections })}` : null);
    if (existing) {
      if (!!existing.expects_answer !== expectsAnswer || (requestedTitle && existing.title !== title)) throw new ConflictError('Idempotency-Key was already used for different content');
      return { ...this.getNode(existing.id), responseId: existing.id, deduplicated: true, target: this.#node(this.#require(nodeId)) };
    }
    if (kind === 'team_reply' && target.status !== 'waiting_on_team') throw new InputError('team_reply targets a question waiting on the team');
    const nextStatus = { answer: 'answered', clarification: 'waiting_on_team', defer: 'deferred', reject: 'rejected', team_reply: 'outstanding' }[kind];
    const revision = parse(target.presentation_json)?.revision || null;
    let responseId;
    this.#atomic(() => {
      responseId = this.#insert({
        parentId: nodeId, expectsAnswer,
        title, body, author, presentation: input.presentation ? this.#presentation(input.presentation) : null,
        response: { kind, selections, presentationRevision: revision, targetId: nodeId },
        key, requestHash: fingerprint(normalized)
      });
      if (target.expects_answer) this.db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, now(), nodeId);
      this.#event('response.created', this.#legacyThreadId(nodeId), { nodeId: responseId, parentId: nodeId, threadId: this.#legacyThreadId(nodeId), questionId: nodeId, responseId, kind, questionStatus: target.expects_answer ? nextStatus : null });
    });
    return { ...this.getNode(responseId), responseId, deduplicated: false, target: this.#node(this.#require(nodeId)) };
  }

  // First-spike adapters use the same authority. No project/question hierarchy is imposed on nodes.
  createThread(input) {
    const title = text(input.title, 'title');
    const project = text(input.project, 'project');
    const questions = input.questions?.length ? input.questions : [input.question];
    for (const question of questions) text(question?.prompt, 'question prompt');
    let id;
    this.#atomic(() => {
      const { parentId } = this.#resolvePath([project], input.author);
      id = this.#insert({ id: input.id, title, parentId, body: input.summary || '', author: input.author });
      const questionIds = questions.map((question) => this.#insert({
        id: question.id, parentId: id, expectsAnswer: true, title: question.prompt, body: question.context || '',
        author: input.author, presentation: this.#presentation(question.presentation || {})
      }));
      this.#event('thread.created', id, { threadId: id, questionIds });
    });
    return this.getThread(id);
  }

  addQuestion(threadId, input) {
    this.#require(threadId);
    text(input.prompt, 'prompt');
    this.#atomic(() => {
      const id = this.#insert({ id: input.id, parentId: threadId, expectsAnswer: true, title: input.prompt,
        body: input.context || '', author: this.getNode(threadId).node.author, presentation: this.#presentation(input.presentation || {}) });
      this.#event('question.created', threadId, { threadId, questionId: id });
    });
    return this.getThread(threadId);
  }

  addResponse(questionId, input, key) {
    const result = this.respond(questionId, input, key);
    return { thread: this.getThread(this.#legacyThreadId(questionId)), responseId: result.responseId, deduplicated: result.deduplicated };
  }

  getThread(threadId) {
    const { node, ancestors, children } = this.getNode(threadId);
    const questions = children.filter((child) => child.expectsAnswer).map((question) => ({
      id: question.id, prompt: question.title, context: question.body, status: question.status,
      presentation: question.presentation, createdAt: question.createdAt,
      responses: this.getNode(question.id).children.filter((child) => child.response).map((response) => ({
        id: response.id, questionId: question.id, kind: response.response.kind, body: response.body,
        selections: response.response.selections, presentationRevision: response.response.presentationRevision,
        author: response.author, createdAt: response.createdAt
      }))
    }));
    const counts = this.#counts(threadId);
    return { id: node.id, title: node.title, project: ancestors[0]?.title || node.title, summary: node.body,
      author: node.author, createdAt: node.createdAt, updatedAt: node.updatedAt,
      counts: { ...counts, questions: counts.requests }, questions };
  }

  listThreads(view = 'history') {
    const items = this.listNodes().filter((node) => node.parentId && !node.expectsAnswer && !node.response).map((node) => {
      const result = this.getThread(node.id);
      return { ...result, latestPrompt: result.questions.at(-1)?.prompt || node.body, questions: undefined };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (view === 'needs-answer') return items.filter((item) => item.counts.outstanding > 0);
    if (view === 'waiting-on-team') return items.filter((item) => item.counts.waitingOnTeam > 0);
    if (view === 'deferred') return items.filter((item) => item.counts.deferred > 0);
    return items;
  }

  listEvents(after = 0, threadId = null) {
    const rows = threadId
      ? this.db.prepare('SELECT * FROM events WHERE sequence > ? AND thread_id = ? ORDER BY sequence LIMIT 100').all(after, threadId)
      : this.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT 100').all(after);
    return rows.map((row) => ({ sequence: row.sequence, id: row.id, type: row.type, threadId: row.thread_id, payload: parse(row.payload_json, {}), createdAt: row.created_at }));
  }

  seedDemo() {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM nodes').get();
    if (count > 0) return;
    this.createThread({
      id: 'thr_mist-creature',
      title: 'Mist creature — visual direction',
      project: 'MistFall',
      summary: 'Choosing a readable silhouette before the next movement pass.',
      author: { name: 'Mara (demo)', role: 'Visual storyteller' },
      questions: [{
        id: 'q_silhouette',
        prompt: 'Which silhouette should anchor the creature’s next pass?',
        context: 'I explored three ways the mist can feel alive at gameplay distance. The choice here is about posture and motion language, not final color.',
        presentation: {
          kind: 'comparison-v1', revision: 'silhouettes-r1', eyebrow: 'Direction review · Revision 1',
          options: [
            { id: 'drift', label: 'A · The Drift', detail: 'Quiet, vertical, almost ceremonial. Cloth-like wake.', image: '/assets/mist-drift.svg', alt: 'Tall narrow mist creature silhouette with a long flowing wake' },
            { id: 'prowler', label: 'B · The Prowler', detail: 'Low center of gravity. Reads as alert and predatory.', image: '/assets/mist-prowler.svg', alt: 'Wide crouched mist creature silhouette with forward-reaching limbs' },
            { id: 'bloom', label: 'C · The Bloom', detail: 'Unstable radial shape. Beautiful, stranger, less readable.', image: '/assets/mist-bloom.svg', alt: 'Radial mist creature silhouette opening like a many-petaled flower' }
          ]
        }
      }]
    });
    const design = this.createThread({
      id: 'thr-fog-arrival',
      title: 'When should the valley fog arrive?',
      project: 'MistFall',
      summary: 'A small pacing decision with one resolved question and one follow-up.',
      author: { name: 'Ivo (demo)', role: 'Game design engineer' },
      questions: [{
        id: 'q_fog-timing', prompt: 'Should the first fog bank arrive before or after the player finds the lantern?',
        context: 'Before makes the lantern feel necessary; after gives the opening more breathing room.',
        presentation: { kind: 'text-v1', revision: 'timing-r1', choices: ['Before the lantern', 'After the lantern'] }
      }]
    });
    this.addResponse('q_fog-timing', {
      kind: 'answer', body: 'After the lantern. Let me learn the valley in clear air first, then make the fog change how I read the same place.',
      selections: [{ id: 'after', label: 'After the lantern' }], author: { name: 'Scott (demo)' }
    }, 'demo-fog-answer');
    this.addQuestion(design.id, {
      id: 'q_fog-duration', prompt: 'Follow-up: should that first fog bank pass, or remain for the rest of the chapter?',
      context: 'A passing bank makes it a reveal. Persistent fog makes it the chapter’s new normal.',
      presentation: { kind: 'text-v1', revision: 'duration-r1', choices: ['Pass after the reveal', 'Remain through the chapter'] }
    });
  }

  #normalizeInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('publish input must be an object');
    if (input.path && input.parentId) throw new InputError('use path or parentId, not both');
    const familiarScope = input.project != null || input.thread != null;
    if (familiarScope && (input.path || input.parentId)) throw new InputError('use project/thread, path, or parentId, not multiple locators');
    const path = familiarScope ? [
      ...(input.project != null ? [text(input.project, 'project')] : []),
      ...(input.thread != null ? [text(input.thread, 'thread')] : [])
    ] : input.path;
    const question = typeof input.question === 'string' ? input.question : null;
    const expectsAnswer = answerRequest(input) || question !== null || input.kind === 'question'; // old request shorthand
    const title = text(question || input.title, 'title or question');
    const body = text(input.body || input.context, 'body', false);
    let presentation = input.presentation;
    if (input.html) presentation = { kind: 'html-v1', html: input.html, fallback: input.fallback, revision: input.revision };
    if (!presentation && input.choices) presentation = { kind: 'text-v1', choices: input.choices, multiple: !!input.multiple };
    if (path && (!Array.isArray(path) || path.some((part) => typeof part !== 'string' || !part.trim()))) throw new InputError('path is an array of nonempty node titles');
    return { expectsAnswer, title, body, path: path?.map((part) => part.trim()) || null, parentId: input.parentId || null,
      author: input.author || { name: 'AI teammate' }, presentation: presentation ? this.#presentation(presentation, false) : (expectsAnswer ? this.#presentation({}, false) : null) };
  }

  #presentation(input, captureAssets = true) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('presentation must be an object');
    const value = structuredClone(input);
    value.kind ||= 'text-v1';
    // Revision is generated at insertion, not here, so request retries have a stable fingerprint.
    if (value.kind === 'html-v1') {
      text(value.html, 'presentation html');
      if (!value.fallback) throw new InputError('an authored presentation needs a readable fallback');
    }
    if (captureAssets && Array.isArray(value.options)) for (const option of value.options) {
      if (typeof option.image === 'string' && option.image.startsWith('/assets/')) {
        const filename = resolve(assetsDir, option.image.slice('/assets/'.length));
        if (!filename.startsWith(resolve(assetsDir) + sep)) throw new InputError('invalid asset reference');
        try {
          const bytes = readFileSync(filename);
          const mime = filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
          option.image = `data:${mime};base64,${bytes.toString('base64')}`;
        } catch { throw new InputError('presentation asset not found'); }
      }
    }
    return value;
  }

  #resolvePath(path, author) {
    let parentId = null;
    const createdIds = [];
    for (const title of path) {
      const matches = this.db.prepare('SELECT id FROM nodes WHERE parent_id IS ? AND title = ?').all(parentId, title);
      if (matches.length > 1) throw new ConflictError(`path is ambiguous at “${title}”; use parentId`);
      if (matches.length === 1) parentId = matches[0].id;
      else {
        parentId = this.#insert({ title, parentId, author });
        createdIds.push(parentId);
      }
    }
    return { parentId, createdIds };
  }

  #insert(input) {
    const id = input.id || `node_${randomUUID()}`;
    const createdAt = input.createdAt || now();
    const presentation = input.presentation ? { ...input.presentation, revision: input.presentation.revision || `rev_${randomUUID()}` } : null;
    this.db.prepare(`INSERT INTO nodes
      (id, parent_id, expects_answer, title, body, author_json, status, presentation_json, response_json, idempotency_key, request_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.parentId || null, input.expectsAnswer ? 1 : 0, input.title, input.body || '',
        JSON.stringify(input.author || { name: 'AI teammate' }), input.status || (input.expectsAnswer ? 'outstanding' : null),
        presentation ? JSON.stringify(presentation) : null, input.response ? JSON.stringify(input.response) : null,
        input.key || null, input.requestHash || null, createdAt, input.updatedAt || createdAt);
    // Updating the whole ancestor chain makes nested activity discoverable without changing identity.
    if (input.parentId) this.db.prepare(`WITH RECURSIVE parents(id) AS (
      SELECT ? UNION ALL SELECT n.parent_id FROM nodes n JOIN parents p ON n.id = p.id WHERE n.parent_id IS NOT NULL
    ) UPDATE nodes SET updated_at = ? WHERE id IN (SELECT id FROM parents)`).run(input.parentId, createdAt);
    return id;
  }

  #existing(key, requestHash, ...compatibleHashes) {
    if (!key) return null;
    const existing = this.db.prepare('SELECT * FROM nodes WHERE idempotency_key = ?').get(key);
    if (existing && existing.request_hash !== requestHash && !compatibleHashes.filter(Boolean).includes(existing.request_hash)) throw new ConflictError('Idempotency-Key was already used for different content');
    return existing;
  }

  #require(id) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (!node) throw new NotFoundError('node not found');
    return node;
  }

  #node(row) {
    return { id: row.id, parentId: row.parent_id, title: row.title, body: row.body, expectsAnswer: !!row.expects_answer,
      author: parse(row.author_json, {}), status: row.status, presentation: parse(row.presentation_json), response: parse(row.response_json),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #counts(id) {
    const rows = this.db.prepare(`WITH RECURSIVE descendants AS (
      SELECT * FROM nodes WHERE id = ? UNION ALL SELECT n.* FROM nodes n JOIN descendants d ON n.parent_id = d.id
    ) SELECT expects_answer, status FROM descendants`).all(id);
    return { nodes: rows.length, requests: rows.filter((row) => row.expects_answer).length,
      outstanding: rows.filter((row) => row.status === 'outstanding').length,
      waitingOnTeam: rows.filter((row) => row.status === 'waiting_on_team').length,
      deferred: rows.filter((row) => row.status === 'deferred').length };
  }

  #legacyThreadId(nodeId) {
    const node = this.#require(nodeId);
    return node.parent_id || node.id;
  }

  #atomic(work) {
    this.db.exec('BEGIN IMMEDIATE');
    let result;
    try { result = work(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // The saved record is authoritative even if a live transport listener fails.
    try { this.changes.emit('change'); } catch (error) { console.error('Live update listener failed after commit:', error); }
    return result;
  }

  #event(type, threadId, payload) {
    this.db.prepare('INSERT INTO events (id, type, thread_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`evt_${randomUUID()}`, type, threadId, JSON.stringify(payload), now());
  }

  #migrateNodeKinds() {
    const columns = this.db.prepare('PRAGMA table_info(nodes)').all().map((column) => column.name);
    if (!columns.includes('kind')) return;
    this.#atomic(() => {
      this.db.exec(`ALTER TABLE nodes ADD COLUMN expects_answer INTEGER NOT NULL DEFAULT 0;
        UPDATE nodes SET expects_answer = 1 WHERE kind = 'question';
        ALTER TABLE nodes DROP COLUMN kind;`);
    });
  }

  #migrateLegacy() {
    const legacy = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get();
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM nodes').get();
    if (!legacy || count > 0) return;
    this.#atomic(() => {
      const oldThreads = this.db.prepare('SELECT * FROM threads ORDER BY created_at').all();
      for (const thread of oldThreads) {
        const { parentId } = this.#resolvePath([thread.project], { name: 'Threadroom' });
        this.#insert({ id: thread.id, parentId, title: thread.title, body: thread.summary,
          author: { name: thread.author_name, role: thread.author_role }, createdAt: thread.created_at, updatedAt: thread.updated_at });
      }
      for (const question of this.db.prepare('SELECT * FROM questions ORDER BY created_at').all()) {
        this.#insert({ id: question.id, parentId: question.thread_id, expectsAnswer: true, title: question.prompt, body: question.context,
          author: this.getNode(question.thread_id).node.author, status: question.status,
          presentation: this.#presentation({ ...parse(question.presentation_json, {}), kind: question.presentation_kind, revision: question.presentation_revision }),
          createdAt: question.created_at });
      }
      for (const response of this.db.prepare('SELECT * FROM responses ORDER BY created_at').all()) {
        this.#insert({ id: response.id, parentId: response.question_id, title: response.body.slice(0, 100) || response.kind,
          body: response.body, author: { name: response.author_name },
          response: { kind: response.kind, selections: parse(response.selections_json, []), presentationRevision: response.presentation_revision, targetId: response.question_id },
          key: response.idempotency_key,
          requestHash: response.idempotency_key ? `legacy:${fingerprint({ nodeId: response.question_id, kind: response.kind, body: response.body, selections: parse(response.selections_json, []) })}` : null,
          createdAt: response.created_at });
      }
    });
  }
}

function answerRequest(input) {
  if (input.expectsAnswer != null && typeof input.expectsAnswer !== 'boolean') throw new InputError('expectsAnswer must be a boolean');
  return input.expectsAnswer === true;
}

function text(value, name, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim())) throw new InputError(`${name} must be ${required ? 'a nonempty' : 'a'} string`);
  return value.trim();
}

export class InputError extends Error { statusCode = 400; }
export class NotFoundError extends Error { statusCode = 404; }
export class ConflictError extends Error { statusCode = 409; }
