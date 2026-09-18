import { readFile } from 'node:fs/promises';
import { ThreadroomClient } from '../../public/client.js';

// A generic API consumer: all content/artwork is captured on publication.
// Repeating this command with unchanged source recovers the same test nodes.
const api = new ThreadroomClient(process.env.THREADROOM_API_URL || 'http://127.0.0.1:4310');
const ui = (process.env.THREADROOM_UI_URL || 'http://127.0.0.1:4311').replace(/\/$/, '');
const key = process.env.PLAYGROUND_KEY || 'interaction-playground-v3';
const author = { name: 'Threadroom test author', id: 'threadroom-interaction-demo', role: 'Synthetic examples requested by Scott' };
const root = await api.publish({ title: 'Interaction playground · TEST questions (notes-safe)', body: 'Synthetic interaction examples, not MistFall team requests or project approvals. Explore moving parts, keyboard controls, overlapping objects, multiple choice, picture choices, and drawing. Every question retains independent written notes / ask-back / rejection / Save controls. Three actual questions also nest inside one another.', author }, `${key}:root`);
const entries = [];
const common = { parentId: root.node.id, author };
const definition = [
  { slug: 'motion', title: '01 · Moving question — steer the little scene', file: 'motion.html', fallback: 'An animated scene with a keyboard-controlled marker. Focus the board; arrows/WASD move, Space pauses, R resets. Mouse alternatives and a speed control are available. Propose captures a compact image and labeled settings, then add written notes and Save in Threadroom.' },
  { slug: 'stacking', title: '02 · Build your answer — put things on top of things', file: 'stacking.html', fallback: 'Arrange five solid objects by dragging and overlapping them; selected objects can be nudged with the keyboard. Move an object to front/back, reset, and propose the arrangement. Positions, layer order, notes and a PNG snapshot accompany the saved answer.' },
  { slug: 'multiple', title: '03 · Multiple choice — pick several, or write something else', choices: ['Moving parts', 'Keyboard play', 'Stacking objects', 'Drawing an answer', 'Pictures instead of labels', 'None of these — I have another idea'], multiple: true },
  { slug: 'images', title: '04 · Picture question, picture choices — which light belongs?', file: 'images.html', fallback: 'The question is a picture of a floating garden with an empty plinth. Image choices are a warm amber orb, cool cyan prism, and coral bloom. Select one, optionally add picture notes, and propose. The exact question and chosen picture are saved with the values; plain text alternatives remain available.' },
  { slug: 'drawing', title: '05 · Draw your answer — a way between two islands', file: 'drawing.html', fallback: 'Draw a bridge, stepping stones, flying path or anything else between island A and B with mouse/touch. Choose ink/brush, undo or clear, add notes and propose. The saved answer carries strokes plus a compact PNG; you can always answer entirely in written text instead.' }
];
for (const demo of definition) {
  const input = { ...common, question: demo.title, body: 'TEST ONLY · Explore this interaction, then use the independent written response and Save controls below. You may add notes, ask back, reject with a reason, or ignore the widget and answer entirely in text.' };
  if (demo.file) Object.assign(input, { html: await readFile(new URL(demo.file, import.meta.url), 'utf8'), fallback: demo.fallback, revision: `${key}:${demo.slug}:r1` });
  else Object.assign(input, { choices: demo.choices, multiple: demo.multiple });
  const saved = await api.ask(input, `${key}:${demo.slug}`);
  entries.push({ slug: demo.slug, id: saved.node.id, title: saved.node.title, url: `${ui}${saved.url}` });
}
let parentId = root.node.id;
for (const [i, title] of [
  '06 · A question: what should this playground explore next?',
  'A question inside that question: which interaction was least obvious?',
  'A question inside that question inside that question: what should change first?'
].entries()) {
  const saved = await api.ask({ parentId, question: title, body: `TEST · Nested question ${i + 1} of 3. Each is its own durable request with notes/text and response controls. You can answer here, go deeper via Inside this thread, or branch further from any saved answer.`, author }, `${key}:nested:${i}`);
  entries.push({ slug: `nested-${i + 1}`, id: saved.node.id, parentId, title, url: `${ui}${saved.url}` });
  parentId = saved.node.id;
}
console.log(JSON.stringify({ root: { id: root.node.id, url: `${ui}${root.url}` }, questions: entries }, null, 2));
