import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { createQuestionHost } from '../extensions/questions/host.ts';

export default function(pi: any) {
  pi.registerTool({ name: 'owned_questions_navigation_proof', label: 'Owned question navigation proof', description: 'Chat-home and question navigation through public SDK boundaries', parameters: Type.Object({}),
    async execute(_id: any, _args: any, _signal: any, _update: any, ctx: any) {
      let widget: any, focus: any, terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const nativeKeys: string[] = [];
      // This is deliberately only the public editor value/input contract. Focus
      // cycling must not depend on cursor or autocomplete inspection.
      const editor = {
        text: '', cursor: { line: 3, col: 7 },
        getText() { return this.text; },
        setText(value: string) { this.text = value; },
        handleInput(data: string) { nativeKeys.push(data); },
      };
      const tui = {
        children: [editor], terminal: { rows: 24, columns: 80 }, requestRender() {},
        getFocusedComponent() { return focus; }, setFocus(next: any) { focus = next; },
      };
      focus = editor;
      const context = { cwd: process.cwd(), isProjectTrusted: () => false, ui: {
        theme: ctx.ui.theme,
        onTerminalInput(handler: typeof terminalInput) { terminalInput = handler; return () => { terminalInput = undefined; }; },
        setWidget(_key: string, factory: any) { if (factory) widget = factory(tui, ctx.ui.theme); else widget?.dispose(); },
      } };
      const send = (data: string) => { const result = terminalInput?.(data); if (!result?.consume) focus?.handleInput?.(data); return result; };
      const question = (id: string) => ({ id, header: id, question: `${id}?` });
      const host = createQuestionHost(context);
      host.enqueue({ id: 'A', mode: 'async', questions: [question('a')], commit() {} });
      host.enqueue({ id: 'B', mode: 'async', questions: [question('b')], commit() {} });
      await Promise.resolve();
      const questionSurface = focus;
      assert.notEqual(questionSurface, editor);
      const homeFrame = widget.render(80).join('\n');
      assert.match(homeFrame, /Chat\s+│\s+Questions\s+›?\[Async a\]/, 'Chat is a fixed, unbracketed home anchor before the named question group');
      assert.doesNotMatch(homeFrame, /\[Chat\]/, 'Chat is not styled as another question tab');

      // Native question-local Tab remains local and wraps among question tabs.
      widget.handleInput('\t');
      assert.equal(host.snapshot().current!.tab.groupId, 'B');
      widget.handleInput('\t');
      assert.equal(host.snapshot().current!.tab.groupId, 'A');
      assert.equal(focus, questionSurface, 'question-local Tab never loans focus to Chat');
      assert.match(widget.render(120).join('\n'), /Tab\/Shift\+Tab question tabs/);

      // The separate global route has the same logical and displayed order:
      // Chat -> A -> B -> Chat, with the reverse in the other direction.
      assert.equal(send('\x1b[9;6u')?.consume, true);
      assert.equal(focus, editor, 'Ctrl+Shift+Tab before the first question reaches Chat');
      assert.deepEqual(editor.cursor, { line: 3, col: 7 }, 'focus loan does not rewrite an uninspected ordinary cursor');
      const chatFrame = widget.render(120).join('\n');
      assert.match(chatFrame, /›Chat\s+│\s+Questions\s+\[Async a\]/, 'the home anchor identifies Chat focus');
      assert.match(chatFrame, /Tab completion · Shift\+Tab thinking/, 'Chat states its native Tab contracts');
      assert.match(chatFrame, /ctrl\+tab\/ctrl\+shift\+tab moves focus/, 'Chat describes the separate focus route');
      assert.doesNotMatch(chatFrame, /Enter confirm|Esc (?:pause|cancel)|Alt\+N notes/, 'Chat never advertises question-owned actions');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(host.snapshot().current!.tab.groupId, 'A', 'forward focus cycle from Chat opens the first question');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(host.snapshot().current!.tab.groupId, 'B');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(focus, editor, 'forward focus cycle wraps from last question to Chat');
      assert.equal(send('\x1b[9;6u')?.consume, true); assert.equal(host.snapshot().current!.tab.groupId, 'B', 'reverse focus cycle opens the last question');

      // Kitty key repeats/releases are consumed but never cause extra focus moves.
      const beforeGuard = host.snapshot().current!.tab.groupId;
      assert.equal(send('\x1b[9;5:2u')?.consume, true); assert.equal(host.snapshot().current!.tab.groupId, beforeGuard);
      assert.equal(send('\x1b[9;5:3u')?.consume, true); assert.equal(host.snapshot().current!.tab.groupId, beforeGuard);

      // Draft editor identity, caret, undo, and notes remain question-owned.
      for (const char of 'ab') widget.handleInput(char);
      widget.handleInput('\x1b[D');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(focus, editor);
      assert.equal(send('\x1b[9;6u')?.consume, true); widget.handleInput('X');
      assert.equal(host.snapshot().current!.reply, 'aXb', 'focus cycling retains the SDK input caret');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(send('\x1b[9;6u')?.consume, true);
      widget.handleInput('\x1b[45;5u');
      assert.equal(host.snapshot().current!.reply, 'ab', 'focus cycling retains SDK undo history');
      widget.handleInput('X');
      const notesGroup = host.enqueue({ id: 'N', mode: 'blocking', questions: [question('n')], commit() {} }); notesGroup.outcome!.catch(() => {});
      widget.handleInput('\x1bn'); for (const char of 'note') widget.handleInput(char);
      widget.handleInput('\x1b[D');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(send('\x1b[9;6u')?.consume, true); widget.handleInput('X');
      assert.equal(host.snapshot().current!.notes, 'notXe', 'focus cycling retains the notes editor and its caret');
      widget.handleInput('\x1bn'); notesGroup.detach(); await Promise.resolve();

      // Chat always owns ordinary Tab and Shift+Tab, regardless of draft state.
      assert.equal(send('\x1b[9;6u')?.consume, true); assert.equal(focus, editor);
      assert.equal(editor.getText(), '', 'entering Chat never replaces its draft');
      assert.equal(send('\t'), undefined); assert.equal(send('\x1b[Z'), undefined);
      editor.setText('ordinary draft');
      assert.equal(send('\t'), undefined); assert.equal(send('\x1b[Z'), undefined);
      assert.deepEqual(nativeKeys.slice(-4), ['\t', '\x1b[Z', '\t', '\x1b[Z']);
      assert.equal(focus, editor); assert.equal(editor.getText(), 'ordinary draft');
      assert.equal(send('\x1d')?.consume, true, 'Ctrl+] remains an optional separate collapse/reentry route');
      assert.equal(focus, questionSurface); assert.equal(editor.getText(), 'ordinary draft');

      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(host.snapshot().current!.tab.groupId, 'B');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(focus, editor);
      host.enqueue({ id: 'C', mode: 'async', questions: [question('c')], commit() {} }); await Promise.resolve();
      assert.equal(focus, editor); assert.equal(host.snapshot().current!.tab.groupId, 'B', 'same-priority arrival preserves Chat and its underlying selection');
      host.enqueue({ id: 'D', mode: 'blocking', questions: [question('d')] }).outcome!.catch(() => {}); await Promise.resolve();
      assert.equal(focus, questionSurface, 'a blocker preempts Chat'); assert.equal(host.snapshot().current!.tab.groupId, 'D');
      const foreignPrompt = { handleInput() {} }; focus = foreignPrompt; host.suspend(true);
      host.enqueue({ id: 'E', mode: 'blocking', questions: [question('e')] }).outcome!.catch(() => {}); await Promise.resolve();
      host.suspend(false); assert.equal(focus, foreignPrompt, 'foreign prompt focus is never replaced during reconciliation');
      host.dispose();

      // Disabling collapse cannot disable the independent global Chat route.
      focus = editor; editor.setText('kept');
      const noCollapse = createQuestionHost(context, { collapseKey: false });
      noCollapse.enqueue({ id: 'OFF', mode: 'async', questions: [question('off')], commit() {} }); await Promise.resolve();
      const noCollapseSurface = focus;
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(focus, editor);
      assert.match(widget.render(100).join('\n'), /›Chat\s+│/);
      assert.equal(send('\x1d'), undefined); assert.equal(focus, editor, 'disabled collapse stays disabled');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(focus, noCollapseSurface, 'focus cycle safely returns without collapse');
      send('\x1b'); await Promise.resolve();
      assert.equal(noCollapse.snapshot().current!.paused, true); assert.equal(focus, editor, 'pause loans focus to Chat without answering');
      assert.match(widget.render(120).join('\n'), /›Chat\s+│/, 'paused questions identify the actual Chat focus owner');
      assert.equal(send('\x1b[9;5u')?.consume, true, 'the explicit global shortcut remains a route back from pause');
      assert.equal(focus, noCollapseSurface); assert.equal(noCollapse.snapshot().current!.paused, false, 'explicit navigation resumes the original question');
      assert.equal(editor.getText(), 'kept');
      noCollapse.dispose();

      focus = editor;
      const pausedDefault = createQuestionHost(context);
      pausedDefault.enqueue({ id: 'PAUSED_DEFAULT', mode: 'async', questions: [question('paused-default')], commit() {} }); await Promise.resolve();
      const pausedDefaultSurface = focus;
      send('\x1b'); await Promise.resolve();
      assert.equal(pausedDefault.snapshot().current!.paused, true); assert.equal(focus, editor);
      assert.match(widget.render(160).join('\n'), /ctrl\+\] returns to questions/, 'default paused footer advertises its explicit return key');
      assert.equal(send('\x1d')?.consume, true, 'default explicit return key must work from paused Chat');
      assert.equal(focus, pausedDefaultSurface); assert.equal(pausedDefault.snapshot().current!.paused, false);
      assert.equal(editor.getText(), 'kept');
      pausedDefault.dispose();

      focus = editor;
      const mixed = createQuestionHost(context);
      for (const id of ['MA', 'MB', 'MC']) mixed.enqueue({ id, mode: 'async', questions: [question(id.toLowerCase())], commit() {} });
      await Promise.resolve(); mixed.select('MB', 'mb'); await Promise.resolve();
      const mixedSurface = focus;
      widget.handleInput('m'); widget.handleInput('i'); widget.handleInput('d');
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, editor);
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(mixed.snapshot().current!.tab.groupId, 'MA');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(mixed.snapshot().current!.tab.groupId, 'MB'); await Promise.resolve();
      assert.equal(focus, mixedSurface, 'every global destination reopens a previously collapsed question');
      assert.equal(mixed.snapshot().current!.reply, 'mid', 'reopened destination keeps its original draft');
      assert.equal(send('\x1b[9;5u')?.consume, true); assert.equal(mixed.snapshot().current!.tab.groupId, 'MC');
      assert.equal(focus, mixedSurface, 'a collapsed middle question cannot trap the later question');
      assert.equal(send('\x1b[9;6u')?.consume, true); await Promise.resolve(); assert.equal(mixed.snapshot().current!.tab.groupId, 'MB'); assert.equal(focus, mixedSurface);
      assert.equal(send('\x1d')?.consume, true); mixed.select('MA', 'ma'); await Promise.resolve();
      send('\t'); await Promise.resolve();
      assert.equal(mixed.snapshot().current!.tab.groupId, 'MB'); assert.equal(focus, mixedSurface, 'question-local Tab reopens its previously collapsed destination');
      assert.equal(mixed.snapshot().current!.reply, 'mid');
      assert.equal(send('\x1d')?.consume, true); mixed.select('MC', 'mc'); await Promise.resolve();
      send('\x1b[Z'); await Promise.resolve();
      assert.equal(mixed.snapshot().current!.tab.groupId, 'MB'); assert.equal(focus, mixedSurface, 'reverse question-local Tab also stays in the question panel');
      assert.equal(mixed.snapshot().current!.reply, 'mid');
      mixed.dispose();


      // The focus keys can be coherently replaced as a forward/reverse pair.
      focus = editor;
      const custom = createQuestionHost(context, { cycleKeys: { next: 'ctrl+g', previous: 'ctrl+shift+g' } });
      custom.enqueue({ id: 'CUSTOM', mode: 'async', questions: [question('custom')], commit() {} }); await Promise.resolve();
      const customSurface = focus;
      assert.equal(send('\x07')?.consume, true); assert.equal(focus, editor);
      assert.match(widget.render(120).join('\n'), /ctrl\+g\/ctrl\+shift\+g moves focus/);
      assert.equal(send('\x1b[103;6u')?.consume, true); assert.equal(focus, customSurface);
      custom.dispose();

      // ui.onTerminalInput plus a mounted public getText/setText editor is the
      // whole capability floor; the former reduced editor now supports Chat.
      let reducedWidget: any, reducedFocus: any, reducedInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const reducedEditor = { text: 'basic draft', getText() { return this.text; }, setText(value: string) { this.text = value; }, handleInput() {} };
      const reducedTui = { children: [reducedEditor], terminal: { rows: 24, columns: 80 }, requestRender() {}, getFocusedComponent() { return reducedFocus; }, setFocus(next: any) { reducedFocus = next; } }; reducedFocus = reducedEditor;
      const reduced = createQuestionHost({ ui: {
        onTerminalInput(handler: typeof reducedInput) { reducedInput = handler; return () => { reducedInput = undefined; }; },
        setWidget(_key: string, factory: any) { if (factory) reducedWidget = factory(reducedTui, ctx.ui.theme); else reducedWidget?.dispose(); },
      } });
      reduced.enqueue({ id: 'REDUCED', mode: 'async', questions: [question('reduced')], commit() {} }); await Promise.resolve();
      const reducedSurface = reducedFocus;
      assert.equal(reducedInput?.('\x1b[9;5u')?.consume, true); assert.equal(reducedFocus, reducedEditor, 'the reduced public editor is a safe Chat stop');
      assert.match(reducedWidget.render(120).join('\n'), /›Chat\s+│/);
      assert.equal(reducedInput?.('\x1d')?.consume, true); assert.equal(reducedFocus, reducedSurface, 'the older collapse/reentry route stays safe too');
      assert.equal(reducedEditor.text, 'basic draft');
      reduced.dispose();

      let opaqueWidget: any, opaqueFocus: any, opaqueInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const opaqueEditor = { handleInput() {} }; opaqueFocus = opaqueEditor;
      const opaqueTui = { children: [opaqueEditor], terminal: { rows: 24, columns: 80 }, requestRender() {}, getFocusedComponent() { return opaqueFocus; }, setFocus(next: any) { opaqueFocus = next; } };
      const opaque = createQuestionHost({ ui: {
        onTerminalInput(handler: typeof opaqueInput) { opaqueInput = handler; return () => { opaqueInput = undefined; }; },
        setWidget(_key: string, factory: any) { if (factory) opaqueWidget = factory(opaqueTui, ctx.ui.theme); else opaqueWidget?.dispose(); },
      } });
      opaque.enqueue({ id: 'OPAQUE', mode: 'async', questions: [question('opaque')], commit() {} }); await Promise.resolve();
      assert.doesNotMatch(opaqueWidget.render(80).join('\n'), /Chat\s+│/, 'raw input alone cannot loan focus to a non-public editor');
      assert.equal(opaqueInput?.('\x1b[9;5u'), undefined); assert.equal(opaqueFocus, opaqueEditor);
      opaque.dispose();

      let limitedWidget: any, limitedFocus: any = editor;
      const limitedTui = { ...tui, getFocusedComponent() { return limitedFocus; }, setFocus(next: any) { limitedFocus = next; } };
      const limited = createQuestionHost({ ui: { setWidget(_key: string, factory: any) { if (factory) limitedWidget = factory(limitedTui, ctx.ui.theme); else limitedWidget?.dispose(); } } });
      limited.enqueue({ id: 'LIMITED', mode: 'async', questions: [question('limited')], commit() {} }); await Promise.resolve();
      assert.doesNotMatch(limitedWidget.render(80).join('\n'), /Chat\s+│/, 'without public raw input the unavailable Chat loan is not advertised');
      assert.equal(limitedFocus === editor, false);
      limited.dispose();

      return { content: [{ type: 'text', text: 'Chat-home SDK navigation passed' }], details: {
        chatHomeAnchor: true, globalCycleOrder: true, questionTabLocal: true, nativeChatTabs: true,
        configurableCyclePair: true, collapseIndependent: true, reducedPublicEditorSupported: true,
        questionCaretUndoNotesRetained: true, ordinaryDraftRetained: true, blockerPreemption: true,
        foreignFocusRetained: true, navigationCapabilityGated: true, oneShotGuards: true, physicalPty: false,
      } };
    },
  });
}
