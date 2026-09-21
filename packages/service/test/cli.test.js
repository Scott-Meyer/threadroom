import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/threadroom-service.js', import.meta.url));

function invoke(args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, 'xdg'), LOCALAPPDATA: join(home, 'local'), THREADROOM_DB: '' }
  });
}

test('configuration is review-only, absolute, escaped, and independent of shell cwd', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'threadroom-config-'));
  try {
    const home = join(temporary, 'home');
    const output = join(temporary, 'review & files');
    const database = join(temporary, 'data & "quoted"', 'threadroom.sqlite');
    const result = invoke(['launchd-config', '--output-dir', output, '--database', database, '--api-port', '4410', '--ui-port', '4411'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(temporary), ['review & files']);
    assert.deepEqual(readdirSync(output), ['local.threadroom.api.plist', 'local.threadroom.ui.plist']);
    const api = readFileSync(join(output, 'local.threadroom.api.plist'), 'utf8');
    const ui = readFileSync(join(output, 'local.threadroom.ui.plist'), 'utf8');
    assert.ok(api.includes(database.replaceAll('&', '&amp;').replaceAll('"', '&quot;')));
    assert.ok(api.includes(`<string>${process.execPath}</string>`));
    assert.ok(api.includes(`<string>${cli}</string>`));
    assert.ok(api.includes('<key>KeepAlive</key><true/>'));
    assert.ok(api.includes('http://127.0.0.1:4411,http://localhost:4411'));
    assert.ok(ui.includes('http://127.0.0.1:4410'));
    assert.ok(ui.includes('<string>ui</string>'));
    assert.ok(!ui.includes('<string>api</string>'));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('launchd configuration refuses symlink destinations without touching their targets', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'threadroom-config-link-'));
  try {
    const home = join(temporary, 'home');
    const output = join(temporary, 'review');
    const target = join(temporary, 'outside.txt');
    mkdirSync(output);
    writeFileSync(target, 'must survive');
    symlinkSync(target, join(output, 'local.threadroom.api.plist'));

    const result = invoke(['launchd-config', '--output-dir', output], home);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Refusing non-regular launchd configuration destination/);
    assert.equal(readFileSync(target, 'utf8'), 'must survive');
    assert.deepEqual(readdirSync(output), ['local.threadroom.api.plist']);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('invalid commands and ports fail before creating user data; help/version are inert', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'threadroom-inert-'));
  try {
    const home = join(temporary, 'home');
    for (const args of [ ['api', '--port', '-1'], ['api', '--database', 'relative.sqlite'], ['ui', '--api-url', 'not-a-url'], ['launchd-config', '--output-dir', join(temporary, 'output'), '--api-port', '0'], ['api', '--unknown', 'x'] ]) {
      const result = invoke(args, home);
      assert.equal(result.status, 1, `${args}: ${result.stdout} ${result.stderr}`);
    }
    for (const args of [ ['--help'], ['--version'], ['api', '--help'] ]) {
      assert.equal(invoke(args, home).status, 0);
    }
    assert.deepEqual(readdirSync(temporary), []);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
