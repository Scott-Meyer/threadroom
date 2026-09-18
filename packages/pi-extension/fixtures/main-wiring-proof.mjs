import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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
assert.equal(appends, 0, 'unsupported hosts cannot create question rows'); assert.equal(sends, 0);
console.log(JSON.stringify({ syntheticNotScott: true, humanAcceptance: false, realMainFactory: true, rawProducerRegistrationsExactlyOnce: true, sharedToolsRemainSeparate: true, printNotHumanCancel: true, registrations: names }, null, 2));
