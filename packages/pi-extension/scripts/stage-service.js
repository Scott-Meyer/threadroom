import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('../', import.meta.url));
const service = fileURLToPath(new URL('../../service/', import.meta.url));
const target = join(here, 'node_modules', 'threadroom-service');
const action = process.argv[2];

if (action === 'clean') {
  await rm(target, { recursive: true, force: true });
} else if (action === 'stage') {
  await import(new URL('../../service/scripts/build.js', import.meta.url).href);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const entry of ['bin', 'lib', 'dist', 'README.md', 'package.json']) {
    await cp(join(service, entry), join(target, entry), { recursive: true });
  }
} else {
  throw new Error('Use stage or clean.');
}
