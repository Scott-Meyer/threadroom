import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

let sdk = process.env.THREADROOM_PI_SDK_ROOT;
if (!sdk) {
  try { sdk = dirname(dirname(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent'))); }
  catch { /* Host checks opt in when peers are installed globally. */ }
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
const host = (path) => import(pathToFileURL(resolve(sdk, path)).href);
const options = { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT for installed-host checks' };

async function fixture(t) {
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { SessionManager } = await host('dist/core/session-manager.js');
  const { initTheme, theme } = await host('dist/modes/interactive/theme/theme.js');
  const getTheme = () => theme;
  initTheme('dark', false);
  const loaded = await loadExtensions([resolve(root, 'packages/pi-extension/fixtures/native-only.ts')], root);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ['ask_user_question_async'], 'blocking ask ownership untouched');
  let manager = SessionManager.inMemory(root);
  let mode = 'tui';
  let idle = true;
  const deliveries = [], notices = [], dialogs = [], statuses = [];
  const ui = { setStatus: (...args) => statuses.push(args), notify: (...args) => notices.push(args),
    custom(factory) {
      return new Promise((resolve) => {
        const dialog = { resolve };
        dialog.component = factory({ requestRender() {}, terminal: { rows: 40 } }, getTheme(), {}, resolve);
        dialogs.push(dialog);
      });
    } };
  Object.assign(loaded.runtime, {
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    sendMessage(message, options) {
      assert.ok(manager.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'threadroom.native.answer.v1'
        && entry.data.answerId === message.details.answerId), 'answer association saved before requesting wake');
      deliveries.push({ message, options });
    },
  });
  // Fresh contexts reflect actual runner behavior; contexts are not stable identity.
  const ctx = () => ({ sessionManager: manager, mode, hasUI: mode !== 'print', isIdle: () => idle, ui });
  const emit = async (name, event = {}) => {
    for (const handler of extension.handlers.get(name) || []) await handler(event, ctx());
  };
  await emit('session_start');
  t.after(() => emit('session_shutdown'));
  const tool = extension.tools.get('ask_user_question_async').definition;
  const ask = (call, question = 'What should I refine?', signal) => tool.execute(call, { question }, signal, () => {}, ctx());
  const open = (id = '') => extension.commands.get('asks').handler(id, ctx());
  const tick = () => new Promise((done) => setImmediate(done));
  const entries = (type) => manager.getBranch().filter((entry) => entry.customType === type);
  return { loaded, extension, SessionManager, getTheme, ctx, emit, ask, open, tick, entries, dialogs, deliveries, notices, statuses,
    get manager() { return manager; }, set manager(value) { manager = value; },
    set mode(value) { mode = value; }, set idle(value) { idle = value; } };
}

test('loaded native boundary saves stable identities, leaves pending on Escape, and reconciles actual host receipts', options, async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Native asks must never use HTTP'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const mode of ['rpc', 'print', 'json']) {
    f.mode = mode;
    assert.equal((await f.ask(`unsupported-${mode}`)).details.status, 'unsupported_host');
  }
  f.mode = 'tui';
  assert.equal(f.manager.getEntries().length, 0, 'unsupported hosts did not manufacture pending/cancellation');
  const abort = new AbortController(); abort.abort();
  assert.equal((await f.ask('abort', 'Question', abort.signal)).details.saved, false);
  const created = await f.ask('call-1');
  assert.equal(created.details.status, 'pending');
  assert.equal(f.dialogs.length, 0, 'creation never opens UI');
  assert.equal((await f.ask('call-1')).details.id, created.details.id);
  assert.equal(f.entries('threadroom.native.question.v1').length, 1, 'same call retry does not duplicate');
  assert.equal((await f.ask('call-1', 'Changed question')).details.status, 'identity_conflict');
  const opening = f.open(); await f.tick();
  await f.open(); assert.equal(f.dialogs.length, 1, 'only one UI can open');
  const first = f.dialogs[0].component;
  first.handleInput('\r'); first.handleInput('Unsubmitted draft'); first.handleInput('\x1b');
  await opening;
  assert.equal(f.entries('threadroom.native.answer.v1').length, 0);
  assert.match(f.notices.at(-1)[0], /stays pending.*draft discarded/);
  const secondOpen = f.open(created.details.id); await f.tick();
  const second = f.dialogs[1].component;
  assert.doesNotMatch(stripVTControlCharacters(second.render(70).join('\n')), /Unsubmitted draft/);
  await f.emit('agent_start'); f.idle = false;
  second.handleInput('My ordinary free answer'); second.handleInput('\r'); await secondOpen;
  const answer = f.entries('threadroom.native.answer.v1')[0].data;
  assert.equal(answer.prompt.question, 'What should I refine?');
  assert.deepEqual(answer.answer, { text: 'My ordinary free answer' });
  assert.deepEqual(f.deliveries[0].options, { deliverAs: 'steer', triggerTurn: true });
  assert.match(f.statuses.at(-1)[1], /saved feedback/, 'sendMessage void is not a saved receipt');
  await f.open();
  assert.match(f.notices.at(-1)[0], /My ordinary free answer/);
  assert.ok(f.notices.at(-1)[0].includes(answer.answerId));
  assert.match(f.notices.at(-1)[0], /quit Pi and resume this original session/);
  assert.equal(f.deliveries.length, 1, 'viewing saved feedback does not speculate about lost queues');
  const delivery = f.deliveries[0].message;
  f.manager.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
  await f.emit('turn_end');
  assert.equal(f.statuses.at(-1)[1], undefined, 'actual saved custom_message identity reconciled');
  f.idle = true; await f.emit('agent_settled'); await f.emit('session_start');
  assert.equal(f.deliveries.length, 1, 'saved receipt survives rebind without duplicate delivery');
});

test('active branch/session ownership and late UI callbacks do not cross switch, fork, tree or compaction', options, async (t) => {
  const f = await fixture(t);
  const original = f.manager;
  const question = await f.ask('owned');
  const questionEntry = f.entries('threadroom.native.question.v1')[0];
  for (const boundary of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_before_compact']) {
    const opening = f.open(question.details.id); await f.tick();
    const dialog = f.dialogs.at(-1);
    f.idle = false; await f.emit(boundary);
    dialog.resolve({ id: question.details.id, text: 'Late callback must not become feedback' });
    await opening;
    assert.equal(f.entries('threadroom.native.answer.v1').length, 0, boundary);
    assert.equal(f.deliveries.length, 0, boundary);
    f.idle = true;
    if (boundary === 'session_before_compact') await f.emit('session_compact_failed');
    else await f.emit('session_tree');
  }
  // Two canceled/failed navigation attempts must not leave a stale epoch timer
  // owning the only retry. No successful session_tree event releases this gate.
  f.idle = false; await f.emit('session_before_tree'); await f.emit('session_before_tree');
  f.idle = true; await new Promise((done) => setTimeout(done, 150));
  assert.equal((await f.ask('owned')).details.status, 'pending', 'quiescence releases the newest boundary');
  const afterCancelled = f.open(question.details.id); await f.tick();
  f.dialogs.at(-1).component.handleInput('\x1b'); await afterCancelled;
  // Same-session tree navigation projects only the actual selected branch.
  const before = original.getLeafId();
  await f.emit('session_before_tree'); original.resetLeaf(); await f.emit('session_tree');
  await f.open(); assert.match(f.notices.at(-1)[0], /No pending/);
  original.branch(before); await f.emit('session_tree');
  const recovered = f.open(question.details.id); await f.tick();
  f.dialogs.at(-1).component.handleInput('\x1b'); await recovered;
  // A copied transcript carrying another session's question does not confer ownership.
  await f.emit('session_shutdown');
  f.manager = f.SessionManager.inMemory(root);
  f.manager.appendCustomEntry(questionEntry.customType, questionEntry.data);
  await f.emit('session_start'); await f.open();
  assert.match(f.notices.at(-1)[0], /No pending/);
  assert.equal(f.deliveries.length, 0);
  // Saved-undelivered answers recover only on the original owned session.
  f.manager = original;
  const saved = { sessionId: original.getSessionId(), answerId: 'answer-recovery', questionId: question.details.id,
    prompt: questionEntry.data.prompt, answer: { text: 'Saved before shutdown' } };
  original.appendCustomEntry('threadroom.native.answer.v1', saved);
  await f.emit('session_start');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].message.details.answerId, saved.answerId);
});

test('native UI and saved transcript render untrusted text as data at actual Pi component boundaries', options, async (t) => {
  const f = await fixture(t);
  const malicious = 'Question\x1b[2J\x1b]52;c;secret\x07\r\b\u202e\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\\nSecond line';
  const created = await f.extension.tools.get('ask_user_question_async').definition.execute('controls',
    { question: malicious, options: [{ label: 'Quiet\nfinish', preview: 'First line\nSecond line' }] }, undefined, () => {}, f.ctx());
  const opening = f.open(); await f.tick();
  const dialog = f.dialogs.at(-1);
  const require = createRequire(pathToFileURL(resolve(sdk, 'package.json')));
  const { visibleWidth } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
  const { CustomEntryComponent } = await host('dist/modes/interactive/components/custom-entry.js');
  const entry = f.entries('threadroom.native.question.v1')[0];
  const renderer = f.extension.entryRenderers.get(entry.customType);
  const component = new CustomEntryComponent(entry, renderer);
  for (const width of [20, 40, 80]) {
    for (const line of dialog.component.render(width)) { assert.doesNotMatch(line, /\n/); assert.ok(visibleWidth(line) <= width); }
  }
  dialog.component.handleInput('\r'); // Open from the single-row inbox.
  dialog.component.handleInput('\t'); // A multiline suggestion becomes a single-line editable reply.
  for (const width of [20, 40, 80]) {
    for (const line of dialog.component.render(width)) { assert.doesNotMatch(line, /\n/); assert.ok(visibleWidth(line) <= width); }
  }
  dialog.component.handleInput(`\x1b[200~${malicious}\x1b[201~`);
  for (const width of [20, 40, 80]) {
    for (const rendered of [dialog.component.render(width), component.render(width)]) {
      for (const line of rendered) assert.ok(visibleWidth(line) <= width);
      const output = rendered.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
      assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    }
  }
  assert.equal(entry.data.prompt.question, malicious, 'saved association is not silently rewritten by rendering');
  dialog.component.handleInput('\x15'); dialog.component.handleInput('\t'); dialog.component.handleInput('\r'); await opening;
  const answer = f.entries('threadroom.native.answer.v1').at(-1).data.answer;
  assert.equal(answer.text, 'Quiet finish'); assert.equal(answer.selection.label, 'Quiet\nfinish');
});

test('installed Pi PTY: focus, streaming UI, wake, real saved receipt and resume', {
  ...options, skip: !sdk || process.env.THREADROOM_PI_TUI_SMOKE !== '1'
    ? 'Set THREADROOM_PI_SDK_ROOT and THREADROOM_PI_TUI_SMOKE=1; requires installed pi and Python pexpect' : false,
}, async (t) => {
  for (const interruption of ['0', '1']) await t.test(interruption === '0' ? 'ordinary busy steering' : 'abort, idle reload, physical restart recovery', async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'threadroom-native-tui-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = spawnSync(process.env.PYTHON || 'python3', [resolve(root, 'packages/pi-extension/test/native-tui-smoke.py'),
      root, directory, process.env.THREADROOM_PI_BIN || 'pi'], { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NATIVE_TEST_RELOAD_INTERRUPTION: interruption } });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    assert.match(result.stdout, /Native TUI: immediate return/);
  });
});
