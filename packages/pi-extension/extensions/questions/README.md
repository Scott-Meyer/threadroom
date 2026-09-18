# Private questions in Pi

A question can need an answer now, or leave the AI free to keep working. This owned SDK-based surface makes both visible in the same flat input-area tabs without changing those execution contracts. Blocking questions take default priority; other arrivals preserve the current draft. Suggestions stay visible during writing, and clearing the reply restores choice selection.

This is a fresh implementation. The existing questionnaire informed the experience, but is neither a dependency nor implementation source. Copied experiments under `.pi/` are historical evidence, not this module.

## Explicit composition

`registerPrivateQuestions(pi)` registers our blocking `ask_user_question` and nonblocking `ask_user_question_async` once. It does not install resources or connect to Threadroom. The package MAIN uses this composition; loading it alongside another producer with the same name would be duplicate wiring. Preparing that entry point does not reload or change the resources of a running Pi session.

Ordinary prompts and saved answers remain in the original Pi session/branch. Threadroom's optional shared discussion tools are a separate lane.

In the conversation stream, cyan question cards and violet reply cards use authored titles and identity-based references to connect each exchange. Literal role labels remain readable without color. Operational echoes stay compact; expanding reveals full literal text and structured reply details. “Private” describes the Pi-local audience, not encryption, retention or delivery confirmation; warning/error colors describe actual reported failures rather than the asking or answering role.

The public `index.ts` also exposes the model, view, inline host, blocking producer and domain types for independent consumers. The host accepts question groups: blocking callers await their own outcome, while an async source owns saving through its commit callback. Completion of that callback means persistence, not AI consumption. Question/option indices retain authored identity even when labels duplicate or tabs reorder.

## Interaction and ownership

Tab/Shift+Tab navigate individual questions, group-local review and an explicit Chat stop. In Chat, they return to questions only while the editor is empty and no autocomplete is showing; with a draft or completion menu, native completion and thinking-level keys remain unchanged. Ctrl+] returns to the selected question without rewriting the Chat draft. Chat is offered only when public editor inspection and terminal-input hooks support safe reentry; disabling the configured collapse/reentry key also removes the Chat stop. Up/Down retain their choice/text behavior.

Partial blocking submission retains live checks and notes; cancel affects only that group. Notes use Alt+N where supported, not printable `n`. Our native async source does not offer notes because its persisted answer contract is reply text and optional chosen-option identity.

Escape pauses async questions without declining them. `/asks` reopens pending native questions. Collapsing gives the ordinary editor its focus and preserves question drafts. It requires the public terminal-input hook for reopening from that editor; hosts without it keep the question expanded and can still pause it. Configured SDK external-editor actions edit the original field through a private temporary file, restore the TUI and sanitize the replacement. UI detachment, shutdown and tool abort are not human Cancel.

Draft editor state belongs to a question incarnation, so reordering retains caret/undo/notes while a new request reusing IDs cannot inherit them. Retired focus falls through to the current mounted owner/editor. Foreign prompts keep their focus.

## Evidence boundary

Saved/pending truth is independent of UI health. A failed projection or reveal does not undo persistence; a queued send is not a receipt. Real sessions, controlled callbacks, synthetic SDK/TUI tests, physical input, provider consumption, post-exit disk receipts and human acceptance are different evidence.

The SDK can mutate its branch before a failed disk write. Private append failures that changed that branch are therefore **storage unconfirmed**, not answers we can deliver. The backend excludes failed entry identities and blocks further private writes/delivery on that manager/session, including after `/reload`. Persisted feedback receipts also require a complete row in the public SDK session file; memory-only hosts make no disk assertion. A refusal before branch mutation remains retryable. This is fail-closed handling, not SDK journal rollback or repair: recover the original journal before continuing, and preserve/copy the retained draft before any process replacement.

The current runtime passed independent source and extracted-package physical checks for normal saving, external editing, priority, partial review, reload and bounded original-session recovery. Storage uncertainty, draft retention and before-startup transcript rendering were checked separately through the real SDK and actual filesystem failures. Normal-path physical runs did not inject disk failures. No SDK journal repair, hard-crash durability, exactly-once AI action, human acceptance or production activation is claimed here.
