import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sdk = process.env.THREADROOM_PI_SDK_ROOT;
test('actual package MAIN registers private producers once while shared tools default off and unsupported hosts stay honest', { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT', timeout: 30000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = fileURLToPath(new URL('../fixtures/main-wiring-proof.mjs', import.meta.url));
  const agentDir = mkdtempSync(join(tmpdir(), 'threadroom-main-agent-'));
  let result;
  try {
    result = spawnSync(process.execPath, [fixture, root, sdk], { encoding: 'utf8', timeout: 25000,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, THREADROOM_API_URL: '::disabled-invalid-endpoint::' } });
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.rawProducerRegistrationsExactlyOnce, true);
  assert.equal(proof.sharedToolsDefaultOff, true);
  assert.equal(proof.olderSdkCapabilityBoundary, true);
  assert.equal(proof.stockBlockingOnlyAsks, true);
  assert.equal(proof.stockAsyncPersistence, true);
  assert.equal(proof.stockPromotionIdentity, true);
  assert.equal(proof.stockPromotionNoDuplicate, true);
  assert.equal(proof.stockPromotionCancelPreservesQuestion, true);
  assert.equal(proof.stockAnswerBeforeWaitNoDuplicate, true);
  assert.equal(proof.stockSaveThenAbortRecoversFeedback, true);
  assert.equal(proof.stockSettledHandoffBoundarySafe, true);
  assert.equal(proof.stockFreshCompletionBoundarySafe, true);
  assert.equal(proof.stockRpcCompletionBoundarySafe, true);
  assert.equal(proof.stockImmediateWaitBoundarySafe, true);
  assert.equal(proof.stockTransitionGatesBothProducers, true);
  assert.equal(proof.stockUnknownTransitionStaysClosed, true);
  assert.equal(proof.stockOriginalEditorCaret, true);
});
