import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installServiceRuntime } from './service-install.js';

const physicalDirectory = dirname(realpathSync(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(physicalDirectory, '../../..');
const sourcePackage = resolve(physicalDirectory, '../../service');
const runtimeArchive = resolve(physicalDirectory, '../runtime/threadroom-service.tgz');

function recognizedSourceWorkspace() {
  try {
    const workspace = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8'));
    const service = JSON.parse(readFileSync(resolve(sourcePackage, 'package.json'), 'utf8'));
    return workspace.name === 'threadroom' && workspace.workspaces?.includes('packages/*') && service.name === 'threadroom-service';
  } catch { return false; }
}

/** Explicit shared-feature boundary. Construction is inert. prepare() makes the
 * runtime available without starting it; ensure() also starts/reuses the service.
 * Call only after shared Threadroom is enabled. A physical development symlink
 * uses live workspace source; portable packages install their archive offline. */
export function createManagedThreadroomService({ baseUrl, databaseValue, invocationCwd = process.cwd(),
  runtimeDirectory = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'threadroom', 'runtime'),
}) {
  let runtime;
  async function load() {
    if (!runtime) {
      const attempt = (async () => {
        // The source workspace remains authoritative during development, even
        // while npm pack stages a portable snapshot beside the extension.
        let root = sourcePackage;
        if (!recognizedSourceWorkspace()) {
          try {
            root = await installServiceRuntime({ archivePath: runtimeArchive, installRoot: runtimeDirectory });
          } catch (error) {
            if (error.code === 'ENOENT' && error.path === runtimeArchive) {
              throw Object.assign(new Error('The shared app archive is missing from this copy. Prepare the extension with npm pack from its development workspace before transferring it.'), { code: 'service_runtime_missing' });
            }
            throw error;
          }
        }
        const [ensureModule, pathsModule] = await Promise.all([
          import(pathToFileURL(resolve(root, 'lib/ensure.js')).href),
          import(pathToFileURL(resolve(root, 'lib/paths.js')).href),
        ]);
        const database = pathsModule.threadroomDatabasePath({ value: databaseValue, cwd: invocationCwd });
        return ensureModule.createThreadroomServiceEnsurer({ baseUrl, database });
      })();
      runtime = attempt;
      attempt.catch(() => { if (runtime === attempt) runtime = undefined; });
    }
    return runtime;
  }
  return { async prepare() { await load(); }, async ensure() { return (await load()).ensure(); } };
}
