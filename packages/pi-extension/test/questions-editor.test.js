import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { editTextOutsidePi } from '../extensions/questions/external-editor.ts';

for (const failed of [false, true]) test(`explicit external editor ${failed ? 'failure' : 'replacement'} restores TUI and removes private file`, () => {
  const root = mkdtempSync(join(tmpdir(), 'owned-editor-proof-'));
  try {
    const script = join(root, 'editor.mjs'), record = join(root, 'record.json'), forbidden = join(root, 'must-not-execute');
    writeFileSync(script, `import fs from 'node:fs'; const file=process.argv[2]; fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({file,text:fs.readFileSync(file,'utf8'),mode:fs.statSync(file).mode&511})); ${failed ? 'process.exit(9);' : "fs.writeFileSync(file,'REPLACED\\nTEXT');"}`);
    const actions = [], tui = { stop: () => actions.push('stop'), start: () => actions.push('start'), requestRender: (force) => actions.push(['render', force]) };
    const original = `$(touch ${forbidden})\nOriginal private data`;
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    if (failed) assert.throws(() => editTextOutsidePi(tui, command, original), /exited 9/);
    else assert.equal(editTextOutsidePi(tui, command, original), 'REPLACED\nTEXT');
    const saved = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(saved.text, original); assert.equal(saved.mode, 0o600); assert.equal(existsSync(forbidden), false);
    assert.equal(existsSync(dirname(saved.file)), false); assert.deepEqual(actions, ['stop', 'start', ['render', true]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing editor is an explicit action failure without touching terminal state', () => {
  assert.throws(() => editTextOutsidePi({ stop() { assert.fail('must not stop'); } }, '', 'draft'), /No external editor/);
});
