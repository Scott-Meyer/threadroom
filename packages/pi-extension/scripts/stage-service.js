import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('../', import.meta.url));
const service = fileURLToPath(new URL('../../service/', import.meta.url));
const target = join(here, 'node_modules', 'threadroom-service');
const marker = join(here, '.threadroom-service-pack-staged');
const action = process.argv[2];
const exists = async (path) => access(path).then(() => true, () => false);

if (action === 'clean') {
  if (await exists(marker)) {
    await rm(target, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
} else if (action === 'stage') {
  await rm(marker, { force: true });
  if (await exists(join(service, 'scripts', 'build.js'))) {
    await import(new URL('../../service/scripts/build.js', import.meta.url).href);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const entry of ['bin', 'lib', 'dist', 'README.md', 'package.json']) {
      await cp(join(service, entry), join(target, entry), { recursive: true });
    }
    await writeFile(marker, 'staged from the Threadroom source workspace\n');
  } else if (!await exists(join(target, 'package.json'))) {
    throw new Error('Threadroom service source and bundled package are both missing.');
  }
} else {
  throw new Error('Use stage or clean.');
}
