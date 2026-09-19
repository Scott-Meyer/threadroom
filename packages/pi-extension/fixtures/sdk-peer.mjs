// Resolve a public SDK peer entry from the SDK's package location, without
// assuming nested node_modules or evaluating the package during resolution.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const script = fileURLToPath(import.meta.url);
export function resolveSdkPeer(sdk, name) {
  const result = spawnSync(process.execPath, ['--experimental-import-meta-resolve', script, sdk, name], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `SDK peer resolution failed: ${name}`);
  return result.stdout.trim();
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
  assert.ok(process.execArgv.includes('--experimental-import-meta-resolve'), 'SDK parent URL requires native import-meta resolution flag');
  const [sdk, name] = process.argv.slice(2);
  process.stdout.write(import.meta.resolve(name, pathToFileURL(resolve(sdk, 'package.json')).href));
}
