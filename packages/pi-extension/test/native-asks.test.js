import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  const deliveries = [], notices = [], dialogs = [], statuses = [], widgets = [];
  const editor = { getText: () => '', setText() {} };
  let focus = editor;
  const tui = { requestRender() {}, terminal: { rows: 40 }, getFocusedComponent: () => focus,
    setFocus(value) { if (focus) focus.focused = false; focus = value; if (focus) focus.focused = true; } };
  const ui = { setWidget(...args) {
      widgets.push(args);
      if (typeof args[1] === 'function') {
        const component = args[1](tui, getTheme());
        if (component.handleInput) dialogs.push({ component, resolve: (value) => component.close(value), options: args[2] });
      }
    }, setStatus: (...args) => statuses.push(args), notify: (...args) => notices.push(args) };
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
  return { loaded, extension, SessionManager, getTheme, ctx, emit, ask, open, tick, entries, dialogs, deliveries, notices, statuses, widgets, tui, editor,
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
  assert.equal(f.dialogs.length, 1, 'question opens automatically while the tool has already returned pending');
  assert.equal(f.dialogs[0].options?.placement, 'aboveEditor', 'question is mounted in normal layout, not an overlay');
  assert.equal((await f.ask('call-1')).details.id, created.details.id);
  assert.equal(f.entries('threadroom.native.question.v1').length, 1, 'same call retry does not duplicate');
  assert.equal((await f.ask('call-1', 'Changed question')).details.status, 'identity_conflict');
  const opening = f.open(); await f.tick();
  await f.open(); assert.equal(f.dialogs.length, 1, 'only one UI can open');
  const first = f.dialogs[0].component;
  first.handleInput('\r'); first.handleInput('Unsubmitted draft'); first.handleInput('\x1b');
  await opening;
  assert.equal(f.entries('threadroom.native.answer.v1').length, 0);
  assert.match(f.notices.at(-1)[0], /stays visible and pending.*draft discarded/);
  const secondOpen = f.open(created.details.id); await f.tick();
  const second = f.dialogs[1].component;
  assert.doesNotMatch(stripVTControlCharacters(second.render(70).join('\n')), /Unsubmitted draft/);
  await f.emit('agent_start'); f.idle = false;
  second.handleInput('My ordinary free answer'); second.handleInput('\r'); await secondOpen;
  const answer = f.entries('threadroom.native.answer.v1')[0].data;
  assert.equal(answer.prompt.question, 'What should I refine?');
  assert.deepEqual(answer.answer, { text: 'My ordinary free answer' });
  assert.deepEqual(f.deliveries[0].options, { deliverAs: 'steer', triggerTurn: true });
  assert.deepEqual(f.deliveries[0].message.details.humanResponse, { version: 1, outcome: 'answered',
    answeredBy: { kind: 'person', via: 'pi-tui' }, answers: [{ question: 'What should I refine?', wrote: 'My ordinary free answer' }] },
    'late feedback tells observers the person wrote this answer');
  assert.match(f.statuses.at(-1)[1], /saved feedback/, 'sendMessage void is not a saved receipt');
  await f.open();
  assert.match(f.notices.at(-1)[0], /My ordinary free answer/);
  assert.ok(f.notices.at(-1)[0].includes(answer.answerId));
  assert.match(f.notices.at(-1)[0], /queued or consumed without a durable receipt/);
  assert.match(f.notices.at(-1)[0], /Preserve\/copy retained drafts and the original SDK journal/);
  assert.match(f.notices.at(-1)[0], /Do not submit again or quit\/resume as a feedback retry/);
  assert.doesNotMatch(f.notices.at(-1)[0], /quit Pi and resume this original session/);
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
    await f.emit(boundary);
    dialog.resolve({ id: question.details.id, text: 'Late callback must not become feedback' });
    await opening;
    assert.equal(f.entries('threadroom.native.answer.v1').length, 0, boundary);
    assert.equal(f.deliveries.length, 0, boundary);
    if (boundary === 'session_before_compact') await f.emit('session_compact_failed');
    else if (boundary === 'session_before_tree') await f.emit('session_tree');
    else { await f.emit('session_shutdown'); await f.emit('session_start'); }
  }
  // Stock Pi awaits later before-switch handlers while isIdle() remains true.
  // Quiescence must not reopen either private producer during that interval, or
  // after an unreported cancellation/failure. Only a lifecycle rebind recovers.
  let releaseTransition; const heldTransition = new Promise((resolve) => { releaseTransition = resolve; });
  f.extension.handlers.get('session_before_switch').push(() => heldTransition);
  const changing = f.emit('session_before_switch'); await f.tick();
  const dialogCount = f.dialogs.length;
  await new Promise((done) => setTimeout(done, 150));
  assert.equal((await f.ask('during-held-transition')).details.status, 'session_changing');
  await f.open(question.details.id);
  assert.equal(f.dialogs.length, dialogCount, '/asks cannot override an unknown in-flight transition');
  assert.match(f.notices.at(-1)[0], /run \/reload/);
  releaseTransition(); await changing;
  await f.emit('session_before_compact'); await f.emit('session_compact_failed'); await f.emit('session_tree');
  assert.equal((await f.ask('after-unreported-cancel')).details.status, 'session_changing', 'unrelated positive events cannot clear a replacement gate');
  await f.emit('session_shutdown');
  const beforeRetiredAttempt = f.manager.getEntries().length;
  assert.equal((await f.ask('retired-native')).details.status, 'session_changing');
  assert.equal(f.manager.getEntries().length, beforeRetiredAttempt, 'retired native producer cannot lazily resurrect itself');
  await f.emit('session_start');
  assert.equal((await f.ask('owned')).details.status, 'pending', 'authoritative lifecycle rebind restores admission');
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
  const { visibleWidth, CURSOR_MARKER } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
  const { CustomEntryComponent } = await host('dist/modes/interactive/components/custom-entry.js');
  const entry = f.entries('threadroom.native.question.v1')[0];
  const renderer = f.extension.entryRenderers.get(entry.customType);
  const component = new CustomEntryComponent(entry, renderer);
  for (const width of [20, 40, 80]) {
    for (const line of dialog.component.render(width)) { assert.doesNotMatch(line, /\n/); assert.ok(visibleWidth(line) <= width); }
  }
  dialog.component.handleInput('\t'); // A multiline suggestion becomes a single-line editable reply.
  for (const width of [20, 40, 80]) {
    for (const line of dialog.component.render(width)) { assert.doesNotMatch(line, /\n/); assert.ok(visibleWidth(line) <= width); }
  }
  dialog.component.handleInput(`\x1b[200~${malicious}\x1b[201~`);
  for (const width of [20, 40, 80]) {
    for (const rendered of [dialog.component.render(width), component.render(width)]) {
      for (const line of rendered) assert.ok(visibleWidth(line) <= width);
      const output = rendered.join('\n').replaceAll(CURSOR_MARKER, '').replace(/\x1b\[[0-9;]*m/g, '');
      assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    }
  }
  assert.equal(entry.data.prompt.question, malicious, 'saved association is not silently rewritten by rendering');
  dialog.component.handleInput('\x15'); dialog.component.handleInput('\r'); await opening;
  const answer = f.entries('threadroom.native.answer.v1').at(-1).data.answer;
  assert.equal(answer.text, 'Quiet finish'); assert.equal(answer.selection.label, 'Quiet\nfinish');
});

test('automatic input-area choices, free writing, pending visibility and concurrent asks through the loaded host', options, async (t) => {
  const f = await fixture(t);
  const tool = f.extension.tools.get('ask_user_question_async').definition;
  const question = await tool.execute('choices', { question: 'Which finish?', options: ['Quiet',
    { label: 'Bright', preview: 'A bright finish.' }, 'Balanced'] }, undefined, () => {}, f.ctx());
  const panel = f.dialogs[0].component;
  const rendered = () => stripVTControlCharacters(panel.render(80).join('\n'));
  assert.match(rendered(), /› 1\. Quiet/);
  assert.match(rendered(), /Type something\./);
  panel.handleInput('\x1b[B');
  assert.match(rendered(), /› 2\. Bright/);
  assert.match(rendered(), /A bright finish\./);
  assert.equal(f.entries('threadroom.native.answer.v1').length, 0, 'navigation is not submission');
  panel.handleInput('\r'); await f.tick();
  const answer = f.entries('threadroom.native.answer.v1')[0].data;
  assert.equal(answer.questionId, question.details.id);
  assert.equal(answer.answer.optionIndex, 1);
  assert.equal(answer.answer.selection.preview, 'A bright finish.');
  assert.equal(answer.answer.text, 'Bright');
  assert.equal(f.notices.length, 0, 'successful final save is not mislabeled as a pause');
  const free = await f.ask('free-first');
  const writing = f.dialogs.at(-1).component;
  writing.handleInput('Keep my answer draft');
  await f.ask('free-second', 'Another independent question?');
  assert.equal(f.dialogs.length, 2, 'concurrent ask joins the existing panel');
  assert.match(stripVTControlCharacters(writing.render(80).join('\n')), /Keep my answer draft/);
  writing.handleInput('\x1b[Z');
  assert.match(stripVTControlCharacters(writing.render(80).join('\n')), /Another independent question\?/);
  writing.handleInput('\x1b[Z');
  assert.match(stripVTControlCharacters(writing.render(80).join('\n')), /Keep my answer draft/);
  writing.handleInput('\x1b'); await f.tick();
  assert.equal(f.entries('threadroom.native.answer.v1').length, 1, 'Escape does not submit a draft');
  const widget = f.widgets.at(-1)[1]({ terminal: { rows: 40 } }, f.getTheme());
  assert.match(stripVTControlCharacters(widget.render(80).join('\n')), /What should I refine\?/);
  assert.match(stripVTControlCharacters(widget.render(80).join('\n')), /Another independent question\?/);
  await f.emit('agent_settled');
  assert.equal(f.dialogs.length, 2, 'ongoing AI activity does not reopen an explicitly paused panel');
  const reopened = f.open(free.details.id); await f.tick();
  const resumed = f.dialogs.at(-1).component;
  assert.doesNotMatch(stripVTControlCharacters(resumed.render(80).join('\n')), /Keep my answer draft/);
  resumed.handleInput('My own wording'); resumed.handleInput('\r'); await reopened; await f.tick();
  assert.equal(f.dialogs.length, 3, 'saving advances in the same panel to the remaining question');
  assert.match(stripVTControlCharacters(f.dialogs.at(-1).component.render(80).join('\n')), /Another independent question\?/);
});

test('suggestions remain visible while typing and clearing a reply restores ordinary choice selection', options, async (t) => {
  const f = await fixture(t);
  await f.extension.tools.get('ask_user_question_async').definition.execute('visible-choices',
    { question: 'Which finish?', options: ['Quiet', 'Bright'] }, undefined, () => {}, f.ctx());
  const panel = f.dialogs[0].component;
  f.tui.terminal.rows = 24;
  const text = () => stripVTControlCharacters(panel.render(80).join('\n'));
  panel.handleInput('Draft');
  assert.match(text(), /1\. Quiet/); assert.match(text(), /2\. Bright/); assert.match(text(), /Draft/);
  for (let i = 0; i < 5; i++) panel.handleInput('\x7f');
  assert.match(text(), /› 1\. Quiet/);
  panel.handleInput('\x1b[B');
  assert.match(text(), /› 2\. Bright/);
  panel.handleInput('\r'); await f.tick();
  assert.equal(f.entries('threadroom.native.answer.v1')[0].data.answer.selection.label, 'Bright');
});

test('saving another pending question preserves the original free-answer draft', options, async (t) => {
  const f = await fixture(t);
  const first = await f.ask('draft-A', 'Question A?');
  const panel = f.dialogs[0].component;
  panel.handleInput('Draft for A');
  const second = await f.ask('answer-B', 'Question B?');
  panel.handleInput('\x1b[Z'); panel.handleInput('Reply for B'); panel.handleInput('\r'); await f.tick();
  const saved = f.entries('threadroom.native.answer.v1')[0].data;
  assert.equal(saved.questionId, second.details.id);
  assert.equal(saved.answer.text, 'Reply for B');
  assert.match(stripVTControlCharacters(panel.render(80).join('\n')), /Draft for A/);
  assert.match(stripVTControlCharacters(panel.render(80).join('\n')), /Question A\?/);
  panel.handleInput('\r'); await f.tick();
  const original = f.entries('threadroom.native.answer.v1')[1].data;
  assert.equal(original.questionId, first.details.id);
  assert.equal(original.answer.text, 'Draft for A');
});

test('browsing choices and returning to writing does not replace a written draft', options, async (t) => {
  const f = await fixture(t);
  await f.extension.tools.get('ask_user_question_async').definition.execute('mode-draft',
    { question: 'Which answer?', options: ['Suggested', 'Other'] }, undefined, () => {}, f.ctx());
  const panel = f.dialogs[0].component;
  panel.handleInput('My written draft'); panel.handleInput('\t'); panel.handleInput('\x1b[B'); panel.handleInput('\t');
  assert.match(stripVTControlCharacters(panel.render(80).join('\n')), /My written draft/);
  panel.handleInput('\r'); await f.tick();
  assert.equal(f.entries('threadroom.native.answer.v1')[0].data.answer.text, 'My written draft');
});

test('each pending free reply retains its cursor and owns its undo history', options, async (t) => {
  const f = await fixture(t);
  await f.ask('cursor-A', 'Question A?');
  const panel = f.dialogs[0].component;
  panel.handleInput('Alpha'); panel.handleInput(' '); panel.handleInput('A'); panel.handleInput('\x1b[D');
  await f.ask('undo-B', 'Question B?');
  panel.handleInput('\x1b[Z'); panel.handleInput('\x1b[45;5u');
  assert.doesNotMatch(stripVTControlCharacters(panel.render(80).join('\n')), /Alpha/, 'undo does not reveal another question’s reply');
  panel.handleInput('\x1b[Z'); panel.handleInput('X'); panel.handleInput('\r'); await f.tick();
  assert.equal(f.entries('threadroom.native.answer.v1')[0].data.answer.text, 'Alpha XA', 'switching questions preserves the cursor');
});

test('whole inline panel fits short terminals and all selected preview text remains scrollable', options, async (t) => {
  const f = await fixture(t);
  const preview = Array.from({ length: 25 }, (_, i) => `PREVIEW_${i}_END`).join('\n');
  await f.extension.tools.get('ask_user_question_async').definition.execute('short-terminal',
    { question: 'A long question? '.repeat(35), context: 'Some longer context. '.repeat(20),
      options: [{ label: 'Selected', preview }, ...Array.from({ length: 19 }, (_, i) => `Choice ${i}`)] }, undefined, () => {}, f.ctx());
  const panel = f.dialogs[0].component;
  for (const rows of [40, 24, 18]) {
    f.tui.terminal.rows = rows;
    let seen = '';
    panel.handleInput('\x1b[5~'); // PageUp; scrolling is bounded to the current detail range.
    for (let page = 0; page < 100; page++) {
      const rendered = panel.render(80);
      assert.ok(rendered.length <= Math.max(4, Math.min(20, rows - 12)), `${rows}-row terminal reserves Pi chrome`);
      seen += stripVTControlCharacters(rendered.join('\n')) + '\n';
      panel.handleInput('\x1b[6~');
    }
    // Start at the top independently of whichever scroll window the resize retained.
    for (let page = 0; page < 100; page++) { seen += stripVTControlCharacters(panel.render(80).join('\n')); panel.handleInput('\x1b[5~'); }
    for (let i = 0; i < 25; i++) assert.ok(seen.includes(`PREVIEW_${i}_END`), `${rows} rows: preview line ${i} reachable`);
  }
});

test('full selected labels use terminal-cell width, including CJK and two-digit choice prefixes', options, async (t) => {
  const f = await fixture(t);
  const wide = '界'.repeat(40) + ' LAST_CJK_DETAIL';
  const tenth = 'x'.repeat(57) + ' LAST_TENTH_DETAIL'; // 75 cells, plus a six-cell prefix.
  await f.extension.tools.get('ask_user_question_async').definition.execute('cell-width',
    { question: 'Inspect the complete label?', options: [wide, ...Array.from({ length: 8 }, () => 'Short'), tenth] }, undefined, () => {}, f.ctx());
  const panel = f.dialogs[0].component;
  f.tui.terminal.rows = 18;
  for (const [down, distinguishing] of [[0, 'LAST_CJK_DETAIL'], [9, 'LAST_TENTH_DETAIL']]) {
    for (let i = 0; i < down; i++) panel.handleInput('\x1b[B');
    let seen = '';
    for (let page = 0; page < 20; page++) {
      seen += stripVTControlCharacters(panel.render(80).join('\n'));
      panel.handleInput('\x1b[6~');
    }
    assert.ok(seen.includes(distinguishing), `selected label’s distinguishing detail remains reachable: ${distinguishing}`);
  }
});

test('paste and Kitty printable keys start a free reply directly from choices', options, async (t) => {
  const f = await fixture(t);
  const tool = f.extension.tools.get('ask_user_question_async').definition;
  for (const [call, key, text] of [['paste-choice', '\x1b[200~Pasted reply\x1b[201~', 'Pasted reply'],
    ['kitty-choice', '\x1b[97u', 'a']]) {
    await tool.execute(call, { question: 'What next?', options: ['Default choice'] }, undefined, () => {}, f.ctx());
    const panel = f.dialogs.at(-1).component;
    panel.handleInput(key); panel.handleInput('\r'); await f.tick();
    const answer = f.entries('threadroom.native.answer.v1').at(-1).data.answer;
    assert.equal(answer.text, text);
    assert.equal(answer.selection, undefined, 'written text is not mistaken for the default choice');
  }
});

test('inline questions yield focus to other host prompts in either creation order without stranding a UI promise', options, async (t) => {
  const f = await fixture(t);
  await f.ask('before-prompt'); await f.tick();
  const panel = f.dialogs.at(-1).component;
  assert.equal(f.tui.getFocusedComponent(), panel);
  await f.emit('ui_prompt_start');
  assert.equal(f.tui.getFocusedComponent(), f.editor);
  const foreign = {};
  f.tui.setFocus(foreign);
  await f.ask('during-prompt', 'Created during another prompt?'); await f.tick();
  assert.equal(f.tui.getFocusedComponent(), foreign, 'async creation does not steal another prompt');
  assert.match(stripVTControlCharacters(panel.render(80).join('\n')), /waiting for the current Pi prompt/);
  f.tui.setFocus(f.editor); await f.emit('ui_prompt_end');
  assert.equal(f.tui.getFocusedComponent(), panel, 'native reply becomes available again automatically');
  panel.handleInput('Answer the first'); panel.handleInput('\r'); await f.tick();
  const next = f.dialogs.at(-1).component;
  assert.match(stripVTControlCharacters(next.render(80).join('\n')), /Created during another prompt\?/);
  next.handleInput('\x1b'); await f.tick();
  const pausedCount = f.dialogs.length;
  await f.emit('ui_prompt_start'); f.tui.setFocus(foreign);
  f.tui.setFocus(f.editor); await f.emit('ui_prompt_end');
  assert.equal(f.dialogs.length, pausedCount, 'an unrelated prompt does not undo explicit Escape pause');
  assert.equal(f.tui.getFocusedComponent(), f.editor);
  await f.emit('ui_prompt_start'); f.tui.setFocus(foreign);
  await f.ask('new-during-prompt', 'A new question while busy?'); await f.tick();
  assert.equal(f.tui.getFocusedComponent(), foreign);
  assert.match(stripVTControlCharacters(f.dialogs.at(-1).component.render(80).join('\n')), /waiting for the current Pi prompt/);
  f.tui.setFocus(f.editor); await f.emit('ui_prompt_end');
  assert.equal(f.tui.getFocusedComponent(), f.dialogs.at(-1).component);
});

test('selectors outside extension prompt spans retain focus, then automatically return to an open question', options, async (t) => {
  const f = await fixture(t);
  const selector = {};
  f.tui.setFocus(selector);
  await f.ask('built-in-first'); await f.tick();
  const panel = f.dialogs.at(-1).component;
  assert.equal(f.tui.getFocusedComponent(), selector, 'a new ask does not claim selector focus');
  assert.match(stripVTControlCharacters(panel.render(80).join('\n')), /waiting for the current Pi prompt/);
  f.tui.setFocus(f.editor); panel.render(80);
  assert.equal(f.tui.getFocusedComponent(), panel, 'host render after selector closure restores an open question');
  f.tui.setFocus(selector); panel.render(80);
  assert.equal(f.tui.getFocusedComponent(), selector, 'an already-open question also yields to a selector');
  f.tui.setFocus(f.editor); panel.render(80);
  assert.equal(f.tui.getFocusedComponent(), panel);
  panel.handleInput('\x1b'); await f.tick();
  const count = f.dialogs.length;
  f.tui.setFocus(selector); f.tui.setFocus(f.editor);
  const paused = f.widgets.at(-1)[1](f.tui, f.getTheme()); paused.render(80);
  assert.equal(f.tui.getFocusedComponent(), f.editor, 'a paused card never regains focus');
  assert.equal(f.dialogs.length, count);
});

test('actual TUI overlay restoration routes retired native focus to the editor or current session/reload owner', options, () => {
  const result = spawnSync(process.execPath, [resolve(root, 'packages/pi-extension/fixtures/native-focus-proof.mjs'), root, sdk],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.noSuccessorEditorKeyOnce, true);
  assert.equal(proof.disposeBeforeShutdown, true);
  assert.equal(proof.replacedEditorLoan, true);
  assert.equal(proof.newSessionCurrentOwner, true);
  assert.equal(proof.originalSessionReloadCurrentWriterAndSender, true);
});

test('installed Pi PTY: focus, streaming UI, wake, real saved receipt and resume', {
  ...options, skip: !sdk || process.env.THREADROOM_PI_TUI_SMOKE !== '1'
    ? 'Set THREADROOM_PI_SDK_ROOT and THREADROOM_PI_TUI_SMOKE=1; requires installed pi and Python pexpect' : false,
}, async (t) => {
  for (const interruption of ['0', '1']) await t.test(interruption === '0' ? 'ordinary busy steering' : 'abort, idle reload, physical restart recovery', async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'threadroom-native-tui-'));
    let passed = false;
    t.after(async () => {
      if (passed) await rm(directory, { recursive: true, force: true });
      else console.error(`Retained failed native PTY evidence: ${directory}`);
    });
    const result = spawnSync(process.env.PYTHON || 'python3', [resolve(root, 'packages/pi-extension/test/native-tui-smoke.py'),
      root, directory, process.env.THREADROOM_PI_BIN || 'pi'], { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, NATIVE_TEST_RELOAD_INTERRUPTION: interruption } });
    await writeFile(resolve(directory, 'driver-result.json'), JSON.stringify({
      interruption, sdk, cli: process.env.THREADROOM_PI_BIN || 'pi', launcherPid: result.pid,
      status: result.status, signal: result.signal, error: result.error?.message,
      stdout: result.stdout, stderr: result.stderr,
    }, null, 2));
    assert.equal(result.status, 0, `${result.stderr || result.stdout || String(result.error)}\nEvidence: ${directory}`);
    assert.match(result.stdout, /Native TUI: immediate return/);
    passed = true;
  });
});
