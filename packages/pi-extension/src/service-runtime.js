import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const physicalDirectory = dirname(realpathSync(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(physicalDirectory, '../../..');
const sourcePackage = resolve(physicalDirectory, '../../service');
const sourceService = (name) => pathToFileURL(resolve(sourcePackage, 'lib', name)).href;

function recognizedSourceWorkspace() {
  try {
    const workspace = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8'));
    const service = JSON.parse(readFileSync(resolve(sourcePackage, 'package.json'), 'utf8'));
    return workspace.name === 'threadroom' && workspace.workspaces?.includes('packages/*') && service.name === 'threadroom-service';
  } catch { return false; }
}

/** Lazy adapter-to-service boundary. A recognized source checkout—including a
 * literal configured symlink—uses current physical sibling source. Packed
 * installs resolve the bundled package. Neither path is selected from cwd. */
export function createManagedThreadroomService({ baseUrl, databaseValue, invocationCwd = process.cwd() }) {
  let runtime;
  async function load() {
    if (!runtime) runtime = (async () => {
      let ensureModule, pathsModule;
      if (recognizedSourceWorkspace()) {
        // Source is authoritative even while npm pack temporarily stages a
        // package-local bundle; verified sibling initialization errors surface.
        [ensureModule, pathsModule] = await Promise.all([
          import(sourceService('ensure.js')), import(sourceService('paths.js')),
        ]);
      } else {
        [ensureModule, pathsModule] = await Promise.all([
          import('threadroom-service/ensure'), import('threadroom-service/paths'),
        ]);
      }
      const database = pathsModule.threadroomDatabasePath({ value: databaseValue, cwd: invocationCwd });
      return ensureModule.createThreadroomServiceEnsurer({ baseUrl, database });
    })();
    return runtime;
  }
  return { async ensure() { return (await load()).ensure(); } };
}
