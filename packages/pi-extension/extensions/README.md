# Pi host adapter

`index.ts` binds Threadroom participation to Pi's tool, session, and message lifecycle. The shared conversation and authored interaction stay in the independent service; Pi presents a readable window onto them, not another questionnaire.

Tool rows and saved-feedback messages show the discussion title, durable website address, and what happened. Expand a row for nearby saved context, provenance labels, receipt identities and participation state. Authored programs never render as terminal source. The original tool result and message details remain unchanged for the model and session replay.

The presentation helpers use Pi's `Text` components, with terminal controls and directional overrides made visible as text. Only validated HTTP(S) addresses become hyperlinks; terminals without hyperlink support still show the address. Author labels describe caller-supplied provenance, not authenticated approval.

`/threadroom` shows the selected API and website addresses, connection state and session watches. Failed tool operations show those addresses too. This adapter connects to the service; it does not start or own it.

The runtime uses the `@earendil-works/pi-tui` peer exposed by Pi's extension loader. Helpers live beneath `presentation/` without an extension entry point.

## Host evidence

`packages/pi-extension/test/presentation.test.js` loads the real adapter through Pi's discovery/loader, executes it against a real service, and renders through Pi's `ToolExecutionComponent` and `CustomMessageComponent`. It checks readable links, wait outcomes, feedback intent/provenance, receipt preservation, terminal safety, expansion and narrow widths. With a local Pi peer installed, the check participates in `npm test`. For a global install, `THREADROOM_PI_SDK_ROOT` names the installed `pi-coding-agent` package directory. A service-only checkout reports these host checks as skipped.
