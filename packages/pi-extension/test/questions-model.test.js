import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionModel } from '../extensions/questions/model.ts';

const question = (id, extra = {}) => ({ id, question: `Question ${id}?`, options: [{ label: 'Same', preview: 'FIRST' }, { label: 'Same', preview: 'SECOND' }], ...extra });
const asyncGroup = (id, commit = () => {}) => ({ id, mode: 'async', questions: [question(id)], commit });

test('flat priority preserves current drafts on same-priority arrivals and authored choice identity', async () => {
  const saved = [], model = new QuestionModel();
  model.enqueue(asyncGroup('A', (id, answer) => saved.push({ id, answer })));
  model.setReply('retained draft'); model.enqueue(asyncGroup('C'));
  assert.equal(model.current().tab.questionId, 'A'); assert.equal(model.current().reply, 'retained draft');
  const blocker = model.enqueue({ id: 'B', mode: 'blocking', questions: [question('b0'), question('__review__')] });
  assert.equal(model.current().tab.groupId, 'B'); assert.deepEqual(model.tabs().map((tab) => tab.mode), ['blocking', 'blocking', 'blocking', 'async', 'async']);
  model.select('B', '__review__'); assert.equal(model.current().tab.review, false);
  const other = model.enqueue({ id: 'D', mode: 'blocking', questions: [question('d')] });
  assert.equal(model.current().tab.questionId, '__review__');
  model.select('A', 'A'); assert.equal(model.current().reply, 'retained draft'); model.setReply(''); model.moveOption(1); await model.confirm();
  assert.equal(saved[0].id, 'A'); assert.equal(saved[0].answer.optionIndex, 1); assert.equal(saved[0].answer.preview, 'SECOND');
  blocker.detach(); other.detach(); await assert.rejects(blocker.outcome, { code: 'presentation_detached' }); await assert.rejects(other.outcome, { code: 'presentation_detached' });
});

test('review cancellation and partial submission are group-local and include live checks/notes', async () => {
  let commits = 0; const model = new QuestionModel(); model.enqueue(asyncGroup('A', () => commits++)); model.setReply('A draft');
  const b = model.enqueue({ id: 'B', mode: 'blocking', questions: [question('b0'), question('b1', { multiSelect: true })] });
  model.select('B', 'b1'); model.toggleOption(); model.moveOption(1); model.toggleOption(); model.setNotes('OPEN_NOTE');
  model.select('B'); model.moveReview();
  const d = model.enqueue({ id: 'D', mode: 'blocking', questions: [question('d0'), question('d1')] });
  model.select('D'); model.moveReview(); await model.confirm(); assert.equal((await d.outcome).cancelled, true);
  model.select('B'); assert.equal(model.current().reviewChoice, 1); model.moveReview(); await model.confirm();
  const result = await b.outcome; assert.equal(result.cancelled, false); assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].questionIndex, 1); assert.deepEqual(result.answers[0].optionIndices, [0, 1]);
  assert.deepEqual(result.answers[0].selected, ['Same', 'Same']); assert.deepEqual(result.answers[0].previews, ['FIRST', 'SECOND']); assert.equal(result.answers[0].notes, 'OPEN_NOTE');
  model.select('A', 'A'); assert.equal(model.current().reply, 'A draft'); assert.equal(commits, 0);
});

test('clearing checks cannot resurrect an old answer; custom multi answers retain notes', async () => {
  const model = new QuestionModel(), group = model.enqueue({ id: 'B', mode: 'blocking', questions: [question('b0', { multiSelect: true }), question('b1')] });
  model.toggleOption(); await model.confirm(); model.select('B', 'b0'); model.toggleOption(); assert.deepEqual(model.answers('B'), []);
  model.setReply('custom'); model.setNotes('note'); model.select('B'); model.submit('B');
  const result = await group.outcome; assert.equal(result.answers[0].answer, 'custom'); assert.deepEqual(result.answers[0].selected, []); assert.equal(result.answers[0].notes, 'note');
});

test('async failure preserves exact draft; saving holds only that cell while blocking remains usable', async () => {
  let reject, attempts = 0; const model = new QuestionModel();
  model.enqueue(asyncGroup('A', () => { attempts++; return attempts === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : undefined; })); model.setReply('exact draft');
  const saving = model.confirm(); assert.equal(model.current().saving, true); model.setReply('must not replace');
  const block = model.enqueue({ id: 'B', mode: 'blocking', questions: [question('b0')] }); await model.confirm(); assert.equal((await block.outcome).cancelled, false);
  model.select('A', 'A'); assert.equal(model.current().reply, 'exact draft'); reject(new Error('provider failure')); await saving;
  assert.match(model.current().error, /provider failure/); assert.equal(model.current().reply, 'exact draft'); await model.confirm(); assert.equal(model.tabs().length, 0); assert.equal(attempts, 2);
});

test('a source that cannot persist notes never accepts them into a saved answer', async () => {
  let saved; const model = new QuestionModel(); model.enqueue({ id: 'native', mode: 'async', questions: [question('n', { allowNotes: false })], commit(_id, answer) { saved = answer; } });
  model.setNotes('unsupported'); assert.equal(model.draftEdit().replaceNotes('unsupported'), false);
  await model.confirm(); assert.equal(saved.notes, undefined); model.dispose();
});

test('external draft edits remain bound to the original cell, not current position or a reused ID', () => {
  const model = new QuestionModel(); model.enqueue(asyncGroup('A')); model.setReply('original'); const edit = model.draftEdit();
  model.enqueue(asyncGroup('C')); model.select('C', 'C'); assert.equal(edit.replaceReply('edited A'), true);
  assert.equal(model.current().reply, ''); model.select('A', 'A'); assert.equal(model.current().reply, 'edited A');
  model.dispose(); assert.equal(edit.replaceReply('late'), false);
  const same = new QuestionModel(), old = same.enqueue(asyncGroup('A')), stale = same.draftEdit(); old.detach(); same.enqueue(asyncGroup('A'));
  assert.equal(stale.replaceNotes('wrong new cell'), false); assert.equal(same.current().notes, '');
});

test('pause does not decline and detached async callbacks cannot update a successor or render retired UI', async () => {
  let release, changes = 0; const model = new QuestionModel(() => changes++);
  model.enqueue(asyncGroup('A', () => new Promise((done) => { release = done; }))); model.cancel(); assert.equal(model.current().paused, true); model.select('A', 'A'); model.setReply('answer');
  const saving = model.confirm(); model.dispose(); const afterDisposal = changes; release(); await saving; assert.equal(changes, afterDisposal); assert.equal(model.tabs().length, 0);
});
