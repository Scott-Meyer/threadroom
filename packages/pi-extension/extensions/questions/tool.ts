import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateHead } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { QuestionAnswer, QuestionGroup, QuestionResult } from './types.ts';
import { renderBlockingAskCall, renderBlockingAskResult } from './stream.ts';

/** TUI presentation owns interaction; rejection means no human cancellation result. */
export type QuestionPresenter = (
  group: QuestionGroup, ctx: ExtensionContext, signal?: AbortSignal,
) => Promise<QuestionResult>;

// These authoring limits belong to new blocking groups, not to a referenced
// native question or the shared renderer.
const authoredQuestions = Type.Array(Type.Object({
  question: Type.String({ minLength: 1, description: 'The question to ask.' }),
  header: Type.Optional(Type.String({ maxLength: 16, description: 'Short tab label.' })),
  context: Type.Optional(Type.String({ description: 'Context useful when answering.' })),
  options: Type.Array(Type.Object({
    label: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String()),
    preview: Type.Optional(Type.String({ description: 'Content to compare when choosing this option.' })),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean()),
}, { additionalProperties: false }), { minItems: 1, maxItems: 4 });
const parameters = Type.Object({
  questions: Type.Optional(authoredQuestions),
  questionId: Type.Optional(Type.String({ minLength: 1,
    description: 'Stable pending ID returned by ask_user_question_async. Waits on that saved question without asking it again.' })),
}, { additionalProperties: false, description: 'Provide either new questions or one existing async questionId, not both.' });

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function resultText(result: QuestionResult): string {
  const notice = '\n[Result text truncated; full answers are retained in tool result details.]';
  const complete = JSON.stringify(result, null, 2);
  const first = truncateHead(complete, { maxBytes: 50 * 1024 - Buffer.byteLength(notice), maxLines: 1998 });
  if (!first.truncated) return complete;
  // A large preview (or a single huge escaped line) must not erase the decision.
  const short = (text: string | undefined) => text === undefined ? undefined : text.length > 512 ? `${text.slice(0, 512)}…` : text;
  const summary = JSON.stringify({ cancelled: result.cancelled, answers: result.answers.map((answer) => ({
    questionIndex: answer.questionIndex, question: short(answer.question),
    optionIndex: answer.optionIndex, optionIndices: answer.optionIndices,
    selected: answer.selected?.map(short), answer: short(answer.answer), notes: short(answer.notes), wasCustom: answer.wasCustom,
  })) }, null, 2);
  const prefix = `Answer summary (long text shortened; previews omitted):\n${summary}\n\nResult detail:\n`;
  const remaining = truncateHead(complete, {
    maxBytes: 50 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(notice),
    maxLines: 2000 - prefix.split('\n').length - notice.split('\n').length,
  });
  return prefix + remaining.content + notice;
}

/** Stop waiting even if a presenter ignores cancellation; always observe its late rejection. */
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** SDK dialog fallback: numbered entries preserve identity even for duplicate labels. */
async function dialogs(group: QuestionGroup, ctx: ExtensionContext, signal: AbortSignal): Promise<QuestionResult> {
  const answers: QuestionAnswer[] = [];
  const select = (title: string, choices: string[]) => abortable(() => ctx.ui.select(title, choices, { signal }), signal);
  const input = (title: string) => abortable(() => ctx.ui.input(title, undefined, { signal }), signal);
  for (const [questionIndex, spec] of group.questions.entries()) {
    const options = spec.options ?? [];
    const checked = new Set<number>();
    let custom = '', notes = '';
    const title = [spec.header, spec.question, spec.context].filter(Boolean).join('\n');
    const currentAnswer = (): QuestionAnswer | undefined => {
      if (!checked.size && !custom) return undefined;
      const indices = [...checked].sort((a, b) => a - b);
      const base = { questionIndex, question: spec.question, ...(notes ? { notes } : {}) };
      if (spec.multiSelect) {
        return { ...base, selected: indices.map((index) => options[index].label), optionIndices: indices,
          previews: indices.map((index) => options[index].preview ?? null),
          ...(custom ? { answer: custom, wasCustom: true } : { wasCustom: false }) };
      }
      if (custom) return { ...base, answer: custom, wasCustom: true };
      const optionIndex = indices[0], option = options[optionIndex];
      return { ...base, answer: option.label, optionIndex, wasCustom: false,
        ...(option.preview !== undefined ? { preview: option.preview } : {}) };
    };
    const cancelled = (): QuestionResult => {
      const current = currentAnswer();
      return { answers: current ? [...answers, current] : answers, cancelled: true };
    };
    while (true) {
      const choices = options.map((option, index) => [
        `${checked.has(index) ? '[x]' : '[ ]'} ${index + 1}. ${option.label}`,
        option.description, option.preview,
      ].filter((part) => part !== undefined).join('\n'));
      const controls = ['Reply: Write or clear custom answer', 'Notes: Write or clear notes',
        'Next: Keep this answer', 'Skip: Leave this question unanswered', 'Cancel: Cancel this questionnaire'];
      const menu = [...choices, ...controls];
      const choice = await select(`${title}${custom ? `\nCustom answer: ${custom}` : ''}${notes ? `\nNotes: ${notes}` : ''}`, menu);
      signal.throwIfAborted();
      if (choice === undefined) return cancelled();
      const action = menu.indexOf(choice);
      if (action < 0) throw failure('invalid_dialog_response', 'Question dialog returned an unknown choice.');
      if (action < options.length) {
        if (spec.multiSelect) {
          if (checked.has(action)) checked.delete(action); else checked.add(action);
        } else {
          checked.clear(); checked.add(action); custom = '';
        }
        continue;
      }
      switch (action - options.length) {
        case 0: {
          const value = await input(`${title}\nCustom answer (empty clears it)`);
          signal.throwIfAborted();
          if (value !== undefined) custom = value.trim();
          continue;
        }
        case 1: {
          const value = await input(`${title}\nNotes (empty clears them)`);
          signal.throwIfAborted();
          if (value !== undefined) notes = value.trim();
          continue;
        }
        case 2: {
          const answer = currentAnswer();
          if (!answer) continue;
          answers.push(answer);
          break;
        }
        case 3: break;
        case 4: return cancelled();
      }
      break;
    }
  }
  const submit = 'Submit: Return these answers', cancel = 'Cancel: Cancel this questionnaire';
  const decision = await select(`Review: ${answers.length}/${group.questions.length} questions answered\n${JSON.stringify(answers, null, 2)}`, [submit, cancel]);
  signal.throwIfAborted();
  if (decision !== undefined && decision !== submit && decision !== cancel) {
    throw failure('invalid_dialog_response', 'Question review returned an unknown choice.');
  }
  return { answers, cancelled: decision !== submit };
}

export type ExistingQuestionWait = (questionId: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<Readonly<{
  sessionId: string;
  questionId: string;
  answerId?: string;
  status: 'answered' | 'cancelled' | 'already_queued' | 'already_received' | 'already_claimed';
  note?: string;
  releaseClaim?: () => void;
  result: QuestionResult;
}>>;

/** Registers a private blocking producer; no network, durable store, or global settings changes. */
export function registerBlockingQuestions(pi: ExtensionAPI, present: QuestionPresenter, waitExisting?: ExistingQuestionWait): void {
  const active = new Set<AbortController>();
  let retired = false;
  pi.on('session_shutdown', () => {
    retired = true;
    for (const controller of active) controller.abort(failure('presentation_detached', 'Question presentation detached during session shutdown.'));
    active.clear();
  });
  // Session-scoped admission reopens; outgoing controllers remain permanently aborted.
  pi.on('session_start', () => { retired = false; });
  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask Questions',
    description: 'Ask 1–4 new private blocking questions, or pass questionId from ask_user_question_async to wait on that exact pending question without asking it again. New questions have 2–4 suggestions and support custom answers, notes, partial submission, and duplicate labels. A referenced async question keeps its original choices and saved identity. Result text is limited to 2000 lines/50KB; full answers remain in details.',
    promptSnippet: 'Ask private questions when an answer is needed before continuing, or wait on an existing async question by ID',
    promptGuidelines: ['Use ask_user_question for decisions needed to continue. ask_user_question_async returns a stable ID; pass it back as questionId when later work becomes blocked on that same pending question.'],
    parameters,
    renderShell: 'self',
    renderCall: renderBlockingAskCall,
    renderResult: renderBlockingAskResult,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (retired) throw failure('presentation_detached', 'Question producer belongs to a retired session.');
      const controller = new AbortController();
      const signals = [controller.signal, signal, ctx.signal].filter((value): value is AbortSignal => value !== undefined);
      const lifetime = AbortSignal.any(signals);
      lifetime.throwIfAborted();
      if (!ctx.hasUI || ctx.mode === 'print' || ctx.mode === 'json') {
        throw failure('unsupported_host', 'ask_user_question needs an interactive TUI or SDK dialog host; no question was presented and no human declined.');
      }
      const referencesExisting = typeof params.questionId === 'string';
      if (referencesExisting === Array.isArray(params.questions)) {
        throw failure('invalid_arguments', 'Provide either questions or questionId, not both.');
      }
      active.add(controller);
      try {
        if (referencesExisting) {
          if (ctx.mode !== 'tui' || !waitExisting) throw failure('unsupported_host', 'Waiting on an existing private async question needs the interactive TUI host that owns it.');
          let waited: Awaited<ReturnType<ExistingQuestionWait>> | undefined;
          try {
            // The native wait already owns lifetime cancellation. Keeping its
            // resolved value visible here lets a final abort release a claim
            // before any answer-bearing tool result exists.
            waited = await waitExisting(params.questionId!, ctx, lifetime);
            lifetime.throwIfAborted();
            const text = waited.note ? JSON.stringify({ status: waited.status, questionId: waited.questionId, note: waited.note }) : resultText(waited.result);
            return { content: [{ type: 'text', text }], details: {
              groupId: `native:${waited.questionId}`, sessionId: waited.sessionId, questionId: waited.questionId,
              waitStatus: waited.status, ...(waited.note ? { waitNote: waited.note } : {}),
              ...(waited.status === 'answered' && waited.answerId ? { receivedNativeAnswerIds: [waited.answerId] } : {}), ...waited.result,
            } };
          } catch (error) { waited?.releaseClaim?.(); throw error; }
        }
        const group: QuestionGroup = Object.freeze({
          id: `blocking:${toolCallId}`, mode: 'blocking',
          questions: Object.freeze(params.questions!.map((spec, index) => Object.freeze({
            ...spec, id: `question:${index}`,
            options: Object.freeze(spec.options.map((option) => Object.freeze({ ...option }))),
          }))),
        });
        const result = await abortable(() => ctx.mode === 'tui' ? present(group, ctx, lifetime) : dialogs(group, ctx, lifetime), lifetime);
        lifetime.throwIfAborted();
        return { content: [{ type: 'text', text: resultText(result) }], details: { groupId: group.id, ...result } };
      } finally {
        active.delete(controller);
      }
    },
  });
}
