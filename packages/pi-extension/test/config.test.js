import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveThreadroomConfig, threadroomConfigPaths, writeThreadroomConfig } from '../src/config.js';

test('shared Threadroom is off by default with trusted project overrides above the computer default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadroom-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent'); await mkdir(cwd, { recursive: true });
  const input = { cwd, agentDir, configDirName: '.pi', projectTrusted: true };
  const paths = threadroomConfigPaths(input);
  assert.deepEqual(resolveThreadroomConfig(input), { enabled: false, source: 'default', ...paths, warnings: [] });

  writeThreadroomConfig({ path: paths.globalPath, shared: true });
  assert.equal(resolveThreadroomConfig(input).enabled, true);
  writeThreadroomConfig({ path: paths.projectPath, shared: false });
  assert.deepEqual(resolveThreadroomConfig(input), { enabled: false, source: 'project', ...paths, warnings: [] });
  assert.equal(resolveThreadroomConfig({ ...input, projectTrusted: false }).enabled, true, 'untrusted project configuration is not read');

  writeThreadroomConfig({ path: paths.globalPath, shared: false });
  writeThreadroomConfig({ path: paths.projectPath, shared: true });
  assert.deepEqual(resolveThreadroomConfig(input), { enabled: true, source: 'project', ...paths, warnings: [] });
  writeThreadroomConfig({ path: paths.projectPath, shared: undefined });
  assert.deepEqual(resolveThreadroomConfig(input), { enabled: false, source: 'global', ...paths, warnings: [] });
});

test('malformed configuration fails the shared lane closed without affecting file ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'threadroom-config-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = { cwd: join(root, 'project'), agentDir: join(root, 'agent'), configDirName: '.pi', projectTrusted: true };
  const { globalPath, projectPath } = threadroomConfigPaths(input); await mkdir(join(root, 'project', '.pi'), { recursive: true });
  writeThreadroomConfig({ path: globalPath, shared: true }); await writeFile(projectPath, '{"shared":"yes"}\n');
  const config = resolveThreadroomConfig(input);
  assert.equal(config.enabled, false); assert.equal(config.source, 'invalid'); assert.match(config.warnings[0], /must be true or false/);

  await writeFile(globalPath, '{"shared":"yes"}\n'); writeThreadroomConfig({ path: projectPath, shared: true });
  const overridden = resolveThreadroomConfig(input);
  assert.equal(overridden.enabled, true, 'a valid trusted-project value overrides the malformed lower layer');
  assert.equal(overridden.source, 'project'); assert.match(overridden.warnings[0], /must be true or false/);
});
