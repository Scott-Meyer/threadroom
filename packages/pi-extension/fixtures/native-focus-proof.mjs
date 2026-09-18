// Actual installed SDK/TuiMainScreen consumer with an injected recording
// Terminal. No physical PTY/provider/disk/human-acceptance claim.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, sdk] = process.argv.slice(2);
const host = (path) => import(pathToFileURL(resolve(sdk, path)).href);
const { loadExtensions } = await host('dist/core/extensions/loader.js');
const { SessionManager } = await host('dist/core/session-manager.js');
const themes = await host('dist/modes/interactive/theme/theme.js'); themes.initTheme('dark', false);
const { TuiMainScreen, Editor } = await host('node_modules/@earendil-works/pi-tui/dist/index.js');
const terminal = { rows: 40, columns: 100, kittyProtocolActive: false,
  start(input) { this.input = input; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
const tui = new TuiMainScreen(terminal);
const editor = new Editor(tui, { borderColor: (text) => text, selectList: { selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text } });
editor.setText('KEEP_EDITOR_DRAFT');
let editorSubmits = 0; editor.onSubmit = () => editorSubmits++;
tui.addChild(editor); tui.setFocus(editor); tui.start();
let manager = SessionManager.inMemory(root), widget;
const writes = [], sends = [];
const ui = { setStatus() {}, notify() {}, setWidget(_key, value) {
  if (widget) { widget.dispose?.(); tui.removeChild(widget); }
  widget = typeof value === 'function' ? value(tui, themes.theme) : undefined;
  if (widget) tui.addChild(widget);
} };
const ctx = () => ({ sessionManager: manager, mode: 'tui', hasUI: true, isIdle: () => true, ui });
const tick = () => new Promise((resolve) => setImmediate(resolve));
let extension, generation = 0;
async function load() {
  const current = ++generation;
  const loaded = await loadExtensions([resolve(root, 'packages/pi-extension/fixtures/native-only.ts')], root);
  assert.deepEqual(loaded.errors, []);
  Object.assign(loaded.runtime, {
    appendEntry(type, data) { writes.push({ current, type, data }); manager.appendCustomEntry(type, data); },
    sendMessage(message) {
      assert.ok(manager.getBranch().some((entry) => entry.customType === 'threadroom.native.answer.v1' && entry.data.answerId === message.details.answerId));
      sends.push({ current, message });
    },
  });
  extension = loaded.extensions[0];
  await emit('session_start');
}
async function emit(name) { for (const handler of extension.handlers.get(name) || []) await handler({}, ctx()); }
const ask = (call, options = ['First', 'Second']) => extension.tools.get('ask_user_question_async').definition.execute(call, { question: `${call}?`, options }, undefined, () => {}, ctx());
const overlay = () => tui.showOverlay({ render: () => ['UNSPANNED OVERLAY'], handleInput() {}, invalidate() {} });
const answers = (owner) => owner.getBranch().filter((entry) => entry.customType === 'threadroom.native.answer.v1');
try {
  await load(); await ask('NO_SUCCESSOR'); await tick();
  const retired = widget, handle = overlay();
  await emit('session_before_switch'); handle.hide();
  assert.equal(tui.getFocusedComponent(), retired, 'real overlay captured the retired preFocus');
  terminal.input('z');
  assert.equal(tui.getFocusedComponent(), editor);
  assert.equal(editor.getText(), 'KEEP_EDITOR_DRAFTz'); assert.equal(editorSubmits, 0); assert.equal(answers(manager).length, 0);

  manager = SessionManager.inMemory(root); await emit('session_start'); await ask('RESET_BEFORE_SHUTDOWN'); await tick();
  const resetPanel = widget, resetOverlay = overlay();
  ui.setWidget('native-asks', undefined); // SDK resetExtensionUI disposes before session_shutdown
  await emit('session_shutdown'); resetOverlay.hide();
  assert.equal(tui.getFocusedComponent(), resetPanel); terminal.input('y');
  assert.equal(tui.getFocusedComponent(), editor); assert.equal(editor.getText(), 'KEEP_EDITOR_DRAFTzy');
  assert.equal(answers(manager).length, 0); const baseline = editor.getText();

  manager = SessionManager.inMemory(root); await emit('session_start'); await ask('OLD_SESSION'); await tick();
  const oldManager = manager, old = widget, cross = overlay();
  await emit('session_before_switch'); manager = SessionManager.inMemory(root); await emit('session_start');
  const fresh = await ask('NEW_SESSION'); await tick(); const successor = widget;
  cross.hide(); assert.equal(tui.getFocusedComponent(), old);
  terminal.input('\x1b[B'); assert.equal(tui.getFocusedComponent(), successor);
  terminal.input('\r'); await tick();
  assert.equal(answers(manager)[0].data.questionId, fresh.details.id);
  assert.equal(answers(manager)[0].data.answer.optionIndex, 1); assert.equal(answers(oldManager).length, 0);
  assert.equal(editor.getText(), baseline); assert.equal(editorSubmits, 0);

  const original = await ask('RELOAD_ORIGINAL'); await tick();
  const reloadOld = widget, reloadOverlay = overlay();
  await emit('session_shutdown'); await load(); await tick();
  const reloaded = widget; reloadOverlay.hide(); assert.equal(tui.getFocusedComponent(), reloadOld);
  terminal.input('fresh-draft'); assert.equal(tui.getFocusedComponent(), reloaded);
  terminal.input('\r'); await tick();
  const recovered = answers(manager).filter((entry) => entry.data.questionId === original.details.id);
  assert.equal(recovered.length, 1); assert.equal(recovered[0].data.answer.text, 'fresh-draft');
  assert.equal(writes.filter((entry) => entry.type === 'threadroom.native.answer.v1' && entry.data.questionId === original.details.id)[0].current, 2);
  assert.equal(sends.filter((entry) => entry.message.details.questionId === original.details.id)[0].current, 2);
  assert.equal(editor.getText(), baseline); assert.equal(editorSubmits, 0);
  const oldLoan = await ask('EDITOR_REPLACED_OLD'); await tick();
  const replacedPanel = widget, replacementOverlay = overlay();
  await emit('session_before_switch');
  tui.removeChild(editor);
  const replacement = new Editor(tui, { borderColor: (text) => text, selectList: { selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text } });
  replacement.setText('NEW_EDITOR_DRAFT'); let replacementSubmits = 0; replacement.onSubmit = () => replacementSubmits++;
  tui.addChild(replacement); tui.setFocus(replacement);
  manager = SessionManager.inMemory(root); await emit('session_start'); const newLoan = await ask('EDITOR_REPLACED_NEW'); await tick();
  replacementOverlay.hide();
  // setFocus during editor replacement updates this SDK's overlay return
  // target. Independently exercise the public retired-focus boundary too.
  assert.equal(tui.getFocusedComponent(), widget); tui.setFocus(replacedPanel);
  terminal.input('\x1b[B'); terminal.input('\r'); await tick();
  assert.equal(answers(manager)[0].data.questionId, newLoan.details.id); assert.equal(answers(manager)[0].data.answer.optionIndex, 1);
  assert.equal(tui.getFocusedComponent(), replacement); terminal.input('w');
  assert.equal(replacement.getText(), 'NEW_EDITOR_DRAFTw'); assert.equal(replacementSubmits, 0);
  assert.equal(editor.getText(), baseline); assert.equal(editorSubmits, 0);
  await emit('session_shutdown');
  console.log(JSON.stringify({ syntheticNotScott: true, noSuccessorEditorKeyOnce: true, disposeBeforeShutdown: true, replacedEditorLoan: true, newSessionCurrentOwner: true, originalSessionReloadCurrentWriterAndSender: true, realTuiClass: true, physicalPty: false, humanAcceptance: false }));
} finally { tui.stop(); }
