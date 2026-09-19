import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { Editor } from '@earendil-works/pi-tui';
import { createQuestionHost } from '../extensions/questions/host.ts';

export default function(pi: any) {
  pi.registerTool({ name: 'owned_questions_navigation_proof', label: 'Owned question navigation proof', description: 'Question-pane focus toggling through public SDK boundaries', parameters: Type.Object({}),
    async execute(_id: any, _args: any, _signal: any, _update: any, ctx: any) {
      let widget: any, focus: any, terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const nativeKeys: string[] = [];
      // Deliberately only the public editor value/input contract: no cursor,
      // autocomplete, private imports, or replacement editor.
      const editor = {
        text: '',
        getText() { return this.text; },
        setText(value: string) { this.text = value; },
        handleInput(data: string) { nativeKeys.push(data); },
      };
      const tui = {
        children: [editor], terminal: { rows: 18, columns: 80 }, requestRender() {},
        getFocusedComponent() { return focus; }, setFocus(next: any) { focus = next; },
      };
      focus = editor;
      const context = { cwd: process.cwd(), isProjectTrusted: () => false, ui: {
        theme: ctx.ui.theme,
        getCoreEditor() { return editor; },
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
      // A known prompt can suspend input before the SDK changes its retained
      // focus identity. An unmounted core cannot receive the return loan.
      tui.children.splice(0, tui.children.length); host.suspend(true);
      const suspendedFrame = widget.render(120).join('\n');
      assert.equal(focus, questionSurface, 'unmounted authoritative core cannot receive the existing focus loan');
      assert.doesNotMatch(suspendedFrame, /Tab next question|Enter confirm|Esc pause|\x1b_pi:c/, 'suspended pane projects no owned controls or live caret even with retained TUI focus');
      assert.match(suspendedFrame, /┈/, 'suspended pane has an inactive border');
      tui.children.push(editor); host.suspend(false);
      const selectedFrame = widget.render(80);
      assert.ok(selectedFrame.length <= 6, '80x18 question widget stays within six rows');
      assert.match(selectedFrame.join('\n'), /\[Async a\].*\[Async b\]/, 'question tabs remain visible');
      assert.doesNotMatch(selectedFrame.join('\n'), /Chat\s*│\s*Questions/, 'the pane does not invent fixed Chat/Questions navigation labels');
      assert.match(selectedFrame[0], /─/, 'selected pane has a solid top border');
      assert.match(selectedFrame.at(1) || '', /│/, 'selected pane has solid side borders');
      assert.doesNotMatch(selectedFrame.join('\n'), /ctrl\+tab|ctrl\+shift\+tab/i, 'retired global cycle aliases are absent');

      // Ordinary Tab advances question and review tabs and wraps without leaving
      // the question pane. Shift+Tab alone toggles the pane focus.
      assert.equal(send('\x1b[9;1:2u'), undefined); assert.equal(host.snapshot().current!.tab.groupId, 'B', 'ordinary Tab navigation retains autorepeat');
      assert.equal(send('\t'), undefined); assert.equal(host.snapshot().current!.tab.groupId, 'A');
      assert.equal(focus, questionSurface);
      assert.match(widget.render(120).join('\n'), /Tab next question/);
      assert.match(widget.render(120).join('\n'), /Shift\+Tab Chat/);
      assert.equal(send('\x1b[9;5u'), undefined); assert.equal(focus, questionSurface, 'retired Ctrl+Tab is not a focus alias');

      for (const char of 'ab') send(char);
      send('\x1b[D');
      editor.setText('ordinary draft');
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, editor);
      assert.equal(editor.getText(), 'ordinary draft', 'leaving the pane never rewrites Chat');
      const passiveFrame = widget.render(80);
      assert.ok(passiveFrame.length <= 6);
      assert.match(passiveFrame[0], /┈/, 'unselected pane has a dotted top border');
      assert.match(passiveFrame.at(1) || '', /┊/, 'unselected pane has dotted side borders');
      assert.doesNotMatch(passiveFrame.join('\n'), /\x1b_pi:c/, 'passive question SDK inputs render statically without a fake caret');
      assert.doesNotMatch(passiveFrame.join('\n'), /Chat\s*│\s*Questions/);
      assert.match(passiveFrame.join('\n'), /Tab completion · Shift\+Tab questions/);
      assert.equal(send('\x1b[9;6u'), undefined); assert.equal(nativeKeys.at(-1), '\x1b[9;6u', 'retired Ctrl+Shift+Tab is native downstream input');
      assert.equal(send('\t'), undefined, 'Chat Tab stays native');
      assert.equal(nativeKeys.at(-1), '\t'); assert.equal(focus, editor);
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(host.snapshot().current!.tab.groupId, 'A', 'focus return retains the selected question');
      send('X');
      assert.equal(host.snapshot().current!.reply, 'aXb', 'focus toggling retains the question Input caret');
      assert.equal(editor.getText(), 'ordinary draft');
      send('\x1b[45;5u');
      assert.equal(host.snapshot().current!.reply, 'ab', 'focus toggling retains SDK Input undo history');
      send('X');

      const notesGroup = host.enqueue({ id: 'N', mode: 'blocking', questions: [question('n1'), question('n2')] }); notesGroup.outcome!.catch(() => {});
      await Promise.resolve();
      assert.equal(host.snapshot().current!.tab.questionId, 'n1');
      send('\t'); assert.equal(host.snapshot().current!.tab.questionId, 'n2');
      send('\t'); assert.equal(host.snapshot().current!.tab.review, true, 'ordinary Tab reaches review tabs');
      send('\t'); assert.equal(host.snapshot().current!.tab.questionId, 'a');
      send('\t'); assert.equal(host.snapshot().current!.tab.questionId, 'b');
      send('\t'); assert.equal(host.snapshot().current!.tab.questionId, 'n1', 'ordinary Tab wraps across all question/review tabs');
      send('\x1bn'); for (const char of 'note') send(char); send('\x1b[D');
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(send('\x1b[Z')?.consume, true); send('X');
      assert.equal(host.snapshot().current!.notes, 'notXe', 'focus toggling retains the notes Editor caret');
      send('\x1bn'); notesGroup.detach(); await Promise.resolve(); host.select('A', 'a'); await Promise.resolve();

      // Toggle presses are one-shot while repeats/releases are consumed.
      assert.equal(send('\x1b[9;2:2u')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(send('\x1b[9;2:3u')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, editor);
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, questionSurface);

      // The independent collapse route and the new toggle both reveal/resume the
      // retained destination. Local Tab also reveals a formerly collapsed tab.
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, editor);
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(host.snapshot().current!.reply, 'aXb');
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, editor);
      host.select('B', 'b'); await Promise.resolve(); assert.equal(focus, questionSurface);
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, editor);
      host.select('A', 'a'); await Promise.resolve();
      assert.equal(send('\t'), undefined); await Promise.resolve();
      assert.equal(host.snapshot().current!.tab.groupId, 'B'); assert.equal(focus, questionSurface, 'local Tab reveals a collapsed destination');

      // Pause hands the pane back only when the public editor exists. Either
      // independent return key resumes exactly the retained question.
      send('\x1b'); await Promise.resolve();
      assert.equal(host.snapshot().current!.paused, true); assert.equal(focus, editor);
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(host.snapshot().current!.paused, false);
      send('\x1b'); await Promise.resolve();
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(host.snapshot().current!.paused, false, 'focus toggle resumes a paused question');

      // Same-priority arrivals preserve the Chat loan; a blocker preempts it.
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, editor);
      host.enqueue({ id: 'C', mode: 'async', questions: [question('c')], commit() {} }); await Promise.resolve();
      assert.equal(focus, editor); assert.equal(host.snapshot().current!.tab.groupId, 'B');
      const blocker = host.enqueue({ id: 'D', mode: 'blocking', questions: [question('d')] }); blocker.outcome!.catch(() => {}); await Promise.resolve();
      assert.equal(focus, questionSurface); assert.equal(host.snapshot().current!.tab.groupId, 'D');
      const foreignPrompt = { handleInput() {} }; focus = foreignPrompt; host.suspend(true);
      const later = host.enqueue({ id: 'E', mode: 'blocking', questions: [question('e')] }); later.outcome!.catch(() => {}); await Promise.resolve();
      host.suspend(false); assert.equal(focus, foreignPrompt, 'foreign prompt keeps focus');
      host.dispose();

      // The single focus-toggle key is configurable or can be disabled. A
      // custom toggle does not steal Tab or Shift+Tab from Chat.
      focus = editor; editor.setText('kept');
      const custom = createQuestionHost(context, { focusToggleKey: 'ctrl+g', collapseKey: false });
      custom.enqueue({ id: 'CUSTOM', mode: 'async', questions: [question('custom')], commit() {} }); await Promise.resolve();
      const customSurface = focus;
      assert.match(widget.render(120).join('\n'), /Ctrl\+G Chat|ctrl\+g Chat/);
      assert.equal(send('\x07')?.consume, true); assert.equal(focus, editor);
      assert.equal(send('\t'), undefined); assert.equal(send('\x1b[Z'), undefined);
      assert.deepEqual(nativeKeys.slice(-2), ['\t', '\x1b[Z']);
      assert.equal(send('\x07')?.consume, true); assert.equal(focus, customSurface);
      assert.equal(editor.getText(), 'kept');
      custom.dispose();

      focus = editor;
      const disabled = createQuestionHost(context, { focusToggleKey: false, collapseKey: false });
      disabled.enqueue({ id: 'OFF', mode: 'async', questions: [question('off')], commit() {} }); await Promise.resolve();
      const disabledSurface = focus;
      assert.doesNotMatch(widget.render(120).join('\n'), /Shift\+Tab Chat|returns to questions|ctrl\+tab/i);
      assert.equal(send('\x1b[Z'), undefined); assert.equal(focus, disabledSurface, 'disabled toggle does not hide or defocus the question');
      disabled.dispose();

      // The public identity remains the unmounted core editor while a foreign
      // SDK Editor occupies the input area with the same empty value contract.
      editor.setText('');
      const firstForeign = new Editor(tui as any, { borderColor: (text: string) => text, selectList: {} } as any);
      tui.children.splice(0, tui.children.length, firstForeign as any); focus = firstForeign;
      const firstMount = createQuestionHost(context);
      firstMount.enqueue({ id: 'FIRST_FOREIGN', mode: 'async', questions: [question('first-foreign')], commit() {} }); await Promise.resolve();
      const foreignFrame = widget.render(120).join('\n');
      assert.doesNotMatch(foreignFrame, /Tab next question|Enter confirm|Esc pause|Chat editor|Tab completion/, 'foreign passive frame has no owned controls or guessed Chat role');
      assert.match(foreignFrame, /Input outside questions/);
      assert.equal(focus, firstForeign, 'first enqueue preserves an already focused foreign SDK Editor without suspend');
      send('x'); assert.equal(firstForeign.getText(), 'x', 'foreign SDK Editor retains the first input after mounting');
      firstMount.dispose(); assert.equal(focus, firstForeign);
      tui.children.splice(0, tui.children.length, editor);

      // Stock SDK: the previous input is an explicit loan origin, not a core
      // editor guess. No value/class/text probes or editor mutations are needed.
      let opaqueWidget: any, opaqueFocus: any, opaqueInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const opaqueNative: string[] = [];
      const opaqueEditor = { handleInput(data: string) { opaqueNative.push(data); } }; opaqueFocus = opaqueEditor;
      const opaqueTui = { children: [opaqueEditor], terminal: { rows: 18, columns: 80 }, requestRender() {}, getFocusedComponent() { return opaqueFocus; }, setFocus(next: any) { opaqueFocus = next; } };
      const opaque = createQuestionHost({ ui: {
        onTerminalInput(handler: typeof opaqueInput) { opaqueInput = handler; return () => { opaqueInput = undefined; }; },
        setWidget(_key: string, factory: any) { if (factory) opaqueWidget = factory(opaqueTui, ctx.ui.theme); else opaqueWidget?.dispose(); },
      } });
      const opaqueSend = (data: string) => { const result = opaqueInput?.(data); if (!result?.consume) opaqueFocus?.handleInput?.(data); return result; };
      const stockPending = opaque.enqueue({ id: 'OPAQUE', mode: 'async', questions: [question('opaque')], commit() {} });
      await Promise.resolve(); opaqueWidget.render(120);
      assert.equal(opaqueFocus, opaqueEditor, 'stock arrival is visible without interrupting unknown input');
      assert.match(opaqueWidget.render(120).join('\n'), /┈/);
      assert.match(opaqueWidget.render(120).join('\n'), /Input outside questions.*Shift\+Tab questions/, 'first passive arrival advertises entry without a previous loan');
      assert.doesNotMatch(opaqueWidget.render(120).join('\n'), /Tab next question|Enter confirm|Esc cancel|Esc pause/, 'passive pane cannot advertise controls routed to another input');
      assert.doesNotMatch(opaqueWidget.render(120).join('\n'), /Chat editor|Tab completion|\x1b_pi:c/);
      assert.equal(opaqueSend('\t'), undefined); assert.equal(opaqueNative.at(-1), '\t');
      assert.equal(opaqueSend('\x1b[9;2:2u')?.consume, true); assert.equal(opaqueFocus, opaqueEditor, 'repeat alone cannot activate a stock loan');
      assert.equal(opaqueSend('\x1b[Z')?.consume, true); assert.equal(opaqueFocus, opaqueWidget);
      opaqueWidget.render(120); opaqueSend('ab'); opaqueSend('\x1b[D');
      assert.match(opaqueWidget.render(120).join('\n'), /Shift\+Tab previous input/);
      assert.equal(opaqueSend('\x1b[Z')?.consume, true); assert.equal(opaqueFocus, opaqueEditor);
      const stockBlock = opaque.enqueue({ id: 'STOCK_BLOCK', mode: 'blocking', questions: [question('stock-block')] }); stockBlock.outcome!.catch(() => {});
      await Promise.resolve(); opaqueWidget.render(120);
      assert.equal(opaqueFocus, opaqueEditor, 'stock blocker cannot automatically interrupt unknown input');
      assert.equal(opaqueSend('\x1b[Z')?.consume, true); assert.equal(opaqueFocus, opaqueWidget);
      assert.equal(opaque.snapshot().current!.tab.groupId, 'STOCK_BLOCK');
      stockBlock.detach(); await Promise.resolve(); opaque.select('OPAQUE', 'opaque'); opaqueWidget.render(120); opaqueSend('X');
      assert.equal(opaque.snapshot().current!.reply, 'aXb', 'stock focus roundtrip retains original Input caret');
      opaque.suspend(true); assert.equal(opaqueFocus, opaqueEditor);
      assert.doesNotMatch(opaqueWidget.render(120).join('\n'), /Shift\+Tab|Ctrl\+\]|\/asks selects questions|Tab next question|Enter confirm/, 'known prompt span cannot advertise suppressed question entry');
      assert.equal(opaqueSend('\x1b[Z'), undefined, 'known SDK prompt span keeps its own ShiftTab');
      opaque.suspend(false); opaqueWidget.render(120); assert.equal(opaqueFocus, opaqueEditor, 'prompt completion is passive on stock SDK');
      assert.equal(opaque.activate(), true); assert.equal(opaqueFocus, opaqueWidget, 'explicit activation also works without editor identity');
      const ownedStockBlock = opaque.enqueue({ id: 'STOCK_OWNED_BLOCK', mode: 'blocking', questions: [question('owned-stock-block')] }); ownedStockBlock.outcome!.catch(() => {});
      await Promise.resolve(); assert.equal(opaqueFocus, opaqueWidget); assert.equal(opaque.snapshot().current!.tab.groupId, 'STOCK_OWNED_BLOCK', 'blocker retains priority within an explicitly owned stock pane');
      ownedStockBlock.detach(); await Promise.resolve(); opaque.select('OPAQUE', 'opaque');
      assert.equal(opaqueSend('\x1d')?.consume, true); assert.equal(opaqueFocus, opaqueEditor);
      const replacementInput = { handleInput() {} }; opaqueTui.children.splice(0, 1, replacementInput); opaqueFocus = replacementInput;
      assert.equal(opaqueSend('\x1d'), undefined, 'Ctrl] cannot reclaim a lost loan');
      const lostCollapsedFrame = opaqueWidget.render(120).join('\n');
      assert.doesNotMatch(lostCollapsedFrame, /ctrl\+\] reopens|ctrl\+\] returns/i, 'collapsed reentry hint follows an admissible route, not the configured key');
      assert.match(lostCollapsedFrame, /shift\+tab reopens|\/asks reopens/i);
      assert.equal(opaque.activate(), true, 'explicit activation can establish a fresh loan from the current mounted input');
      assert.equal(opaque.snapshot().current!.reply, 'aXb', 'lost-origin collapse and explicit reentry retain the original draft');
      opaqueTui.children.splice(0, 1, { handleInput() {} });
      assert.equal(opaqueSend('\x1b[Z'), undefined); assert.equal(opaqueFocus, opaqueWidget, 'lost origin is never replaced by a guessed target');
      opaque.dispose(); assert.equal(opaqueFocus, null, 'retiring a lost stock loan clears focus rather than guessing');
      stockPending.detach(); assert.equal(opaqueInput, undefined);
      const noWidget = createQuestionHost({ ui: {} });
      assert.throws(() => noWidget.enqueue({ id: 'NO_WIDGET', mode: 'async', questions: [question('no-widget')], commit() {} }), { code: 'unsupported_host' });
      noWidget.dispose();

      let limitedWidget: any, limitedFocus: any = editor;
      const limitedTui = { ...tui, getFocusedComponent() { return limitedFocus; }, setFocus(next: any) { limitedFocus = next; } };
      const limited = createQuestionHost({ ui: {
        getCoreEditor() { return editor; },
        setWidget(_key: string, factory: any) { if (factory) limitedWidget = factory(limitedTui, ctx.ui.theme); else limitedWidget?.dispose(); },
      } });
      limited.enqueue({ id: 'LIMITED', mode: 'async', questions: [question('limited')], commit() {} }); await Promise.resolve();
      const limitedSurface = limitedFocus;
      assert.notEqual(limitedSurface, editor);
      assert.doesNotMatch(limitedWidget.render(100).join('\n'), /Shift\+Tab Chat|returns to questions/);
      limitedSurface.handleInput('\x1b[Z'); assert.equal(limitedFocus, limitedSurface);
      limited.dispose();

      // Every focus decision rereads the owner identity. Replacement core
      // editors are selected automatically; equally capable foreign surfaces
      // never become a fallback target at render or disposal boundaries.
      let ownedCore: any = { handleInput() {} }, identityFocus: any = ownedCore, identityWidget: any;
      let identityInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
      const identityTui = { children: [ownedCore], terminal: { rows: 18, columns: 80 }, requestRender() {},
        getFocusedComponent() { return identityFocus; }, setFocus(next: any) { identityFocus = next; } };
      const identityContext = { ui: {
        getCoreEditor() { return ownedCore; },
        onTerminalInput(handler: typeof identityInput) { identityInput = handler; return () => { identityInput = undefined; }; },
        setWidget(_key: string, factory: any) { if (factory) identityWidget = factory(identityTui, ctx.ui.theme); else identityWidget?.dispose(); },
      } };
      const identitySend = (data: string) => { const result = identityInput?.(data); if (!result?.consume) identityFocus?.handleInput?.(data); return result; };
      const identityHost = createQuestionHost(identityContext);
      identityHost.enqueue({ id: 'IDENTITY', mode: 'async', questions: [question('identity')], commit() {} }); await Promise.resolve();
      const identitySurface = identityFocus;
      const successorCore = { handleInput() {} }; ownedCore = successorCore; identityTui.children.splice(0, 1, successorCore); identityFocus = successorCore;
      identityWidget.render(100); assert.equal(identityFocus, identitySurface, 'replacement core identity automatically returns to the question');
      assert.equal(identitySend('\x1b[Z')?.consume, true); assert.equal(identityFocus, successorCore, 'focus toggle uses the fresh replacement identity');

      const laterForeign = new Editor(identityTui as any, { borderColor: (text: string) => text, selectList: {} } as any);
      identityTui.children.splice(0, 1, laterForeign as any); identityFocus = laterForeign; identityWidget.render(100); identityWidget.render(100);
      assert.equal(identityFocus, laterForeign, 'foreign SDK Editor stays focused during a Chat loan without suspend');
      identityTui.children.splice(0, 1, successorCore); identityFocus = successorCore; identityWidget.render(100);
      assert.equal(identityFocus, successorCore, 'returning core stays in Chat until the explicit toggle');
      identitySend('\x1b[Z'); assert.equal(identityFocus, identitySurface);
      identitySend('\x1d'); assert.equal(identityFocus, successorCore);
      identityTui.children.splice(0, 1, laterForeign as any); identityFocus = laterForeign; identityWidget.render(100);
      assert.equal(identityFocus, laterForeign, 'foreign SDK Editor stays focused while the question is collapsed');
      identityTui.children.splice(0, 1, successorCore); identityFocus = successorCore; identitySend('\x1d'); assert.equal(identityFocus, identitySurface);
      identitySend('\x1b'); await Promise.resolve(); assert.equal(identityFocus, successorCore);
      identityTui.children.splice(0, 1, laterForeign as any); identityFocus = laterForeign; identityWidget.render(100);
      assert.equal(identityFocus, laterForeign, 'foreign SDK Editor stays focused while the question is paused');
      identityTui.children.splice(0, 1, successorCore); identityFocus = successorCore; identitySend('\x1b[Z'); assert.equal(identityFocus, identitySurface);
      identityHost.dispose(); assert.equal(identityFocus, successorCore, 'disposal returns only to the current mounted core identity');

      return { content: [{ type: 'text', text: 'Question focus-toggle SDK navigation passed' }], details: {
        questionTabsOnly: true, focusToggle: true, nativeChatTab: true, retiredGlobalCycle: true,
        configurableToggle: true, collapseIndependent: true, publicEditorCapability: true,
        selectedSolidPassiveDotted: true, boundedSmallTerminal: true, questionCaretUndoNotesRetained: true,
        ordinaryDraftRetained: true, pausedReturn: true, localReveal: true, blockerPreemption: true,
        foreignFocusRetained: true, replacementIdentityControl: true, foreignLifecycleControl: true,
        stockPassiveExplicitLoan: true, stockBlockerNoInterruption: true, stockLostOriginNoGuess: true,
        stockForeignSpanNativeKeys: true, passiveFooterUsesActualFocus: true, knownPromptHidesUnavailableRoutes: true,
        collapsedHintUsesAvailableRoute: true, suspendedProjectionInactive: true, oneShotGuards: true, physicalPty: false,
      } };
    },
  });
}
