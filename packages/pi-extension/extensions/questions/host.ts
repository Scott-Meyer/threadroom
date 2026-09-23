import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { QuestionModel } from './model.ts';
import { QuestionView } from './view.ts';
import type { QuestionGroup } from './types.ts';
import { editTextOutsidePi } from './external-editor.ts';

const registryKey = Symbol.for('pi.private-question.focus.v1');
const noReturn = Symbol('pi.private-question.no-return');
const owners: WeakMap<object, { handoff(data: string, fallback?: any, modalReturn?: any): false | { origin?: any } }> = (globalThis as any)[registryKey] ??= new WeakMap();
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
  // Legacy terminals report several native keys as Ctrl chords, so those
  // spellings cannot safely become global shortcuts.
  const hasTerminalInput = typeof context.ui.onTerminalInput === 'function';
  const shortcutIdentity = (value: string) => {
    const parts = value.toLowerCase().split('+').map((part) => part.trim());
    const authoredKey = parts.pop();
    const keyAliases: Record<string, string> = { esc: 'escape', return: 'enter' };
    const key = authoredKey && (keyAliases[authoredKey] || authoredKey);
    const order: Record<string, number> = { ctrl: 0, alt: 1, shift: 2, super: 3 };
    if (!key || parts.some((part) => !Object.prototype.hasOwnProperty.call(order, part)) || new Set(parts).size !== parts.length) return false;
    return [...parts.sort((left, right) => order[left] - order[right]), key].join('+');
  };
  const safeShortcut = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    const normalized = shortcutIdentity(value);
    // Ctrl+H/I/J/M/[ are indistinguishable from Backspace, Tab, line feed,
    // Enter and Escape respectively on legacy terminal input.
    const nativeAliases = new Set(['backspace', 'tab', 'enter', 'escape', 'ctrl+h', 'ctrl+i', 'ctrl+j', 'ctrl+m', 'ctrl+[']);
    return normalized && !nativeAliases.has(normalized) ? normalized : false;
  };
  const configuredCollapseKey = hasTerminalInput ? safeShortcut(options.collapseKey === undefined ? 'ctrl+]' : options.collapseKey) : false;
  const focusToggleKey = hasTerminalInput ? safeShortcut(options.focusToggleKey === undefined ? 'shift+tab' : options.focusToggleKey) : false;
  // Focus toggling is the primary route. If both options name the same shortcut,
  // keep that route reachable instead of letting the earlier collapse branch win.
  const collapseKey = configuredCollapseKey && focusToggleKey
    && configuredCollapseKey === focusToggleKey ? false : configuredCollapseKey;
  const model = new QuestionModel(() => { if (!disposed) { tui?.requestRender(); schedule(); } });
  const hasBlocker = () => model.tabs().some((tab) => tab.mode === 'blocking');
  const tabKey = (tab: { key: string; incarnation: number }) => JSON.stringify([tab.key, tab.incarnation]);
  const displayKey = () => { const tab = model.current()?.tab; return tab && tabKey(tab); };
  // A pending blocker makes the whole shared question surface modal. Async
  // tabs remain usable inside it, but a previously collapsed tab cannot become
  // an escape route to Chat.
  const isCollapsed = () => { const key = displayKey(); return !hasBlocker() && !!key && collapsed.has(key); };
  const isHomeLoan = () => chat || isCollapsed() || !!model.current()?.paused;
  let modal = false, modalClaimedInput = false, modalPendingClaim = false, modalOrigin: any, modalPaneTab: string | undefined;
  let deferredModalReturn: { origin: any } | undefined, settledModalOrigin: any, explicitQuestionLoan = false, explicitQuestionOrigin: any;
  // Optional SDK identity distinguishes the core editor from foreign prompts.
  // Stock hosts retain the exact input a blocker or explicit action loans;
  // that origin is not evidence that a later replacement is also Chat.
  const mountedInput = (input: any) => input && typeof input.handleInput === 'function' && mountedComponents(tui).has(input) ? input : undefined;
  const returnInput = () => coreEditor(context) ? mountedCoreEditor(context, tui) : mountedInput(origin);
  const focusEditor = () => focusToggleKey && returnInput();
  function blockerInputEligible(focus: any, entering = false) {
    if (focus === component) return true;
    const core = coreEditor(context);
    if (core) return focus === mountedCoreEditor(context, tui);
    const retainedOrigin = modal ? modalOrigin : origin, retained = mountedInput(retainedOrigin);
    return !!mountedInput(focus) && (entering || modalPendingClaim || (!!retainedOrigin && focus === retained));
  }
  function release(clear = false) {
    if (tui?.getFocusedComponent() !== component) return;
    const modalReturn = modal, target = modalReturn ? mountedInput(modalOrigin) : returnInput();
    if (target) tui.setFocus(target); else if (clear || modalReturn || !coreEditor(context)) tui.setFocus(null);
  }
  function finishModal(defer = false) {
    if (!modal) return false;
    const claimed = modalClaimedInput, origin = modalOrigin, target = mountedInput(origin);
    modal = modalClaimedInput = modalPendingClaim = false; modalOrigin = undefined; modalPaneTab = undefined;
    if (!claimed) return false;
    settledModalOrigin = origin; explicitQuestionLoan = false; explicitQuestionOrigin = undefined;
    if (tui?.getFocusedComponent() === component) { tui.setFocus(target || null); return true; }
    if (defer) deferredModalReturn = { origin };
    return false;
  }
  function unwindDeferredModalReturn(data?: string) {
    if (!deferredModalReturn || foreign || hasBlocker() || tui?.getFocusedComponent() !== component) return false;
    const origin = deferredModalReturn.origin, target = mountedInput(origin); deferredModalReturn = undefined;
    settledModalOrigin = origin; explicitQuestionLoan = false; explicitQuestionOrigin = undefined;
    tui.setFocus(target || null); if (data !== undefined) target?.handleInput(data); return true;
  }
  function unwindSettledModalReturn(data?: string) {
    if (!settledModalOrigin || explicitQuestionLoan || foreign || hasBlocker() || tui?.getFocusedComponent() !== component) return false;
    const target = mountedInput(settledModalOrigin);
    tui.setFocus(target || null); if (data !== undefined) target?.handleInput(data); return true;
  }
  function availablePaneTab(preferred?: string, includePaused = false) {
    const available = (includePaused ? model.tabs() : model.unpausedTabs()).filter((tab) => tab.mode === 'async');
    const visible = available.filter((tab) => !collapsed.has(tabKey(tab)));
    return visible.find((tab) => tabKey(tab) === preferred) || visible[0]
      || available.find((tab) => tabKey(tab) === preferred) || available[0];
  }
  function continueInQuestions(tab: { key: string; groupId: string; questionId?: string; incarnation: number }) {
    const loan = modalClaimedInput ? modalOrigin : explicitQuestionOrigin || returnInput();
    modal = modalClaimedInput = modalPendingClaim = false; modalOrigin = undefined; modalPaneTab = undefined;
    deferredModalReturn = undefined; settledModalOrigin = undefined;
    explicitQuestionLoan = true; explicitQuestionOrigin = loan;
    chat = false; chatFrom = undefined; collapsed.delete(tabKey(tab));
    // Selecting also resumes a paused async group; successful required
    // completion deliberately hands the still-owned pane to that question.
    model.select(tab.groupId, tab.questionId);
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
      if (modal && hasBlocker()) {
        modalOrigin = focus; modalClaimedInput = true; modalPendingClaim = false;
      }
    }
    if (explicit) {
      // Explicit intent supersedes an older deferred return even when an
      // overlay has already restored the pane before /asks runs.
      explicitQuestionOrigin = focus === component
        ? deferredModalReturn?.origin || settledModalOrigin || (coreEditor(context) ? mountedCoreEditor(context, tui) : origin)
        : focus;
      deferredModalReturn = undefined; settledModalOrigin = undefined; explicitQuestionLoan = true;
    }
    collapsed.delete(JSON.stringify([target.key, target.incarnation])); chat = false; chatFrom = undefined;
    model.select(target.groupId, target.questionId); tui.setFocus(component); tui.requestRender(); return true;
  }
  function enterChat() {
    if (hasBlocker()) return false;
    const target = focusEditor();
    if (!target) return false;
    chat = true; chatFrom = displayKey(); tui.setFocus(target); tui.requestRender(); return true;
  }
  const stopInput = hasTerminalInput ? context.ui.onTerminalInput((data: string) => {
    if (disposed || foreign || !mounted || !model.current()) return;
    const focus = tui.getFocusedComponent();
    if (collapseKey && matchesKey(data, collapseKey as any)) {
      if (hasBlocker()) {
        if (!blockerInputEligible(focus, !modal)) return;
        if (!isKeyRelease(data) && !isKeyRepeat(data)) reconcile();
        return { consume: true };
      }
      const ordinaryEditor = returnInput();
      if (!ordinaryEditor || (focus !== component && !(focus === ordinaryEditor && isHomeLoan()))) return;
      if (!isKeyRelease(data) && !isKeyRepeat(data)) {
        if (focus === component) toggleCollapse();
        else focusQuestion(true);
      }
      return { consume: true };
    }
    if (!focusToggleKey || !matchesKey(data, focusToggleKey as any)) return;
    if (hasBlocker()) {
      if (!blockerInputEligible(focus, !modal)) return;
      if (!isKeyRelease(data) && !isKeyRepeat(data)) reconcile();
      return { consume: true };
    }
    const core = coreEditor(context), editor = focusEditor();
    const eligible = focus === component ? !!editor
      : core ? focus === editor : !!mountedInput(focus);
    if (!eligible) return;
    if (!isKeyRelease(data) && !isKeyRepeat(data)) {
      if (focus === component) enterChat(); else focusQuestion(true);
    }
    return { consume: true };
  }) : undefined;
  function reconcile() {
    if (disposed || !mounted || !tui) return;
    let current = model.current();
    const blocking = hasBlocker();
    if (!current) { if (!finishModal(true) && !unwindDeferredModalReturn() && !unwindSettledModalReturn()) release(); return; }
    if (foreign) { release(); return; }
    if (!blocking && !modal && (unwindDeferredModalReturn() || unwindSettledModalReturn())) return;
    const initialFocus = tui.getFocusedComponent(), enteringModal = blocking && !modal;
    if (enteringModal) {
      modal = true;
      modalPendingClaim = initialFocus !== component;
      modalClaimedInput = false;
      modalOrigin = modalPendingClaim ? undefined : returnInput();
    } else if (!blocking && modal) {
      const paneOwned = !modalClaimedInput && !modalPendingClaim, paneTab = modalPaneTab;
      const completion = model.takeBlockingCompletion(), answered = completion === 'answered';
      const available = availablePaneTab(paneTab, answered);
      if (answered && available) {
        continueInQuestions(available); current = model.current()!;
      } else {
        const restored = finishModal(true);
        chat = false; chatFrom = undefined;
        if (restored) return;
        if (paneOwned && available && tabKey(current.tab) !== tabKey(available)) {
          model.select(available.groupId, available.questionId); current = model.current()!;
        }
      }
    }
    if (blocking && current.paused) {
      const required = model.tabs().find((tab) => tab.mode === 'blocking');
      if (required) { model.select(required.groupId, required.questionId); current = model.current()!; }
    }
    const focus = tui.getFocusedComponent();
    if (blocking) {
      chat = false; chatFrom = undefined;
      collapsed.delete(JSON.stringify([current.tab.key, current.tab.incarnation]));
      if (focus !== component) {
        // Public core identity distinguishes Chat from foreign prompts. Stock
        // hosts retain the exact input captured when the modal claim succeeds,
        // same protection after the loan exists. Normal prompt lifecycle still
        // uses suspend() for the initial ambiguous stock boundary.
        if (!blockerInputEligible(focus, enteringModal)) return;
        if (modalPendingClaim) {
          modalOrigin = mountedInput(focus); modalClaimedInput = true; modalPendingClaim = false; deferredModalReturn = undefined; settledModalOrigin = undefined; explicitQuestionLoan = false; explicitQuestionOrigin = undefined;
          if (!coreEditor(context)) origin = modalOrigin;
        } else if (coreEditor(context) && focus !== modalOrigin) {
          // An authoritative replacement actually reclaimed as Chat is a fresh
          // modal loan, including when this blocker began as pane-owned.
          modalOrigin = mountedInput(focus); modalClaimedInput = true; deferredModalReturn = undefined; settledModalOrigin = undefined; explicitQuestionLoan = false; explicitQuestionOrigin = undefined;
        }
        tui.setFocus(component);
      }
      return;
    }
    if (current.paused || (isCollapsed() && stopInput)) { release(); return; }
    if (chat) {
      if (focus === focusEditor()) return;
      if (focus !== component) return; // A foreign prompt owns its own focus lifetime.
      chat = false; chatFrom = undefined;
    }
    // Async-only arrivals are passive even when the SDK identifies its core
    // editor. Explicit /asks or the focus-toggle key owns activation.
  }
  function schedule() {
    if (scheduled || disposed) return; scheduled = true;
    queueMicrotask(() => {
      scheduled = false; if (disposed) return;
      if (!model.tabs().length && mounted) {
        model.takeBlockingCompletion();
        explicitQuestionLoan = false; explicitQuestionOrigin = undefined;
        if (!finishModal(true) && !unwindDeferredModalReturn() && !unwindSettledModalReturn()) release();
        context.ui.setWidget(widgetKey, undefined);
      } else reconcile();
    });
  }
  function toggleCollapse() {
    const current = model.current(); if (!current || hasBlocker()) return;
    const key = displayKey()!; if (isCollapsed()) collapsed.delete(key); else collapsed.add(key);
    chat = false; chatFrom = undefined; inspect = false; offset = 0; reconcile(); tui.requestRender();
  }
  const owner = { handoff(data: string, fallback?: any, inheritedModalReturn?: any) {
    if (disposed || foreign) return false;
    // An outgoing private pane can transfer its existing loan, not invent a
    // core role for the previous input or discover an arbitrary replacement.
    if (!coreEditor(context) && !origin) origin = mountedInput(fallback);
    if (inheritedModalReturn && !modalClaimedInput && !deferredModalReturn && !settledModalOrigin && !explicitQuestionLoan) {
      if (hasBlocker()) {
        modal = true; modalOrigin = inheritedModalReturn; modalClaimedInput = true; modalPendingClaim = false;
      } else deferredModalReturn = { origin: inheritedModalReturn };
    }
    if (!hasBlocker() && deferredModalReturn) {
      tui.setFocus(component); component.handleInput(data); return { origin: settledModalOrigin };
    }
    const settled = mountedInput(settledModalOrigin);
    if (!hasBlocker() && !explicitQuestionLoan && settledModalOrigin) {
      tui.setFocus(settled || null); settled?.handleInput(data); return { origin: settledModalOrigin };
    }
    const questionRoute = !!model.current() && !foreign && !isHomeLoan();
    if (questionRoute) {
      tui.setFocus(component); component.handleInput(data);
      const after = tui.getFocusedComponent();
      if (after !== component) return { origin: mountedInput(after) || noReturn };
      return { origin: modalClaimedInput ? modalOrigin : deferredModalReturn?.origin || settledModalOrigin || (explicitQuestionLoan ? explicitQuestionOrigin : undefined) };
    }
    const home = returnInput(); tui.setFocus(home || null); home?.handleInput(data); return { origin: home || noReturn };
  } };
  const component = {
    focused: false,
    render(width: number) {
      reconcile(); if (!view || !model.current()) return [];
      const focus = tui.getFocusedComponent(), core = coreEditor(context), ordinaryEditor = returnInput(), blocking = hasBlocker();
      view.focused = !foreign && focus === component;
      view.suspended = foreign || blocking && focus !== component && !blockerInputEligible(focus);
      view.inputIsCore = !!core;
      const mayEnter = !foreign && (view.focused || (core ? !!ordinaryEditor && focus === ordinaryEditor : !!mountedInput(focus)));
      const mayToggle = !blocking && !foreign && (view.focused ? !!ordinaryEditor : core ? !!ordinaryEditor && focus === ordinaryEditor : !!mountedInput(focus));
      const mayCollapse = !blocking && !foreign && !!ordinaryEditor && (view.focused || focus === ordinaryEditor && isHomeLoan());
      view.entryAvailable = mayEnter;
      view.focusToggleKey = mayToggle ? focusToggleKey || undefined : undefined;
      view.chatReturnKey = mayCollapse ? collapseKey || undefined : undefined;
      view.chatFocused = !!core && !!ordinaryEditor && focus === ordinaryEditor;
      const current = model.current()!; if (shown !== displayKey()) { shown = displayKey(); inspect = false; offset = 0; }
      const framed = width >= 4, innerWidth = framed ? width - 2 : width;
      const frame = view.frame(innerWidth, inspect), budget = Math.max(4, Math.min(20, tui.terminal.rows - 12));
      const box = (rows: string[]) => framed ? rows.map((line, index) => {
        const top = index === 0, bottom = index === rows.length - 1, text = truncateToWidth(line, innerWidth, '');
        const role = blocking ? 'warning' : view.focused ? 'borderAccent' : 'borderMuted';
        const horizontal = blocking || view.focused ? '─' : '┈', vertical = blocking || view.focused ? '│' : '┊';
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
          const successor = owners.get(tui);
          if (successor && successor !== owner) {
            const inheritedModalReturn = deferredModalReturn?.origin || settledModalOrigin;
            const editor = inheritedModalReturn ? mountedInput(inheritedModalReturn) : returnInput();
            // Keep the successor's resolved exact route as a tombstone. If the
            // live owner later retires, repeated stale preFocus restoration
            // must neither revive older debt nor fall through to a new core.
            const receipt = successor.handoff(data, editor, inheritedModalReturn);
            if (receipt) {
              deferredModalReturn = undefined; settledModalOrigin = receipt.origin === undefined ? noReturn : receipt.origin;
              explicitQuestionLoan = false; explicitQuestionOrigin = undefined;
            }
            tui.requestRender(); return;
          }
          if (unwindDeferredModalReturn(data) || unwindSettledModalReturn(data)) { tui.requestRender(); return; }
          if (foreign) return;
          const editor = returnInput();
          if (editor) { tui.setFocus(editor); editor.handleInput(data); }
          else tui.setFocus(null);
          tui.requestRender();
        }
        return;
      }
      if (unwindDeferredModalReturn(data) || unwindSettledModalReturn(data)) { tui.requestRender(); return; }
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
    dispose() { if (!finishModal(true) && !unwindDeferredModalReturn() && !unwindSettledModalReturn()) release(!tui || owners.get(tui) === owner); mounted = false; if (tui && owners.get(tui) === owner) owners.delete(tui); },
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
    enqueue(group: QuestionGroup) {
      ensure();
      if (group.mode === 'blocking' && !hasBlocker()) modalPaneTab = displayKey();
      const handle = model.enqueue(group);
      return { outcome: handle.outcome, detach: handle.detach, answered: handle.answered, settle: handle.settle,
        require(value: boolean) {
          if (value && !hasBlocker()) modalPaneTab = displayKey();
          handle.require(value);
        } };
    },
    select(groupId: string, questionId?: string) { ensure(); const tab = model.tabs().find((tab) => tab.groupId === groupId && tab.questionId === questionId); if (tab) collapsed.delete(JSON.stringify([tab.key, tab.incarnation])); chat = false; chatFrom = undefined; model.select(groupId, questionId); reconcile(); },
    /** Explicit person action; automatic selection/projection never lends stock focus. */
    activate() { ensure(); return focusQuestion(true); },
    snapshot() { return Object.freeze({ tabs: model.tabs(), current: model.current() }); },
    suspend(value: boolean) { foreign = value; if (value) release(); else reconcile(); tui?.requestRender(); },
    dispose() { if (disposed) return; disposed = true; stopInput?.(); if (!finishModal(true) && !unwindDeferredModalReturn() && !unwindSettledModalReturn()) release(!tui || owners.get(tui) === owner); if (tui && owners.get(tui) === owner) owners.delete(tui); model.dispose(); view?.dispose(); if (mounted) context.ui.setWidget(widgetKey, undefined); mounted = false; },
  };
}
