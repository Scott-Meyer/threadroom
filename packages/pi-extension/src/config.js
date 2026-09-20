import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function readLayer(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    return { present: true, error: `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { present: true, error: `${path} must contain a JSON object.` };
  }
  const unknown = Object.keys(value).filter((key) => key !== 'shared');
  if (unknown.length) return { present: true, error: `${path} has unknown setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.` };
  if (value.shared !== undefined && typeof value.shared !== 'boolean') {
    return { present: true, error: `${path} setting "shared" must be true or false.` };
  }
  return { present: true, value: value.shared };
}

/** Locate the extension-owned global default and project override. */
export function threadroomConfigPaths({ cwd, agentDir, configDirName = '.pi' }) {
  return Object.freeze({ globalPath: join(agentDir, 'threadroom.json'), projectPath: join(cwd, configDirName, 'threadroom.json') });
}

/** Resolve the optional shared lane. Project configuration is never read before
 * Pi has established project trust. An invalid effective layer fails closed;
 * an explicit trusted-project value can supersede a lower-layer warning. */
export function resolveThreadroomConfig({ cwd, agentDir, configDirName = '.pi', projectTrusted = false }) {
  const { globalPath, projectPath } = threadroomConfigPaths({ cwd, agentDir, configDirName });
  let enabled = false, source = 'default';
  const warnings = [];
  const global = readLayer(globalPath);
  if (global.error) { warnings.push(global.error); enabled = false; source = 'invalid'; }
  else if (global.value !== undefined) { enabled = global.value; source = 'global'; }
  if (projectTrusted) {
    const project = readLayer(projectPath);
    if (project.error) { warnings.push(project.error); enabled = false; source = 'invalid'; }
    else if (project.value !== undefined) { enabled = project.value; source = 'project'; }
  }
  return Object.freeze({ enabled, source, globalPath, projectPath, warnings: Object.freeze(warnings) });
}

/** Persist the one owned setting. Undefined removes an override and inherits the
 * lower scope (or the built-in off default). */
export function writeThreadroomConfig({ path, shared }) {
  if (shared === undefined) { rmSync(path, { force: true }); return; }
  if (typeof shared !== 'boolean') throw new TypeError('Threadroom shared setting must be boolean or undefined.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ shared }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
