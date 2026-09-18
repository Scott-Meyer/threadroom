// HTTP transport over committed store state. Notifications wake readers; the durable
// event log / node snapshot, rather than the notification payload, is authoritative.
const HUMAN_RESPONSES = new Set(['answer', 'reject', 'clarification', 'defer']);
const HEARTBEAT_MS = 15_000;

export function streamEvents(request, response, store, { after = 0, threadId } = {}) {
  // EventSource reconnect cursors take precedence over the original URL cursor.
  let cursor = sequence(request.headers['last-event-id'] || after);
  let closed = false;
  let draining = false;
  let blocked = false;
  let heartbeat;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    store.changes.off('change', onChange);
    response.off('drain', onDrain);
    response.off('close', cleanup);
    response.off('finish', cleanup);
    response.off('error', cleanup);
    request.off('aborted', cleanup);
  };
  const drain = () => {
    if (closed || draining || blocked) return;
    draining = true;
    try {
      // A page is bounded, not the replay: reconnects may need more than 100 events.
      while (!closed && !blocked) {
        const events = store.listEvents(cursor, threadId);
        if (events.length === 0) break;
        for (const event of events) {
          const next = sequence(event.sequence);
          if (next <= cursor) throw new Error('Event log must advance its sequence');
          const writable = response.write(`id: ${next}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = next; // write(false) still accepted this event; resume after it.
          if (!writable) {
            blocked = true;
            break;
          }
          if (closed) break;
        }
      }
    } finally {
      draining = false;
    }
  };
  const onChange = () => {
    try { drain(); } catch (error) { cleanup(); response.destroy(error); }
  };
  const onDrain = () => { blocked = false; onChange(); };

  // Subscribe before replay, so a write cannot fall between replay and listening.
  store.changes.on('change', onChange);
  request.on('aborted', cleanup);
  response.on('close', cleanup);
  response.on('finish', cleanup);
  response.on('error', cleanup);
  response.on('drain', onDrain);
  if (request.aborted || response.destroyed) { cleanup(); return; }
  try {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders();
    drain();
    heartbeat = setInterval(() => {
      // Keepalive only: it neither polls the store nor accumulates a slow-client queue.
      if (!closed && !blocked) blocked = !response.write(': keepalive\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  } catch (error) {
    cleanup();
    response.destroy(error);
  }
}

export function waitForResponse(request, response, store, nodeId, { timeoutMs = 60_000, published } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw inputError('timeoutMs must be a non-negative number');
  timeoutMs = Math.min(timeoutMs, 120_000);
  let closed = false;
  let timer;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    store.changes.off('change', onChange);
    request.off('aborted', cleanup);
    response.off('close', cleanup);
    response.off('finish', cleanup);
    response.off('error', cleanup);
  };
  const finish = (reply, timedOut) => {
    if (closed) return;
    cleanup();
    json(response, 200, {
      published,
      outcome: reply ? reply.response.kind : 'pending',
      response: reply,
      timedOut
    });
  };
  const currentResponse = () => {
    const { node, children } = store.getNode(nodeId);
    const responses = children.filter((child) => child.response);
    const latest = responses.at(-1);
    // A team reply reopens the question. An earlier human turn is not an answer
    // to this wait, including when an idempotent publish is retried after reopening.
    if (node.status === 'outstanding' && responses.some((child) => child.response?.kind === 'team_reply')) return null;
    return HUMAN_RESPONSES.has(latest?.response?.kind) ? latest : null;
  };
  const check = () => {
    if (closed) return;
    const reply = currentResponse();
    if (reply) finish(reply, false);
  };
  const fail = (error) => {
    if (closed) return;
    cleanup();
    const status = error.statusCode || 500;
    json(response, status, { error: status === 500 ? 'Internal server error' : error.message, published });
  };
  const onChange = () => {
    try { check(); } catch (error) { fail(error); }
  };

  // Request 'close' also fires for a normally consumed POST body. Only aborted
  // requests and closed responses represent cancellation of this waiter.
  store.changes.on('change', onChange);
  request.on('aborted', cleanup);
  response.on('close', cleanup);
  response.on('finish', cleanup);
  response.on('error', cleanup);
  if (request.aborted || response.destroyed) { cleanup(); return; }
  try {
    check();
    if (!closed) {
      timer = setTimeout(() => {
        // Recheck committed state at the deadline before issuing a pending receipt.
        try { check(); if (!closed) finish(null, true); } catch (error) { fail(error); }
      }, timeoutMs);
      timer.unref?.();
    }
  } catch (error) {
    cleanup();
    throw error; // The host can handle a synchronous missing-node / input error.
  }
}

function sequence(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw inputError('Event cursor must be a non-negative safe integer');
  return result;
}

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
