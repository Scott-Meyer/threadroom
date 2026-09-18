import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let sdk = process.env.THREADROOM_PI_SDK_ROOT;
if (!sdk) {
  try { sdk = dirname(dirname(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent'))); }
  catch { /* Explicitly skipped without an installed SDK peer. */ }
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
const options = { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT for installed-host checks' };
const host = (path) => import(pathToFileURL(resolve(sdk, path)).href);
const spec = (question = 'TEST question?', extra = {}) => ({ question,
  options: [{ label: 'Same' }, { label: 'Same', description: 'TEST second', preview: 'TEST_SECOND_PREVIEW' }], ...extra });
const tick = () => new Promise((done) => setImmediate(done));

async function fixture(t) {
  const { loadExtensions } = await host('dist/core/extensions/loader.js');
  const { validateToolArguments } = await host('node_modules/@earendil-works/pi-ai/dist/utils/validation.js');
  const fixturePath = process.env.THREADROOM_QUESTIONS_TOOL_FIXTURE ?? resolve(root, 'packages/pi-extension/fixtures/questions-tool-proof.ts');
  const loaded = await loadExtensions([fixturePath], root);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ['ask_user_question']);
  const tool = extension.tools.get('ask_user_question').definition;
  const validate = (args) => validateToolArguments(tool, { name: tool.name, id: 'TEST', arguments: args });
  const ctx = { mode: 'tui', hasUI: true, ui: { testPresent: async () => ({ answers: [], cancelled: false }) } };
  const emit = async (name, context = ctx) => { for (const handler of extension.handlers.get(name) ?? []) await handler({}, context); };
  t.after(() => emit('session_shutdown'));
  const ask = (id, questions, signal, context = ctx) => tool.execute(id, validate({ questions }), signal, undefined, context);
  return { tool, validate, ctx, ask, emit };
}

// These are SDK-loader/controlled-dialog producer checks, not real TUI or human acceptance.
test('blocking authoring bounds validate via SDK without restricting duplicate labels or rich comparison data', options, async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.validate({ questions: [spec()] }).questions[0].options.map((item) => item.label), ['Same', 'Same']);
  assert.equal(f.validate({ questions: [spec('TEST rich?', { options: [{ label: 'Type something.', preview: 'TEST\n'.repeat(4000) }, { label: 'Other' }] })] }).questions.length, 1);
  for (const questions of [[], Array.from({ length: 5 }, () => spec()), [spec('', {})], [spec('TEST?', { options: [] })],
    [spec('TEST?', { options: [{ label: 'Only' }] })], [spec('TEST?', { options: Array.from({ length: 5 }, () => ({ label: 'Many' })) })],
    [spec('TEST?', { header: 'x'.repeat(17) })], [spec('TEST?', { unknown: true })]]) {
    assert.throws(() => f.validate({ questions }), /Validation failed/);
  }
});

test('TUI delegation retains stable group/local IDs and exact authored partial, multi, notes and cancellation results', options, async (t) => {
  const f = await fixture(t), seen = [];
  const answers = [{ questionIndex: 1, question: 'TEST multi?', selected: ['Same', 'Same'], optionIndices: [0, 1],
    previews: [null, 'TEST_SECOND_PREVIEW'], answer: 'TEST additional custom', notes: 'TEST open notes', wasCustom: true }];
  f.ctx.ui.testPresent = async (group, ctx, signal) => {
    seen.push(group); assert.equal(ctx, f.ctx); assert.equal(signal.aborted, false);
    assert.equal(group.mode, 'blocking'); assert.equal(group.commit, undefined);
    assert.deepEqual(group.questions.map((item) => item.id), ['question:0', 'question:1']);
    assert.deepEqual(group.questions[1].options, spec().options);
    return { answers, cancelled: true };
  };
  const result = await f.ask('TEST-call', [spec('TEST unanswered?'), spec('TEST multi?', { multiSelect: true })]);
  assert.deepEqual(result.details, { groupId: 'blocking:TEST-call', answers, cancelled: true });
  assert.deepEqual(JSON.parse(result.content[0].text), { answers, cancelled: true });
  await f.ask('TEST-call', [spec('TEST unanswered?'), spec('TEST multi?', { multiSelect: true })]);
  assert.equal(seen[0].id, seen[1].id);
  assert.notEqual(seen[0], seen[1], 'same identity does not share mutable request objects');
});

function script(f, steps) {
  const calls = [];
  f.ctx.mode = 'rpc';
  f.ctx.ui.testPresent = () => { throw new Error('RPC must not enter TUI presenter'); };
  f.ctx.ui.select = async (title, choices, opts) => {
    calls.push({ title, choices }); assert.equal(new Set(choices).size, choices.length, 'display choices unambiguously identify authored entries');
    assert.equal(opts.signal.aborted, false);
    const step = steps.shift(); assert.equal(step?.method, 'select', `Unexpected selector: ${title}`);
    const choice = choices.find(step.pick); assert.notEqual(choice, undefined, `Missing TEST action in ${JSON.stringify(choices)}`);
    return choice;
  };
  f.ctx.ui.input = async (title, _placeholder, opts) => {
    calls.push({ title }); assert.equal(opts.signal.aborted, false);
    const step = steps.shift(); assert.equal(step?.method, 'input'); return step.value;
  };
  return calls;
}
const select = (prefix) => ({ method: 'select', pick: (choice) => choice.startsWith(prefix) });
const number = (index) => ({ method: 'select', pick: (choice) => choice.startsWith(`[ ] ${index}.`) });
const input = (value) => ({ method: 'input', value });

test('RPC numbered duplicates preserve second single option, original partial index and exact preview', options, async (t) => {
  const f = await fixture(t);
  const steps = [select('Skip:'), number(2), select('Reply:'), input('TEST temporary custom'), select('Reply:'), input(''),
    select('Notes:'), input('TEST single note'), select('Next:'), select('Submit:')];
  const calls = script(f, steps);
  const result = await f.ask('TEST-rpc-single', [spec('TEST skipped?'), spec('TEST answered?')]);
  assert.deepEqual(result.details.answers, [{ questionIndex: 1, question: 'TEST answered?', notes: 'TEST single note',
    answer: 'Same', optionIndex: 1, wasCustom: false, preview: 'TEST_SECOND_PREVIEW' }]);
  assert.equal(result.details.cancelled, false); assert.equal(steps.length, 0);
  assert.ok(calls.some((call) => call.choices?.some((choice) => choice.includes('TEST_SECOND_PREVIEW'))));
});

test('RPC checks coexist with custom text, notes and null-aligned previews rather than inferring duplicate label indices', options, async (t) => {
  const f = await fixture(t);
  const steps = [number(2), number(1), select('Reply:'), input('TEST custom too'), select('Notes:'), input('TEST multi note'),
    select('Next:'), select('Submit:')];
  script(f, steps);
  const result = await f.ask('TEST-rpc-multi', [spec('TEST multi?', { multiSelect: true })]);
  assert.deepEqual(result.details.answers, [{ questionIndex: 0, question: 'TEST multi?', notes: 'TEST multi note',
    selected: ['Same', 'Same'], optionIndices: [0, 1], previews: [null, 'TEST_SECOND_PREVIEW'], answer: 'TEST custom too', wasCustom: true }]);
  assert.equal(result.details.cancelled, false); assert.equal(steps.length, 0);
});

test('RPC cancellation retains live checked/custom partial answers and notes under their original index', options, async (t) => {
  const f = await fixture(t);
  const steps = [select('Skip:'), number(2), select('Reply:'), input('TEST custom draft'), select('Notes:'), input('TEST live note'), select('Cancel:')];
  script(f, steps);
  const result = await f.ask('TEST-rpc-partial-cancel', [spec('TEST first?'), spec('TEST current?', { multiSelect: true })]);
  assert.deepEqual(result.details.answers, [{ questionIndex: 1, question: 'TEST current?', notes: 'TEST live note',
    selected: ['Same'], optionIndices: [1], previews: ['TEST_SECOND_PREVIEW'], answer: 'TEST custom draft', wasCustom: true }]);
  assert.equal(result.details.cancelled, true); assert.equal(steps.length, 0);
});

test('concurrent blocking producers have independent signals and source-local completion', options, async (t) => {
  const f = await fixture(t), groups = new Map(), abort = new AbortController();
  f.ctx.ui.testPresent = (group, _ctx, signal) => new Promise((resolve) => groups.set(group.id, { resolve, signal }));
  const first = f.ask('TEST-A', [spec('TEST A?')], abort.signal);
  const second = f.ask('TEST-B', [spec('TEST B?')]);
  await tick(); abort.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(groups.get('blocking:TEST-A').signal.aborted, true);
  assert.equal(groups.get('blocking:TEST-B').signal.aborted, false);
  const answer = { questionIndex: 0, question: 'TEST B?', optionIndex: 1, answer: 'Same', preview: 'TEST_SECOND_PREVIEW' };
  groups.get('blocking:TEST-B').resolve({ answers: [answer], cancelled: false });
  assert.deepEqual((await second).details, { groupId: 'blocking:TEST-B', answers: [answer], cancelled: false });
});

test('human Cancel is distinct from unsupported, tool abort, scope abort and session detachment', options, async (t) => {
  const f = await fixture(t);
  script(f, [select('Cancel:')]);
  assert.equal((await f.ask('TEST-cancel', [spec()])).details.cancelled, true);
  for (const ctx of [{ mode: 'print', hasUI: false }, { mode: 'json', hasUI: false }, { mode: 'tui', hasUI: false }]) {
    await assert.rejects(f.ask('TEST-unsupported', [spec()], undefined, { ...f.ctx, ...ctx }), { code: 'unsupported_host' });
  }
  f.ctx.mode = 'tui';
  const early = new AbortController(); early.abort();
  let invocations = 0, observed;
  f.ctx.ui.testPresent = async (_group, _ctx, signal) => { invocations++; observed = signal; return new Promise(() => {}); };
  await assert.rejects(f.ask('TEST-early', [spec()], early.signal), { name: 'AbortError' });
  assert.equal(invocations, 0);
  const later = new AbortController();
  const waiting = f.ask('TEST-later', [spec()], later.signal); await tick(); later.abort();
  await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(observed.aborted, true);
  const scope = new AbortController(); f.ctx.signal = scope.signal;
  const scoped = f.ask('TEST-scope', [spec()]); await tick(); scope.abort();
  await assert.rejects(scoped, { name: 'AbortError' }); delete f.ctx.signal;
  const detached = f.ask('TEST-detach', [spec()]); await tick(); await f.emit('session_shutdown');
  await assert.rejects(detached, { code: 'presentation_detached' });
  await assert.rejects(f.ask('TEST-retired', [spec()]), { code: 'presentation_detached' });
});

test('dialog abort never fabricates human cancellation; late failure is observed and presenter detachment propagates', options, async (t) => {
  const f = await fixture(t), abort = new AbortController();
  f.ctx.mode = 'rpc';
  let rejectDialog, dialogSignal;
  f.ctx.ui.select = (_title, _choices, opts) => { dialogSignal = opts.signal; return new Promise((_done, reject) => { rejectDialog = reject; }); };
  const pending = f.ask('TEST-dialog-abort', [spec()], abort.signal); await tick(); abort.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(dialogSignal.aborted, true);
  rejectDialog(new Error('TEST late dialog failure')); await tick();
  f.ctx.mode = 'tui';
  f.ctx.ui.testPresent = async () => { throw Object.assign(new Error('TEST presenter detached'), { code: 'presentation_detached' }); };
  await assert.rejects(f.ask('TEST-presenter-detached', [spec()]), { code: 'presentation_detached' });
});

test('same-registration session_start reopens TUI requests without reviving outgoing controllers or accepting late completion', options, async (t) => {
  const f = await fixture(t), presented = new Map(), question = spec('TEST same-registration lifecycle?');
  const present = (group, _ctx, signal) => new Promise((resolve) => presented.set(group.id, { resolve, signal }));
  f.ctx.ui.testPresent = present; await f.emit('session_start');
  const outgoing = f.ask('TEST_OLD', [question]); const detached = assert.rejects(outgoing, { code: 'presentation_detached' });
  await tick(); const old = presented.get('blocking:TEST_OLD'); assert.equal(old.signal.aborted, false);
  await f.emit('session_shutdown'); await detached; assert.equal(old.signal.aborted, true);
  await assert.rejects(f.ask('TEST_BETWEEN', [question]), { code: 'presentation_detached' }); assert.equal(presented.size, 1);
  const freshCtx = { mode: 'tui', hasUI: true, ui: { testPresent: present } };
  await f.emit('session_start', freshCtx);
  let settled = false;
  const fresh = f.ask('TEST_NEW', [question], undefined, freshCtx); fresh.then(() => { settled = true; }, () => {});
  try {
    await tick(); const current = presented.get('blocking:TEST_NEW'); assert.ok(current, 'Fresh request must reach presenter under the same registration');
    assert.equal(current.signal.aborted, false); assert.equal(old.signal.aborted, true);
    old.resolve({ answers: [{ questionIndex: 0, question: question.question, answer: 'TEST late old answer' }], cancelled: false });
    await tick(); assert.equal(settled, false); assert.equal(current.signal.aborted, false);
    const expected = { questionIndex: 0, question: question.question, answer: 'Same', optionIndex: 1, preview: 'TEST_SECOND_PREVIEW' };
    current.resolve({ answers: [expected], cancelled: false });
    assert.deepEqual((await fresh).details, { groupId: 'blocking:TEST_NEW', answers: [expected], cancelled: false });
    assert.equal(old.signal.aborted, true);
  } finally { await f.emit('session_shutdown', freshCtx); await fresh.catch(() => {}); }
});

test('same-registration SDK dialogs reopen after shutdown/start without converting late old dismissal into new decline', options, async (t) => {
  const f = await fixture(t); let oldResolve, oldSignal;
  const oldCtx = { mode: 'rpc', hasUI: true, ui: { select(_title, _choices, opts) { oldSignal = opts.signal; return new Promise((resolve) => { oldResolve = resolve; }); } } };
  await f.emit('session_start', oldCtx);
  const outgoing = f.ask('TEST_RPC_OLD', [spec()], undefined, oldCtx); const detached = assert.rejects(outgoing, { code: 'presentation_detached' });
  await tick(); await f.emit('session_shutdown', oldCtx); await detached; assert.equal(oldSignal.aborted, true);
  let selects = 0;
  const freshCtx = { mode: 'rpc', hasUI: true, ui: { async select(_title, choices, opts) {
    assert.equal(opts.signal.aborted, false); selects++;
    if (selects === 1) return choices.find((choice) => choice.startsWith('[ ] 2.'));
    if (selects === 2) return choices.find((choice) => choice.startsWith('Next:'));
    return choices.find((choice) => choice.startsWith('Submit:'));
  } } };
  await f.emit('session_start', freshCtx); oldResolve(undefined);
  const fresh = await f.ask('TEST_RPC_NEW', [spec()], undefined, freshCtx);
  assert.equal(selects, 3); assert.equal(fresh.details.cancelled, false);
  assert.equal(fresh.details.answers[0].optionIndex, 1); assert.equal(fresh.details.answers[0].preview, 'TEST_SECOND_PREVIEW');
  assert.equal(oldSignal.aborted, true);
});

test('large written results retain full standalone answers while model-facing text reports bounded truncation', options, async (t) => {
  const f = await fixture(t), answer = 'TEST written response\n'.repeat(6000);
  f.ctx.ui.testPresent = async () => ({ answers: [{ questionIndex: 0, question: 'TEST question?', answer, wasCustom: true }], cancelled: false });
  const result = await f.ask('TEST-long', [spec()]);
  assert.equal(result.details.answers[0].answer, answer);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
  assert.match(result.content[0].text, /truncated.*full answers.*details/);
  assert.match(result.content[0].text, /TEST written response/);
  assert.match(result.content[0].text, /"cancelled": false/);
  assert.match(result.content[0].text, /"questionIndex": 0/);
});

test('an oversized authored preview cannot erase the model-visible chosen answer or option identity', options, async (t) => {
  const f = await fixture(t), preview = 'TEST_OVERSIZED_PREVIEW '.repeat(9000);
  f.ctx.ui.testPresent = async () => ({ answers: [{ questionIndex: 0, question: 'TEST choose?', answer: 'TEST chosen answer',
    optionIndex: 1, preview, wasCustom: false }], cancelled: false });
  const result = await f.ask('TEST-preview', [spec('TEST choose?', { options: [{ label: 'Other' }, { label: 'TEST chosen answer', preview }] })]);
  assert.equal(result.details.answers[0].preview, preview);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
  assert.match(result.content[0].text, /TEST chosen answer/);
  assert.match(result.content[0].text, /"optionIndex": 1/);
  assert.match(result.content[0].text, /"cancelled": false/);
  assert.match(result.content[0].text, /truncated/);
});
