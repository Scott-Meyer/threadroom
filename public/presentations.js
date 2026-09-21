const MESSAGE_TYPE = 'threadroom:proposal';
const MAX_MESSAGE_BYTES = 65536;
const MAX_SUMMARY_LENGTH = 4096;
const MAX_JSON_DEPTH = 32;

// JSON only: no Date, Map, non-finite numbers or undefined silently discarded
// by JSON.stringify. Bound depth/work as well as the serialized byte count.
function isJson(value, depth = 0, budget = { remaining: MAX_MESSAGE_BYTES }) {
  if (--budget.remaining < 0 || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    // Count every occurrence, not only each distinct object. Structured clone
    // preserves shared identity, while JSON serialization expands every use.
    budget.remaining -= value.length;
    return budget.remaining >= 0;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    // JSON.stringify walks through array length, including holes. Reject sparse
    // or impossibly large arrays before serialization can monopolize the host.
    if (value.length > budget.remaining) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJson(value[index], depth + 1, budget)) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  for (const [key, item] of Object.entries(value)) {
    budget.remaining -= key.length;
    if (budget.remaining < 0 || !isJson(item, depth + 1, budget)) return false;
  }
  return true;
}

function proposalFromMessage(data) {
  try {
    if (typeof data === 'string') {
      if (data.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(data).length > MAX_MESSAGE_BYTES) return null;
      data = JSON.parse(data);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== MESSAGE_TYPE) return null;
    if (!Object.hasOwn(data, 'values') || !isJson(data)) return null;
    const json = JSON.stringify(data);
    if (new TextEncoder().encode(json).length > MAX_MESSAGE_BYTES) return null;
    if (data.summary !== undefined && (typeof data.summary !== 'string' || data.summary.length > MAX_SUMMARY_LENGTH)) return null;
    const values = JSON.parse(json).values;
    const summary = data.summary?.trim() || readableValue(values).slice(0, MAX_SUMMARY_LENGTH);
    return { values, summary };
  } catch {
    return null;
  }
}

function readableValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function fallbackText(presentation) {
  const fallback = presentation?.fallback;
  if (typeof fallback === 'string' && fallback.trim()) return fallback;
  if (fallback && typeof fallback === 'object') return readableValue(fallback);
  return 'This authored canvas proposes a draft only. You can always answer in text or reject using the host controls below.';
}

function element(document, tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

// Only append/remove our own presentation subtree. The caller retains ownership
// of dependable answer/reject controls and decides what a proposal means.
export function mountPresentation(container, { node, onProposal, apiBaseUrl = '' }) {
  if (typeof onProposal !== 'function') throw new TypeError('onProposal must be a function');
  const document = container.ownerDocument;
  const window = document.defaultView;
  const root = element(document, 'div', 'presentation');
  const presentation = node?.presentation || { kind: 'text-v1' };
  const disposers = [];
  let mounted = true;
  const emit = (proposal) => { if (mounted) onProposal(proposal); };
  const listen = (target, type, callback) => {
    target.addEventListener(type, callback);
    disposers.push(() => target.removeEventListener(type, callback));
  };
  const fallback = () => root.append(element(document, 'div', 'fallback-presentation', fallbackText(presentation)));

  if (presentation.kind === 'html-v1') {
    root.append(element(document, 'p', 'presentation-eyebrow', 'AUTHORED CANVAS · PROPOSES A DRAFT, NEVER SUBMITS'));
    const frame = element(document, 'iframe', 'authored-frame');
    frame.title = `Interactive presentation: ${node.title || node.prompt || 'question or answer'}`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // Additional defense in supporting browsers. CSP on the served document is
    // authoritative; this Permissions Policy also denies unrelated capabilities.
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; fullscreen 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'");
    frame.setAttribute('height', '360');
    frame.setAttribute('width', '100%');
    frame.src = `${apiBaseUrl.replace(/\/$/, '')}/api/nodes/${encodeURIComponent(node.id)}/presentation`;
    listen(window, 'message', (event) => {
      // Sandboxed documents have opaque origin ('null'); origin cannot identify
      // them. WindowProxy identity associates a proposal with exactly this node.
      if (!mounted || event.source !== frame.contentWindow) return;
      const proposal = proposalFromMessage(event.data);
      if (proposal) emit(proposal);
    });
    root.append(frame);
    fallback();
  } else if (presentation.kind === 'comparison-v1' && Array.isArray(presentation.options)) {
    const grid = element(document, 'div', 'comparison-grid');
    const buttons = [];
    for (const option of presentation.options) {
      if (!option || typeof option.id !== 'string' || typeof option.label !== 'string') continue;
      const button = element(document, 'button', 'option-card');
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      if (typeof option.image === 'string' && option.image) {
        const image = element(document, 'img', 'option-image');
        // Image context permits self-contained SVG too; never accept script or
        // HTML URLs. Relative asset paths resolve against the host document.
        let safeImage = false;
        try {
          const url = new URL(option.image, document.baseURI);
          safeImage = ['http:', 'https:'].includes(url.protocol) || /^data:image\//i.test(option.image);
        } catch { /* invalid URL: retain the readable option */ }
        if (safeImage) {
          image.src = option.image;
          image.alt = typeof option.alt === 'string' ? option.alt : option.label;
          image.referrerPolicy = 'no-referrer';
          button.append(image);
        }
      }
      const copy = element(document, 'span', 'option-copy');
      copy.append(element(document, 'strong', '', option.label));
      if (typeof option.detail === 'string') copy.append(element(document, 'small', '', option.detail));
      button.append(copy);
      listen(button, 'click', () => {
        for (const candidate of buttons) {
          candidate.classList.toggle('selected', candidate === button);
          candidate.setAttribute('aria-pressed', String(candidate === button));
        }
        emit({ values: { id: option.id, label: option.label }, summary: [option.label, option.detail].filter(Boolean).join(' — ') });
      });
      buttons.push(button);
      grid.append(button);
    }
    root.append(grid);
    if (!buttons.length) fallback();
  } else if (presentation.kind === 'text-v1') {
    if (typeof presentation.text === 'string') root.append(element(document, 'div', 'fallback-presentation', presentation.text));
    const list = element(document, 'div', 'choice-list');
    const choices = Array.isArray(presentation.choices) ? [...new Set(presentation.choices.filter((choice) => typeof choice === 'string'))] : [];
    const selected = new Set();
    const buttons = [];
    for (const choice of choices) {
      const button = element(document, 'button', 'choice-pill', choice);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      listen(button, 'click', () => {
        if (presentation.multiple) {
          if (selected.has(choice)) selected.delete(choice);
          else selected.add(choice);
        } else {
          selected.clear();
          selected.add(choice);
        }
        for (const item of buttons) {
          const active = selected.has(item.choice);
          item.button.classList.toggle('selected', active);
          item.button.setAttribute('aria-pressed', String(active));
        }
        const values = choices.filter((item) => selected.has(item));
        emit({ values, summary: values.join('; ') || 'No choices selected' });
      });
      buttons.push({ button, choice });
      list.append(button);
    }
    root.append(list);
    if (presentation.fallback) fallback();
  } else {
    fallback();
  }

  container.append(root);
  return () => {
    if (!mounted) return;
    mounted = false;
    for (const dispose of disposers) dispose();
    root.remove();
  };
}
