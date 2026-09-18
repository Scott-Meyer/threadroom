import { stripVTControlCharacters } from 'node:util';

/** Render/paste safety, never a rewrite of the original stored question. */
export function readable(value: unknown): string {
  return stripVTControlCharacters(String(value)).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}
export function replyText(value: string): string { return readable(value).replace(/\s+/gu, ' ').trimStart(); }
