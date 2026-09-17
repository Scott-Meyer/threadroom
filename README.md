# Threadroom

A lasting place for questions, visual reviews, answers, and follow-ups between people and AI teammates. The conversation stays readable after the original session is gone.

## Try the first spike

Requires **Node 24+**. No packages or external services to install.

```sh
npm start
# http://127.0.0.1:4310
```

Open the Mist creature review, pick a silhouette or ignore the offered choices, and write a response. **Ask back**, **Defer**, and **Reject** are distinct from answering. Add a **Follow-up** to the same thread, then open **All history** to revisit what was shown and saved.

The initial art, authors, and fog conversation are illustrative demo content. New reviews and responses go through the same HTTP API a programmatic client uses.

## What persists

Records live in `data/threadroom.sqlite`; questions capture their presentation and revision, and each response retains its association to that question/revision. Restarting the process does not reset the discussion. The demo is seeded only into an empty database.

`THREADROOM_DB`, `PORT`, and `HOST` override the defaults. `npm run dev` restarts the server when source changes. The server is independent of Pi and FlightDeck, but the current **local host must be awake and the process running**. There is no offline write queue or alternate private store.

## Public boundary

See [API.md](API.md) for publish, read, respond, follow-up, and event-catch-up examples. A generic HTTP client can retrieve the complete saved question, presentation, and responses.

```sh
npm test
```

The consumer-boundary check publishes two questions through HTTP, answers one, retries without duplication, restarts the service, and recovers the presentation and answer with the other question still outstanding.

## Deliberate spike limits

This is loopback-only, single-user software **without authentication or project permissions**. Display names are labels, not verified identities; do not expose it publicly yet. The GitHub repository is private.

Presentations currently support text and an image-comparison convenience format. Unknown presentation kinds fall back to the reliable response path. Arbitrary authored executable UI, asset upload/access policy, live subscriptions, notification delivery, and Pi/FlightDeck adapters are not implemented. The presentation kind/revision boundary is intentionally separate from conversation records rather than a commitment to a fixed form grammar.

The included images are durable repository assets, not transient artist files. Google Fonts are optional visual enhancement; system fallbacks work without them. Browser drafts keep written text locally, but attachments and cross-browser draft recovery are not available yet.
