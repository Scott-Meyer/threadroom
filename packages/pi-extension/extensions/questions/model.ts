import type { QuestionAnswer, QuestionGroup, QuestionResult, QuestionSpec } from './types.ts';

type Cell = { spec: QuestionSpec; index: number; incarnation: number; option: number; confirmed?: number; custom: boolean; reply: string; notes: string; checked: Set<number>; saving: boolean; error?: string; errorCode?: string };
type Group = { spec: QuestionGroup; incarnation: number; cells: Cell[]; paused: boolean; reviewChoice: 0 | 1; resolve?: (result: QuestionResult) => void; reject?: (error: Error) => void };
export type QuestionTab = Readonly<{ key: string; groupId: string; questionId?: string; mode: 'blocking' | 'async'; review: boolean; header?: string; incarnation: number }>;
export type QuestionState = Readonly<{
  tab: QuestionTab; question?: QuestionSpec; index?: number; option?: number;
  reply?: string; custom: boolean; notes?: string; checked?: readonly number[]; saving: boolean;
  error?: string; errorCode?: string; paused: boolean; reviewChoice: 0 | 1;
}>;
const key = (group: string, question?: string) => JSON.stringify(question === undefined ? [group, 'review'] : [group, 'question', question]);
const detached = () => Object.assign(new Error('Question presentation detached.'), { code: 'presentation_detached' });

/** Presentation state for independent question sources. Disposal is not refusal;
 * async success is source persistence, never a feedback-consumption receipt. */
export class QuestionModel {
  private groups = new Map<string, Group>();
  private activeKey?: string;
  private disposed = false;
  private serial = 0;
  private blockingCompletion?: 'answered' | 'cancelled' | 'detached';
  private changed: () => void;
  constructor(changed: () => void = () => {}) { this.changed = changed; }
  tabs(): readonly QuestionTab[] {
    return [...this.groups.values()].sort((a, b) => Number(a.spec.mode === 'async') - Number(b.spec.mode === 'async')).flatMap((group) => [
      ...group.cells.map((cell) => Object.freeze({ key: key(group.spec.id, cell.spec.id), groupId: group.spec.id, questionId: cell.spec.id, mode: group.spec.mode, review: false, header: cell.spec.header, incarnation: cell.incarnation })),
      ...(group.spec.mode === 'blocking' && group.spec.questions.length > 1 ? [Object.freeze({ key: key(group.spec.id), groupId: group.spec.id, mode: group.spec.mode, review: true, incarnation: group.incarnation })] : []),
    ]);
  }
  current(): QuestionState | undefined {
    const tab = this.tabs().find((tab) => tab.key === this.activeKey) || this.tabs()[0];
    if (!tab) return;
    const group = this.groups.get(tab.groupId)!, cell = group.cells.find((cell) => cell.spec.id === tab.questionId);
    return Object.freeze({ tab, question: cell?.spec, index: cell?.index, option: cell?.option, reply: cell?.reply, custom: !!cell?.custom, notes: cell?.notes,
      checked: cell ? Object.freeze([...cell.checked]) : undefined, saving: !!cell?.saving, error: cell?.error, errorCode: cell?.errorCode, paused: group.paused, reviewChoice: group.reviewChoice });
  }
  enqueue(input: QuestionGroup) {
    if (this.disposed) throw detached();
    if (!input.id || this.groups.has(input.id)) throw new Error('Group identity must be unique.');
    if (!input.questions.length || input.questions.some((q) => !q.id) || new Set(input.questions.map((q) => q.id)).size !== input.questions.length) throw new Error('A group needs unique nonempty question identities.');
    if (input.mode === 'async' && !input.commit) throw new Error('Async sources own answer persistence.');
    const questions = Object.freeze(input.questions.map((q) => Object.freeze({ ...q, options: q.options && Object.freeze(q.options.map((option) => Object.freeze({ ...option }))) })));
    const group: Group = { spec: Object.freeze({ ...input, questions }), incarnation: ++this.serial, cells: questions.map((spec, index) => ({ spec, index, incarnation: ++this.serial, option: 0, custom: !spec.options?.length, reply: '', notes: '', checked: new Set(), saving: false })), paused: false, reviewChoice: 0 };
    const outcome = input.mode === 'blocking' ? new Promise<QuestionResult>((resolve, reject) => { group.resolve = resolve; group.reject = reject; }) : undefined;
    const previous = this.current()?.tab;
    this.groups.set(input.id, group);
    if (!previous || (input.mode === 'blocking' && previous.mode === 'async')) this.activeKey = this.tabs()[0]?.key;
    else this.activeKey = previous.key;
    this.changed();
    return { outcome, detach: () => { if (this.groups.get(input.id) !== group) return; this.remove(group, 'detached'); group.reject?.(detached()); } };
  }
  select(groupId: string, questionId?: string) {
    const target = this.tabs().find((tab) => tab.key === key(groupId, questionId));
    if (!target) throw new Error('Unknown question tab.');
    this.activeKey = target.key; this.groups.get(groupId)!.paused = false; this.changed();
  }
  navigate(delta: number) {
    const tabs = this.tabs(), current = this.current(); if (!current) return;
    const at = tabs.findIndex((tab) => tab.key === current.tab.key), tab = tabs[(at + delta + tabs.length) % tabs.length];
    this.select(tab.groupId, tab.questionId);
  }
  /** Tabs whose groups have not been paused, without changing selection. */
  unpausedTabs(): readonly QuestionTab[] {
    return Object.freeze(this.tabs().filter((tab) => !this.groups.get(tab.groupId)?.paused));
  }
  /** The last required-group completion since the host last crossed out of modal state. */
  takeBlockingCompletion() {
    const completion = this.blockingCompletion; this.blockingCompletion = undefined; return completion;
  }
  private cell(): Cell | undefined {
    const current = this.current();
    return current && this.groups.get(current.tab.groupId)?.cells.find((cell) => cell.spec.id === current.tab.questionId);
  }
  moveOption(delta: number) {
    const cell = this.cell(); if (!cell || cell.saving) return;
    const count = (cell.spec.options?.length || 0) + 1;
    cell.option = (cell.option + delta + count) % count; this.changed();
  }
  setReply(reply: string) { const cell = this.cell(); if (!cell || cell.saving) return; cell.reply = reply; cell.custom = !!reply || !cell.spec.options?.length; cell.confirmed = undefined; this.changed(); }
  useCustom() { const cell = this.cell(); if (cell && !cell.saving) { cell.custom = true; this.changed(); } }
  useChoices() { const cell = this.cell(); if (cell && !cell.saving && cell.spec.options?.length) { cell.custom = false; this.changed(); } }
  /** An edit capability belongs to this exact cell/activation, not its reusable ID. */
  draftEdit() {
    const current = this.current(), cell = this.cell(); if (!current || !cell || cell.saving) return;
    const group = this.groups.get(current.tab.groupId)!;
    const replace = (field: 'reply' | 'notes', value: string) => {
      if (this.disposed || this.groups.get(group.spec.id) !== group || !group.cells.includes(cell) || cell.saving || (field === 'notes' && cell.spec.allowNotes === false)) return false;
      cell[field] = value;
      if (field === 'reply') { cell.custom = !!value || !cell.spec.options?.length; cell.confirmed = undefined; }
      this.changed(); return true;
    };
    return Object.freeze({ reply: cell.reply, notes: cell.notes, replaceReply: (value: string) => replace('reply', value), replaceNotes: (value: string) => replace('notes', value) });
  }
  setNotes(notes: string) { const cell = this.cell(); if (!cell || cell.saving || cell.spec.allowNotes === false) return; cell.notes = notes; this.changed(); }
  toggleOption() {
    const cell = this.cell(); if (!cell || cell.saving || !cell.spec.multiSelect || !cell.spec.options?.[cell.option]) return;
    if (cell.checked.has(cell.option)) cell.checked.delete(cell.option); else cell.checked.add(cell.option); this.changed();
  }
  private answer(cell: Cell, confirming = false): QuestionAnswer | undefined {
    const base = { questionIndex: cell.index, question: cell.spec.question, ...(cell.notes ? { notes: cell.notes } : {}) };
    if (cell.spec.multiSelect) {
      const indices = [...cell.checked].sort((a, b) => a - b); if (!indices.length && !(cell.custom && cell.reply)) return;
      const choices = indices.map((index) => cell.spec.options![index]);
      return Object.freeze({ ...base, selected: Object.freeze(choices.map((option) => option.label)), optionIndices: Object.freeze(indices), previews: Object.freeze(choices.map((option) => option.preview ?? null)), ...(cell.custom && cell.reply ? { answer: cell.reply, wasCustom: true } : {}) });
    }
    if (cell.custom) return cell.reply ? Object.freeze({ ...base, answer: cell.reply, wasCustom: true }) : undefined;
    const index = confirming ? cell.option : cell.confirmed, option = index === undefined ? undefined : cell.spec.options?.[index];
    if (!option) return;
    return Object.freeze({ ...base, answer: option.label, optionIndex: index, ...(option.preview !== undefined ? { preview: option.preview } : {}) });
  }
  answers(groupId: string): readonly QuestionAnswer[] {
    const group = this.groups.get(groupId); if (!group) return Object.freeze([]);
    return Object.freeze(group.cells.flatMap((cell) => { const answer = this.answer(cell); return answer ? [answer] : []; }));
  }
  async confirm() {
    const current = this.current(); if (!current || current.paused || current.saving) return;
    const group = this.groups.get(current.tab.groupId)!;
    if (current.tab.review) { if (group.reviewChoice) this.cancel(); else this.submit(group.spec.id); return; }
    const cell = this.cell()!, answer = this.answer(cell, true); if (!answer) return;
    if (group.spec.mode === 'blocking') {
      cell.confirmed = cell.option;
      if (group.cells.length === 1) this.submit(group.spec.id);
      else this.select(group.spec.id, group.cells[cell.index + 1]?.spec.id);
      return;
    }
    cell.saving = true; cell.error = cell.errorCode = undefined; this.changed();
    try {
      await group.spec.commit!(cell.spec.id, answer);
      if (this.groups.get(group.spec.id) !== group) return;
      group.cells = group.cells.filter((candidate) => candidate !== cell);
      if (!group.cells.length) this.remove(group); else this.changed();
    } catch (error) {
      if (this.groups.get(group.spec.id) === group) { cell.error = String(error); cell.errorCode = typeof (error as any)?.code === 'string' ? (error as any).code : undefined; this.changed(); }
    } finally { if (!this.disposed && this.groups.get(group.spec.id) === group) { cell.saving = false; this.changed(); } }
  }
  moveReview() { const current = this.current(); if (!current?.tab.review) return; const group = this.groups.get(current.tab.groupId)!; group.reviewChoice = group.reviewChoice ? 0 : 1; this.changed(); }
  submit(groupId: string) {
    const group = this.groups.get(groupId); if (!group || group.spec.mode !== 'blocking') return;
    const result = Object.freeze({ answers: this.answers(groupId), cancelled: false }); this.remove(group, 'answered'); group.resolve!(result);
  }
  cancel() {
    const current = this.current(); if (!current) return;
    const group = this.groups.get(current.tab.groupId)!;
    if (group.spec.mode === 'async') { group.paused = true; this.changed(); return; }
    const result = Object.freeze({ answers: this.answers(group.spec.id), cancelled: true }); this.remove(group, 'cancelled'); group.resolve!(result);
  }
  private remove(group: Group, completion?: 'answered' | 'cancelled' | 'detached') {
    this.groups.delete(group.spec.id);
    if (group.spec.mode === 'blocking' && completion) this.blockingCompletion = completion;
    if (!this.tabs().some((tab) => tab.key === this.activeKey)) this.activeKey = this.tabs()[0]?.key;
    this.changed();
  }
  dispose() { if (this.disposed) return; this.disposed = true; for (const group of [...this.groups.values()]) { this.remove(group, 'detached'); group.reject?.(detached()); } }
}
