import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { installServiceRuntime } from '../src/service-install.js';

const execFileAsync = promisify(execFile);
const installerUrl = new URL('../src/service-install.js', import.meta.url).href;

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom installer fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function packFixture(directory, snapshot = 'first') {
  const source = join(directory, `source-${snapshot}`);
  const output = join(directory, `packed-${snapshot}`);
  await mkdir(source, { recursive: true });
  await mkdir(output, { recursive: true });
  const forbiddenScript = `node -e "throw new Error('lifecycle scripts must never run')"`;
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'threadroom-service', version: '1.0.0', type: 'module',
    bin: { 'threadroom-service': './cli.js' },
    scripts: { preinstall: forbiddenScript, install: forbiddenScript, postinstall: forbiddenScript },
  }));
  await writeFile(join(source, 'runtime.js'), `export const snapshot = ${JSON.stringify(snapshot)};\n`);
  await writeFile(join(source, 'cli.js'), `#!/usr/bin/env node\nimport { snapshot } from './runtime.js';\nconsole.log(snapshot);\n`);
  // Pack only this disposable fixture, never the live workspace or service.
  const packCommand = process.platform === 'win32' ? process.execPath : 'npm';
  const packArgs = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];
  const { stdout } = await execFileAsync(packCommand, [
    ...packArgs, 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', output,
    '--cache', join(directory, 'packing-cache'),
  ], { cwd: source });
  const packed = Object.values(JSON.parse(stdout))[0];
  return join(output, packed.filename);
}

async function makeNpmCli(directory, source) {
  await mkdir(directory, { recursive: true });
  const cli = join(directory, 'npm-cli.js');
  await writeFile(cli, source);
  return cli;
}

async function installInProcess(options, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    const { installServiceRuntime } = await import(${JSON.stringify(installerUrl)});
    console.log(JSON.stringify(await installServiceRuntime(${JSON.stringify(options)})));
  `], { env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

async function assertRunnable(directory, expected) {
  const { stdout } = await execFileAsync(process.execPath, [join(directory, 'cli.js')]);
  assert.equal(stdout.trim(), expected);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'threadroom-service');
  assert.equal(manifest.version, '1.0.0');
}

test('importing the installer does not install or create any files', async (t) => {
  const directory = await sandbox(t);
  await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    const { installServiceRuntime } = await import(${JSON.stringify(installerUrl)});
    if (typeof installServiceRuntime !== 'function') throw new Error('missing installer');
  `], {
    cwd: directory,
    env: { ...process.env, PATH: '', HOME: directory, USERPROFILE: directory,
      XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory,
      npm_config_cache: directory, npm_config_prefix: directory },
  });
  assert.deepEqual(await readdir(directory), []);
});

test('explicit installation is offline, script-free, runnable, and reusable without npm', async (t) => {
  const directory = await sandbox(t);
  const archivePath = await packFixture(directory);
  const installRoot = join(directory, 'runtime');
  await assert.rejects(access(installRoot), { code: 'ENOENT' });
  const installed = await installInProcess({ archivePath, installRoot }, {
    // If installation falls back to the registry it cannot succeed. Scripts
    // would throw; successful installation also proves they were not run.
    npm_config_registry: 'http://127.0.0.1:1',
    npm_config_offline: 'false', npm_config_ignore_scripts: 'false', npm_config_dry_run: 'true',
    npm_config_cache: join(directory, 'external-cache'),
    npm_config_logs_dir: join(directory, 'external-logs'),
    npm_config_prefix: join(directory, 'external-prefix'),
  });
  for (const name of ['external-cache', 'external-logs', 'external-prefix']) {
    await assert.rejects(access(join(directory, name)), { code: 'ENOENT' });
  }
  assert.ok(isAbsolute(installed));
  assert.ok(!relative(installRoot, installed).startsWith('..'));
  await assertRunnable(installed, 'first');
  const before = await stat(join(installed, 'cli.js'));
  const unusableNpm = await makeNpmCli(join(directory, 'unusable-npm'), `throw new Error('npm must not run on reuse');`);
  assert.equal(await installInProcess({ archivePath, installRoot }, { PATH: '', npm_execpath: unusableNpm }), installed);
  assert.equal((await stat(join(installed, 'cli.js'))).mtimeMs, before.mtimeMs);
  assert.equal((await readdir(installRoot)).length, 1);
});

test('concurrent sessions share one complete installation', async (t) => {
  const directory = await sandbox(t);
  const archivePath = await packFixture(directory);
  const installRoot = join(directory, 'runtime');
  const installed = await Promise.all(Array.from({ length: 4 }, async () => {
    const result = await installInProcess({ archivePath, installRoot });
    // Every caller can use its result immediately, not only after all finish.
    await assertRunnable(result, 'first');
    return result;
  }));
  assert.equal(new Set(installed).size, 1);
  assert.equal((await readdir(installRoot)).length, 1);
});

test('a failed attempt is retryable and does not disturb a completed runtime', async (t) => {
  const directory = await sandbox(t);
  const firstArchive = await packFixture(directory);
  const secondArchive = await packFixture(directory, 'second');
  const installRoot = join(directory, 'runtime');
  const first = await installServiceRuntime({ archivePath: firstArchive, installRoot });
  const failingNpm = await makeNpmCli(join(directory, 'failing-npm'), `throw new Error('intentional installation failure');`);
  await assert.rejects(installInProcess({ archivePath: secondArchive, installRoot }, { npm_execpath: failingNpm }), /intentional installation failure/);
  assert.equal((await readdir(installRoot)).length, 1);
  await assertRunnable(first, 'first');
  const retried = await installServiceRuntime({ archivePath: secondArchive, installRoot });
  assert.notEqual(retried, first);
  await assertRunnable(retried, 'second');
  await assertRunnable(first, 'first');
});

test('same-version archives with different bytes coexist, and bad archives can be replaced and retried', async (t) => {
  const directory = await sandbox(t);
  const firstArchive = await packFixture(directory);
  const secondArchive = await packFixture(directory, 'second');
  const installRoot = join(directory, 'runtime');
  const archivePath = join(directory, 'current-service.tgz');
  await writeFile(archivePath, 'not a package archive');
  await assert.rejects(installServiceRuntime({ archivePath, installRoot }));
  assert.deepEqual(await readdir(installRoot), []);
  await writeFile(archivePath, await readFile(firstArchive));
  const first = await installServiceRuntime({ archivePath, installRoot });
  await writeFile(archivePath, await readFile(secondArchive));
  const second = await installServiceRuntime({ archivePath, installRoot });
  assert.notEqual(first, second);
  await assertRunnable(first, 'first');
  await assertRunnable(second, 'second');
  assert.equal((await readdir(installRoot)).length, 2);
  // Path spelling is not cache identity: an equivalent archive is reused.
  assert.equal(await installServiceRuntime({ archivePath: secondArchive, installRoot }), second);
  const runtime = await import(pathToFileURL(join(second, 'runtime.js')));
  assert.equal(runtime.snapshot, 'second');
});

test('a simulated Windows npm.cmd layout launches JavaScript with literal path arguments', async (t) => {
  const directory = await sandbox(t);
  const archivePath = await packFixture(directory);
  const installRoot = join(directory, 'runtime & $literal %PATH%');
  const npmDirectory = join(directory, 'Node with spaces & symbols');
  const recordPath = join(directory, 'launcher-record.json');
  const npmCli = await makeNpmCli(join(npmDirectory, 'node_modules/npm/bin'), `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
      executable: process.execPath, cli: process.argv[1], args,
      archive: fs.readFileSync(args[1]).toString('base64'),
    }));
    throw new Error('simulated npm entry reached');
  `);
  await writeFile(join(npmDirectory, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n');
  const otherPackageManager = join(directory, 'pnpm.cjs');
  await writeFile(otherPackageManager, `throw new Error('must not launch pnpm as npm');`);
  await assert.rejects(installInProcess({ archivePath, installRoot }, {
    PATH: npmDirectory, npm_execpath: otherPackageManager,
  }), /simulated npm entry reached/);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.executable, process.execPath);
  assert.equal(record.cli, await realpath(npmCli));
  assert.equal(record.args[0], 'install');
  assert.ok(record.args.includes('--offline'));
  assert.ok(record.args.includes('--ignore-scripts'));
  const prefix = record.args[record.args.indexOf('--prefix') + 1];
  assert.ok(prefix.startsWith(installRoot));
  assert.equal(record.archive, (await readFile(archivePath)).toString('base64'));
  assert.deepEqual(await readdir(installRoot), []);
});

test('a hung npm child is killed within the requested timeout, cleaned up, and retryable', { timeout: 15_000 }, async (t) => {
  const directory = await sandbox(t);
  const archivePath = await packFixture(directory);
  const installRoot = join(directory, 'runtime');
  const hangingNpm = await makeNpmCli(join(directory, 'hanging-npm'), `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `);
  const started = Date.now();
  await assert.rejects(installInProcess({ archivePath, installRoot, timeoutMs: 250 }, {
    npm_execpath: hangingNpm,
  }), /SIGKILL/);
  assert.ok(Date.now() - started < 5000, 'a timed-out child must not keep installation waiting');
  assert.deepEqual(await readdir(installRoot), []);
  const retried = await installServiceRuntime({ archivePath, installRoot });
  await assertRunnable(retried, 'first');
});

test('invalid timeout values reject before creating installation files', async (t) => {
  const directory = await sandbox(t);
  const installRoot = join(directory, 'runtime');
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648, '1000']) {
    await assert.rejects(installServiceRuntime({
      archivePath: join(directory, 'not-read.tgz'), installRoot, timeoutMs,
    }), { name: 'RangeError' });
  }
  await assert.rejects(access(installRoot), { code: 'ENOENT' });
});
