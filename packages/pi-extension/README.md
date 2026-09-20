# Native asking and optional Threadroom for Pi

Keep everyday questions in Pi, and bring a discussion to Threadroom when it should be shared and outlive this seat. This package owns both blocking `ask_user_question` and nonblocking `ask_user_question_async`, using one flat input-area surface. It is a fresh SDK implementation, not a fork or dependency of another questionnaire, and remains an unreleased local beta.

## Private questions

Blocking questions take priority within the question pane and await only their own group. Nonblocking questions appear automatically while the AI continues working—not in a hidden inbox. Async-only arrivals leave the current input focused: use Shift+Tab or `/asks` to enter the pane. A blocker selects and focuses the same shared surface; Chat remains unavailable until every blocker is answered or cancelled, while pending async tabs remain usable beside it. Answering the last blocker keeps a remaining nonblocking question focused instead of automatically returning to Chat; cancellation still restores the blocker’s input loan. Same-priority arrivals retain the current draft; suggestions stay visible during writing, and clearing the reply restores choice selection.

`ask_user_question_async` returns a stable ID and an example `waitWith` reference. If later work depends on that same unanswered question, `ask_user_question({ questionId })` temporarily makes its existing tab required and waits for its native saved answer. It neither republishes nor recreates the question, and its original draft, choices, limits, branch identity, and persistence owner remain intact. Escape releases only the wait and returns the still-pending question to async. If its answer was already queued or received through async feedback, the wait reports that state rather than returning the answer a second time.

Use the SDK select keys to choose/confirm, type or paste a free reply, and Tab to cycle forward through question and group-review tabs. In an async-only pane, Shift+Tab selects/unselects questions while preserving both drafts; a solid border means the pane owns focus, and a dotted border means it does not. A blocker has an explicit required marker and warning border; Shift+Tab and collapse cannot leave it. Chat keeps native Tab completion when no blocker is pending. Blocking review supports partial submission, live checks, custom text and Alt+N notes; cancel affects only that group. Native async does not offer notes because its stored answer contract cannot retain them. Async previews are literal text; blocking previews support Markdown.

Escape pauses async questions without declining them or discarding their drafts; with a blocker pending, that returns to a required tab rather than Chat. `/asks [id]` selects pending questions. Collapse is available only without a blocker and returns to the exact input that lent focus, while it remains mounted. The extension never guesses a replacement from editor methods, classes or text. Normal SDK dialog events suppress question focus while another prompt is active; an established modal loan also recognizes its exact stock input. Hosts with optional public `ui.getCoreEditor()` identity can distinguish Chat from unannounced foreign prompts. A blocker returns to its exact modal loan; actually reclaiming an authoritative replacement or explicit stock `/asks` refreshes that loan, while an overlapping unannounced prompt defers the return without losing it. Normal Pi needs no SDK patch. Configured external-editor actions edit the original field and restore the TUI afterward.

Private prompts and answers remain in the original Pi session/branch, never Threadroom’s API or discoverable outline. Saved native feedback retains its original prompt and answer identity, then steers a busy agent at a legal boundary or wakes an idle one. A closed Pi cannot be woken by this extension, and copied/forked different-session histories do not inherit ownership. Native async requires interactive TUI. Blocking questions also support SDK RPC/ACP dialogs; unsupported hosts and aborts are not human declines.

All private admission closes as soon as Pi announces a switch, fork, tree change, or compaction. Positive lifecycle events reopen it; idle time is not treated as transition completion. Stock Pi does not report a cancelled or failed switch, fork, or tree transition back to extensions, so that rare outcome stays fail-closed: after the transition command itself has returned, use `/reload` and then `/asks`. This reload guidance is only presentation-lifecycle recovery—`/reload` never repairs storage uncertainty.

Saving an answer, queueing feedback and recording its consumption receipt are different outcomes. Process-local submission IDs prevent blind resend across extension reload; they are not durable receipts. Cold recovery can replay unreceipted feedback, so subsequent AI work is not exactly-once. `/asks` exposes pending questions, answer identities and recovery diagnostics—do not submit again to repair delivery.

The SDK can mutate memory before a failed disk write. Native records then remain **storage unconfirmed**: further private writes/delivery are blocked on that manager/session, even after `/reload`. Feedback receipts require a complete physical session-file row; memory-only hosts make no disk assertion. A pre-append refusal without branch mutation remains retryable. Recover the original journal and preserve/copy drafts before replacing the process; do not quit/resume as a storage-error feedback retry. This guard is not SDK journal rollback or repair.

## Optional shared discussions

Threadroom can bring someone a question, an experiment, or an interaction you designed—and let the discussion outlive this chat turn. Plain text is enough. A self-contained HTML/CSS/JS document can be a canvas, prototype, comparison, or something we haven't anticipated.

The shared lane is **off by default**; private questions remain available. `/threadroom-config` opens the extension’s configuration picker. It can save a computer-wide default or, in a trusted project, an overriding project value. Command arguments are also accepted:

```text
/threadroom-config computer on
/threadroom-config computer off
/threadroom-config computer inherit
/threadroom-config project on
/threadroom-config project off
/threadroom-config project inherit
```

The durable files are `~/.pi/agent/threadroom.json` (or Pi’s configured agent directory) and `<project>/.pi/threadroom.json`. Project configuration is not read before Pi trusts that project. Missing settings inherit downward from the built-in off default. A malformed effective setting fails the shared lane closed without disabling private questions; an explicit valid trusted-project value can still override a malformed computer default, which remains visible as a warning. Run `/reload` after changing the setting. When off, shared tools are absent from the model’s active tool set, configured shared endpoints are not parsed or contacted, restored shared watches do not connect, and no managed service starts.

## Try it

Native async needs only normal interactive Pi—no Threadroom API, website or patched SDK. The stock-compatible focus refinement is still under validation; preparing it does not reload a running session. Once enabled, shared Threadroom tools lazily ensure the bundled local service unless an explicit endpoint or startup opt-out assigns that responsibility elsewhere. From this repository, load the extension explicitly:

```sh
pi --no-extensions -e ./packages/pi-extension/extensions/index.ts
```

That isolates the trial from existing extensions. For normal project loading, first exclude any other producer of `ask_user_question` or `ask_user_question_async`; do not load duplicate implementations. In a trusted project, Pi’s project package entry overrides an inherited entry with the same npm identity, so a project-local `{ "source": "npm:@juicesharp/rpiv-ask-user-question", "autoload": false, "extensions": ["-index.ts"] }` excludes that package's sole producer without changing global settings. An empty `extensions` delta does not exclude it. This is configuration guidance, not automatic installation or activation. Coordinate reload only after the ordinary editor has focus.

The packed adapter includes the local service runtime. After the shared lane is enabled, the first shared Threadroom request—or restoration of active shared watches—reuses a compatible service or starts a detached API + website at `http://127.0.0.1:4310`. Private questions alone never start it. The detached service uses stable per-user storage and survives Pi reload/shutdown. Concurrent Pi sessions share a startup lease; health checks bind compatibility to the API version, website capability, and selected database rather than adopting an unrelated port owner.

After shared Threadroom is enabled through `/threadroom-config`, runtime/service configuration uses environment variables:

- `THREADROOM_API_URL`: an explicitly owned API endpoint. Setting it disables automatic local startup, even when it names localhost. Set the literal default URL too when intentionally using a checkout/supervised service with its own database.
- `THREADROOM_UI_URL`: website address; defaults to the API address. Set it separately for an independently hosted website.
- `THREADROOM_AUTO_START=0`: keep the default endpoint but require external service ownership.
- `THREADROOM_DB`: local managed-service database. Relative values resolve against Pi’s invocation directory before the detached service changes directory; otherwise the platform’s per-user Threadroom data path is used.

The experimental `THREADROOM_REPLACE_ASK` API alias has been retired. Threadroom always uses its own tool names; a stale setting cannot redirect ordinary native asks into the shared service.

The current service is single-user and unauthenticated. Keep it local or use a trusted tunnel; author/session metadata is correlation, not permission. No production identity or authorized handoff claim is made here.

Shared tools use owned Node HTTP/HTTPS connections, not host `fetch` or its global dispatcher. This avoids the [known Undici socket-QoS crash](https://github.com/nodejs/undici/issues/5544) without changing host networking or suppressing process exceptions. No new runtime dependency is needed. Native asks still make no HTTP requests; this does not fix unrelated uses of host fetch.

## Participation

`threadroom_ask` publishes a plain question or authored interaction in one call and watches its replies in this session. It returns immediately unless `waitMs` is supplied. There is no required options list, header, or form layout. It is a separate shared capability, not an emulator of the native questionnaire schema.

`threadroom` covers ordinary contributions and replies, readable history, outline browsing, direct-node watches, and waiting on an existing question. Discussions can branch beneath any node, including an answer. Watches cover direct replies; a deeper branch can have its own watch. `/threadroom` shows the chosen API/website addresses, connectivity, and local participation. Connection errors also identify those endpoints. Enabled local use can start the bundled service; explicitly configured endpoints are only connected to, never started or replaced.

Pi shows readable questions, saved reply intent, and durable discussion links—not raw authored programs or JSON envelopes. Expanded views reveal more history and receipt identity. Saved text is literal terminal text, not executable controls or Markdown. The full machine-facing records remain unchanged.

Action results carry durable identities/links, saved status, provenance, and a small view of this session's watches. Large authored source and image values stay at their saved API address instead of being echoed into every turn. Browsing currently filters the full service outline locally and returns at most 50 matches; this isn't a server search/paging implementation.

## What a reply means

Later saved feedback enters the originating Pi session as a custom message. Busy agents receive it at Pi's next safe steering boundary; idle agents can wake. Delivery pauses around compaction and resumes afterward. During tree navigation/summarization it preserves the old watch without waking on the outgoing branch. Because Pi lacks a cancel/failure completion event there, a deferred receipt owns a small idle recheck timer; success rebinds the chosen branch, while cancellation/failure releases the gate when the host becomes idle. A clarification, rejection, or deferral retains its own meaning—it isn't silently turned into approval.

Service events replay on reconnect. Adding a watch currently replays from the beginning, and an unsequenced answer found by a wait conservatively holds the checkpoint there until its transcript receipt exists. That trades transport work for recovery safety; scoped per-watch replay is future scalability work. Local checkpoints remember watched IDs and a safe replay position; they don't become another conversation database. A queued Pi message does **not** advance past an unconfirmed response. Only a corresponding persisted transcript receipt does. Reload reconciles receipts, so an interrupted checkpoint doesn't require asking the person again. The current host does not reliably expose whether a custom steering queue was discarded or remains queued after abort. The adapter therefore does not guess and resend during the same runtime; reading/waiting or a session reload recovers unpersisted feedback. This is not an exactly-once guarantee for whatever an agent does afterward.

Wait results carry the request snapshot that established the outcome, not the original outstanding state beside a saved answer. Timeouts carry the last completed wait read, or the publication snapshot if no read completed; later changes remain readable. Timeout (maximum 120 seconds) and cancellation release the wait, not the question or watch. Connection failure is explicit; an ambiguous write returns a retry key for unchanged content. Reading an old discussion does not automatically inherit its original session's subscription. Forked sessions don't inherit live watches merely by copying a transcript; they can adopt a node explicitly.

## Boundaries and next slice

Threadroom owns saved conversations and presentation isolation. Authored scripts can propose drafts, but host controls own saving feedback. Pi owns session participation and model-message delivery. Neither side grants generated content filesystem, terminal, or model credentials.

Private question state, results and persistence are separate from terminal focus. A future attached FlightDeck presenter can become the primary UI with terminal fallback; attachment selection and handoff are not implemented in this slice.

The Node transport and participation modules under `src/` have no Pi or rendering imports. Another Node host can use them without implementing a Pi TUI. Constructing a `ThreadroomClient` allocates no agents or connections; its first request opens its own HTTP/HTTPS pool. REST deadlines include the response body; SSE stays open until its signal, stream failure, or client closure. Redirects are not followed and HTTPS retains ordinary certificate verification.

A consumer owns the client's lifetime: close its participants first, then `await client.close()`. Client closure cancels its active requests/streams and releases its sockets, is idempotent, and permanently rejects new requests; it does not affect another client. `Participation.close()` ends that subscription, not the reusable client. The Pi extension releases its outgoing client on quit/reload/session replacement, giving a replacement session a fresh lazy client. A future terminal UI can consume the same service; its integration point remains open.

Captured presentations are immutable today. An evolving job dashboard or two-way live workspace needs an explicit service capability, not a hidden local server or a Pi-only conversation store. Hard CPU isolation, authentication, remote deployment, large-history scalability, notification preferences, and broader host lifecycle evidence remain unfinished.
