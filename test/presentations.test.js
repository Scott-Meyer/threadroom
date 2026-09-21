import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPresentation } from '../public/presentations.js';

class FakeElement extends EventTarget {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    if (tagName === 'iframe') this.contentWindow = {};
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  remove() { this.removed = true; }
}

function fixture() {
  const window = new EventTarget();
  const document = {
    defaultView: window,
    baseURI: 'http://127.0.0.1:4310/',
    createElement(tagName) { return new FakeElement(tagName, document); },
  };
  const container = new FakeElement('main', document);
  const proposals = [];
  const dispose = mountPresentation(container, {
    node: { id: 'question', title: 'Question', presentation: { kind: 'html-v1', fallback: 'Readable fallback' } },
    onProposal: (proposal) => proposals.push(proposal),
  });
  const frame = container.children[0].children.find((child) => child.tagName === 'iframe');
  const send = (data) => {
    const event = new Event('message');
    Object.defineProperties(event, { source: { value: frame.contentWindow }, data: { value: data } });
    window.dispatchEvent(event);
  };
  return { dispose, proposals, send };
}

test('the host accepts bounded dense proposals and rejects sparse or expanding arrays sent around the bridge', () => {
  const { dispose, proposals, send } = fixture();
  send({ type: 'threadroom:proposal', values: [, 42], summary: 'Sparse' });
  let serializationCalls = 0;
  const sharedLeaf = { text: 'x'.repeat(1000) };
  // This probe is not iframe-authored data (structured clone strips methods); it
  // proves the receiver rejects cumulative expansion before invoking stringify.
  Object.defineProperty(sharedLeaf, 'toJSON', { value() { serializationCalls += 1; return this; } });
  send({ type: 'threadroom:proposal', values: Array(70).fill(sharedLeaf), summary: 'Expanded beyond the limit' });
  assert.equal(serializationCalls, 0);
  assert.deepEqual(proposals, []);

  send({ type: 'threadroom:proposal', values: [null, 42], summary: 'Dense' });
  assert.deepEqual(proposals, [{ values: [null, 42], summary: 'Dense' }]);

  dispose();
  send({ type: 'threadroom:proposal', values: ['late'] });
  assert.equal(proposals.length, 1);
});
