import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { stripVTControlCharacters } from 'node:util';
import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { registerBlockingQuestions } from '../extensions/questions/tool.ts';
import { registerNativeAsks } from '../extensions/native/index.ts';
import { renderNativeQuestion, renderNativeAnswer, renderNativeFeedback, renderAsyncAskCall, renderAsyncAskResult, renderBlockingAskCall, renderBlockingAskResult, renderPrivateAskResult } from '../extensions/questions/stream.ts';

// TEST-only authored records and actual SDK renderer boundary; no human content or persistence authority.
export default function(pi: any) {
  registerBlockingQuestions(pi, async () => ({ answers: [], cancelled: false }));
  registerNativeAsks(pi);
  pi.registerTool({ name: 'TEST_questions_stream_proof', label: 'TEST private stream proof', description: 'TEST literal private question/reply stream boundary', parameters: Type.Object({}),
    async execute(_id: any, _args: any, _signal: any, _update: any, ctx: any) {
      const theme = ctx.ui.theme, checks: string[] = [];
      const raw = (component: any, width = 80) => {
        const lines = component.render(width); for (const line of lines) { assert.doesNotMatch(line, /[\n\r]/, 'One Component row is one physical terminal line'); assert.ok(visibleWidth(line) <= width, `Stream exceeds width ${width}`); }
        const result = lines.join('\n');
        assert.doesNotMatch(result, /\x1b\](?:52|8);/);
        assert.doesNotMatch(result, /\x1b\[7m/);
        assert.ok(!result.includes('\x1b[31m'), 'authored color controls are removed before trusted theme styling');
        assert.ok(!result.includes('\x1b_pi:c\x07'), 'authored APC controls are removed before rendering');
        assert.doesNotMatch(result, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u, 'authored bidi controls are removed before rendering');
        assert.ok(!result.includes(CURSOR_MARKER)); return result;
      };
      const text = (component: any, width = 80) => stripVTControlCharacters(raw(component, width)).split('\n').map(row => row.trimEnd()).join('\n');
      const originalPreview = 'TEST_SELECTED_PREVIEW_FIRST\n' + 'x'.repeat(54000) + '\nTEST_SELECTED_PREVIEW_LAST';
      const prompt = { question: 'TEST_NATIVE_TITLE\nTEST_NATIVE_QUESTION_LAST\x1b[31m\x1b]52;c;TEST_FORBIDDEN\x07\x1b_pi:c\x07\u061c\u200e\u200f\u202e', context: 'TEST_CONTEXT_FIRST\nTEST_CONTEXT_LAST', options: [{ label: 'Same', preview: 'TEST_FIRST_PREVIEW' }, { label: 'Same', preview: originalPreview }] };
      const question = { id: 'ask-TEST_ACTUAL_QUESTION_ID', sessionId: 'TEST_SESSION', toolCallId: 'TEST_ACTUAL_CALL_ID', prompt };
      const answer = { sessionId: question.sessionId, questionId: question.id, answerId: 'answer-TEST_ACTUAL_ANSWER_ID', prompt,
        answer: { text: 'TEST_HUMAN_REPLY\x1b[7m\x1b[0m\x1b]8;;https://invalid.example\x07', optionIndex: 1, selection: prompt.options[1] } };
      const original = JSON.stringify({ question, answer });
      const q = raw(renderNativeQuestion(question, { expanded: false }, theme)), a = raw(renderNativeAnswer(answer, { expanded: false }, theme));
      assert.ok(q.includes(theme.getFgAnsi('borderAccent'))); assert.ok(a.includes(theme.getFgAnsi('customMessageLabel')));
      assert.ok(!q.includes(theme.getFgAnsi('success')) && !a.includes(theme.getFgAnsi('success')));
      for (const view of [q, a]) { assert.match(stripVTControlCharacters(view), /q:ask-TEST_ACTUAL_QUESTION_ID/); assert.match(stripVTControlCharacters(view), /PRIVATE/); assert.doesNotMatch(stripVTControlCharacters(view), /\b(saved|delivered|consumed|read|completed)\b/i); }
      assert.match(stripVTControlCharacters(a), /TEST_HUMAN_REPLY/); assert.doesNotMatch(stripVTControlCharacters(q), /TEST_NATIVE_QUESTION_LAST/);
      checks.push('Raw prebind question/reply captions remain neutral, retain distinct trusted theme roles and share only actual question identity.');
      const expandedQ = text(renderNativeQuestion(question, { expanded: true }, theme)), expandedA = text(renderNativeAnswer(answer, { expanded: true }, theme));
      for (const view of [expandedQ, expandedA]) for (const marker of ['TEST_NATIVE_QUESTION_LAST', 'TEST_CONTEXT_LAST', 'TEST_FIRST_PREVIEW', 'TEST_SELECTED_PREVIEW_LAST']) assert.ok(view.includes(marker), marker);
      assert.match(expandedA, /Original suggestion: 2/); assert.match(expandedA, /Answer identity:\nanswer-TEST_ACTUAL_ANSWER_ID/);
      const compactContext = text(renderNativeFeedback(answer, { expanded: false }, theme)); assert.match(compactContext, /Reply context/); assert.match(compactContext, /q:ask-TEST_ACTUAL_QUESTION_ID/); assert.doesNotMatch(compactContext, /TEST_HUMAN_REPLY|TEST_NATIVE_TITLE/);
      assert.match(text(renderNativeFeedback(answer, { expanded: true }, theme)), /TEST_SELECTED_PREVIEW_LAST/);
      assert.equal(JSON.stringify({ question, answer }), original, 'Rendering never changes the original stored fields');
      checks.push('Expanded original fields/duplicate suggestion index/full large previews are inspectable; compact context echo has no duplicate primary body or input mutation.');

      const args = { questions: [
        { header: 'TEST_ORIGINAL_ONE', question: 'TEST unanswered original?', context: 'TEST_UNANSWERED_CONTEXT', options: [{ label: 'Same' }, { label: 'Same' }] },
        { header: 'TEST_ORIGINAL_TWO', question: 'TEST answered original?', multiSelect: true, options: [{ label: 'Same', preview: 'TEST_CHECKED_FIRST' }, { label: 'Same' }] },
      ] };
      const context: any = { args, toolCallId: 'TEST_BLOCKING_PUBLIC_CALL', expanded: false, isPartial: false, isError: false };
      const result = { content: [{ type: 'text', text: 'TEST_TRUNCATED_CONTENT_NOT_THE_ORIGINAL_DETAILS' }], details: { groupId: 'blocking:TEST_BLOCKING_PUBLIC_CALL', cancelled: false, answers: [{ questionIndex: 1, question: args.questions[1].question, selected: ['Same', 'Same'], optionIndices: [0, 1], previews: ['TEST_CHECKED_FIRST', null], answer: 'TEST_CUSTOM_REPLY', notes: 'TEST_OPEN_NOTES', wasCustom: true }] } };
      const compact = text(renderBlockingAskResult(result, { expanded: false, isPartial: false }, theme, context));
      assert.match(compact, /Original question 2/); assert.match(compact, /TEST_BLOCKING_PUBLIC_CALL\/2/); assert.match(compact, /Some original questions unanswered/); assert.doesNotMatch(compact, /TRUNCATED_CONTENT/);
      const expanded = text(renderBlockingAskResult(result, { expanded: true, isPartial: false }, theme, context));
      for (const marker of ['TEST_ORIGINAL_ONE', 'TEST_UNANSWERED_CONTEXT', 'TEST_ORIGINAL_TWO', 'TEST_CHECKED_FIRST', 'TEST_CUSTOM_REPLY', 'TEST_OPEN_NOTES', '(none authored)']) assert.ok(expanded.includes(marker), marker);
      assert.match(expanded, /Selected suggestion 1:\nSame/); assert.match(expanded, /Selected suggestion 2:\nSame/);
      assert.match(text(renderBlockingAskResult({ ...result, details: { ...result.details, cancelled: true } }, { expanded: false, isPartial: false }, theme, context)), /Questionnaire cancelled/);
      const error = text(renderBlockingAskResult({ content: [{ type: 'text', text: 'TEST unsupported host\nTEST_BLOCKING_CAUSE_LAST' }] }, { expanded: false, isPartial: false }, theme, { ...context, isError: true }));
      assert.match(error, /Question request failed/); assert.doesNotMatch(error, /cancelled|declined/);
      assert.match(text(renderBlockingAskResult(result, { expanded: false, isPartial: true }, theme, context)), /Reply update/);
      const referenceArgs = { questions: [{ questionId: question.id }] }, referenceContext: any = { ...context, args: referenceArgs };
      assert.match(text(renderBlockingAskCall(referenceArgs, theme, referenceContext)), /Wait for existing question/);
      assert.match(text(renderBlockingAskCall(referenceArgs, theme, { ...referenceContext, expanded: true })), /Existing question identity:\nask-TEST_ACTUAL_QUESTION_ID/);
      const historicalReference = { questionId: question.id }, historicalContext: any = { ...context, args: historicalReference };
      assert.match(text(renderBlockingAskCall(historicalReference, theme, historicalContext)), /Wait for existing question/);
      const releasedWait = { content: [{ type: 'text', text: '{"cancelled":true}' }], details: { groupId: `native:${question.id}`, questionId: question.id,
        sessionId: question.sessionId, waitStatus: 'cancelled', cancelled: true, answers: [] } };
      const releasedText = text(renderBlockingAskResult(releasedWait, { expanded: false, isPartial: false }, theme, referenceContext));
      assert.match(releasedText, /Question wait cancelled/); assert.match(releasedText, /original nonblocking question remains pending/); assert.doesNotMatch(releasedText, /Questionnaire cancelled/);
      assert.match(text(renderBlockingAskResult(releasedWait, { expanded: false, isPartial: false }, theme, historicalContext)), /Question wait cancelled/);
      checks.push('Blocking summaries preserve original question/option positions, partial/cancel/error distinction, open notes and null-aligned previews; referenced async waits retain identity and truthful release copy.');

      for (const call of [renderAsyncAskCall(prompt, theme), renderBlockingAskCall(args, theme)]) assert.doesNotMatch(text(call), /call:|group:|q:/);
      assert.match(text(renderAsyncAskCall(prompt, theme, { ...context, args: prompt })), /call:TEST_BLOCKING_PUBLIC_CALL/);
      const pending = { details: { id: question.id, status: 'pending' }, content: [] };
      assert.match(text(renderAsyncAskResult(pending, { expanded: false, isPartial: false }, theme)), /q:ask-TEST_ACTUAL_QUESTION_ID/);
      assert.doesNotMatch(text(renderAsyncAskResult(pending, { expanded: false, isPartial: false }, theme)), /Pending|saved|delivered/i);
      const storage = text(renderAsyncAskResult({ details: { status: 'storage_unconfirmed', error: 'TEST_STORAGE_DIAGNOSTIC', presentationError: 'TEST_PRESENTATION_DIAGNOSTIC' } }, { expanded: true, isPartial: false }, theme, context));
      assert.match(storage, /Storage unconfirmed/); assert.match(storage, /Storage diagnostic:\nTEST_STORAGE_DIAGNOSTIC/); assert.match(storage, /Presentation diagnostic:\nTEST_PRESENTATION_DIAGNOSTIC/);
      assert.match(text(renderAsyncAskResult({ details: { status: 'unsupported_host' } }, { expanded: false, isPartial: false }, theme)), /Not presented/);
      const batchContext: any = { ...context, args: { blocking: false, questions: [
        { header: 'TEST_BATCH_ONE', question: 'TEST batch saved?', options: [{ label: 'One' }, { label: 'Two' }] },
        { header: 'TEST_BATCH_TWO', question: 'TEST batch failed?', options: [{ label: 'One' }, { label: 'Two' }] },
      ] } };
      const batch = { details: { status: 'partial', questions: [
        { id: 'ask-TEST_BATCH_SAVED', status: 'pending' },
        { id: 'ask-TEST_BATCH_FAILED', status: 'storage_unconfirmed', error: 'TEST_BATCH_STORAGE_FAILURE' },
      ] }, content: [] };
      const batchCompact = text(renderPrivateAskResult(batch, { expanded: false, isPartial: false }, theme, batchContext));
      assert.match(batchCompact, /q:ask-TEST_BATCH_SAVED/); assert.match(batchCompact, /q:ask-TEST_BATCH_FAILED/); assert.match(batchCompact, /Storage unconfirmed/);
      const batchExpanded = text(renderPrivateAskResult(batch, { expanded: true, isPartial: false }, theme, batchContext));
      assert.match(batchExpanded, /TEST_BATCH_STORAGE_FAILURE/); assert.match(batchExpanded, /TEST_BATCH_ONE/); assert.match(batchExpanded, /TEST batch failed/);
      checks.push('Older hosts omit absent public call identity; request-time batch identities and storage/presentation diagnostics remain distinct from raw record/receipt authority.');

      const tool = ctx.ui.testBlockingTool;
      assert.equal(tool.renderShell, 'self'); assert.equal(typeof tool.renderCall, 'function'); assert.equal(typeof tool.renderResult, 'function');
      const ui: any = { requestRender() {} }, actual = new ToolExecutionComponent(tool.name, context.toolCallId, args, {}, tool, ui, ctx.cwd || process.cwd());
      actual.setArgsComplete(); actual.markExecutionStarted(); actual.updateResult({ ...result, isError: false });
      const actualRaw = raw(actual); assert.match(stripVTControlCharacters(actualRaw), /Original question 2/); assert.ok(!actualRaw.includes(theme.getBgAnsi('toolSuccessBg')), 'No automatic success shell overstates reply health');
      actual.setExpanded(true); assert.match(text(actual), /TEST_UNANSWERED_CONTEXT/); assert.match(text(actual), /TEST_OPEN_NOTES/);
      const all = [renderNativeQuestion(question, { expanded: false }, theme), renderNativeAnswer(answer, { expanded: false }, theme), renderNativeFeedback(answer, { expanded: false }, theme), renderBlockingAskCall(args, theme, context), renderBlockingAskResult(result, { expanded: false, isPartial: false }, theme, context)];
      for (const width of [1, 4, 18, 40, 80]) for (const component of all) raw(component, width);
      const cjk = renderNativeQuestion({ ...question, prompt: { ...prompt, question: 'TEST漢字'.repeat(100) } }, { expanded: false }, theme); for (const width of [4, 18, 40, 80]) raw(cjk, width);
      checks.push('SDK-loaded blocking hooks render through actual ToolExecutionComponent without success shell; narrow/CJK passive stream components obey public geometry and contain no editable caret.');
      const asyncTool = ctx.ui.testAsyncTool;
      assert.equal(asyncTool.renderShell, 'self');
      const asyncError = new ToolExecutionComponent(asyncTool.name, 'TEST_ASYNC_EXCEPTION_CALL', prompt, {}, asyncTool, ui, ctx.cwd || process.cwd());
      asyncError.setArgsComplete(); asyncError.markExecutionStarted();
      asyncError.updateResult({ content: [{ type: 'text', text: 'TEST_UNEXPECTED_ASYNC_EXCEPTION\nTEST_FULL_EXCEPTION_LAST\x1b]52;c;FORBIDDEN\x07' }], isError: true });
      const asyncCollapsed = text(asyncError); assert.match(asyncCollapsed, /Question request failed/); assert.match(asyncCollapsed, /TEST_UNEXPECTED_ASYNC_EXCEPTION/); assert.doesNotMatch(asyncCollapsed, /Your repl|cancelled|declined/);
      asyncError.setExpanded(true); assert.match(text(asyncError), /TEST_FULL_EXCEPTION_LAST/);
      const unknownBlocking = text(renderBlockingAskResult({ content: [{ type: 'text', text: 'TEST_DETACHED_DIAGNOSTIC' }] }, { expanded: false, isPartial: false }, theme));
      assert.match(unknownBlocking, /Question request result/); assert.doesNotMatch(unknownBlocking, /Your repl|cancelled|declined/);
      actual.setExpanded(false); actual.updateResult({ content: [{ type: 'text', text: 'TEST_BLOCKING_EXCEPTION\nTEST_BLOCKING_CAUSE_LAST' }], isError: true });
      assert.match(text(actual), /Question request failed/); assert.match(text(actual), /TEST_BLOCKING_EXCEPTION/); actual.setExpanded(true); assert.match(text(actual), /TEST_BLOCKING_CAUSE_LAST/);
      const tinyOriginal = renderNativeQuestion({ id: question.id, prompt: { question: 'TEST漢字\nTEST_WIDE_LAST' } }, { expanded: true }, theme); raw(tinyOriginal, 1); assert.ok(text(tinyOriginal, 1).replace(/\n/g, '').includes('\\u{6f22}'));
      checks.push('Registered async/blocking self-shell exceptions stay visible collapsed/full expanded with physical single-line rows; older-host fallback is neutral and one-column expanded wide originals use reversible escapes.');
      return { content: [{ type: 'text', text: 'TEST private stream proof complete' }], details: { syntheticNotHuman: true, humanAcceptance: false, physicalPty: false, actualSdkToolExecution: true, checks, originalInputsUnchanged: true, neutralPrebindCaptions: true, authoredFieldsSanitizedBeforeTrustedTheme: true } };
    },
  });
}
