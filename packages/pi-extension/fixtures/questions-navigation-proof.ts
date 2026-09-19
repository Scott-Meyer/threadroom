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
      assert.equal(focus, editor, 'async arrival stays passive even when the SDK identifies its core editor');
      assert.match(widget.render(120).join('\n'), /┈/);
      assert.equal(send('\x1b[Z')?.consume, true, 'Shift+Tab explicitly enters a passive async pane');
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
      send('\t'); assert.equal(host.snapshot().current!.tab.questionId, 'n1', 'ordinary Tab wraps across required and async tabs in the one surface');
      assert.match(widget.render(120).join('\n'), /★ Response required/);
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, questionSurface, 'a pending blocker keeps the shared question surface modal');
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, questionSurface, 'a pending blocker cannot be collapsed');
      send('\x1bn'); for (const char of 'note') send(char); send('\x1b[D');
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(send('\x1b[Z')?.consume, true); send('X');
      assert.equal(host.snapshot().current!.notes, 'notXe', 'focus toggling retains the notes Editor caret');
      send('\x1bn'); host.select('A', 'a'); send('\x1b'); await Promise.resolve();
      assert.equal(host.snapshot().current!.tab.groupId, 'N', 'pausing an async tab returns to the required group');
      notesGroup.detach(); await Promise.resolve();
      assert.equal(focus, questionSurface); assert.equal(host.snapshot().current!.tab.groupId, 'B', 'pane-owned blocker completion keeps an unpaused async tab open');
      host.select('A', 'a'); await Promise.resolve();

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
      host.select('B', 'b'); await Promise.resolve(); assert.equal(focus, editor, 'programmatic async selection remains passive');
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, questionSurface);
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, editor);
      host.select('A', 'a'); await Promise.resolve(); assert.equal(focus, editor);
      assert.equal(send('\x1b[Z')?.consume, true); assert.equal(focus, questionSurface);
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
      const foreignPrompt = { handleInput() {} }; tui.children.push(foreignPrompt); focus = foreignPrompt; widget.render(120);
      assert.equal(focus, foreignPrompt, 'public core identity prevents a blocker from stealing an unannounced foreign prompt');
      assert.equal(send('\x1b[Z'), undefined, 'the blocker does not consume a foreign prompt key');
      host.suspend(true);
      assert.match(widget.render(120).join('\n'), /waiting for current Pi prompt/, 'suspended blocker copy names the prompt that currently owns input');
      assert.doesNotMatch(widget.render(120).join('\n'), /returning to questions/);
      const later = host.enqueue({ id: 'E', mode: 'blocking', questions: [question('e')] }); later.outcome!.catch(() => {}); await Promise.resolve();
      assert.equal(focus, foreignPrompt, 'known foreign prompt keeps focus for its lifetime');
      tui.children.pop(); focus = editor; host.suspend(false); assert.equal(focus, questionSurface, 'the blocker reclaims Chat when the foreign prompt ends');
      host.dispose();

      // The single focus-toggle key is configurable or can be disabled. A
      // custom toggle does not steal Tab or Shift+Tab from Chat.
      focus = editor; editor.setText('kept');
      const custom = createQuestionHost(context, { focusToggleKey: 'ctrl+g', collapseKey: false });
      custom.enqueue({ id: 'CUSTOM', mode: 'async', questions: [question('custom')], commit() {} }); await Promise.resolve();
      assert.equal(focus, editor); assert.match(widget.render(120).join('\n'), /Ctrl\+G questions|ctrl\+g questions/);
      assert.equal(send('\x07')?.consume, true); const customSurface = focus;
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
      assert.equal(focus, editor); assert.equal(disabled.activate(), true);
      const disabledSurface = focus;
      assert.doesNotMatch(widget.render(120).join('\n'), /Shift\+Tab Chat|returns to questions|ctrl\+tab/i);
      assert.equal(send('\x1b[Z'), undefined); assert.equal(focus, disabledSurface, 'disabled toggle does not hide or defocus the question');
      disabled.dispose();

      // Pane-owned blocker completion restores the visible pre-blocker tab,
      // rather than model fallback to an older collapsed tab.
      focus = editor;
      const collapsedFallback = createQuestionHost(context);
      collapsedFallback.enqueue({ id: 'COLLAPSED_A', mode: 'async', questions: [question('collapsed-a')], commit() {} });
      collapsedFallback.enqueue({ id: 'VISIBLE_B', mode: 'async', questions: [question('visible-b')], commit() {} }); await Promise.resolve();
      assert.equal(send('\x1b[Z')?.consume, true); assert.notEqual(focus, editor);
      assert.equal(send('\x1d')?.consume, true); assert.equal(focus, editor, 'first async tab is collapsed');
      collapsedFallback.select('VISIBLE_B', 'visible-b'); assert.equal(collapsedFallback.activate(), true);
      const visibleSurface = focus, collapsedBlock = collapsedFallback.enqueue({ id: 'COLLAPSED_BLOCK', mode: 'blocking', questions: [question('collapsed-block')] });
      await Promise.resolve(); send('\x1b'); assert.equal((await collapsedBlock.outcome!).cancelled, true); await Promise.resolve();
      assert.equal(focus, visibleSurface); assert.equal(collapsedFallback.snapshot().current!.tab.groupId, 'VISIBLE_B', 'usable visible tab survives blocker completion');
      collapsedFallback.dispose();

      // Empty retirement resets modal ownership before this same host object is
      // mounted for a later batch.
      focus = editor;
      const reused = createQuestionHost(context);
      const oldAsync = reused.enqueue({ id: 'REUSE_ASYNC_1', mode: 'async', questions: [question('reuse-async-1')], commit() {} });
      assert.equal(reused.activate(), true);
      const oldBlock = reused.enqueue({ id: 'REUSE_BLOCK_1', mode: 'blocking', questions: [question('reuse-block-1')] }); oldBlock.outcome!.catch(() => {});
      await Promise.resolve(); assert.notEqual(focus, editor);
      oldBlock.detach(); oldAsync.detach(); await Promise.resolve();
      assert.equal(focus, editor);
      reused.enqueue({ id: 'REUSE_ASYNC_2', mode: 'async', questions: [question('reuse-async-2')], commit() {} }); await Promise.resolve();
      assert.equal(focus, editor);
      const newBlock = reused.enqueue({ id: 'REUSE_BLOCK_2', mode: 'blocking', questions: [question('reuse-block-2')] }); await Promise.resolve();
      assert.notEqual(focus, editor); send('\x1b'); assert.equal((await newBlock.outcome!).cancelled, true); await Promise.resolve();
      assert.equal(focus, editor, 'a reused host restores the input claimed by its new modal batch');
      reused.dispose();

      // A blocker that actually reclaims an authoritative replacement core
      // records that fresh loan, then unwinds to the same replacement.
      let exactCore: any = { handleInput() {} }, exactFocus: any = exactCore, exactWidget: any;
      const replacementKeys: string[] = [], replacementCore = { handleInput(data: string) { replacementKeys.push(data); } };
      const exactTui = { children: [exactCore], terminal: { rows: 18, columns: 80 }, requestRender() {},
        getFocusedComponent() { return exactFocus; }, setFocus(next: any) { exactFocus = next; } };
      const exactHost = createQuestionHost({ ui: {
        getCoreEditor() { return exactCore; },
        setWidget(_key: string, factory: any) { if (factory) { exactWidget = factory(exactTui, ctx.ui.theme); exactTui.children.push(exactWidget); } else { exactWidget?.dispose(); exactTui.children = exactTui.children.filter((item: any) => item !== exactWidget); } },
      } });
      exactHost.enqueue({ id: 'EXACT_ASYNC', mode: 'async', questions: [question('exact-async')], commit() {} }); await Promise.resolve();
      const exactForeign = { handleInput() {} }; exactTui.children.push(exactForeign); exactFocus = exactForeign;
      const claimedCore = exactCore, exactBlock = exactHost.enqueue({ id: 'EXACT_BLOCK', mode: 'blocking', questions: [question('exact-block')] }); await Promise.resolve();
      const exactForeignFrame = exactWidget.render(100).join('\n'); assert.equal(exactFocus, exactForeign, 'a blocker does not record or steal foreign focus as its return origin');
      assert.match(exactForeignFrame, /waiting for current Pi prompt/, 'authoritative unannounced foreign focus gets truthful suspended copy');
      exactTui.children = exactTui.children.filter((item: any) => item !== exactForeign); exactFocus = claimedCore; exactWidget.render(100);
      assert.equal(exactFocus, exactWidget, 'the blocker claims the core editor after the foreign prompt ends');
      exactCore = replacementCore; exactTui.children.unshift(replacementCore); exactFocus = replacementCore;
      exactWidget.render(100); assert.equal(exactFocus, exactWidget, 'required pane reclaims the authoritative replacement core');
      exactWidget.handleInput('\x1b'); assert.equal((await exactBlock.outcome!).cancelled, true); await Promise.resolve();
      assert.equal(exactFocus, replacementCore, 'reclaimed replacement core becomes the modal unwind target');

      // An unannounced overlay may finish a blocker while it owns focus. Its
      // eventual preFocus restoration to Questions must pay the deferred unwind.
      const overlayBlock = exactHost.enqueue({ id: 'OVERLAY_BLOCK', mode: 'blocking', questions: [question('overlay-block')] }); overlayBlock.outcome!.catch(() => {});
      await Promise.resolve(); assert.equal(exactFocus, exactWidget);
      const overlay = { handleInput() {} }; exactTui.children.push(overlay); exactFocus = overlay;
      overlayBlock.detach(); await Promise.resolve(); exactWidget.render(100);
      assert.equal(exactFocus, overlay, 'blocker completion never steals an unannounced overlay');
      const interveningBlock = exactHost.enqueue({ id: 'INTERVENING_BLOCK', mode: 'blocking', questions: [question('intervening-block')] });
      await Promise.resolve(); assert.equal(exactFocus, overlay);
      exactTui.children = exactTui.children.filter((item: any) => item !== overlay); exactFocus = exactWidget;
      exactWidget.handleInput('Q');
      assert.equal(exactFocus, exactWidget, 'deferred unwind cannot bypass a newer blocker');
      assert.equal(exactHost.snapshot().current!.reply, 'Q', 'first restored input remains inside the newer required question');
      assert.notEqual(replacementKeys.at(-1), 'Q');
      exactWidget.handleInput('\x1b'); assert.equal((await interveningBlock.outcome!).cancelled, true); await Promise.resolve(); exactWidget.render(100);
      assert.equal(exactFocus, replacementCore, 'deferred modal unwind is paid after the newer blocker completes');
      exactFocus = exactWidget; exactWidget.handleInput('L');
      assert.equal(exactFocus, replacementCore); assert.equal(replacementKeys.at(-1), 'L', 'repeated live-pane restoration still honors the settled modal return');
      assert.equal(exactHost.snapshot().current!.reply, '', 'settled return keeps repeated input out of the passive async draft');

      // If an overlay restores Questions and a blocker arrives before the first
      // unwind, that blocker is pane-owned. Reclaiming a newer authoritative
      // core still establishes the fresh loan and supersedes the older debt.
      const paneDebt = exactHost.enqueue({ id: 'PANE_DEBT', mode: 'blocking', questions: [question('pane-debt')] }); paneDebt.outcome!.catch(() => {});
      await Promise.resolve(); const paneOverlay = { handleInput() {} }; exactTui.children.push(paneOverlay); exactFocus = paneOverlay;
      paneDebt.detach(); await Promise.resolve(); assert.equal(exactFocus, paneOverlay);
      exactTui.children = exactTui.children.filter((item: any) => item !== paneOverlay); exactFocus = exactWidget;
      const paneOwnedBlock = exactHost.enqueue({ id: 'PANE_OWNED_BLOCK', mode: 'blocking', questions: [question('pane-owned-block')] });
      await Promise.resolve(); assert.equal(exactFocus, exactWidget);
      const newestCore = { handleInput() {} }; exactCore = newestCore; exactTui.children.unshift(newestCore); exactFocus = newestCore;
      exactWidget.render(100); assert.equal(exactFocus, exactWidget, 'pane-owned blocker reclaims the newer authoritative core');
      exactWidget.handleInput('\x1b'); assert.equal((await paneOwnedBlock.outcome!).cancelled, true); await Promise.resolve();
      assert.equal(exactFocus, newestCore, 'fresh pane-owned reclaim supersedes older deferred debt');

      const explicitPaneDebt = exactHost.enqueue({ id: 'EXPLICIT_PANE_DEBT', mode: 'blocking', questions: [question('explicit-pane-debt')] }); explicitPaneDebt.outcome!.catch(() => {});
      await Promise.resolve(); const explicitPaneOverlay = { handleInput() {} }; exactTui.children.push(explicitPaneOverlay); exactFocus = explicitPaneOverlay;
      explicitPaneDebt.detach(); await Promise.resolve(); exactTui.children = exactTui.children.filter((item: any) => item !== explicitPaneOverlay); exactFocus = exactWidget;
      assert.equal(exactHost.activate(), true); exactWidget.render(100); assert.equal(exactFocus, exactWidget, 'explicit activation supersedes deferred return even when overlay already restored the pane');
      exactWidget.handleInput('E'); assert.equal(exactHost.snapshot().current!.reply, 'E');
      exactHost.dispose();

      // Deferred unwind also survives empty-widget retirement when the blocker
      // was the last tab and an overlay still retains the old pane as preFocus.
      const retiredKeys: string[] = [], retiredCore = { handleInput(data: string) { retiredKeys.push(data); } };
      let retiredFocus: any = retiredCore, retiredWidget: any;
      const retiredTui = { children: [retiredCore], terminal: { rows: 18, columns: 80 }, requestRender() {},
        getFocusedComponent() { return retiredFocus; }, setFocus(next: any) { retiredFocus = next; } };
      const retiredHost = createQuestionHost({ ui: {
        getCoreEditor() { return retiredCore; },
        setWidget(_key: string, factory: any) {
          if (factory) { retiredWidget = factory(retiredTui, ctx.ui.theme); retiredTui.children.push(retiredWidget); }
          else { retiredWidget?.dispose(); retiredTui.children = retiredTui.children.filter((item: any) => item !== retiredWidget); }
        },
      } });
      const retiredBlock = retiredHost.enqueue({ id: 'RETIRED_BLOCK', mode: 'blocking', questions: [question('retired-block')] }); retiredBlock.outcome!.catch(() => {});
      await Promise.resolve(); assert.equal(retiredFocus, retiredWidget);
      const retiredOverlay = { handleInput() {} }; retiredTui.children.push(retiredOverlay); retiredFocus = retiredOverlay;
      retiredBlock.detach(); await Promise.resolve(); assert.equal(retiredFocus, retiredOverlay);
      retiredTui.children = retiredTui.children.filter((item: any) => item !== retiredOverlay); retiredFocus = retiredWidget;
      retiredWidget.handleInput('R');
      assert.equal(retiredFocus, retiredCore); assert.equal(retiredKeys.at(-1), 'R', 'retired pane hands first restored input to its exact modal origin');
      retiredHost.dispose();

      const suspendedRetiredKeys: string[] = [], suspendedRetiredCore = { handleInput(data: string) { suspendedRetiredKeys.push(data); } };
      let suspendedRetiredFocus: any = suspendedRetiredCore, suspendedRetiredWidget: any;
      const suspendedRetiredTui = { children: [suspendedRetiredCore], terminal: { rows: 18, columns: 80 }, requestRender() {}, getFocusedComponent() { return suspendedRetiredFocus; }, setFocus(next: any) { suspendedRetiredFocus = next; } };
      const suspendedRetiredHost = createQuestionHost({ ui: { getCoreEditor() { return suspendedRetiredCore; }, setWidget(_key: string, factory: any) { if (factory) { suspendedRetiredWidget = factory(suspendedRetiredTui, ctx.ui.theme); suspendedRetiredTui.children.push(suspendedRetiredWidget); } else { suspendedRetiredWidget?.dispose(); suspendedRetiredTui.children = suspendedRetiredTui.children.filter((item: any) => item !== suspendedRetiredWidget); } } } });
      const suspendedRetiredBlock = suspendedRetiredHost.enqueue({ id: 'SUSPENDED_RETIRED', mode: 'blocking', questions: [question('suspended-retired')] }); suspendedRetiredBlock.outcome!.catch(() => {}); await Promise.resolve();
      suspendedRetiredHost.suspend(true); suspendedRetiredBlock.detach(); await Promise.resolve(); suspendedRetiredFocus = suspendedRetiredWidget;
      suspendedRetiredWidget.handleInput('H'); assert.equal(suspendedRetiredFocus, suspendedRetiredWidget); assert.equal(suspendedRetiredKeys.length, 0, 'retired pane cannot bypass known suspension without a successor');
      suspendedRetiredHost.suspend(false); suspendedRetiredWidget.handleInput('H'); assert.equal(suspendedRetiredFocus, suspendedRetiredCore); assert.equal(suspendedRetiredKeys.at(-1), 'H', 'retired exact debt survives the known prompt span');
      suspendedRetiredHost.dispose();

      // Empty retirement and later stale restoration keep the settled exact
      // origin instead of falling through to a newer authoritative core.
      const settledKeys: string[] = [], settledCore = { handleInput(data: string) { settledKeys.push(data); } }, laterCore = { handleInput() {} };
      let settledAuthoritative: any = settledCore, settledFocus: any = settledCore, settledWidget: any;
      const settledTui = { children: [settledCore], terminal: { rows: 18, columns: 80 }, requestRender() {}, getFocusedComponent() { return settledFocus; }, setFocus(next: any) { settledFocus = next; } };
      const settledHost = createQuestionHost({ ui: { getCoreEditor() { return settledAuthoritative; }, setWidget(_key: string, factory: any) { if (factory) { settledWidget = factory(settledTui, ctx.ui.theme); settledTui.children.push(settledWidget); } else { settledWidget?.dispose(); settledTui.children = settledTui.children.filter((item: any) => item !== settledWidget); } } } });
      const settledAsync = settledHost.enqueue({ id: 'SETTLED_ASYNC', mode: 'async', questions: [question('settled-async')], commit() {} });
      const settledBlock = settledHost.enqueue({ id: 'SETTLED_BLOCK', mode: 'blocking', questions: [question('settled-block')] }); await Promise.resolve();
      settledWidget.handleInput('\x1b'); assert.equal((await settledBlock.outcome!).cancelled, true); await Promise.resolve(); assert.equal(settledFocus, settledCore);
      settledAuthoritative = laterCore; settledTui.children.unshift(laterCore); settledFocus = settledWidget; settledAsync.detach(); await Promise.resolve();
      assert.equal(settledFocus, settledCore, 'empty retirement honors settled origin rather than newer core');
      settledFocus = settledWidget; settledWidget.handleInput('J'); assert.equal(settledFocus, settledCore); assert.equal(settledKeys.at(-1), 'J', 'retired pane preserves settled origin for later stale restoration');
      settledHost.dispose();

      // A retired pane with deferred return never bypasses a newer question
      // owner that mounted before the overlay restored stale preFocus.
      const successorNewKeys: string[] = [];
      const successorBaseCore = { handleInput() {} }, successorNewCore = { handleInput(data: string) { successorNewKeys.push(data); } };
      let successorAuthoritative = successorBaseCore, successorFocus: any = successorBaseCore;
      let activeSuccessorWidget: any, retiredSuccessorPane: any;
      const successorTui = { children: [successorBaseCore], terminal: { rows: 18, columns: 80 }, requestRender() {},
        getFocusedComponent() { return successorFocus; }, setFocus(next: any) { successorFocus = next; } };
      const successorContext = { ui: {
        getCoreEditor() { return successorAuthoritative; },
        setWidget(_key: string, factory: any) {
          if (!factory) {
            if (activeSuccessorWidget) { retiredSuccessorPane = activeSuccessorWidget; activeSuccessorWidget.dispose(); successorTui.children = successorTui.children.filter((item: any) => item !== activeSuccessorWidget); activeSuccessorWidget = undefined; }
          } else { activeSuccessorWidget = factory(successorTui, ctx.ui.theme); successorTui.children.push(activeSuccessorWidget); }
        },
      } };
      const outgoing = createQuestionHost(successorContext), outgoingBlock = outgoing.enqueue({ id: 'OUTGOING_BLOCK', mode: 'blocking', questions: [question('outgoing-block')] }); outgoingBlock.outcome!.catch(() => {});
      await Promise.resolve(); assert.equal(successorFocus, activeSuccessorWidget);
      const successorOverlay = { handleInput() {} }; successorTui.children.push(successorOverlay); successorFocus = successorOverlay;
      outgoingBlock.detach(); await Promise.resolve(); assert.ok(retiredSuccessorPane);
      const claimedRetiredPane = retiredSuccessorPane;
      const incoming = createQuestionHost(successorContext);
      incoming.enqueue({ id: 'INCOMING_ASYNC', mode: 'async', questions: [question('incoming-async')], commit() {} });
      const incomingBlock = incoming.enqueue({ id: 'INCOMING_BLOCK', mode: 'blocking', questions: [question('incoming-block')] });
      await Promise.resolve(); assert.equal(successorFocus, successorOverlay);
      successorAuthoritative = successorNewCore; successorTui.children.unshift(successorNewCore);
      successorTui.children = successorTui.children.filter((item: any) => item !== successorOverlay); successorFocus = successorNewCore;
      activeSuccessorWidget.render(100); assert.equal(successorFocus, activeSuccessorWidget, 'successor first claims its newer authoritative core');
      successorFocus = retiredSuccessorPane; retiredSuccessorPane.handleInput('S');
      assert.equal(successorFocus, activeSuccessorWidget); assert.equal(incoming.snapshot().current!.reply, 'S', 'stale input hands off to the newer required owner first');
      activeSuccessorWidget.handleInput('\x1b'); assert.equal((await incomingBlock.outcome!).cancelled, true); await Promise.resolve();
      assert.equal(successorFocus, successorNewCore, 'older inherited debt cannot replace a successor modal loan already claimed from a newer core');
      successorFocus = retiredSuccessorPane; retiredSuccessorPane.handleInput('W');
      assert.equal(successorFocus, successorNewCore); assert.equal(successorNewKeys.at(-1), 'W', 'completed newer modal return also outranks a later stale-pane debt');
      assert.equal(incoming.snapshot().current!.reply, '', 'post-completion stale input does not edit the remaining async draft');
      outgoing.dispose(); incoming.dispose();
      const afterClaimCore = { handleInput() {} }; successorAuthoritative = afterClaimCore; successorTui.children.unshift(afterClaimCore); successorFocus = claimedRetiredPane; claimedRetiredPane.handleInput('Y');
      assert.equal(successorFocus, successorNewCore); assert.equal(successorNewKeys.at(-1), 'Y', 'retired tombstone keeps successor newer route after successor retirement');

      // An unclaimed successor still adopts the outgoing debt, so cancelling
      // its blocker returns correctly even when an async tab remains.
      successorAuthoritative = successorNewCore; successorFocus = successorNewCore; retiredSuccessorPane = undefined;
      const outgoingAdopt = createQuestionHost(successorContext), adoptDebt = outgoingAdopt.enqueue({ id: 'ADOPT_DEBT', mode: 'blocking', questions: [question('adopt-debt')] }); adoptDebt.outcome!.catch(() => {});
      await Promise.resolve(); const adoptOverlay = { handleInput() {} }; successorTui.children.push(adoptOverlay); successorFocus = adoptOverlay;
      adoptDebt.detach(); await Promise.resolve();
      const incomingAdopt = createQuestionHost(successorContext); incomingAdopt.enqueue({ id: 'ADOPT_ASYNC', mode: 'async', questions: [question('adopt-async')], commit() {} });
      const adoptBlock = incomingAdopt.enqueue({ id: 'ADOPT_BLOCK', mode: 'blocking', questions: [question('adopt-block')] }); await Promise.resolve();
      successorTui.children = successorTui.children.filter((item: any) => item !== adoptOverlay); successorFocus = retiredSuccessorPane; retiredSuccessorPane.handleInput('T');
      assert.equal(incomingAdopt.snapshot().current!.reply, 'T'); activeSuccessorWidget.handleInput('\x1b'); assert.equal((await adoptBlock.outcome!).cancelled, true); await Promise.resolve();
      assert.equal(successorFocus, successorNewCore, 'unclaimed successor repays adopted debt with async work remaining'); outgoingAdopt.dispose(); incomingAdopt.dispose();

      // Passive async-only successors adopt and remember an outgoing return;
      // repeated stale overlay restoration keeps sending input to that origin.
      successorFocus = successorNewCore; successorAuthoritative = successorNewCore; retiredSuccessorPane = undefined;
      const outgoingPassive = createQuestionHost(successorContext), passiveDebt = outgoingPassive.enqueue({ id: 'PASSIVE_DEBT', mode: 'blocking', questions: [question('passive-debt')] }); passiveDebt.outcome!.catch(() => {});
      await Promise.resolve(); const passiveOverlay = { handleInput() {} }; successorTui.children.push(passiveOverlay); successorFocus = passiveOverlay; passiveDebt.detach(); await Promise.resolve();
      const passiveRetiredPane = retiredSuccessorPane;
      const incomingPassive = createQuestionHost(successorContext); incomingPassive.enqueue({ id: 'PASSIVE_ASYNC', mode: 'async', questions: [question('passive-async')], commit() {} }); await Promise.resolve();
      successorTui.children = successorTui.children.filter((item: any) => item !== passiveOverlay); successorFocus = passiveRetiredPane; passiveRetiredPane.handleInput('P');
      assert.equal(successorFocus, successorNewCore); assert.equal(successorNewKeys.at(-1), 'P'); assert.equal(incomingPassive.snapshot().current!.reply, '');
      successorFocus = passiveRetiredPane; passiveRetiredPane.handleInput('Q');
      assert.equal(successorFocus, successorNewCore); assert.equal(successorNewKeys.at(-1), 'Q', 'repaid adopted debt remains newer than repeated stale-pane restoration');
      outgoingPassive.dispose(); incomingPassive.dispose();
      const postPassiveCore = { handleInput() {} }; successorAuthoritative = postPassiveCore; successorTui.children.unshift(postPassiveCore); successorFocus = passiveRetiredPane; passiveRetiredPane.handleInput('R');
      assert.equal(successorFocus, successorNewCore); assert.equal(successorNewKeys.at(-1), 'R', 'outgoing tombstone preserves exact routing after its successor retires');

      // A successor in a known prompt span rejects stale handoff without
      // changing focus or forgetting the debt; it can accept after the span.
      successorAuthoritative = successorNewCore; successorFocus = successorNewCore; retiredSuccessorPane = undefined;
      const outgoingSuspended = createQuestionHost(successorContext), suspendedDebt = outgoingSuspended.enqueue({ id: 'SUSPENDED_DEBT', mode: 'blocking', questions: [question('suspended-debt')] }); suspendedDebt.outcome!.catch(() => {});
      await Promise.resolve(); const suspendedOverlay = { handleInput() {} }; successorTui.children.push(suspendedOverlay); successorFocus = suspendedOverlay; suspendedDebt.detach(); await Promise.resolve();
      const incomingSuspended = createQuestionHost(successorContext); incomingSuspended.enqueue({ id: 'SUSPENDED_ASYNC', mode: 'async', questions: [question('suspended-async')], commit() {} }); await Promise.resolve(); incomingSuspended.suspend(true);
      const beforeSuspendedKeys = successorNewKeys.length; successorFocus = retiredSuccessorPane; retiredSuccessorPane.handleInput('K');
      assert.equal(successorFocus, retiredSuccessorPane); assert.equal(successorNewKeys.length, beforeSuspendedKeys); assert.equal(incomingSuspended.snapshot().current!.reply, '', 'known prompt span rejects stale successor input');
      incomingSuspended.suspend(false); retiredSuccessorPane.handleInput('K');
      assert.equal(successorFocus, successorNewCore); assert.equal(successorNewKeys.at(-1), 'K', 'rejected handoff debt remains available after known prompt completion');
      outgoingSuspended.dispose(); incomingSuspended.dispose();

      // Conversely, explicit async ownership is a newer loan and rejects an
      // older retired pane's debt rather than losing its first restored key.
      successorFocus = successorNewCore; retiredSuccessorPane = undefined;
      const outgoingExplicit = createQuestionHost(successorContext), explicitDebt = outgoingExplicit.enqueue({ id: 'EXPLICIT_DEBT', mode: 'blocking', questions: [question('explicit-debt')] }); explicitDebt.outcome!.catch(() => {});
      await Promise.resolve(); const explicitOverlay = { handleInput() {} }; successorTui.children.push(explicitOverlay); successorFocus = explicitOverlay;
      explicitDebt.detach(); await Promise.resolve(); const explicitRetiredPane = retiredSuccessorPane;
      const incomingExplicit = createQuestionHost(successorContext); incomingExplicit.enqueue({ id: 'EXPLICIT_ASYNC', mode: 'async', questions: [question('explicit-async')], commit() {} }); await Promise.resolve();
      const successorNewestCore = { handleInput() {} }; successorAuthoritative = successorNewestCore; successorTui.children.unshift(successorNewestCore);
      successorTui.children = successorTui.children.filter((item: any) => item !== explicitOverlay); successorFocus = successorNewestCore;
      assert.equal(incomingExplicit.activate(), true); successorFocus = explicitRetiredPane; explicitRetiredPane.handleInput('U');
      assert.equal(successorFocus, activeSuccessorWidget); assert.equal(incomingExplicit.snapshot().current!.reply, 'U', 'explicit async successor rejects older debt and retains first input');
      const homeKeys: string[] = [], replacementHome = { handleInput(data: string) { homeKeys.push(data); } }; successorAuthoritative = replacementHome; successorTui.children.unshift(replacementHome);
      successorFocus = explicitRetiredPane; explicitRetiredPane.handleInput('\x1b'); assert.equal(successorFocus, replacementHome, 'first handed-off Escape records the actual home transition');
      successorFocus = explicitRetiredPane; explicitRetiredPane.handleInput('V'); assert.equal(successorFocus, replacementHome); assert.equal(homeKeys.at(-1), 'V');
      outgoingExplicit.dispose(); incomingExplicit.dispose();
      const afterHome = { handleInput() {} }; successorAuthoritative = afterHome; successorTui.children.unshift(afterHome); successorFocus = explicitRetiredPane; explicitRetiredPane.handleInput('W');
      assert.equal(successorFocus, replacementHome); assert.equal(homeKeys.at(-1), 'W', 'retired tombstone records the actual successor home route');

      // Existing newer deferred debt also outranks inherited debt while a
      // successor blocker is waiting but has not claimed an input itself.
      successorAuthoritative = successorNewestCore; successorFocus = successorNewestCore; retiredSuccessorPane = undefined;
      const outgoingOlder = createQuestionHost(successorContext), olderDebt = outgoingOlder.enqueue({ id: 'OLDER_DEBT', mode: 'blocking', questions: [question('older-debt')] }); olderDebt.outcome!.catch(() => {});
      await Promise.resolve(); const olderOverlay = { handleInput() {} }; successorTui.children.push(olderOverlay); successorFocus = olderOverlay;
      olderDebt.detach(); await Promise.resolve(); successorTui.children = successorTui.children.filter((item: any) => item !== olderOverlay);
      const deferredCoreKeys: string[] = [], deferredCore = { handleInput(data: string) { deferredCoreKeys.push(data); } }; successorAuthoritative = deferredCore; successorTui.children.unshift(deferredCore); successorFocus = deferredCore;
      const incomingDeferred = createQuestionHost(successorContext); incomingDeferred.enqueue({ id: 'DEFERRED_ASYNC', mode: 'async', questions: [question('deferred-async')], commit() {} });
      const newerDebt = incomingDeferred.enqueue({ id: 'NEWER_DEBT', mode: 'blocking', questions: [question('newer-debt')] }); newerDebt.outcome!.catch(() => {}); await Promise.resolve();
      const newerOverlay = { handleInput() {} }; successorTui.children.push(newerOverlay); successorFocus = newerOverlay; newerDebt.detach(); await Promise.resolve();
      const waitingBlock = incomingDeferred.enqueue({ id: 'WAITING_BLOCK', mode: 'blocking', questions: [question('waiting-block')] }); await Promise.resolve();
      successorFocus = retiredSuccessorPane; retiredSuccessorPane.handleInput('V');
      assert.equal(incomingDeferred.snapshot().current!.reply, 'V', 'older inherited debt cannot replace an existing newer deferred return');
      activeSuccessorWidget.handleInput('\x1b'); assert.equal((await waitingBlock.outcome!).cancelled, true); await Promise.resolve(); activeSuccessorWidget.render(100);
      assert.equal(successorFocus, deferredCore, 'successor pays its newer deferred debt after the waiting blocker'); outgoingOlder.dispose(); incomingDeferred.dispose();

      // A paused successor still pays its own deferred exact return before the
      // home-loan route can fall through to a newer authoritative core.
      successorAuthoritative = deferredCore; successorFocus = deferredCore;
      const pausedSuccessor = createQuestionHost(successorContext); pausedSuccessor.enqueue({ id: 'PAUSED_ASYNC', mode: 'async', questions: [question('paused-async')], commit() {} }); await Promise.resolve();
      assert.equal(pausedSuccessor.activate(), true); activeSuccessorWidget.handleInput('\x1b'); assert.equal(successorFocus, deferredCore);
      const pausedDebt = pausedSuccessor.enqueue({ id: 'PAUSED_DEBT', mode: 'blocking', questions: [question('paused-debt')] }); pausedDebt.outcome!.catch(() => {}); await Promise.resolve();
      const pausedOverlay = { handleInput() {} }; successorTui.children.push(pausedOverlay); successorFocus = pausedOverlay; pausedDebt.detach(); await Promise.resolve();
      const pausedReplacement = { handleInput() {} }; successorAuthoritative = pausedReplacement; successorTui.children.unshift(pausedReplacement); successorFocus = retiredSuccessorPane; retiredSuccessorPane.handleInput('Z');
      assert.equal(successorFocus, deferredCore); assert.equal(deferredCoreKeys.at(-1), 'Z', 'paused successor services deferred return before isHomeLoan routing'); pausedSuccessor.dispose();

      // Stock successor fallback cannot replace a newer explicit origin merely
      // because that exact input has since unmounted.
      const stockOldKeys: string[] = [], stockOld = { handleInput(data: string) { stockOldKeys.push(data); } }, stockNew = { handleInput() {} }; let stockSuccessorFocus: any = stockOld, stockSuccessorWidget: any, stockRetiredPane: any;
      const stockSuccessorTui = { children: [stockOld], terminal: { rows: 18, columns: 80 }, requestRender() {}, getFocusedComponent() { return stockSuccessorFocus; }, setFocus(next: any) { stockSuccessorFocus = next; } };
      const stockSuccessorContext = { ui: { setWidget(_key: string, factory: any) { if (!factory) { if (stockSuccessorWidget) { stockRetiredPane = stockSuccessorWidget; stockSuccessorWidget.dispose(); stockSuccessorTui.children = stockSuccessorTui.children.filter((item: any) => item !== stockSuccessorWidget); stockSuccessorWidget = undefined; } } else { stockSuccessorWidget = factory(stockSuccessorTui, ctx.ui.theme); stockSuccessorTui.children.push(stockSuccessorWidget); } } } };
      const stockOutgoing = createQuestionHost(stockSuccessorContext), stockDebt = stockOutgoing.enqueue({ id: 'STOCK_OLD_DEBT', mode: 'blocking', questions: [question('stock-old-debt')] }); stockDebt.outcome!.catch(() => {}); await Promise.resolve();
      const stockOverlay = { handleInput() {} }; stockSuccessorTui.children.push(stockOverlay); stockSuccessorFocus = stockOverlay; stockDebt.detach(); await Promise.resolve();
      const stockOldPane = stockRetiredPane;
      const stockIncoming = createQuestionHost(stockSuccessorContext); stockIncoming.enqueue({ id: 'STOCK_NEW_ASYNC', mode: 'async', questions: [question('stock-new-async')], commit() {} }); await Promise.resolve();
      stockSuccessorTui.children = stockSuccessorTui.children.filter((item: any) => item !== stockOverlay); stockSuccessorFocus = stockOldPane;
      const stockIncomingBlock = stockIncoming.enqueue({ id: 'STOCK_INCOMING_BLOCK', mode: 'blocking', questions: [question('stock-incoming-block')] }); await Promise.resolve();
      assert.equal(stockSuccessorFocus, stockOldPane, 'stock blocker never claims an unmounted retired pane as input');
      stockOldPane.handleInput('O'); assert.equal(stockSuccessorFocus, stockSuccessorWidget); assert.equal(stockIncoming.snapshot().current!.reply, 'O');
      stockSuccessorWidget.handleInput('\x1b'); assert.equal((await stockIncomingBlock.outcome!).cancelled, true); await Promise.resolve(); assert.equal(stockSuccessorFocus, stockOld);
      stockSuccessorTui.children.push(stockNew); stockSuccessorFocus = stockNew; assert.equal(stockIncoming.activate(), true);
      stockSuccessorWidget.handleInput('\x1b');
      stockSuccessorTui.children = stockSuccessorTui.children.filter((item: any) => item !== stockNew && item !== stockOverlay); stockSuccessorFocus = stockOldPane; stockOldPane.handleInput('M'); assert.equal(stockSuccessorFocus, null);
      stockIncoming.dispose(); stockSuccessorFocus = stockOldPane; stockOldPane.handleInput('P');
      assert.equal(stockSuccessorFocus, null, 'accepted no-target successor route cannot revive older stock debt'); assert.equal(stockOldKeys.length, 0); stockOutgoing.dispose();

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
      opaque.suspend(true);
      const stockBlock = opaque.enqueue({ id: 'STOCK_BLOCK', mode: 'blocking', questions: [question('stock-block')] });
      await Promise.resolve(); assert.equal(opaqueFocus, opaqueEditor, 'a blocker waits for the current foreign prompt span');
      opaque.suspend(false);
      const requiredFrame = opaqueWidget.render(120).join('\n');
      assert.equal(opaqueFocus, opaqueWidget, 'a blocker claims the shared surface on stock Pi');
      assert.match(requiredFrame, /★ Response required/); assert.doesNotMatch(requiredFrame, /Shift\+Tab previous input|collapse/);
      const stockForeignKeys: string[] = [], stockForeign = { handleInput(data: string) { stockForeignKeys.push(data); } };
      opaqueTui.children.splice(0, 1, stockForeign); opaqueFocus = stockForeign; opaqueWidget.render(120);
      assert.equal(opaqueFocus, stockForeign, 'a stock modal loan does not steal a replacement after its origin is unmounted');
      assert.equal(opaqueSend('\x1b[Z'), undefined); assert.equal(stockForeignKeys.at(-1), '\x1b[Z', 'replacement prompt keeps its own toggle key');
      assert.equal(opaque.activate(), true); assert.equal(opaqueFocus, opaqueWidget, 'explicit /asks intent establishes a fresh stock modal loan');
      assert.equal(opaqueSend('\x1b[Z')?.consume, true); assert.equal(opaqueFocus, opaqueWidget, 'focus toggle cannot leave a blocker');
      assert.equal(opaqueSend('\x1d')?.consume, true); assert.equal(opaqueFocus, opaqueWidget, 'collapse cannot hide a blocker');
      assert.equal(opaque.snapshot().current!.tab.groupId, 'STOCK_BLOCK');
      opaqueSend('\t'); assert.equal(opaque.snapshot().current!.tab.groupId, 'OPAQUE', 'async questions remain reachable inside the modal surface');
      opaqueSend('X'); assert.equal(opaque.snapshot().current!.reply, 'aXb');
      opaqueSend('\x1b'); await Promise.resolve();
      assert.equal(opaque.snapshot().current!.tab.groupId, 'STOCK_BLOCK', 'pausing an async tab returns to the required question instead of escaping');
      assert.equal(opaqueFocus, opaqueWidget);
      opaqueSend('\x1b'); assert.equal((await stockBlock.outcome!).cancelled, true); await Promise.resolve(); opaqueWidget.render(120);
      assert.equal(opaqueFocus, stockForeign, 'cancelling the blocker restores the explicitly rebound stock input');
      assert.equal(opaque.snapshot().current!.reply, 'aXb', 'modal focus roundtrip retains the async Input caret');
      opaqueTui.children.splice(0, 1, opaqueEditor); opaqueFocus = opaqueEditor;
      const answeredBlock = opaque.enqueue({ id: 'STOCK_ANSWERED', mode: 'blocking', questions: [question('stock-answered')] });
      await Promise.resolve(); opaqueSend('yes'); opaqueSend('\r');
      assert.deepEqual((await answeredBlock.outcome!).answers.map((answer) => answer.answer), ['yes']);
      assert.equal(opaqueFocus, opaqueWidget, 'answering the blocker keeps the shared surface on a remaining async question');
      assert.equal(opaque.snapshot().current!.tab.groupId, 'OPAQUE');
      opaque.suspend(true); assert.equal(opaqueFocus, opaqueEditor);
      assert.doesNotMatch(opaqueWidget.render(120).join('\n'), /Shift\+Tab|Ctrl\+\]|\/asks selects questions|Tab next question|Enter confirm/, 'known prompt span cannot advertise suppressed question entry');
      assert.equal(opaqueSend('\x1b[Z'), undefined, 'known SDK prompt span keeps its own ShiftTab');
      opaque.suspend(false); opaqueWidget.render(120); assert.equal(opaqueFocus, opaqueEditor, 'prompt completion is passive on stock SDK');
      assert.equal(opaque.activate(), true); assert.equal(opaqueFocus, opaqueWidget, 'explicit activation also works without editor identity');
      const ownedStockBlock = opaque.enqueue({ id: 'STOCK_OWNED_BLOCK', mode: 'blocking', questions: [question('owned-stock-block')] }); ownedStockBlock.outcome!.catch(() => {});
      await Promise.resolve(); assert.equal(opaqueFocus, opaqueWidget); assert.equal(opaque.snapshot().current!.tab.groupId, 'STOCK_OWNED_BLOCK', 'blocker retains priority within an explicitly owned stock pane');
      opaque.suspend(true); assert.equal(opaqueFocus, opaqueEditor); opaque.suspend(false);
      assert.equal(opaqueFocus, opaqueWidget, 'a pane-owned stock blocker reclaims its retained loan after a foreign prompt');
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
      assert.equal(limitedFocus, editor); assert.equal(limited.activate(), true);
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
      assert.equal(identityFocus, ownedCore); assert.equal(identityHost.activate(), true);
      const identitySurface = identityFocus;
      const successorCore = { handleInput() {} }; ownedCore = successorCore; identityTui.children.splice(0, 1, successorCore); identityFocus = successorCore;
      identityWidget.render(100); assert.equal(identityFocus, successorCore, 'async questions do not reclaim a replacement core editor');
      assert.equal(identityHost.activate(), true); assert.equal(identityFocus, identitySurface);
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
        asyncCoreArrivalPassive: true, stockPassiveExplicitLoan: true, stockBlockerModal: true, unifiedBlockingTabs: true, modalReuseReset: true, exactModalReturn: true, replacementModalRebind: true, explicitStockModalRebind: true, paneOwnedAsyncFallback: true, collapsedModalFallback: true, deferredOverlayReturn: true, retiredDeferredHandoff: true, stockLostOriginNoGuess: true,
        stockForeignSpanNativeKeys: true, passiveFooterUsesActualFocus: true, knownPromptHidesUnavailableRoutes: true, truthfulSuspendedCopy: true,
        collapsedHintUsesAvailableRoute: true, suspendedProjectionInactive: true, oneShotGuards: true, physicalPty: false,
      } };
    },
  });
}
