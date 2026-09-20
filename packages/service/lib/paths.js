import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Stable per-user service data; never relative to a checkout or plugin install. */
export function threadroomDataDirectory(env = process.env, home = homedir(), platform = process.platform) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Threadroom');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(home, 'AppData', 'Local'), 'Threadroom');
  }
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share'), 'threadroom');
}

/** Resolve an explicit environment value before a launcher changes cwd. */
export function threadroomDatabasePath({ value = process.env.THREADROOM_DB, cwd = process.cwd(), env = process.env,
  home = homedir(), platform = process.platform } = {}) {
  return value ? resolve(cwd, value) : join(threadroomDataDirectory(env, home, platform), 'threadroom.sqlite');
}
