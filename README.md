# Threadroom

A lasting, recursively nestable place for people and AI teammates to bring work, ask questions, answer, and branch the discussion—even from an answer. The conversation outlives the session that started it.

## Run it

Requires **Node 24+**, with no packages to install.

```sh
npm start    # API + website at http://127.0.0.1:4310

# Or separate processes: the website is just an HTTP API client.
npm run api  # http://127.0.0.1:4310
npm run ui   # http://127.0.0.1:4311
```

The Pi adapter’s shared Threadroom lane is off by default. After it is enabled for the computer or a trusted project, the adapter can start the bundled combined service lazily on its first shared operation. Private Pi questions do not need or start it. The backend doesn't require the website, and multiple UIs can consume the same records without database access.

## Try the direction

The outline follows [Workflowy's expand/zoom distinction](https://workflowy.com/help/navigate-around): chevrons expand children; bullets zoom into a branch; breadcrumbs navigate back. Sidebar attention views remain global, so zooming into one discussion doesn't hide incoming questions elsewhere. Everything is the same node—no root/project/question/answer node types. A node may ask for an answer, carry saved response context, or do both. Placement only records its parent. **Branch here** works at any depth.

```sh
node examples/publish-canvas.js
```

This makes one API call to resolve/create `MistFall → Creatures → Mist creature → Procedural studies`, publish a question, and capture its authored interactive document. Tune/generate an illustrative image, propose it, then save written feedback or reject through the separate Threadroom controls. Saved parameters and PNG snapshot remain readable without running the canvas. Questions **and answers** can carry authored canvases.

For a collection of clearly labeled interaction tests—moving/keyboard scenes, overlapping objects, multi-select, picture choices, drawing, and three nested questions—run `node examples/playground/publish.js`. [Playground instructions](examples/playground/README.md) cover proposing values, adding notes, and using the separate host Save controls.

To try a normal question call that waits for your response:

```sh
node examples/ask-and-wait.js
```

It appears live in **Needs your answer**. Respond on the website; the CLI receives the saved reply. A timeout leaves the question available. Rerunning recovers the same example question; set `ASK_KEY` to start a fresh one.

The MistFall art, authors, fog discussion, and explicitly marked browser-check responses are demo content, not real team approvals. The Threadroom feedback request is a real question for Scott.

## Backend contract

Ordinary use stays ordinary: `room.ask({project: 'MistFall', question: 'Which direction?'})`, then `room.reply(questionId, {body: 'Keep the wide silhouette.'})`. Project/conversation names are conveniences, not fixed tiers. Deeper `path` or `parentId` addressing is there when needed.

[API.md](API.md) covers one-call deep publication, reads, responses, event subscriptions, catch-up, and optional blocking asks. A question can return immediately or keep its HTTP call open until a human responds. Timeout/cancellation releases the waiter, not the question.

The checkout scripts store records and captured presentation content in `data/threadroom.sqlite`; the packaged/managed service defaults to the platform’s stable per-user Threadroom data directory. Restarting either UI or API does not erase them. The first-spike records migrate to recursive nodes with their IDs, presentations, responses, and retry receipts preserved. No offline writes or divergent fallback store are invented when the backend is unavailable.

Useful configuration:

- `THREADROOM_DB`, `PORT`, `HOST`: backend defaults are `data/threadroom.sqlite`, `4310`, and loopback.
- `THREADROOM_SERVE_UI=0`: API-only process (`npm run api` sets this).
- `THREADROOM_API_URL`, `THREADROOM_UI_URL`, `UI_PORT`: independent website defaults are API `http://127.0.0.1:4310` and UI port `4311`; the adapter’s website link defaults to its API address. An explicit API URL tells the Pi adapter the service is externally owned and disables its local auto-start.
- `THREADROOM_UI_ORIGINS`: comma-separated allowed browser origins. Defaults permit the independent localhost/127.0.0.1 UI on `4311`; configure this when adding another UI.
- `/threadroom`: opens the Threadroom menu for status, watched discussions, and configuration. Configuration can be computer-wide or override it for the current trusted project. Run `/reload` after changing it.
- `THREADROOM_AUTO_START=0`: after the shared lane is enabled, disables the Pi adapter’s managed local startup without assigning a different API URL.

The public browser client is `public/client.js`; it has no rendering or persistence dependencies. Website hosting is separate from API/domain behavior. Independently launched modes follow their own foreground/supervisor lifetime; the adapter’s detached managed service survives the Pi process that started it.

## Independent service package — optional

`npm pack --workspace threadroom-service` produces a private Node 24+ bundle of the API, website, and their resources—without Pi, a checkout database, or runtime dependencies. [Service instructions](packages/service/README.md) explain stable per-user storage, explicit database/URL selection, and review-only macOS supervisor configuration.

Run it from an independent terminal or a separately approved supervisor, not a Pi-owned background task: Pi reload/shutdown terminates those tasks. Nothing has been installed or activated, and the existing checkout database is not automatically copied or adopted. Threadroom remains an explicit optional discussion lane, not a prerequisite for native Pi asking.

## Pi integration — local spike

The independent [`packages/pi-extension`](packages/pi-extension/README.md) workspace now exposes expressive questions and ordinary thread participation to Pi. Public-boundary checks cover asynchronous publication, optional waiting/cancellation, saved response provenance, replay/restart recovery, and bounded readable receipts. The real Pi loader accepts both source and packed distribution. An actual Pi RPC/Gemini session published an authored comparison, continued independently, went idle, woke on saved automated feedback, and persisted the correlated reply in its transcript. The adapter consumes the HTTP API, not the database or website; service/UI remain independent.

This is opt-in and unreleased. The prepared Pi entry point uses our fresh-owned question surface: flat input-area tabs, blocking priority, retained drafts, and group-local review. `ask_user_question` waits by default, matching the familiar questionnaire contract. Setting `blocking: false` returns immediately with stable pending identities; passing one back to the same tool as the sole `{ questionId }` entry in `questions` later waits on that still-pending private question. `/asks` reopens paused questions. Other producers of the ordinary ask name must be excluded before loading it. Preparing the source does not activate a running seat or change global settings. Shared `threadroom_ask` and `threadroom` are inactive until the `/threadroom` menu enables them; native prompts/replies are never published to Threadroom or its shared outline. Authentication, evolving live presentations, FlightDeck, and an alternative terminal UI remain unfinished. `npm run pi:pack:check` builds and inspects the standalone adapter distribution, including its local service runtime.

## Evidence

`npm test` exercises the public HTTP boundary: restart recovery, independent question state, response retries, clarification/team-reply lifecycle, one-call 25-deep nesting, branching from an answer, mixed request/response capabilities on the same node, live delivery to a blocking ask, timeout recovery, first-spike and typed-spike migration, and an independently hosted UI/API pair with authored question/answer records.

Actual-browser evidence additionally includes the image generator, proposal-versus-save distinction, a captured generated snapshot, and a question branched directly from the saved answer. A real CLI call also stayed waiting while its question arrived without a page refresh, then received the exact host-saved demo reply.

A combined HTTP/Node participation check covers replacement-colleague recovery: after service restart, a same-name/new-session participant reads without inheriting watches, explicitly adopts the old review, and continues its clarification. Feedback on newer pass B neither clears pass A's responsibility nor rewrites its captured presentation. This is isolated synthetic consumer evidence, not an actual replacement Pi session, FlightDeck seat, or authenticated handoff.

## Spike limits

This is **local single-user software without authentication or permissions**. Author names are labels, not verified identities. The GitHub repo is private; don't expose the service publicly yet.

Authored HTML/CSS/JS runs in an opaque sandbox. It can propose semantic JSON to the host, not submit an answer or access host DOM/credentials. CSP restricts fetches, forms, external resources, and workers; the embedding UI restricts frame destinations. This is not hard CPU/process isolation. Readable fallback and host text-answer/reject controls remain outside authored content. Model/image-generation services would require explicit capabilities, not ambient credentials; the demo generates images procedurally in its own canvas.

The tree supports arbitrary nesting but currently loads the whole outline; large-tree paging, moves/edits/deletion, production access control/hosting, notification acknowledgements, production adapter hardening, FlightDeck integration, and an alternative terminal UI remain future work. Browser drafts retain text, proposed values, authored reply source, and retry keys locally. Google Fonts are optional; system fallbacks work offline.
