# Private questions in Pi

A question can need an answer now, or leave the AI free to keep working. This owned SDK-based surface makes both visible in the same flat input-area tabs without changing those execution contracts. Blocking questions take default priority; other arrivals preserve the current draft. Suggestions stay visible during writing, and clearing the reply restores choice selection.

This is a fresh implementation. The existing questionnaire informed the experience, but is neither a dependency nor implementation source. Copied experiments under `.pi/` are historical evidence, not this module.

## Explicit composition

`registerPrivateQuestions(pi)` registers our blocking `ask_user_question` and nonblocking `ask_user_question_async` once. It does not install resources or connect to Threadroom. The package MAIN uses this composition; loading it alongside another producer with the same name would be duplicate wiring. Preparing that entry point does not reload or change the resources of a running Pi session.

Ordinary prompts and saved answers remain in the original Pi session/branch. Threadroom's optional shared discussion tools are a separate lane.

In the conversation stream, cyan question cards and violet reply cards use authored titles and identity-based references to connect each exchange. Literal role labels remain readable without color. Operational echoes stay compact; expanding reveals full literal text and structured reply details. “Private” describes the Pi-local audience, not encryption, retention or delivery confirmation; warning/error colors describe actual reported failures rather than the asking or answering role.

The public `index.ts` also exposes the model, view, inline host, blocking producer and domain types for independent consumers. The host accepts question groups: blocking callers await their own outcome, while an async source owns saving through its commit callback. Completion of that callback means persistence, not AI consumption. Question/option indices retain authored identity even when labels duplicate or tabs reorder.

## Interaction and ownership

The question pane has a solid border while it owns input focus and a dotted border while inactive; its header contains only question/review tabs. Tab moves forward through those tabs and wraps. Shift+Tab switches between the pane and its previous input, returning to the retained selected question without rewriting either draft. Up/Down retain their choice/text behavior.

Normal Pi needs no SDK patch. Questions appear passively above the editor without stealing first focus or interrupting another input for a blocker. Shift+Tab or `/asks` explicitly enters the pane, retaining the exact previous input only as a loan origin—not proof that it is Chat. Return requires that same input to remain mounted; losing or replacing it never authorizes a guessed successor. Blockers still take priority inside an already-focused question pane. No editor factory, draft setter, class check or text probe discovers ownership.

Chat keeps native Tab completion. While questions are open, Shift+Tab is a global pane toggle; known SDK dialog spans suppress it, but unannounced custom UI may use that key for backward navigation. This is a documented shortcut tradeoff, not universal foreign-key safety. `focusToggleKey` configures or disables it; plain Tab cannot be used. `/asks` also works without the public raw terminal-input hook, including blocking-only groups. Missing return capabilities omit unsupported hints. With no questions, native keys remain unchanged. Ctrl+] is the separate optional collapse/reentry shortcut; the former Ctrl+Tab routes and Chat/Questions heading are retired.

Optional public `ui.getCoreEditor()` identity enables the stronger automatic-focus path and replacement-aware core return. It is reread at every focus boundary and checked for mount membership. Without it, the stock path remains fully admitted and uses only explicit focus loans. SDK dialog notifications help coordinate ordinary prompts but do not identify arbitrary focused components.

Partial blocking submission retains live checks and notes; cancel affects only that group. Notes use Alt+N where supported, not printable `n`. Our native async source does not offer notes because its persisted answer contract is reply text and optional chosen-option identity.

Escape pauses async questions without declining them. `/asks` selects pending async or blocking questions; automatic bind/navigation/recovery reveal never grants stock focus intent. Collapsing returns to the mounted loan origin or authoritative core and preserves question drafts. It requires the public terminal-input hook for reopening; hosts without it keep the pane expanded and can still use `/asks` or pause it. Configured SDK external-editor actions edit the original field through a private temporary file, restore the TUI and sanitize the replacement. UI detachment, shutdown and tool abort are not human Cancel.

Draft editor state belongs to a question incarnation, so reordering retains caret/undo/notes while a new request reusing IDs cannot inherit them. Retired private focus can transfer its existing loan to a mounted successor question owner; otherwise it returns only to a still-mounted origin or authoritative core. Foreign focus is never automatically claimed by the stock path.

The presentation port separates pending projection from explicit reveal/focus intent. Terminal widgets do not own storage, results or provider consumption. A future attached FlightDeck UI can replace terminal presentation without redefining those authorities; attachment switching is not implemented here.

## Evidence boundary

Saved/pending truth is independent of UI health. A failed projection or reveal does not undo persistence; a queued send is not a receipt. Real sessions, controlled callbacks, synthetic SDK/TUI tests, physical input, provider consumption, post-exit disk receipts and human acceptance are different evidence.

The SDK can mutate its branch before a failed disk write. Private append failures that changed that branch are therefore **storage unconfirmed**, not answers we can deliver. The backend excludes failed entry identities and blocks further private writes/delivery on that manager/session, including after `/reload`. Persisted feedback receipts also require a complete row in the public SDK session file; memory-only hosts make no disk assertion. A refusal before branch mutation remains retryable. This is fail-closed handling, not SDK journal rollback or repair: recover the original journal before continuing, and preserve/copy the retained draft before any process replacement.

Earlier signed checkpoints passed independent source and extracted-package physical checks for normal saving, external editing, priority, partial review, reload and bounded original-session recovery. Those results do not validate this in-progress focus/SDK-identity refinement. Storage uncertainty, draft retention and before-startup transcript rendering were checked separately through the real SDK and actual filesystem failures; normal-path physical runs did not inject disk failures. No SDK journal repair, hard-crash durability, exactly-once AI action, human acceptance or production activation is claimed here.
