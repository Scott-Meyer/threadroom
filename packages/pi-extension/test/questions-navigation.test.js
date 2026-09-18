import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const sdk = process.env.THREADROOM_PI_SDK_ROOT;
test('Chat is a fixed home anchor and a separate global shortcut cycles all visible stops without taking native editor Tab', { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT', timeout: 30000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = fileURLToPath(new URL('../fixtures/questions-navigation-proof.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [fixture, root, sdk], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    chatHomeAnchor: true,
    globalCycleOrder: true,
    questionTabLocal: true,
    nativeChatTabs: true,
    configurableCyclePair: true,
    collapseIndependent: true,
    reducedPublicEditorSupported: true,
    questionCaretUndoNotesRetained: true,
    ordinaryDraftRetained: true,
    blockerPreemption: true,
    foreignFocusRetained: true,
    navigationCapabilityGated: true,
    oneShotGuards: true,
    physicalPty: false,
  });
});
