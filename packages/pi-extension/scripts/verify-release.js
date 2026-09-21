import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const serviceManifest = JSON.parse(await readFile(join(repositoryRoot, 'packages/service/package.json'), 'utf8'));
const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
const problems = [];

const expect = (condition, message) => { if (!condition) problems.push(message); };
expect(manifest.name === 'threadroom-pi', 'Package name must remain threadroom-pi.');
expect(/^0\.1\.0-beta\.\d+$/.test(manifest.version), 'Version must be a 0.1.0 beta prerelease.');
expect(manifest.private === false, 'Package must explicitly set private=false.');
expect(manifest.license === 'MIT', 'Package metadata must declare the selected MIT license.');
expect(manifest.publishConfig?.access === 'public', 'publishConfig.access must be public.');
if (process.env.npm_lifecycle_event === 'prepublishOnly') {
  expect(process.env.npm_config_tag === 'beta', 'Publishing requires an explicit --tag beta; refusing npm\'s latest default.');
}
expect(manifest.repository?.url === 'git+https://github.com/Scott-Meyer/threadroom.git', 'Repository provenance is missing or unexpected.');
expect(manifest.homepage && manifest.bugs?.url, 'Homepage and issue metadata are required.');
expect(manifest.keywords?.includes('pi-package'), 'Pi package discovery keyword is missing.');
expect(manifest.pi?.extensions?.length === 1 && manifest.pi.extensions[0] === './extensions/index.ts', 'Published Pi entry point is unexpected.');
expect(manifest.bundleDependencies?.length === 1 && manifest.bundleDependencies[0] === 'threadroom-service', 'The local service must remain the sole bundled dependency.');
expect(manifest.dependencies?.['threadroom-service'] === serviceManifest.version, 'Bundled service dependency must match the staged service version.');
expect(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'].every(name => manifest.peerDependencies?.[name] === '*'), 'Pi-provided imports must remain wildcard peer dependencies.');
expect(manifest.files?.includes('LICENSE'), 'The published file list must include LICENSE.');
expect(readme.includes('pi install npm:threadroom-pi@beta'), 'README must contain the beta Pi installation command.');
expect(readme.includes('shared Threadroom lane is experimental, off by default'), 'README must keep the unfinished shared lane boundary visible.');
expect(license.startsWith('MIT License\n') && license.includes('Copyright (c) 2026 Scott Meyer'), 'LICENSE does not contain the selected MIT grant and copyright.');

const releaseInputs = ['packages/pi-extension', 'packages/service', 'src', 'public'];
try {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...releaseInputs], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  expect(!dirty, `Release inputs are not committed:\n${dirty}`);
  execFileSync('git', ['diff', '--check', '--', ...releaseInputs], { cwd: repositoryRoot, stdio: 'pipe' });
} catch (error) {
  if (!problems.some(problem => problem.startsWith('Release inputs are not committed:'))) {
    problems.push(`Git release-input verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (problems.length) {
  console.error(`threadroom-pi release check failed:\n\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

console.log(`threadroom-pi ${manifest.version} metadata and release inputs are ready for a beta publish.`);
if (process.argv.includes('--full')) {
  const sdk = process.env.THREADROOM_PI_SDK_ROOT;
  if (!sdk) throw new Error('Set THREADROOM_PI_SDK_ROOT before running the full release check.');
  const testDirectory = join(repositoryRoot, 'packages/pi-extension/test');
  const tests = (await readdir(testDirectory)).filter(name => name.endsWith('.test.js')).sort().map(name => join(testDirectory, name));
  const checked = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 300_000,
    stdio: 'inherit',
    env: { ...process.env, THREADROOM_PI_TUI_SMOKE: '1' },
  });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw new Error(`Pi extension tests failed with status ${checked.status}.`);

  for (const [command, args] of [
    [process.execPath, [join(packageRoot, 'scripts/verify-packed.js')]],
    ['npm', ['publish', '--workspace', 'threadroom-pi', '--dry-run', '--tag', 'beta', '--access', 'public']],
  ]) {
    const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', timeout: 300_000, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
  }
  console.log(`threadroom-pi ${manifest.version} passed the full beta release check; nothing was published.`);
}
