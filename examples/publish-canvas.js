import { readFile } from 'node:fs/promises';

const baseUrl = process.env.THREADROOM_API_URL || 'http://127.0.0.1:4310';
const html = await readFile(new URL('./creature-canvas.html', import.meta.url), 'utf8');
// One API call resolves/creates every ancestor and durably captures the authored document.
const response = await fetch(`${baseUrl}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'demo-procedural-creature-r1' },
  body: JSON.stringify({
    path: ['MistFall', 'Creatures', 'Mist creature', 'Procedural studies'],
    question: 'Explore the silhouette generator — what movement character would you carry forward?',
    context: 'An illustrative authored canvas, not a real art-team approval. Generate and tune a study, propose it, then answer or reject using the dependable Threadroom controls below. The generated snapshot and labeled parameters can travel with your saved response.',
    author: { name: 'Mara (demo)', role: 'Visual storyteller' },
    html,
    fallback: 'A procedural silhouette generator: adjust silhouette spread and restless edges, generate studies with different seeds, then propose a study. The host can capture seed/spread/edge values and a generated PNG snapshot alongside written feedback. Initial state: seed41, spread53, restless edges13.',
    revision: 'procedural-study-r1'
  })
});
const result = await response.json();
if (!response.ok) throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ id: result.node.id, parentId: result.node.parentId, path: result.ancestors.map(({ title }) => title), website: `http://127.0.0.1:4311${result.url}`, deduplicated: result.deduplicated }, null, 2));
