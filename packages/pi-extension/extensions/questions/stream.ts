import type { Theme, ToolRenderContext, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { readable } from './text.ts';

/** Transcript presentation only. Raw records confer no storage/delivery authority.
 * Authored fields are sanitized before trusted theme styling; inputs are never changed. */
export type StreamOptions = { readonly expanded: boolean };
type Result = { readonly details?: unknown; readonly content?: readonly unknown[] };
type RecordValue = Record<string, unknown>;
type Role = 'question' | 'reply' | 'context';
type Row = { text: string; color?: 'text' | 'dim' | 'warning' | 'error'; compact?: boolean };

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function field(value: unknown): string { return typeof value === 'string' ? readable(value) : ''; }
function line(value: unknown): string { return field(value).replace(/\s+/gu, ' ').trim(); }
function title(prompt: unknown): string {
  const data = record(prompt);
  return line(data.header) || field(data.question).split('\n').find(part => part.trim())?.trim() || '';
}
// Escaped literal IDs retain actual identity even if an older host supplies controls.
function identity(value: unknown): string {
  return typeof value === 'string' && value.length ? JSON.stringify(value).slice(1, -1)
    .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) : '';
}
function reference(kind: string, value: unknown): string {
  const id = identity(value); return id ? `${kind}:${id}` : '';
}
function callReference(context?: ToolRenderContext): string { return reference('call', context?.toolCallId); }
function integer(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0; }
function literal(label: string, value: unknown): Row[] {
  return typeof value === 'string' ? [{ text: `${label}:`, color: 'dim' }, { text: field(value) }] : [];
}
function promptRows(value: unknown): Row[] {
  const prompt = record(value), rows = [...literal('Authored header', prompt.header), ...literal('Question', prompt.question), ...literal('Context', prompt.context)];
  if (typeof prompt.multiSelect === 'boolean') rows.push({ text: `Multiple selections: ${prompt.multiSelect ? 'allowed' : 'no'}`, color: 'dim' });
  for (const [index, value] of list(prompt.options).entries()) {
    const option = typeof value === 'string' ? { label: value } : record(value);
    rows.push(...literal(`Suggestion ${index + 1}`, option.label), ...literal('Description', option.description), ...literal('Preview', option.preview));
  }
  return rows;
}
function nativeReplyRows(value: unknown): Row[] {
  const answer = record(value), rows = literal('Reply', answer.text);
  if (integer(answer.optionIndex)) rows.push({ text: `Original suggestion: ${answer.optionIndex + 1}`, color: 'dim' });
  const selection = record(answer.selection);
  rows.push(...literal('Selected label', selection.label), ...literal('Selected preview', selection.preview));
  const indices = list(answer.optionIndices), selections = list(answer.selections);
  for (const [position, value] of selections.entries()) {
    const selected = record(value), index = indices[position];
    rows.push(...literal(integer(index) ? `Selected suggestion ${index + 1}` : 'Selected label', selected.label),
      ...literal('Selected preview', selected.preview));
  }
  rows.push(...literal('Additional reply', answer.custom));
  return rows;
}
function contentText(result: Result): string {
  return list(result.content).map(part => field(record(part).text)).filter(Boolean).join('\n');
}

/** No implicit padding or colored tool-success shell. The host owns placement. */
function card(role: Role, heading: string, authoredTitle: string, metadata: string[], rows: Row[], theme: Theme): Component {
  const color = role === 'question' ? 'borderAccent' : role === 'reply' ? 'customMessageLabel' : 'dim';
  return {
    render(width: number) {
      if (width <= 0) return [];
      const header = theme.fg(color, heading) + (authoredTitle ? ` · ${theme.fg('text', authoredTitle)}` : '');
      const output = [truncateToWidth(header, width, '…')];
      const meta = metadata.filter(Boolean).join(' · ');
      if (meta) output.push(truncateToWidth(theme.fg('dim', `│ ${meta}`), width, '…'));
      for (const row of rows) {
        // SDK rows never contain line breaks. A one-column viewport cannot fit
        // a wide glyph, so expanded originals use reversible Unicode escapes.
        const literal = row.compact ? line(row.text) : width === 1
          ? row.text.replace(/[^\x00-\x7f]/gu, char => `\\u{${char.codePointAt(0)!.toString(16)}}`) : row.text;
        const text = theme.fg(row.color || 'text', literal);
        output.push(...(row.compact ? [truncateToWidth(text, width, '…')] : new Text(text, 0, 0).render(width).map(part => truncateToWidth(part, width, ''))));
      }
      return output;
    },
    invalidate() {},
  };
}
function nativeMetadata(data: RecordValue, question: boolean): string[] {
  return ['PRIVATE', 'ASYNC', reference('q', question ? data.id : data.questionId)];
}

/** Original native source record. A caption is not proof of a successful append. */
export function renderNativeQuestion(data: unknown, options: StreamOptions, theme: Theme): Component {
  const source = record(data), prompt = record(source.prompt), expanded = options?.expanded;
  const rows = expanded ? [
    ...literal('Question identity', identity(source.id) || undefined),
    ...literal('Source call', identity(source.toolCallId) || undefined),
    ...promptRows(prompt),
  ] : [{ text: [list(prompt.options).length ? `${list(prompt.options).length} suggestions` : '',
    typeof prompt.context === 'string' ? 'Context available' : ''].filter(Boolean).join(' · '), color: 'dim', compact: true }].filter(row => row.text) as Row[];
  return card('question', 'Question', title(prompt), nativeMetadata(source, true), rows, theme);
}

/** Human reply record; does not claim persistence, consumption, or completion. */
export function renderNativeAnswer(data: unknown, options: StreamOptions, theme: Theme): Component {
  const source = record(data), answer = record(source.answer);
  const rows = options?.expanded ? [
    ...literal('Question identity', identity(source.questionId) || undefined),
    ...literal('Answer identity', identity(source.answerId) || undefined),
    ...promptRows(source.prompt), ...nativeReplyRows(answer),
  ] : [{ text: line(answer.text), compact: true }].filter(row => row.text);
  return card('reply', 'Your reply', title(source.prompt), nativeMetadata(source, false), rows, theme);
}

/** Context echo is intentionally compact, not another primary reply body.
 * An SDK context row alone cannot prove the model read or received it. */
export function renderNativeFeedback(details: unknown, options: StreamOptions, theme: Theme): Component {
  const source = record(details);
  const rows = options?.expanded ? [
    ...literal('Question identity', identity(source.questionId) || undefined),
    ...literal('Answer identity', identity(source.answerId) || undefined),
    ...promptRows(source.prompt), ...nativeReplyRows(source.answer),
  ] : [];
  return card('context', 'Reply context', '', nativeMetadata(source, false), rows, theme);
}

/** Public SDK call context supplies a call reference; absent older-host context
 * never causes a reference inferred from authored question text. */
export function renderAsyncAskCall(args: unknown, theme: Theme, context?: ToolRenderContext): Component {
  const prompt = record(args);
  return card('question', 'Question request', title(prompt), ['PRIVATE', 'ASYNC', callReference(context)],
    context?.expanded ? promptRows(prompt) : [], theme);
}

const failedRequests: Record<string, string> = {
  unsupported_host: 'Not presented · unsupported host',
  aborted: 'Request aborted',
  session_changing: 'Request detached · session changing',
  invalid_question: 'Question request invalid',
  identity_conflict: 'Question identity conflict',
  save_failed: 'Question storage failed',
  storage_unconfirmed: 'Storage unconfirmed',
};
export function renderAsyncAskResult(result: Result, options: ToolRenderResultOptions, theme: Theme, context?: ToolRenderContext): Component {
  const details = record(result.details), status = field(details.status), partial = options?.isPartial || context?.isPartial;
  const children = list(details.questions).map(record);
  const failed = Object.hasOwn(failedRequests, status) ? failedRequests[status] : undefined;
  const error = context?.isError === true, metadata = ['PRIVATE', 'ASYNC', reference('q', details.id) || callReference(context)];
  const heading = error ? 'Question request failed' : partial ? 'Question request update' : (status === 'pending' || status === 'answered' ? 'Question reference' : 'Question request result');
  const rows: Row[] = [], content = contentText(result);
  if (failed) rows.push({ text: failed, color: status === 'storage_unconfirmed' ? 'warning' : 'error', compact: true });
  for (const [index, child] of children.entries()) {
    const childStatus = field(child.status), childFailure = failedRequests[childStatus];
    rows.push({ text: `Question ${index + 1}${identity(child.id) ? ` · q:${identity(child.id)}` : ''} · ${childFailure || childStatus || 'unknown result'}`,
      color: childFailure ? childStatus === 'storage_unconfirmed' ? 'warning' : 'error' : 'dim', compact: true });
    if (childFailure || options?.expanded) rows.push(...literal('Reason', child.reason), ...literal('Storage diagnostic', child.error),
      ...literal('Presentation diagnostic', child.presentationError));
  }
  if (error || !Object.keys(details).length) {
    const diagnostic = content || field(details.error) || field(details.reason);
    if (diagnostic) rows.push({ text: diagnostic, color: error ? 'error' : 'text', compact: !options?.expanded });
  }
  if (options?.expanded) {
    rows.push(...literal('Question identity', identity(details.id) || undefined), ...literal('Source call', identity(context?.toolCallId) || undefined));
    if (status) rows.push({ text: `Status reported by request: ${status}`, color: 'dim' });
    rows.push(...literal('Reason', details.reason), ...literal('Storage diagnostic', details.error), ...literal('Presentation diagnostic', details.presentationError));
    const args = record(context?.args), authored = list(args.questions);
    if (authored.length) for (const [index, prompt] of authored.entries()) {
      rows.push({ text: `Original question ${index + 1}`, color: 'dim' }, ...promptRows(prompt));
    }
    else if (context?.args) rows.push(...promptRows(context.args));
  }
  return card('context', heading, '', metadata, rows, theme);
}

export function renderBlockingAskCall(args: unknown, theme: Theme, context?: ToolRenderContext): Component {
  const input = record(args), requests = list(input.questions), first = record(requests[0]);
  const nestedQuestionId = requests.length === 1 ? identity(first.questionId) : '';
  const questionId = nestedQuestionId || (!requests.length ? identity(input.questionId) : ''), questions = questionId ? [] : requests;
  const rows: Row[] = questionId
    ? context?.expanded ? literal('Existing question identity', questionId) : []
    : context?.expanded ? questions.flatMap((question, index) => [
      { text: `Original question ${index + 1}`, color: 'dim' as const }, ...promptRows(question),
    ]) : questions.length > 1 ? [{ text: `${questions.length} questions · waits for this group`, color: 'dim', compact: true }] : [];
  return card('question', questionId ? 'Wait for existing question' : 'Question request', title(first),
    ['PRIVATE', 'BLOCKING', questionId ? reference('q', questionId) : callReference(context)], rows, theme);
}
function blockingAnswerRows(value: unknown, specs: unknown[], expanded: boolean, ref: string): Row[] {
  const answer = record(value), index = integer(answer.questionIndex) ? answer.questionIndex : undefined;
  const heading = index === undefined ? 'Question reply' : `Original question ${index + 1}`;
  const rows: Row[] = [{ text: `${heading}${ref ? ` · ${ref}${index === undefined ? '' : `/${index + 1}`}` : ''}`, color: 'dim', compact: !expanded }];
  if (!expanded) {
    const selected = list(answer.selected).map(line).filter(Boolean).join(', '), custom = line(answer.answer);
    rows.push({ text: [selected, custom].filter(Boolean).join('; '), compact: true });
    if (typeof answer.notes === 'string') rows.push({ text: 'Notes available', color: 'dim', compact: true });
    return rows;
  }
  if (!specs.length) rows.push(...literal('Question', answer.question));
  rows.push(...literal('Reply', answer.answer));
  if (integer(answer.optionIndex)) rows.push({ text: `Original suggestion: ${answer.optionIndex + 1}`, color: 'dim' });
  const indices = list(answer.optionIndices);
  for (const [position, selected] of list(answer.selected).entries()) {
    const option = indices[position], label = integer(option) ? `Selected suggestion ${option + 1}` : 'Selected label';
    rows.push(...literal(label, selected));
  }
  rows.push(...literal('Selected preview', answer.preview));
  for (const [position, preview] of list(answer.previews).entries()) {
    rows.push(...literal(`Selected preview ${position + 1}`, preview === null ? '(none authored)' : preview));
  }
  rows.push(...literal('Notes', answer.notes));
  return rows;
}

/** Partial replies retain authored indices; abort/errors never become a human cancel. */
export function renderBlockingAskResult(result: Result, options: ToolRenderResultOptions, theme: Theme, context?: ToolRenderContext): Component {
  const details = record(result.details), input = record(context?.args), requests = list(input.questions), first = record(requests[0]);
  const nestedQuestionId = requests.length === 1 ? identity(first.questionId) : '';
  const referencedQuestionId = nestedQuestionId || (!requests.length ? identity(input.questionId) : '');
  const specs = referencedQuestionId ? [] : requests, answers = list(details.answers);
  const questionId = identity(details.questionId) || referencedQuestionId, existing = !!questionId;
  const partial = options?.isPartial || context?.isPartial, error = context?.isError;
  const recognizedReply = typeof details.cancelled === 'boolean' || Array.isArray(details.answers);
  const heading = error ? 'Question request failed' : partial ? 'Reply update'
    : existing && details.cancelled === true ? 'Question wait cancelled'
    : existing ? 'Question wait result'
    : details.cancelled === true ? 'Questionnaire cancelled' : recognizedReply ? 'Your replies' : 'Question request result';
  const metadata = ['PRIVATE', 'BLOCKING', existing ? reference('q', details.questionId || referencedQuestionId) : callReference(context) || reference('group', details.groupId)];
  const rows: Row[] = [];
  if (existing) {
    if (details.cancelled === true) rows.push({ text: 'Wait cancelled · original nonblocking question remains pending', color: 'dim', compact: true });
    else if (typeof details.waitNote === 'string') rows.push({ text: field(details.waitNote), color: 'dim', compact: true });
    else if (answers.length) rows.push({ text: 'Saved reply returned through this blocking wait', color: 'dim', compact: true });
  } else if (typeof details.cancelled === 'boolean') {
    rows.push({ text: `${answers.length} ${answers.length === 1 ? 'reply' : 'replies'}${specs.length ? ` / ${specs.length} original questions` : ''}${details.cancelled ? ' · partial replies retained' : ''}`, color: 'dim', compact: true });
    if (specs.length && answers.length < specs.length) rows.push({ text: 'Some original questions unanswered', color: 'dim', compact: true });
  }
  if (options?.expanded) {
    rows.push(...literal(existing ? 'Existing question identity' : 'Group identity', existing ? questionId : identity(details.groupId) || undefined));
    if (existing && typeof details.waitStatus === 'string') rows.push({ text: `Wait status: ${field(details.waitStatus)}`, color: 'dim' });
    for (const [index, spec] of specs.entries()) rows.push({ text: `Original question ${index + 1}`, color: 'dim' }, ...promptRows(spec));
  }
  for (const answer of answers) rows.push(...blockingAnswerRows(answer, specs, !!options?.expanded, metadata[2]));
  if (!answers.length && typeof details.cancelled !== 'boolean') {
    const text = contentText(result);
    if (text) rows.push({ text, color: error ? 'error' : 'text', compact: !options?.expanded });
  }
  return card(error ? 'context' : 'reply', heading, '', metadata, rows, theme);
}

/** One public question tool has two execution modes. The authored schema stays
 * familiar; only an explicit blocking=false changes the execution contract. */
export function renderPrivateAskCall(args: unknown, theme: Theme, context?: ToolRenderContext): Component {
  const input = record(args);
  if (input.blocking !== false) return renderBlockingAskCall(args, theme, context);
  const questions = list(input.questions), first = record(questions[0]);
  if (questions.length === 1) return renderAsyncAskCall(first, theme, context);
  return card('question', 'Question request', title(first), ['PRIVATE', 'ASYNC', callReference(context)],
    context?.expanded ? questions.flatMap((question, index) => [
      { text: `Original question ${index + 1}`, color: 'dim' as const }, ...promptRows(question),
    ]) : [{ text: `${questions.length} questions · continues without waiting`, color: 'dim', compact: true }], theme);
}

export function renderPrivateAskResult(result: Result, options: ToolRenderResultOptions, theme: Theme, context?: ToolRenderContext): Component {
  return record(context?.args).blocking === false
    ? renderAsyncAskResult(result, options, theme, context)
    : renderBlockingAskResult(result, options, theme, context);
}
