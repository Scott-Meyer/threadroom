import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateHead } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { QuestionAnswer, QuestionGroup, QuestionResult } from './types.ts';
import { renderPrivateAskCall, renderPrivateAskResult } from './stream.ts';
import { dialogVia, humanResponse } from './human-response.ts';

/** TUI presentation owns interaction; rejection means no human cancellation result.
 * Composed hosts carry their originating native activation through final return. */
export type QuestionPresentation = QuestionResult | Readonly<{ result: QuestionResult; accept: () => void; via?: string }>;
export type QuestionPresenter = (
  group: QuestionGroup, ctx: ExtensionContext, signal?: AbortSignal,
) => Promise<QuestionPresentation>;

// New questions and references share one required collection so an omitted
// alternative never needs a fabricated placeholder in a generated tool call.
const authoredQuestion = Type.Object({
  question: Type.String({ minLength: 1, description: 'What the person is being asked.' }),
  header: Type.Optional(Type.String({ maxLength: 16, description: 'Short tab label.' })),
  context: Type.Optional(Type.String({ description: 'Supporting detail shown directly beneath the question, such as a command, path, or comparison background.' })),
  options: Type.Array(Type.Object({
    label: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String({ description: 'A short explanation shown when this suggestion is selected.' })),
    preview: Type.Optional(Type.String({ description: 'Additional content shown when this suggestion is selected.' })),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const pendingQuestion = Type.Object({
  questionId: Type.String({ minLength: 1,
    description: 'Stable pending ID returned by an earlier nonblocking call. Reuses that question instead of asking it again.' }),
}, { additionalProperties: false });
const parameters = Type.Object({
  questions: Type.Union([
    Type.Array(authoredQuestion, { minItems: 1, maxItems: 4 }),
    Type.Array(pendingQuestion, { minItems: 1, maxItems: 1 }),
  ], { description: 'New questions, or one pending question reference when returning to an earlier nonblocking question.' }),
  blocking: Type.Optional(Type.Boolean({ default: true,
    description: 'Wait for an answer before continuing. Defaults to true; set false to leave new questions pending while continuing.' })),
}, { additionalProperties: false,
  description: 'Provide 1–4 new questions, or a single pending question reference. blocking defaults to true.' });

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

export type NonblockingQuestionProducer = (
  toolCallId: string,
  question: Readonly<{ question: string; header?: string; context?: string; options?: readonly Readonly<{ label: string; description?: string; preview?: string }>[]; multiSelect?: boolean }>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) => Promise<Readonly<{ content: readonly unknown[]; details: Record<string, unknown> }>>;

export type ExistingQuestionWait = (questionId: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<Readonly<{
  sessionId: string;
  questionId: string;
  answerId?: string;
  status: 'answered' | 'cancelled' | 'already_queued' | 'already_received' | 'already_claimed';
  note?: string;
  via?: string;
  acceptWait?: () => void;
  acceptClaim?: () => void;
  releaseClaim?: () => void;
  result: QuestionResult;
}>>;

/** Registers the private question tool; no network, service, or global settings changes. */
export function registerBlockingQuestions(pi: ExtensionAPI, present: QuestionPresenter, waitExisting?: ExistingQuestionWait,
  captureAdmission?: (ctx: ExtensionContext) => () => void, askNonblocking?: NonblockingQuestionProducer): void {
  const active = new Set<AbortController>();
  let retired = false, replacing = false, changingTree = false, compacting = false;
  const transitioning = () => replacing || changingTree || compacting;
  function detachActive(message: string) {
    for (const controller of active) controller.abort(failure('presentation_detached', message));
    active.clear();
  }
  pi.on('session_shutdown', () => {
    retired = true; replacing = true;
    detachActive('Question presentation detached during session shutdown.');
  });
  for (const event of ['session_before_switch', 'session_before_fork'] as const) pi.on(event, () => {
    replacing = true; detachActive('Question presentation detached during session transition.');
  });
  pi.on('session_before_tree', () => {
    changingTree = true; detachActive('Question presentation detached during session transition.');
  });
  pi.on('session_before_compact', () => {
    compacting = true; detachActive('Question presentation detached during session transition.');
  });
  // Only the matching positive lifecycle event reopens its gate. Stock Pi
  // exposes no cancelled/failed replacement or tree event, so those attempts
  // remain fail-closed until their positive event or a lifecycle rebind.
  pi.on('session_start', () => { retired = false; replacing = changingTree = compacting = false; });
  pi.on('session_tree', () => { changingTree = false; });
  pi.on('session_compact', () => { compacting = false; });
  pi.on('session_compact_failed', () => { compacting = false; });
  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask Questions',
    description: 'A private questionnaire for decisions and feedback. It ordinarily waits for the person’s answer. A nonblocking question stays open while useful work continues and can become required later without being asked twice. The person sees the question, its context, suggestions, and selected previews together. Supports 1–4 questions, 2–4 suggestions, custom replies, multiple selection, and partial submission. Result text is limited to 2000 lines/50KB; full answers remain in details.',
    promptSnippet: 'Ask private questions; ordinarily waits, or can leave them pending while useful work continues',
    promptGuidelines: ['Blocking is the ordinary question-and-answer experience. Nonblocking questions fit moments when useful work can continue while the person answers.'],
    parameters,
    renderShell: 'self',
    renderCall: renderPrivateAskCall,
    renderResult: renderPrivateAskResult,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (retired) throw failure('presentation_detached', 'Question producer belongs to a retired session.');
      if (transitioning()) throw failure('presentation_detached', 'Private question admission is closed during an unresolved session transition.');
      const controller = new AbortController();
      const signals = [controller.signal, signal, ctx.signal].filter((value): value is AbortSignal => value !== undefined);
      const lifetime = AbortSignal.any(signals);
      lifetime.throwIfAborted();
      if (!ctx.hasUI || ctx.mode === 'print' || ctx.mode === 'json') {
        throw failure('unsupported_host', 'ask_user_question needs an interactive TUI or SDK dialog host; no question was presented and no human declined.');
      }
      const requests = Array.isArray(params.questions) ? params.questions : [];
      const references = requests.filter((request): request is { questionId: string } => 'questionId' in request);
      const reference = references[0], authored = reference ? undefined : requests;
      const blocking = params.blocking !== false;
      if (!requests.length || references.length > 1 || (reference && requests.length !== 1)) {
        throw failure('invalid_arguments', 'Provide 1–4 new questions, or one existing pending question reference.');
      }
      if (reference && !blocking) {
        throw failure('invalid_arguments', 'A pending question reference is already nonblocking; wait for it with blocking=true.');
      }
      if (!blocking && !askNonblocking) throw failure('unsupported_host', 'This question producer does not support nonblocking questions.');
      active.add(controller);
      try {
        if (!blocking) {
          const results = [];
          for (const [index, spec] of authored!.entries()) {
            results.push(await askNonblocking!(`${toolCallId}:${index}`, {
              question: spec.question,
              ...(spec.header !== undefined ? { header: spec.header } : {}),
              ...(spec.context !== undefined ? { context: spec.context } : {}),
              options: spec.options.map((option) => ({ label: option.label,
                ...(option.description !== undefined ? { description: option.description } : {}),
                ...(option.preview !== undefined ? { preview: option.preview } : {}) })),
              ...(spec.multiSelect !== undefined ? { multiSelect: spec.multiSelect } : {}),
            }, ctx, lifetime));
            lifetime.throwIfAborted();
          }
          if (results.length === 1) return results[0];
          const questions = results.map((item) => item.details);
          const accepted = questions.every((item) => item.status === 'pending' || item.status === 'answered');
          const value = { status: !accepted ? 'partial' : questions.every((item) => item.status === 'answered') ? 'answered' : 'pending', questions };
          return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
        }
        if (reference) {
          if (ctx.mode !== 'tui' || !waitExisting) throw failure('unsupported_host', 'Waiting on an existing private nonblocking question needs the interactive TUI host that owns it.');
          let waited: Awaited<ReturnType<ExistingQuestionWait>> | undefined;
          try {
            // The native wait already owns lifetime cancellation. Keeping its
            // resolved value visible here lets a final abort release a claim
            // before any answer-bearing tool result exists.
            waited = await waitExisting(reference.questionId, ctx, lifetime);
            lifetime.throwIfAborted();
            // Every native outcome is activation-bound; answer-bearing outcomes
            // additionally arbitrate the one delivery winner.
            waited.acceptWait?.();
            waited.acceptClaim?.();
            const text = waited.note
              ? JSON.stringify({ status: waited.status, questionId: waited.questionId, note: waited.note })
              : waited.status === 'cancelled'
                ? JSON.stringify({ status: waited.status, questionId: waited.questionId, ...waited.result,
                    note: 'Blocking wait cancelled. The original nonblocking question remains pending.' })
                : resultText(waited.result);
            return { content: [{ type: 'text', text }], details: {
              groupId: `native:${waited.questionId}`, sessionId: waited.sessionId, questionId: waited.questionId,
              waitStatus: waited.status, ...(waited.note ? { waitNote: waited.note } : {}),
              ...(waited.status === 'answered' && waited.answerId ? { receivedNativeAnswerIds: [waited.answerId] } : {}), ...waited.result,
              ...(waited.status === 'answered' ? { humanResponse: humanResponse(waited.result, 1, waited.via ?? 'pi-tui') } : {}),
            } };
          } catch (error) { waited?.releaseClaim?.(); throw error; }
        }
        // TUI composition returns its fence with the presenter outcome; SDK
        // dialogs need it captured here before their first awaited interaction.
        const acceptCompletion = ctx.mode === 'tui' ? undefined : captureAdmission?.(ctx);
        const group: QuestionGroup = Object.freeze({
          id: `blocking:${toolCallId}`, mode: 'blocking',
          questions: Object.freeze(authored!.map((spec, index) => Object.freeze({
            ...spec, id: `question:${index}`,
            options: Object.freeze(spec.options.map((option) => Object.freeze({ ...option }))),
          }))),
        });
        const presented = await abortable(() => ctx.mode === 'tui' ? present(group, ctx, lifetime) : dialogs(group, ctx, lifetime), lifetime);
        lifetime.throwIfAborted();
        const result = 'result' in presented ? presented.result : presented;
        if ('result' in presented) presented.accept(); else acceptCompletion?.();
        const via = ('result' in presented && presented.via) || (ctx.mode === 'tui' ? 'pi-tui' : dialogVia(ctx.mode));
        return { content: [{ type: 'text', text: resultText(result) }],
          details: { groupId: group.id, ...result, humanResponse: humanResponse(result, group.questions.length, via) } };
      } finally {
        active.delete(controller);
      }
    },
  });
}
