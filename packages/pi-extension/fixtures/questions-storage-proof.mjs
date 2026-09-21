import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, sdk] = process.argv.slice(2), local = mkdtempSync(join(tmpdir(), 'question-storage-gate-'));
const host = (path) => import(pathToFileURL(resolve(sdk, path)).href);
const { SessionManager } = await host('dist/core/session-manager.js'), { loadExtensions } = await host('dist/core/extensions/loader.js');
const seed = { role: 'assistant', content: [{ type: 'text', text: 'Explicit TEST seed, not human feedback' }], api: 'test', provider: 'test', model: 'test', timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const details = [];
try {
  for (const scenario of ['question', 'answer', 'receipt', 'blocking-receipt', 'preappend']) {
    const manager = SessionManager.create(local, join(local, scenario)); manager.appendMessage(seed);
    const sends = [], notices = [], ctx = { mode: 'tui', hasUI: true, sessionManager: manager, isIdle: () => true, ui: { setStatus() {}, setWidget() {}, notify(message) { notices.push(message); } } };
    async function factory() {
      const loaded = await loadExtensions([resolve(root, 'packages/pi-extension/fixtures/questions-storage-proof.ts')], local); assert.deepEqual(loaded.errors, []);
      loaded.runtime.appendEntry = (type, data) => manager.appendCustomEntry(type, data); loaded.runtime.sendMessage = (message) => sends.push(message);
      return { loaded, extension: loaded.extensions[0], tool: loaded.extensions[0].tools.get('ask_user_question_async').definition,
        blocking: loaded.extensions[0].tools.get('ask_user_question').definition };
    }
    let api = await factory();
    const emit = async (name) => { for (const handler of api.extension.handlers.get(name) || []) await handler({}, ctx); };
    const create = (id = 'original') => api.tool.execute(id, { question: 'TEST original question?', options: ['One', 'Two'] }, undefined, () => {}, ctx);
    let question;
    if (scenario !== 'question') { question = await create(); assert.equal(question.details.status, 'pending'); }
    const binding = () => globalThis[Symbol.for('threadroom.test.storage-binding')];
    if (scenario === 'preappend') {
      const original = api.loaded.runtime.appendEntry; api.loaded.runtime.appendEntry = () => { throw new Error('Controlled no-mutation refusal'); };
      assert.throws(() => binding().commit({ questionId: question.details.id, text: 'draft' }), /no-mutation/);
      api.loaded.runtime.appendEntry = original; binding().commit({ questionId: question.details.id, text: 'draft' }); assert.equal(sends.length, 1);
      details.push({ scenario, retryable: true }); continue;
    }
    if (scenario === 'receipt') { binding().commit({ questionId: question.details.id, text: 'Two', optionIndex: 1 }); assert.equal(sends.length, 1); }
    let blockingResult;
    if (scenario === 'blocking-receipt') {
      const waiting = api.blocking.execute('wait-existing', { questions: [{ questionId: question.details.id }] }, undefined, () => {}, ctx);
      await new Promise((resolve) => setImmediate(resolve));
      binding().commit({ questionId: question.details.id, text: 'Promoted answer', optionIndex: 1 });
      blockingResult = await waiting; assert.equal(sends.length, 0);
      assert.equal(blockingResult.details.receivedNativeAnswerIds.length, 1);
    }
    const file = manager.getSessionFile(), backup = file + '.backup', before = new Set(manager.getBranch().map((entry) => entry.id));
    renameSync(file, backup); mkdirSync(file);
    if (scenario === 'question') { question = await create(); assert.equal(question.details.status, 'storage_unconfirmed'); }
    else if (scenario === 'answer') assert.throws(() => binding().commit({ questionId: question.details.id, text: 'Two', optionIndex: 1 }), { code: 'storage_unconfirmed' });
    else if (scenario === 'blocking-receipt') assert.throws(() => manager.appendMessage({ role: 'toolResult', toolCallId: 'wait-existing', toolName: 'ask_user_question',
      content: blockingResult.content, details: blockingResult.details, isError: false, timestamp: Date.now() }), /EISDIR/);
    else assert.throws(() => manager.appendCustomMessageEntry('threadroom.native.feedback.v1', 'TEST receipt', true, sends[0].details), /EISDIR/);
    const failed = manager.getBranch().filter((entry) => !before.has(entry.id)); assert.equal(failed.length, 1);
    rmSync(file, { recursive: true }); renameSync(backup, file);
    const disk = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); assert.equal(disk.some((entry) => entry.id === failed[0].id), false);
    await emit('turn_end'); await emit('agent_settled');
    const expectedSends = scenario === 'receipt' ? 1 : 0; assert.equal(sends.length, expectedSends);
    if (scenario === 'blocking-receipt') {
      await assert.rejects(api.blocking.execute('retry-wait', { questions: [{ questionId: question.details.id }] }, undefined, () => {}, ctx), { code: 'storage_unconfirmed' });
    }
    const branchSize = manager.getEntries().length;
    const blocked = await create('new-after-fault'); assert.equal(blocked.details.status, 'storage_unconfirmed'); assert.equal(manager.getEntries().length, branchSize);
    await emit('session_shutdown'); api = await factory(); await emit('session_start');
    const renderer = api.extension.entryRenderers.get(failed[0].customType);
    if (renderer) assert.doesNotMatch(renderer(failed[0], {}, { fg(_color, text) { return text; } }).render(80)[0], /saved/i, 'raw entry renderer must not assert storage before binding');
    assert.equal((await create('after-reload')).details.status, 'storage_unconfirmed'); assert.equal(sends.length, expectedSends);
    await api.extension.commands.get('asks').handler('', ctx);
    assert.match(notices.at(-1), /Recover the original SDK journal/);
    assert.match(notices.at(-1), /Preserve\/copy retained drafts/);
    assert.match(notices.at(-1), /Do not quit\/resume as a feedback retry/);
    assert.doesNotMatch(notices.at(-1), /quit Pi and resume this original session to recover/);
    if (scenario === 'answer') assert.throws(() => binding().commit({ questionId: question.details.id, text: 'retry cannot repair SDK' }), { code: 'storage_unconfirmed' });
    details.push({ scenario, actualFilesystemFailure: true, failedEntryInMemory: true, failedEntryOnDisk: false, faultRemovalAndReloadRemainBlocked: true, extraSends: sends.length - expectedSends });
  }
  console.log(JSON.stringify({ syntheticNotScott: true, humanAcceptance: false, sdkPublicBoundary: true, journalRepairNotClaimed: true, details }, null, 2));
} finally { rmSync(local, { recursive: true, force: true }); }
