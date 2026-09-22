import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('a source/dev-link layout uses live sibling source without installing its portable archive', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'threadroom-source-runtime-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const extension = join(temporary, 'packages', 'pi-extension'), service = join(temporary, 'packages', 'service');
  await mkdir(join(extension, 'src'), { recursive: true }); await mkdir(service, { recursive: true });
  await cp(resolve(root, 'package.json'), join(temporary, 'package.json'));
  for (const file of ['service-runtime.js', 'service-install.js']) {
    await cp(resolve(root, 'packages/pi-extension/src', file), join(extension, 'src', file));
  }
  await cp(resolve(root, 'packages/service/lib'), join(service, 'lib'), { recursive: true });
  await cp(resolve(root, 'packages/service/bin'), join(service, 'bin'), { recursive: true });
  await cp(resolve(root, 'packages/service/package.json'), join(service, 'package.json'));
  await mkdir(join(extension, 'runtime'));
  await writeFile(join(extension, 'runtime/threadroom-service.tgz'), 'an invalid stale archive must not own live source runtime');
  const runtimeDirectory = join(temporary, 'installed');
  const configuredLink = join(temporary, 'configured-extension');
  await symlink(extension, configuredLink, process.platform === 'win32' ? 'junction' : 'dir');
  const { createManagedThreadroomService } = await import(`${pathToFileURL(join(configuredLink, 'src/service-runtime.js')).href}?isolated=${Date.now()}`);
  await assert.rejects(createManagedThreadroomService({ baseUrl: 'http://example.test:4310', runtimeDirectory }).prepare(), { code: 'unmanaged_endpoint' });
  await assert.rejects(stat(runtimeDirectory), { code: 'ENOENT' });
});
