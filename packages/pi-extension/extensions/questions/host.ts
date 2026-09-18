import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { QuestionModel } from './model.ts';
import { QuestionView } from './view.ts';
import type { QuestionGroup } from './types.ts';
import { editTextOutsidePi } from './external-editor.ts';

const registryKey = Symbol.for('pi.private-question.focus.v1');
const owners: WeakMap<object, { handoff(data: string, fallback?: any): void }> = (globalThis as any)[registryKey] ??= new WeakMap();
function mountedEditor(tui: any, preferred?: any, fallback?: any) {
  const seen = new Set<any>(), queue = [...(tui.children || [])];
  while (queue.length) { const child = queue.pop(); if (!child || seen.has(child)) continue; seen.add(child); if (Array.isArray(child.children)) queue.push(...child.children); }
  const editor = (child: any) => seen.has(child) && typeof child?.getText === 'function' && typeof child?.setText === 'function';
  return editor(preferred) ? preferred : editor(fallback) ? fallback : [...seen].find(editor);
}

/** A session-owned editor loan, not an overlay or replacement editor.
 * Mount disposal retires focus; scope disposal also detaches outstanding groups. */
export function createQuestionHost(context: any, options: { collapseKey?: string | false } = {}) {
  let tui: any, palette: any, view: QuestionView | undefined, previous: any, mounted = false, disposed = false, foreign = false;
  let inspect = false, offset = 0, page = 1, shown: string | undefined, scheduled = false;
  const collapsed = new Set<string>(), widgetKey = 'private-question-surface';
  // A collapsed surface must loan focus back to the editor and reopen there.
  // Without the public terminal hook, keep the focused question visible instead.
  const collapseKey = typeof context.ui.onTerminalInput === 'function'
    ? (options.collapseKey === undefined ? 'ctrl+]' : options.collapseKey) : false;
  const model = new QuestionModel(() => { if (!disposed) { tui?.requestRender(); schedule(); } });
  const displayKey = () => { const tab = model.current()?.tab; return tab && JSON.stringify([tab.key, tab.incarnation]); };
  const isCollapsed = () => { const key = displayKey(); return !!key && collapsed.has(key); };
  const stopInput = collapseKey ? context.ui.onTerminalInput?.((data: string) => {
    if (disposed || foreign || !mounted || !model.current() || !matchesKey(data, collapseKey as any)) return;
    const focus = tui.getFocusedComponent();
    if (focus !== component && !(isCollapsed() && mountedEditor(tui, focus) === focus)) return;
    if (!isKeyRelease(data) && !isKeyRepeat(data)) toggleCollapse();
    return { consume: true };
  }) : undefined;
  function release() { if (tui?.getFocusedComponent() === component) tui.setFocus(mountedEditor(tui, previous) || null); }
  function reconcile() {
    if (disposed || !mounted || !tui) return;
    const current = model.current();
    if (!current || current.paused || foreign || (isCollapsed() && stopInput)) { release(); return; }
    const focus = tui.getFocusedComponent();
    if (mountedEditor(tui, focus) === focus && focus) { previous = focus; tui.setFocus(component); }
  }
  function schedule() {
    if (scheduled || disposed) return; scheduled = true;
    queueMicrotask(() => { scheduled = false; if (disposed) return; if (!model.tabs().length && mounted) { release(); context.ui.setWidget(widgetKey, undefined); } else reconcile(); });
  }
  function toggleCollapse() {
    const current = model.current(); if (!current) return;
    const key = displayKey()!; if (isCollapsed()) collapsed.delete(key); else collapsed.add(key);
    inspect = false; offset = 0; reconcile(); tui.requestRender();
  }
  const owner = { handoff(data: string, fallback?: any) {
    if (disposed) return;
    const target = mountedEditor(tui, previous, fallback); tui.setFocus(target || null); reconcile();
    if (tui.getFocusedComponent() === component) component.handleInput(data); else target?.handleInput?.(data);
  } };
  const component = {
    focused: false,
    render(width: number) {
      reconcile(); if (!view || !model.current()) return [];
      view.focused = tui.getFocusedComponent() === component;
      const current = model.current()!; if (shown !== displayKey()) { shown = displayKey(); inspect = false; offset = 0; }
      const framed = width >= 4, innerWidth = framed ? width - 2 : width;
      const frame = view.frame(innerWidth, inspect), budget = Math.max(4, Math.min(20, tui.terminal.rows - 12));
      const box = (rows: string[]) => framed ? rows.map((line, index) => {
        const top = index === 0, bottom = index === rows.length - 1, text = truncateToWidth(line, innerWidth, '');
        const edge = (value: string) => palette.fg('borderAccent', value);
        return edge(top ? '╭' : bottom ? '╰' : '│') + text + (top || bottom ? edge('─'.repeat(Math.max(0, innerWidth - visibleWidth(text)))) : ' '.repeat(Math.max(0, innerWidth - visibleWidth(text)))) + edge(top ? '╮' : bottom ? '╯' : '│');
      }) : rows;
      if (isCollapsed()) return box([frame.header[0], truncateToWidth(`Collapsed · ${collapseKey || '/asks'} reopens · draft retained`, innerWidth, ''), frame.footer]);
      page = Math.max(1, budget - frame.header.length - 1); const last = Math.max(0, frame.lines.length - page);
      offset = inspect ? Math.max(0, Math.min(last, offset)) : Math.max(0, Math.min(last, frame.focus[0] - Math.floor(page / 2)));
      return box([...frame.header, ...frame.lines.slice(offset, offset + page), frame.footer].slice(0, budget));
    },
    handleInput(data: string) {
      if (disposed || !mounted || !model.current()) {
        if (tui?.getFocusedComponent() === component) {
          const successor = owners.get(tui);
          if (successor && successor !== owner) successor.handoff(data, previous);
          else { const target = mountedEditor(tui, previous); tui.setFocus(target || null); target?.handleInput?.(data); }
          tui.requestRender();
        }
        return;
      }
      if (foreign || tui.getFocusedComponent() !== component || isKeyRelease(data)) return;
      if (collapseKey && matchesKey(data, collapseKey as any)) { if (!stopInput && !isKeyRepeat(data)) toggleCollapse(); return; }
      if (isCollapsed()) return; // Never edit an invisible draft on a host without a raw listener.
      if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) { if (!inspect) { inspect = true; offset = 0; } else offset += matchesKey(data, 'pageDown') ? page : -page; tui.requestRender(); return; }
      inspect = false; view!.handleInput(data); reconcile(); schedule();
    },
    invalidate() { view?.invalidate(); },
    dispose() { release(); mounted = false; if (tui && owners.get(tui) === owner) owners.delete(tui); },
  };
  function ensure() {
    if (disposed) throw Object.assign(new Error('Question host detached.'), { code: 'presentation_detached' });
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
    select(groupId: string, questionId?: string) { ensure(); const tab = model.tabs().find((tab) => tab.groupId === groupId && tab.questionId === questionId); if (tab) collapsed.delete(JSON.stringify([tab.key, tab.incarnation])); model.select(groupId, questionId); reconcile(); },
    snapshot() { return Object.freeze({ tabs: model.tabs(), current: model.current() }); },
    suspend(value: boolean) { foreign = value; if (value) release(); else reconcile(); tui?.requestRender(); },
    dispose() { if (disposed) return; disposed = true; stopInput?.(); release(); if (tui && owners.get(tui) === owner) owners.delete(tui); model.dispose(); view?.dispose(); if (mounted) context.ui.setWidget(widgetKey, undefined); mounted = false; },
  };
}
