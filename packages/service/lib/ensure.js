import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { threadroomDatabasePath } from './paths.js';

const cli = fileURLToPath(new URL('../bin/threadroom-service.js', import.meta.url));
const stderrLimit = 4000;
const storageIdentity = (database) => createHash('sha256').update(database).digest('hex').slice(0, 24);

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw Object.assign(new Error('Automatic Threadroom startup only owns an uncredentialed loopback HTTP origin.'), { code: 'unmanaged_endpoint' });
  }
  return url;
}

function probe(baseUrl, expectedStorageId, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const url = new URL('/api/health', baseUrl);
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const call = request(url, { method: 'GET', family: 4, agent: false, headers: { Accept: 'application/json' } }, (response) => {
      const chunks = []; let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { response.destroy(); finish({ status: 'incompatible', reason: 'health response exceeded 64 KiB' }); }
        else chunks.push(chunk);
      });
      response.on('error', () => finish({ status: 'unavailable' }));
      response.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return finish({ status: 'incompatible', reason: 'health response was not JSON' }); }
        if (response.statusCode === 200 && body?.ok === true && body.service === 'threadroom' && body.apiVersion === 2 &&
            body.website === true && body.storageId === expectedStorageId) return finish({ status: 'healthy', health: body });
        const reason = body?.service === 'threadroom' && body?.apiVersion !== 2
          ? `API version ${body?.apiVersion ?? 'missing'} is incompatible; restart the detached Threadroom service for API version 2`
          : 'service identity, API version, website, or storage does not match';
        finish({ status: 'incompatible', reason, health: body });
      });
    });
    call.on('error', () => finish({ status: 'unavailable' }));
    call.end();
    const timer = setTimeout(() => { call.destroy(); finish({ status: 'unavailable' }); }, timeoutMs);
    timer.unref?.();
  });
}

function startupError(message, stderr, cause) {
  const diagnostic = stderr.trim();
  const text = diagnostic ? `${message}\nThreadroom service stderr:\n${diagnostic}` : message;
  return Object.assign(cause === undefined ? new Error(text) : new Error(text, { cause }), { code: 'service_start_failed' });
}

/** Idempotently ensure one compatible detached local API + website process.
 * The returned boundary performs no write retry; callers invoke it before each
 * request so an ambiguous mutation remains ambiguous. */
export function createThreadroomServiceEnsurer({
  baseUrl = 'http://127.0.0.1:4310', database = threadroomDatabasePath(), timeoutMs = 5000,
  env = process.env, spawnProcess = spawn,
} = {}) {
  const url = endpoint(baseUrl);
  if (url.port === '0') throw Object.assign(new Error('Automatic Threadroom startup needs a stable nonzero port.'), { code: 'unmanaged_endpoint' });
  if (!isAbsolute(database)) throw new Error('Automatic Threadroom startup needs an absolute database path.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) throw new Error('Threadroom startup timeout must be at least 100 ms.');
  const databasePath = resolve(database), storageId = storageIdentity(databasePath);
  const dataDir = dirname(databasePath);
  const lock = join(dataDir, `.startup-${createHash('sha256').update(url.origin).digest('hex').slice(0, 12)}`);
  let inflight;
  async function ensureOnce() {
    const initial = await probe(url, storageId);
    if (initial.status === 'healthy') return initial.health;
    if (initial.status === 'incompatible') throw Object.assign(new Error(`Threadroom endpoint ${url.origin} is already occupied by an incompatible runtime (${initial.reason}).`), { code: 'incompatible_service' });

    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let owned = false, ownerToken;
    const claim = () => {
      mkdirSync(lock, { mode: 0o700 });
      ownerToken = randomUUID(); writeFileSync(join(lock, 'owner'), ownerToken, { mode: 0o600 }); owned = true;
    };
    try {
      try { claim(); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        // Never delete a lease we do not own. If its starter disappeared, the
        // bounded wait below falls back to the HTTP port's atomic bind; extra
        // contenders may launch, but only one compatible service can listen.
      }
      if (!owned) {
        const deadline = Date.now() + Math.max(100, Math.floor(timeoutMs / 2));
        while (Date.now() < deadline) {
          const observed = await probe(url, storageId);
          if (observed.status === 'healthy') return observed.health;
          if (observed.status === 'incompatible') throw Object.assign(new Error(`Threadroom endpoint ${url.origin} became occupied by an incompatible runtime (${observed.reason}).`), { code: 'incompatible_service' });
          await delay(100);
        }
        // The lease may be orphaned. Continue without mutating it; the port is
        // the final cross-process ownership claim and losers exit on EADDRINUSE.
      }

      const afterLock = await probe(url, storageId);
      if (afterLock.status === 'healthy') return afterLock.health;
      if (afterLock.status === 'incompatible') throw Object.assign(new Error(`Threadroom endpoint ${url.origin} is occupied by an incompatible runtime (${afterLock.reason}).`), { code: 'incompatible_service' });

      const port = url.port || '80';
      const child = spawnProcess(process.execPath, [cli, 'serve', '--database', databasePath, '--port', port], {
        cwd: dataDir, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...env, THREADROOM_DB: databasePath, THREADROOM_SEED_DEMO: '0' },
      });
      let stderr = '', launchFailure, exit, ready = false;
      const remember = (chunk) => { stderr = `${stderr}${chunk}`.slice(-stderrLimit); };
      child.stderr?.on('data', remember);
      child.stderr?.unref?.(); child.unref();
      child.once('error', (error) => { launchFailure = error; });
      child.once('exit', (code, signal) => { exit = { code, signal }; });
      try {
        let deadline = Date.now() + timeoutMs, raceGrace = false;
        while (Date.now() < deadline) {
          const observed = await probe(url, storageId);
          if (observed.status === 'healthy') { ready = true; return observed.health; }
          if (observed.status === 'incompatible') throw Object.assign(new Error(`Threadroom endpoint ${url.origin} became occupied by an incompatible runtime (${observed.reason}).`), { code: 'incompatible_service' });
          // A fallback contender can lose the port or an early SQLite race while
          // another compatible starter is still becoming ready. Preserve its
          // diagnostic, but let health—not child lifetime—decide. A failed lease
          // owner grants one bounded window for its waiters to take the port.
          if (owned && !raceGrace && (launchFailure || exit)) { deadline += timeoutMs; raceGrace = true; }
          await delay(100);
        }
        try { child.kill(); } catch {}
        if (launchFailure) throw startupError(`Failed to launch Threadroom: ${launchFailure.message}`, stderr, launchFailure);
        if (exit) throw startupError(`Threadroom exited before readiness${exit.signal ? ` with signal ${exit.signal}` : ` with code ${exit.code ?? 'unknown'}`}.`, stderr);
        throw startupError('Threadroom did not become healthy before the startup deadline.', stderr);
      } finally {
        if (!ready && child.exitCode === null) { try { child.kill(); } catch {} }
        child.stderr?.off('data', remember); child.stderr?.resume(); child.stderr?.unref?.();
      }
    } finally {
      if (owned) {
        try { if (readFileSync(join(lock, 'owner'), 'utf8') === ownerToken) rmSync(lock, { recursive: true, force: true }); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
  }
  return {
    baseUrl: url.origin, database: databasePath, storageId,
    ensure() {
      if (!inflight) inflight = ensureOnce().finally(() => { inflight = undefined; });
      return inflight;
    },
  };
}
