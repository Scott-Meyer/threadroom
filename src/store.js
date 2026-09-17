import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const asJson = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

export class ThreadStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL,
        author_role TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        presentation_kind TEXT NOT NULL DEFAULT 'text-v1',
        presentation_revision TEXT NOT NULL,
        presentation_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'outstanding',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        selections_json TEXT NOT NULL DEFAULT '[]',
        presentation_revision TEXT NOT NULL,
        author_name TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS questions_thread_idx ON questions(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS responses_thread_idx ON responses(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS events_thread_idx ON events(thread_id, sequence);
    `);
  }

  close() { this.db.close(); }

  createThread(input) {
    const createdAt = now();
    const threadId = input.id || `thr_${randomUUID()}`;
    const questions = input.questions?.length ? input.questions : [input.question];
    if (!input.title?.trim() || !input.project?.trim() || !questions[0]?.prompt?.trim()) {
      throw new InputError('title, project, and at least one question prompt are required');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO threads
        (id, title, project, summary, author_name, author_role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(threadId, input.title.trim(), input.project.trim(), input.summary?.trim() || '',
          input.author?.name?.trim() || 'AI teammate', input.author?.role?.trim() || '', createdAt, createdAt);
      const createdQuestions = questions.map((question) => this.#insertQuestion(threadId, question, createdAt));
      this.#event('thread.created', threadId, { threadId, questionIds: createdQuestions.map(({ id }) => id) }, createdAt);
      this.db.exec('COMMIT');
      return this.getThread(threadId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addQuestion(threadId, input) {
    const thread = this.db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId);
    if (!thread) throw new NotFoundError('thread not found');
    if (!input.prompt?.trim()) throw new InputError('prompt is required');
    const createdAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const question = this.#insertQuestion(threadId, input, createdAt);
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(createdAt, threadId);
      this.#event('question.created', threadId, { threadId, questionId: question.id }, createdAt);
      this.db.exec('COMMIT');
      return this.getThread(threadId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addResponse(questionId, input, idempotencyKey) {
    const question = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
    if (!question) throw new NotFoundError('question not found');
    if (!['answer', 'clarification', 'defer', 'reject', 'team_reply'].includes(input.kind)) {
      throw new InputError('kind must be answer, clarification, defer, reject, or team_reply');
    }
    const selections = Array.isArray(input.selections) ? input.selections : [];
    const responseBody = input.body?.trim() || '';
    if (input.kind !== 'defer' && !responseBody && selections.length === 0) {
      throw new InputError('a response needs written feedback or a selection');
    }
    if (['clarification', 'reject', 'team_reply'].includes(input.kind) && !responseBody) {
      throw new InputError(`${input.kind} needs written context`);
    }
    if (idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM responses WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.question_id !== questionId || existing.kind !== input.kind || existing.body !== responseBody ||
            existing.selections_json !== JSON.stringify(selections)) {
          throw new ConflictError('Idempotency-Key was already used for a different response');
        }
        return { thread: this.getThread(existing.thread_id), responseId: existing.id, deduplicated: true };
      }
    }
    if (input.kind === 'team_reply' && question.status !== 'waiting_on_team') {
      throw new InputError('team_reply targets a question waiting on the team');
    }

    const createdAt = now();
    const responseId = `rsp_${randomUUID()}`;
    const nextStatus = {
      answer: 'answered', clarification: 'waiting_on_team', defer: 'deferred', reject: 'rejected', team_reply: 'outstanding'
    }[input.kind];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO responses
        (id, thread_id, question_id, kind, body, selections_json, presentation_revision, author_name, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(responseId, question.thread_id, questionId, input.kind, input.body?.trim() || '', JSON.stringify(selections),
          question.presentation_revision, input.author?.name?.trim() || (input.kind === 'team_reply' ? 'AI teammate' : 'Scott'), idempotencyKey || null, createdAt);
      this.db.prepare('UPDATE questions SET status = ? WHERE id = ?').run(nextStatus, questionId);
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(createdAt, question.thread_id);
      this.#event('response.created', question.thread_id,
        { threadId: question.thread_id, questionId, responseId, kind: input.kind, questionStatus: nextStatus }, createdAt);
      this.db.exec('COMMIT');
      return { thread: this.getThread(question.thread_id), responseId, deduplicated: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listThreads(view = 'inbox') {
    const rows = this.db.prepare(`
      SELECT t.*,
        COUNT(q.id) AS question_count,
        SUM(CASE WHEN q.status = 'outstanding' THEN 1 ELSE 0 END) AS outstanding_count,
        SUM(CASE WHEN q.status = 'waiting_on_team' THEN 1 ELSE 0 END) AS team_count,
        SUM(CASE WHEN q.status = 'deferred' THEN 1 ELSE 0 END) AS deferred_count,
        (SELECT q2.prompt FROM questions q2 WHERE q2.thread_id = t.id ORDER BY q2.created_at DESC LIMIT 1) AS latest_prompt
      FROM threads t LEFT JOIN questions q ON q.thread_id = t.id
      GROUP BY t.id ORDER BY t.updated_at DESC`).all();
    const items = rows.map(this.#threadSummary);
    if (view === 'needs-answer') return items.filter((item) => item.counts.outstanding > 0);
    if (view === 'waiting-on-team') return items.filter((item) => item.counts.waitingOnTeam > 0);
    if (view === 'deferred') return items.filter((item) => item.counts.deferred > 0);
    return items;
  }

  getThread(threadId) {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
    if (!row) throw new NotFoundError('thread not found');
    const questions = this.db.prepare('SELECT * FROM questions WHERE thread_id = ? ORDER BY created_at').all(threadId);
    const responses = this.db.prepare('SELECT * FROM responses WHERE thread_id = ? ORDER BY created_at').all(threadId);
    const byQuestion = new Map();
    for (const response of responses) {
      const value = {
        id: response.id,
        questionId: response.question_id,
        kind: response.kind,
        body: response.body,
        selections: asJson(response.selections_json, []),
        presentationRevision: response.presentation_revision,
        author: { name: response.author_name },
        createdAt: response.created_at
      };
      byQuestion.set(response.question_id, [...(byQuestion.get(response.question_id) || []), value]);
    }
    const mappedQuestions = questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      context: question.context,
      status: question.status,
      presentation: {
        kind: question.presentation_kind,
        revision: question.presentation_revision,
        ...asJson(question.presentation_json, {})
      },
      createdAt: question.created_at,
      responses: byQuestion.get(question.id) || []
    }));
    const counts = this.#counts(mappedQuestions);
    return {
      id: row.id,
      title: row.title,
      project: row.project,
      summary: row.summary,
      author: { name: row.author_name, role: row.author_role },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      counts,
      questions: mappedQuestions
    };
  }

  listEvents(after = 0, threadId = null) {
    const rows = threadId
      ? this.db.prepare('SELECT * FROM events WHERE sequence > ? AND thread_id = ? ORDER BY sequence LIMIT 100').all(after, threadId)
      : this.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT 100').all(after);
    return rows.map((row) => ({
      sequence: row.sequence, id: row.id, type: row.type, threadId: row.thread_id,
      payload: asJson(row.payload_json, {}), createdAt: row.created_at
    }));
  }

  seedDemo() {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM threads').get();
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

  #insertQuestion(threadId, input, createdAt) {
    const questionId = input.id || `q_${randomUUID()}`;
    const presentation = input.presentation || {};
    const kind = presentation.kind || 'text-v1';
    const revision = presentation.revision || `rev_${randomUUID()}`;
    this.db.prepare(`INSERT INTO questions
      (id, thread_id, prompt, context, presentation_kind, presentation_revision, presentation_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'outstanding', ?)`)
      .run(questionId, threadId, input.prompt.trim(), input.context?.trim() || '', kind, revision,
        JSON.stringify({ ...presentation, kind: undefined, revision: undefined }), createdAt);
    return { id: questionId, revision };
  }

  #event(type, threadId, payload, createdAt) {
    this.db.prepare(`INSERT INTO events (id, type, thread_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(`evt_${randomUUID()}`, type, threadId, JSON.stringify(payload), createdAt);
  }

  #threadSummary = (row) => ({
    id: row.id, title: row.title, project: row.project, summary: row.summary,
    author: { name: row.author_name, role: row.author_role },
    latestPrompt: row.latest_prompt, createdAt: row.created_at, updatedAt: row.updated_at,
    counts: {
      questions: Number(row.question_count || 0), outstanding: Number(row.outstanding_count || 0),
      waitingOnTeam: Number(row.team_count || 0), deferred: Number(row.deferred_count || 0)
    }
  });

  #counts(questions) {
    return {
      questions: questions.length,
      outstanding: questions.filter((q) => q.status === 'outstanding').length,
      waitingOnTeam: questions.filter((q) => q.status === 'waiting_on_team').length,
      deferred: questions.filter((q) => q.status === 'deferred').length
    };
  }
}

export class InputError extends Error { statusCode = 400; }
export class NotFoundError extends Error { statusCode = 404; }
export class ConflictError extends Error { statusCode = 409; }
