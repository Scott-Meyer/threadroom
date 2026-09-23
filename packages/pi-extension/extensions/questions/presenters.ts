import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { QuestionAnswer, QuestionGroup, QuestionResult, QuestionSpec } from './types.ts';

/**
 * Question presenters, v1: another extension in the same Pi process (for example
 * a desktop host's bridge) can show private questions in its own UI. Threadroom
 * keeps saving, pending/async lifecycle, delivery and wake-ups; a presenter only
 * shows questions and hands back what the person did. The terminal surface stays
 * up too, so the person can answer in either place; the other one is dismissed.
 *
 * Discovery uses `pi.events` in both directions, so load order doesn't matter:
 * a presenter emits `register` when it loads and again whenever it hears
 * `discover`, which Threadroom emits when it loads.
 */
export const PRESENTER_EVENTS = Object.freeze({
  register: 'threadroom.questions.presenter.v1.register',
  unregister: 'threadroom.questions.presenter.v1.unregister',
  discover: 'threadroom.questions.presenter.v1.discover',
});

/** One person's response to one question. `choices` are option indices (labels can repeat). */
export type PresenterReplyV1 = Readonly<{ questionId: string; choices?: readonly number[]; text?: string; notes?: string }>;
export type PresentedQuestionV1 = Readonly<{
  id: string; question: string; header?: string; context?: string;
  options: readonly Readonly<{ label: string; description?: string; preview?: string }>[];
  multiSelect: boolean;
  /** Whether a notes field makes sense; async questions can't keep notes. */
  notes: boolean;
  /** How `preview` text is meant to be shown. */
  previewFormat: 'markdown' | 'text';
}>;
export type PresentedGroupV1 = Readonly<{
  id: string; sessionId: string;
  /** `blocking`: the AI is waiting on the whole group. `async`: one question the AI isn't waiting on. */
  mode: 'blocking' | 'async';
  /** An async question the AI has started waiting on; see `update`. */
  required: boolean;
  questions: readonly PresentedQuestionV1[];
  /** Blocking groups: finish the group. Skipped questions are simply absent. Returns false if it already finished elsewhere. */
  submit(result: Readonly<{ replies: readonly PresenterReplyV1[]; cancelled?: boolean }>): boolean;
  /** Async questions: save an answer. Rejects if it couldn't be saved (keep the draft and show the error). */
  commit(reply: PresenterReplyV1): Promise<void>;
  /** Async and required: the person wants the AI to stop waiting. The question stays pending. */
  release(questionId: string): void;
}>;
export type PresentationHandleV1 = Readonly<{
  update?(change: Readonly<{ required: boolean }>): void;
  /** Stop showing it: answered or cancelled (here or elsewhere), or withdrawn (aborted, session change, detached). */
  dismiss?(reason: 'answered' | 'cancelled' | 'withdrawn'): void;
}>;
export type QuestionPresenterV1 = Readonly<{
  id: string;
  /** Show a group, returning a handle; return nothing to decline. */
  present(group: PresentedGroupV1): PresentationHandleV1 | void;
}>;

type Offer = { group: QuestionGroup; sessionId: string; required: boolean; closed: boolean; handles: Map<string, PresentationHandleV1>;
  submit?: (result: QuestionResult) => boolean;
  commit?: (questionId: string, answer: QuestionAnswer) => void | Promise<void>;
  release?: (questionId: string) => void };

function answerFor(spec: QuestionSpec, index: number, reply: PresenterReplyV1): QuestionAnswer | undefined {
  const options = spec.options ?? [];
  const choices = [...new Set(reply.choices ?? [])].sort((a, b) => a - b);
  if (choices.some((choice) => !Number.isInteger(choice) || !options[choice])) throw new Error(`Unknown option index for question ${spec.id}.`);
  if (!spec.multiSelect && choices.length > 1) throw new Error(`Question ${spec.id} takes one choice.`);
  const text = reply.text?.trim(), notes = spec.allowNotes === false ? undefined : reply.notes?.trim();
  const base = { questionIndex: index, question: spec.question, ...(notes ? { notes } : {}) };
  if (spec.multiSelect) {
    if (!choices.length && !text) return;
    return Object.freeze({ ...base, selected: Object.freeze(choices.map((choice) => options[choice].label)), optionIndices: Object.freeze(choices),
      previews: Object.freeze(choices.map((choice) => options[choice].preview ?? null)), ...(text ? { answer: text, wasCustom: true } : { wasCustom: false }) });
  }
  if (text) return Object.freeze({ ...base, answer: text, wasCustom: true });
  if (!choices.length) return;
  const option = options[choices[0]];
  return Object.freeze({ ...base, answer: option.label, optionIndex: choices[0], wasCustom: false, ...(option.preview !== undefined ? { preview: option.preview } : {}) });
}

function valid(value: any): value is QuestionPresenterV1 {
  return typeof value?.id === 'string' && !!value.id && typeof value.present === 'function';
}

/** Offers every private question group to registered presenters. Failures in a presenter never affect the terminal surface. */
export function createPresenterMirror(pi: ExtensionAPI) {
  const presenters = new Map<string, QuestionPresenterV1>();
  const offers = new Set<Offer>();
  const safely = (work: () => void) => { try { work(); } catch { /* A presenter's failure only affects its own surface. */ } };
  const specOf = (offer: Offer, questionId: string) => {
    const index = offer.group.questions.findIndex((spec) => spec.id === questionId);
    if (index < 0) throw new Error(`Unknown question ${questionId}.`);
    return { spec: offer.group.questions[index], index };
  };
  function view(offer: Offer): PresentedGroupV1 {
    return Object.freeze({
      id: offer.group.id, sessionId: offer.sessionId, mode: offer.group.mode, required: offer.required,
      questions: Object.freeze(offer.group.questions.map((spec) => Object.freeze({
        id: spec.id, question: spec.question, ...(spec.header !== undefined ? { header: spec.header } : {}), ...(spec.context !== undefined ? { context: spec.context } : {}),
        options: spec.options ?? Object.freeze([]), multiSelect: !!spec.multiSelect, notes: spec.allowNotes !== false,
        previewFormat: spec.plainPreview ? 'text' as const : 'markdown' as const }))),
      submit(result) {
        if (offer.closed || !offer.submit) return false;
        const answers = result.replies.flatMap((reply) => { const { spec, index } = specOf(offer, reply.questionId); const answer = answerFor(spec, index, reply); return answer ? [answer] : []; })
          .sort((a, b) => a.questionIndex - b.questionIndex);
        return offer.submit(Object.freeze({ answers: Object.freeze(answers), cancelled: !!result.cancelled }));
      },
      async commit(reply) {
        if (offer.closed || !offer.commit) throw Object.assign(new Error('This question is no longer pending here.'), { code: 'presentation_detached' });
        const { spec, index } = specOf(offer, reply.questionId), answer = answerFor(spec, index, reply);
        if (!answer) throw new Error('Reply must not be empty.');
        await offer.commit(reply.questionId, answer);
      },
      release(questionId) { if (!offer.closed && offer.required) offer.release?.(questionId); },
    });
  }
  function show(offer: Offer, presenter: QuestionPresenterV1) {
    safely(() => { const handle = presenter.present(view(offer)); if (handle) offer.handles.set(presenter.id, handle); });
  }
  function withdraw(offer: Offer, presenterId: string) {
    const handle = offer.handles.get(presenterId); offer.handles.delete(presenterId);
    if (handle) safely(() => handle.dismiss?.('withdrawn'));
  }
  pi.events.on(PRESENTER_EVENTS.register, (data) => {
    if (!valid(data)) return;
    if (presenters.has(data.id)) for (const offer of offers) withdraw(offer, data.id);
    presenters.set(data.id, data);
    for (const offer of offers) show(offer, data);
  });
  pi.events.on(PRESENTER_EVENTS.unregister, (data: any) => {
    const id = typeof data === 'string' ? data : data?.id;
    if (typeof id !== 'string' || !presenters.delete(id)) return;
    for (const offer of offers) withdraw(offer, id);
  });
  pi.events.emit(PRESENTER_EVENTS.discover, { version: 1 });

  return {
    offer(input: Omit<Offer, 'required' | 'closed' | 'handles'>) {
      const offer: Offer = { ...input, required: false, closed: false, handles: new Map() };
      offers.add(offer);
      for (const presenter of presenters.values()) show(offer, presenter);
      return {
        update(required: boolean) {
          if (offer.closed || offer.required === required) return;
          offer.required = required;
          for (const handle of offer.handles.values()) safely(() => handle.update?.({ required }));
        },
        close(reason: 'answered' | 'cancelled' | 'withdrawn') {
          if (offer.closed) return; offer.closed = true; offers.delete(offer);
          for (const handle of offer.handles.values()) safely(() => handle.dismiss?.(reason));
          offer.handles.clear();
        },
      };
    },
  };
}
