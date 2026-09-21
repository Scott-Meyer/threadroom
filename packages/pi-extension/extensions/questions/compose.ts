import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerNativeAsks } from '../native/index.ts';
import type { NativeQuestionPresentation } from '../native/presentation.ts';
import { createQuestionHost, supportsQuestionHost } from './host.ts';
import { registerBlockingQuestions } from './tool.ts';

/** Explicit private-question composition. Registers each producer once; does not
 * install resources, replace another extension, or connect to Threadroom. */
export function registerPrivateQuestions(pi: ExtensionAPI) {
  let host: ReturnType<typeof createQuestionHost> | undefined;
  let owner: { manager: object; sessionId: string } | undefined;
  let foreign = false;
  function ensure(ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!host || owner?.manager !== ctx.sessionManager || owner.sessionId !== sessionId) {
      host?.dispose(); host = createQuestionHost(ctx); owner = { manager: ctx.sessionManager, sessionId }; host.suspend(foreign);
    }
    return host;
  }
  const presentation: NativeQuestionPresentation = {
    canPresent(context) { return supportsQuestionHost(context); },
    connect(binding) {
      type Handle = { detach(): void; answered(): void; require(value: boolean): void };
      const captured = ensure(binding.context), handles = new Map<string, Handle>(); let live = true;
      return {
        replace(questions, state) {
          if (!live) return;
          const pending = new Set(questions.map((question) => question.id));
          const answered = new Set(state?.answeredQuestionIds || []);
          const required = new Set(state?.requiredQuestionIds || []);
          for (const [id, handle] of handles) if (!pending.has(id)) {
            if (answered.has(id)) handle.answered(); else handle.detach();
            handles.delete(id);
          }
          for (const question of questions) {
            let handle = handles.get(question.id);
            if (!handle) {
              handle = captured.enqueue({ id: `native:${question.id}`, mode: 'async', questions: [{ id: question.id, question: question.prompt.question,
                header: question.prompt.header, context: question.prompt.context, options: question.prompt.options,
                multiSelect: question.prompt.multiSelect, plainPreview: true, allowNotes: false }],
                commit(questionId, answer) {
                  if (!live) throw Object.assign(new Error('Private source detached.'), { code: 'presentation_detached' });
                  binding.commit({ questionId, text: answer.answer || '', optionIndex: answer.optionIndex, optionIndices: answer.optionIndices });
                },
                releaseRequirement(questionId) {
                  if (!live) return;
                  binding.cancelWait(questionId);
                } });
              handles.set(question.id, handle);
            }
            handle.require(required.has(question.id));
          }
        },
        reveal(questionId, options) {
          if (!live) return false;
          // Automatic resume preserves an existing blocker; explicit /asks ID can
          // select another pending question. Arrival itself does not steal drafts.
          if (!questionId && captured.snapshot().current?.tab.mode === 'blocking') {
            if (options?.focus) captured.activate();
            return true;
          }
          const id = questionId || handles.keys().next().value;
          if (id && handles.has(id)) { captured.select(`native:${id}`, id); if (options?.focus) captured.activate(); return true; }
          return false;
        },
        dispose() { if (!live) return; live = false; captured.dispose(); handles.clear(); if (host === captured) { host = undefined; owner = undefined; } },
      };
    },
  };
  const native = registerNativeAsks(pi, { presentation, waitToolName: 'ask_user_question', registerStandaloneTool: false });
  registerBlockingQuestions(pi, async (group, ctx, signal) => {
    if (!supportsQuestionHost(ctx)) throw Object.assign(new Error('This Pi host does not expose inline widgets; no question was presented and no human declined.'), { code: 'unsupported_host' });
    const accept = native.captureAdmission(ctx);
    const handle = ensure(ctx).enqueue(group), detach = () => handle.detach();
    if (signal?.aborted) detach(); else signal?.addEventListener('abort', detach, { once: true });
    try { return { result: await handle.outcome!, accept }; } finally { signal?.removeEventListener('abort', detach); }
  }, native.waitForQuestion, native.captureAdmission,
  (toolCallId, question, ctx, signal) => native.askQuestion(toolCallId, question, signal, ctx));
  pi.on('ui_prompt_start', () => { foreign = true; host?.suspend(true); });
  pi.on('ui_prompt_end', () => { foreign = false; host?.suspend(false); });
  return { snapshot: () => host?.snapshot(), dispose() { host?.dispose(); host = undefined; owner = undefined; } };
}
