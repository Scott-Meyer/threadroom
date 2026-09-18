import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// This is a host-boundary check, not a replacement Pi or a helper-string test.
// Set THREADROOM_PI_SDK_ROOT to an installed pi-coding-agent package when Pi
// is installed globally rather than in this workspace.
let sdk = process.env.THREADROOM_PI_SDK_ROOT;
if (!sdk) {
  try { sdk = dirname(dirname(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent'))); }
  catch { /* A service-only checkout does not install the Pi peer. */ }
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
const host = async (path) => import(pathToFileURL(resolve(sdk, path)).href);

async function fixture(t, { staleApiAlias = false } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'threadroom-pi-presentation-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve(root, 'src/main.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), THREADROOM_SERVE_UI: '0',
      THREADROOM_DB: resolve(directory, 'records.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  function deadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Service deadline: ${log}`)), ms);
    })]).finally(() => clearTimeout(timer));
  }
  t.after(async () => {
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit'); child.kill('SIGTERM');
        try { await deadline(exit, 3000); }
        catch (error) { child.kill('SIGKILL'); await deadline(exit, 1000); throw error; }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await deadline(new Promise((done, reject) => {
    child.stdout.on('data', (data) => { log = (log + data).slice(-16000); if (log.includes('is ready at')) done(); });
    child.stderr.on('data', (data) => { log = (log + data).slice(-16000); });
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Service exited (${code}/${signal}): ${log}`)));
  }), 3000);
  const before = { api: process.env.THREADROOM_API_URL, ui: process.env.THREADROOM_UI_URL, replace: process.env.THREADROOM_REPLACE_ASK };
  process.env.THREADROOM_API_URL = url; process.env.THREADROOM_UI_URL = url;
  if (staleApiAlias) process.env.THREADROOM_REPLACE_ASK = '1'; else delete process.env.THREADROOM_REPLACE_ASK;
  const { discoverAndLoadExtensions } = await host('dist/core/extensions/loader.js');
  const loaded = await discoverAndLoadExtensions([resolve(root, 'packages/pi-extension/extensions')], root, '/nonexistent/threadroom-test-agent');
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1, 'helpers are not discovered as extra extensions');
  const extension = loaded.extensions[0];
  const branch = [];
  const messages = [];
  const notices = [];
  Object.assign(loaded.runtime, {
    getSessionName: () => 'Motion teammate', appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
  });
  const ctx = { sessionManager: { getSessionId: () => 'presentation-session', getBranch: () => branch },
    isIdle: () => true, ui: { setStatus() {}, notify: (text) => notices.push(text) } };
  await extension.handlers.get('session_start')[0]({}, ctx);
  t.after(async () => {
    await extension.handlers.get('session_shutdown')[0]({}, ctx);
    for (const [name, value] of Object.entries(before)) {
      const key = { api: 'THREADROOM_API_URL', ui: 'THREADROOM_UI_URL', replace: 'THREADROOM_REPLACE_ASK' }[name];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { initTheme } = await host('dist/modes/interactive/theme/theme.js');
  initTheme('dark', false);
  const { ToolExecutionComponent } = await host('dist/modes/interactive/components/tool-execution.js');
  const { CustomMessageComponent } = await host('dist/modes/interactive/components/custom-message.js');
  const require = createRequire(pathToFileURL(resolve(sdk, 'package.json')));
  const { visibleWidth, getOsc8LinkAtColumn, getCapabilities, setCapabilities } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
  const previousCapabilities = getCapabilities();
  setCapabilities({ ...previousCapabilities, hyperlinks: true });
  t.after(() => setCapabilities(previousCapabilities));
  function rendered(component, width = 100) {
    const lines = component.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns`);
    // Theme SGR and validated service hyperlinks are expected; commands or
    // hidden targets supplied by saved body/author text are not.
    const withoutOwnedSequences = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\]8;;([^\x1b]*)\x1b\\/g, (_sequence, target) => {
        if (target) assert.ok(target.startsWith(`${url}/`), `unexpected terminal link: ${target}`);
        return '';
      });
    assert.doesNotMatch(withoutOwnedSequences, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    return stripVTControlCharacters(lines.join('\n'));
  }
  function row(name, args, result) {
    const component = new ToolExecutionComponent(name, 'render-row', args, undefined, extension.tools.get(name).definition,
      { requestRender() {} }, root);
    component.setArgsComplete(); component.markExecutionStarted();
    if (result) component.updateResult({ ...result, isError: false });
    return component;
  }
  return { extension, ctx, url, messages, notices, rendered, row, CustomMessageComponent, getOsc8LinkAtColumn,
    setHyperlinks: (enabled) => setCapabilities({ ...previousCapabilities, hyperlinks: enabled }) };
}
const options = { skip: !sdk && 'Pi peer absent; set THREADROOM_PI_SDK_ROOT for real host rendering' };

test('a retired API takeover setting cannot claim the native ask name', options, async (t) => {
  const f = await fixture(t, { staleApiAlias: true });
  assert.deepEqual([...f.extension.tools.keys()], ['threadroom_ask', 'threadroom']);
  assert.equal(f.extension.tools.has('ask_user_question'), false);
});

test('Pi loads the adapter and renders expressive calls, durable results and saved feedback without changing receipts', options, async (t) => {
  const f = await fixture(t);
  const ask = f.extension.tools.get('threadroom_ask').definition;
  assert.deepEqual([...f.extension.tools.keys()], ['threadroom_ask', 'threadroom']);
  const source = '<script>const SOURCE_ONLY_MARKER = "private authored program";</script>'.repeat(2000);
  const params = { question: 'How should this motion feel?', html: source, fallback: 'A study with quiet center and restless edges.' };
  const call = f.row('threadroom_ask', params);
  assert.match(f.rendered(call), /How should this motion feel\?/);
  assert.match(f.rendered(call), /quiet center/);
  assert.doesNotMatch(f.rendered(call), /SOURCE_ONLY_MARKER|<script>/);
  const result = await ask.execute('publish-1', params, undefined, () => {}, f.ctx);
  const untouched = JSON.stringify(result);
  const published = f.row('threadroom_ask', params, result);
  const text = f.rendered(published);
  assert.match(text, /Contribution saved/);
  assert.ok(text.includes(result.details.url));
  assert.doesNotMatch(text, /"participation"|SOURCE_ONLY_MARKER/);
  assert.ok(published.render(100).some((line) => Array.from({ length: 100 }, (_, column) =>
    f.getOsc8LinkAtColumn(line, column)).includes(result.details.url)), 'durable address is a host-recognized clickable link');
  f.setHyperlinks(false);
  const plain = f.row('threadroom_ask', params, result);
  assert.doesNotMatch(plain.render(100).join('\n'), /\x1b\]8;/, 'unsupported terminals receive no hyperlink controls');
  assert.ok(f.rendered(plain).includes(result.details.url), 'unsupported terminals retain a readable address');
  f.setHyperlinks(true);
  assert.equal(result.content[0].text, JSON.stringify(result.details), 'full machine-facing envelope remains intact');

  const feedback = { kind: 'clarification', body: 'Show the tail first.\x1b[2J\x1b]52;c;secret\x07\r\b\u202e',
    author: { name: 'Scott\x1b[31m', id: 'opaque:person/label', role: 'Owner label—not authentication' },
    selections: [{ label: 'Quiet', value: { contrast: 0.4 } }] };
  const answer = await fetch(`${f.url}/api/nodes/${result.details.node.id}/respond`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feedback),
  }).then((response) => response.json());
  const deadline = Date.now() + 3000;
  while (!f.messages.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.equal(f.messages.length, 1, 'actual service feedback reaches the registered message renderer');
  const { message, options: deliveryOptions } = f.messages[0];
  assert.deepEqual(deliveryOptions, { deliverAs: 'steer', triggerTurn: true });
  assert.deepEqual(message.details.receivedResponseIds, [answer.node.id]);
  assert.equal(message.details.response.node.body, feedback.body);
  assert.deepEqual(message.details.response.node.author, feedback.author);
  const saved = JSON.stringify(message);
  const component = new f.CustomMessageComponent(message, f.extension.messageRenderers.get(message.customType));
  const displayed = f.rendered(component);
  assert.match(displayed, /How should this motion feel\?/);
  assert.match(displayed, /Reply intent: clarification/);
  assert.match(displayed, /Show the tail first/);
  assert.match(displayed, /caller-provided; not authenticated approval/);
  assert.ok(displayed.includes(result.details.url));
  assert.doesNotMatch(displayed, /"receivedResponseIds"|"delivery"/);
  component.setExpanded(true);
  assert.match(f.rendered(component), /opaque:person\/label/);
  assert.ok(f.rendered(component).includes(answer.node.id));
  for (const width of [20, 40, 80]) { f.rendered(component, width); f.rendered(published, width); }
  assert.equal(JSON.stringify(message), saved);
  assert.equal(JSON.stringify(result), untouched);
});

test('Pi distinguishes waited snapshots, saved replies, outline limits and uncertain publication', options, async (t) => {
  const f = await fixture(t);
  const discussion = f.extension.tools.get('threadroom').definition;
  const invoke = (id, args) => discussion.execute(id, args, undefined, () => {}, f.ctx);
  const question = await invoke('question-2', { action: 'publish', input: { question: 'Could the tail stay soft?', body: 'Continue the motion study.' } });
  const id = question.details.node.id;
  const timeout = await invoke('wait-2', { action: 'wait', id, waitMs: 30 });
  assert.match(f.rendered(f.row('threadroom', { action: 'wait', id }, timeout)), /No reply before the wait ended/);
  assert.ok(timeout.details.node, 'wait snapshot identity is retained');
  const reply = await invoke('reply-2', { action: 'reply', id, input: { kind: 'defer', body: 'After the next motion pass.' } });
  const replyRow = f.row('threadroom', { action: 'reply', id }, reply);
  assert.match(f.rendered(replyRow), /Reply saved/);
  assert.match(f.rendered(replyRow), /Reply intent: defer/);
  const waited = await invoke('wait-3', { action: 'wait', id, waitMs: 1000 });
  const waitedRow = f.row('threadroom', { action: 'wait', id }, waited);
  assert.match(f.rendered(waitedRow), /Saved reply received/);
  assert.match(f.rendered(waitedRow), /After the next motion pass/);
  waitedRow.setExpanded(true);
  assert.ok(f.rendered(waitedRow).includes(waited.details.receivedResponseIds[0]));
  assert.match(f.rendered(waitedRow), /Snapshot: wait_read/);
  assert.match(f.rendered(waitedRow), /Could the tail stay soft\?/);
  for (let n = 0; n < 5; n++) await invoke(`outline-${n}`, { action: 'publish', input: { title: `Study ${n}` } });
  const browse = await invoke('browse-1', { action: 'browse' });
  const outline = f.row('threadroom', { action: 'browse' }, browse);
  assert.match(f.rendered(outline), /more discussions; expand/);
  outline.setExpanded(true);
  assert.match(f.rendered(outline), /Study 4/);
  const uncertain = { content: [{ type: 'text', text: '{"error":"not confirmed"}' }], details: {
    error: 'Connection lost\x1b[2J', retryKey: 'retry:opaque/identity', publication: 'unknown; the write may already be saved. Reuse the retry key with unchanged content.' } };
  const error = f.rendered(f.row('threadroom', { action: 'publish' }, uncertain));
  assert.match(error, /unknown; the write may already be saved/);
  assert.match(error, /retry:opaque\/identity/);
  assert.match(error, /not confirmed/);
  assert.ok(error.includes(`API: ${f.url}`));
  assert.ok(error.includes(`Website: ${f.url}`));
  await f.extension.commands.get('threadroom').handler('', f.ctx);
  assert.ok(f.notices.at(-1).includes(`API: ${f.url}`));
  assert.ok(f.notices.at(-1).includes(`Website: ${f.url}`));
  assert.match(f.notices.at(-1), /Watching:/);
});
