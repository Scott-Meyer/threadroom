import { Text, hyperlink, getCapabilities } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';

// Saved discussions are text, not terminal instructions or Markdown. Keep the
// original records in the tool/message payload; only this view is abbreviated.
function literal(value: unknown, multiline = false): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  return (text || '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (char) => {
    if (char === '\n') return multiline ? '\n' : ' ';
    if (char === '\t') return '    ';
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
function preview(value: unknown, expanded: boolean, multiline = false): string {
  const text = literal(value, multiline);
  const limit = expanded ? 4000 : 240;
  return text.length > limit ? `${text.slice(0, limit)}… [more at the discussion URL]` : text;
}
function link(value: unknown): string {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    // Only our validated HTTP(S) address becomes a terminal hyperlink. Saved
    // labels and body text never supply escape sequences or hidden targets.
    return getCapabilities().hyperlinks ? hyperlink(url.href, url.href) : url.href;
  } catch { return ''; }
}
function block(theme: Theme, heading: string, lines: string[], pad = 0) {
  return new Text([theme.fg('toolTitle', theme.bold(heading)), ...lines.filter(Boolean)].join('\n'), pad, 0);
}
function author(node: any, expanded: boolean) {
  if (!node?.author) return '';
  // A name, role, session ID, or arbitrary label is provenance, not approval.
  const label = typeof node.author === 'object' ? node.author.name ?? node.author.id ?? node.author : node.author;
  return `Author label: ${preview(expanded ? node.author : label, expanded)} (caller-provided; not authenticated approval)`;
}
function record(node: any, expanded: boolean, url?: unknown): string[] {
  if (!node) return [];
  return [
    preview(node.title || 'Untitled discussion', expanded),
    link(url || node.url),
    expanded ? `Node: ${literal(node.id)}${node.status ? ` · Status: ${literal(node.status)}` : ''}` : node.status ? `Status: ${literal(node.status)}` : '',
    node.body ? preview(node.body, expanded, expanded) : '',
    node.presentation ? `Presentation: ${literal(node.presentation.kind)}${expanded && node.presentation.revision ? ` · Revision: ${literal(node.presentation.revision)}` : ''} (open the discussion)` : '',
    node.presentation?.fallback ? preview(node.presentation.fallback, expanded, expanded) : '',
    expanded ? author(node, true) : '',
  ];
}
function response(node: any, expanded: boolean): string[] {
  if (!node) return [];
  return [
    `Reply intent: ${literal(node.response?.kind || 'contribution')}`,
    node.body ? preview(node.body, expanded, expanded) : preview(node.title, expanded),
    node.response?.selections !== undefined ? `Selections: ${preview(node.response.selections, expanded)}` : '',
    author(node, expanded),
    link(node.url),
    expanded ? `Reply node: ${literal(node.id)}` : '',
    expanded && node.response?.targetId ? `In reply to: ${literal(node.response.targetId)}` : '',
    expanded && node.response?.presentationRevision ? `Responded to revision: ${literal(node.response.presentationRevision)}` : '',
    node.presentation ? `Reply presentation: ${literal(node.presentation.kind)} (open the reply)` : '',
    node.presentation?.fallback ? preview(node.presentation.fallback, expanded, expanded) : '',
  ];
}
const actions: Record<string, string> = {
  read: 'Read discussion', browse: 'Discussion outline', publish: 'Contribution saved',
  reply: 'Reply saved', watch: 'Watching discussion', unwatch: 'Stopped watching in this session', wait: 'Wait finished',
};
const outcomes: Record<string, string> = {
  timeout: 'No reply before the wait ended; the discussion remains saved and watched.',
  cancelled: 'Wait cancelled; shared history is unchanged.',
  unavailable: 'Could not establish the wait outcome; shared history is unchanged.',
  answer: 'Saved reply received · intent: answer', clarification: 'Saved reply received · intent: clarification',
  defer: 'Saved reply received · intent: defer', reject: 'Saved reply received · intent: reject',
};

export function renderAskCall(args: any, theme: Theme, context?: any) {
  return call(args, theme, !!context?.expanded, true);
}
export function renderDiscussionCall(args: any, theme: Theme, context?: any) {
  return call(args, theme, !!context?.expanded, false);
}
function call(args: any, theme: Theme, expanded: boolean, ask: boolean) {
  const input = ask ? args : args.input || {};
  const presentation = input.presentation;
  const authored = input.html !== undefined || presentation?.html !== undefined || presentation?.kind === 'html-v1';
  const scope = input.path || input.project || input.parentId;
  return block(theme, ask ? 'Ask in Threadroom' : `Threadroom · ${literal(args.action || 'discussion')}`, [
    preview(input.question || input.title || args.id || args.query || '', expanded),
    scope ? `Within: ${preview(scope, expanded)}` : '',
    authored ? 'Authored interaction · source stays out of the terminal' : '',
    (input.fallback || presentation?.fallback) ? preview(input.fallback || presentation.fallback, expanded, expanded) : '',
    expanded && input.body ? preview(input.body, true, true) : '',
    args.waitMs !== undefined ? `Wait: up to ${literal(args.waitMs)} ms; ending the wait does not withdraw saved work` : '',
  ]);
}

export function renderToolResult(result: any, options: any, theme: Theme, context?: any) {
  const expanded = !!options.expanded;
  if (options.isPartial) return block(theme, 'Threadroom', ['Working…']);
  const value = result.details;
  if (!value || typeof value !== 'object') {
    const text = (result.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    return block(theme, 'Threadroom', [preview(text || 'No result available.', expanded, expanded)]);
  }
  const action = context?.args?.action || 'publish';
  const lines: string[] = [];
  let heading = actions[action] || 'Threadroom';
  if (value.error && !value.outcome) {
    heading = 'Threadroom · not confirmed';
    lines.push(preview(value.error, expanded, expanded), literal(value.publication),
      value.retryKey ? `Retry key: ${literal(value.retryKey)}` : '', ...endpointLines(context?.endpoints));
  } else if (Array.isArray(value.nodes)) {
    heading = 'Threadroom · discussion outline';
    const shown = expanded ? value.nodes : value.nodes.slice(0, 5);
    for (const node of shown) lines.push(...record(node, false), expanded ? `Node: ${literal(node.id)}` : '');
    const omitted = (value.omitted || 0) + value.nodes.length - shown.length;
    if (omitted) lines.push(`${omitted} more discussions${expanded ? '; narrow the browse query to see them' : '; expand for more'}.`);
    if (!value.nodes.length) lines.push('No matching discussions.');
  } else {
    if (value.outcome) {
      heading = 'Threadroom · wait finished';
      lines.push(outcomes[value.outcome] || `Wait outcome: ${literal(value.outcome)}`);
      if (value.error) lines.push(preview(value.error, expanded), ...endpointLines(context?.endpoints));
    }
    if (value.deduplicated) lines.push('Already saved; this retry did not publish a duplicate.');
    if (value.node?.response && action === 'reply') {
      if (value.target) lines.push(`In discussion: ${preview(value.target.title, expanded)}`, link(value.target.url));
      lines.push(...response(value.node, expanded));
    } else {
      lines.push(...record(value.node, expanded, value.url));
      if (!value.node) lines.push(value.id ? `Node: ${literal(value.id)}` : '', link(value.url));
      if (value.response) lines.push(...response(value.response, expanded));
      else if (value.node?.response) lines.push(...response(value.node, expanded));
      if (expanded && value.ancestors?.length) lines.push(`Within: ${value.ancestors.map((node: any) => literal(node.title)).join(' / ')}`);
      const otherChildren = value.children?.filter((child: any) => child.id !== value.response?.id) || [];
      if (otherChildren.length) {
        const children = expanded ? otherChildren : otherChildren.slice(-2);
        lines.push('Saved contributions:');
        for (const child of children) lines.push(...(child.response ? response(child, expanded) : record(child, expanded)));
        const omitted = (value.omittedChildren || 0) + otherChildren.length - children.length;
        if (omitted) lines.push(`${omitted} other contributions; open the discussion for full history.`);
      }
    }
    if (value.note) lines.push(preview(value.note, expanded));
  }
  if (expanded) {
    if (value.receivedResponseIds?.length) lines.push(`Receipt IDs: ${literal(value.receivedResponseIds)}`);
    if (value.retryKey && !value.error) lines.push(`Retry key: ${literal(value.retryKey)}`);
    if (value.contextSnapshot) lines.push(`Snapshot: ${literal(value.contextSnapshot)}`);
    lines.push(...participationLines(value.participation));
  }
  return block(theme, heading, lines);
}

export function renderFeedback(message: any, options: any, theme: Theme) {
  const value = message.details;
  const expanded = !!options.expanded;
  if (!value?.response?.node) return block(theme, 'Saved Threadroom feedback', [
    preview(typeof message.content === 'string' ? message.content : 'Saved feedback; no readable record available.', expanded, expanded),
  ], options.outputPad ?? 0);
  const lines = [
    `Discussion: ${preview(value.target?.node?.title || 'Untitled discussion', expanded)}`,
    link(value.target?.url || value.target?.node?.url),
    ...response(value.response.node, expanded),
  ];
  if (expanded) lines.push(`Receipt IDs: ${literal(value.receivedResponseIds)}`,
    `Delivery event: ${literal(value.delivery?.eventId)} · sequence: ${literal(value.delivery?.sequence)}`);
  return block(theme, 'Saved Threadroom feedback', lines, options.outputPad ?? 0);
}

function participationLines(state: any): string[] {
  if (!state) return [];
  return [`Connection: ${literal(state.connection)}`, `Watching: ${literal(state.watching || [])}`,
    state.otherWatches ? `${literal(state.otherWatches)} other watches` : '',
    state.unconfirmedDeliveries ? `${literal(state.unconfirmedDeliveries)} deliveries awaiting transcript receipt` : ''];
}
function endpointLines(endpoints: any): string[] {
  if (!endpoints) return [];
  // Notifications are plain text too, not an ANSI or Markdown surface.
  return [`API: ${literal(endpoints.apiUrl)}`, `Website: ${literal(endpoints.uiUrl)}`];
}
export function participationNotice(state: any, endpoints?: any): string {
  return ['Threadroom', ...endpointLines(endpoints), ...participationLines(state)].filter(Boolean).join('\n');
}
