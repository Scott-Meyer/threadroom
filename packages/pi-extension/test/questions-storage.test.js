import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const sdk = process.env.THREADROOM_PI_SDK_ROOT;
test('actual SDK filesystem failures cannot become native answers or receipts; refresh/reload stay fail-closed while preappend refusals retry', { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT', timeout: 30000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = fileURLToPath(new URL('../fixtures/questions-storage-proof.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [fixture, root, sdk], { encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout); assert.equal(proof.humanAcceptance, false);
  assert.deepEqual(proof.details.map((item) => item.scenario), ['question', 'answer', 'receipt', 'blocking-receipt', 'preappend']);
  assert.equal(proof.details.find((item) => item.scenario === 'blocking-receipt').extraSends, 0);
});
