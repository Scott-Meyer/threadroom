import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
    'package/runtime/threadroom-service.tgz',
  ]) assert.ok(archive.includes(path), `Packed artifact is missing ${path}`);
  assert.equal(archive.some(path => path.startsWith('package/node_modules/threadroom-service/')), false,
    'Installing private questions must not also install the app.');

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
  assert.equal(installedManifest.dependencies?.['threadroom-service'], undefined);
  assert.equal(installedManifest.optionalDependencies?.['threadroom-service'], undefined);
  await assert.rejects(stat(join(installedRoot, 'node_modules/threadroom-service')), { code: 'ENOENT' });
  const runtimeDirectory = join(agentDir, 'threadroom', 'runtime');
  await assert.rejects(stat(runtimeDirectory), { code: 'ENOENT' });
  // Private startup works even without the inert archive. An absent optional
  // runtime can never prevent the private question tool from being loaded.
  const serviceArchive = join(installedRoot, 'runtime/threadroom-service.tgz');
  const heldArchive = join(directory, 'held-service.tgz');
  await rename(serviceArchive, heldArchive);

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

  await assert.rejects(stat(runtimeDirectory), { code: 'ENOENT' });

  // A missing optional runtime must remain a shared-lane failure, not disable
  // private questions. Once supplied, the same activation can retry preparation.
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'threadroom.json'), JSON.stringify({ shared: true }));
  delete process.env.THREADROOM_API_URL;
  delete process.env.THREADROOM_UI_URL;
  delete process.env.THREADROOM_AUTO_START;
  const database = join(directory, 'must-not-start.sqlite');
  process.env.THREADROOM_DB = database;
  const enabled = await loadExtensions([target], installRoot);
  assert.deepEqual(enabled.errors, []);
  const enabledExtension = enabled.extensions[0];
  let enabledTools = [...enabledExtension.tools.keys()];
  enabled.runtime.getActiveTools = () => [...enabledTools];
  enabled.runtime.setActiveTools = names => { enabledTools = [...names]; };
  enabled.runtime.appendEntry = () => {};
  enabled.runtime.sendMessage = () => {};
  enabled.runtime.getSessionName = () => undefined;
  const warnings = [];
  const enabledContext = { ...context, sessionManager: SessionManager.inMemory(installRoot),
    ui: { setStatus() {}, notify(message) { warnings.push(message); } } };
  for (const handler of enabledExtension.handlers.get('session_start') || []) await handler({}, enabledContext);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Shared Threadroom is unavailable.*Private questions remain available/);
  assert.ok(enabledTools.includes('ask_user_question'));
  await assert.rejects(stat(runtimeDirectory), { code: 'ENOENT' });
  await assert.rejects(() => enabledExtension.tools.get('ask_user_question').definition.execute('missing-app-private-check', { questions: [{
    question: 'Does the private tool remain independent?', options: [{ label: 'Yes' }, { label: 'No' }],
  }] }, undefined, undefined, enabledContext), { code: 'unsupported_host' });
  // Opt-in makes the runtime available, but does not start a server without a
  // shared request or restored watch. Preparation uses only the shipped archive.
  await rename(heldArchive, serviceArchive);
  warnings.length = 0;
  for (const handler of enabledExtension.handlers.get('session_start') || []) await handler({}, enabledContext);
  assert.deepEqual(warnings, []);
  assert.ok(enabledTools.includes('threadroom_ask'));
  assert.ok((await stat(runtimeDirectory)).isDirectory(), 'Enabling shared Threadroom installs its runtime.');
  const { createManagedThreadroomService } = await import(pathToFileURL(join(installedRoot, 'src/service-runtime.js')).href);
  await createManagedThreadroomService({ baseUrl: 'http://127.0.0.1:4310', runtimeDirectory }).prepare();
  await assert.rejects(stat(database), { code: 'ENOENT' });
  for (const handler of enabledExtension.handlers.get('session_shutdown') || []) await handler({}, enabledContext);
  console.log(`Verified ${packedPackage.filename}: offline private-only install, Pi load without app resources, and offline runtime installation only after shared opt-in.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
