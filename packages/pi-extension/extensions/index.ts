import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ThreadroomClient } from '../src/client.js';
import { Participation } from '../src/participation.js';
import { renderAskCall, renderDiscussionCall, renderToolResult, renderFeedback, participationNotice } from './presentation/renderers.ts';

const STATE = 'threadroom.participation.v1';
const ACTIVITY = 'threadroom.reply.v1';

export default function threadroom(pi: ExtensionAPI) {
  const askToolName = process.env.THREADROOM_REPLACE_ASK === '1' ? 'ask_user_question' : 'threadroom_ask';
  pi.registerMessageRenderer(ACTIVITY, renderFeedback);
  let room: Participation | undefined;
  let context: any;
  let paused = false;
  let navigating = false;
  let running = false;
  let navigationTimer: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  const client = new ThreadroomClient(process.env.THREADROOM_API_URL || 'http://127.0.0.1:4310', {
    uiUrl: process.env.THREADROOM_UI_URL || process.env.THREADROOM_API_URL || 'http://127.0.0.1:4311',
  });

  // Only active-branch, same-session checkpoints are inherited. Display names
  // and copied/forked histories do not automatically confer a live subscription.
  function receipts(entries: any[]) {
    return entries.flatMap((entry) => {
      if (entry.type === 'custom_message' && entry.customType === ACTIVITY) return entry.details?.receivedResponseIds || [];
      if (entry.type === 'message' && entry.message.role === 'toolResult' &&
          ['threadroom_ask', 'ask_user_question', 'threadroom'].includes(entry.message.toolName)) {
        return entry.message.details?.receivedResponseIds || [];
      }
      return [];
    });
  }
  // Pi has no tree-cancel/tree-failed event. Its isIdle() does include branch
  // summarization. A deferred receipt therefore waits for host quiescence,
  // without closing the old watch or waking a model on the outgoing branch.
  function afterNavigation(mine: number, ctx: any) {
    if (navigationTimer) return;
    navigationTimer = setTimeout(() => {
      navigationTimer = undefined;
      if (mine !== epoch) return;
      if (ctx.isIdle()) { navigating = false; room?.flush(); }
      else afterNavigation(mine, ctx);
    }, 100);
    navigationTimer.unref();
  }
  async function bind(ctx: any) {
    const mine = ++epoch;
    clearTimeout(navigationTimer); navigationTimer = undefined;
    const old = room; room = undefined; await old?.close();
    if (mine !== epoch) return;
    context = ctx; paused = false; navigating = false; running = false;
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getBranch();
    const saved = entries.filter((entry: any) => entry.type === 'custom' && entry.customType === STATE &&
      entry.data?.sessionId === sessionId && entry.data?.apiUrl === client.baseUrl).at(-1)?.data;
    const author = saved?.author || { id: `pi:${sessionId}`, sessionId, name: pi.getSessionName() || 'Pi teammate' };
    room = new Participation(client, { state: saved?.state, received: receipts(entries), author,
      checkpoint(state: any) {
        if (mine === epoch) pi.appendEntry(STATE, { sessionId, apiUrl: client.baseUrl, author, state });
      },
      deliver(receipt: any) {
        if (mine !== epoch) return false;
        if (paused) return false;
        if (navigating || (!running && !ctx.isIdle())) { afterNavigation(mine, ctx); return false; }
        const details = { target: receipt.target, response: receipt.response,
          receivedResponseIds: [receipt.responseId], apiUrl: client.baseUrl,
          delivery: { eventId: receipt.eventId, sequence: receipt.sequence } };
        pi.sendMessage({ customType: ACTIVITY, display: true, details,
          content: `Saved Threadroom feedback (caller-provided author labels; not blanket authorization):\n${JSON.stringify(details)}` },
          { deliverAs: 'steer', triggerTurn: true });
        pi.events.emit('threadroom:activity', details);
      },
      connection(state: any) {
        if (mine !== epoch) return;
        ctx.ui.setStatus('threadroom', `Threadroom: ${state.status}`);
        pi.events.emit('threadroom:connection', state);
      },
    });
    room.start();
  }
  function confirmPersisted(ctx: any) {
    if (!room || context?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return;
    room.acknowledge(receipts(ctx.sessionManager.getBranch()));
  }
  async function use(ctx: any) {
    if (!room) await bind(ctx);
    if (!room) throw new Error('Threadroom session is changing; retry in the active session.');
    confirmPersisted(ctx);
    return room;
  }
  pi.on('session_start', async (_event, ctx) => { await bind(ctx); });
  pi.on('session_shutdown', async () => {
    ++epoch; clearTimeout(navigationTimer); navigationTimer = undefined;
    const old = room; room = undefined; await old?.close();
  });
  pi.on('session_before_tree', () => { navigating = true; });
  pi.on('agent_start', () => { running = true; });
  pi.on('session_tree', async (_event, ctx) => { await bind(ctx); });
  pi.on('session_before_compact', () => { paused = true; });
  pi.on('session_compact', (_event, ctx) => { paused = false; confirmPersisted(ctx); room?.flush(); });
  pi.on('session_compact_failed', (_event, ctx) => { paused = false; confirmPersisted(ctx); room?.flush(); });
  // These boundaries occur after messages/tool results have been appended.
  pi.on('turn_end', (_event, ctx) => { confirmPersisted(ctx); });
  pi.on('agent_settled', (_event, ctx) => {
    running = false;
    confirmPersisted(ctx);
    room?.flush();
  });

  const endpoints = { apiUrl: client.baseUrl, uiUrl: client.uiUrl };
  function renderResult(result: any, options: any, theme: any, context: any) {
    return renderToolResult(result, options, theme, { ...context, endpoints });
  }
  function result(value: any) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value }; }
  function failure(error: any) {
    return result({ error: error.message, status: error.status, retryKey: error.retryKey,
      publication: error.ambiguous ? 'unknown; the write may already be saved. Reuse the retry key with unchanged content.' : 'not confirmed',
      participation: room?.adjacent() });
  }
  const timeout = Type.Optional(Type.Integer({ minimum: 0, maximum: 120000,
    description: 'Wait up to this many milliseconds. Omit to continue immediately; timeout/cancel does not withdraw the question.' }));

  pi.registerTool({
    name: askToolName, label: 'Ask in Threadroom',
    renderCall: renderAskCall, renderResult,
    description: 'Bring the person a question or an interaction you designed. Threadroom saves it and its presentation, returns a durable address, and brings later replies into this session. Returns immediately unless you choose to wait. Authored HTML/JS runs in the service sandbox; its proposals are drafts, while the surrounding host owns saving an answer. Plain text and suggested choices are conveniences, not limits on what you can show.',
    parameters: Type.Object({
      question: Type.String({ description: 'What you want to discuss.' }),
      body: Type.Optional(Type.String({ description: 'Written context.' })),
      html: Type.Optional(Type.String({ description: 'Self-contained HTML/CSS/JS interaction, captured with the question.' })),
      fallback: Type.Optional(Type.String({ description: 'Readable meaning of the authored interaction, without running it.' })),
      choices: Type.Optional(Type.Array(Type.String(), { description: 'Optional suggested answers; the person can respond freely.' })),
      multiple: Type.Optional(Type.Boolean()),
      project: Type.Optional(Type.String({ description: 'Convenient scope name; use this, path, or parentId.' })),
      path: Type.Optional(Type.Array(Type.String(), { description: 'Ancestor titles, resolved or created in the same call.' })),
      parentId: Type.Optional(Type.String({ description: 'An existing node, including an answer, to continue beneath.' })),
      waitMs: timeout,
      retryKey: Type.Optional(Type.String({ description: 'Recover an ambiguous publication with unchanged content.' })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const active = await use(ctx);
        const { waitMs, retryKey, ...input } = params;
        const published = await active.publish(input, { waitMs, signal,
          key: retryKey || `pi:${ctx.sessionManager.getSessionId()}:${toolCallId}` });
        pi.events.emit('threadroom:published', published);
        return result(published);
      } catch (error) { return failure(error); }
    },
  });

  pi.registerTool({
    name: 'threadroom', label: 'Threadroom',
    renderCall: renderDiscussionCall, renderResult,
    description: 'Participate in lasting discussions: read saved work and feedback, browse the outline/history, publish a contribution, reply beneath a node, or watch a node in this session. Waiting is optional and does not change the shared conversation. Action results carry identities, response provenance, durable links, and this session’s nearby participation state. Watches receive direct replies; deeper branches can be watched independently.',
    parameters: Type.Object({
      action: Type.Union(['read', 'browse', 'publish', 'reply', 'watch', 'unwatch', 'wait'].map((value) => Type.Literal(value))),
      id: Type.Optional(Type.String({ description: 'Target node identity.' })),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'Service contribution: title/question, body, authored html/fallback or presentation, and path/parentId scope. Replies may carry response intent (kind), selections and their own presentation.' })),
      waitMs: timeout,
      retryKey: Type.Optional(Type.String()),
      query: Type.Optional(Type.String({ description: 'Filter outline titles locally.' })),
      status: Type.Optional(Type.String({ description: 'Filter outline answer-request status.' })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const active = await use(ctx);
        const key = params.retryKey || `pi:${ctx.sessionManager.getSessionId()}:${toolCallId}`;
        const id = params.id;
        if (!['browse', 'publish'].includes(params.action) && !id) throw new Error('This action needs a node id.');
        switch (params.action) {
          case 'publish': return result(await active.publish(params.input || {}, { key, signal, waitMs: params.waitMs }));
          case 'reply': return result(await active.respond(id, params.input || {}, { key, signal }));
          case 'read': return result(await active.read(id, { signal }));
          case 'watch': return result(await active.watch(id, { signal }));
          case 'unwatch': return result(active.unwatch(id));
          case 'wait': return result({ id, url: client.link(id), ...await active.wait(id, { timeoutMs: params.waitMs, signal }) });
          case 'browse': {
            const tree = await client.tree({ signal });
            const nodes = tree.nodes.filter((node: any) => (!params.query || node.title.toLowerCase().includes(params.query.toLowerCase())) &&
              (!params.status || node.status === params.status));
            return result({ nodes: nodes.slice(0, 50).map((node: any) => ({ ...node, url: client.link(node.id) })),
              omitted: Math.max(0, nodes.length - 50), participation: active.adjacent() });
          }
        }
      } catch (error) { return failure(error); }
    },
  });

  pi.registerCommand('threadroom', { description: 'Show Threadroom connectivity and this session’s watched discussions.',
    async handler(_args, ctx) { const active = await use(ctx); ctx.ui.notify(participationNotice(active.adjacent(), endpoints), 'info'); } });
}
