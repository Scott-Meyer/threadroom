const state = {
  threads: [],
  currentThread: null,
  currentView: 'needs-answer',
  currentProject: null,
  query: '',
  selections: new Map(),
  modes: new Map(),
  pendingResponses: new Map()
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[character]);
const initials = (name) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const relativeTime = (iso) => {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};
const dateTime = (iso) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

async function loadThreads({ preserveCurrent = true } = {}) {
  const { threads } = await api('/api/threads?view=history');
  state.threads = threads;
  renderCounts();
  renderThreadList();
  const pathId = location.pathname.match(/^\/threads\/([^/]+)$/)?.[1];
  const desired = preserveCurrent ? (state.currentThread?.id || pathId) : pathId;
  const visible = filteredThreads();
  const id = desired && threads.some((thread) => thread.id === desired) ? desired : visible[0]?.id || threads[0]?.id;
  if (id) await openThread(id, { navigate: pathId !== id });
  else $('#threadRoom').innerHTML = '<div class="thread-loading">No conversations in this view yet.</div>';
}

function filteredThreads() {
  let threads = state.threads;
  if (state.currentProject) threads = threads.filter((thread) => thread.project === state.currentProject);
  if (state.currentView === 'needs-answer') threads = threads.filter((thread) => thread.counts.outstanding > 0);
  if (state.currentView === 'waiting-on-team') threads = threads.filter((thread) => thread.counts.waitingOnTeam > 0);
  if (state.currentView === 'deferred') threads = threads.filter((thread) => thread.counts.deferred > 0);
  if (state.query) {
    const query = state.query.toLowerCase();
    threads = threads.filter((thread) => [thread.title, thread.summary, thread.project, thread.author.name, thread.latestPrompt].join(' ').toLowerCase().includes(query));
  }
  return threads;
}

function renderCounts() {
  const sum = (key) => state.threads.reduce((total, thread) => total + thread.counts[key], 0);
  $('#needsCount').textContent = sum('outstanding');
  $('#teamCount').textContent = sum('waitingOnTeam');
  $('#deferredCount').textContent = sum('deferred');
  const projects = [...new Set(state.threads.map((thread) => thread.project))].sort();
  $('#projectList').innerHTML = [null, ...projects].map((project) => {
    const count = project ? state.threads.filter((thread) => thread.project === project).length : state.threads.length;
    return `<button class="project-item ${state.currentProject === project ? 'active' : ''}" data-project="${esc(project || '')}"><span class="project-glyph ${project ? 'mistfall' : ''}">${esc(project ? initials(project) : '∗')}</span><span><strong>${esc(project || 'All projects')}</strong><small>${count} thread${count === 1 ? '' : 's'}</small></span></button>`;
  }).join('');
  $$('.project-item').forEach((button) => button.addEventListener('click', () => {
    state.currentProject = button.dataset.project || null;
    renderCounts();
    renderThreadList();
    const first = filteredThreads()[0];
    if (first) openThread(first.id);
  }));
}

function renderThreadList() {
  const threads = filteredThreads();
  $('#threadList').innerHTML = threads.length ? threads.map((thread) => {
    const status = thread.counts.outstanding
      ? `<span class="tag attention">${thread.counts.outstanding} TO ANSWER</span>`
      : thread.counts.waitingOnTeam
        ? '<span class="tag team">TEAM OWES REPLY</span>'
        : thread.counts.deferred
          ? '<span class="tag deferred">DEFERRED</span>'
          : '<span class="tag">IN HISTORY</span>';
    return `<button class="thread-card ${thread.id === state.currentThread?.id ? 'active' : ''}" data-thread-id="${esc(thread.id)}">
      <span class="thread-card-top">
        <span class="author-avatar ${thread.author.name.toLowerCase().includes('ivo') ? 'ivo' : ''}">${esc(initials(thread.author.name))}</span>
        <span><span class="thread-author">${esc(thread.author.name)}</span> <span class="thread-role">· ${esc(thread.author.role || thread.project)}</span></span>
        <time class="thread-time">${relativeTime(thread.updatedAt)}</time>
      </span>
      <h2>${esc(thread.title)}</h2>
      <p>${esc(thread.latestPrompt || thread.summary)}</p>
      <span class="thread-card-footer">${status}<span class="tag">${thread.counts.questions} Q</span><span class="arrow">›</span></span>
    </button>`;
  }).join('') : '<div class="empty-list">Nothing here right now.<br>Try All history or publish a new review.</div>';
  $$('.thread-card').forEach((button) => button.addEventListener('click', () => openThread(button.dataset.threadId)));
}

async function openThread(id, { navigate = true } = {}) {
  const { thread } = await api(`/api/threads/${encodeURIComponent(id)}`);
  state.currentThread = thread;
  renderThreadList();
  renderThread(thread);
  if (navigate && location.pathname !== `/threads/${id}`) history.pushState({ threadId: id }, '', `/threads/${id}`);
}

function renderThread(thread) {
  $('#threadRoom').innerHTML = `
    <header class="room-header">
      <div class="room-title-row"><span class="room-author">${esc(initials(thread.author.name))}</span><div><h1>${esc(thread.title)}</h1><div class="room-meta">${esc(thread.project)} · ${esc(thread.author.name)} · opened ${dateTime(thread.createdAt)}</div></div></div>
      <div class="room-actions"><button class="room-action" id="copyLinkButton">Copy link</button><button class="room-action primary" id="addFollowupButton">＋ Follow-up</button></div>
    </header>
    <div class="room-content">
      <p class="thread-summary">${esc(thread.summary)}</p>
      <div class="conversation-label">CONVERSATION · ${thread.questions.length} QUESTION${thread.questions.length === 1 ? '' : 'S'}</div>
      ${thread.questions.map((question, index) => renderQuestion(question, index)).join('')}
    </div>`;
  $('#copyLinkButton').addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.href);
    toast('Thread link copied');
  });
  $('#addFollowupButton').addEventListener('click', () => $('#followupDialog').showModal());
  bindQuestionInteractions();
}

function renderQuestion(question, index) {
  const statusLabels = {
    outstanding: 'NEEDS YOUR ANSWER', answered: 'ANSWERED', waiting_on_team: 'WAITING ON TEAM', deferred: 'DEFERRED', rejected: 'REJECTED'
  };
  const responses = question.responses.map(renderResponse).join('');
  const canRespond = ['outstanding', 'deferred'].includes(question.status);
  return `<article class="question-block" data-question-id="${esc(question.id)}">
    <div class="question-heading">
      <span class="question-number">${String(index + 1).padStart(2, '0')}</span>
      <div><h2>${esc(question.prompt)}</h2><p class="question-context">${esc(question.context)}</p></div>
      <span class="status-chip ${esc(question.status)}">${statusLabels[question.status] || esc(question.status)}</span>
    </div>
    ${renderPresentation(question)}
    ${responses}
    ${canRespond ? renderComposer(question) : ''}
  </article>`;
}

function renderPresentation(question) {
  const presentation = question.presentation;
  if (presentation.kind === 'comparison-v1' && Array.isArray(presentation.options)) {
    return `<div class="presentation">
      <p class="presentation-eyebrow">${esc(presentation.eyebrow || `PRESENTATION · ${presentation.revision}`)}</p>
      <div class="comparison-grid">${presentation.options.map((option) => `<button class="option-card ${state.selections.get(question.id)?.id === option.id ? 'selected' : ''}" data-option-id="${esc(option.id)}" data-option-label="${esc(option.label)}">
        <img class="option-image" src="${esc(option.image)}" alt="${esc(option.alt || option.label)}">
        <span class="option-copy"><strong>${esc(option.label)}</strong><small>${esc(option.detail)}</small></span>
      </button>`).join('')}</div>
    </div>`;
  }
  if (presentation.kind === 'text-v1') {
    if (!presentation.choices?.length) return '';
    return `<div class="presentation"><p class="presentation-eyebrow">SUGGESTED DIRECTIONS · ${esc(presentation.revision)}</p><div class="choice-list">
      ${presentation.choices.map((label, index) => `<button class="choice-pill ${state.selections.get(question.id)?.label === label ? 'selected' : ''}" data-option-id="choice-${index}" data-option-label="${esc(label)}">${esc(label)}</button>`).join('')}
    </div></div>`;
  }
  return `<div class="presentation"><div class="fallback-presentation">This presentation type is not available here. The question and dependable response path still work.\n\nRevision: ${esc(presentation.revision)}</div></div>`;
}

function renderResponse(response) {
  const kinds = { answer: 'Answered', clarification: 'Asked back', defer: 'Deferred', reject: 'Rejected with reason', team_reply: 'Team replied' };
  return `<div class="response-history">
    <div class="response-top"><span class="author-avatar">${esc(initials(response.author.name))}</span><strong class="thread-author">${esc(response.author.name)}</strong><span class="response-kind">${kinds[response.kind] || esc(response.kind)}</span><time class="response-time">${dateTime(response.createdAt)}</time></div>
    ${response.selections.length ? `<div class="selection-summary">${response.selections.map((selection) => `<span>${esc(selection.label || selection.id)}</span>`).join('')}</div>` : ''}
    ${response.body ? `<p class="response-body">${esc(response.body)}</p>` : ''}
  </div>`;
}

function renderComposer(question) {
  const draft = localStorage.getItem(`threadroom:draft:${question.id}`) || '';
  const mode = state.modes.get(question.id) || 'answer';
  const placeholders = {
    answer: 'Add context in your own words — the offered choices never limit the answer…',
    clarification: 'What do you need the team to clarify or explore next?',
    defer: 'Optional: note when or what would make this worth revisiting…',
    reject: 'Explain what is wrong with the premise or direction…'
  };
  return `<div class="composer">
    <div class="composer-modes">
      ${[['answer','Answer'],['clarification','Ask back'],['defer','Defer'],['reject','Reject']].map(([value,label]) => `<button class="mode-button ${mode === value ? 'active' : ''}" data-mode="${value}">${label}</button>`).join('')}
    </div>
    <textarea placeholder="${placeholders[mode]}" aria-label="Written response">${esc(draft)}</textarea>
    <div class="composer-footer"><span class="draft-state ${draft ? 'unsaved' : ''}">${draft ? 'Draft kept in this browser' : 'Freeform is always available'}</span><button class="submit-response">Save response →</button></div>
  </div>`;
}

function bindQuestionInteractions() {
  $$('.question-block').forEach((block) => {
    const questionId = block.dataset.questionId;
    $$('.option-card, .choice-pill', block).forEach((button) => button.addEventListener('click', () => {
      state.selections.set(questionId, { id: button.dataset.optionId, label: button.dataset.optionLabel });
      $$('.option-card, .choice-pill', block).forEach((other) => other.classList.toggle('selected', other === button));
      const draftState = $('.draft-state', block);
      if (draftState) { draftState.textContent = 'Selection not saved yet'; draftState.classList.add('unsaved'); }
    }));
    $$('.mode-button', block).forEach((button) => button.addEventListener('click', () => {
      state.modes.set(questionId, button.dataset.mode);
      $$('.mode-button', block).forEach((other) => other.classList.toggle('active', other === button));
      const textarea = $('textarea', block);
      textarea.placeholder = {
        answer: 'Add context in your own words — the offered choices never limit the answer…',
        clarification: 'What do you need the team to clarify or explore next?',
        defer: 'Optional: note when or what would make this worth revisiting…',
        reject: 'Explain what is wrong with the premise or direction…'
      }[button.dataset.mode];
    }));
    const textarea = $('textarea', block);
    if (textarea) textarea.addEventListener('input', () => {
      localStorage.setItem(`threadroom:draft:${questionId}`, textarea.value);
      const draftState = $('.draft-state', block);
      draftState.textContent = textarea.value ? 'Draft kept in this browser' : 'Freeform is always available';
      draftState.classList.toggle('unsaved', Boolean(textarea.value));
    });
    const submit = $('.submit-response', block);
    if (submit) submit.addEventListener('click', () => submitResponse(questionId, block));
  });
}

async function submitResponse(questionId, block) {
  const originThreadId = state.currentThread.id;
  const button = $('.submit-response', block);
  const body = $('textarea', block).value;
  const selection = state.selections.get(questionId);
  const kind = state.modes.get(questionId) || 'answer';
  const payload = JSON.stringify({ kind, body, selections: selection ? [selection] : [], author: { name: 'Scott' } });
  const pending = state.pendingResponses.get(questionId);
  const attempt = pending?.payload === payload ? pending : { key: crypto.randomUUID(), payload };
  state.pendingResponses.set(questionId, attempt);
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const result = await api(`/api/questions/${encodeURIComponent(questionId)}/responses`, {
      method: 'POST', headers: { 'Idempotency-Key': attempt.key }, body: payload
    });
    state.pendingResponses.delete(questionId);
    localStorage.removeItem(`threadroom:draft:${questionId}`);
    state.selections.delete(questionId);
    state.modes.delete(questionId);
    if (state.currentThread?.id === originThreadId) {
      state.currentThread = result.thread;
      renderThread(result.thread);
    }
    const successMessage = kind === 'clarification' ? 'Saved — the team now owes a reply' : kind === 'defer' ? 'Deferred without losing the thread' : 'Response saved to history';
    try {
      const { threads } = await api('/api/threads?view=history');
      state.threads = threads;
      renderCounts();
      renderThreadList();
      toast(successMessage);
    } catch {
      toast(`${successMessage}. Inbox counts will catch up on refresh.`);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Retry save →';
    toast(`${error.message}. Your draft is still here.`, true);
  }
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
  state.currentView = button.dataset.view;
  const labels = {
    'needs-answer': ['INBOX', 'Needs your answer'], 'waiting-on-team': ['OUTBOUND', 'Waiting on team'],
    deferred: ['LATER', 'Deferred'], history: ['ARCHIVE', 'All history']
  }[state.currentView];
  $('#viewEyebrow').textContent = labels[0];
  $('#viewTitle').textContent = labels[1];
  renderThreadList();
  const first = filteredThreads()[0];
  if (first) openThread(first.id);
}));

$('#searchInput').addEventListener('input', (event) => { state.query = event.target.value.trim(); renderThreadList(); });
$('#refreshButton').addEventListener('click', async () => { await loadThreads(); toast('Caught up with the durable record'); });
$('#newThreadButton').addEventListener('click', () => $('#newThreadDialog').showModal());
$('#newThreadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#newThreadDialog').close();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const { thread } = await api('/api/threads', { method: 'POST', body: JSON.stringify({
      title: form.get('title'), project: form.get('project'), summary: form.get('context'),
      author: { name: 'AI teammate', role: 'Project collaborator' },
      question: { prompt: form.get('prompt'), context: form.get('context'), presentation: { kind: 'text-v1', revision: `published-${Date.now()}` } }
    }) });
    $('#newThreadDialog').close();
    formElement.reset();
    state.currentView = 'history';
    state.currentProject = null;
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'history'));
    $('#viewEyebrow').textContent = 'ARCHIVE'; $('#viewTitle').textContent = 'All history';
    state.currentThread = thread;
    await loadThreads();
    toast('Review published through the API');
  } catch (error) { toast(error.message, true); }
});

$('#followupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#followupDialog').close();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const { thread } = await api(`/api/threads/${encodeURIComponent(state.currentThread.id)}/questions`, {
      method: 'POST', body: JSON.stringify({ prompt: form.get('prompt'), context: form.get('context'), presentation: { kind: 'text-v1', revision: `followup-${Date.now()}` } })
    });
    $('#followupDialog').close(); formElement.reset(); state.currentThread = thread;
    await loadThreads(); toast('Follow-up added without rewriting the history');
  } catch (error) { toast(error.message, true); }
});

window.addEventListener('popstate', () => {
  const id = location.pathname.match(/^\/threads\/([^/]+)$/)?.[1];
  if (id) openThread(id, { navigate: false });
});

loadThreads({ preserveCurrent: false }).catch((error) => {
  $('#threadRoom').innerHTML = `<div class="thread-loading">Threadroom could not connect.<br>${esc(error.message)}</div>`;
  toast(error.message, true);
});
