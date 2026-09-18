import { Input, matchesKey, wrapTextWithAnsi, truncateToWidth, Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

// Stored text is data, never terminal instructions (including OSC links and bidi).
export function plain(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}
function singleLine(value: unknown) { return plain(value).replace(/\n/g, ' '); }
export function card(text: string) { return new Text(plain(text), 0, 0); }

/** An on-demand inbox. No component exists until the person opens /asks. */
export class AskInbox {
  private input = new Input({ prompt: '> ', placeholder: 'Your response (suggestions are optional)' });
  private selected = 0;
  private question: any;
  private suggestion = -1;
  private scroll = 0;
  private closed = false;
  private _focused = false;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(private items: any[], private tui: any, private theme: any,
    private done: (value: { id: string; text: string; optionIndex?: number } | undefined) => void,
    initialId?: string) {
    this.input.onSubmit = (text) => {
      if (!this.question || !text.trim()) return;
      this.close({ id: this.question.id, text,
        ...(this.suggestion >= 0 && text === singleLine(this.question.prompt.options[this.suggestion].label)
          ? { optionIndex: this.suggestion } : {}) });
    };
    if (initialId) this.open(items.find((item) => item.id === initialId));
  }
  private close(value: any) { if (!this.closed) { this.closed = true; this.done(value); } }
  private open(item: any) {
    if (!item) return;
    this.question = item; this.suggestion = -1; this.scroll = 0; this.input.setValue('');
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, 'escape')) { this.close(undefined); return; }
    if (!this.question) {
      if (matchesKey(data, 'up')) this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, 'down')) this.selected = Math.min(this.items.length - 1, this.selected + 1);
      else if (matchesKey(data, 'enter')) this.open(this.items[this.selected]);
    } else if (matchesKey(data, 'pageUp')) this.scroll = Math.max(0, this.scroll - 5);
    else if (matchesKey(data, 'pageDown')) this.scroll += 5;
    else if (matchesKey(data, 'tab') && this.question.prompt.options?.length) {
      this.suggestion = (this.suggestion + 1) % this.question.prompt.options.length;
      this.input.setValue(singleLine(this.question.prompt.options[this.suggestion].label));
    } else {
      this.input.handleInput(data);
      // Pi Input keeps raw bracketed-paste contents. Never let pasted OSC/CSI or
      // bidi controls become instructions when that value is rendered next.
      const value = this.input.getValue();
      const safe = singleLine(value);
      if (safe !== value) this.input.setValue(safe);
    }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const line = (text: string) => truncateToWidth(singleLine(text), Math.max(1, width));
    const height = Math.max(4, Math.min(18, (this.tui.terminal?.rows || 30) - 12));
    const title = this.theme.fg('accent', line('Private asks · /asks'));
    if (!this.question) {
      const start = Math.max(0, this.selected - height + 1);
      return [title, line('↑/↓ choose · Enter open · Esc close'), ...this.items.slice(start, start + height)
        .map((item, i) => line(`${start + i === this.selected ? '›' : ' '} ${plain(item.prompt.question)}`))];
    }
    const { prompt } = this.question;
    const body = [prompt.question, prompt.context, ...(prompt.options || []).map((option: any, i: number) =>
      `${i + 1}. ${option.label}${option.preview ? `\n   ${option.preview}` : ''}`)].filter(Boolean).join('\n\n');
    const wrapped = wrapTextWithAnsi(plain(body), Math.max(1, width));
    this.scroll = Math.min(this.scroll, Math.max(0, wrapped.length - height));
    const end = Math.min(wrapped.length, this.scroll + height);
    return [title, ...wrapped.slice(this.scroll, end),
      line(wrapped.length > height ? `Prompt ${this.scroll + 1}–${end}/${wrapped.length} · PgUp/PgDn scroll` : ''),
      line('Free response · Enter submit' + (prompt.options?.length ? ' · Tab use/edit suggestion' : '')),
      line('Esc closes; question stays pending. Unsaved drafts are discarded.'),
      ...this.input.render(Math.max(1, width))];
  }
  invalidate() { this.input.invalidate(); }
  dispose() { this.closed = true; }
}
