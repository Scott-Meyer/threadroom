const baseUrl = process.env.THREADROOM_API_URL || 'http://127.0.0.1:4310';
console.log('Making one durable question call and waiting up to two minutes. Open the website to answer.');
const response = await fetch(`${baseUrl}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': process.env.ASK_KEY || 'blocking-example-r1' },
  body: JSON.stringify({
    path: ['Threadroom', 'Blocking asks'],
    question: 'Can you answer this while the CLI question call is waiting?',
    context: 'An optional waiting demonstration. You can type freely, select a suggested answer, or reject. If this call times out, the question remains here and can be answered later.',
    choices: ['Yes, this is the blocking interaction I meant', 'Needs a different waiting experience'],
    author: { name: 'Example API client' },
    wait: { timeoutMs: 120000 }
  })
});
const result = await response.json();
if (!response.ok) throw new Error(JSON.stringify(result));
console.log(JSON.stringify(result, null, 2));
