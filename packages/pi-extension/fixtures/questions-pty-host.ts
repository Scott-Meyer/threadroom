import { registerPrivateQuestions } from '../extensions/questions/index.ts';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';

// Synthetic provider and input only. The public setup prompt acquires a read-only
// TUI reference once per process; it is not repeated on /reload. No UI/tool patch.
const observerKey = Symbol.for('threadroom.test.question-observer.v1');
export default function(pi: any) {
  const log = (record: any) => appendFileSync(process.env.OWNED_QUESTION_LOG!, JSON.stringify({ at: Date.now(), pid: process.pid, ...record }) + '\n');
  const matrix = process.env.OWNED_QUESTION_MATRIX === '1', marker = process.env.OWNED_QUESTION_RELEASE! + '.append-failed';
  const runtime = matrix ? { ...pi, appendEntry(type: string, data: any) {
    if (type === 'threadroom.native.answer.v1' && !existsSync(marker)) {
      writeFileSync(marker, 'failed exactly once'); log({ event: 'controlled_append_failure', questionId: data.questionId });
      throw new Error('TEST_WRITE_FAILED \x1b[31mDATA\u202e');
    }
    return pi.appendEntry(type, data);
  } } : pi;
  const controller = registerPrivateQuestions(runtime), nonce = `${process.pid}:${Date.now()}`;
  let stopObserve: undefined | (() => void);
  pi.on('session_shutdown', () => { stopObserve?.(); stopObserve = undefined; log({ event: 'observer_detached', nonce }); });
  pi.on('session_start', async (_event: any, ctx: any) => {
    let reference = (globalThis as any)[observerKey]?.deref();
    if (!reference) {
      await ctx.ui.custom((tui: any, _theme: any, _keys: any, done: any) => {
        reference = tui; (globalThis as any)[observerKey] = new WeakRef(tui); done(undefined);
        return { render() { return []; }, invalidate() {} };
      });
      log({ event: 'test_setup' });
    }
    stopObserve?.();
    stopObserve = ctx.ui.onTerminalInput((data: string) => {
      if (data !== '\x1b[24~') return;
      const focus = reference.getFocusedComponent(), editorLike = typeof focus?.getText === 'function' && typeof focus?.setText === 'function';
      log({ event: 'observation', nonce, snapshot: controller.snapshot(), rows: reference.terminal.rows, width: reference.terminal.columns,
        editorLike, nonemptyFocus: !!focus?.render, lines: focus?.render?.(reference.terminal.columns) || [], editor: ctx.ui.getEditorText(), ...(matrix ? { branch: ctx.sessionManager.getBranch() } : {}) });
      const foreign = process.env.OWNED_QUESTION_RELEASE! + '.foreign';
      if (matrix && existsSync(foreign)) {
        unlinkSync(foreign); // Test one-shot survives reload deliberately.
        queueMicrotask(async () => { log({ event: 'foreign_started', nonce }); const answer = await ctx.ui.select('TEST foreign selector', ['Stay', 'Return']); log({ event: 'foreign_ended', nonce, answer }); });
      }
      return { consume: true };
    });
    log({ event: 'observer_attached', nonce });
    log({ event: 'ready', nonce, sessionId: ctx.sessionManager.getSessionId(), registrations: pi.getAllTools().map((tool: any) => tool.name) });
  });
  pi.on('tool_execution_start', (event: any, ctx: any) => {
    if (event.toolName === 'ask_user_question_async' && event.toolCallId === 'NATIVE_A') ctx.ui.setEditorText('KEEP_ORDINARY_EDITOR');
    log({ event: 'tool_start', name: event.toolName, id: event.toolCallId });
  });
  pi.on('tool_execution_end', (event: any) => log({ event: 'tool_end', name: event.toolName, id: event.toolCallId, result: event.result }));
  pi.on('agent_settled', (_event: any, ctx: any) => log({ event: 'settled', branch: ctx.sessionManager.getBranch(), snapshot: controller.snapshot(), editor: ctx.ui.getEditorText() }));
  pi.registerCommand('question-test-ledger', { description: 'Read TEST private branch', handler(_args: any, ctx: any) { log({ event: 'ledger', branch: ctx.sessionManager.getBranch(), snapshot: controller.snapshot(), editor: ctx.ui.getEditorText() }); } });
  pi.registerTool({ name: 'question_test_work', label: 'TEST independent work', description: 'Controlled local work overlaps private question interaction', parameters: Type.Object({}),
    async execute() {
      log({ event: 'work_started' }); const deadline = Date.now() + 60000;
      while (!existsSync(process.env.OWNED_QUESTION_RELEASE!) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      if (!existsSync(process.env.OWNED_QUESTION_RELEASE!)) throw new Error('TEST independent work was not released.');
      log({ event: 'work_finished' }); return { content: [{ type: 'text', text: 'TEST_WORK_FINISHED' }] };
    },
  });
  pi.registerProvider('owned-question-test', { api: 'owned-question-test-api', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-only',
    models: [{ id: 'local', name: 'TEST question provider', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4000 }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const results = context.messages.filter((message: any) => message.role === 'toolResult');
        const feedback = context.messages.filter((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('Saved private human feedback for native ask'));
        let content: any[], stopReason = 'toolUse';
        if (feedback.length) { log({ event: 'provider_feedback', feedback }); content = [{ type: 'text', text: 'TEST_FEEDBACK_CONSUMED' }]; stopReason = 'stop'; }
        else if (!results.some((message: any) => message.toolName === 'ask_user_question_async')) content = [
          { type: 'toolCall', id: 'NATIVE_A', name: 'ask_user_question_async', arguments: { question: 'TEST_ASYNC_A question?', options: ['Quiet', 'Bright'] } },
          { type: 'toolCall', id: 'NATIVE_C', name: 'ask_user_question_async', arguments: { question: 'TEST_ASYNC_C backlog?', options: [{ label: '同じ' + '長い'.repeat(30), preview: 'FIRST_PREVIEW' }, { label: '同じ' + '長い'.repeat(30), preview: '**SECOND_LITERAL**\n' + Array.from({ length: 30 }, (_value, index) => `PREVIEW_${index}`).join('\n') }] } },
        ];
        else if (!results.some((message: any) => message.toolName === 'question_test_work')) content = [{ type: 'toolCall', id: 'WORK', name: 'question_test_work', arguments: {} }];
        else if (!results.some((message: any) => message.toolName === 'ask_user_question')) content = [{ type: 'toolCall', id: 'BLOCK_B', name: 'ask_user_question', arguments: { questions: [
          { header: 'B1', question: 'TEST_BLOCK_B1?', options: [{ label: 'Wait' }, { label: 'Go' }] },
          { header: 'B2', question: 'TEST_BLOCK_B2 checks?', multiSelect: true, options: [{ label: 'North' }, { label: 'South' }] },
        ] } }];
        else { content = [{ type: 'text', text: 'TEST_AI_CONTINUED' }]; stopReason = 'stop'; }
        const output = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: output }); stream.push({ type: 'done', reason: stopReason, message: output }); stream.end();
      });
      return stream;
    },
  });
}
