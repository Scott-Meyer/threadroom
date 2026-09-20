import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveSdkPeer } from './sdk-peer.mjs';
const [root, sdk] = process.argv.slice(2);
const host = (path) => import(pathToFileURL(resolve(sdk, path)).href);
const { loadExtensions } = await host('dist/core/extensions/loader.js');
const loaded = await loadExtensions([resolve(root, 'packages/pi-extension/fixtures/main-wiring-proof.ts')], root);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0], names = globalThis[Symbol.for('threadroom.test.main-registration')];
for (const name of ['ask_user_question', 'ask_user_question_async', 'threadroom_ask', 'threadroom']) {
  assert.equal(names.filter((registered) => registered === name).length, 1, `Real MAIN must register ${name} exactly once`);
  assert.ok(extension.tools.has(name));
}
let appends = 0, sends = 0;
loaded.runtime.appendEntry = () => { appends++; }; loaded.runtime.sendMessage = () => { sends++; };
const ctx = { mode: 'print', hasUI: false, ui: {} };
await assert.rejects(() => extension.tools.get('ask_user_question').definition.execute('print-test', { questions: [{ question: 'TEST MAIN prompt?', options: [{ label: 'One', description: 'TEST first' }, { label: 'Two', description: 'TEST second' }] }] }, undefined, () => {}, ctx), { code: 'unsupported_host' }, 'unsupported print must not fabricate a human cancellation result');
const async = await extension.tools.get('ask_user_question_async').definition.execute('print-async', { question: 'TEST MAIN async prompt?' }, undefined, () => {}, ctx);
assert.equal(async.details.status, 'unsupported_host'); assert.notEqual(async.details.saved, true);
const olderTui = { mode: 'tui', hasUI: true, ui: {} };
await assert.rejects(() => extension.tools.get('ask_user_question').definition.execute('older-tui-blocking', { questions: [{ question: 'TEST older SDK prompt?', options: [{ label: 'One' }, { label: 'Two' }] }] }, undefined, () => {}, olderTui), { code: 'unsupported_host' }, 'missing widgets must reject before blocking enqueue/wait');
const olderAsync = await extension.tools.get('ask_user_question_async').definition.execute('older-tui-async', { question: 'TEST older SDK async prompt?' }, undefined, () => {}, olderTui);
assert.equal(olderAsync.details.status, 'unsupported_host'); assert.equal(olderAsync.details.saved, false);
assert.equal(appends, 0, 'unsupported hosts cannot create question rows'); assert.equal(sends, 0);
// Stock public UI port: no getCoreEditor and deliberately no raw terminal hook.
// A blocker still claims the shared pane and returns to the exact input on abort.
const { SessionManager } = await host('dist/core/session-manager.js');
const themes = await host('dist/modes/interactive/theme/theme.js'); themes.initTheme('dark', false);
const { TuiMainScreen, Editor } = await import(resolveSdkPeer(sdk, '@earendil-works/pi-tui'));
const terminal = { rows: 18, columns: 80, kittyProtocolActive: false, write() {}, hideCursor() {}, showCursor() {} };
const tui = new TuiMainScreen(terminal);
const input = new Editor(tui, { borderColor: text => text, selectList: {} });
input.setText('TEST_STOCK_DRAFT'); input.handleInput('\x1b[D');
tui.addChild(input); tui.setFocus(input);
const manager = SessionManager.inMemory(root);
let widget, notices = [], selections = [], selectionPrompts = [];
const stock = { mode: 'tui', hasUI: true, cwd: root, isIdle: () => true,
  sessionManager: manager, ui: { // Older Pi contexts have no project-trust method; shared config must still fail closed.
    theme: themes.theme, notify(text) { notices.push(text); }, setStatus() {},
    async select(title, choices) { selectionPrompts.push({ title, choices }); return selections.shift(); },
    setWidget(_key, factory) {
      if (widget) { widget.dispose?.(); tui.removeChild(widget); widget = undefined; }
      if (factory) { widget = factory(tui, themes.theme); tui.addChild(widget); }
    },
  } };
loaded.runtime.appendEntry = (type, data) => { appends++; manager.appendCustomEntry(type, data); };
let activeTools = [...extension.tools.keys()];
loaded.runtime.getActiveTools = () => [...activeTools]; loaded.runtime.setActiveTools = (names) => { activeTools = [...names]; };
for (const handler of extension.handlers.get('session_start') || []) await handler({}, stock);
assert.deepEqual(activeTools.sort(), ['ask_user_question', 'ask_user_question_async'], 'shared tools are inactive by default');
const configPath = resolve(process.env.PI_CODING_AGENT_DIR, 'threadroom.json');
await extension.commands.get('threadroom-config').handler('project on', stock);
assert.match(notices.at(-1), /trusted project/, 'older contexts cannot grant project overrides');
selections.push('Computer-wide default', 'On');
await extension.commands.get('threadroom').handler('', stock);
assert.deepEqual(selectionPrompts.map(({ title }) => title), ['Configure shared Threadroom', 'Computer-wide shared Threadroom'],
  'disabled /threadroom opens the extension configuration menu');
assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { shared: true }, 'the /threadroom menu writes the computer-wide setting');
await extension.commands.get('threadroom-config').handler('computer inherit', stock);
assert.equal(existsSync(configPath), false, 'extension command can restore the built-in default'); notices = [];
const abort = new AbortController();
const blocker = extension.tools.get('ask_user_question').definition.execute('stock-blocking-only', { questions: [{ question: 'TEST stock blocker?', options: [{ label: 'One' }, { label: 'Two' }] }] }, abort.signal, () => {}, stock);
const blockerOutcome = blocker.catch(error => error);
await new Promise(done => setImmediate(done));
assert.ok(widget); assert.equal(tui.getFocusedComponent(), widget, 'stock blocking arrival must claim the shared question surface');
const required = widget.render(120).join('\n'); assert.match(required, /★ Response required/); assert.doesNotMatch(required, /Shift\+Tab|collapse/);
await extension.commands.get('asks').handler('', stock);
assert.equal(tui.getFocusedComponent(), widget, 'blocking-only /asks retains the required pane without getter or raw input hook');
assert.equal(appends, 0, 'blocking activation is not an async question append');
assert.equal(notices.length, 0, 'blocking-only /asks must not report no pending questions');
abort.abort(); await blockerOutcome; await new Promise(done => setImmediate(done));
assert.equal(tui.getFocusedComponent(), input); input.handleInput('X');
assert.equal(input.getText(), 'TEST_STOCK_DRAFXT', 'activation and cancellation retain original SDK Editor caret');
const pending = await extension.tools.get('ask_user_question_async').definition.execute('stock-async', { question: 'TEST stock async?' }, undefined, () => {}, stock);
assert.equal(pending.details.status, 'pending'); assert.equal(appends, 1, 'stock SDK async is admitted and saved');
assert.deepEqual(pending.details.waitWith, { tool: 'ask_user_question', questionId: pending.details.id });
assert.equal(tui.getFocusedComponent(), input, 'stock async arrival remains passive');
const promoted = extension.tools.get('ask_user_question').definition.execute('stock-promoted', { questionId: pending.details.id }, undefined, () => {}, stock);
await new Promise(done => setImmediate(done));
assert.equal(tui.getFocusedComponent(), widget, 'waiting on the existing ID makes its original tab required');
assert.match(widget.render(120).join('\n'), /★ Response required/);
widget.handleInput('TEST_STOCK_ANSWER'); widget.handleInput('\r');
const promotedResult = await promoted; await new Promise(done => setImmediate(done));
assert.equal(appends, 2, 'promoted answer is persisted by its original native source');
assert.equal(promotedResult.details.questionId, pending.details.id);
assert.equal(promotedResult.details.answers[0].answer, 'TEST_STOCK_ANSWER');
assert.equal(promotedResult.details.receivedNativeAnswerIds.length, 1);
assert.equal(tui.getFocusedComponent(), input, 'promoted completion returns to the exact original input when no async tab remains');
assert.equal(sends, 0, 'the same saved answer is reserved for the blocking result instead of duplicate async feedback');
manager.appendMessage({ role: 'toolResult', toolCallId: 'stock-promoted', toolName: 'ask_user_question',
  content: promotedResult.content, details: promotedResult.details, isError: false, timestamp: Date.now() });
for (const handler of extension.handlers.get('turn_end') || []) await handler({}, stock);
assert.equal(sends, 0, 'persisted blocking receipt prevents later duplicate feedback');

const cancellable = await extension.tools.get('ask_user_question_async').definition.execute('stock-cancellable', { question: 'TEST cancellable async?' }, undefined, () => {}, stock);
const cancelling = extension.tools.get('ask_user_question').definition.execute('stock-cancel-wait', { questionId: cancellable.details.id }, undefined, () => {}, stock);
await new Promise(done => setImmediate(done)); widget.handleInput('\x1b');
const cancelled = await cancelling; await new Promise(done => setImmediate(done));
assert.equal(cancelled.details.cancelled, true, 'Escape releases only the blocking wait');
assert.equal(tui.getFocusedComponent(), input, 'released wait repays the exact modal loan');
await extension.commands.get('asks').handler(cancellable.details.id, stock); assert.equal(tui.getFocusedComponent(), widget);
widget.handleInput('TEST_LATER_ASYNC_ANSWER'); widget.handleInput('\r'); await new Promise(done => setImmediate(done));
assert.equal(appends, 4, 'released question remains pending and can be answered later');
assert.equal(sends, 1, 'later ordinary async completion follows the original feedback path once');
const afterAnswer = await extension.tools.get('ask_user_question').definition.execute('stock-after-answer', { questionId: cancellable.details.id }, undefined, () => {}, stock);
assert.equal(afterAnswer.details.waitStatus, 'already_queued'); assert.deepEqual(afterAnswer.details.answers, []);
assert.equal(afterAnswer.details.receivedNativeAnswerIds, undefined, 'a queued async delivery is not falsely claimed by a second tool result');
assert.equal(sends, 1, 'answer-before-wait cannot enqueue or return a duplicate answer path');

const interrupted = await extension.tools.get('ask_user_question_async').definition.execute('stock-interrupted', { question: 'TEST save then abort?' }, undefined, () => {}, stock);
const interruption = new AbortController();
const interruptedWait = extension.tools.get('ask_user_question').definition.execute('stock-interrupted-wait', { questionId: interrupted.details.id }, interruption.signal, () => {}, stock);
await new Promise(done => setImmediate(done)); widget.handleInput('TEST_SAVED_BEFORE_ABORT'); widget.handleInput('\r'); interruption.abort();
await assert.rejects(interruptedWait); await new Promise(done => setImmediate(done));
assert.equal(appends, 6, 'answer remains durably saved when the waiting tool aborts before its result');
assert.equal(sends, 2, 'failed answer handoff releases its claim back to ordinary async feedback');

const detached = await extension.tools.get('ask_user_question_async').definition.execute('stock-detached', { question: 'TEST settle then transition?' }, undefined, () => {}, stock);
const detachedWait = extension.tools.get('ask_user_question').definition.execute('stock-detached-wait', { questionId: detached.details.id }, undefined, () => {}, stock);
const detachedFresh = extension.tools.get('ask_user_question').definition.execute('stock-detached-fresh', { questions: [{ question: 'TEST fresh settle then transition?', options: [{ label: 'One' }, { label: 'Two' }] }] }, undefined, () => {}, stock);
let rpcStep = 0, resolveRpcSubmit;
const rpc = { ...stock, mode: 'rpc', ui: { async select(_title, choices) {
  rpcStep++;
  if (rpcStep === 1) return choices.find(choice => choice.startsWith('[ ] 1.'));
  if (rpcStep === 2) return choices.find(choice => choice.startsWith('Next:'));
  return new Promise(resolve => { resolveRpcSubmit = () => resolve(choices.find(choice => choice.startsWith('Submit:'))); });
} } };
const detachedRpc = extension.tools.get('ask_user_question').definition.execute('stock-detached-rpc', { questions: [{ question: 'TEST RPC settle then transition?', options: [{ label: 'One' }, { label: 'Two' }] }] }, undefined, () => {}, rpc);
await new Promise(done => setImmediate(done)); assert.equal(typeof resolveRpcSubmit, 'function');
widget.handleInput('TEST_FRESH_BEFORE_TRANSITION'); widget.handleInput('\r'); widget.handleInput('\r');
widget.handleInput('TEST_SAVED_BEFORE_TRANSITION'); widget.handleInput('\r');
resolveRpcSubmit();
const detachedAlreadyQueued = extension.tools.get('ask_user_question').definition.execute('stock-detached-already', { questionId: cancellable.details.id }, undefined, () => {}, stock);
// Match ExtensionRunner's sequential awaited dispatch: each synchronous handler
// yields a microtask before the next one. The native activation fence must close
// answer, fresh-group, and immediate non-answer outcomes before the later
// blocking-controller handler runs.
const detachedWaitRejected = assert.rejects(detachedWait, { code: 'presentation_detached' });
const detachedFreshRejected = assert.rejects(detachedFresh, { code: 'presentation_detached' });
const detachedRpcRejected = assert.rejects(detachedRpc, { code: 'presentation_detached' });
const detachedAlreadyRejected = assert.rejects(detachedAlreadyQueued, { code: 'presentation_detached' });
for (const handler of extension.handlers.get('session_before_switch') || []) await handler({}, stock);
await detachedWaitRejected; await detachedFreshRejected; await detachedRpcRejected; await detachedAlreadyRejected;
assert.equal(appends, 8, 'transition cannot erase the already saved native answer');
assert.equal(sends, 2, 'detached handoff cannot return and enqueue the same answer');
await assert.rejects(extension.tools.get('ask_user_question').definition.execute('blocked-new', { questions: [{ question: 'TEST blocked new?', options: [{ label: 'One' }, { label: 'Two' }] }] }, undefined, () => {}, stock), { code: 'presentation_detached' });
assert.equal((await extension.tools.get('ask_user_question_async').definition.execute('blocked-async', { question: 'TEST blocked async?' }, undefined, () => {}, stock)).details.status, 'session_changing');
await extension.commands.get('asks').handler('', stock); assert.match(notices.at(-1), /run \/reload/);
assert.equal(sends, 2, 'unknown transition outcome stays closed instead of guessing when to flush');
console.log(JSON.stringify({ syntheticNotScott: true, humanAcceptance: false, realMainFactory: true, rawProducerRegistrationsExactlyOnce: true, sharedToolsRemainSeparate: true, sharedToolsDefaultOff: true, printNotHumanCancel: true, olderSdkCapabilityBoundary: true, stockBlockingOnlyAsks: true, stockAsyncPersistence: true, stockPromotionIdentity: true, stockPromotionNoDuplicate: true, stockPromotionCancelPreservesQuestion: true, stockAnswerBeforeWaitNoDuplicate: true, stockSaveThenAbortRecoversFeedback: true, stockSettledHandoffBoundarySafe: true, stockFreshCompletionBoundarySafe: true, stockRpcCompletionBoundarySafe: true, stockImmediateWaitBoundarySafe: true, stockTransitionGatesBothProducers: true, stockUnknownTransitionStaysClosed: true, stockOriginalEditorCaret: true, registrations: names }, null, 2));
