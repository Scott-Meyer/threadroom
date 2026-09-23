import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sdk = process.env.THREADROOM_PI_SDK_ROOT;

// A host extension shows private questions in its own UI; the terminal stays usable,
// and whichever surface the person answers in wins.
test('another extension can present private questions and answer them', { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT', timeout: 30000 }, () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const fixture = fileURLToPath(new URL('../fixtures/presenter-proof.mjs', import.meta.url));
  const agentDir = mkdtempSync(join(tmpdir(), 'threadroom-presenter-agent-'));
  let result;
  try {
    result = spawnSync(process.execPath, [fixture, root, sdk], { encoding: 'utf8', timeout: 25000,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, THREADROOM_API_URL: '::disabled-invalid-endpoint::' } });
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout);

  assert.deepEqual(proof.blockingOffered, { mode: 'blocking', required: false, questions: ['Which silhouette?', 'Anything else?'], terminalShown: true },
    'a presenter loaded before Threadroom still receives the group, and the terminal shows it too');
  assert.equal(proof.blockingSubmit, true);
  assert.deepEqual(proof.blockingResult, { terminalReleased: true, secondSubmit: false, cancelled: false,
    answers: [{ questionIndex: 0, question: 'Which silhouette?', notes: 'softer', answer: 'Wide', optionIndex: 0, wasCustom: false, preview: 'W' }] },
    'answering in the presenter finishes the tool call, releases the terminal, and cannot be submitted twice');

  assert.deepEqual(proof.terminalAnswered, { dismissed: 'answered', answer: 'Wide' },
    'answering in the terminal dismisses the presenter copy');

  assert.deepEqual(proof.asyncOffered, { mode: 'async', required: false, notes: false });
  assert.deepEqual(proof.asyncAnswered, { updates: [true], dismissed: 'answered', waitStatus: 'answered', terminalReleased: true,
    answers: [{ questionIndex: 0, question: 'Later: which palette?', answer: 'Warmer than both', wasCustom: true }] },
    'a nonblocking question becomes required when the AI waits, and a presenter answer is saved and delivered once');
});
