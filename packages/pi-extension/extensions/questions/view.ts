import { Input, Editor, Text, Markdown, CURSOR_MARKER, getKeybindings, isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { QuestionModel, type QuestionState } from './model.ts';
import { readable, replyText } from './text.ts';

type DraftEditors = { input: Input; notes: Editor; custom: boolean; editingNotes: boolean; submittedNotes?: string; externalEditing?: boolean; editError?: string };
export type QuestionFrame = { header: string[]; lines: string[]; focus: [number, number]; footer: string };

/** SDK components belong to stable question identity, never tab position.
 * Returns complete frame content/geometry; the host owns its bounded viewport. */
export class QuestionView {
  focused = false;
  /** Focus hints exist only when the host owns the complete public route.
   * These flags affect presentation, never drafts. */
  chatFocused = false;
  inputIsCore = true;
  /** Explicit selection can currently acquire pane focus; independent of return capability. */
  entryAvailable = false;
  chatReturnKey: string | undefined;
  focusToggleKey: string | undefined;
  private disposed = false;
  private drafts = new Map<string, DraftEditors>();
  private model: QuestionModel;
  private tui: any;
  private theme: any;
  private editText?: (text: string) => Promise<string | undefined>;
  constructor(model: QuestionModel, tui: any, theme: any, editText?: (text: string) => Promise<string | undefined>) { this.model = model; this.tui = tui; this.theme = theme; this.editText = editText; }
  private async editOutside(editors: DraftEditors) {
    const edit = this.model.draftEdit(); if (!edit || !this.editText || editors.externalEditing) return;
    const notes = editors.editingNotes; editors.externalEditing = true; editors.editError = undefined;
    try {
      const replacement = await this.editText(notes ? edit.notes : edit.reply);
      if (replacement !== undefined) { if (notes) edit.replaceNotes(readable(replacement)); else edit.replaceReply(replyText(replacement)); }
    } catch (error) { editors.editError = String(error); }
    finally { editors.externalEditing = false; if (!this.disposed) this.tui.requestRender(true); }
  }
  private editors(current: QuestionState) {
    const draftKey = JSON.stringify([current.tab.key, current.tab.incarnation]);
    const live = new Set(this.model.tabs().filter((tab) => !tab.review).map((tab) => JSON.stringify([tab.key, tab.incarnation])));
    for (const key of this.drafts.keys()) if (!live.has(key)) this.drafts.delete(key);
    let editors = this.drafts.get(draftKey);
    if (!editors) {
      editors = { input: new Input({ prompt: '' }), notes: new Editor(this.tui, { borderColor: (text) => this.theme.fg('accent', text), selectList: { selectedPrefix: (text) => this.theme.fg('accent', text), selectedText: (text) => this.theme.fg('accent', text), description: (text) => this.theme.fg('dim', text), scrollInfo: (text) => this.theme.fg('dim', text), noMatch: (text) => this.theme.fg('warning', text) } }, getKeybindings()), custom: !current.question?.options?.length, editingNotes: false };
      const captured = editors;
      editors.notes.onSubmit = (text) => { captured.submittedNotes = readable(text); captured.editingNotes = false; this.tui.requestRender(); };
      this.drafts.set(draftKey, editors);
    }
    if (editors.input.getValue() !== current.reply) editors.input.setValue(current.reply || '');
    if (editors.notes.getText() !== current.notes) editors.notes.setText(current.notes || '');
    editors.custom = current.custom;
    editors.input.focused = this.focused && editors.custom && !editors.editingNotes;
    editors.notes.focused = this.focused && editors.editingNotes;
    return editors;
  }
  private tabs(width: number, current: QuestionState) {
    const tabs = this.model.tabs(), at = tabs.findIndex((tab) => tab.key === current.tab.key && tab.incarnation === current.tab.incarnation);
    const label = (index: number) => {
      const tab = tabs[index], mode = tab.mode === 'blocking' ? 'Ask' : 'Async';
      const title = tab.review ? 'review' : tab.header ? truncateToWidth(readable(tab.header).replace(/\s+/gu, ' ').trim(), 24, '') : String(index + 1);
      return `${index === at ? '›' : ''}[${mode} ${title}]`;
    };
    let left = at, right = at, questions = label(at);
    while (left > 0 || right < tabs.length - 1) {
      const nextLeft = left > 0 ? label(left - 1) + ' ' + questions : undefined;
      if (nextLeft && visibleWidth(nextLeft) <= width) { questions = nextLeft; left--; continue; }
      const nextRight = right < tabs.length - 1 ? questions + ' ' + label(right + 1) : undefined;
      if (nextRight && visibleWidth(nextRight) <= width) { questions = nextRight; right++; continue; }
      break;
    }
    return this.theme.fg('accent', truncateToWidth(questions, width, ''));
  }
  private keyLabel(key: string) {
    return key.split('+').map((part) => ({ ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta', tab: 'Tab' })[part.toLowerCase()] || (part.length === 1 ? part.toUpperCase() : part)).join('+');
  }
  private caret(lines: string[], fallback: number): [number, number] {
    const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    return [row < 0 ? fallback : row, (row < 0 ? fallback : row) + 1];
  }
  frame(width: number, inspect = false): QuestionFrame {
    const current = this.model.current();
    if (!current) return { header: [], lines: [], focus: [0, 1], footer: '' };
    const wrap = (text: unknown) => new Text(readable(text), 0, 0).render(width);
    const header = [this.tabs(width, current)];
    const toggle = this.focusToggleKey && this.keyLabel(this.focusToggleKey);
    const collapse = this.chatReturnKey && this.keyLabel(this.chatReturnKey);
    const questionNavigation = `Tab next question${toggle ? ` · ${toggle} ${this.inputIsCore ? 'Chat' : 'previous input'}` : ''}`;
    const questionFooter = `${current.tab.mode === 'blocking' && current.question?.allowNotes !== false ? 'Alt+N notes · ' : ''}${questionNavigation}${collapse ? ` · ${collapse} collapse` : ''} · PgUp/Dn details · Enter confirm · Esc ${current.tab.mode === 'async' ? 'pause' : 'cancel'}`;
    const chatFooter = `${this.inputIsCore && this.chatFocused ? 'Chat editor · Tab completion' : 'Input outside questions'}${this.entryAvailable ? toggle ? ` · ${toggle} questions` : ' · /asks selects questions' : ' · Question focus unavailable'}${collapse ? ` · ${collapse} returns to questions` : ''}`;
    const footer = this.theme.fg('dim', truncateToWidth(this.focused ? questionFooter : chatFooter, width, ''));
    if (current.error || current.saving) header.push(this.theme.fg('warning', truncateToWidth(current.saving ? 'Saving answer…' : current.errorCode === 'storage_unconfirmed' ? 'Storage unconfirmed · PgDn details' : 'Save failed · draft retained · PgDn details', width, '')));
    if (current.paused) return { header, lines: wrap(`Paused; this question remains pending.${this.entryAvailable ? ' /asks resumes it.' : ' Draft retained.'}`), focus: [0, 1], footer };
    if (current.tab.review) {
      const answers = this.model.answers(current.tab.groupId);
      const summary = wrap(`Review this group\n${answers.map((answer) => `${answer.questionIndex + 1}. ${answer.question}: ${[answer.selected?.join(', '), answer.answer].filter(Boolean).join('; ')}${answer.notes ? `\nNotes: ${answer.notes}` : ''}`).join('\n')}\n${answers.length < this.model.tabs().filter((tab) => tab.groupId === current.tab.groupId && !tab.review).length ? 'Some questions are unanswered; partial submission is allowed.' : 'Ready to submit.'}`);
      const picker = ['Submit answers', 'Cancel'].map((label, index) => this.theme.fg(index === current.reviewChoice ? 'accent' : 'text', truncateToWidth(`${index === current.reviewChoice ? '❯' : ' '} ${index + 1}. ${label}`, width, '')));
      return { header, lines: [...summary, ...picker], focus: [summary.length + current.reviewChoice, summary.length + current.reviewChoice + 1], footer };
    }
    const question = current.question!, editors = this.editors(current), options = question.options || [], selected = options[current.option || 0];
    if (editors.editError || editors.externalEditing) {
      const status = current.saving ? 'Saving · editor issue · PgDn details' : current.error ? 'Save/editor issues · PgDn details' : editors.externalEditing ? 'Editing outside Pi…' : 'Editor failed · draft retained · PgDn details';
      const row = this.theme.fg('warning', truncateToWidth(status, width, '')); if (header.length > 1) header[1] = row; else header.push(row);
    }
    if (inspect) {
      const detail = question.question + (question.context ? `\n\n${question.context}` : '') + (selected ? `\n\nSelected ${(current.option || 0) + 1}: ${selected.label}${selected.description ? `\n\n${selected.description}` : ''}${selected.preview !== undefined ? `\n\nPreview:\n${selected.preview}` : ''}` : '') + (current.reply ? `\n\nReply draft:\n${current.reply}` : '') + (current.error ? `\n\nSave diagnostic:\n${current.error}` : '') + (editors.editError ? `\n\nEditor diagnostic:\n${editors.editError}` : '');
      return { header, lines: wrap(detail), focus: [0, 1], footer };
    }
    const lines = wrap(question.question), optionStart = lines.length;
    let focus = optionStart, focusEnd = optionStart + 1;
    for (const [index, option] of options.entries()) {
      const pointer = index === current.option && !editors.custom ? '❯' : ' ';
      const checkbox = question.multiSelect ? (current.checked?.includes(index) ? '[x] ' : '[ ] ') : '';
      const rows = wrap(`${pointer} ${index + 1}. ${checkbox}${option.label}`);
      if (index === current.option && !editors.custom) { focus = lines.length; focusEnd = focus + rows.length; }
      lines.push(...rows.map((line) => this.theme.fg(index === current.option && !editors.custom ? 'accent' : 'text', line)));
    }
    const selectedCustom = editors.custom || current.option === options.length;
    const prefix = truncateToWidth(options.length ? `${selectedCustom ? '❯' : ' '} ${options.length + 1}. Reply: ` : 'Reply: ', Math.max(0, width - 1), '');
    const fieldWidth = Math.max(1, width - visibleWidth(prefix));
    const input = editors.input.focused ? editors.input.render(fieldWidth)
      : [this.theme.fg(current.reply ? 'text' : 'dim', truncateToWidth(readable(current.reply || 'Write a reply…'), fieldWidth, ''))];
    const start = lines.length;
    lines.push(...input.map((line, index) => (index ? ' '.repeat(visibleWidth(prefix)) : this.theme.fg(selectedCustom ? 'accent' : 'text', prefix)) + line));
    if (selectedCustom) { focus = start + this.caret(input, 0)[0]; focusEnd = focus + 1; }
    if (editors.editingNotes) {
      lines.push(...wrap('Notes:'));
      const start = lines.length, notes = editors.notes.focused ? editors.notes.render(width) : wrap(current.notes || 'Write notes…');
      lines.push(...notes); focus = start + this.caret(notes, 0)[0]; focusEnd = focus + 1;
    } else if (current.notes) lines.push(...wrap(`Notes: ${current.notes}`));
    if (selected?.preview !== undefined && !editors.editingNotes && !editors.custom) {
      const preview = readable(selected.preview);
      lines.push(...(question.plainPreview ? wrap(preview) : new Markdown(preview, 0, 0, getMarkdownTheme()).render(width)));
    }
    return { header, lines, focus: [focus, focusEnd], footer };
  }
  handleInput(data: string) {
    const current = this.model.current(); if (this.disposed || !current || isKeyRelease(data)) return;
    const kb = getKeybindings();
    if (isKeyRepeat(data) && (kb.matches(data, 'tui.select.cancel') || kb.matches(data, 'tui.select.confirm') || kb.matches(data, 'tui.input.submit'))) return;
    if (matchesKey(data, 'tab')) { this.model.navigate(1); return; }
    if (matchesKey(data, 'shift+tab')) return;
    if (current.paused || current.saving) return;
    if (current.tab.review) {
      if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) this.model.moveReview();
      else if (kb.matches(data, 'tui.select.confirm') || kb.matches(data, 'tui.input.submit')) void this.model.confirm();
      else if (kb.matches(data, 'tui.select.cancel')) this.model.cancel();
      return;
    }
    const editors = this.editors(current), options = current.question!.options || [];
    if (editors.externalEditing) return;
    const externalKeys = kb.getKeys('app.editor.external' as any);
    if (this.editText && (externalKeys.length ? kb.matches(data, 'app.editor.external') : matchesKey(data, 'ctrl+g'))) {
      if (!isKeyRepeat(data)) void this.editOutside(editors); return;
    }
    if (kb.matches(data, 'tui.select.cancel')) {
      if (editors.editingNotes) editors.editingNotes = false;
      else if (editors.custom && current.tab.mode === 'blocking' && options.length) { editors.custom = false; this.model.useChoices(); }
      else this.model.cancel();
    } else if (current.tab.mode === 'blocking' && current.question?.allowNotes !== false && matchesKey(data, 'alt+n')) {
      editors.editingNotes = !editors.editingNotes;
    } else if (editors.editingNotes) {
      editors.notes.handleInput(data);
      const raw = editors.submittedNotes ?? editors.notes.getText(), safe = readable(raw); editors.submittedNotes = undefined;
      if (editors.notes.getText() !== safe) editors.notes.setText(safe);
      this.model.setNotes(safe);
    } else if (kb.matches(data, 'tui.select.confirm') || kb.matches(data, 'tui.input.submit')) {
      if (!editors.custom && current.option === options.length) { editors.custom = true; this.model.useCustom(); }
      else void this.model.confirm();
    } else if (!editors.custom && (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down'))) this.model.moveOption(kb.matches(data, 'tui.select.down') ? 1 : -1);
    else if (!editors.custom && current.question!.multiSelect && matchesKey(data, 'space')) { if (!isKeyRepeat(data)) this.model.toggleOption(); }
    else {
      const before = editors.input.getValue(); editors.input.handleInput(data);
      const raw = editors.input.getValue(), safe = replyText(raw); if (safe !== raw) editors.input.setValue(safe);
      if (safe !== before) {
        this.model.setReply(safe); editors.custom = !!safe || !options.length;
      }
    }
    this.tui.requestRender();
  }
  invalidate() { for (const draft of this.drafts.values()) { draft.input.invalidate(); draft.notes.invalidate(); } }
  dispose() { this.disposed = true; this.drafts.clear(); }
}
