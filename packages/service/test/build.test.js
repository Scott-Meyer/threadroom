import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildSource = fileURLToPath(new URL('../scripts/build.js', import.meta.url));

function put(path, contents = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

test('standalone build excludes every SQLite sidecar including rollback journals', () => {
  const root = mkdtempSync(join(tmpdir(), 'threadroom-build-'));
  try {
    put(join(root, 'package.json'), JSON.stringify({ name: 'threadroom' }));
    put(join(root, 'src', 'main.js'), 'export const ready = true;\n');
    put(join(root, 'public', 'app.js'), 'console.log("ready");\n');
    for (const name of [
      'records.sqlite', 'records.sqlite-wal', 'records.sqlite-shm', 'records.sqlite-journal',
      'records.db', 'records.db-wal', 'records.db-shm', 'records.db-journal'
    ]) put(join(root, 'public', name), 'database state');
    const build = join(root, 'packages', 'service', 'scripts', 'build.js');
    put(build, readFileSync(buildSource, 'utf8'));

    const result = spawnSync(process.execPath, [build], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'packages', 'service', 'dist', 'public', 'app.js'), 'utf8'), 'console.log("ready");\n');
    for (const name of [
      'records.sqlite', 'records.sqlite-wal', 'records.sqlite-shm', 'records.sqlite-journal',
      'records.db', 'records.db-wal', 'records.db-shm', 'records.db-journal'
    ]) assert.throws(() => readFileSync(join(root, 'packages', 'service', 'dist', 'public', name)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
