import { registerNativeAsks } from '../extensions/native/index.ts';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync, existsSync } from 'node:fs';

export default function fixture(pi: any) {
  const log = (value: any) => appendFileSync(process.env.NATIVE_TEST_LOG!, JSON.stringify(value) + '\n');
  globalThis.fetch = ((...args: any[]) => { log({ event: 'fetch', args }); throw new Error('Native test forbids HTTP'); }) as any;
  let nativeAsk: any;
  const instrument = (ctx: any) => ({ ...ctx, ui: { ...ctx.ui,
    setWidget(key: string, content: any, options: any) {
      let shown = false;
      ctx.ui.setWidget(key, typeof content === 'function' ? (tui: any, theme: any) => {
        const component = content(tui, theme);
        shown = !!component.handleInput;
        return component;
      } : content, options);
      if (key === 'native-asks' && content) log({ event: shown ? 'question_shown' : 'question_paused',
        placement: options?.placement ?? 'aboveEditor', editor: ctx.ui.getEditorText() });
    },
  } });
  registerNativeAsks({ ...pi,
    on(name: string, handler: any) { pi.on(name, (event: any, ctx: any) => handler(event, instrument(ctx))); },
    registerCommand(name: string, definition: any) { pi.registerCommand(name,
      { ...definition, handler: (args: any, ctx: any) => definition.handler(args, instrument(ctx)) }); },
    registerTool(definition: any) {
      nativeAsk = { ...definition, execute: (id: any, args: any, signal: any, update: any, ctx: any) =>
        definition.execute(id, args, signal, update, instrument(ctx)) };
      pi.registerTool(nativeAsk);
    },
  });
  pi.registerCommand('native-seed-idle', { description: 'Test fixture only', async handler(_args: any, ctx: any) {
    const result = await nativeAsk.execute('native-idle-ask', { question: 'An idle follow-up?',
      options: [{ label: 'Soft', preview: 'A soft finish.' }] }, undefined, () => {}, ctx);
    log({ event: 'idle_seed', result });
  } });
  pi.registerCommand('native-seed-during-prompt', { description: 'Test fixture only', async handler(_args: any, ctx: any) {
    const other = ctx.ui.input('FOREIGN_PROMPT_BEFORE_NATIVE').then((answer: any) => log({ event: 'foreign_seed_finished', answer }));
    const result = await nativeAsk.execute('native-during-prompt-ask', { question: 'Created during another prompt?',
      options: ['First', 'Second'] }, undefined, () => {}, ctx);
    log({ event: 'during_prompt_seed', result });
    await other;
  } });
  pi.registerCommand('native-seed-delayed', { description: 'Test fixture only', handler(args: string, ctx: any) {
    setTimeout(async () => {
      const result = await nativeAsk.execute(`native-delayed-${args}`, { question: `Question arriving during /${args}?` }, undefined, () => {}, ctx);
      log({ event: 'delayed_seed', selector: args, result });
    }, 700);
  } });
  pi.on('session_before_tree', () => ({ summary: { summary: 'Native test branch summary.' } }));
  pi.on('session_tree', (_event: any, ctx: any) => log({ event: 'tree_emitted', idle: ctx.isIdle() }));
  pi.registerCommand('native-tree-recover', { description: 'Test fixture only', async handler(_args: any, ctx: any) {
    const created = await nativeAsk.execute('native-tree-ask', { question: 'Feedback saved before tree settlement?' }, undefined, () => {}, ctx);
    pi.appendEntry('threadroom.native.answer.v1', { sessionId: ctx.sessionManager.getSessionId(), answerId: 'answer-tree-recovery',
      questionId: created.details.id, prompt: { question: 'Feedback saved before tree settlement?' }, answer: { text: 'Recover after controller finally.' } });
    const target = ctx.sessionManager.getBranch().at(-1).id;
    pi.appendEntry('native.test.anchor', {});
    await ctx.navigateTree(target, { summarize: true });
    log({ event: 'tree_finished', idle: ctx.isIdle() });
  } });
  pi.on('session_start', () => log({ event: 'ready' }));
  pi.on('ui_prompt_start', (event: any) => log({ event: 'ui_prompt_start', kind: event.kind }));
  pi.on('ui_prompt_end', (event: any) => log({ event: 'ui_prompt_end', kind: event.kind }));
  pi.on('tool_execution_start', (event: any, ctx: any) => log({ event: 'tool_start', name: event.toolName, editor: ctx.ui.getEditorText() }));
  pi.on('tool_execution_end', (event: any, ctx: any) => log({ event: 'tool_end', name: event.toolName, editor: ctx.ui.getEditorText(), result: event.result }));
  pi.on('agent_settled', () => log({ event: 'settled' }));
  pi.registerCommand('native-probe', { description: 'Test fixture only', handler(_args: any, ctx: any) {
    log({ event: 'probe', sessionId: ctx.sessionManager.getSessionId(), branch: ctx.sessionManager.getBranch(), editor: ctx.ui.getEditorText() });
    ctx.ui.notify('NATIVE_PROBE_SAVED', 'info');
  } });
  pi.registerTool({ name: 'native_test_work', label: 'Independent work', description: 'Test work continues independently.',
    parameters: { type: 'object', properties: {} }, async execute(_id: any, _args: any, _signal: any, _update: any, ctx: any) {
      log({ event: 'work_started' });
      const other = await ctx.ui.input('FOREIGN_BLOCKING_PROMPT');
      log({ event: 'foreign_finished', other });
      const start = Date.now();
      while (!existsSync(process.env.NATIVE_TEST_RELEASE!) && Date.now() - start < 20000) await new Promise((done) => setTimeout(done, 50));
      log({ event: 'work_finished' });
      return { content: [{ type: 'text', text: 'NATIVE_WORK_FINISHED' }], details: {} };
    } });
  pi.registerProvider('native-test', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'local-test-only', api: 'native-test-api',
    models: [{ id: 'local', name: 'Local deterministic host test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4000 }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      (async () => {
        const feedback = context.messages.filter((message: any) =>
          JSON.stringify(message.content).includes('Saved private human feedback for native ask'));
        const results = context.messages.filter((message: any) => message.role === 'toolResult');
        let content: any;
        let stopReason: any = 'stop';
        if (feedback.length) {
          log({ event: 'feedback_seen', feedback });
          content = [{ type: 'text', text: 'NATIVE_FEEDBACK_RECEIVED' }];
        } else if (!results.some((result: any) => result.toolName === 'ask_user_question_async')) {
          await new Promise((done) => setTimeout(done, 1000));
          content = [{ type: 'toolCall', id: 'native-host-ask', name: 'ask_user_question_async',
            arguments: { question: 'Which detail should I refine?', context: 'Continue working while I consider this.',
              options: [{ label: 'Quiet', preview: 'A quieter tail.' }, 'Bright'] } }];
          stopReason = 'toolUse';
        } else if (!results.some((result: any) => result.toolName === 'native_test_work')) {
          content = [{ type: 'toolCall', id: 'native-host-work', name: 'native_test_work', arguments: {} }];
          stopReason = 'toolUse';
        } else content = [{ type: 'text', text: 'NATIVE_AI_CONTINUED' }];
        const output: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason,
          timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: output });
        stream.push({ type: 'done', reason: stopReason, message: output }); stream.end();
      })().catch((error) => { log({ event: 'provider_error', error: String(error) }); stream.end(); });
      return stream;
    },
  });
}
