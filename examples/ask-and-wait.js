import { ThreadroomClient } from '../public/client.js';

const room = new ThreadroomClient(process.env.THREADROOM_API_URL || 'http://127.0.0.1:4310');
console.log('Making one durable question call and waiting up to two minutes. Open the website to answer.');
const result = await room.ask({
  project: 'Threadroom',
  thread: 'Blocking asks',
  question: 'Can you answer this while the CLI question call is waiting?',
  context: 'An optional waiting demonstration. You can type freely, select a suggested answer, or reject. If this call times out, the question remains here and can be answered later.',
  choices: ['Yes, this is the blocking interaction I meant', 'Needs a different waiting experience'],
  author: { name: 'Example API client' },
  wait: { timeoutMs: 120000 }
}, process.env.ASK_KEY || 'blocking-example-r1');
console.log(JSON.stringify(result, null, 2));
