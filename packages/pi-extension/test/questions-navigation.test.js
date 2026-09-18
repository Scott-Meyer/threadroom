import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const sdk = process.env.THREADROOM_PI_SDK_ROOT;
test('questions and Chat form a capability-gated flat keyboard navigation order without taking native editor keys', { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT', timeout: 30000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = fileURLToPath(new URL('../fixtures/questions-navigation-proof.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [fixture, root, sdk], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    flatQuestionChatOrder: true,
    honestChatFooter: true,
    configuredReturnKey: true,
    disabledReturnDisablesChatStop: true,
    reducedEditorCollapseReentry: true,
    publicEditorPolicy: true,
    questionCaretUndoNotesRetained: true,
    ordinaryDraftRetained: true,
    completionDelegated: true,
    thinkingShiftTabDelegated: true,
    blockerPreemption: true,
    foreignFocusRetained: true,
    navigationCapabilityGated: true,
    physicalPty: false,
  });
});
