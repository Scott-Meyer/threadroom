# Threadroom HTTP API — local spike

Base URL: `http://127.0.0.1:4310`. Requests and results are JSON. This first contract is unauthenticated and for local single-user use only.

## Publish a review

```sh
curl -s http://127.0.0.1:4310/api/threads \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Lantern interaction",
    "project": "MistFall",
    "author": {"name": "UI teammate", "role": "Interaction designer"},
    "summary": "First pickup should feel different from later pickups.",
    "question": {
      "prompt": "Should the first lantern pickup pause for a breath?",
      "context": "Both animation timings are ready to try.",
      "presentation": {
        "kind": "text-v1",
        "revision": "pickup-r1",
        "choices": ["Immediate", "Pause once, then immediate"]
      }
    }
  }'
```

Returns `201` with `{ "thread": ... }`. A thread carries stable `id`, `project`, author, timestamps, counts, and full questions. Each question carries its own ID, status, prompt, context, captured presentation/revision, and responses. `questions: [...]` can replace `question` to publish several related questions together.

The website address is `/threads/{thread.id}`. Publishing does not wait for a human answer.

### Image comparisons

A convenience presentation uses `kind: "comparison-v1"` and `options` containing `{ id, label, detail, image, alt }`. The included images are available under `/assets/`. This is one renderer, not the conversation schema: other presentation kinds can be retained as records and currently show a fallback. No custom scripts are executed.

## Read and browse

```sh
curl -s http://127.0.0.1:4310/api/threads/thr_mist-creature
curl -s 'http://127.0.0.1:4310/api/threads?view=needs-answer'
curl -s 'http://127.0.0.1:4310/api/threads?view=history'
```

A read returns `{ thread }`. Browse returns `{ threads: [...] }` with bounded per-thread summaries/counts. Views: `needs-answer`, `waiting-on-team`, `deferred`, or `history` (all threads).

## Respond

```sh
curl -s http://127.0.0.1:4310/api/questions/QUESTION_ID/responses \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: unique-response-attempt-id' \
  -d '{
    "kind": "answer",
    "body": "Pause on the first pickup only. Keep later interactions quick.",
    "author": {"name": "Scott"},
    "selections": [{"id": "pause-once", "label": "Pause once, then immediate"}]
  }'
```

Returns `{ thread, responseId, deduplicated }`. The saved response carries written feedback, labeled selections, author, timestamp, question identity, and presentation revision. Repeating the same key for the same response recovers the existing response (`200` instead of `201`); using it for different content or a different question returns `409`. Other write operations do not yet offer retry deduplication.

`kind` determines the targeted question’s state:

| Kind | Question state | Meaning |
| --- | --- | --- |
| `answer` | `answered` | Input provided; does not answer other questions. |
| `clarification` | `waiting_on_team` | Human asked back; not approval. |
| `defer` | `deferred` | Intentionally postponed, still recoverable. |
| `reject` | `rejected` | Request/direction rejected, not selected. |
| `team_reply` | `outstanding` | Team addressed an ask-back; human input is requested again. |

Answers need text or a selection. Clarification, rejection, and team replies need written context; deferral can be empty. Earlier responses remain in the record. Display names are not authenticated identities in this spike.

A teammate uses the same response endpoint with `kind: "team_reply"`, written `body`, and its own author label. This explicitly targets a question `waiting_on_team` and returns it to the human’s answer queue. Adding an unrelated follow-up does not clear the team’s responsibility.

## Add a same-thread follow-up

```sh
curl -s http://127.0.0.1:4310/api/threads/THREAD_ID/questions \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Follow-up: should the lantern light bloom before the pickup completes?",
    "context": "The original timing feedback remains below this new question.",
    "presentation": {"kind": "text-v1", "revision": "bloom-r1"}
  }'
```

Returns `201` with `{ thread }`. The new question has independent `outstanding` state. It does not replace the original presentation or answer.

## Catch up on saved events

```sh
curl -s 'http://127.0.0.1:4310/api/events?after=0'
# Optional: &threadId=THREAD_ID
```

Returns `{ events: [...] }`, at most 100 at a time. Each event has stable `id`, increasing `sequence`, `threadId`, type, payload, and timestamp. Advance `after` to the last received sequence. Thread creation, follow-up creation, and response creation are recorded atomically with their domain write. This is catch-up, **not live notification delivery**.

## Failure contract

Invalid inputs return `400`; cross-origin browser writes return `403`; missing records return `404`; mismatched idempotency retries return `409`; oversized JSON bodies return `413`. Failure results carry `{ error }`. A connection loss is ambiguous, so response clients can retry with the same idempotency key. If the service is unavailable, no other authoritative store is silently created.
