import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('../', import.meta.url));
const service = fileURLToPath(new URL('../../service/', import.meta.url));
const target = join(here, 'runtime', 'threadroom-service.tgz');
const marker = join(here, '.threadroom-service-pack-staged');
const action = process.argv[2];
const exists = async (path) => access(path).then(() => true, () => false);

if (action === 'clean') {
  if (await exists(marker)) {
    await rm(target, { force: true });
    await rm(marker, { force: true });
  }
} else if (action === 'stage') {
  await rm(marker, { force: true });
  if (await exists(join(service, 'scripts', 'build.js'))) {
    // Transport the service as an inert resource, not an installed dependency.
    // The service's own prepack owns its build and portable runtime contents.
    const temporary = await mkdtemp(join(tmpdir(), 'threadroom-service-pack-'));
    try {
      const npmCli = process.env.npm_execpath;
      if (!npmCli) throw new Error('Prepare the service snapshot through npm pack, which supplies its npm CLI path.');
      // An outer --dry-run still needs a real temporary input archive.
      const output = execFileSync(process.execPath, [npmCli, 'pack', '--json', '--dry-run=false', '--pack-destination', temporary], {
        cwd: service, encoding: 'utf8', timeout: 120_000,
      });
      const starts = [output.indexOf('\n{'), output.indexOf('\n[')].filter(index => index >= 0);
      const report = JSON.parse(output.slice(starts.length ? Math.min(...starts) + 1 : 0));
      const packed = Array.isArray(report) ? report[0] : report['threadroom-service'];
      if (!packed?.filename) throw new Error('npm pack did not report a Threadroom service archive.');
      await mkdir(join(here, 'runtime'), { recursive: true });
      await copyFile(join(temporary, packed.filename), target);
      await writeFile(marker, 'staged from the Threadroom source workspace\n');
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } else if (!await exists(target)) {
    throw new Error('Threadroom service source and portable runtime archive are both missing. Pack from the development workspace.');
  }
} else {
  throw new Error('Use stage or clean.');
}
