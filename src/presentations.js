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
  const propose = (values, summary) => {
    if (summary !== undefined && (typeof summary !== 'string' || summary.length > 4096)) {
      throw new TypeError('Proposal summary must be a string of at most 4096 characters');
    }
    const message = {type: 'threadroom:proposal', values};
    if (summary !== undefined) message.summary = summary;
    const json = stringify(message);
    if (encoder.encode(json).length > 65536) throw new RangeError('Proposal exceeds 64 KiB');
    const copy = parse(json);
    if (!Object.prototype.hasOwnProperty.call(copy, 'values')) throw new TypeError('Proposal needs JSON values');
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
