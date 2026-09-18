import { cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.name !== 'threadroom') throw new Error('Build from the Threadroom source checkout.');

// Preserve relative src -> public URLs; these are generated resources, not a fork.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const directory of ['src', 'public']) {
  await cp(join(root, directory), join(dist, directory), {
    recursive: true,
    filter: async (source) => {
      const name = basename(source);
      if (/(^|[.\-])(test|spec)([.\-]|$)/i.test(name)
        || /\.(sqlite(?:3)?|db)(?:-(?:wal|shm))?$/i.test(name)
        || ['.DS_Store', 'node_modules', 'test', 'tests', 'examples', 'data', 'pi', 'dev'].includes(name)) return false;
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Runtime resources cannot depend on symlinks: ${source}`);
      return directory !== 'src' || info.isDirectory() || name.endsWith('.js');
    }
  });
}
console.log('Generated standalone resources: dist/src and dist/public');
