import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerNativeAsks } from '../native/index.ts';
import type { NativeQuestionPresentation } from '../native/presentation.ts';
import { createQuestionHost } from './host.ts';
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
  const presentation: NativeQuestionPresentation = { connect(binding) {
    const captured = ensure(binding.context), handles = new Map<string, { detach(): void }>(); let live = true;
    return {
      replace(questions) {
        if (!live) return;
        const pending = new Set(questions.map((question) => question.id));
        for (const [id, handle] of handles) if (!pending.has(id)) { handle.detach(); handles.delete(id); }
        for (const question of questions) {
          if (handles.has(question.id)) continue;
          const handle = captured.enqueue({ id: `native:${question.id}`, mode: 'async', questions: [{ id: question.id, question: question.prompt.question,
            context: question.prompt.context, options: question.prompt.options, plainPreview: true, allowNotes: false }],
            commit(questionId, answer) {
              if (!live) throw Object.assign(new Error('Private source detached.'), { code: 'presentation_detached' });
              binding.commit({ questionId, text: answer.answer || '', optionIndex: answer.optionIndex });
            } });
          handles.set(question.id, handle);
        }
      },
      reveal(questionId) {
        if (!live) return;
        // Automatic resume preserves an existing blocker; explicit /asks ID can
        // select another pending question. Arrival itself does not steal drafts.
        if (!questionId && captured.snapshot().current?.tab.mode === 'blocking') return;
        const id = questionId || handles.keys().next().value;
        if (id && handles.has(id)) captured.select(`native:${id}`, id);
      },
      dispose() { if (!live) return; live = false; captured.dispose(); handles.clear(); if (host === captured) { host = undefined; owner = undefined; } },
    };
  } };
  registerNativeAsks(pi, { presentation });
  registerBlockingQuestions(pi, async (group, ctx, signal) => {
    const handle = ensure(ctx).enqueue(group), detach = () => handle.detach();
    if (signal?.aborted) detach(); else signal?.addEventListener('abort', detach, { once: true });
    try { return await handle.outcome!; } finally { signal?.removeEventListener('abort', detach); }
  });
  pi.on('ui_prompt_start', () => { foreign = true; host?.suspend(true); });
  pi.on('ui_prompt_end', () => { foreign = false; host?.suspend(false); });
  return { snapshot: () => host?.snapshot(), dispose() { host?.dispose(); host = undefined; owner = undefined; } };
}
