import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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
// Stock public UI port: no getCoreEditor, and deliberately no raw terminal hook.
// Blocking-only /asks must still be a usable activation route through real MAIN.
const { SessionManager } = await host('dist/core/session-manager.js');
const themes = await host('dist/modes/interactive/theme/theme.js'); themes.initTheme('dark', false);
const { TuiMainScreen, Editor } = await import(resolveSdkPeer(sdk, '@earendil-works/pi-tui'));
const terminal = { rows: 18, columns: 80, kittyProtocolActive: false, write() {}, hideCursor() {}, showCursor() {} };
const tui = new TuiMainScreen(terminal);
const input = new Editor(tui, { borderColor: text => text, selectList: {} });
input.setText('TEST_STOCK_DRAFT'); input.handleInput('\x1b[D');
tui.addChild(input); tui.setFocus(input);
const manager = SessionManager.inMemory(root);
let widget, notices = [];
const stock = { mode: 'tui', hasUI: true, cwd: root, isIdle: () => true,
  isProjectTrusted: () => false, sessionManager: manager, ui: {
    theme: themes.theme, notify(text) { notices.push(text); }, setStatus() {},
    setWidget(_key, factory) {
      if (widget) { widget.dispose?.(); tui.removeChild(widget); widget = undefined; }
      if (factory) { widget = factory(tui, themes.theme); tui.addChild(widget); }
    },
  } };
loaded.runtime.appendEntry = (type, data) => { appends++; manager.appendCustomEntry(type, data); };
const abort = new AbortController();
const blocker = extension.tools.get('ask_user_question').definition.execute('stock-blocking-only', { questions: [{ question: 'TEST stock blocker?', options: [{ label: 'One' }, { label: 'Two' }] }] }, abort.signal, () => {}, stock);
const blockerOutcome = blocker.catch(error => error);
await new Promise(done => setImmediate(done));
assert.ok(widget); assert.equal(tui.getFocusedComponent(), input, 'stock blocking arrival must not interrupt input');
assert.match(widget.render(120).join('\n'), /\/asks selects questions/);
await extension.commands.get('asks').handler('', stock);
assert.equal(tui.getFocusedComponent(), widget, 'blocking-only /asks works without getter or raw input hook');
assert.equal(appends, 0, 'blocking activation is not an async question append');
assert.equal(notices.length, 0, 'blocking-only /asks must not report no pending questions');
abort.abort(); await blockerOutcome; await new Promise(done => setImmediate(done));
assert.equal(tui.getFocusedComponent(), input); input.handleInput('X');
assert.equal(input.getText(), 'TEST_STOCK_DRAFXT', 'activation and cancellation retain original SDK Editor caret');
const pending = await extension.tools.get('ask_user_question_async').definition.execute('stock-async', { question: 'TEST stock async?' }, undefined, () => {}, stock);
assert.equal(pending.details.status, 'pending'); assert.equal(appends, 1, 'stock SDK async is admitted and saved');
assert.equal(tui.getFocusedComponent(), input, 'stock async arrival remains passive');
await extension.commands.get('asks').handler('', stock); assert.equal(tui.getFocusedComponent(), widget);
const questionWidget = widget;
questionWidget.handleInput('TEST_STOCK_ANSWER'); questionWidget.handleInput('\r');
await new Promise(done => setImmediate(done));
assert.equal(appends, 2, 'original async answer is persisted from stock pane');
assert.equal(tui.getFocusedComponent(), input, 'async completion returns to exact original input');
assert.equal(sends, 1, 'saved stock answer schedules original-session feedback once');
console.log(JSON.stringify({ syntheticNotScott: true, humanAcceptance: false, realMainFactory: true, rawProducerRegistrationsExactlyOnce: true, sharedToolsRemainSeparate: true, printNotHumanCancel: true, olderSdkCapabilityBoundary: true, stockBlockingOnlyAsks: true, stockAsyncPersistence: true, stockOriginalEditorCaret: true, registrations: names }, null, 2));
