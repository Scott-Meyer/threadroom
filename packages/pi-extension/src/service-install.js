import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function npmCliAt(candidate) {
  try {
    const physical = await realpath(candidate);
    if (basename(physical).toLowerCase() === 'npm-cli.js' && (await stat(physical)).isFile()) return physical;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
}

async function resolveNpmCli() {
  // npm sets this for its children; yarn/pnpm may set it to a different CLI.
  if (process.env.npm_execpath && basename(process.env.npm_execpath).toLowerCase() === 'npm-cli.js') {
    const inherited = await npmCliAt(process.env.npm_execpath);
    if (inherited) return inherited;
  }
  const directories = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), dirname(process.execPath)];
  for (const directory of new Set(directories)) {
    for (const candidate of [
      join(directory, 'npm'), // Unix symlink to npm-cli.js.
      join(directory, 'npm-cli.js'), // npm distributions with adjacent wrappers.
      join(directory, 'node_modules/npm/bin/npm-cli.js'), // Windows npm.cmd layout.
      resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'), // Unix prefix.
    ]) {
      const cli = await npmCliAt(candidate);
      if (cli) return cli;
    }
  }
  throw Object.assign(new Error('Cannot locate npm-cli.js. Install npm alongside Node or make its installation available on PATH.'), { code: 'ENOENT' });
}

async function installedPackage(prefix) {
  const directory = join(prefix, 'node_modules', 'threadroom-service');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (manifest.name !== 'threadroom-service') {
    throw new Error(`Invalid Threadroom service installation: ${directory}`);
  }
  return directory;
}

/**
 * Install a trusted, dependency-free npm service archive on explicit demand.
 * Returns the absolute threadroom-service package directory, without loading it.
 *
 * Importing this module does no filesystem or installation work. The caller owns
 * the decision to enable shared features and supplies both paths. Installation
 * requires a standard npm installation on PATH, beside Node, or identified by
 * npm_execpath. npm runs through the current Node executable (never a shell),
 * offline without lifecycle scripts, with a bounded child-process timeout
 * (timeoutMs defaults to 120 seconds). Temporary cache/configuration stays inside
 * installRoot. Completed installs are keyed
 * by archive bytes (not version) and published atomically for cross-process reuse.
 * A failed attempt removes only its own temporary files and can be retried; no
 * existing completed installation is modified or removed.
 */
export async function installServiceRuntime({ archivePath, installRoot, timeoutMs = 120_000 }) {
  if (typeof archivePath !== 'string' || !archivePath || typeof installRoot !== 'string' || !installRoot) {
    throw new TypeError('archivePath and installRoot must be nonempty paths');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('timeoutMs must be a positive integer no greater than 2147483647');
  }
  // Install the bytes we hashed, even if a development build replaces the source
  // archive while npm is running.
  const archive = await readFile(archivePath);
  const digest = createHash('sha256').update(archive).digest('hex');
  const root = resolve(installRoot);
  const destination = join(root, `sha256-${digest}`);
  const existing = await installedPackage(destination);
  if (existing) return existing;

  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, '.install-'));
  try {
    const prefix = join(temporary, 'prefix');
    const snapshot = join(temporary, 'service.tgz');
    const userconfig = join(temporary, 'user.npmrc');
    const globalconfig = join(temporary, 'global.npmrc');
    await mkdir(prefix);
    await Promise.all([
      writeFile(snapshot, archive),
      writeFile(userconfig, ''),
      writeFile(globalconfig, ''),
      writeFile(join(prefix, 'package.json'), JSON.stringify({ private: true })),
    ]);
    const npmCli = await resolveNpmCli();
    await execFileAsync(process.execPath, [
      npmCli, 'install', snapshot, '--prefix', prefix,
      '--offline', '--ignore-scripts', '--dry-run=false', '--no-audit', '--no-fund', '--update-notifier=false',
      '--no-package-lock', '--no-save', '--global=false', '--workspaces=false',
      '--cache', join(temporary, 'npm-cache'), '--logs-dir', join(temporary, 'npm-logs'),
      '--userconfig', userconfig,
      '--globalconfig', globalconfig,
    ], { cwd: prefix, maxBuffer: 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true });
    if (!await installedPackage(prefix)) {
      throw new Error('Archive did not install a threadroom-service package');
    }
    try {
      await rename(prefix, destination);
    } catch (error) {
      // Another process can win publication. Check the completed result rather
      // than a platform-specific rename error (Windows can report access errors
      // for an existing directory). Without a completed winner, fail normally.
      if (!await installedPackage(destination)) throw error;
    }
    return join(destination, 'node_modules', 'threadroom-service');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
