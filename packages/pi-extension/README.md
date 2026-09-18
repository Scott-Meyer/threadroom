# Native asking and optional Threadroom for Pi

Keep everyday questions in Pi, and bring a discussion to Threadroom when it should be shared and outlive this seat. This package owns both blocking `ask_user_question` and nonblocking `ask_user_question_async`, using one flat input-area surface. It is a fresh SDK implementation, not a fork or dependency of another questionnaire, and remains an unreleased local beta.

## Private questions

Blocking questions take default priority and await only their own group. Nonblocking questions appear automatically while the AI continues working—not in a hidden inbox. Same-priority arrivals retain the current draft; suggestions stay visible during writing, and clearing the reply restores choice selection.

Use the SDK select keys to choose/confirm, type or paste a free reply, and Tab/Shift+Tab to navigate question and group-review tabs. Blocking review supports partial submission, live checks, custom text and Alt+N notes; cancel affects only that group. Native async does not offer notes because its stored answer contract cannot retain them. Async previews are literal text; blocking previews support Markdown.

Escape pauses async questions without declining them or discarding their drafts; `/asks [id]` reopens pending questions. Collapse returns focus to the ordinary editor while retaining question drafts, on hosts with the public terminal-input hook needed to reopen there. Foreign prompts keep focus. Configured external-editor actions edit the original field and restore the TUI afterward.

Private prompts and answers remain in the original Pi session/branch, never Threadroom’s API or discoverable outline. Saved native feedback retains its original prompt and answer identity, then steers a busy agent at a legal boundary or wakes an idle one. A closed Pi cannot be woken by this extension, and copied/forked different-session histories do not inherit ownership. Native async requires interactive TUI. Blocking questions also support SDK RPC/ACP dialogs; unsupported hosts and aborts are not human declines.

Saving an answer, queueing feedback and recording its consumption receipt are different outcomes. Process-local submission IDs prevent blind resend across extension reload; they are not durable receipts. Cold recovery can replay unreceipted feedback, so subsequent AI work is not exactly-once. `/asks` exposes pending questions, answer identities and recovery diagnostics—do not submit again to repair delivery.

The SDK can mutate memory before a failed disk write. Native records then remain **storage unconfirmed**: further private writes/delivery are blocked on that manager/session, even after `/reload`. Feedback receipts require a complete physical session-file row; memory-only hosts make no disk assertion. A pre-append refusal without branch mutation remains retryable. Recover the original journal and preserve/copy drafts before replacing the process; do not quit/resume as a storage-error feedback retry. This guard is not SDK journal rollback or repair.

## Optional shared discussions

Threadroom can bring someone a question, an experiment, or an interaction you designed—and let the discussion outlive this chat turn. Plain text is enough. A self-contained HTML/CSS/JS document can be a canvas, prototype, comparison, or something we haven't anticipated.

## Try it

Native async needs no API or website. Shared Threadroom tools need the independent API and website running. From this repository, load the extension explicitly:

```sh
pi --no-extensions -e ./packages/pi-extension/extensions/index.ts
```

That isolates the trial from existing extensions. For normal project loading, first exclude any other producer of `ask_user_question` or `ask_user_question_async`; do not load duplicate implementations. In a trusted project, Pi’s project package entry overrides an inherited entry with the same npm identity, so a project-local `{ "source": "npm:@juicesharp/rpiv-ask-user-question", "extensions": [] }` can disable that inherited producer without changing global settings. This is configuration guidance, not automatic installation or activation. Coordinate reload only after the ordinary editor has focus.

Installation does not start the service. The packed package contains this adapter and its owned question modules, not the website, database, or historical reference source.

Configuration uses environment variables:

- `THREADROOM_API_URL`: defaults to `http://127.0.0.1:4310`.
- `THREADROOM_UI_URL`: defaults to `http://127.0.0.1:4311`, or the configured API address when one is supplied. Set it separately for an independently hosted website.

The experimental `THREADROOM_REPLACE_ASK` API alias has been retired. Threadroom always uses its own tool names; a stale setting cannot redirect ordinary native asks into the shared service.

The current service is single-user and unauthenticated. Keep it local or use a trusted tunnel; author/session metadata is correlation, not permission. No production identity or authorized handoff claim is made here.

Shared tools use owned Node HTTP/HTTPS connections, not host `fetch` or its global dispatcher. This avoids the [known Undici socket-QoS crash](https://github.com/nodejs/undici/issues/5544) without changing host networking or suppressing process exceptions. No new runtime dependency is needed. Native asks still make no HTTP requests; this does not fix unrelated uses of host fetch.

## Participation

`threadroom_ask` publishes a plain question or authored interaction in one call and watches its replies in this session. It returns immediately unless `waitMs` is supplied. There is no required options list, header, or form layout. It is a separate shared capability, not an emulator of the native questionnaire schema.

`threadroom` covers ordinary contributions and replies, readable history, outline browsing, direct-node watches, and waiting on an existing question. Discussions can branch beneath any node, including an answer. Watches cover direct replies; a deeper branch can have its own watch. `/threadroom` shows the chosen API/website addresses, connectivity, and local participation. Connection errors also identify those endpoints; the adapter never starts the service.

Pi shows readable questions, saved reply intent, and durable discussion links—not raw authored programs or JSON envelopes. Expanded views reveal more history and receipt identity. Saved text is literal terminal text, not executable controls or Markdown. The full machine-facing records remain unchanged.

Action results carry durable identities/links, saved status, provenance, and a small view of this session's watches. Large authored source and image values stay at their saved API address instead of being echoed into every turn. Browsing currently filters the full service outline locally and returns at most 50 matches; this isn't a server search/paging implementation.

## What a reply means

Later saved feedback enters the originating Pi session as a custom message. Busy agents receive it at Pi's next safe steering boundary; idle agents can wake. Delivery pauses around compaction and resumes afterward. During tree navigation/summarization it preserves the old watch without waking on the outgoing branch. Because Pi lacks a cancel/failure completion event there, a deferred receipt owns a small idle recheck timer; success rebinds the chosen branch, while cancellation/failure releases the gate when the host becomes idle. A clarification, rejection, or deferral retains its own meaning—it isn't silently turned into approval.

Service events replay on reconnect. Adding a watch currently replays from the beginning, and an unsequenced answer found by a wait conservatively holds the checkpoint there until its transcript receipt exists. That trades transport work for recovery safety; scoped per-watch replay is future scalability work. Local checkpoints remember watched IDs and a safe replay position; they don't become another conversation database. A queued Pi message does **not** advance past an unconfirmed response. Only a corresponding persisted transcript receipt does. Reload reconciles receipts, so an interrupted checkpoint doesn't require asking the person again. The current host does not reliably expose whether a custom steering queue was discarded or remains queued after abort. The adapter therefore does not guess and resend during the same runtime; reading/waiting or a session reload recovers unpersisted feedback. This is not an exactly-once guarantee for whatever an agent does afterward.

Wait results carry the request snapshot that established the outcome, not the original outstanding state beside a saved answer. Timeouts carry the last completed wait read, or the publication snapshot if no read completed; later changes remain readable. Timeout (maximum 120 seconds) and cancellation release the wait, not the question or watch. Connection failure is explicit; an ambiguous write returns a retry key for unchanged content. Reading an old discussion does not automatically inherit its original session's subscription. Forked sessions don't inherit live watches merely by copying a transcript; they can adopt a node explicitly.

## Boundaries and next slice

Threadroom owns saved conversations and presentation isolation. Authored scripts can propose drafts, but host controls own saving feedback. Pi owns session participation and model-message delivery. Neither side grants generated content filesystem, terminal, or model credentials.

The Node transport and participation modules under `src/` have no Pi or rendering imports. Another Node host can use them without implementing a Pi TUI. Constructing a `ThreadroomClient` allocates no agents or connections; its first request opens its own HTTP/HTTPS pool. REST deadlines include the response body; SSE stays open until its signal, stream failure, or client closure. Redirects are not followed and HTTPS retains ordinary certificate verification.

A consumer owns the client's lifetime: close its participants first, then `await client.close()`. Client closure cancels its active requests/streams and releases its sockets, is idempotent, and permanently rejects new requests; it does not affect another client. `Participation.close()` ends that subscription, not the reusable client. The Pi extension releases its outgoing client on quit/reload/session replacement, giving a replacement session a fresh lazy client. A future terminal UI can consume the same service; its integration point remains open.

Captured presentations are immutable today. An evolving job dashboard or two-way live workspace needs an explicit service capability, not a hidden local server or a Pi-only conversation store. Hard CPU isolation, authentication, remote deployment, large-history scalability, notification preferences, and broader host lifecycle evidence remain unfinished.
