import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createHash, randomUUID } from 'node:crypto';
import { AskPanel, pendingCard, card, plain, type Feedback } from './ui.ts';
import type { NativeQuestionPresentation, NativeQuestionSource, NativeSavedAnswer } from './presentation.ts';
import { createReceiptJournal } from './receipt.ts';

const QUESTION = 'threadroom.native.question.v1';
const ANSWER = 'threadroom.native.answer.v1';
const FEEDBACK = 'threadroom.native.feedback.v1';

// Reload replaces extension closures but preserves Pi's agent queues. Keep only
// process-local submission identities across that boundary, never question data
// or durable receipt claims. A fresh process/SessionManager can recover safely.
const INFLIGHT = Symbol.for('threadroom.native.inflight.v1');
const inflight: WeakMap<object, Map<string, Set<string>>> =
  (globalThis as any)[INFLIGHT] ??= new WeakMap();
function submissions(manager: object, sessionId: string) {
  let sessions = inflight.get(manager);
  if (!sessions) { sessions = new Map(); inflight.set(manager, sessions); }
  let ids = sessions.get(sessionId);
  if (!ids) { ids = new Set(); sessions.set(sessionId, ids); }
  return ids;
}

// SDK append can mutate its branch before a failed disk write. These IDs are
// uncertainty exclusions, never saved data or receipts. Reload cannot make the
// same manager's failed append authoritative.
const STORAGE = Symbol.for('threadroom.native.storage-unconfirmed.v1');
const uncertain: WeakMap<object, Map<string, Set<string>>> = (globalThis as any)[STORAGE] ??= new WeakMap();
function unconfirmed(ctx: ExtensionContext) {
  const manager = ctx.sessionManager, sessionId = manager.getSessionId();
  let sessions = uncertain.get(manager); if (!sessions) { sessions = new Map(); uncertain.set(manager, sessions); }
  let ids = sessions.get(sessionId); if (!ids) { ids = new Set(); sessions.set(sessionId, ids); }
  return ids;
}
function storageFailure(cause?: unknown, anchor?: string | null) {
  return Object.assign(new Error(`Private storage is unconfirmed; no new private feedback will be sent. Draft retained. Recover the original SDK journal before continuing; /reload is not storage recovery. Preserve/copy retained drafts before any process replacement. Do not quit/resume as a feedback retry: feedback may have been consumed without a durable receipt.${anchor ? ` Last prior branch entry: ${anchor}.` : ''}${cause ? ` Cause: ${plain(cause)}` : ''}`), { code: 'storage_unconfirmed' });
}

// An overlay can retain an unmounted widget as preFocus. Share only current
// UI ownership across closure reload, never questions or durable receipts.
const FOCUS = Symbol.for('pi.private-question.focus.v1');
const focusOwners: WeakMap<object, { handoff(data: string, editor: any): void }> =
  (globalThis as any)[FOCUS] ??= new WeakMap();

function mountedEditor(tui: any, preferred: any, fallback?: any) {
  const mounted = new Set<any>(), queue = [...(tui.children || [])];
  while (queue.length) {
    const item = queue.pop(); if (!item || mounted.has(item)) continue;
    mounted.add(item); if (Array.isArray(item.children)) queue.push(...item.children);
  }
  const editor = (item: any) => mounted.has(item) && typeof item?.getText === 'function' && typeof item?.setText === 'function';
  return editor(preferred) ? preferred : editor(fallback) ? fallback : [...mounted].find(editor);
}

type Prompt = { question: string; context?: string; options?: { label: string; preview?: string }[] };
type Question = { sessionId: string; id: string; toolCallId: string; prompt: Prompt };
type Answer = { sessionId: string; answerId: string; questionId: string; prompt: Prompt;
  answer: { text: string; optionIndex?: number; selection?: { label: string; preview?: string } } };

/** Native/private asks have no service dependency and do not claim the blocking ask name. */
export function registerNativeAsks(pi: ExtensionAPI, options: { presentation?: NativeQuestionPresentation } = {}) {
  let context: ExtensionContext | undefined;
  let epoch = 0;
  let paused = false;
  let navigating = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reopenWhenIdle = false;
  let open: { epoch: number; close?: () => void; panel?: AskPanel; yield?: () => void; focus?: () => void } | undefined;
  const receiptJournal = createReceiptJournal();
  let source: NativeQuestionSource | undefined;
  let projectionError: string | undefined, displayError: string | undefined;
  function presentationFailed(ctx: ExtensionContext, error: unknown, phase: 'projection' | 'display') {
    const message = plain(error); if (phase === 'projection') projectionError = message; else displayError = message;
    try { ctx.ui.notify(`Private question presentation failed: ${message}. Saved questions remain pending; /asks retries.`, 'error'); } catch {}
  }
  function append(ctx: ExtensionContext, type: string, data: any) {
    const blocked = unconfirmed(ctx); if (blocked.size) throw storageFailure();
    const prior = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)), anchor = ctx.sessionManager.getLeafId?.();
    try { pi.appendEntry(type, data); }
    catch (error) {
      for (const entry of ctx.sessionManager.getBranch()) if (!prior.has(entry.id)) blocked.add(entry.id);
      if (blocked.size) throw storageFailure(error, anchor);
      throw error; // A preappend refusal has not poisoned the SDK branch.
    }
  }
  function persistReply(ctx: ExtensionContext, mine: number, reply: { questionId: string; text: string; optionIndex?: number }): NativeSavedAnswer {
    if (!active(ctx, mine)) throw new Error('Original private question activation is detached.');
    const state = project(ctx), question = state.questions.get(reply.questionId);
    if (!question || state.answers.has(reply.questionId)) throw new Error('Original question is not pending on this branch.');
    const selection = reply.optionIndex === undefined ? undefined : question.prompt.options?.[reply.optionIndex];
    if (reply.optionIndex !== undefined && (!Number.isInteger(reply.optionIndex) || !selection)) throw new Error('Invalid original option index.');
    const text = plain(reply.text).replace(/\s+/gu, ' ').trim(); if (!text) throw new Error('Reply must not be empty.');
    const answer: Answer = { sessionId: state.sessionId, answerId: `answer-${randomUUID()}`, questionId: question.id, prompt: question.prompt,
      answer: { text, ...(selection ? { optionIndex: reply.optionIndex, selection } : {}) } };
    append(ctx, ANSWER, answer);
    if (project(ctx).answers.get(question.id)?.answerId !== answer.answerId) throw new Error('Host did not save the answer entry.');
    return { sessionId: state.sessionId, questionId: question.id, answerId: answer.answerId };
  }
  let hostPrompt = false;
  let submitted = new Set<string>();

  function project(ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    const questions = new Map<string, Question>();
    const answers = new Map<string, Answer>();
    const received = new Set<string>();
    const blocked = unconfirmed(ctx), diskReceipts = receiptJournal(ctx.sessionManager);
    for (const entry of ctx.sessionManager.getBranch() as any[]) {
      if (blocked.has(entry.id)) continue;
      if (entry.type === 'custom' && entry.data?.sessionId === sessionId) {
        if (entry.customType === QUESTION) questions.set(entry.data.id, entry.data);
        if (entry.customType === ANSWER) answers.set(entry.data.questionId, entry.data);
      }
      if (entry.type === 'custom_message' && entry.customType === FEEDBACK && entry.details?.sessionId === sessionId) {
        if (diskReceipts && !diskReceipts.has(entry.id)) { blocked.add(entry.id); continue; }
        received.add(entry.details.answerId);
      }
    }
    // An answer is meaningful only with its original question on this branch.
    for (const id of answers.keys()) if (!questions.has(id)) answers.delete(id);
    return { sessionId, questions, answers, received, storageUnconfirmed: blocked.size > 0,
      pending: [...questions.values()].filter((question) => !answers.has(question.id)) };
  }
  function sameSession(ctx: ExtensionContext) {
    return context?.sessionManager === ctx.sessionManager;
  }
  function active(ctx: ExtensionContext, mine: number) {
    return mine === epoch && sameSession(ctx) && !paused && !navigating;
  }
  function ambient(ctx: ExtensionContext) {
    if (ctx.mode !== 'tui') return;
    const state = project(ctx);
    for (const id of state.received) submitted.delete(id);
    const waiting = [...state.answers.values()].filter((answer) => !state.received.has(answer.answerId)).length;
    try {
      ctx.ui.setStatus('native-asks', state.storageUnconfirmed ? 'Private storage unconfirmed · recovery needed' : state.pending.length || waiting
        ? `Asks: ${state.pending.length} pending${waiting ? ` · ${waiting} saved feedback` : ''} · /asks` : undefined);
      if (options.presentation) {
        if (active(ctx, epoch)) {
          if (!source) {
            const mine = epoch;
            source = options.presentation.connect({ context: ctx, sessionId: state.sessionId, activation: mine, commit(reply) {
              const saved = persistReply(ctx, mine, reply);
              try { ambient(ctx); flush(ctx); } catch (error) { try { ctx.ui.notify(`Feedback saved (${saved.answerId}), but continuation failed: ${plain(error)}. No receipt claimed.`, 'error'); } catch {} }
              return saved;
            } });
          }
          source.replace(state.pending); projectionError = undefined;
          if (!state.pending.length) displayError = undefined;
        }
        return;
      }
      if (open && !state.pending.length) {
        const old = open; open = undefined; old.yield?.(); old.close?.();
      } else open?.panel?.update(state.pending);
      if (!open) ctx.ui.setWidget('native-asks', state.pending.length && active(ctx, epoch)
        ? (tui, theme) => pendingCard(state.pending, tui, theme) : undefined);
      projectionError = undefined;
    } catch (error) { presentationFailed(ctx, error, 'projection'); }
  }
  function flush(ctx: ExtensionContext) {
    if (!active(ctx, epoch) || ctx.mode !== 'tui') return;
    // isIdle includes tree summarization/compaction, not only agent streaming.
    if (!running && !ctx.isIdle()) { resumeAfterBoundary(ctx, epoch); return; }
    const state = project(ctx);
    if (state.storageUnconfirmed) { ambient(ctx); return; }
    for (const answer of state.answers.values()) {
      if (state.received.has(answer.answerId) || submitted.has(answer.answerId)) continue;
      submitted.add(answer.answerId); // In-flight only: never a persistence receipt.
      try {
        pi.sendMessage({ customType: FEEDBACK, display: true, details: answer,
          content: `Saved private human feedback for native ask (answer identity ${answer.answerId}):\n${JSON.stringify(answer)}` },
          { deliverAs: 'steer', triggerTurn: true });
      } catch (error) {
        submitted.delete(answer.answerId);
        ctx.ui.notify(`Feedback saved, but delivery failed: ${plain(error)}`, 'error');
      }
    }
    ambient(ctx);
  }
  function invalidate() {
    ++epoch; projectionError = displayError = undefined;
    const oldSource = source; source = undefined;
    try { oldSource?.dispose(); } catch (error) { if (context) presentationFailed(context, error, 'projection'); }
    clearTimeout(timer); timer = undefined; reopenWhenIdle = false;
    const old = open; open = undefined; old?.yield?.(); old?.close?.();
    if (!options.presentation && context?.mode === 'tui') context.ui.setWidget('native-asks', undefined);
  }
  function bind(ctx: ExtensionContext) {
    invalidate();
    context = ctx; paused = false; navigating = false; running = false;
    submitted = submissions(ctx.sessionManager, ctx.sessionManager.getSessionId());
    ambient(ctx); flush(ctx); void present(ctx);
  }
  // Pi exposes no cancelled/failed tree or switch event. Resume only after host
  // quiescence and reproject the actual selected branch, never an old UI snapshot.
  function resumeAfterBoundary(ctx: ExtensionContext, mine: number, reopen = false) {
    reopenWhenIdle ||= reopen;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (mine !== epoch || !sameSession(ctx)) return;
      if (!ctx.isIdle()) { resumeAfterBoundary(ctx, mine); return; }
      const show = reopenWhenIdle; reopenWhenIdle = false;
      paused = false; navigating = false; ambient(ctx); flush(ctx); if (show) void present(ctx);
    }, 100);
    timer.unref?.();
  }
  function boundary(ctx: ExtensionContext, kind: 'navigate' | 'compact') {
    invalidate();
    if (kind === 'compact') paused = true; else navigating = true;
    resumeAfterBoundary(ctx, epoch, true);
  }
  pi.on('session_start', (_event, ctx) => { bind(ctx); });
  pi.on('session_shutdown', () => {
    invalidate();
    context?.ui.setStatus('native-asks', undefined); context = undefined;
  });
  pi.on('session_before_switch', (_event, ctx) => { boundary(ctx, 'navigate'); });
  pi.on('session_before_fork', (_event, ctx) => { boundary(ctx, 'navigate'); });
  pi.on('session_before_tree', (_event, ctx) => { boundary(ctx, 'navigate'); });
  pi.on('session_tree', (_event, ctx) => { bind(ctx); });
  pi.on('session_before_compact', (_event, ctx) => { boundary(ctx, 'compact'); });
  for (const event of ['session_compact', 'session_compact_failed'] as const) {
    pi.on(event, (_event, ctx) => {
      clearTimeout(timer); timer = undefined; paused = false; ambient(ctx); flush(ctx); void present(ctx);
    });
  }
  // Our inline widget does not start a blocking UI span. The host's outer
  // prompt events therefore describe other prompts, including overlapping ones.
  pi.on('ui_prompt_start', () => { hostPrompt = true; open?.yield?.(); });
  pi.on('ui_prompt_end', (_event, ctx) => {
    hostPrompt = false;
    if (sameSession(ctx) && active(ctx, epoch)) open?.focus?.();
  });
  pi.on('agent_start', () => { running = true; });
  pi.on('turn_end', (_event, ctx) => { if (sameSession(ctx)) ambient(ctx); });
  pi.on('agent_settled', (_event, ctx) => {
    running = false;
    if (sameSession(ctx)) { ambient(ctx); flush(ctx); }
  });

  pi.registerEntryRenderer<Question>(QUESTION, (entry, _options, theme) =>
    card(theme.fg('accent', 'Private ask') + ` · ${entry.data?.id}\n${entry.data?.prompt.question}\nPresentation and storage status appear in Pi’s input area; /asks reopens questions.`));
  pi.registerEntryRenderer<Answer>(ANSWER, (entry) =>
    card(`Private answer · ${entry.data?.answerId}\n${entry.data?.prompt.question}\n${entry.data?.answer.text}`));
  pi.registerMessageRenderer<Answer>(FEEDBACK, (message) =>
    card(`Private feedback · ${message.details?.questionId}\n${message.details?.prompt.question}\n${message.details?.answer.text}`));

  function result(value: any) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value }; }
  pi.registerTool({
    name: 'ask_user_question_async', label: 'Ask privately (async)',
    description: 'Ask one private native Pi question, then continue working. The question opens automatically in Pi’s input area while this tool returns a stable pending identity immediately. The person can select a suggestion or write freely; /asks reopens paused questions. Saved feedback steers this session or wakes it when idle. Interactive TUI only; questions remain local to this session/branch, not shared Threadroom.',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 12000, description: 'The question, in ordinary text. No header required.' }),
      context: Type.Optional(Type.String({ maxLength: 30000, description: 'Optional context for the person.' })),
      options: Type.Optional(Type.Array(Type.Union([Type.String({ minLength: 1, maxLength: 2000 }),
        Type.Object({ label: Type.String({ minLength: 1, maxLength: 2000 }),
          preview: Type.Optional(Type.String({ maxLength: 12000, description: 'Optional plain-text preview.' })) })]),
      { maxItems: 20, description: 'Optional suggestions; the person can edit them or answer freely.' })),
    }),
    renderCall(args) { return card(`Private async ask\n${args.question || ''}`); },
    renderResult(value) { return card(value.details?.status === 'pending'
      ? `Pending private ask · ${value.details.id} · /asks reopens` : `Private ask: ${value.details?.status || 'unavailable'}`); },
    async execute(toolCallId, params, signal, _update, ctx) {
      if (ctx.mode !== 'tui') return result({ status: 'unsupported_host', host: ctx.mode,
        reason: 'Native async asks require interactive Pi TUI; no question was saved.' });
      if (signal?.aborted) return result({ status: 'aborted', saved: false });
      if (!context) bind(ctx);
      if (!active(ctx, epoch)) return result({ status: 'session_changing', saved: false });
      if (!params.question.trim()) return result({ status: 'invalid_question', saved: false });
      const state = project(ctx);
      const id = `ask-${createHash('sha256').update(`${state.sessionId}\0${toolCallId}`).digest('hex').slice(0, 24)}`;
      const prompt: Prompt = { question: params.question,
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.options !== undefined ? { options: params.options.map((option: any) =>
          typeof option === 'string' ? { label: option } : { label: option.label,
            ...(option.preview !== undefined ? { preview: option.preview } : {}) }) } : {}) };
      const old = state.questions.get(id);
      if (old && JSON.stringify(old.prompt) !== JSON.stringify(prompt)) return result({ status: 'identity_conflict', id, saved: false });
      try {
        if (state.storageUnconfirmed) throw storageFailure();
        if (!old) append(ctx, QUESTION, { sessionId: state.sessionId, id, toolCallId, prompt });
        const saved = project(ctx);
        if (!saved.questions.has(id)) throw new Error('Host did not save the question entry.');
      } catch (error) { return result({ status: (error as any)?.code === 'storage_unconfirmed' ? 'storage_unconfirmed' : 'save_failed', id, saved: false, error: plain(error) }); }
      ambient(ctx); if (!old && !options.presentation) present(ctx, id);
      const saved = project(ctx);
      return result({ id, sessionId: state.sessionId, status: saved.answers.has(id) ? 'answered' : 'pending',
        ...((projectionError || displayError) ? { presentationError: projectionError || displayError } : {}),
        pending: saved.pending.map((question) => ({ id: question.id, question: question.prompt.question.slice(0, 160) })) });
    },
  });


  function present(ctx: ExtensionContext, initialId?: string) {
    if (ctx.mode !== 'tui' || !active(ctx, epoch) || open) return;
    if (!running && !ctx.isIdle()) { resumeAfterBoundary(ctx, epoch, true); return; }
    const state = project(ctx);
    if (!state.pending.length) return;
    if (options.presentation) {
      ambient(ctx); try { source?.reveal(initialId); if (source) displayError = undefined; } catch (error) { presentationFailed(ctx, error, 'display'); }
      return;
    }
    const mine = epoch;
    const opening: NonNullable<typeof open> = { epoch: mine };
    open = opening;
    try {
      ctx.ui.setWidget('native-asks', (tui, theme) => {
        if (typeof tui.getFocusedComponent !== 'function' || typeof tui.setFocus !== 'function')
          throw new Error('This Pi TUI does not support owned inline-question focus.');
        let previous: any;
        const finish = (feedback: Feedback | undefined) => {
          if (open !== opening) return;
          if (!feedback) { opening.yield?.(); open = undefined; }
          if (!active(ctx, mine)) return;
          try {
            if (feedback) {
              const current = project(ctx);
              const question = current.questions.get(feedback.id);
              if (question && !current.answers.has(feedback.id) && feedback.text.trim()) {
                const selection = feedback.optionIndex === undefined ? undefined : question.prompt.options?.[feedback.optionIndex];
                const answer: Answer = { sessionId: current.sessionId, answerId: `answer-${randomUUID()}`,
                  questionId: question.id, prompt: question.prompt,
                  answer: { text: feedback.text, ...(selection ? { optionIndex: feedback.optionIndex, selection } : {}) } };
                append(ctx, ANSWER, answer); // Save prompt association + structured answer BEFORE wake.
                if (project(ctx).answers.get(question.id)?.answerId !== answer.answerId) throw new Error('Host did not save the answer entry.');
              }
            } else ctx.ui.notify('Paused without answering. Question stays visible and pending; unsaved draft discarded. /asks reopens it.', 'info');
          } catch (error) {
            ctx.ui.notify(`Private question could not complete: ${plain(error)}. Check /asks; no decline was recorded.`, 'error');
          }
          ambient(ctx); flush(ctx);
          // The same panel projects the remaining questions, preserving their
          // unsaved drafts. Only explicit pause or a host boundary discards them.
        };
        const panel = new AskPanel(state.pending, tui, theme, finish, initialId);
        panel.suspend(hostPrompt);
        opening.panel = panel;
        const owner = { handoff(data: string, editor: any) {
          if (!active(ctx, mine) || open !== opening) return;
          const target = mountedEditor(tui, previous, editor);
          tui.setFocus(target || null); opening.focus?.();
          if (tui.getFocusedComponent() === panel) panel.handleInput(data);
          else target?.handleInput?.(data);
        } };
        focusOwners.set(tui, owner);
        panel.onRetire = () => { if (focusOwners.get(tui) === owner) focusOwners.delete(tui); };
        panel.retiredInput = (data) => {
          if (tui.getFocusedComponent() !== panel) return;
          const successor = focusOwners.get(tui);
          if (successor && successor !== owner) successor.handoff(data, previous);
          else { const target = mountedEditor(tui, previous); tui.setFocus(target || null); target?.handleInput?.(data); }
          tui.requestRender();
        };
        opening.close = () => panel.close();
        opening.yield = () => {
          // Never restore over another prompt that has already taken focus.
          panel.suspend(true);
          if (tui.getFocusedComponent() === panel) tui.setFocus(previous);
        };
        opening.focus = () => {
          if (!active(ctx, mine) || open !== opening) return;
          const current: any = tui.getFocusedComponent();
          // Built-in selectors do not emit ui_prompt spans. Only the public
          // editor boundary is eligible to lend focus; never borrow a selector.
          const editor = typeof current?.getText === 'function' && typeof current?.setText === 'function';
          const available = !hostPrompt && (current === panel || editor);
          panel.suspend(!available);
          if (available && current !== panel) { previous = current; tui.setFocus(panel); }
        };
        // Host selectors request a render on open/close. Reconcile focus at that
        // boundary too, without a timer, a displaced UI promise or private APIs.
        panel.beforeRender = () => opening.focus?.();
        // setWidget mounts synchronously after this factory returns. Claim focus
        // afterwards, without retaining a custom-UI promise or replacing an editor.
        queueMicrotask(() => opening.focus?.());
        return panel;
      }, { placement: 'aboveEditor' });
      ambient(ctx); displayError = undefined;
    } catch (error) {
      if (open === opening) { opening.yield?.(); open = undefined; }
      ambient(ctx); presentationFailed(ctx, error, 'display');
    }
  }

  pi.registerCommand('asks', {
    description: 'Reopen this session’s paused private questions. Esc restores the editor; the question stays visible and pending, and unsaved drafts are discarded.',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui') { ctx.ui.notify('Private asks require interactive Pi TUI.', 'warning'); return; }
      if (!context) bind(ctx);
      if (!active(ctx, epoch)) { ctx.ui.notify('Session is changing; reopen /asks when ready.', 'info'); return; }
      const state = project(ctx);
      if (state.storageUnconfirmed) {
        ambient(ctx); ctx.ui.notify(plain(storageFailure()), 'error');
        if (!open && state.pending.length) {
          const id = args.trim() || undefined;
          if (!id || state.pending.some((question) => question.id === id)) present(ctx, id);
        }
        return;
      }
      if (open) { ctx.ui.notify('A private question is already open.', 'info'); return; }
      if (!state.pending.length) {
        ambient(ctx);
        const waiting = [...state.answers.values()].filter((answer) => !state.received.has(answer.answerId));
        ctx.ui.notify(waiting.length
          ? `No pending private questions. ${waiting.length} saved feedback item(s) await an actual host receipt:\n` +
            waiting.map((answer) => `${plain(answer.prompt.question)}\n${plain(answer.answer.text)}\nAnswer: ${answer.answerId}`).join('\n\n') +
            '\n\nDelivery may still be queued. If it was interrupted, quit Pi and resume this original session to recover with the same answer identities. Do not submit again; /reload is not a delivery retry.'
          : 'No pending private questions.', 'info');
        return;
      }
      const initialId = args.trim() || undefined;
      if (initialId && !state.pending.some((question) => question.id === initialId)) {
        ctx.ui.notify('That private question is not pending on this session branch.', 'warning'); return;
      }
      present(ctx, initialId);
    },
  });
}
