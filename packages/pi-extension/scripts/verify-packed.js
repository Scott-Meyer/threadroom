import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sdk = process.env.THREADROOM_PI_SDK_ROOT;
if (!sdk) throw new Error('Set THREADROOM_PI_SDK_ROOT to the supported installed Pi package before checking a release artifact.');

const directory = await mkdtemp(join(tmpdir(), 'threadroom-pi-packed-'));
const agentDir = join(directory, 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.THREADROOM_API_URL = '::release-check-must-not-connect::';
try {
  const packed = spawnSync('npm', ['pack', '--workspace', 'threadroom-pi', '--json', '--pack-destination', directory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const starts = [packed.stdout.indexOf('\n{'), packed.stdout.indexOf('\n[')].filter(index => index >= 0);
  const jsonStart = starts.length ? Math.min(...starts) + 1 : 0;
  const report = JSON.parse(packed.stdout.slice(jsonStart));
  const packedPackage = Array.isArray(report) ? report[0] : report['threadroom-pi'] || Object.values(report)[0];
  assert.ok(packedPackage);
  const tarball = join(directory, packedPackage.filename);
  const archive = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
  for (const path of [
    'package/extensions/index.ts',
    'package/LICENSE',
    'package/node_modules/threadroom-service/package.json',
    'package/node_modules/threadroom-service/bin/threadroom-service.js',
    'package/node_modules/threadroom-service/lib/ensure.js',
    'package/node_modules/threadroom-service/lib/paths.js',
    'package/node_modules/threadroom-service/dist/src/main.js',
    'package/node_modules/threadroom-service/dist/public/index.html',
  ]) assert.ok(archive.includes(path), `Packed artifact is missing ${path}`);

  const installRoot = join(directory, 'install');
  const installed = spawnSync('npm', ['install', '--prefix', installRoot, '--ignore-scripts', '--legacy-peer-deps', '--offline', tarball], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const installedRoot = join(installRoot, 'node_modules', 'threadroom-pi');
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installedManifest.name, 'threadroom-pi');
  assert.equal(installedManifest.version, packedPackage.version);
  const bundledManifest = JSON.parse(await readFile(join(installedRoot, 'node_modules', 'threadroom-service', 'package.json'), 'utf8'));
  assert.equal(bundledManifest.name, 'threadroom-service');

  const { loadExtensions } = await import(pathToFileURL(join(sdk, 'dist/core/extensions/loader.js')).href);
  const { SessionManager } = await import(pathToFileURL(join(sdk, 'dist/core/session-manager.js')).href);
  const target = join(installedRoot, 'extensions', 'index.ts');
  const loaded = await loadExtensions([target], installRoot);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools.has('ask_user_question'));
  assert.equal(extension.tools.has('ask_user_question_async'), false);

  let activeTools = [...extension.tools.keys()];
  loaded.runtime.getActiveTools = () => [...activeTools];
  loaded.runtime.setActiveTools = names => { activeTools = [...names]; };
  loaded.runtime.appendEntry = () => {};
  loaded.runtime.sendMessage = () => {};
  const context = {
    mode: 'print', hasUI: false, cwd: installRoot, isIdle: () => true,
    sessionManager: SessionManager.inMemory(installRoot),
    ui: { setStatus() {}, notify() {} },
  };
  for (const handler of extension.handlers.get('session_start') || []) await handler({}, context);
  assert.deepEqual(activeTools, ['ask_user_question'], 'Shared tools must remain inactive after a clean default start.');
  const ask = extension.tools.get('ask_user_question').definition;
  await assert.rejects(() => ask.execute('release-print-check', { questions: [{
    question: 'Can this clean package present a private question?', options: [{ label: 'Yes' }, { label: 'No' }],
  }] }, undefined, undefined, context), { code: 'unsupported_host' });
  for (const handler of extension.handlers.get('session_shutdown') || []) await handler({}, context);

  console.log(`Verified ${packedPackage.filename}: clean offline install, bundled service, installed Pi load, private tool, and default-off shared lane.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
