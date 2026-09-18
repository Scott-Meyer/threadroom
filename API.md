# Threadroom API — recursive, UI-independent local spike

Base URL: `http://127.0.0.1:4310`. JSON over HTTP; SSE for live updates. Single-user and unauthenticated for now.

## Normal questions and replies

Using the rendering-independent client in `public/client.js`:

```js
const room = new ThreadroomClient('http://127.0.0.1:4310');
const asked = await room.ask({ project: 'MistFall', question: 'Which direction?' });
await room.reply(asked.node.id, { body: 'Keep the wide silhouette.' });
const discussion = await room.read(asked.node.id); // content + replies in children
```

`project` names an ordinary parent; optional `thread` names a conversation inside it. Both are conveniences for resolving a path, not node types. No tree-building calls or type flags are needed. Leave the project out for an unscoped question. Replies are ordinary nodes too, so discussions can deepen when useful.

## Caller correlation

`author` is captured as supplied JSON, including optional `id` and `sessionId` alongside `name`. These fields survive reads, tree/ancestor context, replies, and restart; they let an adapter correlate a durable interaction with its caller. They are opaque caller-provided metadata, not verified identity or access control. Submitted author metadata is part of new publication/response retry fingerprints, so retries retain the original metadata even if a different session resumes the interaction. Don't put credentials in it.

## Ask at any depth in one call

```sh
curl -s http://127.0.0.1:4310/api/ask \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: trail-review-1' \
  -d '{
    "path": ["MistFall", "Creatures", "Mist creature", "Movement"],
    "question": "Should the trail linger?",
    "choices": ["Briefly", "Until it turns"],
    "author": {"name": "Artist"}
  }'
```

The backend resolves or creates the entire path and publishes the leaf atomically. No prior lookup/create turns are needed. `path` names the ancestors, not the leaf; use an array so titles can contain slashes. Duplicate same-titled siblings make a path ambiguous (`409`), rather than silently choosing one.

Returns `201` with `{node, ancestors, children, counts, url, createdAncestorIds, deduplicated}`. The result carries stable leaf/ancestor identities, saved content, status, and resolved context. A website may use the `/threads/{node.id}` convenience address; another UI can use its own navigation.

A known **`parentId`** replaces `path`, including the ID of an answer. This is the same ordinary publish capability at every depth. Retrying unchanged content with the same idempotency key returns the saved result (`200`); changing content with that key returns `409`.

### Cheap conveniences, not mandatory schemas

- `question: "..."`: shorthand for a title with `expectsAnswer: true`.
- `choices: ["..."]`: optional suggested choices; `multiple: true` allows several.
- `context` or `body`: freeform written content.
- `project: "MistFall"`, optionally `thread: "Movement"`: familiar scope names, equivalent to `path: ["MistFall", "Movement"]`. Choose these, `path`, or `parentId`, rather than mixing locators.
- `title`: ordinary node content; `expectsAnswer: true` optionally requests an answer.

`POST /api/nodes` is the same publication boundary. There is one node shape, with no node `kind`. Every node can have children, authored content, response context, and an answer request. Omitting `path` and `parentId` places it at the top of the outline, not in a special category.

## Authored questions and answers

```json
{
  "path": ["MistFall", "Art", "Experiments"],
  "question": "Try this interaction and tell me what feels right",
  "html": "<h1>My own scene</h1><canvas id='art'></canvas><script>/* any self-contained interaction */</script>",
  "fallback": "A readable explanation of what this scene shows and asks.",
  "revision": "scene-r1"
}
```

Or provide `presentation: {kind: "html-v1", html, fallback, revision}`. The exact authored document is captured durably. Images/resources can be self-contained data URIs. The comparison convenience renderer also captures included `/assets/` image references into the record at publication, rather than leaving history dependent on mutable source files.

The document runs in a sandbox with a small proposal bridge:

```js
window.Threadroom.propose(
  {variant: 'B', proportions: 0.7},
  'Variant B with narrower proportions'
);
```

This proposes a **draft**, never an answer. The host displays it separately; only its own Save button records feedback. Proposals carry arbitrary semantic JSON plus a readable summary (64 KiB maximum). Canvas-generated image snapshots can travel as data URI values. The dependable text-answer/reject-with-reason controls remain outside the document.

Text/select (`text-v1`) and image comparisons (`comparison-v1`) are convenience renderers, not a finite limit on presentation design. Unsupported kinds retain their data and show a readable fallback. `GET /api/nodes/{id}/presentation` serves the captured authored document with sandbox/CSP headers; `GET /api/nodes/{id}` always returns the readable record.

The opaque sandbox has no ambient host DOM, model credentials, filesystem, or fetch capability. See README for isolation limits; arbitrary external effects would need explicit backend capabilities.

## Read the tree or a node

```sh
curl -s http://127.0.0.1:4310/api/tree
curl -s http://127.0.0.1:4310/api/nodes/NODE_ID
```

Tree returns `{nodes: [...]}` with structural summaries: `id`, `parentId`, title, `expectsAnswer`/status, author, timestamps, response intent, and whether a presentation exists. It currently returns the whole outline without a depth cap.

Read returns `{node, ancestors, children, counts, url}`. Children are direct children; each can be read/zoomed independently. A node carries body, captured presentation, and optional response identity/context. Counts cover the subtree. There is no fixed project → thread → question level.

## Respond; the saved result is another node

```sh
curl -s http://127.0.0.1:4310/api/nodes/NODE_ID/respond \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: human-response-1' \
  -d '{
    "body": "Keep the wide silhouette, but soften the movement.",
    "author": {"name": "Scott"},
    "selections": [{"id": "study", "label": "Wide silhouette", "value": {"spread": 72}}]
  }'
```

The default response intent is `answer`; ordinary replies only need `body`. Returns the saved response’s node/context plus `responseId`, `target`, and `deduplicated`. A response captures the target presentation revision, written content, labeled values, and author/time. It becomes a child of the target node. Any later thread can use that response ID as `parentId`.

Selection `value` is JSON, not a mandatory form schema. The reference website displays self-contained raster/SVG data images under `image`, `snapshot`, or `questionImage` as pictures, and a string `notes` separately from the bounded JSON preview. These are optional viewer conveniences; other values remain saved unchanged. Capture an important generated/drawn/arranged state explicitly instead of assuming replaying an interactive document proves what someone saw.

Responses may also provide their own `presentation: {kind: "html-v1", html, fallback}`. Question and answer surfaces share the authored-presentation boundary.

| Response intent | Target answer-request state | Meaning |
| --- | --- | --- |
| `answer` | `answered` | Input given; sibling questions are unaffected. |
| `clarification` | `waiting_on_team` | Human asked back, not approval. |
| `defer` | `deferred` | Intentionally postponed; later responses remain possible. |
| `reject` | `rejected` | Rejected with written reason. |
| `team_reply` | `outstanding` | Team addressed an ask-back and requests input again. |

Rejection, clarification, and team reply need written context. Answers need text, values, or an authored presentation; deferral can be empty. `team_reply` explicitly targets a waiting-on-team request; adding unrelated children never clears that responsibility. The response payload's `kind` describes the action, not a node type. A response can also set `expectsAnswer: true`: saved response context and an answer request can coexist on the same node. Responding to a node without an answer request records discussion without inventing one. Earlier responses remain readable.

## Optionally block the normal question call

Add `wait: {timeoutMs: 120000}` to **the same `/api/ask` call**. Publication is durable immediately; the HTTP response remains open until a human answers/rejects/asks back/defers or the timeout expires.

```json
{
  "published": {"node": {}, "ancestors": [], "url": "/threads/..."},
  "outcome": "answer",
  "response": {"id": "node_...", "body": "...", "response": {}},
  "timedOut": false
}
```

Timeout returns `outcome: "pending"`, `response: null`, `timedOut: true`, with the saved publication context. Maximum wait is 120 seconds per connection. Client abort/disconnect only releases the waiter. The question and any later response remain recoverable. Retry with the same publish key to recover the existing question and wait again; an already-present current-turn human response returns immediately. A subsequent team reply reopening the question does not cause a waiter to consume the prior human turn again.

## Live updates and reconnect catch-up

```sh
curl -N 'http://127.0.0.1:4310/api/stream?after=0'
curl -s 'http://127.0.0.1:4310/api/events?after=0'
```

SSE sends `event: change`, `id: <sequence>`, and `data: <full durable event JSON>`. Events have stable ID, increasing sequence, type, affected identity/context, and timestamp. They become visible only after the associated domain write commits. Reconnect with `Last-Event-ID` or `after` to replay missed events. `/api/events` returns up to 100 at a time; advance to the last sequence. SSE drains replay pages and then listens for committed changes.

Stable payload fields for session watches:

| Event type | Payload | Meaning |
| --- | --- | --- |
| `node.created` | `nodeId`, `parentId` | Created leaf and its direct parent (or `null`). |
| `response.created` | `questionId`, `responseId`, `kind` | Target node, saved child node, and response intent. |

`questionId` is a historical name for the target ID, not a node type; replies can target any node. Additional fields/event types may appear without changing these meanings. Idempotent retries recover receipts without appending duplicate events. An event is a committed change signal; read the referenced node for its captured content.

Subscriptions/waits are live transport, not the only copy of a response. No Pi session or website owns persistence. Notification acknowledgements/exactly-once external actions are not claimed.

## Independent UIs and failures

The API does not require or import a website. Optional static hosting is injected by the launcher. `public/client.js` is a rendering-independent HTTP client. Separately hosted browser UIs need their origin listed in `THREADROOM_UI_ORIGINS`; localhost/127.0.0.1 port4311 is permitted by default. CORS/preflight is explicit, and unrelated browser writes fail safely.

`400`: invalid input; `403`: disallowed browser write origin; `404`: missing record; `409`: ambiguous path or mismatched idempotency key; `413`: JSON body exceeds 5 MB. Failures carry `{error}`. A lost connection is ambiguous: reuse the same key for unchanged publication/response content. No alternate authoritative store is created when disconnected.

The initial `/api/threads` and `/api/questions/{id}/responses` endpoints remain adapters over the same recursive records, so the first-spike clients and retry receipts still work. New clients use `/api/nodes`, `/api/ask`, and `/api/stream`.
