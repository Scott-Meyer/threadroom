import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const sdk = process.env.THREADROOM_PI_SDK_ROOT;
test('question tabs use Tab locally and a capability-gated focus toggle without synthetic Chat navigation labels', { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT', timeout: 30000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = fileURLToPath(new URL('../fixtures/questions-navigation-proof.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [fixture, root, sdk], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    questionTabsOnly: true,
    focusToggle: true,
    nativeChatTab: true,
    retiredGlobalCycle: true,
    configurableToggle: true,
    collapseIndependent: true,
    publicEditorCapability: true,
    selectedSolidPassiveDotted: true,
    boundedSmallTerminal: true,
    questionCaretUndoNotesRetained: true,
    ordinaryDraftRetained: true,
    pausedReturn: true,
    localReveal: true,
    blockerPreemption: true,
    foreignFocusRetained: true,
    replacementIdentityControl: true,
    foreignLifecycleControl: true,
    stockPassiveExplicitLoan: true,
    stockBlockerNoInterruption: true,
    stockLostOriginNoGuess: true,
    stockForeignSpanNativeKeys: true,
    passiveFooterUsesActualFocus: true,
    knownPromptHidesUnavailableRoutes: true,
    collapsedHintUsesAvailableRoute: true,
    suspendedProjectionInactive: true,
    oneShotGuards: true,
    physicalPty: false,
  });
});
