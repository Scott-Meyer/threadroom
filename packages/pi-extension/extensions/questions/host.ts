import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { QuestionModel } from './model.ts';
import { QuestionView } from './view.ts';
import type { QuestionGroup } from './types.ts';
import { editTextOutsidePi } from './external-editor.ts';

const registryKey = Symbol.for('pi.private-question.focus.v1');
const owners: WeakMap<object, { handoff(data: string, fallback?: any): void }> = (globalThis as any)[registryKey] ??= new WeakMap();
function mountedComponents(tui: any) {
  const seen = new Set<any>(), queue = [...(tui?.children || [])];
  while (queue.length) { const child = queue.pop(); if (!child || seen.has(child)) continue; seen.add(child); if (Array.isArray(child.children)) queue.push(...child.children); }
  return seen;
}
function coreEditor(context: any) {
  if (typeof context?.ui?.getCoreEditor !== 'function') return undefined;
  try {
    const editor = context.ui.getCoreEditor();
    return editor && typeof editor.handleInput === 'function' ? editor : undefined;
  } catch { return undefined; }
}
function mountedCoreEditor(context: any, tui: any) {
  const editor = coreEditor(context);
  return editor && mountedComponents(tui).has(editor) ? editor : undefined;
}
/** Stock interactive hosts need the public widget capability, not a patched SDK.
 * The widget factory validates the TUI focus boundary when it mounts. */
export function supportsQuestionHost(context: any) { return typeof context?.ui?.setWidget === 'function'; }
export type QuestionHostOptions = {
  /** Optional older collapse/reentry route. It is independent of focus toggling. */
  collapseKey?: string | false;
  /** Toggle between the selected question and its previous input. `false` keeps focus local. */
  focusToggleKey?: string | false;
};

/** A session-owned editor loan, not an overlay or replacement editor.
 * Mount disposal retires focus; scope disposal also detaches outstanding groups. */
export function createQuestionHost(context: any, options: QuestionHostOptions = {}) {
  let tui: any, palette: any, view: QuestionView | undefined, mounted = false, disposed = false, foreign = false;
  let inspect = false, offset = 0, page = 1, shown: string | undefined, scheduled = false;
  let chat = false, chatFrom: string | undefined, origin: any;
  const collapsed = new Set<string>(), widgetKey = 'private-question-surface';
  // An editor loan is safe only when raw input can reclaim the focus-toggle key.
  // Ordinary Tab is reserved even if a caller accidentally configures it.
  const hasTerminalInput = typeof context.ui.onTerminalInput === 'function';
  const safeShortcut = (value: unknown) => typeof value === 'string' && !!value.trim() && value.trim().toLowerCase() !== 'tab' ? value.trim() : false;
  const collapseKey = hasTerminalInput ? safeShortcut(options.collapseKey === undefined ? 'ctrl+]' : options.collapseKey) : false;
  const focusToggleKey = hasTerminalInput ? safeShortcut(options.focusToggleKey === undefined ? 'shift+tab' : options.focusToggleKey) : false;
  const model = new QuestionModel(() => { if (!disposed) { tui?.requestRender(); schedule(); } });
  const displayKey = () => { const tab = model.current()?.tab; return tab && JSON.stringify([tab.key, tab.incarnation]); };
  const isCollapsed = () => { const key = displayKey(); return !!key && collapsed.has(key); };
  const isHomeLoan = () => chat || isCollapsed() || !!model.current()?.paused;
  // An optional SDK identity grants automatic core-editor focus authority.
  // Otherwise only an explicit action lends focus, with its exact input origin
  // retained for return. A loan origin is not evidence of a Chat/editor role.
  const mountedInput = (input: any) => input && typeof input.handleInput === 'function' && mountedComponents(tui).has(input) ? input : undefined;
  const returnInput = () => coreEditor(context) ? mountedCoreEditor(context, tui) : mountedInput(origin);
  const focusEditor = () => focusToggleKey && returnInput();
  function release(clear = false) {
    if (tui?.getFocusedComponent() !== component) return;
    const target = returnInput();
    if (target) tui.setFocus(target); else if (clear || !coreEditor(context)) tui.setFocus(null);
  }
  function focusQuestion(explicit = false) {
    const target = model.current()?.tab;
    if (!target || foreign) return false;
    const focus = tui.getFocusedComponent();
    if (focus !== component) {
      if (!explicit) return false;
      const core = coreEditor(context);
      if (core ? focus !== mountedCoreEditor(context, tui) : !mountedInput(focus)) return false;
      if (!core) origin = focus;
    }
    collapsed.delete(JSON.stringify([target.key, target.incarnation])); chat = false; chatFrom = undefined;
    model.select(target.groupId, target.questionId); tui.setFocus(component); tui.requestRender(); return true;
  }
  function enterChat() {
    const target = focusEditor();
    if (!target) return false;
    chat = true; chatFrom = displayKey(); tui.setFocus(target); tui.requestRender(); return true;
  }
  const stopInput = hasTerminalInput ? context.ui.onTerminalInput((data: string) => {
    if (disposed || foreign || !mounted || !model.current()) return;
    const focus = tui.getFocusedComponent();
    if (collapseKey && matchesKey(data, collapseKey as any)) {
      const ordinaryEditor = returnInput();
      if (!ordinaryEditor || (focus !== component && !(focus === ordinaryEditor && isHomeLoan()))) return;
      if (!isKeyRelease(data) && !isKeyRepeat(data)) {
        if (focus === component) toggleCollapse();
        else focusQuestion(true);
      }
      return { consume: true };
    }
    if (!focusToggleKey || !matchesKey(data, focusToggleKey as any)) return;
    const core = coreEditor(context), editor = focusEditor();
    const eligible = focus === component ? !!editor
      : core ? focus === editor && isHomeLoan() : !!mountedInput(focus);
    if (!eligible) return;
    if (!isKeyRelease(data) && !isKeyRepeat(data)) {
      if (focus === component) enterChat(); else focusQuestion(true);
    }
    return { consume: true };
  }) : undefined;
  function reconcile() {
    if (disposed || !mounted || !tui) return;
    const current = model.current();
    if (!current) { release(); return; }
    const focus = tui.getFocusedComponent();
    if (current.paused || foreign || (isCollapsed() && stopInput)) { release(); return; }
    if (chat) {
      if (coreEditor(context) && current.tab.mode === 'blocking' && chatFrom !== displayKey()) { chat = false; chatFrom = undefined; }
      else if (focus === focusEditor()) return;
      else if (focus !== component) return; // A foreign prompt owns its own focus lifetime.
      else { chat = false; chatFrom = undefined; }
    }
    const editor = mountedCoreEditor(context, tui);
    if (editor && focus === editor) tui.setFocus(component);
  }
  function schedule() {
    if (scheduled || disposed) return; scheduled = true;
    queueMicrotask(() => { scheduled = false; if (disposed) return; if (!model.tabs().length && mounted) { release(); context.ui.setWidget(widgetKey, undefined); } else reconcile(); });
  }
  function toggleCollapse() {
    const current = model.current(); if (!current) return;
    const key = displayKey()!; if (isCollapsed()) collapsed.delete(key); else collapsed.add(key);
    chat = false; chatFrom = undefined; inspect = false; offset = 0; reconcile(); tui.requestRender();
  }
  const owner = { handoff(data: string, fallback?: any) {
    if (disposed) return;
    // An outgoing private pane can transfer its existing loan, not invent a
    // core role for the previous input or discover an arbitrary replacement.
    if (!coreEditor(context)) origin = mountedInput(origin) || mountedInput(fallback);
    if (model.current() && !foreign && !isHomeLoan()) tui.setFocus(component);
    else tui.setFocus(returnInput() || null);
    if (tui.getFocusedComponent() === component) component.handleInput(data); else returnInput()?.handleInput(data);
  } };
  const component = {
    focused: false,
    render(width: number) {
      reconcile(); if (!view || !model.current()) return [];
      const focus = tui.getFocusedComponent(), core = coreEditor(context), ordinaryEditor = returnInput();
      view.focused = !foreign && focus === component;
      view.inputIsCore = !!core;
      const mayEnter = !foreign && (view.focused || (core ? !!ordinaryEditor && focus === ordinaryEditor : !!mountedInput(focus)));
      const mayToggle = !foreign && (view.focused ? !!ordinaryEditor : core ? !!ordinaryEditor && focus === ordinaryEditor && isHomeLoan() : !!mountedInput(focus));
      const mayCollapse = !foreign && !!ordinaryEditor && (view.focused || focus === ordinaryEditor && isHomeLoan());
      view.entryAvailable = mayEnter;
      view.focusToggleKey = mayToggle ? focusToggleKey || undefined : undefined;
      view.chatReturnKey = mayCollapse ? collapseKey || undefined : undefined;
      view.chatFocused = !!core && !!ordinaryEditor && focus === ordinaryEditor;
      const current = model.current()!; if (shown !== displayKey()) { shown = displayKey(); inspect = false; offset = 0; }
      const framed = width >= 4, innerWidth = framed ? width - 2 : width;
      const frame = view.frame(innerWidth, inspect), budget = Math.max(4, Math.min(20, tui.terminal.rows - 12));
      const box = (rows: string[]) => framed ? rows.map((line, index) => {
        const top = index === 0, bottom = index === rows.length - 1, text = truncateToWidth(line, innerWidth, '');
        const role = view.focused ? 'borderAccent' : 'borderMuted';
        const horizontal = view.focused ? '─' : '┈', vertical = view.focused ? '│' : '┊';
        const edge = (value: string) => palette.fg(role, value);
        return edge(top ? '╭' : bottom ? '╰' : vertical) + text + (top || bottom ? edge(horizontal.repeat(Math.max(0, innerWidth - visibleWidth(text)))) : ' '.repeat(Math.max(0, innerWidth - visibleWidth(text)))) + edge(top ? '╮' : bottom ? '╯' : vertical);
      }) : rows;
      if (isCollapsed()) {
        const reentry = view.chatReturnKey || view.focusToggleKey || (view.entryAvailable ? '/asks' : undefined);
        return box([frame.header[0], truncateToWidth(`Collapsed${reentry ? ` · ${reentry} reopens` : ''} · draft retained`, innerWidth, ''), frame.footer]);
      }
      page = Math.max(1, budget - frame.header.length - 1); const last = Math.max(0, frame.lines.length - page);
      offset = inspect ? Math.max(0, Math.min(last, offset)) : Math.max(0, Math.min(last, frame.focus[0] - Math.floor(page / 2)));
      return box([...frame.header, ...frame.lines.slice(offset, offset + page), frame.footer].slice(0, budget));
    },
    handleInput(data: string) {
      if (disposed || !mounted || !model.current()) {
        if (tui?.getFocusedComponent() === component) {
          const successor = owners.get(tui), editor = returnInput();
          if (successor && successor !== owner) successor.handoff(data, editor);
          else { tui.setFocus(editor || null); editor?.handleInput(data); }
          tui.requestRender();
        }
        return;
      }
      if (foreign || tui.getFocusedComponent() !== component || isKeyRelease(data)) return;
      if (focusToggleKey && matchesKey(data, focusToggleKey as any)) return; // Raw hook owns supported toggles.
      if (collapseKey && matchesKey(data, collapseKey as any)) { if (!stopInput && !isKeyRepeat(data)) toggleCollapse(); return; }
      if (isCollapsed()) return; // Never edit an invisible draft on a host without a raw listener.
      if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) { if (!inspect) { inspect = true; offset = 0; } else offset += matchesKey(data, 'pageDown') ? page : -page; tui.requestRender(); return; }
      inspect = false; view!.handleInput(data);
      if (matchesKey(data, 'tab')) focusQuestion();
      reconcile(); schedule();
    },
    invalidate() { view?.invalidate(); },
    dispose() { release(!tui || owners.get(tui) === owner); mounted = false; if (tui && owners.get(tui) === owner) owners.delete(tui); },
  };
  function ensure() {
    if (disposed) throw Object.assign(new Error('Question host detached.'), { code: 'presentation_detached' });
    if (!supportsQuestionHost(context)) throw Object.assign(new Error('This Pi host does not expose inline widgets; no question was presented.'), { code: 'unsupported_host' });
    if (mounted) return;
    context.ui.setWidget(widgetKey, (reference: any, theme: any) => {
      if (typeof reference.getFocusedComponent !== 'function' || typeof reference.setFocus !== 'function') throw new Error('SDK lacks public inline focus support.');
      tui = reference; palette = theme;
      // Renderer references can be write-through Proxies. Never assign their methods.
      const delegate = new Proxy({} as any, { get(_target, property) { const value = Reflect.get(tui, property, tui); return typeof value === 'function' ? value.bind(tui) : value; } });
      view ||= new QuestionView(model, delegate, theme, async (text) => {
        try {
          const { SettingsManager } = await import('@earendil-works/pi-coding-agent');
          if (disposed || !mounted || foreign || owners.get(tui) !== owner || tui.getFocusedComponent() !== component) return undefined;
          const command = SettingsManager.create(context.cwd, undefined, { projectTrusted: context.isProjectTrusted?.() ?? false }).getExternalEditorCommand();
          return editTextOutsidePi(delegate, command || '', text);
        } catch (error) { if (disposed || !mounted || owners.get(tui) !== owner) return undefined; throw error; }
      }); owners.set(tui, owner); mounted = true;
      queueMicrotask(reconcile); return component;
    }, { placement: 'aboveEditor' });
    if (!mounted) throw new Error('SDK did not mount question widget synchronously.');
  }
  return {
    enqueue(group: QuestionGroup) { ensure(); return model.enqueue(group); },
    select(groupId: string, questionId?: string) { ensure(); const tab = model.tabs().find((tab) => tab.groupId === groupId && tab.questionId === questionId); if (tab) collapsed.delete(JSON.stringify([tab.key, tab.incarnation])); chat = false; chatFrom = undefined; model.select(groupId, questionId); reconcile(); },
    /** Explicit person action; automatic selection/projection never lends stock focus. */
    activate() { ensure(); return focusQuestion(true); },
    snapshot() { return Object.freeze({ tabs: model.tabs(), current: model.current() }); },
    suspend(value: boolean) { foreign = value; if (value) release(); else reconcile(); tui?.requestRender(); },
    dispose() { if (disposed) return; disposed = true; stopInput?.(); release(!tui || owners.get(tui) === owner); if (tui && owners.get(tui) === owner) owners.delete(tui); model.dispose(); view?.dispose(); if (mounted) context.ui.setWidget(widgetKey, undefined); mounted = false; },
  };
}
