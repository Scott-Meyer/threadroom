# Threadroom for Pi

Bring someone a question, an experiment, or an interaction you designed—and let the discussion outlive this chat turn. Plain text is enough. A self-contained HTML/CSS/JS document can be a canvas, prototype, comparison, or something we haven't anticipated.

Threadroom is the optional shared, longer-lived asking lane. The first-release direction keeps ordinary blocking and non-blocking asks in Pi, local to its transcript and outside the Threadroom API/discoverable outline. Native async asking is not implemented here yet. This is a working local spike, not a released replacement for your installed questionnaire.

## Try it

Run the independent Threadroom API and website first. From this repository, load the extension explicitly:

```sh
pi --no-extensions -e ./packages/pi-extension/extensions/index.ts
```

That isolates the trial from existing extensions. For a normal installation, `pi install ./packages/pi-extension` works alongside `@juicesharp/rpiv-ask-user-question`: Threadroom uses `threadroom_ask`, leaving the existing blocking `ask_user_question` alone. Installation does not start the service. The packed package contains only this adapter, not the website, database, or reference source.

Configuration uses environment variables:

- `THREADROOM_API_URL`: defaults to `http://127.0.0.1:4310`.
- `THREADROOM_UI_URL`: defaults to `http://127.0.0.1:4311`, or the configured API address when one is supplied. Set it separately for an independently hosted website.
- `THREADROOM_REPLACE_ASK=1`: an experimental API-backed alias, not the native first-release default. It explicitly registers the rich tool as `ask_user_question` instead. Disable/remove the old questionnaire before choosing this mode; the input contract is different. Coexistence is the default for the first beta.

The current service is single-user and unauthenticated. Keep it local or use a trusted tunnel; author/session metadata is correlation, not permission. No production identity or authorized handoff claim is made here.

## Participation

`threadroom_ask` publishes a plain question or authored interaction in one call and watches its replies in this session. It returns immediately unless `waitMs` is supplied. There is no required options list, header, or form layout. The optional replacement mode changes the old tool's input contract; it is not a drop-in questionnaire-schema emulator.

`threadroom` covers ordinary contributions and replies, readable history, outline browsing, direct-node watches, and waiting on an existing question. Discussions can branch beneath any node, including an answer. Watches cover direct replies; a deeper branch can have its own watch. `/threadroom` shows the chosen API/website addresses, connectivity, and local participation. Connection errors also identify those endpoints; the adapter never starts the service.

Pi shows readable questions, saved reply intent, and durable discussion links—not raw authored programs or JSON envelopes. Expanded views reveal more history and receipt identity. Saved text is literal terminal text, not executable controls or Markdown. The full machine-facing records remain unchanged.

Action results carry durable identities/links, saved status, provenance, and a small view of this session's watches. Large authored source and image values stay at their saved API address instead of being echoed into every turn. Browsing currently filters the full service outline locally and returns at most 50 matches; this isn't a server search/paging implementation.

## What a reply means

Later saved feedback enters the originating Pi session as a custom message. Busy agents receive it at Pi's next safe steering boundary; idle agents can wake. Delivery pauses around compaction and resumes afterward. During tree navigation/summarization it preserves the old watch without waking on the outgoing branch. Because Pi lacks a cancel/failure completion event there, a deferred receipt owns a small idle recheck timer; success rebinds the chosen branch, while cancellation/failure releases the gate when the host becomes idle. A clarification, rejection, or deferral retains its own meaning—it isn't silently turned into approval.

Service events replay on reconnect. Adding a watch currently replays from the beginning, and an unsequenced answer found by a wait conservatively holds the checkpoint there until its transcript receipt exists. That trades transport work for recovery safety; scoped per-watch replay is future scalability work. Local checkpoints remember watched IDs and a safe replay position; they don't become another conversation database. A queued Pi message does **not** advance past an unconfirmed response. Only a corresponding persisted transcript receipt does. Reload reconciles receipts, so an interrupted checkpoint doesn't require asking the person again. The current host does not reliably expose whether a custom steering queue was discarded or remains queued after abort. The adapter therefore does not guess and resend during the same runtime; reading/waiting or a session reload recovers unpersisted feedback. This is not an exactly-once guarantee for whatever an agent does afterward.

Wait results carry the request snapshot that established the outcome, not the original outstanding state beside a saved answer. Timeouts carry the last completed wait read, or the publication snapshot if no read completed; later changes remain readable. Timeout (maximum 120 seconds) and cancellation release the wait, not the question or watch. Connection failure is explicit; an ambiguous write returns a retry key for unchanged content. Reading an old discussion does not automatically inherit its original session's subscription. Forked sessions don't inherit live watches merely by copying a transcript; they can adopt a node explicitly.

## Boundaries and next slice

Threadroom owns saved conversations and presentation isolation. Authored scripts can propose drafts, but host controls own saving feedback. Pi owns session participation and model-message delivery. Neither side grants generated content filesystem, terminal, or model credentials.

The transport and participation modules under `src/` have no Pi or rendering imports. Another host can use them without implementing a Pi TUI. A future terminal UI can consume the same service; its integration point remains open.

Captured presentations are immutable today. An evolving job dashboard or two-way live workspace needs an explicit service capability, not a hidden local server or a Pi-only conversation store. Hard CPU isolation, authentication, remote deployment, large-history scalability, notification preferences, and broader host lifecycle evidence remain unfinished.
