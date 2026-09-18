import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createHash, randomUUID } from 'node:crypto';
import { AskPanel, pendingCard, card, plain, type Feedback } from './ui.ts';

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

type Prompt = { question: string; context?: string; options?: { label: string; preview?: string }[] };
type Question = { sessionId: string; id: string; toolCallId: string; prompt: Prompt };
type Answer = { sessionId: string; answerId: string; questionId: string; prompt: Prompt;
  answer: { text: string; optionIndex?: number; selection?: { label: string; preview?: string } } };

/** Native/private asks have no service dependency and do not claim the blocking ask name. */
export function registerNativeAsks(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let epoch = 0;
  let paused = false;
  let navigating = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reopenWhenIdle = false;
  let open: { epoch: number; close?: () => void; panel?: AskPanel; yield?: () => void; focus?: () => void } | undefined;
  let hostPrompt = false;
  let submitted = new Set<string>();

  function project(ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    const questions = new Map<string, Question>();
    const answers = new Map<string, Answer>();
    const received = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch() as any[]) {
      if (entry.type === 'custom' && entry.data?.sessionId === sessionId) {
        if (entry.customType === QUESTION) questions.set(entry.data.id, entry.data);
        if (entry.customType === ANSWER) answers.set(entry.data.questionId, entry.data);
      }
      if (entry.type === 'custom_message' && entry.customType === FEEDBACK && entry.details?.sessionId === sessionId) {
        received.add(entry.details.answerId);
      }
    }
    // An answer is meaningful only with its original question on this branch.
    for (const id of answers.keys()) if (!questions.has(id)) answers.delete(id);
    return { sessionId, questions, answers, received,
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
    ctx.ui.setStatus('native-asks', state.pending.length || waiting
      ? `Asks: ${state.pending.length} pending${waiting ? ` · ${waiting} saved feedback` : ''} · /asks` : undefined);
    if (open && !state.pending.length) {
      const old = open; open = undefined; old.yield?.(); old.close?.();
    } else open?.panel?.update(state.pending);
    if (!open) ctx.ui.setWidget('native-asks', state.pending.length && active(ctx, epoch)
      ? (tui, theme) => pendingCard(state.pending, tui, theme) : undefined);
  }
  function flush(ctx: ExtensionContext) {
    if (!active(ctx, epoch) || ctx.mode !== 'tui') return;
    // isIdle includes tree summarization/compaction, not only agent streaming.
    if (!running && !ctx.isIdle()) { resumeAfterBoundary(ctx, epoch); return; }
    const state = project(ctx);
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
    ++epoch;
    clearTimeout(timer); timer = undefined; reopenWhenIdle = false;
    const old = open; open = undefined; old?.yield?.(); old?.close?.();
    if (context?.mode === 'tui') context.ui.setWidget('native-asks', undefined);
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
    card(theme.fg('accent', 'Private ask saved') + ` · ${entry.data?.id}\n${entry.data?.prompt.question}\nPresented in the input area; /asks reopens paused questions (answers are saved separately)`));
  pi.registerEntryRenderer<Answer>(ANSWER, (entry) =>
    card(`Private answer saved · ${entry.data?.answerId}\n${entry.data?.prompt.question}\n${entry.data?.answer.text}`));
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
      ? `Pending private ask · ${value.details.id} · shown in input area` : `Private ask: ${value.details?.status || 'unavailable'}`); },
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
        if (!old) pi.appendEntry(QUESTION, { sessionId: state.sessionId, id, toolCallId, prompt });
        const saved = project(ctx);
        if (!saved.questions.has(id)) throw new Error('Host did not save the question entry.');
        ambient(ctx);
        if (!old) void present(ctx, id);
        return result({ id, sessionId: state.sessionId, status: saved.answers.has(id) ? 'answered' : 'pending',
          pending: saved.pending.map((question) => ({ id: question.id, question: question.prompt.question.slice(0, 160) })) });
      } catch (error) { return result({ status: 'save_failed', id, error: plain(error) }); }
    },
  });


  function present(ctx: ExtensionContext, initialId?: string) {
    if (ctx.mode !== 'tui' || !active(ctx, epoch) || open) return;
    if (!running && !ctx.isIdle()) { resumeAfterBoundary(ctx, epoch, true); return; }
    const state = project(ctx);
    if (!state.pending.length) return;
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
                pi.appendEntry(ANSWER, answer); // Save prompt association + structured answer BEFORE wake.
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
      ambient(ctx);
    } catch (error) {
      if (open === opening) { opening.yield?.(); open = undefined; }
      ambient(ctx);
      ctx.ui.notify(`Private question presentation failed: ${plain(error)}. The saved question remains in /asks.`, 'error');
    }
  }

  pi.registerCommand('asks', {
    description: 'Reopen this session’s paused private questions. Esc restores the editor; the question stays visible and pending, and unsaved drafts are discarded.',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui') { ctx.ui.notify('Private asks require interactive Pi TUI.', 'warning'); return; }
      if (!context) bind(ctx);
      if (!active(ctx, epoch)) { ctx.ui.notify('Session is changing; reopen /asks when ready.', 'info'); return; }
      if (open) { ctx.ui.notify('A private question is already open.', 'info'); return; }
      const state = project(ctx);
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
