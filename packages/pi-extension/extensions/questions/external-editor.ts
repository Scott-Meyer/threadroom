import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Explicit user action only. The command is trusted SDK/user configuration;
 * question/paste text is file data, never shell source. Owns file and TUI cleanup. */
export function editTextOutsidePi(tui: any, command: string, text: string): string {
  if (!command.trim()) throw new Error('No external editor is configured.');
  const directory = mkdtempSync(join(tmpdir(), 'pi-question-edit-')), file = join(directory, 'reply.txt');
  let stopped = false;
  try {
    writeFileSync(file, text, { mode: 0o600 });
    tui.stop(); stopped = true;
    const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
    const child = spawnSync('/bin/sh', ['-c', `${command} ${quote(file)}`], { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`External editor exited ${child.signal || child.status}. Original draft retained.`);
    return readFileSync(file, 'utf8');
  } finally {
    try { rmSync(directory, { recursive: true, force: true }); }
    finally { if (stopped) { tui.start(); tui.requestRender(true); } }
  }
}
