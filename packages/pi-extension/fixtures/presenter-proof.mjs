// Drives the real package MAIN through the SDK loader with a real TUI, plus a
// test presenter on the same event bus. Prints observed outcomes as JSON.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { resolveSdkPeer } from './sdk-peer.mjs';
const [root, sdk] = process.argv.slice(2);
const host = (path) => import(pathToFileURL(resolve(sdk, path)).href);
const { loadExtensions } = await host('dist/core/extensions/loader.js');
const { createEventBus } = await host('dist/core/event-bus.js');
const { SessionManager } = await host('dist/core/session-manager.js');
const themes = await host('dist/modes/interactive/theme/theme.js'); themes.initTheme('dark', false);
const { TuiMainScreen, Editor } = await import(resolveSdkPeer(sdk, '@earendil-works/pi-tui'));
const tick = () => new Promise((done) => setImmediate(done));

// A presenter that was loaded before Threadroom: it only hears `discover`.
const events = createEventBus(), shown = [];
const presenter = { id: 'test', present(group) {
  const entry = { group, updates: [], dismissed: undefined }; shown.push(entry);
  return { update(change) { entry.updates.push(change.required); }, dismiss(reason) { entry.dismissed = reason; } };
} };
events.on('threadroom.questions.presenter.v1.discover', () => events.emit('threadroom.questions.presenter.v1.register', presenter));

const loaded = await loadExtensions([resolve(root, 'packages/pi-extension/fixtures/main-wiring-proof.ts')], root, events);
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const extension = loaded.extensions[0], ask = extension.tools.get('ask_user_question').definition;
const tui = new TuiMainScreen({ rows: 18, columns: 80, kittyProtocolActive: false, write() {}, hideCursor() {}, showCursor() {} });
const input = new Editor(tui, { borderColor: (text) => text, selectList: {} });
tui.addChild(input); tui.setFocus(input);
const manager = SessionManager.inMemory(root);
let widget;
const ctx = { mode: 'tui', hasUI: true, cwd: root, isIdle: () => true, sessionManager: manager, ui: {
  theme: themes.theme, notify() {}, setStatus() {}, async select() {},
  setWidget(_key, factory) {
    if (widget) { widget.dispose?.(); tui.removeChild(widget); widget = undefined; }
    if (factory) { widget = factory(tui, themes.theme); tui.addChild(widget); }
  } } };
loaded.runtime.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
loaded.runtime.sendMessage = () => {};
let active = [...extension.tools.keys()];
loaded.runtime.getActiveTools = () => [...active]; loaded.runtime.setActiveTools = (names) => { active = [...names]; };
for (const handler of extension.handlers.get('session_start') || []) await handler({}, ctx);

const proof = {};
const options = [{ label: 'Wide', preview: 'W' }, { label: 'Narrow' }];

// Blocking, answered in the presenter.
const first = ask.execute('blocking-presenter', { questions: [{ question: 'Which silhouette?', options }, { question: 'Anything else?', options }] }, undefined, () => {}, ctx);
await tick();
const offered = shown.at(-1);
proof.blockingOffered = { mode: offered.group.mode, required: offered.group.required, questions: offered.group.questions.map((q) => q.question),
  terminalShown: tui.getFocusedComponent() === widget };
proof.blockingSubmit = offered.group.submit({ replies: [{ questionId: offered.group.questions[0].id, choices: [0], notes: 'softer' }] });
const firstResult = await first; await tick();
proof.blockingResult = { humanResponse: firstResult.details.humanResponse, terminalReleased: tui.getFocusedComponent() === input,
  secondSubmit: offered.group.submit({ replies: [], cancelled: true }) };

// Blocking, answered in the terminal: the presenter's copy is dismissed.
const second = ask.execute('blocking-terminal', { questions: [{ question: 'Ship today?', options }] }, undefined, () => {}, ctx);
await tick(); const terminalOffer = shown.at(-1);
widget.handleInput('\r');
const secondResult = await second; await tick();
proof.terminalAnswered = { dismissed: terminalOffer.dismissed, via: secondResult.details.humanResponse.answeredBy.via, chose: secondResult.details.humanResponse.answers[0].chose };

// Async: shown passively, becomes required when the AI waits, answered in the presenter.
const pending = await ask.execute('async', { blocking: false, questions: [{ question: 'Later: which palette?', options }] }, undefined, () => {}, ctx);
await tick(); const asyncOffer = shown.at(-1);
proof.asyncOffered = { mode: asyncOffer.group.mode, required: asyncOffer.group.required, notes: asyncOffer.group.questions[0].notes };
const waiting = ask.execute('async-wait', { questions: [{ questionId: pending.details.id }] }, undefined, () => {}, ctx);
await tick();
await asyncOffer.group.commit({ questionId: asyncOffer.group.questions[0].id, text: 'Warmer than both' });
const waited = await waiting; await tick();
proof.asyncAnswered = { updates: asyncOffer.updates, dismissed: asyncOffer.dismissed, waitStatus: waited.details.waitStatus,
  humanResponse: waited.details.humanResponse, terminalReleased: tui.getFocusedComponent() === input };

for (const handler of extension.handlers.get('session_shutdown') || []) await handler({}, ctx);
process.stdout.write(JSON.stringify(proof));
process.exit(0);
