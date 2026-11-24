'use strict';

/* ============================================================
   Cairn workspace — vanilla ES2022, no build step.
   Reads and writes through the local UI API over HTTP.
   ============================================================ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* Overlays are siblings of #app, so making the app inert leaves the dialog
   reachable while removing every background control from the tab order. */
let overlayPreviousFocus = null;

function activeOverlay() {
  return $$('.overlay').find((overlay) => !overlay.hidden) || null;
}

function syncOverlayInert() {
  const open = Boolean(activeOverlay());
  const app = $('#app');
  if (app) app.inert = open;
  const skip = $('.skip-link');
  if (skip) skip.inert = open;
}

function restoreOverlayFocus() {
  const previous = overlayPreviousFocus;
  overlayPreviousFocus = null;
  if (previous && document.contains(previous) && typeof previous.focus === 'function') {
    previous.focus();
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const dialog = activeOverlay()?.querySelector('[role="dialog"]');
  if (!dialog) return;
  const focusable = $$('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', dialog)
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

const KIND_META = {
  decision: { label: 'Decision', icon: 'i-decision' },
  change: { label: 'Change', icon: 'i-change' },
  insight: { label: 'Insight', icon: 'i-insight' },
  question: { label: 'Question', icon: 'i-question' },
  answer: { label: 'Answer', icon: 'i-message' },
  handoff: { label: 'Handoff', icon: 'i-handoff' },
  message: { label: 'Message', icon: 'i-message' },
  session: { label: 'Session', icon: 'i-session' },
  spec: { label: 'Spec', icon: 'i-spec' },
  risk: { label: 'Risk', icon: 'i-risk' },
  task: { label: 'Task', icon: 'i-task' },
  note: { label: 'Note', icon: 'i-note' },
  project: { label: 'Project', icon: 'i-project' },
  agent: { label: 'Agent', icon: 'i-agents' },
  file: { label: 'File', icon: 'i-file' },
  tag: { label: 'Tag', icon: 'i-link' },
  missing: { label: 'Missing note', icon: 'i-question' },
};

const STATUS_OPTIONS = {
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  change: ['active', 'in_progress', 'committed', 'captured', 'archived'],
  insight: ['active', 'archived'],
  question: ['open', 'answered', 'archived'],
  answer: ['answered', 'archived'],
  handoff: ['unread', 'read', 'done'],
  message: ['unread', 'read'],
  session: ['active', 'done', 'abandoned'],
  spec: ['draft', 'active', 'archived'],
  risk: ['open', 'mitigated', 'accepted'],
  task: ['todo', 'doing', 'done', 'blocked'],
  note: ['active', 'archived'],
  project: ['active', 'paused', 'archived'],
  agent: ['active', 'archived'],
};

const STATUS_LABELS = {
  in_progress: 'In progress', captured: 'Captured', archived: 'Archived',
  proposed: 'Proposed', accepted: 'Accepted', rejected: 'Rejected', superseded: 'Superseded',
  open: 'Open', answered: 'Answered', unread: 'Unread', read: 'Read', done: 'Done',
  active: 'Active', draft: 'Draft', mitigated: 'Mitigated', todo: 'To do', doing: 'Doing',
  blocked: 'Blocked', committed: 'Committed', abandoned: 'Abandoned', paused: 'Paused',
  captured: 'Captured',
};

const KIND_CSS_COLORS = ['decision', 'change', 'insight', 'question', 'message', 'handoff', 'spec', 'risk', 'task', 'answer', 'session', 'note', 'project', 'agent'];
const GRAPH_KINDS = ['decision', 'change', 'insight', 'spec', 'risk', 'task', 'question', 'answer', 'note', 'message', 'handoff', 'session', 'project', 'agent', 'file', 'tag'];

const VIEW_META = {
  home: { title: 'Brief', icon: 'i-home' },
  graph: { title: 'Memory graph', icon: 'i-graph' },
  timeline: { title: 'Timeline', icon: 'i-clock' },
  decisions: { title: 'Decisions', icon: 'i-decision' },
  changes: { title: 'Changes', icon: 'i-change' },
  questions: { title: 'Open questions', icon: 'i-question' },
  risks: { title: 'Risks', icon: 'i-risk' },
  messages: { title: 'Messages', icon: 'i-message' },
  handoffs: { title: 'Handoffs', icon: 'i-handoff' },
  agents: { title: 'Agents', icon: 'i-agents' },
  projects: { title: 'Projects', icon: 'i-project' },
  setup: { title: 'Connect agents', icon: 'i-terminal' },
  search: { title: 'Search', icon: 'i-search' },
  note: { title: 'Memory', icon: 'i-note' },
  agent: { title: 'Agent', icon: 'i-agents' },
};

const NOTES_VIEWS = {
  decisions: {
    title: 'Decisions',
    eyebrow: 'Shared memory · decisions',
    description: 'Every accepted tradeoff, proposed direction, and superseded call — with the reasoning attached.',
    kinds: ['decision'],
    statusOptions: ['all', 'proposed', 'accepted', 'rejected', 'superseded'],
    defaultStatus: 'all',
    emptyTitle: 'No decisions yet',
    emptyBody: 'When an agent picks an approach and explains why, it lands here automatically. You can also capture one by hand.',
    captureKind: 'decision',
  },
  changes: {
    title: 'Changes',
    eyebrow: 'Shared memory · changes',
    description: 'What was actually created and changed across the codebase, grouped into a durable record.',
    kinds: ['change'],
    statusOptions: ['all', 'active', 'in_progress', 'committed', 'captured', 'archived'],
    defaultStatus: 'all',
    emptyTitle: 'No changes captured',
    emptyBody: 'Commits and edits your agents capture land here automatically as work moves.',
    captureKind: 'change',
  },
  questions: {
    title: 'Open questions',
    eyebrow: 'Shared memory · questions',
    description: 'Unresolved threads that are blocking clarity. Answer them once, and every agent benefits.',
    kinds: ['question'],
    statusOptions: ['open', 'answered', 'all', 'archived'],
    defaultStatus: 'open',
    emptyTitle: 'No open questions',
    emptyBody: 'When an agent hits something undecided, its question lands here until someone answers it.',
    captureKind: 'question',
  },
  risks: {
    title: 'Risks',
    eyebrow: 'Shared memory · risks',
    description: 'Known hazards, fragile assumptions, and the mitigation state for each one.',
    kinds: ['risk'],
    statusOptions: ['open', 'mitigated', 'accepted', 'all'],
    defaultStatus: 'open',
    emptyTitle: 'No open risks',
    emptyBody: 'Hazards your agents surface land here, with the blast radius attached.',
    captureKind: 'risk',
  },
  search: {
    title: 'Search',
    eyebrow: 'Shared memory · search',
    description: 'Search titles, bodies, tags, projects, and linked files across the vault.',
    kinds: null,
    statusOptions: ['all'],
    defaultStatus: 'all',
    emptyTitle: 'No matches',
    emptyBody: 'Try a different phrase, a tag, an agent name, or search a file path.',
    captureKind: 'note',
  },
};

const state = {
  boot: null,
  overview: null,
  overviewAt: 0,
  overviewProject: '',
  project: localStorage.getItem('cairn.project') || '',
  theme: localStorage.getItem('cairn.theme') || 'system',
  route: 'home',
  baseRoute: 'home',
  rendered: false,
  token: 0,
  loadSeq: 0,
  graph: { kind: 'all', files: false, hubs: false, search: '', hidden: new Set() },
  timelineDays: Number(localStorage.getItem('cairn.timelineDays')) || 14,
  timelineAgent: '',
  notes: { query: '', status: 'all', sort: 'updated' },
  messages: { status: 'all' },
  palette: { open: false, items: [], commands: [], active: 0, query: '', notes: [], searching: false, seq: 0 },
  captureOpen: false,
  changePasswordOpen: false,
  changePasswordPreviousFocus: null,
  selectedId: null,
  inspectorSeq: 0,
  live: false,
  csrf: '',
  graphs: new Set(),
};

/* ---------- Small utilities ---------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  return wrapped;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function humanize(value) {
  const text = String(value || '').replace(/[-_]+/g, ' ').trim();
  if (!text) return '';
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function kindLabel(kind) {
  return KIND_META[kind]?.label || humanize(kind);
}

function kindIcon(kind) {
  return KIND_META[kind]?.icon || 'i-note';
}

function statusLabel(status) {
  return STATUS_LABELS[status] || humanize(status);
}

function initials(name) {
  const clean = String(name || '?').replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
  const parts = clean.split(/[-_ ]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  const text = String(name || '');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const color = KIND_CSS_COLORS[hash % KIND_CSS_COLORS.length];
  return `--avatar: color-mix(in srgb, var(--k-${color}) 15%, transparent); --avatar-ink: var(--k-${color});`;
}

function agentAvatar(name, sizeClass = '') {
  return `<span class="agent-avatar ${sizeClass}" style="${avatarColor(name)}" title="${escapeAttr(name)}">${escapeHtml(initials(name))}</span>`;
}

function fmtNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  if (diff < 30 * 86_400_000) return `${Math.round(diff / (7 * 86_400_000))}w ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayKey(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabel(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const key = dayKey(iso);
  if (key === dayKey(today.toISOString())) return 'Today';
  if (key === dayKey(yesterday.toISOString())) return 'Yesterday';
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function todayEyebrow() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function projectLabel(name) {
  if (!name) return 'All projects';
  const known = (state.overview?.projects || state.boot?.projects || []).find((project) => project.name === name);
  return known?.label || humanize(name);
}

function noteTitle(note) {
  return note?.title || 'Untitled memory';
}

function statusPill(status) {
  return `<span class="status-pill" data-status="${escapeAttr(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function chip(text, tone = '', extra = '') {
  return `<span class="chip ${tone ? `chip--${tone}` : ''} ${extra}">${escapeHtml(text)}</span>`;
}

function kindPill(kind) {
  return `<span class="kind-pill kind-${escapeAttr(kind)}">${escapeHtml(kindLabel(kind))}</span>`;
}

function icon(name, className = 'icon') {
  return `<svg class="${className}"><use href="#${name}"/></svg>`;
}

function emptyState(title, body, action = '') {
  return `<div class="empty-state">
    <svg class="empty-art" viewBox="0 0 64 64" aria-hidden="true">
      <ellipse cx="32" cy="49" rx="20" ry="6" fill="currentColor" opacity=".14"/>
      <ellipse cx="32" cy="40" rx="15" ry="5" fill="currentColor" opacity=".22"/>
      <ellipse cx="32" cy="31.5" rx="10.5" ry="4.2" fill="currentColor" opacity=".3"/>
      <ellipse cx="32" cy="24" rx="6" ry="3.2" fill="currentColor" opacity=".4"/>
      <path d="M12 49h40" stroke="currentColor" stroke-width="1" opacity=".25"/>
    </svg>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(body)}</p>
    ${action}
  </div>`;
}

function skeletonView() {
  return `<div class="skeleton-page">
    <div class="skeleton skeleton-hero"></div>
    <div class="stat-grid">
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    </div>
    <div class="skeleton skeleton-card" style="height: 300px"></div>
  </div>`;
}

function projectQuery(extra = {}) {
  const params = new URLSearchParams();
  if (state.project) params.set('project', state.project);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function readCookie(name) {
  const prefix = `${name}=`;
  for (const part of String(document.cookie || '').split(';')) {
    const entry = part.trim();
    if (entry.startsWith(prefix)) return decodeURIComponent(entry.slice(prefix.length));
  }
  return '';
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const token = state.csrf || readCookie('cairn_csrf');
    if (token) headers['X-Cairn-CSRF'] = token;
  }
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON errors are mapped to a readable message below.
  }
  if (!response.ok) {
    const failure = new Error(payload?.error || `Request failed (${response.status})`);
    failure.status = response.status;
    failure.code = payload?.code;
    if (response.status === 401 && path !== '/api/auth/session') {
      location.assign('/login');
    }
    throw failure;
  }
  return payload;
}

async function getJSON(path) {
  return api(path);
}

/* ---------- Theme ---------- */

function effectiveTheme() {
  if (state.theme === 'light' || state.theme === 'dark') return state.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  const label = $('#theme-label');
  if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Light';
  for (const graph of state.graphs) graph.onThemeChange();
}

function toggleTheme() {
  state.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cairn.theme', state.theme);
  applyTheme();
}

async function lockWorkspace() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch (caught) {
    if (caught instanceof Error && caught.status && caught.status !== 401) {
      toast(caught.message, 'error');
      return;
    }
  }
  state.csrf = '';
  location.assign('/login');
}

/* ---------- Chrome and data ---------- */

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value == null ? '' : String(value);
}

function applyBootstrap() {
  const boot = state.boot;
  if (!boot) return;
  setText('#vault-name', boot.vault?.name || 'Local vault');
  const vaultPath = $('#vault-path');
  if (vaultPath) {
    const rawPath = boot.vault?.path || '';
    const segments = rawPath.split(/[\\/]/).filter(Boolean);
    vaultPath.textContent = segments.length > 2 ? `…\\${segments.slice(-2).join('\\')}` : (rawPath || '—');
    vaultPath.title = rawPath;
  }
  renderProjectUI(boot.projects);
  applyTheme();
}

function renderProjectUI(projects = (state.overview?.projects || state.boot?.projects || [])) {
  const list = $('#sidebar-project-list');
  if (list) {
    const sorted = [...(projects || [])].sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity))).slice(0, 6);
    list.innerHTML = [
      `<button class="sidebar-project${state.project ? '' : ' is-active'}" data-scope="" type="button" aria-pressed="${state.project ? 'false' : 'true'}">
        <span class="sidebar-project-dot" style="--dot: var(--accent)"></span>
        <span class="sidebar-project-name">All memory</span>
      </button>`,
      ...sorted.map((project) => {
        const color = KIND_CSS_COLORS[(project.name || '').length % KIND_CSS_COLORS.length];
        const isActive = state.project === project.name;
        return `<button class="sidebar-project${isActive ? ' is-active' : ''}" data-scope="${escapeAttr(project.name)}" type="button" aria-pressed="${isActive ? 'true' : 'false'}" title="${escapeAttr(project.label || project.name)}">
          <span class="sidebar-project-dot" style="--dot: var(--k-${color})"></span>
          <span class="sidebar-project-name">${escapeHtml(project.label || humanize(project.name))}</span>
          <span class="sidebar-project-count">${project.total ? fmtNumber(project.total) : ''}</span>
        </button>`;
      }),
    ].join('');
  }

  const select = $('#project-select');
  if (select) {
    const sorted = [...(projects || [])].sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
    const names = new Set(sorted.map((project) => project.name));
    if (state.project && !names.has(state.project)) {
      sorted.push({ name: state.project, label: humanize(state.project), lastActivity: '' });
    }
    select.innerHTML = `<option value="">All projects</option>` + sorted.map((project) => (
      `<option value="${escapeAttr(project.name)}"${project.name === state.project ? ' selected' : ''}>${escapeHtml(project.label || humanize(project.name))}</option>`
    )).join('');
    select.value = state.project || '';
  }
}

function updateChrome(overview) {
  if (!overview) return;
  const stats = overview.stats || {};
  const byKind = stats.byKind || {};
  setText('#count-decisions', byKind.decision ? fmtNumber(byKind.decision) : '');
  setText('#count-changes', byKind.change ? fmtNumber(byKind.change) : '');
  setText('#count-questions', overview.attention?.questions ? fmtNumber(overview.attention.questions) : '');
  setText('#count-risks', overview.attention?.risks ? fmtNumber(overview.attention.risks) : '');
  setText('#count-messages', overview.attention?.messages ? fmtNumber(overview.attention.messages) : '');
  setText('#count-handoffs', overview.attention?.handoffs ? fmtNumber(overview.attention.handoffs) : '');

  renderProjectUI(overview.projects);
}

async function loadOverview(force = false) {
  const fresh = state.overview && state.overviewProject === state.project && Date.now() - state.overviewAt < 1600;
  if (!force && fresh) return state.overview;
  const overview = await getJSON(`/api/overview${projectQuery()}`);
  state.overview = overview;
  state.overviewAt = Date.now();
  state.overviewProject = state.project;
  updateChrome(overview);
  return overview;
}

function invalidateOverview() {
  state.overviewAt = 0;
}

function setProject(value) {
  state.project = value || '';
  try {
    localStorage.setItem('cairn.project', state.project);
  } catch {}
  invalidateOverview();
  renderProjectUI();
  closeNav();
  setNav(state.route);
  setCrumb(state.route);
  renderRoute(true);
}

function setNav(route) {
  for (const link of $$('[data-nav]')) {
    if (link.dataset.nav === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setCrumb(route, custom) {
  const meta = VIEW_META[route] || VIEW_META.home;
  setText('#crumb-current', custom || meta.title);
  const rootText = state.project ? `Project: ${projectLabel(state.project)}` : 'All memory';
  setText('#crumb-root', rootText);
  const scopeSuffix = state.project ? ` · ${projectLabel(state.project)}` : '';
  document.title = custom ? `${custom}${scopeSuffix} · Cairn` : `${meta.title}${scopeSuffix} · Cairn`;
}

/* ---------- Router ---------- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const path = decodeURIComponent(pathPart || 'home');
  const params = new URLSearchParams(queryPart || '');
  return { path: path || 'home', params };
}

function go(route) {
  const target = `#/${route}`;
  if (location.hash === target) renderRoute(true);
  else location.hash = target;
}

function destroyGraphs() {
  for (const graph of state.graphs) graph.destroy();
  state.graphs.clear();
}

async function renderRoute(force = false) {
  const { path, params } = parseHash();

  if (path.startsWith('note/')) {
    const id = path.slice(5);
    if (!state.rendered) {
      await renderBase('home');
    }
    selectNote(id, { push: false });
    return;
  }

  closeInspectorDOM();
  await renderBase(path, params);
}

async function renderBase(path, params = new URLSearchParams()) {
  const route = Object.prototype.hasOwnProperty.call(VIEW_META, path) ? path : 'home';
  state.route = route;
  state.rendered = true;
  state.baseRoute = route;
  setNav(route);
  setCrumb(route);
  const token = ++state.token;
  closeNav();
  destroyGraphs();

  const view = $('#view');
  if (!view) return;
  view.className = route === 'graph' ? 'view view--graph' : 'view';
  view.innerHTML = skeletonView();

  try {
    if (route === 'home') {
      await renderHome(token);
    } else if (route === 'graph') {
      await renderGraph(token);
    } else if (route === 'timeline') {
      await renderTimeline(token);
    } else if (route === 'messages' || route === 'handoffs') {
      await renderMessages(token, route);
    } else if (route === 'agents') {
      await renderAgents(token);
    } else if (route === 'projects') {
      await renderProjects(token);
    } else if (route === 'setup') {
      await renderSetup(token);
    } else if (route === 'search') {
      await renderNotesView(token, 'search', { query: params.get('q') || '' });
    } else if (route.startsWith('agent/')) {
      await renderAgentMemory(token, route.slice(6));
    } else if (NOTES_VIEWS[route]) {
      await renderNotesView(token, route);
    } else {
      await renderHome(token);
    }
  } catch (caught) {
    if (token !== state.token) return;
    view.innerHTML = `<div class="view-inner">${emptyState('Could not load this view', caught instanceof Error ? caught.message : 'Unexpected error', `<button class="btn" data-action="retry">${icon('i-clock')} Retry</button>`)}</div>`;
  }
}

/* ---------- Home ---------- */

async function renderHome(token) {
  const [overview, graph] = await Promise.all([
    loadOverview(true),
    getJSON(`/api/graph${projectQuery({ limit: 90 })}`),
  ]);
  if (token !== state.token) return;

  const stats = overview.stats || {};
  const byKind = stats.byKind || {};
  const agents = overview.agents || [];
  const online = agents.filter((agent) => agent.online).length;
  const scopeName = state.project ? projectLabel(state.project) : '';
  const total = stats.notes || 0;
  const attention = overview.attention || {};
  const mcpCommand = `cairn mcp --vault "${state.boot?.vault?.path || '.cairn'}" --project ${state.boot?.defaultProject || 'cairn'} --agent <handle>`;

  let wiredHere = null;
  if (!total) {
    try {
      const connections = await getJSON('/api/connections');
      if (token !== state.token) return;
      wiredHere = (connections.clients || []).filter((client) => client.wired).length;
    } catch {
      wiredHere = null;
    }
  }

  const hero = `<section class="hero">
    <div class="hero-copy">
      <p class="eyebrow eyebrow--accent">${escapeHtml(todayEyebrow())} · vault brief</p>
      <h1>${scopeName ? `${escapeHtml(scopeName)}, <em>remembered</em>.` : `Agents change code.<br>Cairn <em>remembers</em> why.`}</h1>
      <p class="hero-sub">${scopeName
        ? `A scoped view of the decisions, changes, and handoffs your agents left in <strong>${escapeHtml(scopeName)}</strong> — stored as plain Markdown, readable by any coding system.`
        : `A shared, local memory graph of decisions, changes, and handoffs. Your agents write to it, read from it, and hand work over through it.`}</p>
      <div class="hero-meta">
        ${total
          ? `${chip(`${fmtNumber(total)} notes`, 'muted')}
             ${chip(`${fmtNumber(stats.edges || 0)} links`, 'muted')}
             ${chip(`${fmtNumber(overview.projects?.length || 0)} projects`, 'muted')}
             <span class="muted small">Updated ${timeAgo(overview.generatedAt)}</span>`
          : `${chip('local-first', 'muted')}
             ${chip('plain Markdown', 'muted')}
             ${chip('MCP', 'muted')}
             <span class="muted small">Nothing leaves this machine.</span>`}
      </div>
    </div>
    <div class="hero-actions">
      ${total
        ? `<button class="btn btn--primary" data-action="capture" type="button">${icon('i-plus')} Capture memory</button>
           <button class="btn btn--ghost" data-go="graph" type="button">${icon('i-graph')} Explore graph</button>`
        : ''}
    </div>
  </section>`;

  if (!total) {
    $('#view').innerHTML = `<div class="view-inner">
      ${hero}
      <section class="panel first-run">
        <p class="eyebrow">Waiting for agents</p>
        <h2>Connect your agents. They feed this vault.</h2>
        <p class="muted first-run-lead">Cairn is the memory layer your coding systems write to over MCP. You do not fill it in by hand: wire each system once, and it records decisions, changes, questions, and handoffs as it works. This workspace is where you watch it happen.</p>
        ${wiredHere == null ? '' : `<div class="first-run-status">
          ${wiredHere
            ? `<span class="chip chip--moss">${icon('i-check')} ${wiredHere} wired in this directory</span><span class="muted small">Restart the client so it loads Cairn.</span>`
            : `<span class="chip chip--muted">No clients detected in this directory yet</span>`}
        </div>`}
        <div class="first-run-actions">
          <button class="btn btn--primary" data-go="setup" type="button">${icon('i-terminal')} Connect agents</button>
          <button class="btn btn--ghost" data-copy="${escapeAttr(mcpCommand)}" type="button">${icon('i-copy')} Copy MCP command</button>
        </div>
        <div class="first-run-steps">
          <div class="first-run-step">
            <span class="chip chip--accent">Step 1</span>
            <h3>Wire a coding system</h3>
            <p>Run <code class="mono">cairn connect &lt;client&gt;</code> in your project root, then restart the client.</p>
          </div>
          <div class="first-run-step">
            <span class="chip chip--gold">Step 2</span>
            <h3>The agent writes as it works</h3>
            <p>It reads the brief first, then records decisions, changes, questions, and handoffs as it goes.</p>
          </div>
          <div class="first-run-step">
            <span class="chip chip--moss">Step 3</span>
            <h3>Watch progress</h3>
            <p>The brief, graph, and timeline update live as memory arrives — no refreshes.</p>
          </div>
        </div>
      </section>
    </div>`;
    return;
  }

  const statCards = [
    { label: 'Notes', value: total, foot: `${fmtNumber(byKind.decision || 0)} decisions · ${fmtNumber(byKind.change || 0)} changes`, icon: 'i-note', color: 'decision' },
    { label: 'Links', value: stats.edges || 0, foot: `${fmtNumber(stats.projects || 0)} projects in the graph`, icon: 'i-link', color: 'insight' },
    { label: 'Open threads', value: (attention.questions || 0) + (attention.risks || 0) + (attention.handoffs || 0), foot: `${fmtNumber(attention.questions || 0)} questions · ${fmtNumber(attention.risks || 0)} risks`, icon: 'i-question', color: 'question' },
    { label: 'Agents', value: agents.length, foot: `${online} active right now`, icon: 'i-agents', color: 'agent' },
  ];

  const statGrid = `<section class="stat-grid" aria-label="Vault statistics">
    ${statCards.map((card) => `<div class="stat-card" style="--stat-color: var(--k-${card.color})">
      <div class="stat-label">${icon(card.icon)} ${escapeHtml(card.label)}</div>
      <div class="stat-value">${fmtNumber(card.value)}</div>
      <div class="stat-foot">${card.foot}</div>
    </div>`).join('')}
  </section>`;

  const attentionCards = [
    { label: 'decisions awaiting review', count: attention.proposals || 0, route: 'decisions', icon: 'i-decision', tone: 'accent' },
    { label: 'open questions', count: attention.questions || 0, route: 'questions', icon: 'i-question', tone: 'gold' },
    { label: 'handoffs unread', count: attention.handoffs || 0, route: 'handoffs', icon: 'i-handoff', tone: 'hand' },
    { label: 'unread messages', count: attention.messages || 0, route: 'messages', icon: 'i-message', tone: 'blue' },
  ];
  const attentionRow = `<section class="attention-row" aria-label="Needs attention">
    ${attentionCards.map((card) => `<button class="attention attention--${card.tone}${card.count ? '' : ' is-zero'}" data-go="${card.route}" type="button">
      <span class="attention-icon">${icon(card.icon)}</span>
      <span class="attention-body"><span class="attention-count">${fmtNumber(card.count)}</span><span class="attention-label">${escapeHtml(card.label)}</span></span>
    </button>`).join('')}
  </section>`;

  const decisions = overview.decisions || [];
  const decisionPanel = `<section class="panel">
    <div class="panel-head">
      <h2>Decisions recently made</h2>
      <a class="text-link panel-link" href="#/decisions">All decisions ${icon('i-chevron')}</a>
    </div>
    <div style="padding: 0 18px 10px;">
      ${decisions.length ? `<div class="decision-stack">${decisions.map((note) => `
        <button class="decision-item" data-note="${escapeAttr(note.id)}" type="button">
          <span class="decision-mark">${icon('i-decision')}</span>
          <span class="decision-body">
            <span class="decision-title">${escapeHtml(note.title)}</span>
            <span class="decision-meta">
              <span>${escapeHtml(humanize(note.agent || 'human'))}</span>
              <span class="sep"></span>
              <span>${timeAgo(note.updated)}</span>
              ${note.files?.length ? `<span class="sep"></span><span>${fmtNumber(note.files.length)} file${note.files.length === 1 ? '' : 's'}</span>` : ''}
            </span>
          </span>
          <span class="decision-status">${statusPill(note.status)}</span>
        </button>`).join('')}</div>` : emptyState('No decisions captured', 'The next tradeoff your agent makes deserves a note. Capture it with the reasoning intact.')}
    </div>
  </section>`;

  const timeline = (overview.timeline || []).slice(0, 7);
  const activityPanel = `<section class="panel">
    <div class="panel-head">
      <h2>Latest activity</h2>
      <a class="text-link panel-link" href="#/timeline">Timeline ${icon('i-chevron')}</a>
    </div>
    <div style="padding: 0 18px 10px;">
      ${timeline.length ? `<div class="activity-feed">${timeline.map((hit) => {
        const note = hit.note;
        const color = `var(--k-${KIND_META[note.kind] ? note.kind : 'note'})`;
        return `<div class="activity-item">
          <span class="activity-rail"><span class="activity-dot" style="--dot: ${color}"></span></span>
          <div class="activity-body">
            <div class="activity-text"><a href="#/note/${encodeURIComponent(note.id)}"><strong>${escapeHtml(note.title)}</strong></a></div>
            <div class="activity-time">${escapeHtml(kindLabel(note.kind))} · ${escapeHtml(humanize(note.agent || 'human'))} · ${timeAgo(note.created)}</div>
          </div>
        </div>`;
      }).join('')}</div>` : emptyState('Nothing has happened yet', 'Activity will stream in as agents write decisions, changes, and messages.')}
    </div>
  </section>`;

  const presentKinds = Array.from(new Set((graph.nodes || []).map((node) => node.kind))).filter((kind) => GRAPH_KINDS.includes(kind)).slice(0, 6);
  const graphPreview = `<section class="graph-preview">
    <div class="graph-preview-head"><h2>Memory map</h2><span>${fmtNumber(graph.stats?.nodes || 0)} nodes · ${fmtNumber(graph.stats?.edges || 0)} links</span></div>
    <canvas id="preview-canvas" aria-label="Preview of the memory graph"></canvas>
    <div class="graph-preview-legend">
      ${presentKinds.map((kind) => `<span class="legend-item"><span class="legend-swatch" style="--sw: var(--k-${kind})"></span>${escapeHtml(kindLabel(kind))}</span>`).join('')}
    </div>
  </section>`;

  const topAgents = [...agents].sort((a, b) => Number(b.online) - Number(a.online) || b.total - a.total).slice(0, 5);
  const agentPanel = `<section class="panel" style="padding-bottom: 8px;">
    <div class="panel-head">
      <h2>Agents in this vault</h2>
      <a class="text-link panel-link" href="#/agents">All agents ${icon('i-chevron')}</a>
    </div>
    <div style="padding: 0 18px;">
      <div class="agent-strip">
        ${topAgents.map((agent) => `<button class="agent-line" data-go="agent/${encodeURIComponent(agent.name)}" type="button">
          ${agentAvatar(agent.name)}
          <span class="agent-line-main">
            <span class="agent-line-name">${escapeHtml(agent.label || humanize(agent.name))}<span class="dot ${agent.online ? 'dot--live' : 'dot--idle'}" title="${agent.online ? 'Active now' : 'Last seen ' + timeAgo(agent.lastSeen)}"></span></span>
            <span class="agent-line-sub">${escapeHtml(agent.sessionTitle || agent.goal || 'No active session')}</span>
          </span>
          <span class="agent-line-total">${fmtNumber(agent.total)} notes</span>
        </button>`).join('')}
      </div>
    </div>
  </section>`;

  $('#view').innerHTML = `<div class="view-inner">
    ${hero}
    ${statGrid}
    ${attentionRow}
    <div class="home-grid">
      <div class="home-col">${decisionPanel}${activityPanel}</div>
      <div class="home-col home-col--side">${graphPreview}${agentPanel}</div>
    </div>
  </div>`;

  const canvas = $('#preview-canvas');
  if (canvas) {
    const preview = new ForceGraph(canvas, {
      data: graph,
      preview: true,
      onSelect: (id) => selectNote(id),
    });
    state.graphs.add(preview);
    preview.start();
  }
}

/* ---------- Notes list views ---------- */

async function renderNotesView(token, route, options = {}) {
  const config = NOTES_VIEWS[route] || NOTES_VIEWS.search;
  state.notes = {
    query: options.query ?? '',
    status: config.defaultStatus,
    sort: 'updated',
  };
  setCrumb(route, route === 'search' && state.notes.query ? `Search · ${state.notes.query}` : config.title);

  const view = $('#view');
  view.innerHTML = `<div class="view-inner">
    <header class="page-head">
      <div>
        <p class="eyebrow eyebrow--accent">${escapeHtml(config.eyebrow)}</p>
        <h1>${escapeHtml(config.title)}</h1>
        <p>${escapeHtml(config.description)}</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="capture" data-kind="${escapeAttr(config.captureKind)}" type="button">${icon('i-plus')} Capture ${escapeHtml(kindLabel(config.captureKind).toLowerCase())}</button>
      </div>
    </header>
    <div class="list-toolbar">
      <label class="search-field">
        ${icon('i-search')}
        <input id="notes-search" type="search" placeholder="Search ${escapeHtml(config.title.toLowerCase())}…" value="${escapeAttr(state.notes.query)}" autocomplete="off" spellcheck="false">
      </label>
      <select class="filter-select" id="notes-status" aria-label="Filter by status">
        ${config.statusOptions.map((status) => `<option value="${escapeAttr(status)}"${status === state.notes.status ? ' selected' : ''}>${status === 'all' ? 'Any status' : escapeHtml(statusLabel(status))}</option>`).join('')}
      </select>
      <select class="filter-select" id="notes-sort" aria-label="Sort notes">
        <option value="updated">Recently updated</option>
        <option value="created">Recently created</option>
      </select>
    </div>
    <div id="notes-results"><div class="skeleton skeleton-card" style="height: 260px"></div></div>
  </div>`;

  const search = $('#notes-search');
  const runSearch = debounce(() => {
    state.notes.query = search.value.trim();
    loadNotesResults(route, config);
  }, 220);
  search?.addEventListener('input', runSearch);
  search?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      runSearch.cancel();
      state.notes.query = search.value.trim();
      loadNotesResults(route, config);
    }
  });
  $('#notes-status')?.addEventListener('change', (event) => {
    state.notes.status = event.target.value;
    loadNotesResults(route, config);
  });
  $('#notes-sort')?.addEventListener('change', (event) => {
    state.notes.sort = event.target.value;
    loadNotesResults(route, config);
  });

  await loadNotesResults(route, config);
  if (token !== state.token) return;
}

async function loadNotesResults(route, config) {
  const seq = ++state.loadSeq;
  const results = $('#notes-results');
  if (!results) return;
  if (!results.querySelector('.note-list')) {
    results.innerHTML = `<div class="skeleton skeleton-card" style="height: 260px"></div>`;
  }
  const params = new URLSearchParams();
  if (state.notes.query) params.set('q', state.notes.query);
  if (state.project) params.set('project', state.project);
  if (config.kinds?.length) params.set('kinds', config.kinds.join(','));
  if (state.notes.status && state.notes.status !== 'all') params.set('status', state.notes.status);
  params.set('sort', state.notes.sort);
  params.set('limit', '150');

  try {
    const data = await getJSON(`/api/notes?${params.toString()}`);
    if (seq !== state.loadSeq) return;
    const hits = data.hits || [];
    setCrumb(route, route === 'search' && state.notes.query ? `Search · ${state.notes.query}` : config.title);

    if (!hits.length) {
      results.innerHTML = `<div class="panel">${emptyState(config.emptyTitle, config.emptyBody, `<button class="btn btn--primary" data-action="capture" data-kind="${escapeAttr(config.captureKind)}">${icon('i-plus')} Capture a note</button>`)}</div>`;
      return;
    }

    const grouping = state.notes.status === 'all' && config.kinds?.length === 1 && config.statusOptions.length > 2;
    let body = '';
    if (grouping) {
      const order = config.statusOptions.filter((status) => status !== 'all');
      const groups = new Map();
      for (const hit of hits) {
        const key = hit.note.status;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(hit);
      }
      const keys = [...groups.keys()].sort((a, b) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      body = keys.map((key) => `<section class="note-group">
        <div class="note-group-head"><span>${escapeHtml(statusLabel(key))}</span><span class="note-group-count">${groups.get(key).length}</span></div>
        <div class="note-list">${groups.get(key).map((hit) => noteRow(hit)).join('')}</div>
      </section>`).join('');
    } else {
      body = `<div class="note-list">${hits.map((hit) => noteRow(hit)).join('')}</div>`;
    }

    results.innerHTML = `<div class="result-meta">
      <strong>${fmtNumber(hits.length)}</strong> ${hits.length === 1 ? 'note' : 'notes'}
      ${state.notes.query ? ` matching “${escapeHtml(state.notes.query)}”` : ''}
      ${state.project ? ` in ${escapeHtml(projectLabel(state.project))}` : ''}
      <span style="margin-left:auto">${state.notes.sort === 'updated' ? 'Sorted by update' : 'Sorted by creation'}</span>
    </div>${body}`;
  } catch (caught) {
    if (seq !== state.loadSeq) return;
    results.innerHTML = `<div class="panel">${emptyState('Could not load notes', caught instanceof Error ? caught.message : 'Unexpected error')}</div>`;
  }
}

function noteRow(hit) {
  const note = hit.note || hit;
  const unread = note.status === 'unread';
  const snippet = hit.snippet || note.snippet || '';
  return `<button class="note-row${state.selectedId === note.id ? ' is-selected' : ''}" data-note="${escapeAttr(note.id)}" type="button">
    <span class="note-kind-mark kind-${escapeAttr(note.kind)}">${icon(kindIcon(note.kind))}</span>
    <span class="note-row-main">
      <span class="note-row-title">${unread ? '<span class="unread-dot"></span>' : ''}${escapeHtml(noteTitle(note))}</span>
      <span class="note-row-snippet">${escapeHtml(snippet || 'No body yet.')}</span>
    </span>
    <span class="note-row-side">
      ${statusPill(note.status)}
      <span class="note-row-agent">${escapeHtml(humanize(note.agent || 'human'))}</span>
      <span class="note-row-time">${timeAgo(note.updated)}</span>
      ${icon('i-chevron', 'icon note-row-chevron')}
    </span>
  </button>`;
}

/* ---------- Timeline ---------- */

async function renderTimeline(token) {
  const agents = state.boot?.agents || [];
  const view = $('#view');
  view.innerHTML = `<div class="view-inner">
    <header class="page-head">
      <div>
        <p class="eyebrow eyebrow--accent">Shared memory · activity</p>
        <h1>Timeline</h1>
        <p>Everything the agents did, in the order they did it. A chronological read of the vault.</p>
      </div>
    </header>
    <div class="list-toolbar">
      <span class="muted small" style="font-weight:600">Window</span>
      <select class="filter-select" id="timeline-days" aria-label="Timeline window">
        ${[7, 14, 30, 90].map((days) => `<option value="${days}"${days === state.timelineDays ? ' selected' : ''}>Last ${days} days</option>`).join('')}
      </select>
      <select class="filter-select" id="timeline-agent" aria-label="Filter by agent">
        <option value="">All agents</option>
        ${agents.map((agent) => `<option value="${escapeAttr(agent.name)}"${agent.name === state.timelineAgent ? ' selected' : ''}>${escapeHtml(agent.label || humanize(agent.name))}</option>`).join('')}
      </select>
      <span class="muted small" style="margin-left:auto" id="timeline-count"></span>
    </div>
    <div id="timeline-results"><div class="skeleton skeleton-card" style="height: 360px"></div></div>
  </div>`;

  const load = async () => {
    const seq = ++state.loadSeq;
    const results = $('#timeline-results');
    try {
      const params = new URLSearchParams();
      if (state.project) params.set('project', state.project);
      if (state.timelineAgent) params.set('agent', state.timelineAgent);
      params.set('days', String(state.timelineDays));
      params.set('limit', '200');
      const data = await getJSON(`/api/timeline?${params.toString()}`);
      if (seq !== state.loadSeq || token !== state.token) return;
      const hits = data.hits || [];
      setText('#timeline-count', `${fmtNumber(hits.length)} events`);
      if (!hits.length) {
        results.innerHTML = `<div class="panel">${emptyState('A quiet stretch', 'No activity in this window. Widen the timeline or ask an agent to capture its next decision.')}</div>`;
        return;
      }
      const groups = new Map();
      for (const hit of hits) {
        const key = dayKey(hit.note.created);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(hit);
      }
      results.innerHTML = `<div class="timeline">${[...groups.entries()].map(([, items]) => `
        <section class="timeline-day">
          <div class="timeline-day-label">${escapeHtml(dayLabel(items[0].note.created))}</div>
          <div class="timeline-events">
            ${items.map((hit) => {
              const note = hit.note;
              return `<button class="timeline-event" data-note="${escapeAttr(note.id)}" type="button">
                <span class="note-kind-mark kind-${escapeAttr(note.kind)}">${icon(kindIcon(note.kind))}</span>
                <span class="timeline-event-main">
                  <span class="timeline-event-title">${escapeHtml(note.title)}</span>
                  <span class="timeline-event-meta">
                    ${kindPill(note.kind)}
                    <span class="sep-dot"></span>
                    <span>${escapeHtml(humanize(note.agent || 'human'))}</span>
                    ${note.project ? `<span class="sep-dot"></span><span>${escapeHtml(projectLabel(note.project))}</span>` : ''}
                    <span class="sep-dot"></span>
                    ${statusPill(note.status)}
                  </span>
                  <span class="timeline-event-snippet">${escapeHtml(hit.snippet || '')}</span>
                </span>
                <span class="timeline-event-time">${escapeHtml(fmtTime(note.created))}</span>
              </button>`;
            }).join('')}
          </div>
        </section>`).join('')}</div>`;
    } catch (caught) {
      if (seq !== state.loadSeq) return;
      results.innerHTML = `<div class="panel">${emptyState('Could not load the timeline', caught instanceof Error ? caught.message : 'Unexpected error')}</div>`;
    }
  };

  $('#timeline-days')?.addEventListener('change', (event) => {
    state.timelineDays = Number(event.target.value) || 14;
    localStorage.setItem('cairn.timelineDays', String(state.timelineDays));
    load();
  });
  $('#timeline-agent')?.addEventListener('change', (event) => {
    state.timelineAgent = event.target.value;
    load();
  });
  await load();
}

/* ---------- Messages and handoffs ---------- */

async function renderMessages(token, route) {
  const isHandoff = route === 'handoffs';
  const view = $('#view');
  const statusOptions = isHandoff ? ['all', 'unread', 'read', 'done'] : ['all', 'unread', 'read'];
  const overview = await loadOverview();
  if (token !== state.token) return;
  const unread = isHandoff ? overview.attention?.handoffs || 0 : overview.attention?.messages || 0;

  view.innerHTML = `<div class="view-inner">
    <header class="page-head">
      <div>
        <p class="eyebrow eyebrow--accent">Shared memory · coordination</p>
        <h1>${isHandoff ? 'Handoffs' : 'Messages'}</h1>
        <p>${isHandoff
          ? 'Work passed from one agent to another, with context, next steps, and a clear state.'
          : 'Direct notes between agents. Ask a question, share a finding, or flag something before it becomes a problem.'}</p>
      </div>
      <div class="page-actions">
        <button class="btn btn--primary" data-action="capture" data-kind="${isHandoff ? 'handoff' : 'message'}" type="button">${icon('i-plus')} ${isHandoff ? 'New handoff' : 'Compose message'}</button>
      </div>
    </header>
    <div class="list-toolbar">
      <div class="seg" id="message-filter">
        ${statusOptions.map((status) => `<button type="button" data-message-status="${status}" class="${status === state.messages.status ? 'is-active' : ''}">${status === 'all' ? 'All' : escapeHtml(statusLabel(status))}</button>`).join('')}
      </div>
      <span class="muted small" style="margin-left:auto">${fmtNumber(unread)} unread ${isHandoff ? 'handoffs' : 'messages'}</span>
    </div>
    <div id="message-results"><div class="skeleton skeleton-card" style="height: 260px"></div></div>
  </div>`;

  const load = async () => {
    const seq = ++state.loadSeq;
    const results = $('#message-results');
    const params = new URLSearchParams();
    if (state.project) params.set('project', state.project);
    params.set('kind', isHandoff ? 'handoff' : 'message');
    if (state.messages.status !== 'all') params.set('status', state.messages.status);
    params.set('limit', '200');
    try {
      const data = await getJSON(`/api/messages?${params.toString()}`);
      if (seq !== state.loadSeq || token !== state.token) return;
      const hits = data.hits || [];
      if (!hits.length) {
        results.innerHTML = `<div class="panel">${emptyState(
          isHandoff ? 'No handoffs in flight' : 'Inbox zero',
          isHandoff ? 'When one agent hands work to another, the context and next steps will land here.' : 'No messages match this filter. Compose one to start a conversation between agents.',
          `<button class="btn btn--primary" data-action="capture" data-kind="${isHandoff ? 'handoff' : 'message'}">${icon('i-plus')} ${isHandoff ? 'Create a handoff' : 'Compose a message'}</button>`,
        )}</div>`;
        return;
      }
      results.innerHTML = `<div class="message-list">${hits.map((hit) => messageCard(hit.note, hit.snippet, isHandoff)).join('')}</div>`;
    } catch (caught) {
      if (seq !== state.loadSeq) return;
      results.innerHTML = `<div class="panel">${emptyState('Could not load messages', caught instanceof Error ? caught.message : 'Unexpected error')}</div>`;
    }
  };

  for (const button of $$('#message-filter [data-message-status]')) {
    button.addEventListener('click', () => {
      state.messages.status = button.dataset.messageStatus;
      for (const peer of $$('#message-filter [data-message-status]')) peer.classList.toggle('is-active', peer === button);
      load();
    });
  }
  await load();
}

function messageCard(note, snippet, isHandoff) {
  const unread = note.status === 'unread';
  const done = note.status === 'done';
  return `<button class="message-card${unread ? ' is-unread' : ''}${done ? ' is-done' : ''}" data-note="${escapeAttr(note.id)}" type="button">
    <span class="note-kind-mark kind-${isHandoff ? 'handoff' : 'message'}">${icon(isHandoff ? 'i-handoff' : 'i-message')}</span>
    <span class="message-body">
      <span class="message-subject">${escapeHtml(note.title)}${note.metadata?.priority === 'high' ? '<span class="priority">High</span>' : ''}</span>
      <span class="message-route">
        <span>${escapeHtml(humanize(note.agent || 'human'))}</span>
        ${icon('i-chevron', 'icon arrow')}
        <span>${escapeHtml((note.to || []).map(humanize).join(', ') || 'unassigned')}</span>
        ${note.project ? `<span class="sep-dot"></span><span>${escapeHtml(projectLabel(note.project))}</span>` : ''}
      </span>
      <span class="message-preview">${escapeHtml(snippet || 'No message body.')}</span>
    </span>
    <span class="message-side">
      <span>${statusPill(note.status)}</span>
      <time>${timeAgo(note.updated)}</time>
      ${note.files?.length ? `<span class="muted" style="font-size:9.5px">${fmtNumber(note.files.length)} file${note.files.length === 1 ? '' : 's'}</span>` : ''}
    </span>
  </button>`;
}

/* ---------- Connect agents ---------- */

async function renderSetup(token) {
  const data = await getJSON('/api/connections');
  if (token !== state.token) return;
  const clients = data.clients || [];
  const wiredCount = clients.filter((client) => client.wired).length;
  const notes = data.notes || 0;
  const kinds = ['decision', 'change', 'insight', 'question', 'spec', 'risk', 'task', 'message', 'handoff'];
  const cwd = data.cwd || '';
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  const cwdShort = segments.length > 2 ? `…\\${segments.slice(-2).join('\\')}` : cwd;

  const groups = [
    { id: 'editors', label: 'Editors & IDEs', sub: 'Writes the client config, rule, and hooks for you.' },
    { id: 'terminal', label: 'CLI & terminal agents', sub: 'Prints the exact entry to paste into the client config.' },
    { id: 'universal', label: 'Any MCP client', sub: 'For everything else that speaks stdio MCP.' },
  ];

  const steps = [
    {
      title: 'Run the connector',
      body: 'One command per client, from this project directory. It writes the MCP config and the rule file.',
      done: wiredCount > 0,
    },
    {
      title: 'Restart the client',
      body: 'Most clients load MCP servers at launch. Approve Cairn if the client asks for permission.',
      done: wiredCount > 0 && notes > 0,
    },
    {
      title: 'Watch memory arrive',
      body: 'Give the agent a task. Decisions, changes, and questions appear here live, with no refresh.',
      done: wiredCount > 0 && notes > 0,
    },
  ];
  const openStep = steps.findIndex((step) => !step.done);

  $('#view').innerHTML = `<div class="view-inner">
    <header class="page-head">
      <div>
        <p class="eyebrow eyebrow--accent">Shared memory · connect</p>
        <h1>Connect agents</h1>
        <p>Cairn is fed automatically. Wire each coding system once over MCP; it reads memory before work and writes decisions, changes, and handoffs as it goes. Every connection installs a rule file — and, where supported, a skill — that teaches the agent the loop.</p>
      </div>
      <div class="page-actions">
        ${chip(wiredCount ? `${wiredCount} wired here` : 'No clients detected here', wiredCount ? 'moss' : 'muted')}
        ${chip(notes ? `${fmtNumber(notes)} notes` : 'Waiting for memory', notes ? 'moss' : 'muted')}
        <button class="btn btn--ghost" data-action="retry" type="button" title="Re-read client configs on disk">${icon('i-clock')} Check again</button>
      </div>
    </header>

    <section class="setup-steps" aria-label="Setup steps">
      ${steps.map((step, index) => `
        <div class="setup-step${step.done ? ' is-done' : ''}${!step.done && index === openStep ? ' is-current' : ''}">
          <span class="setup-step-mark">${step.done ? icon('i-check') : index + 1}</span>
          <div>
            <strong>${escapeHtml(step.title)}</strong>
            <p>${escapeHtml(step.body)}</p>
          </div>
        </div>`).join('')}
    </section>

    <section class="panel setup-command-panel">
      <div class="panel-head">
        <div>
          <h2>MCP server</h2>
          <p class="panel-sub">Point any MCP-capable coding system at this vault. Each agent connects with its own handle, which stamps everything it writes.</p>
        </div>
        <span class="chip chip--muted">${icon('i-terminal')} stdio</span>
      </div>
      <button class="connect-cmd" data-copy="${escapeAttr(data.command || '')}" type="button" title="Copy MCP command">
        <code>${escapeHtml(data.command || '')}</code>
        <span class="copy-hint">${icon('i-copy')} Copy</span>
      </button>
      <p class="muted small setup-hint setup-where">Run connectors from
        <button class="setup-cwd" data-copy="${escapeAttr(cwd)}" type="button" title="Copy project directory">${icon('i-copy')} <code>${escapeHtml(cwdShort)}</code></button>
        — the directory the workspace was started from, so config lands in the right project.</p>
    </section>

    ${groups.map((group) => {
      const items = clients.filter((client) => client.category === group.id);
      if (!items.length) return '';
      return `<section class="setup-group" aria-label="${escapeAttr(group.label)}">
        <div class="setup-group-head">
          <h2>${escapeHtml(group.label)}</h2>
          <span class="setup-group-count">${items.length}</span>
          <p>${escapeHtml(group.sub)}</p>
        </div>
        <div class="setup-grid">
          ${items.map((client) => `
            <article class="setup-card${client.wired ? ' is-wired' : ''}">
              <div class="setup-card-head">
                <span class="setup-card-name">${escapeHtml(client.name)}</span>
                ${client.wired
                  ? `<span class="chip chip--moss">${icon('i-check')} Wired</span>`
                  : `<span class="setup-mode setup-mode--${escapeAttr(client.install)}">${client.install === 'writes' ? 'writes config' : 'prints config'}</span>`}
              </div>
              <p>${escapeHtml(client.note)}</p>
              <button class="setup-cmd" data-copy="${escapeAttr(client.command)}" type="button" title="Copy command">
                <code>${escapeHtml(client.command)}</code>
                ${icon('i-copy')}
              </button>
            </article>`).join('')}
        </div>
      </section>`;
    }).join('')}

    <div class="setup-lower">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>What lands here</h2>
            <p class="panel-sub">Memory kinds agents write as they work.</p>
          </div>
        </div>
        <div class="setup-kinds">
          ${kinds.map((kind) => `<span class="chip">${icon(KIND_META[kind].icon)} ${escapeHtml(kindLabel(kind))}</span>`).join('')}
        </div>
        <p class="muted small setup-hint">Messages and handoffs coordinate agents directly, with unread inboxes and review. Every note is Markdown with YAML frontmatter, linked into the graph.</p>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Automatic capture</h2>
            <p class="panel-sub">Claude Code gets more than just MCP.</p>
          </div>
        </div>
        <ul class="setup-hooks">
          <li><strong>SessionStart</strong> injects the brief before work begins.</li>
          <li><strong>PostToolUse</strong> keeps a rolling worklog of files edited.</li>
          <li><strong>SessionEnd</strong> closes the session with a summary.</li>
          <li><strong>post-commit</strong> captures every commit as change memory.</li>
        </ul>
        <p class="muted small setup-hint">Installed by <code class="mono">cairn connect claude-code --git-hooks</code>.</p>
      </section>
    </div>
  </div>`;
}

/* ---------- Agents ---------- */

async function renderAgents(token) {
  const data = await getJSON(`/api/agents${projectQuery()}`);
  if (token !== state.token) return;
  const agents = data.agents || [];
  const online = agents.filter((agent) => agent.online).length;
  const boot = state.boot || {};
  const mcpCommand = `cairn mcp --vault "${boot.vault?.path || '.cairn'}" --project ${boot.defaultProject || 'workspace'} --agent <handle>`;

  $('#view').innerHTML = `<div class="view-inner">
    <header class="page-head">
      <div>
        <p class="eyebrow eyebrow--accent">Shared memory · actors</p>
        <h1>Agents</h1>
        <p>Every coding system that has written to this vault, what it is working on, and what it left behind.</p>
      </div>
      <div class="page-actions">${chip(`${agents.length} known`, 'muted')}${chip(`${online} online`, online ? 'moss' : 'muted')}</div>
    </header>
    ${agents.length ? `<div class="agent-grid">${agents.map((agent) => `
      <article class="agent-card">
        <div class="agent-card-head">
          ${agentAvatar(agent.name)}
          <div class="agent-card-id">
            <div class="agent-card-name">${escapeHtml(agent.label || humanize(agent.name))}<span class="dot ${agent.online ? 'dot--live' : 'dot--idle'}" title="${agent.online ? 'Active now' : 'Last seen ' + timeAgo(agent.lastSeen)}"></span></div>
            <div class="agent-card-role">${agent.project ? escapeHtml(projectLabel(agent.project)) : 'No project scope'} · ${escapeHtml(agent.online ? 'active now' : `seen ${timeAgo(agent.lastSeen) || 'recently'}`)}</div>
          </div>
          ${agent.unread ? `<span class="chip chip--accent">${fmtNumber(agent.unread)} unread</span>` : ''}
        </div>
        ${agent.sessionTitle || agent.goal ? `<div class="agent-card-session"><strong>${escapeHtml(agent.sessionTitle || 'Current session')}</strong>${agent.goal ? `<br><span>${escapeHtml(agent.goal)}</span>` : ''}</div>` : ''}
        <div class="agent-counts">
          ${Object.entries(agent.counts || {}).filter(([, count]) => count).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([kind, count]) => `<span class="chip">${escapeHtml(kindLabel(kind))} ${fmtNumber(count)}</span>`).join('')}
          ${!Object.values(agent.counts || {}).some(Boolean) ? '<span class="chip chip--muted">No notes yet</span>' : ''}
        </div>
        <div class="agent-card-foot">
          <span>${fmtNumber(agent.total)} notes</span>
          <span class="sep-dot"></span>
          <span>${escapeHtml(agent.lastSeen ? timeAgo(agent.lastSeen) : '')}</span>
          <a class="text-link" href="#/agent/${encodeURIComponent(agent.name)}">Memory ${icon('i-chevron')}</a>
        </div>
      </article>`).join('')}</div>` : `<div class="panel">${emptyState('No agents yet', 'The first agent to call a Cairn tool will appear here, along with its sessions and notes.', `<button class="btn" data-go="home">${icon('i-home')} Back to brief</button>`)}</div>`}
    <section class="panel connect-panel">
      <div class="panel-head">
        <div>
          <h2>Connect over MCP</h2>
          <p class="panel-sub">Every agent reads and writes this vault through one local MCP server. Add this command to a client, or wire one automatically from the terminal.</p>
        </div>
        <span class="chip chip--muted">${icon('i-terminal')} stdio</span>
      </div>
      <button class="connect-cmd" data-copy="${escapeAttr(mcpCommand)}" type="button" title="Copy MCP command">
        <code>${escapeHtml(mcpCommand)}</code>
        <span class="copy-hint">${icon('i-copy')} Copy</span>
      </button>
      <div class="connect-foot">
        <span>Wire it for you:</span>
        <button class="meta-chip" data-copy="cairn connect claude-code" type="button" title="Copy command"><code>cairn connect claude-code</code></button>
        <button class="meta-chip" data-copy="cairn status" type="button" title="Copy command"><code>cairn status</code></button>
        <a class="text-link" href="#/setup">All clients ${icon('i-chevron')}</a>
      </div>
    </section>
  </div>`;
}

async function renderAgentMemory(token, rawName) {
  const name = decodeURIComponent(rawName);
  const [notes, agentsData] = await Promise.all([
    getJSON(`/api/notes${projectQuery({ agent: name, limit: 150, sort: 'updated' })}`),
    getJSON(`/api/agents${projectQuery()}`),
  ]);
  if (token !== state.token) return;
  const agent = (agentsData.agents || []).find((entry) => entry.name === name);
  const hits = notes.hits || [];
  const groups = new Map();
  for (const hit of hits) {
    if (!groups.has(hit.note.kind)) groups.set(hit.note.kind, []);
    groups.get(hit.note.kind).push(hit);
  }
  setCrumb('agent', agent?.label || humanize(name));

  $('#view').innerHTML = `<div class="view-inner">
    <header class="page-head">
      <div>
        <p class="eyebrow eyebrow--accent">Shared memory · agent</p>
        <h1 style="display:flex;align-items:center;gap:12px">${agentAvatar(name)} ${escapeHtml(agent?.label || humanize(name))}</h1>
        <p>${escapeHtml(agent?.online ? 'Active now' : agent?.lastSeen ? `Last seen ${timeAgo(agent.lastSeen)}` : 'No live session')} · ${fmtNumber(agent?.total ?? hits.length)} notes in this vault${agent?.project ? ` · ${escapeHtml(projectLabel(agent.project))}` : ''}</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="capture" data-kind="message" data-to="${escapeAttr(name)}" type="button">${icon('i-message')} Message</button>
        <a class="btn btn--ghost" href="#/agents">${icon('i-arrow-left')} All agents</a>
      </div>
    </header>
    ${agent?.sessionTitle || agent?.goal ? `<div class="panel" style="padding: 15px 18px; margin-bottom: 18px; display:flex; gap:12px; align-items:flex-start;">
      <span class="attention-icon" style="--att: var(--moss); --att-soft: var(--moss-soft)">${icon('i-session')}</span>
      <div><div style="font-size:12px;font-weight:600">${escapeHtml(agent.sessionTitle || 'Current session')}</div><div class="muted small">${escapeHtml(agent.goal || 'No goal recorded')}</div></div>
    </div>` : ''}
    ${hits.length ? [...groups.entries()].map(([kind, items]) => `
      <section class="note-group">
        <div class="note-group-head"><span>${escapeHtml(kindLabel(kind))}</span><span class="note-group-count">${items.length}</span></div>
        <div class="note-list">${items.map((hit) => noteRow(hit)).join('')}</div>
      </section>`).join('') : `<div class="panel">${emptyState('No memories from this agent', 'Once it writes a decision, change, or message, it will collect here.')}</div>`}
  </div>`;
}

/* ---------- Projects ---------- */

async function renderProjects(token) {
  const data = await getJSON('/api/projects');
  if (token !== state.token) return;
  const projects = data.projects || [];
  const activeProjects = projects.filter((project) => project.total);

  $('#view').innerHTML = `<div class="view-inner">
    <header class="page-head">
      <div>
        <p class="eyebrow eyebrow--accent">Shared memory · scope</p>
        <h1>Projects</h1>
        <p>Each project is a branch of the graph. Scope the workspace to one to see only what that work remembers.</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="capture" data-kind="note" type="button">${icon('i-plus')} Capture context</button>
      </div>
    </header>
    ${activeProjects.length ? `<div class="project-grid">${activeProjects.map((project) => {
      const total = project.total || 0;
      const counts = project.counts || {};
      const parts = [
        ['decision', counts.decision || 0],
        ['change', counts.change || 0],
        ['message', (counts.message || 0) + (counts.handoff || 0)],
        ['session', counts.session || 0],
      ].filter(([, count]) => count);
      const color = KIND_CSS_COLORS[(project.name || '').length % KIND_CSS_COLORS.length];
      return `<article class="project-card">
        <div class="project-card-head">
          <span class="project-mark" style="color: var(--k-${color}); background: color-mix(in srgb, var(--k-${color}) 11%, transparent)">${escapeHtml((project.label || project.name || '?').slice(0, 1).toUpperCase())}</span>
          <div style="min-width:0;flex:1">
            <div class="project-name">${escapeHtml(project.label || humanize(project.name))}</div>
            <div class="project-agents">${escapeHtml((project.agents || []).map(humanize).join(', ') || 'No agents yet')}</div>
          </div>
          ${project.name === state.project ? '<span class="chip chip--accent">Scoped</span>' : ''}
        </div>
        <div class="project-metrics">
          <div class="project-metric"><strong>${fmtNumber(total)}</strong><span>Notes</span></div>
          <div class="project-metric"><strong>${fmtNumber(project.openDecisions || 0)}</strong><span>Proposals</span></div>
          <div class="project-metric"><strong>${fmtNumber(project.openQuestions || 0)}</strong><span>Questions</span></div>
          <div class="project-metric"><strong>${fmtNumber(project.files || 0)}</strong><span>Files</span></div>
        </div>
        <div class="project-bars" aria-hidden="true">
          ${parts.map(([kind, count]) => `<span style="width:${Math.max(3, Math.round((count / total) * 100))}%;background:var(--k-${kind})" title="${escapeAttr(kindLabel(kind))}: ${count}"></span>`).join('')}
        </div>
        <div class="project-foot">
          <span>${escapeHtml(project.lastActivity ? `Active ${timeAgo(project.lastActivity)}` : 'No activity')}</span>
          <button class="text-link" data-scope="${escapeAttr(project.name)}" type="button">Scope workspace ${icon('i-chevron')}</button>
        </div>
      </article>`;
    }).join('')}</div>` : `<div class="panel">${emptyState('No projects yet', 'Projects appear automatically when agents write their first note. Scope names come from the repository or session.', `<button class="btn btn--primary" data-action="capture">${icon('i-plus')} Capture a note</button>`)}</div>`}
  </div>`;
}

/* ============================================================
   Inspector
   ============================================================ */

function inspectorIsOpen() {
  const inspector = $('#inspector');
  return inspector?.classList.contains('is-open') || false;
}

function openInspectorShell() {
  const inspector = $('#inspector');
  const scrim = $('#inspector-scrim');
  if (!inspector) return;
  inspector.classList.add('is-open');
  inspector.setAttribute('aria-hidden', 'false');
  scrim?.classList.add('is-visible');
  document.body.classList.add('inspector-open');
}

function closeInspectorDOM() {
  const inspector = $('#inspector');
  const scrim = $('#inspector-scrim');
  if (!inspector) return;
  inspector.classList.remove('is-open');
  inspector.setAttribute('aria-hidden', 'true');
  scrim?.classList.remove('is-visible');
  document.body.classList.remove('inspector-open');
  state.selectedId = null;
}

function closeInspector() {
  closeInspectorDOM();
  if (location.hash.startsWith('#/note/')) {
    const base = state.baseRoute && !state.baseRoute.startsWith('note') ? state.baseRoute : 'home';
    history.replaceState(null, '', `#/${base}`);
  }
}

function selectNote(id, options = {}) {
  if (!id) return;
  const push = options.push !== false;
  if (push) {
    state.baseRoute = state.route;
    const target = `#/note/${encodeURIComponent(id)}`;
    if (location.hash === target) {
      loadInspector(id);
    } else {
      location.hash = target;
    }
    return;
  }
  loadInspector(id);
}

async function loadInspector(id, silent = false) {
  const seq = ++state.inspectorSeq;
  state.selectedId = id;
  openInspectorShell();
  const shell = $('#inspector-inner');
  if (!shell) return;

  if (!silent) {
    shell.innerHTML = `<div class="inspector-top">
      <span class="skeleton" style="width: 92px; height: 20px;"></span>
      <button class="icon-btn" data-action="close-inspector" aria-label="Close inspector">${icon('i-close')}</button>
    </div>
    <div class="inspector-body">
      <div class="skeleton skeleton-line" style="width: 38%; height: 18px;"></div>
      <div class="skeleton" style="width: 86%; height: 30px; margin: 12px 0 8px;"></div>
      <div class="skeleton" style="width: 58%; height: 30px; margin-bottom: 22px;"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line" style="width: 92%"></div>
      <div class="skeleton skeleton-line" style="width: 74%"></div>
      <div class="skeleton" style="height: 160px; margin-top: 22px"></div>
    </div>`;
  }

  try {
    const data = await getJSON(`/api/notes/${encodeURIComponent(id)}`);
    if (seq !== state.inspectorSeq) return;
    renderInspector(data);
  } catch (caught) {
    if (seq !== state.inspectorSeq) return;
    shell.innerHTML = `<div class="inspector-top">
      <span class="chip chip--danger">Unavailable</span>
      <button class="icon-btn" data-action="close-inspector" aria-label="Close inspector">${icon('i-close')}</button>
    </div>
    <div class="inspector-body">${emptyState('Note not found', caught instanceof Error ? caught.message : 'This memory may have been moved or deleted.')}</div>`;
  }
}

function metaRow(label, valueHtml) {
  return `<div class="meta-row"><span class="meta-label">${escapeHtml(label)}</span><span class="meta-value">${valueHtml}</span></div>`;
}

function renderInspector(data) {
  const note = data.note;
  const shell = $('#inspector-inner');
  if (!shell || !note) return;
  const actions = [];
  const statusOptions = STATUS_OPTIONS[note.kind] || [note.status];

  if (note.kind === 'decision' && note.status === 'proposed') {
    actions.push(`<button class="btn btn--sm" data-note-status="accepted">${icon('i-check')} Accept</button>`);
    actions.push(`<button class="btn btn--sm btn--danger" data-note-status="rejected">${icon('i-close')} Reject</button>`);
  }
  if (note.status === 'unread') {
    actions.push(`<button class="btn btn--sm" data-note-status="read">${icon('i-check')} Mark read</button>`);
  }
  if (note.kind === 'handoff' && note.status !== 'done') {
    actions.push(`<button class="btn btn--sm" data-note-status="done">${icon('i-check')} Mark done</button>`);
  }
  if (note.status === 'open' && note.kind !== 'question' && note.kind !== 'risk') {
    actions.push(`<button class="btn btn--sm" data-note-status="done">${icon('i-check')} Resolve</button>`);
  }

  const project = note.project
    ? `<button class="meta-chip" data-scope="${escapeAttr(note.project)}" type="button">${icon('i-project')} ${escapeHtml(projectLabel(note.project))}</button>`
    : '<span class="muted small">Unscoped</span>';
  const agent = note.agent
    ? `<a class="meta-chip" href="#/agent/${encodeURIComponent(note.agent)}">${agentAvatar(note.agent)} ${escapeHtml(humanize(note.agent))}</a>`
    : '<span class="muted small">Unknown</span>';
  const session = data.sessionNote
    ? `<button class="meta-chip" data-note="${escapeAttr(data.sessionNote.id)}" type="button">${icon('i-session')} ${escapeHtml(data.sessionNote.title)}</button>`
    : '';

  const tags = note.tags?.length
    ? note.tags.map((tag) => `<span class="meta-chip">#${escapeHtml(tag)}</span>`).join('')
    : '<span class="muted small">None</span>';
  const recipients = note.to?.length
    ? note.to.map((name) => `<a class="meta-chip" href="#/agent/${encodeURIComponent(name)}">${agentAvatar(name)} ${escapeHtml(humanize(name))}</a>`).join('')
    : '';
  const files = note.files?.length
    ? note.files.map((file) => `<button class="meta-chip" data-copy="${escapeAttr(file)}" type="button" title="Copy path">${icon('i-file')} <code>${escapeHtml(file)}</code></button>`).join('')
    : '';
  const metadataEntries = note.kind === 'session'
    ? Object.entries(note.metadata || {}).filter(([key, value]) => !['dedupe_key'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 10)
    : [];

  const outgoingGroups = groupConnections(data.outgoing || []);
  const backlinkGroups = groupConnections(data.backlinks || []);
  const connectedIds = new Set(
    [...(data.outgoing || []), ...(data.backlinks || [])]
      .map((neighbor) => neighbor.node?.noteId || neighbor.node?.id)
      .filter(Boolean),
  );
  const related = (data.related || []).filter((entry) => !connectedIds.has(entry.noteId || entry.id));

  const connectionGroupHtml = (groups, emptyLabel) => {
    const entries = [...groups.entries()];
    if (!entries.length) return '';
    return entries.map(([type, nodes]) => `<div class="connection-group">
      <div class="connection-label">${escapeHtml(humanize(type))} · ${nodes.length}</div>
      ${nodes.map((node) => connectionHtml(node, type)).join('')}
    </div>`).join('');
  };

  const hasConnections = outgoingGroups.size || backlinkGroups.size || related.length;
  const body = note.body?.trim()
    ? renderMarkdown(note.body)
    : '<p class="muted">No body was recorded. The title and links still carry memory.</p>';

  shell.innerHTML = `<div class="inspector-top">
    ${kindPill(note.kind)}
    ${statusPill(note.status)}
    <button class="icon-btn" data-copy="${escapeAttr(`[[${note.title}]]`)}" title="Copy wikilink" aria-label="Copy wikilink">${icon('i-copy')}</button>
    <button class="icon-btn" data-action="close-inspector" aria-label="Close inspector">${icon('i-close')}</button>
  </div>
  <div class="inspector-body">
    <h2 class="inspector-title">${escapeHtml(note.title)}</h2>

    <div class="inspector-meta">
      ${metaRow('Project', project)}
      ${metaRow('Agent', agent)}
      ${session ? metaRow('Session', session) : ''}
      ${recipients ? metaRow(note.kind === 'handoff' ? 'Handoff to' : 'To', recipients) : ''}
      ${metaRow('Created', `<span class="small">${escapeHtml(fmtDateTime(note.created))}</span>`)}
      ${metaRow('Updated', `<span class="small">${escapeHtml(fmtDateTime(note.updated))}</span>`)}
      ${metaRow('Tags', tags)}
      ${files ? metaRow('Files', files) : ''}
      ${metaRow('Note', `<span class="small mono" style="font-size:9.5px;color:var(--ink-3)">${escapeHtml(note.path)}</span>`)}
      ${metadataEntries.length ? metadataEntries.map(([key, value]) => metaRow(humanize(key), `<span class="small">${escapeHtml(String(value))}</span>`)).join('') : ''}
    </div>

    <div class="inspector-actions">
      ${actions.join('')}
      <select class="filter-select" id="inspector-status" aria-label="Change status" style="height: 30px; margin-left: auto;">
        ${statusOptions.map((status) => `<option value="${escapeAttr(status)}"${status === note.status ? ' selected' : ''}>${escapeHtml(statusLabel(status))}</option>`).join('')}
      </select>
    </div>

    <section class="inspector-section">
      <h3>Memory</h3>
      <div class="prose">${body}</div>
    </section>

    ${hasConnections ? `<section class="inspector-section">
      <h3>Connections</h3>
      ${connectionGroupHtml(outgoingGroups)}
      ${backlinkGroups.size ? `<div class="connection-label" style="margin-top:8px">Linked from</div>${connectionGroupHtml(backlinkGroups)}` : ''}
      ${related.length ? `<div class="connection-label" style="margin-top:8px">Related</div>${related.map((entry) => connectionHtml(entry, entry.linkTypes?.join(', ') || 'related', entry.direction)).join('')}` : ''}
    </section>` : ''}

    <section class="inspector-section">
      <h3>Source</h3>
      <div class="meta-row">
        <span class="meta-label">File</span>
        <span class="meta-value"><button class="meta-chip" data-copy="${escapeAttr(data.filePath || '')}" title="Copy the absolute path">${icon('i-file')} <code>${escapeHtml(note.path)}</code></button></span>
      </div>
    </section>
  </div>`;

  const select = $('#inspector-status');
  select?.addEventListener('change', (event) => {
    updateNoteStatus(note.id, event.target.value);
  });
}

function groupConnections(neighbors) {
  const groups = new Map();
  for (const neighbor of neighbors || []) {
    const type = neighbor.edge?.type || 'linked';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(neighbor.node);
  }
  return groups;
}

function connectionHtml(node, type, direction) {
  const kind = node.kind || 'note';
  if (node.noteId) {
    return `<button class="connection" data-note="${escapeAttr(node.noteId)}" type="button" title="${escapeAttr(node.label || '')}">
      <span class="kind-dot-small" style="--kind: var(--k-${escapeAttr(kind)})"></span>
      <span class="connection-text">${escapeHtml(node.label || 'Untitled')}</span>
      ${type ? `<span class="connection-type">${escapeHtml(humanize(type))}</span>` : ''}
      ${direction ? `<span class="connection-type">${escapeHtml(direction)}</span>` : ''}
      ${icon('i-chevron')}
    </button>`;
  }
  if (node.kind === 'file' && node.path) {
    return `<button class="connection" data-search-file="${escapeAttr(node.path)}" type="button" title="${escapeAttr(node.path)}">
      <span class="kind-dot-small" style="--kind: var(--k-file)"></span>
      <span class="connection-text">${escapeHtml(node.label || node.path)}</span>
      <span class="connection-type">${escapeHtml(humanize(type))}</span>
      ${icon('i-search')}
    </button>`;
  }
  return `<span class="connection" title="${escapeAttr(node.label || '')}">
    <span class="kind-dot-small" style="--kind: var(--k-${escapeAttr(kind)})"></span>
    <span class="connection-text">${escapeHtml(node.label || 'Untitled')}</span>
    <span class="connection-type">${escapeHtml(humanize(type))}</span>
  </span>`;
}

async function updateNoteStatus(id, status) {
  try {
    await api(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    toast(`Moved to ${statusLabel(status)}`);
    invalidateOverview();
    await loadOverview(true).catch(() => {});
    if (state.selectedId === id) await loadInspector(id, true);
    const row = $(`#view [data-note="${cssEscape(id)}"]`);
    const pill = row?.querySelector('.status-pill');
    if (pill) {
      pill.dataset.status = status;
      pill.textContent = statusLabel(status);
    }
  } catch (caught) {
    toast(caught instanceof Error ? caught.message : 'Could not update the note', 'error');
  }
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/* ============================================================
   Markdown
   ============================================================ */

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  const codes = [];
  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, label) => {
    const clean = decodeEntities(String(target).trim());
    return `<a class="wikilink" href="#/note/${encodeURIComponent(clean)}" data-wikilink="${escapeAttr(clean)}">${label ? label : target}</a>`;
  });
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+|#[^)\s]+)\)/g, (_match, label, url) => (
    `<a href="${escapeAttr(decodeEntities(url))}"${/^https?:/.test(url) ? ' target="_blank" rel="noreferrer noopener"' : ''}>${label}</a>`
  ));
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${codes[Number(index)] ?? ''}</code>`);
  return html;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let listType = null;
  let quote = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map((line) => inlineMarkdown(line)).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.map((line) => inlineMarkdown(line)).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (inCode) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code${codeLang ? ` class="language-${escapeAttr(codeLang)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLang = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w#+.-]*)\s*$/);
    if (fence) {
      flushAll();
      inCode = true;
      codeLang = fence[1] || '';
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }
    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }
    const listMatch = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      const type = /\d+\./.test(listMatch[1]) ? 'ol' : 'ul';
      if (listType && listType !== type) flushList();
      if (!listType) {
        listType = type;
        out.push(`<${type}>`);
      }
      let content = listMatch[2];
      content = content.replace(/^\[([ xX])\]\s+/, (_match, checked) => (
        `${checked.toLowerCase() === 'x' ? '☑' : '☐'} `
      ));
      out.push(`<li>${inlineMarkdown(content)}</li>`);
      continue;
    }
    if (listType) flushList();
    if (quote.length) flushQuote();
    paragraph.push(line);
  }
  flushAll();
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}

/* ============================================================
   Command palette
   ============================================================ */

const PALETTE_COMMANDS = [
  { group: 'Navigate', label: 'Brief', sub: 'Vault overview, decisions, and activity', icon: 'i-home', route: 'home' },
  { group: 'Navigate', label: 'Memory graph', sub: 'Explore the connection map', icon: 'i-graph', route: 'graph' },
  { group: 'Navigate', label: 'Timeline', sub: 'Everything, in order', icon: 'i-clock', route: 'timeline' },
  { group: 'Navigate', label: 'Decisions', sub: 'Accepted and proposed calls', icon: 'i-decision', route: 'decisions' },
  { group: 'Navigate', label: 'Changes', sub: 'What moved in the codebase', icon: 'i-change', route: 'changes' },
  { group: 'Navigate', label: 'Open questions', sub: 'Unresolved threads', icon: 'i-question', route: 'questions' },
  { group: 'Navigate', label: 'Risks', sub: 'Known hazards and mitigations', icon: 'i-risk', route: 'risks' },
  { group: 'Navigate', label: 'Messages', sub: 'Agent-to-agent inbox', icon: 'i-message', route: 'messages' },
  { group: 'Navigate', label: 'Handoffs', sub: 'Work passed between agents', icon: 'i-handoff', route: 'handoffs' },
  { group: 'Navigate', label: 'Agents', sub: 'Who is writing to this vault', icon: 'i-agents', route: 'agents' },
  { group: 'Navigate', label: 'Projects', sub: 'Scope the workspace', icon: 'i-project', route: 'projects' },
  { group: 'Actions', label: 'Capture memory', sub: 'Write a decision, change, or note', icon: 'i-plus', action: 'capture' },
  { group: 'Actions', label: 'Toggle appearance', sub: 'Switch between light and dark', icon: 'i-moon', action: 'theme' },
];

function openPalette(prefill = '') {
  const overlay = $('#palette');
  if (!overlay) return;
  overlayPreviousFocus = document.activeElement;
  overlay.hidden = false;
  syncOverlayInert();
  state.palette.open = true;
  state.palette.query = prefill;
  state.palette.notes = [];
  state.palette.active = 0;
  document.body.classList.add('modal-open');
  const input = $('#palette-input');
  if (input) {
    input.value = prefill;
    input.focus();
    input.select();
  }
  renderPalette();
  if (prefill) searchPalette(prefill);
}

function closePalette() {
  const overlay = $('#palette');
  if (!overlay) return;
  overlay.hidden = true;
  syncOverlayInert();
  state.palette.open = false;
  state.palette.query = '';
  state.palette.notes = [];
  state.palette.active = 0;
  document.body.classList.remove('modal-open');
  restoreOverlayFocus();
}

async function searchPalette(query) {
  if (!query.trim()) {
    state.palette.notes = [];
    renderPalette();
    return;
  }
  const seq = ++state.palette.seq;
  state.palette.searching = true;
  try {
    const params = new URLSearchParams({ q: query.trim(), limit: '14', sort: 'relevance' });
    if (state.project) params.set('project', state.project);
    const data = await getJSON(`/api/notes?${params.toString()}`);
    if (seq !== state.palette.seq) return;
    state.palette.notes = data.hits || [];
  } catch {
    if (seq !== state.palette.seq) return;
    state.palette.notes = [];
  } finally {
    if (seq === state.palette.seq) {
      state.palette.searching = false;
      state.palette.active = 0;
      renderPalette();
    }
  }
}

function renderPalette() {
  const container = $('#palette-results');
  if (!container) return;
  const query = state.palette.query.trim().toLowerCase();
  const commands = PALETTE_COMMANDS.filter((command) => (
    !query || command.label.toLowerCase().includes(query) || command.sub.toLowerCase().includes(query)
  ));
  const notes = state.palette.notes;
  const items = [];

  let html = '';
  if (commands.length) {
    html += `<div class="palette-section-label">Commands</div>`;
    for (const command of commands) {
      items.push({ type: 'command', command });
    }
  }
  if (query && notes.length) {
    html += `<div class="palette-section-label">Notes</div>`;
    for (const hit of notes) {
      items.push({ type: 'note', hit });
    }
  }

  html = `<div class="palette-section-label">${query ? 'Commands' : 'Jump to'}</div>` + commands.map((command, index) => {
    return `<button class="palette-item${items[index] && state.palette.active === index ? ' is-active' : ''}" data-palette-index="${index}" type="button">
      ${icon(command.icon)}
      <span class="palette-item-main"><span class="palette-item-title">${escapeHtml(command.label)}</span><span class="palette-item-sub">${escapeHtml(command.sub)}</span></span>
    </button>`;
  }).join('');

  if (query && notes.length) {
    html += `<div class="palette-section-label">Notes</div>` + notes.map((hit, noteIndex) => {
      const index = commands.length + noteIndex;
      const note = hit.note;
      return `<button class="palette-item${state.palette.active === index ? ' is-active' : ''}" data-palette-index="${index}" type="button">
        <span class="palette-item-kind kind-${escapeAttr(note.kind)}">${escapeHtml(kindLabel(note.kind))}</span>
        <span class="palette-item-main"><span class="palette-item-title">${escapeHtml(note.title)}</span><span class="palette-item-sub">${escapeHtml(note.agent ? humanize(note.agent) + ' · ' : '')}${escapeHtml(hit.snippet || note.snippet || '')}</span></span>
        <span class="muted" style="font-size:9.5px">${timeAgo(note.updated)}</span>
      </button>`;
    }).join('');
  } else if (query && state.palette.searching) {
    html += `<div class="palette-empty"><span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:7px"></span>Searching the vault…</div>`;
  } else if (query && !commands.length) {
    html += `<div class="palette-empty">No memories or commands match “${escapeHtml(state.palette.query)}”.</div>`;
  } else if (query) {
    html += `<div class="palette-empty">Press Enter to search every note for “${escapeHtml(state.palette.query)}”.</div>`;
  }

  container.innerHTML = html;
  state.palette.items = items;
  state.palette.commands = commands;
}

function activatePaletteIndex(index) {
  const commands = state.palette.commands || [];
  if (index < commands.length) {
    const command = commands[index];
    closePalette();
    if (command.route) go(command.route);
    else if (command.action === 'capture') openCapture();
    else if (command.action === 'theme') toggleTheme();
    return;
  }
  const noteIndex = index - commands.length;
  const hit = state.palette.notes[noteIndex];
  if (hit?.note?.id) {
    closePalette();
    selectNote(hit.note.id);
  }
}

function paletteKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closePalette();
    return;
  }
  const total = (state.palette.commands?.length || 0) + state.palette.notes.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!total) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    state.palette.active = (state.palette.active + delta + total) % total;
    renderPalette();
    const active = $(`[data-palette-index="${state.palette.active}"]`);
    active?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (total) {
      activatePaletteIndex(state.palette.active);
    } else if (state.palette.query.trim()) {
      const query = state.palette.query.trim();
      closePalette();
      go(`search?q=${encodeURIComponent(query)}`);
    }
  }
}

/* ============================================================
   Capture dialog
   ============================================================ */

function populateCaptureStatus(kind, selected) {
  const select = $('#capture-status');
  if (!select) return;
  const options = STATUS_OPTIONS[kind] || ['active'];
  select.innerHTML = options.map((status) => `<option value="${escapeAttr(status)}"${status === selected ? ' selected' : ''}>${escapeHtml(statusLabel(status))}</option>`).join('');
}

function openCapture(options = {}) {
  const overlay = $('#capture');
  const form = $('#capture-form');
  if (!overlay || !form) return;
  form.reset();
  clearCaptureError();
  const titleInput = $('#capture-note-title');
  if (titleInput && !titleInput.dataset.errorBound) {
    titleInput.dataset.errorBound = '1';
    titleInput.addEventListener('input', clearCaptureError);
  }
  const kind = options.kind || 'note';
  const select = $('#capture-kind');
  if (select) {
    if (!Array.from(select.options).some((option) => option.value === kind)) select.value = 'note';
    else select.value = kind;
  }
  populateCaptureStatus(select?.value || 'note');
  const projectInput = $('#capture-project');
  const agentInput = $('#capture-agent');
  if (projectInput) projectInput.value = state.project || state.boot?.defaultProject || '';
  if (agentInput) agentInput.value = state.boot?.defaultAgent || 'human';
  const toField = $('#capture-to-field');
  const toInput = $('#capture-to');
  const isMessage = kind === 'message' || kind === 'handoff';
  if (toField) toField.hidden = !isMessage;
  if (toInput && isMessage) toInput.value = options.to || '';
  overlayPreviousFocus = document.activeElement;
  overlay.hidden = false;
  syncOverlayInert();
  state.captureOpen = true;
  document.body.classList.add('modal-open');
  setTimeout(() => $('#capture-note-title')?.focus(), 40);
}

function closeCapture() {
  const overlay = $('#capture');
  if (!overlay) return;
  overlay.hidden = true;
  syncOverlayInert();
  state.captureOpen = false;
  document.body.classList.remove('modal-open');
  restoreOverlayFocus();
}

function bindReveal(button, input) {
  if (!button || !input) return;
  if (button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.setAttribute('aria-pressed', showing ? 'false' : 'true');
    button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    input.focus();
  });
}

function openChangePassword() {
  const overlay = $('#change-password');
  const form = $('#change-password-form');
  if (!overlay || !form) return;
  if (!overlay.contains(document.activeElement)) {
    state.changePasswordPreviousFocus = document.activeElement;
  }
  form.reset();
  form.querySelectorAll('.password-field input').forEach((input) => {
    input.type = 'password';
  });
  form.querySelectorAll('.reveal').forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Show password');
  });
  const submit = form.querySelector('button[type="submit"]');
  if (submit) {
    if (!submit.dataset.original) submit.dataset.original = submit.innerHTML;
    submit.disabled = false;
    submit.innerHTML = submit.dataset.original;
  }
  const errorEl = $('#cp-error');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
  overlay.hidden = false;
  syncOverlayInert();
  state.changePasswordOpen = true;
  document.body.classList.add('modal-open');
  setTimeout(() => $('#cp-current')?.focus(), 40);
  bindReveal($('#cp-current')?.parentElement?.querySelector('.reveal'), $('#cp-current'));
  bindReveal($('#cp-new')?.parentElement?.querySelector('.reveal'), $('#cp-new'));
  bindReveal($('#cp-confirm')?.parentElement?.querySelector('.reveal'), $('#cp-confirm'));
}

function closeChangePassword() {
  const overlay = $('#change-password');
  if (!overlay) return;
  overlay.hidden = true;
  syncOverlayInert();
  state.changePasswordOpen = false;
  document.body.classList.remove('modal-open');
  const form = $('#change-password-form');
  if (form) {
    form.querySelectorAll('.password-field input').forEach((input) => {
      input.type = 'password';
    });
    form.querySelectorAll('.reveal').forEach((button) => {
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', 'Show password');
    });
  }
  const previous = state.changePasswordPreviousFocus;
  state.changePasswordPreviousFocus = null;
  if (previous && typeof previous.focus === 'function') {
    try {
      previous.focus();
    } catch {
      // Element might be detached
    }
  }
}

async function submitChangePassword(event) {
  event.preventDefault();
  const form = $('#change-password-form');
  if (!form) return;
  const submit = form.querySelector('button[type="submit"]');
  const errorEl = $('#cp-error');
  const current = $('#cp-current').value;
  const next = $('#cp-new').value;
  const confirm = $('#cp-confirm').value;
  if (!current || !next || !confirm) {
    errorEl.textContent = 'All fields are required.';
    errorEl.hidden = false;
    return;
  }
  if (next !== confirm) {
    errorEl.textContent = 'New passwords do not match.';
    errorEl.hidden = false;
    return;
  }
  if (next.length < 12) {
    errorEl.textContent = 'The new password must be at least 12 characters.';
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;
  if (submit) {
    submit.disabled = true;
    submit.dataset.original = submit.innerHTML;
    submit.innerHTML = '<span class="spinner"></span><span>Changing…</span>';
  }
  try {
    const result = await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    });
    // setPassword() rotates the session secret, so the server issued a new
    // CSRF token (and a new session cookie). Keep state.csrf in sync or the
    // next POST is rejected as bad_csrf.
    if (result?.csrfToken) state.csrf = result.csrfToken;
    closeChangePassword();
    toast('Password changed. All other sessions have been signed out.');
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Could not change password.';
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = submit.dataset.original || 'Change password';
    }
  }
}

function splitList(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function showCaptureError(message) {
  const errorEl = $('#capture-error');
  const title = $('#capture-note-title');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
  title?.setAttribute('aria-invalid', 'true');
  title?.focus();
}

function clearCaptureError() {
  const errorEl = $('#capture-error');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
  $('#capture-note-title')?.removeAttribute('aria-invalid');
}

async function submitCapture(event) {
  event.preventDefault();
  const form = $('#capture-form');
  if (!form) return;
  const submit = form.querySelector('button[type="submit"]');
  if (submit?.disabled) return;
  const data = new FormData(form);
  const kind = String(data.get('kind') || 'note');
  const title = String(data.get('title') || '').trim();
  if (!title) {
    showCaptureError('A title is required for every memory.');
    return;
  }
  const payload = {
    kind,
    title,
    body: String(data.get('body') || ''),
    status: String(data.get('status') || ''),
    project: String(data.get('project') || '').trim(),
    agent: String(data.get('agent') || '').trim() || 'human',
    tags: splitList(data.get('tags')),
    files: splitList(data.get('files')),
  };
  if (kind === 'message' || kind === 'handoff') {
    payload.to = splitList(data.get('to'));
  }
  if (submit) {
    submit.disabled = true;
    submit.dataset.original = submit.innerHTML;
    submit.innerHTML = '<span class="spinner"></span><span>Saving…</span>';
  }
  try {
    const result = await api('/api/notes', { method: 'POST', body: JSON.stringify(payload) });
    closeCapture();
    toast(result.created === false ? 'That memory already existed.' : 'Memory captured.');
    invalidateOverview();
    await renderRoute(true);
    await loadOverview(true).catch(() => {});
    if (result.note?.id) selectNote(result.note.id);
  } catch (caught) {
    showCaptureError(caught instanceof Error ? caught.message : 'Could not save the note');
  } finally {
    if (submit) {
      submit.disabled = false;
      if (submit.dataset.original) submit.innerHTML = submit.dataset.original;
    }
  }
}

/* ============================================================
   Graph view
   ============================================================ */

const GRAPH_KIND_OPTIONS = [
  ['all', 'All kinds'],
  ['decision', 'Decisions'],
  ['change', 'Changes'],
  ['insight', 'Insights'],
  ['question', 'Questions'],
  ['answer', 'Answers'],
  ['spec', 'Specs'],
  ['risk', 'Risks'],
  ['task', 'Tasks'],
  ['message', 'Messages'],
  ['handoff', 'Handoffs'],
  ['session', 'Sessions'],
  ['note', 'Notes'],
];

function graphUrl() {
  const params = new URLSearchParams();
  if (state.project) params.set('project', state.project);
  if (state.graph.kind !== 'all') params.set('kinds', state.graph.kind);
  if (state.graph.files) params.set('include_files', '1');
  if (state.graph.hubs) params.set('include_hubs', '1');
  params.set('limit', '480');
  return `/api/graph?${params.toString()}`;
}

async function renderGraph(token) {
  const view = $('#view');
  view.innerHTML = `<div class="graph-shell">
    <div class="graph-toolbar">
      <label class="search-field">
        ${icon('i-search')}
        <input id="graph-search" type="search" placeholder="Find a node…" value="${escapeAttr(state.graph.search)}" autocomplete="off" spellcheck="false" aria-label="Find a node">
      </label>
      <select class="filter-select" id="graph-kind" aria-label="Filter graph by kind">
        ${GRAPH_KIND_OPTIONS.map(([value, label]) => `<option value="${value}"${state.graph.kind === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
      <span class="graph-toolbar-sep"></span>
      <button class="icon-btn${state.graph.files ? ' is-on' : ''}" data-graph-toggle="files" title="Show file nodes" aria-label="Show file nodes" aria-pressed="${state.graph.files}">${icon('i-file')}</button>
      <button class="icon-btn${state.graph.hubs ? ' is-on' : ''}" data-graph-toggle="hubs" title="Show agents, projects, sessions" aria-label="Show hub nodes" aria-pressed="${state.graph.hubs}">${icon('i-agents')}</button>
      <span class="graph-toolbar-sep"></span>
      <div class="graph-toolbar-group">
        <button class="icon-btn" data-graph-zoom="out" title="Zoom out" aria-label="Zoom out">${icon('i-zoom-out')}</button>
        <button class="icon-btn" data-graph-zoom="in" title="Zoom in" aria-label="Zoom in">${icon('i-zoom-in')}</button>
        <button class="icon-btn" data-graph-zoom="fit" title="Fit to view" aria-label="Fit to view">${icon('i-fit')}</button>
      </div>
      <span class="muted small" id="graph-match" style="margin-left:auto"></span>
    </div>
    <div class="graph-stage" id="graph-stage">
      <canvas id="graph-canvas" aria-label="Memory graph"></canvas>
      <div class="graph-loading" id="graph-loading"><span class="spinner"></span> Reading the graph…</div>
      <div class="graph-legend" id="graph-legend" hidden></div>
      <div class="graph-hud" id="graph-hud"></div>
      <div class="graph-hint">Drag to pan · scroll to zoom · drag a node to rearrange</div>
    </div>
  </div>`;

  let engine = null;
  const canvas = $('#graph-canvas');
  const searchInput = $('#graph-search');

  const updateHud = () => {
    const hud = $('#graph-hud');
    const match = $('#graph-match');
    if (!engine) return;
    const stats = engine.visibleStats();
    if (hud) {
      hud.innerHTML = `<div class="graph-hud-panel">
        <span><strong>${fmtNumber(stats.nodes)}</strong> nodes</span>
        <span><strong>${fmtNumber(stats.edges)}</strong> links</span>
        <span><strong>${Math.round(engine.scale * 100)}%</strong></span>
      </div>`;
    }
    if (match) {
      if (engine.search) match.textContent = `${fmtNumber(engine.matchCount())} matching`;
      else match.textContent = state.graph.hidden.size ? `${fmtNumber(state.graph.hidden.size)} kind${state.graph.hidden.size === 1 ? '' : 's'} hidden` : '';
    }
  };

  const renderLegend = () => {
    if (!engine) return;
    const legend = $('#graph-legend');
    if (!legend) return;
    const counts = new Map();
    for (const node of engine.nodes) counts.set(node.kind, (counts.get(node.kind) || 0) + 1);
    const kinds = GRAPH_KINDS.filter((kind) => counts.get(kind));
    if (!kinds.length) {
      legend.hidden = true;
      return;
    }
    legend.hidden = false;
    legend.innerHTML = kinds.map((kind) => `<button class="legend-item${state.graph.hidden.has(kind) ? ' is-off' : ''}" data-legend-kind="${escapeAttr(kind)}" type="button" title="Toggle ${escapeAttr(kindLabel(kind))} nodes">
      <span class="legend-swatch" style="--sw: var(--k-${escapeAttr(kind)})"></span>${escapeHtml(kindLabel(kind))} <span style="opacity:.6">${counts.get(kind)}</span>
    </button>`).join('');
  };

  const applyData = (data, preserve = false) => {
    const stage = $('#graph-stage');
    if (!canvas || !stage) return;
    if (!data.nodes?.length) {
      $('#graph-loading')?.remove();
      if (!stage.querySelector('.graph-empty')) {
        const empty = document.createElement('div');
        empty.className = 'graph-empty panel';
        empty.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;max-width:380px;width:calc(100% - 48px)';
        empty.innerHTML = emptyState('Nothing in this slice', 'No notes match the current project and kind filters. Widen the scope or capture a note.', `<button class="btn btn--primary" data-action="capture">${icon('i-plus')} Capture memory</button>`);
        stage.appendChild(empty);
      }
      return;
    }
    if (engine) {
      if (preserve) engine.updateData(data);
      else engine.setData(data);
    } else {
      engine = new ForceGraph(canvas, {
        data,
        onSelect: handleGraphNode,
        onViewChange: updateHud,
      });
      state.activeGraph = engine;
      state.graphs.add(engine);
      if (state.graph.search) engine.setSearch(state.graph.search);
      if (state.graph.hidden.size) engine.setHidden(state.graph.hidden);
    }
    renderLegend();
    updateHud();
    engine.start();
  };

  try {
    const data = await getJSON(graphUrl());
    if (token !== state.token) return;
    $('#graph-loading')?.remove();
    applyData(data);
  } catch (caught) {
    if (token !== state.token) return;
    $('#graph-loading')?.remove();
    const stage = $('#graph-stage');
    if (stage) {
      const box = document.createElement('div');
      box.className = 'panel';
      box.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;max-width:380px;width:calc(100% - 48px)';
      box.innerHTML = emptyState('Could not draw the graph', caught instanceof Error ? caught.message : 'Unexpected error');
      stage.appendChild(box);
    }
    return;
  }

  searchInput?.addEventListener('input', () => {
    state.graph.search = searchInput.value;
    engine?.setSearch(state.graph.search);
    updateHud();
  });
  $('#graph-kind')?.addEventListener('change', (event) => {
    state.graph.kind = event.target.value;
    renderRoute(true);
  });
  for (const button of $$('[data-graph-toggle]')) {
    button.addEventListener('click', () => {
      const key = button.dataset.graphToggle;
      if (key === 'files') state.graph.files = !state.graph.files;
      if (key === 'hubs') state.graph.hubs = !state.graph.hubs;
      renderRoute(true);
    });
  }
  for (const button of $$('[data-graph-zoom]')) {
    button.addEventListener('click', () => {
      if (!engine) return;
      if (button.dataset.graphZoom === 'in') engine.zoomBy(1.28);
      else if (button.dataset.graphZoom === 'out') engine.zoomBy(1 / 1.28);
      else engine.fit();
      updateHud();
    });
  }
  $('#graph-legend')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-legend-kind]');
    if (!button || !engine) return;
    const kind = button.dataset.legendKind;
    if (state.graph.hidden.has(kind)) state.graph.hidden.delete(kind);
    else state.graph.hidden.add(kind);
    engine.setHidden(state.graph.hidden);
    button.classList.toggle('is-off', state.graph.hidden.has(kind));
    updateHud();
  });
}

function handleGraphNode(node) {
  if (!node) return;
  if (node.noteId) {
    selectNote(node.noteId);
    return;
  }
  if (node.kind === 'project') {
    const name = node.project || String(node.id || '').replace(/^project:/, '');
    if (name) {
      setProject(name);
      toast(`Scoped to ${projectLabel(name)}`);
    }
    return;
  }
  if (node.kind === 'agent') {
    const name = node.agent || String(node.id || '').replace(/^agent:/, '');
    if (name) go(`agent/${encodeURIComponent(name)}`);
    return;
  }
  if (node.kind === 'file') {
    go(`search?q=${encodeURIComponent(node.path || node.label || '')}`);
    return;
  }
  toast(`${kindLabel(node.kind)} · ${node.label || 'node'}`);
}

/* ============================================================
   Force graph renderer
   ============================================================ */

class ForceGraph {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.preview = Boolean(options.preview);
    this.onSelect = options.onSelect || null;
    this.onViewChange = options.onViewChange || null;
    this.abort = new AbortController();
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.alpha = 1;
    this.raf = null;
    this.dirty = true;
    this.running = false;
    this.destroyed = false;
    this.ticks = 0;
    this.pendingFit = true;
    this.userAdjusted = false;
    this.hover = null;
    this.focus = null;
    this.drag = null;
    this.pan = null;
    this.pointerStart = null;
    this.hiddenKinds = new Set(options.hiddenKinds || []);
    this.search = '';
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.tooltip = null;
    this.loop = this.loop.bind(this);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this.bindEvents();
    this.resize();
    this.setData(options.data || { nodes: [], edges: [] });
  }

  setData(data) {
    this.data = data;
    const nodes = (data.nodes || []).filter((node) => node && node.id);
    const known = new Set(nodes.map((node) => node.id));
    const rawEdges = (data.edges || []).filter((edge) => known.has(edge.from) && known.has(edge.to));
    const count = Math.max(1, nodes.length);
    const spread = Math.min(this.width || 640, this.height || 420) * (this.preview ? 0.36 : 0.42);

    this.nodes = nodes.map((raw, index) => {
      const angle = index * 2.399963229728653;
      const radius = Math.sqrt((index + 0.5) / count) * spread;
      const virtual = ['file', 'project', 'agent', 'session', 'missing', 'tag'].includes(raw.kind);
      const base = this.preview
        ? (virtual ? 2.4 : 3.2 + Math.min(raw.degree || 0, 10) * 0.26)
        : (virtual ? 4.2 : 5.4 + Math.min(raw.degree || 0, 12) * 0.86);
      return {
        ...raw,
        x: Math.cos(angle) * radius + (Math.random() - 0.5) * 3,
        y: Math.sin(angle) * radius + (Math.random() - 0.5) * 3,
        vx: 0,
        vy: 0,
        fx: 0,
        fy: 0,
        r: base,
      };
    });
    this.byId = new Map(this.nodes.map((node) => [node.id, node]));
    this.edges = rawEdges.map((edge) => ({
      ...edge,
      source: this.byId.get(edge.from),
      target: this.byId.get(edge.to),
    })).filter((edge) => edge.source && edge.target);

    this.hover = null;
    this.focus = null;
    this.ticks = 0;
    this.alpha = 1;
    this.pendingFit = true;
    this.dirty = true;
    if (this.nodes.length) this.fit();
  }

  updateData(data) {
    const positions = new Map(this.nodes.map((node) => [node.id, node]));
    this.setData(data);
    for (const node of this.nodes) {
      const previous = positions.get(node.id);
      if (previous) {
        node.x = previous.x;
        node.y = previous.y;
        node.vx = previous.vx * 0.3;
        node.vy = previous.vy * 0.3;
      }
    }
    this.alpha = Math.max(this.alpha, 0.32);
    this.dirty = true;
    this.schedule();
  }

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    if (this.nodes.length && (this.preview || !this.userAdjusted)) this.fit();
    this.dirty = true;
    if (!this.running) {
      this.schedule();
    }
  }

  start() {
    this.alpha = Math.max(this.alpha, 0.85);
    this.schedule();
  }

  wake(strength = 0.38) {
    this.alpha = Math.max(this.alpha, strength);
    this.dirty = true;
    this.schedule();
  }

  schedule() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
  }

  loop() {
    this.raf = null;
    if (this.destroyed) return;
    const active = this.alpha > 0.018;
    if (active) {
      this.tick();
      this.ticks += 1;
      if (this.pendingFit && this.ticks > 55) {
        this.pendingFit = false;
        this.fit();
      }
    }
    if (active || this.dirty) {
      this.draw();
      this.dirty = false;
    }
    if (active) this.schedule();
  }

  tick() {
    const nodes = this.nodes;
    const count = nodes.length;
    if (!count) return;
    const charge = this.preview ? 1600 : 2600;
    const maxDist2 = 190_000;
    const alpha = this.alpha;

    for (const node of nodes) {
      node.fx = 0;
      node.fy = 0;
    }
    for (let i = 0; i < count; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < count; j += 1) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 > maxDist2) continue;
        if (dist2 < 36) dist2 = 36;
        const inv = 1 / Math.sqrt(dist2);
        const force = (charge / dist2) * alpha;
        const fx = dx * inv * force;
        const fy = dy * inv * force;
        a.fx -= fx;
        a.fy -= fy;
        b.fx += fx;
        b.fy += fy;
      }
    }

    const desired = this.preview ? 30 : 58;
    for (const edge of this.edges) {
      const a = edge.source;
      const b = edge.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (dist - desired) * (this.preview ? 0.012 : 0.0072) * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.fx += fx;
      a.fy += fy;
      b.fx -= fx;
      b.fy -= fy;
    }

    const gravity = this.preview ? 0.008 : 0.0052;
    for (const node of nodes) {
      // Loose nodes (no links yet) drift back to the middle instead of the frame edges.
      const pull = (node.degree || 0) === 0 ? gravity * 2.4 : gravity;
      node.fx += -node.x * pull * alpha;
      node.fy += -node.y * pull * alpha;
      node.vx = (node.vx + node.fx) * 0.84;
      node.vy = (node.vy + node.fy) * 0.84;
      node.x += node.vx;
      node.y += node.vy;
    }

    this.alpha *= this.preview ? 0.972 : 0.985;
  }

  fit() {
    if (!this.nodes.length || !this.width || !this.height) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes) {
      minX = Math.min(minX, node.x - node.r);
      minY = Math.min(minY, node.y - node.r);
      maxX = Math.max(maxX, node.x + node.r);
      maxY = Math.max(maxY, node.y + node.r);
    }
    const pad = this.preview ? 22 : 74;
    const boxWidth = Math.max(1, maxX - minX);
    const boxHeight = Math.max(1, maxY - minY);
    const nextScale = clamp(
      Math.min((this.width - pad * 2) / boxWidth, (this.height - pad * 2) / boxHeight),
      0.08,
      this.preview ? 1.35 : 2.6,
    );
    this.scale = Number.isFinite(nextScale) ? nextScale : 1;
    this.tx = this.width / 2 - ((minX + maxX) / 2) * this.scale;
    this.ty = this.height / 2 - ((minY + maxY) / 2) * this.scale;
    this.userAdjusted = false;
    this.dirty = true;
    this.onViewChange?.();
    this.schedule();
  }

  zoomAt(screenX, screenY, factor) {
    const next = clamp(this.scale * factor, 0.08, 3.4);
    if (Math.abs(next - this.scale) < 0.0001) return;
    const worldX = (screenX - this.tx) / this.scale;
    const worldY = (screenY - this.ty) / this.scale;
    this.scale = next;
    this.tx = screenX - worldX * next;
    this.ty = screenY - worldY * next;
    this.userAdjusted = true;
    this.dirty = true;
    this.onViewChange?.();
    this.schedule();
  }

  zoomBy(factor) {
    this.zoomAt(this.width / 2, this.height / 2, factor);
  }

  setSearch(text) {
    this.search = String(text || '').trim().toLowerCase();
    this.dirty = true;
    this.schedule();
  }

  matches(node) {
    if (!this.search) return true;
    return String(node.label || '').toLowerCase().includes(this.search);
  }

  matchCount() {
    if (!this.search) return 0;
    return this.nodes.filter((node) => this.matches(node)).length;
  }

  setHidden(kinds) {
    this.hiddenKinds = new Set(kinds || []);
    this.dirty = true;
    this.schedule();
  }

  isVisible(node) {
    return !this.hiddenKinds.has(node.kind);
  }

  visibleStats() {
    const nodes = this.nodes.filter((node) => this.isVisible(node));
    const ids = new Set(nodes.map((node) => node.id));
    const edges = this.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    return { nodes: nodes.length, edges: edges.length };
  }

  setSelectedNoteId(id) {
    this.focus = this.nodes.find((node) => node.noteId === id) || null;
    this.dirty = true;
    this.schedule();
  }

  focusById(id) {
    this.focus = this.byId.get(id) || null;
    this.wake(0.18);
  }

  draw() {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const styles = getComputedStyle(document.documentElement);
    const paper = styles.getPropertyValue('--paper').trim() || '#fff';
    const ink = styles.getPropertyValue('--ink-2').trim() || '#555';
    const accent = styles.getPropertyValue('--accent').trim() || '#b3542b';
    const lineColor = styles.getPropertyValue('--line-strong').trim() || '#ccc';
    const colors = {};
    const colorFor = (kind) => {
      if (!colors[kind]) colors[kind] = styles.getPropertyValue(`--k-${kind}`).trim() || ink;
      return colors[kind];
    };

    const nodes = this.nodes.filter((node) => this.isVisible(node));
    const ids = new Set(nodes.map((node) => node.id));
    const edges = this.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const focus = this.hover || this.focus;
    const neighborIds = new Set();
    if (focus) {
      neighborIds.add(focus.id);
      for (const edge of edges) {
        if (edge.from === focus.id) neighborIds.add(edge.to);
        if (edge.to === focus.id) neighborIds.add(edge.from);
      }
    }

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    for (const edge of edges) {
      let alpha = 0.22;
      if (focus) alpha = neighborIds.has(edge.from) && neighborIds.has(edge.to) ? 0.6 : 0.055;
      if (this.search && !(this.matches(edge.source) || this.matches(edge.target))) alpha = Math.min(alpha, 0.04);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = Math.max(0.55, 1 / this.scale);
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.stroke();
    }

    for (const node of nodes) {
      let alpha = 1;
      if (this.search && !this.matches(node)) alpha = 0.16;
      if (focus && !neighborIds.has(node.id)) alpha = Math.min(alpha, 0.2);
      ctx.globalAlpha = alpha;
      const color = colorFor(node.kind);
      const x = node.x;
      const y = node.y;
      const r = node.r;
      const virtual = ['file', 'project', 'agent', 'session', 'missing', 'tag'].includes(node.kind);

      if (virtual) {
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.7, 1.1 / this.scale);
        if (node.kind === 'file') {
          ctx.fillRect(x - r * 0.65, y - r * 0.65, r * 1.3, r * 1.3);
        } else if (node.kind === 'project') {
          ctx.beginPath();
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
          ctx.fill();
        } else if (node.kind === 'agent') {
          ctx.beginPath();
          for (let side = 0; side < 6; side += 1) {
            const angle = (Math.PI / 3) * side - Math.PI / 6;
            const px = x + Math.cos(angle) * r;
            const py = y + Math.sin(angle) * r;
            if (side === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        } else if (node.kind === 'session') {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (node.kind === 'decision' || node.kind === 'risk') {
          ctx.globalAlpha = alpha * 0.55;
          ctx.strokeStyle = paper;
          ctx.lineWidth = Math.max(0.6, 0.9 / this.scale);
          ctx.beginPath();
          ctx.arc(x, y, r * 0.48, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = alpha;
        }
      }

      if (this.hover === node || this.focus === node) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1.1, 2 / this.scale);
        ctx.beginPath();
        ctx.arc(x, y, r + 3 / this.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!this.preview) {
      const focusIds = neighborIds;
      let candidates = nodes.filter((node) => (
        this.scale > 1.02
        || (node.degree || 0) >= 6
        || ['project', 'agent', 'session'].includes(node.kind)
        || focusIds.has(node.id)
        || (this.search && this.matches(node))
      ));
      const priority = (node) => (
        (node === this.hover || node === this.focus ? 4 : 0)
        + (this.search && this.matches(node) ? 3 : 0)
        + (focusIds.has(node.id) ? 2 : 0)
        + Math.min((node.degree || 0) / 10, 1)
      );
      if (candidates.length > 200) {
        candidates = candidates
          .slice()
          .sort((a, b) => priority(b) - priority(a))
          .slice(0, 200);
      }
      ctx.font = '10.5px "Aptos", "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const placed = [];
      const collides = (box) => placed.some((other) => (
        box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0
      ));
      for (const node of candidates) {
        const x = node.x * this.scale + this.tx;
        const y = node.y * this.scale + this.ty + node.r * this.scale + 3;
        if (x < -80 || x > this.width + 80 || y < -20 || y > this.height + 20) continue;
        let label = String(node.label || '');
        if (label.length > 34) label = `${label.slice(0, 32)}…`;
        const half = ctx.measureText(label).width / 2;
        const box = { x0: x - half - 2, x1: x + half + 2, y0: y - 1, y1: y + 13 };
        const pinned = node === this.hover || node === this.focus || (this.search && this.matches(node));
        if (!pinned && collides(box)) continue;
        placed.push(box);
        ctx.globalAlpha = this.search && !this.matches(node) ? 0.25 : 0.94;
        ctx.lineWidth = 3;
        ctx.strokeStyle = paper;
        ctx.strokeText(label, x, y);
        ctx.fillStyle = ink;
        ctx.fillText(label, x, y);
      }
      ctx.globalAlpha = 1;
    }
  }

  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const worldX = (sx - this.tx) / this.scale;
    const worldY = (sy - this.ty) / this.scale;
    let best = null;
    let bestDistance = Infinity;
    const padding = 6 / this.scale;
    for (const node of this.nodes) {
      if (!this.isVisible(node)) continue;
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const radius = Math.max(node.r, 2.6) + padding;
      if (distance <= radius && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  bindEvents() {
    const signal = this.abort.signal;
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event), { signal });
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event), { signal });
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event), { signal });
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event), { signal });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.canvas.classList.remove('is-hovering');
      this.hideTooltip();
      this.dirty = true;
      this.schedule();
    }, { signal });
    this.canvas.addEventListener('wheel', (event) => {
      if (this.preview) return;
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0012));
    }, { passive: false, signal });
    this.canvas.addEventListener('dblclick', () => {
      if (!this.preview) this.fit();
    }, { signal });
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    this.canvas.setPointerCapture?.(event.pointerId);
    const node = this.hitTest(event.clientX, event.clientY);
    this.pointerStart = { x: event.clientX, y: event.clientY, node, moved: false };
    if (this.preview) return;
    if (node) {
      const rect = this.canvas.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - this.tx) / this.scale;
      const worldY = (event.clientY - rect.top - this.ty) / this.scale;
      this.drag = { node, offsetX: node.x - worldX, offsetY: node.y - worldY };
      this.canvas.classList.add('is-dragging');
    } else {
      this.pan = { startX: event.clientX, startY: event.clientY, tx: this.tx, ty: this.ty };
      this.canvas.classList.add('is-dragging');
    }
  }

  onPointerMove(event) {
    if (this.pointerStart) {
      const distance = Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y);
      if (distance > 4) this.pointerStart.moved = true;
    }

    if (this.drag) {
      const rect = this.canvas.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - this.tx) / this.scale;
      const worldY = (event.clientY - rect.top - this.ty) / this.scale;
      this.drag.node.x = worldX + this.drag.offsetX;
      this.drag.node.y = worldY + this.drag.offsetY;
      this.drag.node.vx = 0;
      this.drag.node.vy = 0;
      this.dirty = true;
      this.alpha = Math.max(this.alpha, 0.25);
      this.schedule();
      return;
    }

    if (this.pan) {
      this.tx = this.pan.tx + (event.clientX - this.pan.startX);
      this.ty = this.pan.ty + (event.clientY - this.pan.startY);
      this.userAdjusted = true;
      this.dirty = true;
      this.onViewChange?.();
      this.schedule();
      return;
    }

    const node = this.hitTest(event.clientX, event.clientY);
    if (node !== this.hover) {
      this.hover = node;
      this.dirty = true;
      this.canvas.classList.toggle('is-hovering', Boolean(node));
      if (node) this.showTooltip(node, event.clientX, event.clientY);
      else this.hideTooltip();
      this.schedule();
    } else if (node) {
      this.showTooltip(node, event.clientX, event.clientY);
    }
  }

  onPointerUp() {
    const start = this.pointerStart;
    this.pointerStart = null;
    const dragged = this.drag;
    this.drag = null;
    this.pan = null;
    this.canvas.classList.remove('is-dragging');
    if (dragged) {
      if (!start?.moved) {
        this.focus = dragged.node;
        this.onSelect?.(dragged.node);
      } else {
        this.wake(0.2);
      }
      return;
    }
    if (start && !start.moved && start.node) {
      this.focus = start.node;
      this.onSelect?.(start.node);
    }
  }

  showTooltip(node, clientX, clientY) {
    if (!this.tooltip) {
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'graph-tooltip';
      document.body.appendChild(this.tooltip);
    }
    const meta = [`${fmtNumber(node.degree || 0)} links`];
    if (node.status) meta.push(statusLabel(node.status));
    if (node.project) meta.push(projectLabel(node.project));
    this.tooltip.innerHTML = `<div class="tt-kind" style="--kind: var(--k-${escapeAttr(node.kind)})">${escapeHtml(kindLabel(node.kind))}</div>
      <div class="tt-title">${escapeHtml(node.label || 'Untitled')}</div>
      <div class="tt-meta">${escapeHtml(meta.join(' · '))}</div>`;
    this.tooltip.hidden = false;
    const left = Math.min(clientX, window.innerWidth - 310);
    const top = Math.min(clientY, window.innerHeight - 90);
    this.tooltip.style.left = `${Math.max(6, left)}px`;
    this.tooltip.style.top = `${Math.max(6, top)}px`;
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.hidden = true;
  }

  onThemeChange() {
    this.dirty = true;
    this.schedule();
  }

  destroy() {
    this.destroyed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.hideTooltip();
    this.tooltip?.remove();
    this.tooltip = null;
  }
}

/* ============================================================
   Toasts, clipboard, links
   ============================================================ */

function toast(message, tone = 'ok') {
  const stack = $('#toasts');
  if (!stack) return;
  const element = document.createElement('div');
  element.className = `toast${tone === 'error' ? ' toast--error' : ''}`;
  element.innerHTML = `<span class="toast-icon">${icon(tone === 'error' ? 'i-risk' : 'i-check')}</span><span>${escapeHtml(message)}</span>`;
  stack.appendChild(element);
  setTimeout(() => element.classList.add('is-leaving'), 3200);
  setTimeout(() => element.remove(), 3500);
}

async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    toast('Copied to clipboard');
  } catch {
    toast('Could not copy to the clipboard', 'error');
  }
}

async function resolveWikilink(target) {
  const title = String(target || '').trim();
  if (!title) return;
  try {
    const params = new URLSearchParams({ q: title, limit: '8', sort: 'relevance' });
    if (state.project) params.set('project', state.project);
    const data = await getJSON(`/api/notes?${params.toString()}`);
    const hits = data.hits || [];
    const exact = hits.find((hit) => hit.note.title.toLowerCase() === title.toLowerCase());
    const hit = exact || hits[0];
    if (!hit) {
      toast(`No memory titled “${title}”`, 'error');
      return;
    }
    selectNote(hit.note.id);
  } catch {
    toast(`Could not resolve “${title}”`, 'error');
  }
}

/* ============================================================
   Live sync
   ============================================================ */

function setLive(ok) {
  if (state.live === ok) return;
  state.live = ok;
  const status = $('#live-status');
  const label = $('#live-label');
  if (status) {
    status.classList.toggle('is-live', ok);
    status.classList.toggle('is-offline', !ok);
  }
  if (label) label.textContent = ok ? 'Live · local vault' : 'Reconnecting…';
}

function connectLive() {
  if (!window.EventSource) {
    setLive(false);
    return;
  }
  const source = new EventSource('/api/events');
  source.onopen = () => setLive(true);
  source.onerror = () => setLive(false);
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === 'refresh') scheduleLiveRefresh();
      if (payload?.type === 'hello') setLive(true);
    } catch {
      // Ignore malformed event frames.
    }
  };
}

const scheduleLiveRefresh = debounce(async () => {
  if (!state.boot) return;
  invalidateOverview();
  try {
    await loadOverview(true);
  } catch {
    return;
  }
  if (state.captureOpen || state.palette.open || isTyping()) return;
  if (state.route === 'graph') {
    await refreshGraphData();
    return;
  }
  // renderBase() clears the inspector DOM, so remember the open note first.
  const selected = state.selectedId;
  try {
    await renderBase(state.route);
  } catch {
    return;
  }
  if (selected) {
    loadInspector(selected, true).catch(() => {});
  }
}, 200);

async function refreshGraphData() {
  try {
    const data = await getJSON(graphUrl());
    const engine = state.activeGraph;
    if (!engine || state.route !== 'graph') return;
    engine.updateData(data);
    if (state.graph.search) engine.setSearch(state.graph.search);
    if (state.graph.hidden.size) engine.setHidden(state.graph.hidden);
  } catch {
    // Keep the last good graph.
  }
}

function isTyping() {
  const element = document.activeElement;
  if (!element) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
}

/* ============================================================
   Global events and boot
   ============================================================ */

function bindGlobals() {
  document.addEventListener('click', (event) => {
    const paletteItem = event.target.closest('[data-palette-index]');
    if (paletteItem) {
      event.preventDefault();
      activatePaletteIndex(Number(paletteItem.dataset.paletteIndex));
      return;
    }

    const element = event.target.closest('[data-wikilink],[data-note-status],[data-note],[data-copy],[data-search-file],[data-scope],[data-go],[data-action]');
    if (!element) return;

    if (element.hasAttribute('data-wikilink')) {
      event.preventDefault();
      resolveWikilink(element.dataset.wikilink);
      return;
    }
    if (element.hasAttribute('data-note-status')) {
      event.preventDefault();
      if (state.selectedId) updateNoteStatus(state.selectedId, element.dataset.noteStatus);
      return;
    }
    if (element.hasAttribute('data-note')) {
      event.preventDefault();
      selectNote(element.dataset.note);
      return;
    }
    if (element.hasAttribute('data-copy')) {
      event.preventDefault();
      copyText(element.dataset.copy);
      return;
    }
    if (element.hasAttribute('data-search-file')) {
      event.preventDefault();
      go(`search?q=${encodeURIComponent(element.dataset.searchFile)}`);
      return;
    }
    if (element.hasAttribute('data-scope')) {
      event.preventDefault();
      const scope = element.dataset.scope;
      closeInspector();
      setProject(scope);
      return;
    }
    if (element.hasAttribute('data-go')) {
      event.preventDefault();
      go(element.dataset.go);
      return;
    }
    if (element.hasAttribute('data-action')) {
      const action = element.dataset.action;
      if (action === 'capture') {
        event.preventDefault();
        openCapture({ kind: element.dataset.kind, to: element.dataset.to });
      } else if (action === 'palette') {
        event.preventDefault();
        openPalette();
      } else if (action === 'theme') {
        event.preventDefault();
        toggleTheme();
      } else if (action === 'open-nav') {
        openNav();
      } else if (action === 'close-nav') {
        closeNav();
      } else if (action === 'close-inspector') {
        closeInspector();
      } else if (action === 'close-palette') {
        closePalette();
      } else if (action === 'close-capture') {
        closeCapture();
      } else if (action === 'change-password') {
        event.preventDefault();
        openChangePassword();
      } else if (action === 'close-change-password') {
        closeChangePassword();
      } else if (action === 'logout') {
        event.preventDefault();
        lockWorkspace();
      } else if (action === 'retry') {
        renderRoute(true);
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (state.palette.open) closePalette();
      else openPalette();
      return;
    }
    if (event.key === 'Escape') {
      if (state.palette.open) {
        closePalette();
      } else if (state.changePasswordOpen) {
        closeChangePassword();
      } else if (state.captureOpen) {
        closeCapture();
      } else if (inspectorIsOpen()) {
        closeInspector();
      } else {
        closeNav();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping() || state.palette.open || state.captureOpen || state.changePasswordOpen) return;
    if (event.key === 'n') {
      event.preventDefault();
      openCapture();
    } else if (event.key === '/') {
      event.preventDefault();
      openPalette();
    }
  });

  window.addEventListener('focus', () => {
    if (state.route === 'setup') renderRoute(true);
  });

  $('#project-select')?.addEventListener('change', (event) => {
    setProject(event.target.value);
  });

  $('#capture-kind')?.addEventListener('change', (event) => {
    const kind = event.target.value;
    populateCaptureStatus(kind);
    const toField = $('#capture-to-field');
    if (toField) toField.hidden = kind !== 'message' && kind !== 'handoff';
  });

  $('#capture-form')?.addEventListener('submit', submitCapture);
  $('#capture-form')?.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submitCapture(event);
    }
  });

  $('#change-password-form')?.addEventListener('submit', submitChangePassword);

  const paletteInput = $('#palette-input');
  const searchPaletteDebounced = debounce((value) => searchPalette(value), 160);
  paletteInput?.addEventListener('input', (event) => {
    state.palette.query = event.target.value;
    state.palette.active = 0;
    renderPalette();
    searchPaletteDebounced(event.target.value);
  });
  paletteInput?.addEventListener('keydown', paletteKeydown);

  window.addEventListener('hashchange', () => renderRoute());

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme();
  });

  window.addEventListener('beforeunload', () => {
    destroyGraphs();
  });
}

function openNav() {
  $('#sidebar')?.classList.add('is-open');
  $('.nav-scrim')?.classList.add('is-visible');
}

function closeNav() {
  $('#sidebar')?.classList.remove('is-open');
  $('.nav-scrim')?.classList.remove('is-visible');
}

async function boot() {
  applyTheme();
  bindGlobals();
  try {
    const session = await getJSON('/api/auth/session');
    state.csrf = session?.csrfToken || '';
  } catch (caught) {
    if (caught instanceof Error && caught.status === 401) {
      location.assign('/login');
      return;
    }
    const view = $('#view');
    if (view) {
      view.innerHTML = `<div class="view-inner">${emptyState('Cairn could not reach the vault', caught instanceof Error ? caught.message : 'The local server did not respond.', `<button class="btn" data-action="retry">${icon('i-clock')} Try again</button>`)}</div>`;
    }
    return;
  }
  try {
    state.boot = await getJSON('/api/bootstrap');
    applyBootstrap();
  } catch (caught) {
    if (caught instanceof Error && caught.status === 401) return;
    const view = $('#view');
    if (view) {
      view.innerHTML = `<div class="view-inner">${emptyState('Cairn could not reach the vault', caught instanceof Error ? caught.message : 'The local server did not respond.', `<button class="btn" data-action="retry">${icon('i-clock')} Try again</button>`)}</div>`;
    }
    return;
  }
  connectLive();
  await renderRoute(true);
}

boot();

