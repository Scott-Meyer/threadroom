import { Input, matchesKey, wrapTextWithAnsi, truncateToWidth, visibleWidth, Text } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

// Stored text is data, never terminal instructions (including OSC links and bidi).
export function plain(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}
function singleLine(value: unknown) { return plain(value).replace(/\n/g, ' '); }
export function card(text: string) { return new Text(plain(text), 0, 0); }
export type Feedback = { id: string; text: string; optionIndex?: number };

/** Lives in Pi's normal input area while the agent continues its turn. */
export class AskPanel {
  private input!: Input;
  private question: any;
  private option = 0;
  private writing = false;
  private scroll = 0;
  private pageSize = 1;
  private closed = false;
  private suspended = false;
  beforeRender?: () => void;
  private drafts = new Map<string, { input: Input; writing: boolean; option: number; scroll: number }>();
  private _focused = false;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && this.writing; }

  constructor(private items: any[], private tui: any, private theme: any,
    private done: (value: Feedback | undefined) => void, initialId?: string) {
    this.show(items.find((item) => item.id === initialId) || items[0]);
  }
  suspend(value: boolean) { if (value !== this.suspended) { this.suspended = value; this.tui.requestRender(); } }
  private submit(value: Feedback) { if (!this.closed) this.done(value); }
  close(value?: Feedback) { if (!this.closed) { this.closed = true; this.done(value); } }
  private show(item: any) {
    if (this.input) this.input.focused = false;
    this.question = item;
    const draft = this.drafts.get(item?.id);
    this.input = draft?.input ?? new Input({ prompt: '> ', placeholder: 'Your response' });
    this.input.onSubmit = (text) => {
      if (this.question && text.trim()) this.submit({ id: this.question.id, text });
    };
    this.option = draft?.option ?? 0; this.scroll = draft?.scroll ?? 0;
    this.writing = draft?.writing ?? !item?.prompt.options?.length;
    this.focused = this._focused;
  }
  update(items: any[]) {
    this.items = items;
    for (const id of this.drafts.keys()) if (!items.some((item) => item.id === id)) this.drafts.delete(id);
    // Another async ask joins the panel without replacing the current answer draft.
    if (!items.some((item) => item.id === this.question?.id)) this.show(items[0]);
    if (!items.length) this.close();
    this.tui.requestRender();
  }
  private next(direction = 1) {
    this.drafts.set(this.question.id, { input: this.input, writing: this.writing, option: this.option, scroll: this.scroll });
    const index = this.items.findIndex((item) => item.id === this.question.id);
    this.show(this.items[(index + direction + this.items.length) % this.items.length]);
  }
  private write(value = '') {
    this.writing = true;
    // Browsing choices is not permission to replace an existing written draft.
    if (!this.input.getValue()) this.input.setValue(value);
    this.focused = this._focused;
  }
  handleInput(data: string) {
    if (this.closed || !this.question) return;
    const options = this.question.prompt.options || [];
    if (matchesKey(data, 'escape')) { this.close(); return; }
    if (matchesKey(data, 'shift+tab') && this.items.length > 1) this.next();
    else if (matchesKey(data, 'pageUp')) this.scroll = Math.max(0, this.scroll - this.pageSize);
    else if (matchesKey(data, 'pageDown')) this.scroll += this.pageSize;
    else if (!this.writing && (matchesKey(data, 'left') || matchesKey(data, 'right'))) {
      const direction = matchesKey(data, 'left') ? -1 : 1;
      this.next(direction);
    } else if (!this.writing && (matchesKey(data, 'up') || matchesKey(data, 'down'))) {
      const direction = matchesKey(data, 'up') ? -1 : 1;
      this.option = (this.option + direction + options.length + 1) % (options.length + 1);
      this.scroll = 0;
    } else if (!this.writing && matchesKey(data, 'enter')) {
      if (this.option === options.length) this.write();
      else this.submit({ id: this.question.id, text: singleLine(options[this.option].label), optionIndex: this.option });
    } else if (matchesKey(data, 'tab') && options.length) {
      if (this.writing) { this.writing = false; this.focused = this._focused; }
      else this.write(this.option < options.length ? singleLine(options[this.option].label) : '');
    } else {
      // Let Pi Input decode ordinary text, bracketed paste and Kitty printable
      // keys. Escape-prefixed input is not necessarily a navigation key.
      this.input.handleInput(data);
      const value = this.input.getValue(), safe = singleLine(value);
      if (safe !== value) this.input.setValue(safe);
      if (!this.writing && safe.length) { this.writing = true; this.focused = this._focused; }
    }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    this.beforeRender?.();
    width = Math.max(1, width);
    const line = (text: string) => truncateToWidth(singleLine(text), width);
    const border = this.theme.fg('accent', '─'.repeat(width));
    if (!this.question) return [];
    const { prompt } = this.question;
    if (this.suspended) return [this.theme.fg('accent', line('Private question · waiting for the current Pi prompt')),
      ...wrapTextWithAnsi(plain(prompt.question), width).slice(0, 3)];
    const options = prompt.options || [];
    const title = `Private question${this.items.length > 1 ? ` ${this.items.findIndex((item) => item.id === this.question.id) + 1}/${this.items.length} · Shift+Tab questions` : ''} · reply here`;
    const selected = !this.writing && options[this.option];
    const details = [prompt.question, prompt.context,
      selected && visibleWidth(singleLine(`› ${this.option + 1}. ${selected.label}`)) > width ? `Selected: ${selected.label}` : '',
      selected?.preview ? `Preview: ${selected.preview}` : ''].filter(Boolean).join('\n\n');
    const body = wrapTextWithAnsi(plain(details), width);
    const input = this.writing ? this.input.render(width) : [];
    // Budget the complete widget, leaving space for Pi's editor, status/footer
    // and chat. Every detail remains reachable, even in a short terminal.
    const budget = Math.max(4, Math.min(20, (this.tui.terminal?.rows || 30) - 12));
    const hint = this.writing
      ? 'Enter save reply' + (options.length ? ' · Tab choices' : '') + ' · Esc pause'
      : '↑/↓ choose · Enter save choice · Tab edit · Or type a reply · Esc pause';
    const choiceLine = (i: number) => this.theme.fg(i === this.option ? 'accent' : 'text',
      line(`${i === this.option ? '›' : ' '} ${i + 1}. ${i === options.length ? 'Type something.' : options[i].label}`));
    if (budget <= 6) {
      this.pageSize = 1;
      this.scroll = Math.min(this.scroll, Math.max(0, body.length - 1));
      return [this.theme.fg('accent', line(title)), body[this.scroll],
        ...(this.writing ? input : [choiceLine(this.option)]),
        this.theme.fg('dim', line('PgUp/PgDn details · ' + hint))].slice(0, budget);
    }
    const room = budget - 4 - input.length;
    const count = !this.writing && options.length ? Math.min(6, options.length + 1, Math.max(1, Math.floor(room / 2))) : 0;
    const height = Math.max(1, room - count - 1); // reserve the scroll hint too
    this.pageSize = height;
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - height));
    const rows = [border, this.theme.fg('accent', line(title)), ...body.slice(this.scroll, this.scroll + height)];
    if (body.length > height) rows.push(this.theme.fg('dim', line(`PgUp/PgDn · details ${this.scroll + 1}–${Math.min(body.length, this.scroll + height)}/${body.length}`)));
    if (count) {
      const start = Math.max(0, Math.min(this.option - Math.floor(count / 2), options.length + 1 - count));
      for (let i = start; i < start + count; i++) rows.push(choiceLine(i));
    }
    rows.push(...input, this.theme.fg('dim', line(hint)), border);
    return rows;
  }
  invalidate() { this.input.invalidate(); }
  dispose() { this.closed = true; }
}

/** Escape restores the chat editor, but does not make the pending ask disappear. */
export function pendingCard(items: any[], tui: any, theme: any) {
  return {
    invalidate() {},
    render(width: number) {
      width = Math.max(1, width);
      const rows = [theme.fg('accent', truncateToWidth(`Private questions paused · ${items.length} pending · /asks to reply`, width))];
      const budget = Math.max(2, Math.min(6, Math.floor((tui.terminal?.rows || 30) / 4)));
      for (const item of items) rows.push(...wrapTextWithAnsi(plain(item.prompt.question), width));
      return rows.slice(0, budget);
    },
  };
}
