import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadroomDataDirectory, threadroomDatabasePath } from './paths.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const cliPath = join(packageDir, 'bin/threadroom-service.js');
const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
const help = `Threadroom service (Node 24+; local, unauthenticated loopback only)

  threadroom-service serve [--database /absolute/path] [--port 4310]
  threadroom-service api [--database /absolute/path] [--port 4310]
  threadroom-service ui [--api-url http://127.0.0.1:4310] [--port 4311]
  threadroom-service launchd-config --output-dir /absolute/path
      [--database /absolute/path] [--api-port 4310] [--ui-port 4311]
      [--api-url http://127.0.0.1:4310]
  threadroom-service --help | --version

serve runs the API and website together; api and ui keep them independent.
All run in the foreground until stopped. Port 0 chooses a free port.
API storage: --database, then THREADROOM_DB, then the per-user data directory.
UI never opens a database. No command installs or activates a background job.
launchd-config only writes two plists; review and activation are manual.
`;

function optionsFor(args, accepted) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith('--') || !accepted.includes(flag.slice(2))) throw new Error(`Unknown option: ${flag}. See --help.`);
    const key = flag.slice(2);
    if (options[key] !== undefined) throw new Error(`Duplicate option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    options[key] = value;
  }
  return options;
}

function port(value, fallback, ephemeral = true) {
  const text = String(value ?? fallback);
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < (ephemeral ? 0 : 1) || number > 65535) {
    throw new Error(`Invalid port: ${text}; expected ${ephemeral ? '0' : '1'}–65535.`);
  }
  return number;
}

function absolute(value, flag) {
  if (!isAbsolute(value)) throw new Error(`${flag} needs an absolute path.`);
  return resolve(value);
}

function databasePath(options) {
  if (options.database) return absolute(options.database, '--database');
  return threadroomDatabasePath();
}

function apiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid API URL: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API URL must be an HTTP(S) base URL without credentials, query, or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

function resourceEntry(name) {
  // Recognized source CLI uses current source, even after a previous pack.
  // An extracted distribution must always use its own bundled resources.
  const checkout = resolve(packageDir, '../..');
  const manifest = join(checkout, 'package.json');
  if (resolve(packageDir) === join(checkout, 'packages', 'service') && existsSync(manifest)) {
    const root = JSON.parse(readFileSync(manifest, 'utf8'));
    if (root.name === 'threadroom' && root.workspaces?.includes('packages/*')) {
      const source = join(checkout, 'src', name);
      if (existsSync(source)) return pathToFileURL(source).href;
    }
  }
  const bundled = join(packageDir, 'dist', 'src', name);
  if (existsSync(bundled)) return pathToFileURL(bundled).href;
  throw new Error('Runtime resources are missing. Pack from the source checkout with npm pack --workspace threadroom-service.');
}

function xml(value) {
  const text = String(value);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error('Paths and URLs cannot contain XML control characters.');
  return text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function plist(label, args, environment, directory, logName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${[process.execPath, cliPath, ...args].map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
  <key>WorkingDirectory</key><string>${xml(directory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(directory, `${logName}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(directory, `${logName}.error.log`))}</string>
</dict></plist>
`;
}

function generateConfig(options) {
  if (!options['output-dir']) throw new Error('launchd-config needs --output-dir /absolute/path.');
  const output = absolute(options['output-dir'], '--output-dir');
  const database = databasePath(options);
  const apiPort = port(options['api-port'], 4310, false);
  const uiPort = port(options['ui-port'], 4311, false);
  if (apiPort === uiPort) throw new Error('API and UI need different ports.');
  const url = apiUrl(options['api-url'] || `http://127.0.0.1:${apiPort}`);
  const directory = threadroomDataDirectory();
  // Capture user identity paths, not shell/Pi lifetime or arbitrary ambient settings.
  const environment = { HOME: homedir() };
  if (process.platform !== 'darwin') {
    if (process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)) environment.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
    if (process.env.LOCALAPPDATA) environment.LOCALAPPDATA = process.env.LOCALAPPDATA;
  }
  const jobs = [
    ['local.threadroom.api', plist('local.threadroom.api', ['api', '--database', database, '--port', String(apiPort)], {
      ...environment, THREADROOM_SEED_DEMO: '0',
      THREADROOM_UI_ORIGINS: `http://127.0.0.1:${uiPort},http://localhost:${uiPort}`
    }, directory, 'api')],
    ['local.threadroom.ui', plist('local.threadroom.ui', ['ui', '--api-url', url, '--port', String(uiPort)], environment, directory, 'ui')]
  ];
  // Validate every destination before any write. Atomic replacement avoids
  // following symlinks or hard links that happen to occupy the final name.
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const destinations = jobs.map(([label, contents]) => ({ contents, path: join(output, `${label}.plist`) }));
  for (const { path } of destinations) {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error(`Refusing non-regular launchd configuration destination: ${path}`);
  }
  for (const { contents, path } of destinations) {
    const temporary = join(output, `.${randomUUID()}.plist.tmp`);
    try {
      writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    console.log(path);
  }
  console.log(`Configuration only; no jobs installed or started. Before approved activation, prepare private directories:\n  ${directory}\n  ${dirname(database)}\nNode: ${process.execPath}\nCLI: ${cliPath}`);
}

export async function run(args) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required.');
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help' || (rest.length === 1 && rest[0] === '--help')) {
    console.log(help); return;
  }
  if (command === '--version') { console.log(version); return; }
  if (command === 'launchd-config') {
    generateConfig(optionsFor(rest, ['output-dir', 'database', 'api-port', 'ui-port', 'api-url']));
    return;
  }
  if (command === 'serve' || command === 'api') {
    const options = optionsFor(rest, ['database', 'port']);
    const database = databasePath(options);
    const listenPort = port(options.port ?? process.env.PORT, 4310);
    const entry = resourceEntry('main.js');
    process.umask(0o077);
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
    Object.assign(process.env, {
      THREADROOM_DB: database, PORT: String(listenPort), HOST: '127.0.0.1',
      THREADROOM_SERVE_UI: command === 'api' ? '0' : '1', THREADROOM_SEED_DEMO: '0'
    });
    await import(entry);
    return;
  }
  if (command === 'ui') {
    const options = optionsFor(rest, ['api-url', 'port']);
    const url = apiUrl(options['api-url'] || process.env.THREADROOM_API_URL || 'http://127.0.0.1:4310');
    const listenPort = port(options.port ?? process.env.UI_PORT, 4311);
    Object.assign(process.env, { THREADROOM_API_URL: url, UI_PORT: String(listenPort) });
    await import(resourceEntry('ui-main.js'));
    return;
  }
  throw new Error(`Unknown command: ${command}. See --help.`);
}
