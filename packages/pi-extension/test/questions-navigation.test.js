import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const sdk = process.env.THREADROOM_PI_SDK_ROOT;
test('async tabs stay passive while blockers make the shared question surface modal', { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT', timeout: 30000 }, () => {
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
    asyncCoreArrivalPassive: true,
    stockPassiveExplicitLoan: true,
    stockBlockerModal: true,
    unifiedBlockingTabs: true,
    modalReuseReset: true,
    exactModalReturn: true,
    replacementModalRebind: true,
    explicitStockModalRebind: true,
    paneOwnedAsyncFallback: true,
    collapsedModalFallback: true,
    deferredOverlayReturn: true,
    retiredDeferredHandoff: true,
    stockLostOriginNoGuess: true,
    stockForeignSpanNativeKeys: true,
    passiveFooterUsesActualFocus: true,
    knownPromptHidesUnavailableRoutes: true,
    truthfulSuspendedCopy: true,
    collapsedHintUsesAvailableRoute: true,
    suspendedProjectionInactive: true,
    oneShotGuards: true,
    physicalPty: false,
  });
});
