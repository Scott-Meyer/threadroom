# Threadroom

A lasting, recursively nestable place for people and AI teammates to bring work, ask questions, answer, and branch the discussion—even from an answer. The conversation outlives the session that started it.

## Run it

Requires **Node 24+**, with no packages to install.

```sh
# Separate processes: the website is just an HTTP API client.
npm run api  # http://127.0.0.1:4310
npm run ui   # http://127.0.0.1:4311
```

Or `npm start` serves the API and website together on `4310` for convenience. The backend doesn't require the website. Multiple UIs can consume the same records without database access.

## Try the direction

The outline follows [Workflowy's expand/zoom distinction](https://workflowy.com/help/navigate-around): chevrons expand children; bullets zoom into a branch; breadcrumbs navigate back. Everything is the same node—no root/project/question/answer node types. A node may ask for an answer, carry saved response context, or do both. Placement only records its parent. **Branch here** works at any depth.

```sh
node examples/publish-canvas.js
```

This makes one API call to resolve/create `MistFall → Creatures → Mist creature → Procedural studies`, publish a question, and capture its authored interactive document. Tune/generate an illustrative image, propose it, then save written feedback or reject through the separate Threadroom controls. Saved parameters and PNG snapshot remain readable without running the canvas. Questions **and answers** can carry authored canvases.

To try a normal question call that waits for your response:

```sh
node examples/ask-and-wait.js
```

It appears live in **Needs your answer**. Respond on the website; the CLI receives the saved reply. A timeout leaves the question available. Rerunning recovers the same example question; set `ASK_KEY` to start a fresh one.

The MistFall art, authors, fog discussion, and explicitly marked browser-check responses are demo content, not real team approvals. The Threadroom feedback request is a real question for Scott.

## Backend contract

Ordinary use stays ordinary: `room.ask({project: 'MistFall', question: 'Which direction?'})`, then `room.reply(questionId, {body: 'Keep the wide silhouette.'})`. Project/conversation names are conveniences, not fixed tiers. Deeper `path` or `parentId` addressing is there when needed.

[API.md](API.md) covers one-call deep publication, reads, responses, event subscriptions, catch-up, and optional blocking asks. A question can return immediately or keep its HTTP call open until a human responds. Timeout/cancellation releases the waiter, not the question.

Records and captured presentation content live in `data/threadroom.sqlite`. Restarting either UI or API does not erase them. The first-spike records migrate to recursive nodes with their IDs, presentations, responses, and retry receipts preserved. No offline writes or divergent fallback store are invented when the backend is unavailable.

Useful configuration:

- `THREADROOM_DB`, `PORT`, `HOST`: backend defaults are `data/threadroom.sqlite`, `4310`, and loopback.
- `THREADROOM_SERVE_UI=0`: API-only process (`npm run api` sets this).
- `THREADROOM_API_URL`, `UI_PORT`: independent website defaults are API `http://127.0.0.1:4310` and UI port `4311`.
- `THREADROOM_UI_ORIGINS`: comma-separated allowed browser origins. Defaults permit the independent localhost/127.0.0.1 UI on `4311`; configure this when adding another UI.

The public browser client is `public/client.js`; it has no rendering or persistence dependencies. Website hosting is separate from API/domain behavior. The current host still needs to be awake and both chosen processes need to run.

## Evidence

`npm test` exercises the public HTTP boundary: restart recovery, independent question state, response retries, clarification/team-reply lifecycle, one-call 25-deep nesting, branching from an answer, mixed request/response capabilities on the same node, live delivery to a blocking ask, timeout recovery, first-spike and typed-spike migration, and an independently hosted UI/API pair with authored question/answer records.

Actual-browser evidence additionally includes the image generator, proposal-versus-save distinction, a captured generated snapshot, and a question branched directly from the saved answer. A real CLI call also stayed waiting while its question arrived without a page refresh, then received the exact host-saved demo reply.

## Spike limits

This is **local single-user software without authentication or permissions**. Author names are labels, not verified identities. The GitHub repo is private; don't expose the service publicly yet.

Authored HTML/CSS/JS runs in an opaque sandbox. It can propose semantic JSON to the host, not submit an answer or access host DOM/credentials. CSP restricts fetches, forms, external resources, and workers; the embedding UI restricts frame destinations. This is not hard CPU/process isolation. Readable fallback and host text-answer/reject controls remain outside authored content. Model/image-generation services would require explicit capabilities, not ambient credentials; the demo generates images procedurally in its own canvas.

The tree supports arbitrary nesting but currently loads the whole outline; large-tree paging, moves/edits/deletion, production access control/hosting, notification acknowledgements, and Pi/FlightDeck adapters remain future work. Browser drafts retain text, proposed values, authored reply source, and retry keys locally. Google Fonts are optional; system fallbacks work offline.
