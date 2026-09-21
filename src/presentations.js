// Authored documents are deliberately separate from the host UI and response controls.
// Serve this policy as an HTTP header: sandbox/frame-ancestors do not work in a meta tag.
// CSP is not CPU isolation. Own-frame navigation is constrained by the embedding UI's frame-src.
export const PRESENTATION_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'", 
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*",
  'sandbox allow-scripts'
].join('; ');

// No host identity or response API is available to this bridge. A proposal is a
// draft; only the host's controls can decide whether to persist an answer.
const bridge = `<script>
(() => {
  const send = window.parent.postMessage.bind(window.parent);
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const encoder = new TextEncoder();
  const encode = Function.call.bind(TextEncoder.prototype.encode);
  const arrayIsArray = Array.isArray;
  const Seen = WeakSet;
  const weakSetHas = Function.call.bind(Seen.prototype.has);
  const weakSetAdd = Function.call.bind(Seen.prototype.add);
  const weakSetDelete = Function.call.bind(Seen.prototype.delete);
  const objectKeys = Object.keys;
  const objectPrototype = Object.prototype;
  const getPrototypeOf = Object.getPrototypeOf;
  const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const ownKeys = Reflect.ownKeys;
  const createObject = Object.create;
  const defineProperty = Object.defineProperty;
  const isFiniteNumber = Number.isFinite;
  const hasOwn = Function.call.bind(objectPrototype.hasOwnProperty);
  const validateJson = (value, seen = new Seen()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!isFiniteNumber(value)) throw new TypeError('Proposal values must contain only finite JSON numbers');
      return value;
    }
    if (typeof value !== 'object') throw new TypeError('Proposal values must be JSON-compatible');
    if (weakSetHas(seen, value)) throw new TypeError('Proposal values must not contain cycles');
    const array = arrayIsArray(value);
    const prototype = getPrototypeOf(value);
    if (!array && prototype !== objectPrototype && prototype !== null) {
      throw new TypeError('Proposal values must contain only JSON objects and arrays');
    }
    const descriptors = getOwnPropertyDescriptors(value);
    for (const key of ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (descriptor.get || descriptor.set) throw new TypeError('Proposal values must not define accessors');
    }
    if (typeof descriptors.toJSON?.value === 'function') {
      throw new TypeError('Proposal values must not define custom toJSON behavior');
    }
    weakSetAdd(seen, value);
    let copy;
    if (array) {
      copy = [];
      // Never allow an authored Array.prototype.toJSON to transform the copy.
      defineProperty(copy, 'toJSON', { value: undefined });
      for (let index = 0; index < descriptors.length.value; index += 1) {
        if (!hasOwn(descriptors, index)) throw new TypeError('Proposal arrays must not be sparse');
        defineProperty(copy, index, { value: validateJson(descriptors[index].value, seen), enumerable: true, writable: true, configurable: true });
      }
    } else {
      copy = createObject(null);
      for (const key of objectKeys(descriptors)) {
        if (!descriptors[key].enumerable) continue;
        defineProperty(copy, key, { value: validateJson(descriptors[key].value, seen), enumerable: true, writable: true, configurable: true });
      }
    }
    weakSetDelete(seen, value);
    return copy;
  };
  const propose = (values, summary) => {
    if (summary !== undefined && (typeof summary !== 'string' || summary.length > 4096)) {
      throw new TypeError('Proposal summary must be a string of at most 4096 characters');
    }
    const valuesSnapshot = validateJson(values);
    const message = createObject(null);
    message.type = 'threadroom:proposal';
    message.values = valuesSnapshot;
    if (summary !== undefined) message.summary = summary;
    const json = stringify(message);
    if (encode(encoder, json).length > 65536) throw new RangeError('Proposal exceeds 64 KiB');
    const copy = parse(json);
    if (!hasOwn(copy, 'values')) throw new TypeError('Proposal needs JSON values');
    send(copy, '*');
  };
  Object.defineProperty(window, 'Threadroom', {
    value: Object.freeze({propose}), writable: false, configurable: false
  });
})();
</script>`;

export function renderPresentationDocument(presentation) {
  if (presentation?.kind !== 'html-v1' || typeof presentation.html !== 'string') {
    throw new TypeError('Expected an html-v1 presentation with an HTML document');
  }
  const html = presentation.html;
  // Start the bridge before any authored scripts, preserving the document's
  // doctype (and therefore standards mode). The parser merges the authored head.
  const doctype = html.match(/^\s*<!doctype\s+html\b[^>]*>/i);
  if (doctype) return `${doctype[0]}\n${bridge}\n${html.slice(doctype[0].length)}`;
  return `<!doctype html>\n${bridge}\n${html}`;
}
