# Interaction playground — test questions

Synthetic examples requested by Scott, not real MistFall requests or approvals. Publish them to the running API and open the printed playground link:

```sh
node examples/playground/publish.js
```

The collection contains moving/keyboard exploration, an overlapping/layered composition answer, multi-select choices, a picture question with picture choices, mouse/touch drawing, and three actual questions nested inside one another. Motion/stacking/drawing proposals include compact PNG captures; picture choices retain self-contained images. All keep written notes/text and the independent host response controls.

Focus the moving scene for arrows/WASD, Space, and R. Drag composition pieces; choose a covered piece by name and use front/back or keyboard nudges. Drawing supports brush/color, undo, and clear. The widgets only **propose a draft**. Threadroom's **Save response** records it; text, ask-back, defer, and rejection remain available without using a widget. After proposing, edits to widget notes update the draft automatically while keeping its captured visual state. If you change the scene, layout, picture selection, or drawing itself, propose again to capture that new state.

Repeating unchanged source recovers the same nodes. Captures are immutable: after changing these documents, use a fresh `PLAYGROUND_KEY` to publish a new collection. `THREADROOM_API_URL` and `THREADROOM_UI_URL` select the service/website. Publication never invents an offline store.
