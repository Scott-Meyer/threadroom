import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { QuestionModel } from '../extensions/questions/model.ts';
import { QuestionView } from '../extensions/questions/view.ts';
import { createQuestionHost } from '../extensions/questions/host.ts';
import { stripVTControlCharacters } from 'node:util';

export default function(pi: any) {
  pi.registerTool({ name: 'owned_questions_view_proof', label: 'Owned question view proof', description: 'Fresh question UI public boundary, synthetic input only', parameters: Type.Object({}),
    async execute(_id: any, _args: any, _signal: any, _update: any, ctx: any) {
      const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
      const model = new QuestionModel(), view = new QuestionView(model, tui, ctx.ui.theme); view.focused = true;
      const question = { id: 'A', header: 'A\nB', question: 'Fresh private question?', options: [{ label: 'Same', preview: 'FIRST' }, { label: 'Same', preview: '**SECOND_LITERAL**' }], plainPreview: true };
      const saved: any[] = [];
      model.enqueue({ id: 'A', mode: 'async', questions: [question], commit: (id, answer) => { saved.push({ id, answer }); } });
      assert.doesNotMatch(view.frame(80).header[0], /\n/, 'authored headers cannot break a single-row tab strip');
      assert.doesNotMatch(view.frame(80).lines.join('\n'), /\x1b\[7m/, 'an inactive reply field must not draw a caret while an authored choice is selected');
      const text = () => stripVTControlCharacters(view.frame(80).lines.join('\n'));
      for (const char of 'DRAFT') view.handleInput(char);
      assert.match(text(), /1\. Same/); assert.match(text(), /2\. Same/); assert.match(text(), /DRAFT/);
      const replyRows = view.frame(80).lines.map((line) => stripVTControlCharacters(line));
      assert.ok(replyRows.some((line) => /Reply:.*DRAFT/.test(line)), 'the selectable free reply is the actual inline typing field, not a separate action and field');
      assert.doesNotMatch(replyRows.join('\n'), /Type something\./, 'no pseudo-option remains above a duplicate typing field');
      for (let index = 0; index < 5; index++) view.handleInput('\x7f');
      view.handleInput('\x1b[B'); assert.match(text(), /\*\*SECOND_LITERAL\*\*/);
      view.handleInput('\r'); await new Promise((done) => setImmediate(done));
      assert.equal(saved[0].answer.optionIndex, 1); assert.equal(saved[0].answer.preview, '**SECOND_LITERAL**');
      const block = model.enqueue({ id: 'B', mode: 'blocking', questions: [{ ...question, id: 'b0' }, { ...question, id: 'b1', multiSelect: true }] });
      model.select('B', 'b1'); view.handleInput('\x1b[32u'); view.handleInput('\x1b[32;1:2u'); assert.deepEqual(model.current()!.checked, [0], 'Space repeat does not flip a checkbox'); view.handleInput('\x1b[B'); view.handleInput(' '); view.handleInput('\x1bn');
      for (const char of 'OPEN_NOTE') view.handleInput(char);
      const noteFrame = view.frame(80).lines;
      assert.doesNotMatch(noteFrame.find((line) => stripVTControlCharacters(line).includes('Reply:'))!, /\x1b\[7m/, 'editing notes cannot leave a second caret in the reply field');
      assert.match(noteFrame.join('\n'), /\x1b\[7m/, 'the actual notes editor retains its SDK caret');
      view.handleInput('\x1b[D'); // Put the caret before the final E, not at the default end.
      view.focused = false;
      const inactiveNotes = view.frame(80).lines.join('\n');
      assert.doesNotMatch(inactiveNotes, /\x1b\[7m/, 'foreign focus must leave no fake reply or notes caret');
      assert.match(stripVTControlCharacters(inactiveNotes), /OPEN_NOTE/, 'inactive notes remain inspectable without changing the draft');
      view.focused = true;
      assert.match(view.frame(80).lines.join('\n'), /\x1b\[7m/, 'restored notes keep the original SDK editor caret');
      view.handleInput('X');
      assert.equal(model.current()!.notes, 'OPEN_NOTXE', 'focus suspension preserves the original mid-text notes caret, not a reset-to-end editor');
      view.handleInput('\x7f'); assert.equal(model.current()!.notes, 'OPEN_NOTE');
      view.handleInput('\r'); assert.equal(model.current()!.notes, 'OPEN_NOTE', 'notes submit retains the text supplied by SDK Editor');
      view.handleInput('\t'); assert.match(text(), /OPEN_NOTE/); assert.match(text(), /Submit answers/); assert.match(text(), /Cancel/);
      view.handleInput('\r'); const result = await block.outcome!; assert.equal(result.answers[0].notes, 'OPEN_NOTE'); assert.deepEqual(result.answers[0].optionIndices, [0, 1]);
      const noOp = model.enqueue({ id: 'F', mode: 'blocking', questions: [{ ...question, id: 'f0' }, { ...question, id: 'f1' }] });
      view.handleInput('\r'); view.handleInput('\x1b[Z'); view.handleInput('\x1b[D'); view.handleInput('\x7f'); model.select('F');
      assert.equal(model.answers('F')[0].optionIndex, 0, 'no-op editing keys cannot erase an accepted choice');
      model.submit('F'); await noOp.outcome!;
      const plainNo = model.enqueue({ id: 'N', mode: 'blocking', questions: [{ ...question, id: 'n' }] });
      view.handleInput('n'); view.handleInput('o'); view.handleInput('\r');
      assert.equal((await plainNo.outcome!).answers[0].answer, 'no', 'printable n must begin a normal reply, not enter notes');
      const free = model.enqueue({ id: 'FREE', mode: 'blocking', questions: [{ id: 'free', question: 'Own free text?' }] });
      for (const char of 'reply') view.handleInput(char); view.handleInput('\x1bn'); for (const char of 'free note') view.handleInput(char);
      view.handleInput('\r'); view.handleInput('\r'); const freeResult = await free.outcome!;
      assert.equal(freeResult.answers[0].answer, 'reply'); assert.equal(freeResult.answers[0].notes, 'free note');
      const explicit = model.enqueue({ id: 'E', mode: 'blocking', questions: [{ ...question, id: 'e' }] });
      for (const char of 'retained') view.handleInput(char);
      view.handleInput('\x1b'); view.handleInput('\x1b[B'); view.handleInput('\r');
      const chosen = await explicit.outcome!;
      assert.equal(chosen.answers[0].optionIndex, 1); assert.equal(chosen.answers[0].answer, 'Same'); assert.equal(chosen.answers[0].preview, '**SECOND_LITERAL**');
      model.enqueue({ id: 'C', mode: 'async', questions: [{ id: 'C', question: 'Long 控制 question\n\x1b[31mDATA\u202e', options: [{ label: '長い' + '選択肢'.repeat(25), preview: 'TAIL\n'.repeat(30) }] }], commit() {} });
      view.handleInput('\x1b[B'); view.handleInput('\r');
      view.frame(80); assert.equal(model.current()!.custom, true, 'render cannot undo explicit empty custom-row activation');
      view.handleInput('\x1b[200~PASTE\x1b[31mVALUE\u202e\x1b[201~');
      assert.doesNotMatch(model.current()!.reply!, /\x1b|\u202e/);
      const beforeRepeat = model.current()!.reply!; view.handleInput('\x1b[127;1:2u'); assert.equal(model.current()!.reply, beforeRepeat.slice(0, -1), 'held Backspace remains an editing action');
      for (const width of [25, 80]) for (const inspect of [false, true]) {
        const frame = view.frame(width, inspect);
        for (const line of [...frame.header, ...frame.lines, frame.footer]) assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${visibleWidth(line)}`);
      }
      model.moveOption(-1); // Explicitly select the authored option before inspecting its preview.
      assert.match(stripVTControlCharacters(view.frame(25, true).lines.join('\n')), /TAIL/);
      for (const line of view.frame(25).lines) assert.ok(visibleWidth(line) <= 25);
      // Kitty key releases/repeats must not submit the next question.
      const tabs = model.tabs().length; view.handleInput('\x1b[13;1:3u'); view.handleInput('\x1b[13;1:2u'); assert.equal(model.tabs().length, tabs);
      const incarnations = new QuestionModel(), incarnationView = new QuestionView(incarnations, tui, ctx.ui.theme);
      const old = incarnations.enqueue({ id: 'REUSED', mode: 'blocking', questions: [question] }); old.outcome!.catch(() => {});
      for (const char of 'secret') incarnationView.handleInput(char); incarnationView.handleInput('\x7f');
      incarnationView.handleInput('\x1bn'); for (const char of 'old note') incarnationView.handleInput(char);
      old.detach(); const successor = incarnations.enqueue({ id: 'REUSED', mode: 'blocking', questions: [question] }); successor.outcome!.catch(() => {});
      incarnationView.frame(80); incarnationView.handleInput('\x1b[45;5u');
      assert.equal(incarnations.current()!.reply, ''); assert.equal(incarnations.current()!.notes, '');
      for (const char of 'fresh') incarnationView.handleInput(char);
      assert.equal(incarnations.current()!.reply, 'fresh', 'same-ID successor cannot inherit notes editing state');
      assert.doesNotMatch(incarnationView.frame(80).lines.join('\n'), /secret|old note/);
      incarnations.dispose(); incarnationView.dispose();
      const edits = new QuestionModel(); let replace: (value: string) => void;
      const editView = new QuestionView(edits, tui, ctx.ui.theme, () => new Promise((done) => { replace = done; }));
      edits.enqueue({ id: 'EDIT_A', mode: 'async', questions: [question], commit() {} }); editView.handleInput('a'); editView.handleInput('\x07');
      edits.enqueue({ id: 'EDIT_C', mode: 'async', questions: [question], commit() {} }); edits.select('EDIT_C', question.id);
      replace!('EDIT\x1b[31mX\u202e\nFINAL'); await Promise.resolve(); await Promise.resolve();
      assert.equal(edits.current()!.reply, ''); edits.select('EDIT_A', question.id); assert.equal(edits.current()!.reply, 'EDITX FINAL');
      edits.dispose(); editView.dispose();
      // A minimal public host without terminal-input interception must not hide
      // the focused question behind an unreopenable/keyboard-trapping collapse.
      let widget: any, focus: any;
      const ordinary = { value: 'ORDINARY', getText() { return this.value; }, setText(value: string) { this.value = value; }, handleInput(data: string) { this.value += data; } };
      const noRawTui = { children: [ordinary], terminal: { rows: 24, columns: 80 }, requestRender() {}, getFocusedComponent() { return focus; }, setFocus(next: any) { focus = next; } }; focus = ordinary;
      const noRaw = createQuestionHost({ ui: {
        getCoreEditor() { return ordinary; },
        setWidget(_key: string, factory: any) { if (factory) widget = factory(noRawTui, ctx.ui.theme); else widget?.dispose(); },
      } });
      noRaw.enqueue({ id: 'NO_RAW', mode: 'async', questions: [question], commit() {} }); await Promise.resolve(); widget.render(80);
      assert.equal(focus, ordinary, 'async arrival stays passive with public core identity'); assert.equal(noRaw.activate(), true);
      widget.handleInput('\x1d'); assert.doesNotMatch(widget.render(80).join('\n'), /Collapsed/, 'collapse is unavailable without an editor-level reopen hook');
      widget.handleInput('visible'); assert.equal(noRaw.snapshot().current!.reply, 'visible', 'unsupported collapse cannot swallow input into a hidden draft');
      for (const [width, rows] of [[25, 24], [80, 18]]) {
        noRawTui.terminal.rows = rows;
        const boxed = widget.render(width).map((line: string) => stripVTControlCharacters(line));
        assert.ok(boxed[0].startsWith('╭') && boxed[0].endsWith('╮'), 'question has an unmistakable top boundary');
        assert.ok(boxed.at(-1).startsWith('╰') && boxed.at(-1).endsWith('╯'), 'question has an unmistakable bottom boundary');
        assert.ok(boxed.slice(1, -1).every((line: string) => line.startsWith('│') && line.endsWith('│')), 'visible question rows remain inside the boundary');
        assert.ok(boxed.every((line: string) => visibleWidth(line) <= width));
        assert.ok(boxed.length <= Math.max(4, Math.min(20, rows - 12)), 'framing does not add rows outside the viewport budget');
      }
      widget.handleInput('\x1b'); widget.handleInput('\x1b'); await Promise.resolve(); assert.equal(focus, ordinary, 'pause still restores the mounted ordinary editor');
      focus.handleInput('+'); assert.equal(ordinary.value, 'ORDINARY+'); noRaw.dispose();
      assert.ok(getKeybindings()); model.dispose(); view.dispose();
      return { content: [{ type: 'text', text: 'Fresh SDK-owned question view passed' }], details: { syntheticNotScott: true, humanAcceptance: false, noQuestionnaireDependency: true, suggestionsVisible: true, clearRestoresChoices: true, duplicateIndexPlainPreview: true, reviewChecksAndOpenNotes: true, untrustedPasteSafe: true, boundedLineWidths: true, incarnationEditorHistorySafe: true, externalEditOriginalCellAndSafeText: true, collapseUnavailableWithoutReopenHook: true, inlineReplyField: true, inactiveEditorsHaveNoFakeCaret: true, framedWithinViewportBudget: true, physicalPty: false } };
    },
  });
}
