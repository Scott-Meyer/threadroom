import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('a source/dev-link layout prefers its physical sibling over transient package staging', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'threadroom-source-runtime-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const extension = join(temporary, 'packages', 'pi-extension'), service = join(temporary, 'packages', 'service');
  await mkdir(join(extension, 'src'), { recursive: true }); await mkdir(service, { recursive: true });
  await cp(resolve(root, 'package.json'), join(temporary, 'package.json'));
  await cp(resolve(root, 'packages/pi-extension/src/service-runtime.js'), join(extension, 'src/service-runtime.js'));
  await cp(resolve(root, 'packages/service/lib'), join(service, 'lib'), { recursive: true });
  await cp(resolve(root, 'packages/service/bin'), join(service, 'bin'), { recursive: true });
  await cp(resolve(root, 'packages/service/package.json'), join(service, 'package.json'));
  const staged = join(extension, 'node_modules', 'threadroom-service'); await mkdir(staged, { recursive: true });
  await writeFile(join(staged, 'package.json'), JSON.stringify({ name: 'threadroom-service', type: 'module',
    exports: { './ensure': './fail.js', './paths': './fail.js' } }));
  await writeFile(join(staged, 'fail.js'), `throw new Error('transient staged package must not own live source runtime');\n`);
  const { createManagedThreadroomService } = await import(`${pathToFileURL(join(extension, 'src/service-runtime.js')).href}?isolated=${Date.now()}`);
  await assert.rejects(createManagedThreadroomService({ baseUrl: 'http://example.test:4310' }).ensure(), { code: 'unmanaged_endpoint' });
});
