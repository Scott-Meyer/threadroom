import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerBlockingQuestions } from '../extensions/questions/tool.ts';
import type { QuestionGroup, QuestionResult } from '../extensions/questions/types.ts';

// TEST-only injected presenter, exercised through the SDK-loaded registered tool.
export default function (pi: ExtensionAPI) {
  registerBlockingQuestions(pi, (group, ctx, signal) => {
    const ui = ctx.ui as typeof ctx.ui & {
      testPresent: (group: QuestionGroup, ctx: ExtensionContext, signal?: AbortSignal) => Promise<QuestionResult>;
    };
    return ui.testPresent(group, ctx, signal);
  }, (questionId, ctx, signal) => (ctx.ui as any).testWait(questionId, ctx, signal));
}
