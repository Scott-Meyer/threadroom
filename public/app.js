import { ThreadroomClient } from './client.js';
import { mountPresentation } from './presentations.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
const initials = (name = '?') => name.replace(/\([^)]*\)/g,'').trim().split(/\s+/).map((part) => part[0]).join('').slice(0,2).toUpperCase();
const time = (iso) => new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).format(new Date(iso));
const statusLabels = { outstanding:'NEEDS YOUR ANSWER', answered:'ANSWERED', waiting_on_team:'WAITING ON TEAM', deferred:'DEFERRED', rejected:'REJECTED' };
const responseLabels = { answer:'Answered', reject:'Rejected with reason', clarification:'Asked back', defer:'Deferred', team_reply:'Team replied' };
const state = { nodes:[], byId:new Map(), children:new Map(), expanded:new Set(), selected:null, zoomId:null, view:'outline', query:'', dialogParentId:null, drafts:new Map(), saving:new Map(), readGeneration:0 };
let client;
let cleanupCanvas = () => {};

function rebuildTree(nodes) {
  state.nodes = nodes;
  state.byId = new Map(nodes.map((node) => [node.id,node]));
  state.children = new Map();
  for (const node of nodes) {
    const parentId = node.parentId ?? null;
    state.children.set(parentId, [...(state.children.get(parentId) || []),node]);
  }
}
const childrenOf = (id) => state.children.get(id) || [];
function ancestorsOf(id) {
  const result = [];
  let node = state.byId.get(id);
  while (node?.parentId) { node = state.byId.get(node.parentId); if (node) result.unshift(node); }
  return result;
}
function inBranch(node, rootId) { return !rootId || node.id === rootId || ancestorsOf(node.id).some((parent) => parent.id === rootId); }

async function refreshTree() {
  const { nodes } = await client.tree();
  rebuildTree(nodes);
  renderSidebar();
  renderOutline();
}

function renderSidebar() {
  $('#needsCount').textContent = state.nodes.filter((node) => node.status === 'outstanding').length;
  $('#teamCount').textContent = state.nodes.filter((node) => node.status === 'waiting_on_team').length;
  $('#deferredCount').textContent = state.nodes.filter((node) => node.status === 'deferred').length;
}

function renderOutline() {
  const zoomed = state.view === 'outline' ? state.byId.get(state.zoomId) : null;
  const labels = { outline:['OUTLINE',zoomed?.title || 'Everything'], outstanding:['INBOX','Needs your answer'], waiting_on_team:['OUTBOUND','Waiting on team'], deferred:['LATER','Deferred'] };
  $('#viewEyebrow').textContent = labels[state.view][0];
  $('#viewTitle').textContent = labels[state.view][1];
  const crumbs = zoomed ? [...ancestorsOf(zoomed.id),zoomed] : [];
  $('#outlineCrumbs').innerHTML = `<button data-zoom="">Home</button>${crumbs.map((node) => `<span>›</span><button data-zoom="${esc(node.id)}">${esc(node.title)}</button>`).join('')}`;
  $$('[data-zoom]', $('#outlineCrumbs')).forEach((button) => button.addEventListener('click', () => zoom(button.dataset.zoom || null)));
  const query = state.query.toLowerCase();
  let html;
  if (state.view !== 'outline' || query) {
    const nodes = state.nodes.filter((node) => (state.view !== 'outline' || inBranch(node,state.zoomId)) && (state.view === 'outline' || node.status === state.view) && (!query || [node.title,node.author.name].join(' ').toLowerCase().includes(query)));
    html = nodes.map((node) => `<div class="outline-context">${esc(ancestorsOf(node.id).map((parent) => parent.title).join(' › '))}</div>${outlineRow(node,0,false)}`).join('');
  } else {
    const roots = childrenOf(state.zoomId);
    const stack = [...roots].reverse().map((node) => ({node,depth:0}));
    const rows = [];
    while (stack.length) {
      const {node,depth} = stack.pop();
      rows.push(outlineRow(node,depth,true));
      if (state.expanded.has(node.id)) for (const child of [...childrenOf(node.id)].reverse()) stack.push({node:child,depth:depth+1});
    }
    html = rows.join('');
  }
  $('#threadList').innerHTML = html || '<div class="empty-list">No items in this view.<br>You can add a thread at any depth.</div>';
  $$('.outline-row').forEach((row) => row.style.setProperty('--depth',row.dataset.depth));
  $$('[data-select]').forEach((button) => button.addEventListener('click', () => openNode(button.dataset.select)));
  $$('[data-expand]').forEach((button) => button.addEventListener('click', () => { const id = button.dataset.expand; state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); renderOutline(); }));
  $$('[data-bullet]').forEach((button) => button.addEventListener('click', () => zoom(button.dataset.bullet)));
  $$('[data-add-child]').forEach((button) => button.addEventListener('click', () => showPublish(button.dataset.addChild)));
}

function outlineRow(node,depth,tree) {
  const kids = childrenOf(node.id);
  const isExpanded = state.expanded.has(node.id);
  return `<div class="outline-row ${node.id === state.selected?.node.id ? 'selected' : ''}" data-depth="${Math.min(depth,30)}">
    <button class="outline-toggle ${kids.length ? '' : 'no-children'}" data-expand="${esc(node.id)}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} ${esc(node.title)}">${tree && isExpanded ? '⌄' : '›'}</button>
    <button class="outline-bullet" data-bullet="${esc(node.id)}" title="Zoom into this thread" aria-label="Zoom into ${esc(node.title)}">•</button>
    <button class="outline-title" data-select="${esc(node.id)}"><span>${esc(node.title)}</span>${node.status ? `<small class="outline-state ${esc(node.status)}">${esc(statusLabels[node.status] || node.status)}</small>` : ''}</button>
    <button class="outline-add" data-add-child="${esc(node.id)}" title="Add a child thread" aria-label="Branch from ${esc(node.title)}">＋</button>
  </div>`;
}

function zoom(id) {
  state.zoomId = id;
  state.view = 'outline';
  $$('.nav-item').forEach((button) => button.classList.toggle('active',button.dataset.view === 'outline'));
  renderSidebar(); renderOutline();
  if (id) openNode(id);
}

async function openNode(id,{navigate=true}={}) {
  const generation = ++state.readGeneration;
  try {
    const result = await client.read(id);
    if (generation !== state.readGeneration) return;
    state.selected = result;
    for (const ancestor of result.ancestors) state.expanded.add(ancestor.id);
    if (navigate && location.pathname !== `/threads/${id}`) history.pushState({id},'',`/threads/${id}`);
    renderOutline(); renderRoom(result);
  } catch (error) { toast(error.message,true); }
}

function renderRoom(result) {
  cleanupCanvas();
  const {node,ancestors,children,counts} = result;
  const draft = draftFor(node.id);
  $('#threadRoom').scrollTop = 0;
  $('#threadRoom').innerHTML = `
    <header class="room-header"><div class="room-title-row"><span class="room-author">${esc(initials(node.author.name))}</span><div><div class="room-breadcrumbs"><button data-room-zoom="">Home</button>${ancestors.map((parent) => `<span>›</span><button data-room-zoom="${esc(parent.id)}">${esc(parent.title)}</button>`).join('')}</div><h1>${esc(node.title)}</h1><div class="room-meta">${esc(node.author.name)}${node.author.role ? ` · ${esc(node.author.role)}` : ''} · ${time(node.createdAt)}</div></div></div><div class="room-actions"><button class="room-action" id="copyLinkButton">Copy link</button><button class="room-action primary" id="branchButton">＋ Branch here</button></div></header>
    <div class="room-content node-content">
      <div class="node-heading"><span class="node-context">${esc(nodeContext(node))}</span><span id="selectedStatus">${statusChip(node.status)}</span></div>
      ${node.body ? `<p class="node-body">${esc(node.body)}</p>` : ''}
      ${node.response ? renderSavedValues(node.response.selections) : ''}
      <div class="node-canvas" id="nodeCanvas"></div>
      <div class="conversation-label">INSIDE THIS THREAD <span id="childCount">${children.length}</span></div>
      <div id="childThreads">${renderChildren(children)}</div>
      <div class="trusted-response" id="trustedResponse">
        <div class="trusted-heading"><span>▣ THREADROOM RESPONSE</span><small>Always available · outside the authored canvas</small></div>
        <div class="composer">
          <div class="composer-modes">${[['answer','Answer with text'],['clarification','Ask back'],['defer','Defer'],['reject','Reject with reason']].map(([kind,label]) => `<button class="mode-button ${draft.kind === kind ? 'active' : ''}" data-mode="${kind}">${label}</button>`).join('')}</div>
          <div class="proposal-summary" id="proposalSummary">${proposalSummary(draft.proposal)}</div>
          <textarea id="responseBody" aria-label="Written response" placeholder="Answer in your own words. You never have to use the author’s proposed controls.">${esc(draft.body)}</textarea>
          <details class="authoring-details response-authoring"><summary>Include an authored answer canvas</summary><label>Self-contained HTML/CSS/JS<textarea id="responseHtml" aria-label="Answer canvas HTML" rows="4">${esc(draft.html)}</textarea></label><label>Readable fallback<textarea id="responseFallback" aria-label="Answer canvas readable fallback" rows="2">${esc(draft.fallback)}</textarea></label></details>
          <div class="composer-footer"><span class="draft-state" id="draftState">${draft.body || draft.proposal ? 'Unsaved draft kept in this browser' : 'Your text answer / rejection cannot be overridden'}</span><button class="submit-response" id="saveResponseButton" ${state.saving.has(node.id) ? 'disabled' : ''}>${state.saving.has(node.id) ? 'Saving…' : 'Save response →'}</button></div>
        </div>
      </div>
      <p class="node-footnote">${counts.outstanding} awaiting human input · ${counts.waitingOnTeam} waiting on team · ${counts.deferred} deferred in this branch. You can branch from any thread.</p>
    </div>`;
  $$('[data-room-zoom]').forEach((button) => button.addEventListener('click',() => zoom(button.dataset.roomZoom || null)));
  $('#copyLinkButton').addEventListener('click',async () => { try { await navigator.clipboard.writeText(location.href); toast('Thread link copied'); } catch { toast('Copy the address from the browser'); } });
  $('#branchButton').addEventListener('click',() => showPublish(node.id));
  bindChildren();
  cleanupCanvas = mountPresentation($('#nodeCanvas'), { node, apiBaseUrl:client.baseUrl, onProposal:(proposal) => {
    const current = draftFor(node.id);
    current.proposal = proposal;
    keepDraft(node.id,current);
    if (state.selected?.node.id === node.id) { $('#proposalSummary').innerHTML = proposalSummary(proposal); $('#draftState').textContent = 'Canvas values proposed—not saved until you submit here'; }
  }});
  $$('.mode-button').forEach((button) => button.addEventListener('click',() => {
    draft.kind = button.dataset.mode;
    $$('.mode-button').forEach((other) => other.classList.toggle('active',other === button));
    $('#responseBody').placeholder = draft.kind === 'reject' ? 'Explain why you reject the premise or direction…' : draft.kind === 'clarification' ? 'What do you need the team to clarify?' : draft.kind === 'defer' ? 'Optional: when or what should bring this back?' : 'Answer in your own words…';
    keepDraft(node.id,draft);
  }));
  const updateDraft = () => {
    draft.body = $('#responseBody').value; draft.html = $('#responseHtml').value; draft.fallback = $('#responseFallback').value;
    keepDraft(node.id,draft); $('#draftState').textContent = 'Unsaved draft kept in this browser';
  };
  ['#responseBody','#responseHtml','#responseFallback'].forEach((selector) => $(selector).addEventListener('input',updateDraft));
  $('#saveResponseButton').addEventListener('click',() => saveResponse(node.id));
}

function renderChildren(children) {
  if (!children.length) return '<p class="children-empty">Nothing nested here yet. Reply below or branch here.</p>';
  return children.map((child) => `<article class="child-thread">
    <div class="child-top"><span class="author-avatar">${esc(initials(child.author.name))}</span><span class="thread-author">${esc(child.author.name)}</span>${nodeContext(child) ? `<span class="node-context">${esc(nodeContext(child))}</span>` : ''}<span class="response-time">${time(child.createdAt)}</span>${statusChip(child.status)}</div>
    <button class="child-title" data-open-child="${esc(child.id)}">${esc(child.title)} <span>↗</span></button>
    ${child.body ? `<p class="child-body">${esc(child.body)}</p>` : ''}
    ${child.response ? renderSavedValues(child.response.selections) : ''}
    ${child.presentation ? `<span class="child-artifact">${child.presentation.kind === 'html-v1' ? 'Authored interactive canvas + readable record' : 'Review presentation'} · ${esc(child.presentation.revision)}</span>` : ''}
    <div class="child-actions"><button data-open-child="${esc(child.id)}">Open / zoom</button><button data-branch-child="${esc(child.id)}">＋ Branch here</button></div>
  </article>`).join('');
}
function bindChildren() {
  $$('[data-open-child]').forEach((button) => button.addEventListener('click',() => zoom(button.dataset.openChild)));
  $$('[data-branch-child]').forEach((button) => button.addEventListener('click',() => showPublish(button.dataset.branchChild)));
}
function nodeContext(node) {
  return [node.expectsAnswer ? 'Answer requested' : '', node.response ? responseLabels[node.response.kind] || 'Saved response' : ''].filter(Boolean).join(' · ');
}
const statusChip = (status) => status ? `<span class="status-chip ${esc(status)}">${statusLabels[status] || esc(status)}</span>` : '';
function renderSavedValues(selections=[]) {
  return selections.map((selection) => {
    const image = selection.value?.image;
    const hasImage = typeof image === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(image);
    const readable = hasImage ? {...selection.value,image:'[Captured generated image shown above]'} : selection.value;
    return `<div class="saved-values"><strong>${esc(selection.label || selection.id || 'Interaction values')}</strong>${hasImage ? `<img class="saved-generation" src="${esc(image)}" alt="Captured generated study from the submitted response">` : ''}${readable != null ? `<pre>${esc(JSON.stringify(readable,null,2).slice(0,3000))}</pre>` : ''}</div>`;
  }).join('');
}
function proposalSummary(proposal) {
  return proposal ? `<strong>Unsaved canvas proposal</strong><span>${esc(proposal.summary || JSON.stringify(proposal.values).slice(0,300))}</span><small>Only the Threadroom Save button records this.</small>` : '';
}
function draftFor(id) {
  if (state.drafts.has(id)) return state.drafts.get(id);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(`threadroom:node-draft:${id}`) || '{}'); } catch {}
  const draft = { kind:'answer', body:'', html:'', fallback:'', proposal:null, ...saved };
  state.drafts.set(id,draft); return draft;
}
function keepDraft(id,draft) {
  state.drafts.set(id,draft);
  try { localStorage.setItem(`threadroom:node-draft:${id}`,JSON.stringify(draft)); } catch { toast('Draft remains on this page; browser storage is full',true); }
}

function responsePayload(draft) {
  return {
    kind:draft.kind, body:draft.body, author:{name:'Scott'},
    selections:draft.proposal && draft.kind !== 'reject' ? [{id:'authored-values',label:draft.proposal.summary || 'Canvas interaction',value:draft.proposal.values}] : [],
    ...(draft.html ? {presentation:{kind:'html-v1',html:draft.html,fallback:draft.fallback}} : {})
  };
}
async function saveResponse(id) {
  if (state.saving.has(id)) return;
  const originGeneration = state.readGeneration;
  const draft = draftFor(id);
  const payload = responsePayload(draft);
  const serialized = JSON.stringify(payload);
  if (draft.attempt?.payload !== serialized) draft.attempt = {key:crypto.randomUUID(),payload:serialized};
  const attempt = draft.attempt;
  state.saving.set(id,attempt);
  keepDraft(id,draft);
  const button = $('#saveResponseButton'); button.disabled = true; button.textContent = 'Saving…';
  try {
    await client.respond(id,payload,attempt.key);
  } catch (error) {
    state.saving.delete(id);
    if (state.selected?.node.id === id) { const currentButton = $('#saveResponseButton'); currentButton.disabled = false; currentButton.textContent = 'Retry save →'; }
    toast(`${error.message}. Your draft is still here.`,true);
    return;
  }
  state.saving.delete(id);
  const currentDraft = draftFor(id);
  const hasNewerDraft = JSON.stringify(responsePayload(currentDraft)) !== serialized;
  if (hasNewerDraft) { currentDraft.attempt = null; keepDraft(id,currentDraft); }
  else { state.drafts.delete(id); localStorage.removeItem(`threadroom:node-draft:${id}`); }
  // A committed save never owns navigation or edits made after the submitted snapshot.
  if (state.selected?.node.id === id) {
    const currentButton = $('#saveResponseButton'); currentButton.disabled = false;
    currentButton.textContent = hasNewerDraft ? 'Save newer draft →' : 'Save response →';
    $('#draftState').textContent = hasNewerDraft ? 'Submitted snapshot saved; newer draft is still unsaved' : 'Response saved to history';
    if (!hasNewerDraft && state.readGeneration === originGeneration) await openNode(id,{navigate:false});
  }
  try { await refreshTree(); toast(hasNewerDraft ? 'Submitted response saved. Your newer draft was kept.' : 'Saved. Your response is in this branch.'); }
  catch { toast('Response saved. Outline will catch up when reconnected.'); }
}

function showPublish(parentId) {
  state.dialogParentId = parentId || null;
  const parent = state.byId.get(parentId);
  $('#publishContext').textContent = parent ? `Inside: ${[...ancestorsOf(parentId),parent].map((node) => node.title).join(' › ')}` : 'In Everything';
  $('#newThreadDialog').showModal();
}
$('#newThreadForm').addEventListener('submit',async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') return $('#newThreadDialog').close();
  const form = event.currentTarget; const data = new FormData(form);
  const payload = { parentId:state.dialogParentId, title:data.get('title'), body:data.get('body'), expectsAnswer:data.has('expectsAnswer'), author:{name:'Scott'},
    ...(data.get('html') ? {presentation:{kind:'html-v1',html:data.get('html'),fallback:data.get('fallback')}} : {}) };
  const serialized = JSON.stringify(payload);
  if (state.publishAttempt?.payload !== serialized) state.publishAttempt = {key:crypto.randomUUID(),payload:serialized};
  let result;
  try { result = await client.publish(payload,state.publishAttempt.key); }
  catch (error) { toast(`${error.message}. The form is retained for retry.`,true); return; }
  state.publishAttempt = null;
  $('#newThreadDialog').close(); form.reset();
  const updated = new Map(state.nodes.map((node) => [node.id,node]));
  for (const node of [...result.ancestors,result.node,...result.children]) updated.set(node.id,{...updated.get(node.id),...node});
  rebuildTree([...updated.values()]);
  for (const ancestor of result.ancestors) state.expanded.add(ancestor.id);
  if (!result.node.parentId) state.zoomId = null;
  ++state.readGeneration;
  state.selected = result;
  history.pushState({id:result.node.id},'',`/threads/${result.node.id}`);
  renderSidebar(); renderOutline(); renderRoom(result);
  toast('Node added here');
});
$('#newThreadButton').addEventListener('click',() => showPublish(state.zoomId));
$('#addInBranch').addEventListener('click',() => showPublish(state.zoomId));
$('#outlineUp').addEventListener('click',() => zoom(state.byId.get(state.zoomId)?.parentId || null));
$('#searchInput').addEventListener('input',(event) => { state.query = event.target.value; renderOutline(); });
$('#refreshButton').addEventListener('click',async () => { try { await refreshTree(); if (state.selected) await openNode(state.selected.node.id,{navigate:false}); toast('Caught up with saved history'); } catch (error) { toast(error.message,true); } });
// Sidebar views are global; an outline zoom must not hide incoming questions in another branch.
$$('.nav-item').forEach((button) => button.addEventListener('click',() => { state.view = button.dataset.view; state.zoomId = null; $$('.nav-item').forEach((other) => other.classList.toggle('active',other === button)); renderOutline(); }));
window.addEventListener('popstate',() => { const id = location.pathname.match(/^\/threads\/([^/]+)$/)?.[1]; if (id) openNode(id,{navigate:false}); });
function toast(message,error=false) {
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error',error); element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'),3500);
}
let eventTimer;
async function catchUp() {
  try {
    await refreshTree();
    const id = state.selected?.node.id;
    if (id) {
      const result = await client.read(id);
      if (state.selected?.node.id !== id) return;
      state.selected = result;
      $('#selectedStatus').innerHTML = statusChip(result.node.status);
      $('#childCount').textContent = result.children.length;
      $('#childThreads').innerHTML = renderChildren(result.children);
      bindChildren();
    }
  } catch { /* EventSource owns reconnection; a manual refresh stays available. */ }
}
async function start() {
  const config = await fetch('/threadroom-config.json').then((response) => response.json());
  client = new ThreadroomClient(config.apiBaseUrl);
  await refreshTree();
  const pathId = location.pathname.match(/^\/threads\/([^/]+)$/)?.[1];
  const id = pathId && state.byId.has(pathId) ? pathId : state.nodes.find((node) => node.id === 'q_silhouette')?.id || childrenOf(null)[0]?.id;
  for (const root of childrenOf(null)) state.expanded.add(root.id);
  if (id) await openNode(id);
  client.subscribe(() => { clearTimeout(eventTimer); eventTimer = setTimeout(catchUp,60); }, {onState:(connection) => {
    $('#connectionLabel').textContent = connection === 'live' ? 'Live updates · conversations outlast sessions' : 'Reconnecting · saved history stays in the backend';
    $('#connectionDot').classList.toggle('disconnected',connection !== 'live');
  }});
}
start().catch((error) => { $('#threadRoom').innerHTML = `<div class="thread-loading">Could not connect to Threadroom.<br>${esc(error.message)}</div>`; toast(error.message,true); });
