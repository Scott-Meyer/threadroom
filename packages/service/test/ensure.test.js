import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThreadroomServiceEnsurer } from '../lib/ensure.js';
import { threadroomDatabasePath } from '../lib/paths.js';

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function health(baseUrl) {
  return new Promise((resolve, reject) => {
    const request = import('node:http').then(({ get }) => get(`${baseUrl}/api/health`, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks)))); response.on('error', reject);
    }).on('error', reject));
    void request;
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(); await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
}

test('concurrent starters publish one compatible detached API and website with the selected durable store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-ensure-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'records.sqlite'), listen = await port(), baseUrl = `http://127.0.0.1:${listen}`;
  let launches = 0, child, commandArgs, options;
  const launch = (...args) => { launches++; commandArgs = args[1]; options = args[2]; child = spawn(...args); return child; };
  t.after(() => stop(child));
  const first = createThreadroomServiceEnsurer({ baseUrl, database, spawnProcess: launch });
  const second = createThreadroomServiceEnsurer({ baseUrl, database, spawnProcess: launch });
  const [a, b] = await Promise.all([first.ensure(), second.ensure()]);
  assert.equal(launches, 1); assert.equal(a.storageId, first.storageId); assert.equal(b.storageId, first.storageId);
  assert.equal(a.website, true); assert.equal(a.apiVersion, 2); assert.equal(options.detached, true); assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, directory); assert.deepEqual(commandArgs.slice(1, 4), ['serve', '--database', database]);
  assert.ok(existsSync(database));
  assert.deepEqual(await health(baseUrl), a);
  assert.equal((await first.ensure()).storageId, first.storageId, 'healthy reuse does not launch again');
  assert.equal(launches, 1);
});

test('a lease owner that exits still converges on a later fallback winner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-owner-race-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'records.sqlite'), listen = await port(), baseUrl = `http://127.0.0.1:${listen}`;
  const loser = new EventEmitter(); loser.stderr = new PassThrough(); loser.exitCode = null; loser.unref = () => {}; loser.kill = () => {};
  let ownerSpawned; const spawned = new Promise((resolve) => { ownerSpawned = resolve; });
  const owner = createThreadroomServiceEnsurer({ baseUrl, database, timeoutMs: 1000, spawnProcess() {
    ownerSpawned(); setImmediate(() => { loser.exitCode = 1; loser.emit('exit', 1, null); }); return loser;
  } });
  const owning = owner.ensure(); await spawned;
  let winner;
  const fallback = createThreadroomServiceEnsurer({ baseUrl, database, timeoutMs: 1000, spawnProcess(...args) { winner = spawn(...args); return winner; } });
  t.after(() => stop(winner));
  const [a, b] = await Promise.all([owning, fallback.ensure()]);
  assert.equal(a.storageId, b.storageId); assert.equal(a.website, true);
});

test('an orphaned startup lease is never deleted; port ownership safely resolves fallback contenders', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-stale-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'records.sqlite'), listen = await port(), baseUrl = `http://127.0.0.1:${listen}`;
  const lock = join(directory, `.startup-${createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)}`);
  await mkdir(lock); await writeFile(join(lock, 'owner'), 'dead-owner');
  const old = new Date(Date.now() - 5000); await utimes(lock, old, old);
  let launches = 0, winner;
  const launch = (...args) => {
    launches++;
    if (launches === 1) {
      const loser = new EventEmitter(); loser.stderr = new PassThrough(); loser.exitCode = null; loser.unref = () => {};
      loser.kill = () => {}; setImmediate(() => { loser.exitCode = 1; loser.emit('exit', 1, null); }); return loser;
    }
    winner = spawn(...args); return winner;
  };
  t.after(() => stop(winner));
  const a = createThreadroomServiceEnsurer({ baseUrl, database, timeoutMs: 1000, spawnProcess: launch });
  const b = createThreadroomServiceEnsurer({ baseUrl, database, timeoutMs: 1000, spawnProcess: launch });
  const results = await Promise.all([a.ensure(), b.ensure()]);
  assert.equal(launches, 2, 'orphan recovery favors safe redundant launch over deleting a foreign lease');
  assert.equal(results[0].storageId, results[1].storageId);
  assert.equal(results[0].website, true, 'the early loser still observes the later compatible winner');
});

test('an occupied endpoint with the wrong runtime or store is rejected without launching over it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-occupied-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, service: 'something-else' })); });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let launches = 0;
  const managed = createThreadroomServiceEnsurer({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    database: join(directory, 'records.sqlite'), spawnProcess() { launches++; throw new Error('must not launch'); } });
  await assert.rejects(managed.ensure(), { code: 'incompatible_service' });
  assert.equal(launches, 0);
});

test('an older detached Threadroom API is rejected with a restart instruction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadroom-old-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'records.sqlite');
  const storageId = createHash('sha256').update(database).digest('hex').slice(0, 24);
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, service: 'threadroom', apiVersion: 1, website: true, storageId }));
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let launches = 0;
  const managed = createThreadroomServiceEnsurer({ baseUrl: `http://127.0.0.1:${server.address().port}`, database,
    spawnProcess() { launches++; throw new Error('must not launch'); } });
  await assert.rejects(managed.ensure(), (error) => error.code === 'incompatible_service' && /restart.*API version 2/i.test(error.message));
  assert.equal(launches, 0);
});

test('database paths resolve before a detached child changes directory and share one normalized identity', () => {
  assert.equal(threadroomDatabasePath({ value: 'relative/records.sqlite', cwd: '/tmp/invocation' }), '/tmp/invocation/relative/records.sqlite');
  assert.equal(createThreadroomServiceEnsurer({ baseUrl: 'http://127.0.0.1:4310', database: '/tmp/data/./records.sqlite' }).database,
    '/tmp/data/records.sqlite');
});
