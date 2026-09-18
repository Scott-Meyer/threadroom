import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { createQuestionHost } from '../extensions/questions/host.ts';

export default function(pi: any) {
  pi.registerTool({ name: 'owned_questions_navigation_proof', label: 'Owned question navigation proof', description: 'Flat question and Chat navigation through public SDK boundaries', parameters: Type.Object({}),
    async execute(_id: any, _args: any, _signal: any, _update: any, ctx: any) {
      let widget: any, focus: any, terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const nativeKeys: string[] = [];
      const editor = {
        text: '', cursor: { line: 0, col: 0 }, completion: false,
        getText() { return this.text; },
        setText(value: string) { this.text = value; this.cursor = { line: 0, col: value.length }; },
        getCursor() { return { ...this.cursor }; },
        isShowingAutocomplete() { return this.completion; },
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
      assert.match(widget.render(80).join('\n'), /\[Chat\]/, 'Chat is rendered as a peer navigation stop');

      for (const char of 'ab') widget.handleInput(char);
      widget.handleInput('\x1b[D');
      widget.handleInput('\t');
      assert.equal(host.snapshot().current!.tab.groupId, 'B');
      widget.handleInput('\x1b[Z');
      assert.equal(host.snapshot().current!.tab.groupId, 'A');
      widget.handleInput('X');
      assert.equal(host.snapshot().current!.reply, 'aXb', 'question navigation retains the SDK input caret');
      widget.handleInput('\t'); widget.handleInput('\x1b[Z'); widget.handleInput('\x1b[45;5u');
      assert.equal(host.snapshot().current!.reply, 'ab', 'question navigation retains SDK undo history');
      widget.handleInput('X');
      const notesGroup = host.enqueue({ id: 'N', mode: 'blocking', questions: [question('n')], commit() {} }); notesGroup.outcome!.catch(() => {});
      widget.handleInput('\x1bn'); for (const char of 'note') widget.handleInput(char);
      widget.handleInput('\x1b[D'); widget.handleInput('\t'); widget.handleInput('\x1b[Z'); widget.handleInput('X');
      assert.equal(host.snapshot().current!.notes, 'notXe', 'question navigation retains the notes editor and its caret');
      widget.handleInput('\x1bn'); notesGroup.detach(); await Promise.resolve();

      widget.handleInput('\t');
      widget.handleInput('\t');
      assert.equal(focus, editor, 'forward Tab reaches Chat after the last question');
      assert.equal(editor.getText(), '', 'entering Chat does not replace its editor draft');
      const chatFrame = widget.render(80).join('\n');
      assert.match(chatFrame, /›\[Chat\]/, 'the rendered flat strip identifies Chat focus');
      assert.match(chatFrame, /ctrl\+\] returns to questions/, 'Chat describes its configured explicit return key');
      assert.doesNotMatch(chatFrame, /Enter confirm|Esc (?:pause|cancel)|Alt\+N notes/, 'Chat never advertises question-owned actions');
      assert.equal(send('\t')?.consume, true);
      assert.equal(focus, questionSurface);
      assert.equal(host.snapshot().current!.tab.groupId, 'A', 'forward Tab from empty Chat wraps to the first question');
      widget.handleInput('\x1b[Z');
      assert.equal(focus, editor, 'backward Tab reaches Chat before the first question');
      assert.equal(send('\x1b[Z')?.consume, true);
      assert.equal(host.snapshot().current!.tab.groupId, 'B', 'backward Tab from empty Chat wraps to the last question');

      widget.handleInput('\t');
      editor.setText('ordinary draft');
      const draftCursor = editor.getCursor();
      assert.equal(send('\t'), undefined, 'nonempty Chat delegates Tab to the ordinary editor');
      assert.equal(send('\x1b[Z'), undefined, 'nonempty Chat delegates Shift+Tab to ordinary thinking-level behavior');
      assert.deepEqual(editor.getCursor(), draftCursor); assert.equal(editor.getText(), 'ordinary draft');
      assert.deepEqual(nativeKeys.slice(-2), ['\t', '\x1b[Z']);
      assert.equal(send('\x1d')?.consume, true, 'Ctrl+] remains an explicit fallback from a nonempty Chat draft');
      assert.equal(focus, questionSurface); assert.equal(host.snapshot().current!.tab.groupId, 'B');
      assert.equal(editor.getText(), 'ordinary draft');

      widget.handleInput('\t'); editor.setText(''); editor.completion = true;
      assert.equal(send('\t'), undefined, 'an active completion keeps native Tab ownership even when text is empty');
      assert.equal(focus, editor); assert.equal(nativeKeys.at(-1), '\t');
      editor.completion = false;
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(host.snapshot().current!.tab.groupId, 'B');

      widget.handleInput('\t');
      host.enqueue({ id: 'C', mode: 'async', questions: [question('c')], commit() {} });
      await Promise.resolve();
      assert.equal(focus, editor); assert.equal(host.snapshot().current!.tab.groupId, 'B', 'same-priority arrival preserves the Chat stop and underlying selection');
      host.enqueue({ id: 'D', mode: 'blocking', questions: [question('d')] }).outcome!.catch(() => {});
      await Promise.resolve();
      assert.equal(focus, questionSurface, 'a blocker preempts Chat'); assert.equal(host.snapshot().current!.tab.groupId, 'D');

      const foreignPrompt = { handleInput() {} }; focus = foreignPrompt; host.suspend(true);
      host.enqueue({ id: 'E', mode: 'blocking', questions: [question('e')] }).outcome!.catch(() => {}); await Promise.resolve();
      host.suspend(false); assert.equal(focus, foreignPrompt, 'foreign prompt focus is never replaced during reconciliation');
      host.dispose();

      focus = editor; editor.setText('');
      const custom = createQuestionHost(context, { collapseKey: 'ctrl+g' });
      custom.enqueue({ id: 'CUSTOM', mode: 'async', questions: [question('custom')], commit() {} }); await Promise.resolve();
      const customSurface = focus;
      assert.equal(send('\x07')?.consume, true); assert.equal(focus, editor, 'the configured key collapses from a question');
      assert.match(widget.render(80).join('\n'), /Collapsed[\s\S]*ctrl\+g returns to questions/);
      assert.equal(send('\x07')?.consume, true); assert.equal(focus, customSurface, 'the configured key reopens a collapsed question');
      widget.handleInput('\t'); assert.equal(focus, editor);
      const customChatFrame = widget.render(80).join('\n');
      assert.match(customChatFrame, /ctrl\+g returns to questions/, 'Chat renders the configured return key');
      assert.doesNotMatch(customChatFrame, /ctrl\+\] returns to questions/);
      assert.equal(send('\x1d'), undefined, 'the default key is not retained behind a custom return key'); assert.equal(focus, editor);
      assert.equal(send('\x07')?.consume, true); assert.equal(focus, customSurface, 'the configured return key works from Chat');
      custom.dispose();

      focus = editor; editor.setText('');
      const disabled = createQuestionHost(context, { collapseKey: false });
      disabled.enqueue({ id: 'OFF1', mode: 'async', questions: [question('off1')], commit() {} });
      disabled.enqueue({ id: 'OFF2', mode: 'async', questions: [question('off2')], commit() {} }); await Promise.resolve();
      const disabledSurface = focus; widget.handleInput('\t'); widget.handleInput('\t');
      assert.equal(focus, disabledSurface, 'disabling the explicit return route also disables the potentially trapping Chat stop');
      assert.doesNotMatch(widget.render(80).join('\n'), /\[Chat\]/);
      disabled.dispose();

      let reducedWidget: any, reducedFocus: any, reducedInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const reducedEditor = { text: 'basic draft', getText() { return this.text; }, setText(value: string) { this.text = value; }, handleInput() {} };
      const reducedTui = { children: [reducedEditor], terminal: { rows: 24, columns: 80 }, requestRender() {}, getFocusedComponent() { return reducedFocus; }, setFocus(next: any) { reducedFocus = next; } }; reducedFocus = reducedEditor;
      const reduced = createQuestionHost({ ui: {
        onTerminalInput(handler: typeof reducedInput) { reducedInput = handler; return () => { reducedInput = undefined; }; },
        setWidget(_key: string, factory: any) { if (factory) reducedWidget = factory(reducedTui, ctx.ui.theme); else reducedWidget?.dispose(); },
      } });
      reduced.enqueue({ id: 'REDUCED', mode: 'async', questions: [question('reduced')], commit() {} }); await Promise.resolve();
      const reducedSurface = reducedFocus;
      assert.equal(reducedInput?.('\x1d')?.consume, true); assert.equal(reducedFocus, reducedEditor, 'collapse still loans focus to a basic public editor');
      assert.match(reducedWidget.render(80).join('\n'), /Collapsed/);
      const reducedChatFooter = reducedWidget.render(240).join('\n');
      assert.match(reducedChatFooter, /ctrl\+\] returns to questions/, 'a reduced editor advertises its supported explicit return route');
      assert.doesNotMatch(reducedChatFooter, /empty Tab\/Shift\+Tab navigates/, 'a reduced editor must not promise unsupported empty-Tab navigation');
      assert.equal(reducedInput?.('\x1d')?.consume, true, 'the collapse key remains available with the original reduced editor contract');
      assert.equal(reducedFocus, reducedSurface, 'a basic public editor can reopen the question it was allowed to collapse');
      assert.equal(reducedEditor.text, 'basic draft'); assert.doesNotMatch(reducedWidget.render(80).join('\n'), /\[Chat\]/, 'stricter Chat navigation stays disabled for the reduced editor');
      reduced.dispose();

      let limitedWidget: any, limitedFocus: any = editor;
      const limitedTui = { ...tui, getFocusedComponent() { return limitedFocus; }, setFocus(next: any) { limitedFocus = next; } };
      const limited = createQuestionHost({ ui: { setWidget(_key: string, factory: any) { if (factory) limitedWidget = factory(limitedTui, ctx.ui.theme); else limitedWidget?.dispose(); } } });
      limited.enqueue({ id: 'L1', mode: 'async', questions: [question('l1')], commit() {} });
      limited.enqueue({ id: 'L2', mode: 'async', questions: [question('l2')], commit() {} }); await Promise.resolve();
      const limitedSurface = limitedFocus; limitedWidget.handleInput('\t'); limitedWidget.handleInput('\t');
      assert.equal(limitedFocus, limitedSurface, 'without raw terminal input, Tab remains question-only rather than trapping focus in Chat');
      assert.doesNotMatch(limitedWidget.render(80).join('\n'), /\[Chat\]/, 'unsupported Chat navigation is not advertised');
      limited.dispose();
      return { content: [{ type: 'text', text: 'Question/Chat SDK navigation passed' }], details: { flatQuestionChatOrder: true, honestChatFooter: true, configuredReturnKey: true, disabledReturnDisablesChatStop: true, reducedEditorCollapseReentry: true, publicEditorPolicy: true, questionCaretUndoNotesRetained: true, ordinaryDraftRetained: true, completionDelegated: true, thinkingShiftTabDelegated: true, blockerPreemption: true, foreignFocusRetained: true, navigationCapabilityGated: true, physicalPty: false } };
    },
  });
}
