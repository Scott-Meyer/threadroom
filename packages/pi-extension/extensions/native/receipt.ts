import { readFileSync, statSync } from 'node:fs';

/** Public SDK session-file protocol, not manager internals. Memory-only hosts
 * have no disk assertion. A persisted host's branch row alone cannot prove a
 * receipt: SDK can expose it before a failed write. Cache identities only. */
export function createReceiptJournal() {
  let cached: { file: string; stamp: string; ids: Set<string> } | undefined;
  return (manager: { getSessionFile?(): string | undefined }): ReadonlySet<string> | undefined => {
    const file = manager.getSessionFile?.(); if (!file) return undefined;
    try {
      const stat = statSync(file), stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (cached?.file === file && cached.stamp === stamp) return cached.ids;
      const ids = new Set<string>();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        try {
          const entry = JSON.parse(line);
          const nativeFeedback = entry.type === 'custom_message';
          const blockingResult = entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message.toolName === 'ask_user_question';
          if ((nativeFeedback || blockingResult) && typeof entry.id === 'string') ids.add(entry.id);
        } catch {} // A torn line is not a receipt.
      }
      cached = { file, stamp, ids }; return ids;
    } catch { cached = undefined; return new Set<string>(); }
  };
}
