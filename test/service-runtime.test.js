import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, readFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

function deadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function runtime(bin, args, options) {
  const child = spawn(process.execPath, [bin, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', ended = false, resolveReady, rejectReady, resolveExit;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const record = bytes => {
    logs = (logs + bytes).slice(-64000);
    const match = logs.match(/(?:is ready at |Independent Threadroom UI: )(http:\/\/127\.0\.0\.1:\d+)/);
    if (match && (args[0] !== 'api' || /Durable records: .+\n/.test(logs))) resolveReady(match[1]);
  };
  child.stdout.on('data', record); child.stderr.on('data', record);
  child.on('error', error => { ended = true; rejectReady(error); resolveExit(); });
  child.on('exit', (code, signal) => {
    ended = true; resolveExit();
    rejectReady(new Error(`Service exited before readiness (${code ?? signal}):\n${logs}`));
  });
  return {
    ready: deadline(ready, 5000, () => `Service startup deadline:\n${logs}`),
    logs: () => logs,
    async stop() {
      if (ended || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      try { await deadline(exited, 3000, () => `Service SIGTERM deadline:\n${logs}`); }
      catch {
        if (!ended) child.kill('SIGKILL');
        await deadline(exited, 1000, () => `Service SIGKILL deadline:\n${logs}`);
      }
    }
  };
}

function isolatedEnvironment(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_DATA_HOME: join(home, 'xdg'), LOCALAPPDATA: join(home, 'local') };
  for (const key of ['THREADROOM_DB', 'THREADROOM_API_URL', 'THREADROOM_UI_URL', 'THREADROOM_SERVE_UI',
    'THREADROOM_SEED_DEMO', 'THREADROOM_UI_ORIGINS', 'PORT', 'UI_PORT', 'HOST']) delete env[key];
  return env;
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

test('the packed service runs outside the checkout and recovers one store across cwd and process changes', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-runtime-'));
  const processes = [];
  t.after(async () => {
    const cleanup = await Promise.allSettled(processes.map(process => process.stop()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(cleanup.filter(result => result.status === 'rejected'), [], 'Bounded service teardown failed');
  });
  const home = join(directory, 'home'), unpack = join(directory, 'installed service & resources');
  const firstCwd = join(directory, 'first working directory'), secondCwd = join(directory, 'unrelated working directory');
  await Promise.all([home, unpack, firstCwd, secondCwd].map(path => mkdir(path, { recursive: true })));
  await exec('npm', ['pack', '--workspace', 'threadroom-service', '--pack-destination', directory, '--silent'],
    { cwd: repository, timeout: 12000 });
  const archives = (await readdir(directory)).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  await exec('tar', ['-xzf', join(directory, archives[0]), '-C', unpack], { timeout: 5000 });
  const installed = join(unpack, 'package'), bin = join(installed, 'bin', 'threadroom-service.js');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'threadroom-service');
  assert.equal(manifest.private, true);
  assert.equal(manifest.pi, undefined, 'Service must not be a Pi extension');
  assert.equal(manifest.workspaces, undefined);
  assert.ok((await stat(bin)).mode & 0o111);
  assert.equal((await readdir(installed)).includes('node_modules'), false);
  assert.equal((await readdir(installed)).includes('packages'), false);

  const env = isolatedEnvironment(home);
  const api = runtime(bin, ['api', '--port', '0'], { cwd: firstCwd, env }); processes.push(api);
  const apiUrl = await api.ready;
  assert.deepEqual((await json(apiUrl + '/api/tree')).nodes, [], 'Installed service must not silently seed fake requests');
  const database = api.logs().match(/Durable records: (.+)/)?.[1];
  const databaseFromHome = database ? relative(home, database) : '';
  assert.ok(
    database && isAbsolute(database) && databaseFromHome && !isAbsolute(databaseFromHome) &&
      databaseFromHome !== '..' && !databaseFromHome.startsWith(`..${sep}`),
    'Default store must be stable user data within the isolated home, not cwd or a sibling path'
  );
  const ui = runtime(bin, ['ui', '--api-url', apiUrl, '--port', '0'], { cwd: secondCwd, env }); processes.push(ui);
  const uiUrl = await ui.ready;
  assert.equal((await json(uiUrl + '/threadroom-config.json')).apiBaseUrl, apiUrl);
  for (const asset of ['/', '/app.js', '/client.js', '/presentations.js', '/styles.css', '/assets/mist-drift.svg']) {
    assert.equal((await fetch(uiUrl + asset, { signal: AbortSignal.timeout(3000) })).status, 200, `Packed UI resource ${asset}`);
  }
  const input = { question: 'TEST packed-service recovery',
    presentation: { kind: 'comparison-v1', revision: 'packed-review',
      options: [{ id: 'drift', label: 'Captured image from the installed bundle', image: '/assets/mist-drift.svg' }] },
    author: { name: 'Automated runtime check—not Scott' } };
  const published = await json(apiUrl + '/api/ask', { method: 'POST', headers: { 'Idempotency-Key': 'packed-recovery' }, body: JSON.stringify(input) });
  const before = await json(apiUrl + '/api/nodes/' + published.node.id);
  // /assets/ capture is the comparison convenience's promise; authored HTML
  // instead requires self-contained resources and is not silently rewritten.
  assert.match(before.node.presentation.options[0].image, /^data:image\/svg\+xml;base64,/);
  await api.stop();
  assert.equal((await fetch(uiUrl + '/')).status, 200, 'UI must have an independent lifetime');

  const resumed = runtime(bin, ['api', '--port', new URL(apiUrl).port],
    { cwd: secondCwd, env: { ...env, THREADROOM_UI_ORIGINS: uiUrl } }); processes.push(resumed);
  assert.equal(await resumed.ready, apiUrl);
  assert.equal(resumed.logs().match(/Durable records: (.+)/)?.[1], database);
  const after = await json(apiUrl + '/api/nodes/' + published.node.id);
  assert.deepEqual(after.node, before.node);
  const retry = await json(apiUrl + '/api/ask', { method: 'POST', headers: { 'Idempotency-Key': 'packed-recovery' }, body: JSON.stringify(input) });
  assert.equal(retry.node.id, published.node.id); assert.equal(retry.deduplicated, true);
  const answer = await json(apiUrl + '/api/nodes/' + published.node.id + '/respond', {
    method: 'POST', headers: { Origin: uiUrl }, body: JSON.stringify({ body: '[TEST] Saved through the configured browser origin, not Scott’s feedback.' }) });
  await ui.stop();
  assert.equal((await json(apiUrl + '/api/nodes/' + answer.responseId)).node.body, answer.node.body);
  for (const cwd of [firstCwd, secondCwd]) assert.equal((await readdir(cwd)).includes('data'), false);

  if (process.platform === 'darwin') {
    const configHome = join(directory, 'config-only home'), output = join(directory, 'generated configs');
    await mkdir(configHome);
    const chosenDatabase = join(directory, 'chosen data & path', 'records.sqlite');
    await exec(process.execPath, [bin, 'launchd-config', '--output-dir', output, '--database', chosenDatabase],
      { cwd: firstCwd, env: isolatedEnvironment(configHome), timeout: 5000 });
    assert.deepEqual(await readdir(configHome), [], 'Generating config must not install jobs or create a store/logs');
    const plists = (await readdir(output)).filter(name => name.endsWith('.plist'));
    assert.equal(plists.length, 2);
    const jobs = [];
    for (const name of plists) {
      const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', join(output, name)], { timeout: 3000 });
      const job = JSON.parse(stdout); jobs.push(job);
      assert.equal(job.KeepAlive, true);
      assert.equal(job.ProgramArguments[0], process.execPath);
      // Node resolves installed entrypoints through filesystem symlinks.
      assert.ok(job.ProgramArguments.includes(await realpath(bin)));
      assert.ok(isAbsolute(job.WorkingDirectory));
      assert.ok(isAbsolute(job.StandardOutPath));
      assert.ok(isAbsolute(job.StandardErrorPath));
    }
    assert.equal(new Set(jobs.map(job => job.Label)).size, 2);
    const apiJob = jobs.find(job => job.ProgramArguments.includes('api'));
    assert.ok(apiJob.ProgramArguments.includes(chosenDatabase), 'Supervisor config must retain the explicit database even with XML-sensitive paths');
    assert.ok(jobs.some(job => job.ProgramArguments.includes('ui')));
  }
});
