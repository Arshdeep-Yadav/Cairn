import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { detectProjectName, initVault, resolveVaultDir, Vault, vaultExists } from './vault.js';
import { VaultIndex, type Neighbor } from './indexer.js';
import { handle, newId, safeKey } from './ids.js';
import { isIgnoredPath, isSensitivePath, redactSecrets } from './redact.js';
import { normalizeFilePath, wikiLink } from './links.js';
import {
  getCommit,
  getDiff,
  getWorkspace,
  projectNameForRepo,
  repoRoot,
  type GitFileChange,
} from './git.js';
import { humanizeHandle, truncate } from './text.js';
import {
  DEFAULT_STATUS,
  type AgentInfo,
  type CaptureOptions,
  type CaptureResult,
  type ClientSessionState,
  type ContextData,
  type GraphOptions,
  type InboxOptions,
  type Kind,
  type MessageInput,
  type Note,
  type NoteInput,
  type NotePatch,
  type NoteSummary,
  type ProjectInfo,
  type Relation,
  type SearchHit,
  type SearchOptions,
  type SessionResult,
  type SessionStartInput,
  type VaultStats,
  type WorklogState,
} from './types.js';
import { renderContext } from './format.js';

export interface StoreOptions {
  vaultDir: string;
  cwd?: string;
  project?: string;
  agent?: string;
  refreshMs?: number;
  lazy?: boolean;
}

export interface OpenStoreOptions {
  vault?: string;
  cwd?: string;
  project?: string;
  agent?: string;
  autoInit?: boolean;
  refreshMs?: number;
  lazy?: boolean;
}

export interface WriteResult {
  note: Note;
  created: boolean;
  deduped: boolean;
  warnings: string[];
}

export interface GetResult {
  note: Note;
  outgoing: Neighbor[];
  backlinks: Neighbor[];
  related: Array<{ note: Note; types: string[]; direction: string }>;
  sessionNote?: NoteSummary;
}

export interface SessionEndInput {
  session?: string;
  agent?: string;
  summary?: string;
  nextSteps?: string[];
  status?: 'done' | 'abandoned';
}

export interface SessionEndResult {
  session: Note;
  captured: NoteSummary[];
  counts: Partial<Record<Kind, number>>;
}

export interface CaptureFileInput {
  path: string;
  tool?: string;
  project?: string;
  agent?: string;
  clientSession?: string;
  cwd?: string;
}

function statusValue(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  return handle(input).replace(/-/g, '_') || fallback;
}

function isoOrNow(input?: string): string {
  if (input) {
    const date = new Date(input);
    if (!Number.isFinite(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  }
  return new Date().toISOString();
}

function normalizeTags(tags?: string[]): string[] {
  return Array.from(new Set((tags || []).map(handle).filter(Boolean))).slice(0, 40);
}

function normalizeFiles(files?: string[], applyIgnore = false): string[] {
  const out = new Set<string>();
  for (const file of files || []) {
    const normalized = normalizeFilePath(file);
    if (!normalized) continue;
    if (isSensitivePath(normalized)) continue;
    if (applyIgnore && isIgnoredPath(normalized)) continue;
    out.add(normalized);
  }
  return Array.from(out).slice(0, 400);
}

function normalizeRelations(relations?: Relation[]): Relation[] {
  const seen = new Set<string>();
  const out: Relation[] = [];
  for (const relation of relations || []) {
    const to = (relation.to || '').trim();
    if (!to) continue;
    const type = handle(relation.type || 'relates_to') || 'relates_to';
    const key = `${to}\u0000${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ to, type });
  }
  return out.slice(0, 100);
}

function statText(files: GitFileChange[]): string {
  if (!files.length) return 'No tracked file changes.';
  return files
    .slice(0, 80)
    .map((file) => {
      const stats =
        file.additions === null && file.deletions === null
          ? ''
          : ` (+${file.additions ?? '?'} −${file.deletions ?? '?'})`;
      return `- \`${file.path}\` · ${file.status}${stats}`;
    })
    .join('\n');
}

function countFileStats(files: GitFileChange[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, file) => {
      acc.additions += file.additions ?? 0;
      acc.deletions += file.deletions ?? 0;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
}

function fingerprint(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function openStore(options: OpenStoreOptions = {}): Store {
  const dir = resolveVaultDir({ vault: options.vault, cwd: options.cwd });
  if (!vaultExists(dir)) {
    if (options.autoInit === false) {
      throw new Error(`No Cairn vault at ${dir}. Run \`cairn init\` first.`);
    }
    initVault(dir, { cwd: options.cwd, project: options.project });
  }
  return new Store({
    vaultDir: dir,
    cwd: options.cwd,
    project: options.project,
    agent: options.agent,
    refreshMs: options.refreshMs,
    lazy: options.lazy,
  });
}

export class Store {
  readonly vault: Vault;
  readonly index: VaultIndex;
  readonly cwd: string;
  readonly defaultProject: string;
  readonly defaultAgent: string;

  constructor(options: StoreOptions) {
    this.vault = new Vault(options.vaultDir);
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.defaultProject = handle(
      options.project || this.vault.config.project || detectProjectName(this.cwd) || 'workspace',
    );
    this.defaultAgent = handle(options.agent || 'human');
    this.index = new VaultIndex(this.vault, { refreshMs: options.refreshMs });
    if (!options.lazy) this.index.refresh(true);
  }

  get vaultDir(): string {
    return this.vault.dir;
  }

  refresh(force = false): void {
    this.index.refresh(force);
  }

  resolveProject(project?: string): string {
    return handle(project || this.defaultProject);
  }

  scopeProject(project?: string, allProjects = false): string | undefined {
    if (allProjects) return undefined;
    return this.resolveProject(project);
  }

  write(input: NoteInput): WriteResult {
    return this.vault.withWriteLock(() => {
    const warnings: string[] = [];
    const kind = input.kind;
    const project = this.resolveProject(input.project);
    const agent = handle(input.agent || this.defaultAgent);
    let title = (input.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    let body = (input.body || '').slice(0, 240_000);
    if (this.vault.config.settings.redact) {
      title = redactSecrets(title);
      body = redactSecrets(body);
    }
    if (!title) throw new Error('A note title is required.');
    if (!body.trim()) body = '';
    const dedupeKey = input.dedupe_key?.trim();
    if (dedupeKey) {
      this.index.refresh(true);
      const existing = Array.from(this.index.notes.values()).find(
        (note) =>
          note.kind === kind &&
          note.project === project &&
          note.metadata?.dedupe_key === dedupeKey,
      );
      if (existing) {
        return { note: existing, created: false, deduped: true, warnings };
      }
    }
    const rawFiles = input.files || [];
    const files = normalizeFiles(rawFiles);
    if (rawFiles.length && !files.length) warnings.push('Sensitive file paths were not stored.');
    const sensitiveSkipped = rawFiles.filter((file) => isSensitivePath(normalizeFilePath(file)));
    if (sensitiveSkipped.length) warnings.push(`${sensitiveSkipped.length} sensitive path(s) skipped.`);
    const note: Note = {
      id: newId(),
      kind,
      title,
      status: statusValue(input.status, DEFAULT_STATUS[kind] || 'active'),
      project,
      agent,
      session: input.session,
      tags: normalizeTags(input.tags),
      files,
      to: Array.from(
        new Set((input.to || []).map((recipient) => (recipient.trim() === '*' ? '*' : handle(recipient))).filter(Boolean)),
      ),
      related: Array.from(new Set((input.related || []).map((entry) => entry.trim()).filter(Boolean))),
      supersedes: Array.from(new Set((input.supersedes || []).map((entry) => entry.trim()).filter(Boolean))),
      repliesTo: input.replies_to,
      relations: normalizeRelations(input.relations),
      created: isoOrNow(input.created),
      updated: isoOrNow(input.updated || input.created),
      body,
      path: '',
      metadata: { ...(input.metadata || {}) },
      aliases: [],
    };
    if (dedupeKey) note.metadata.dedupe_key = dedupeKey;
    if (!input.no_auto_link && this.vault.config.settings.autoLink && files.length) {
      const related = this.index.notesTouchingFiles(files, {
        project,
        excludeId: note.id,
        kinds: ['decision', 'spec', 'insight', 'risk', 'question'],
        limit: 4,
      });
      for (const entry of related) {
        if (!note.related.includes(entry.note.id)) note.related.push(entry.note.id);
      }
    }
    note.path = this.vault.makeNotePath(note);
    this.vault.writeNote(note);
    this.index.refresh(true);
    this.touchPresence(agent, { project, session: input.session });
    return { note: this.index.getNote(note.id) || note, created: true, deduped: false, warnings };
    });
  }

  update(ref: string, patch: NotePatch): Note {
    return this.vault.withWriteLock(() => {
    this.index.refresh(true);
    const note = this.index.resolveNote(ref);
    if (!note) throw new Error(`Note not found: ${ref}`);
    const warnings: string[] = [];
    const updated: Note = {
      ...note,
      tags: note.tags.slice(),
      files: note.files.slice(),
      to: note.to.slice(),
      related: note.related.slice(),
      supersedes: note.supersedes.slice(),
      relations: note.relations.slice(),
      metadata: { ...note.metadata },
    };
    if (patch.title !== undefined) {
      const title = patch.title.replace(/\s+/g, ' ').trim().slice(0, 180);
      if (!title) throw new Error('A note title cannot be empty.');
      updated.title = this.vault.config.settings.redact ? redactSecrets(title) : title;
    }
    if (patch.body !== undefined) {
      let body = patch.body.slice(0, 240_000);
      if (this.vault.config.settings.redact) body = redactSecrets(body);
      updated.body = patch.append && note.body ? `${note.body.trim()}\n\n${body.trim()}` : body;
    }
    if (patch.status !== undefined) updated.status = statusValue(patch.status, note.status);
    if (patch.project !== undefined) updated.project = this.resolveProject(patch.project);
    if (patch.agent !== undefined) updated.agent = handle(patch.agent);
    if (patch.tags !== undefined) updated.tags = normalizeTags(patch.tags);
    if (patch.files !== undefined) {
      updated.files = normalizeFiles(patch.files);
      if (patch.files.length && !updated.files.length) warnings.push('Sensitive file paths were not stored.');
    }
    if (patch.to !== undefined) updated.to = Array.from(new Set(patch.to.map(handle).filter(Boolean)));
    if (patch.related !== undefined) updated.related = Array.from(new Set(patch.related.filter(Boolean)));
    if (patch.supersedes !== undefined) updated.supersedes = Array.from(new Set(patch.supersedes.filter(Boolean)));
    if (patch.relations !== undefined) updated.relations = normalizeRelations(patch.relations);
    if (patch.metadata !== undefined) updated.metadata = { ...updated.metadata, ...patch.metadata };
    updated.updated = new Date().toISOString();
    this.vault.writeNote(updated);
    this.index.refresh(true);
    const result = this.index.getNote(updated.id);
    if (!result) throw new Error('Note was written but could not be read back.');
    if (warnings.length) this.vault.appendLog('store', warnings.join(' '));
    return result;
    });
  }

  get(ref: string): GetResult | null {
    this.index.refresh();
    const note = this.index.resolveNote(ref);
    if (!note) return null;
    const neighbors = this.index.neighbors(note.id);
    const related = this.index.relatedNotes(note.id, 8);
    const sessionNote = note.session ? this.index.getNote(note.session) : null;
    return {
      note,
      outgoing: neighbors.outgoing,
      backlinks: neighbors.backlinks,
      related,
      sessionNote: sessionNote ? this.index.summary(sessionNote) : undefined,
    };
  }

  search(options: SearchOptions = {}): SearchHit[] {
    return this.index.search(options);
  }

  timeline(options: { project?: string; agent?: string; days?: number; limit?: number; kinds?: Kind[] } = {}) {
    const days = Math.max(1, Math.min(options.days ?? 21, 365));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.search({
      project: options.project ? this.resolveProject(options.project) : undefined,
      agent: options.agent ? handle(options.agent) : undefined,
      kinds: options.kinds,
      since,
      limit: options.limit ?? 80,
      sort: 'created',
    });
  }

  link(fromRef: string, toRef: string, type = 'relates_to'): { from: Note; to: Note; type: string } {
    return this.vault.withWriteLock(() => {
    this.index.refresh(true);
    const from = this.index.resolveNote(fromRef);
    const to = this.index.resolveNote(toRef);
    if (!from) throw new Error(`Source note not found: ${fromRef}`);
    if (!to) throw new Error(`Target note not found: ${toRef}`);
    if (from.id === to.id) throw new Error('A note cannot link to itself.');
    const relationType = handle(type || 'relates_to') || 'relates_to';
    if (!from.relations.some((relation) => relation.to === to.id && relation.type === relationType)) {
      from.relations.push({ to: to.id, type: relationType });
      from.updated = new Date().toISOString();
      this.vault.writeNote(from);
      this.index.refresh(true);
    }
    return { from, to, type: relationType };
    });
  }

  unlink(fromRef: string, toRef: string, type?: string): Note {
    return this.vault.withWriteLock(() => {
    this.index.refresh(true);
    const from = this.index.resolveNote(fromRef);
    const to = this.index.resolveNote(toRef);
    if (!from) throw new Error(`Source note not found: ${fromRef}`);
    if (!to) throw new Error(`Target note not found: ${toRef}`);
    const relationType = type ? handle(type) : undefined;
    from.relations = from.relations.filter(
      (relation) => !(relation.to === to.id && (!relationType || relation.type === relationType)),
    );
    from.updated = new Date().toISOString();
    this.vault.writeNote(from);
    this.index.refresh(true);
    return from;
    });
  }

  sessionStart(input: SessionStartInput): SessionResult {
    return this.vault.withWriteLock(() => {
    this.index.refresh(true);
    const agent = handle(input.agent || this.defaultAgent);
    const project = this.resolveProject(input.project);
    let session: Note | null = null;
    let resumed = false;
    if (input.session) {
      session = this.index.getNote(input.session);
      resumed = Boolean(session && session.kind === 'session' && session.status === 'active');
    }
    if (!session && input.clientSession) {
      session =
        Array.from(this.index.notes.values()).find(
          (note) =>
            note.kind === 'session' &&
            note.status === 'active' &&
            note.agent === agent &&
            note.metadata?.clientSession === input.clientSession,
        ) || null;
      resumed = Boolean(session);
    }
    if (!session) {
      session =
        Array.from(this.index.notes.values())
          .filter(
            (note) =>
              note.kind === 'session' &&
              note.status === 'active' &&
              note.agent === agent &&
              note.project === project &&
              Date.now() - Date.parse(note.updated) < 10 * 60_000,
          )
          .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))[0] || null;
      resumed = Boolean(session);
    }
    if (session) {
      const mergedMetadata = {
        ...session.metadata,
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.client ? { client: input.client } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.clientSession ? { clientSession: input.clientSession } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        lastActivity: new Date().toISOString(),
      };
      const patch: NotePatch = { metadata: mergedMetadata, status: 'active' };
      if (input.goal && !session.metadata?.goal) {
        patch.body = `${session.body}\n\n## Goal\n${input.goal}`.trim();
      }
      session = this.update(session.id, patch);
    } else {
      const goal = input.goal?.trim();
      session = this.write({
        kind: 'session',
        title: goal
          ? `Session — ${truncate(goal, 64)}`
          : `Session — ${humanizeHandle(agent)} — ${project} — ${new Date().toLocaleString()}`,
        status: 'active',
        agent,
        project,
        body: [
          '## Goal',
          goal || '_No goal recorded._',
          '',
          '## Context',
          input.cwd ? `Started from \`${input.cwd}\`.` : 'Session started.',
          '',
          `Client: ${input.client || 'unknown'}${input.model ? ` · Model: ${input.model}` : ''}`,
        ].join('\n'),
        tags: ['session'],
        metadata: {
          goal: goal || '',
          cwd: input.cwd || this.cwd,
          model: input.model,
          client: input.client,
          source: input.source,
          clientSession: input.clientSession,
          startedAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        },
        no_auto_link: true,
      }).note;
    }
    this.touchPresence(agent, {
      project,
      session: session.id,
      cwd: input.cwd || this.cwd,
      client: input.client,
    });
    const context = this.context(project, agent);
    return { session, resumed, context };
    });
  }

  sessionEnd(input: SessionEndInput): SessionEndResult {
    return this.vault.withWriteLock(() => {
    this.index.refresh(true);
    const agent = input.agent ? handle(input.agent) : this.defaultAgent;
    let session: Note | null = input.session ? this.index.getNote(input.session) : null;
    if (!session) {
      session =
        Array.from(this.index.notes.values())
          .filter((note) => note.kind === 'session' && note.status === 'active' && (!agent || note.agent === agent))
          .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))[0] || null;
    }
    if (!session) throw new Error('No active session found to close.');
    const captured = this.index.notesBySession(session.id);
    const counts: Partial<Record<Kind, number>> = {};
    for (const note of captured) counts[note.kind] = (counts[note.kind] || 0) + 1;
    const startedAt = Date.parse(String(session.metadata?.startedAt || session.created));
    const durationMinutes = Number.isFinite(startedAt)
      ? Math.max(0, Math.round((Date.now() - startedAt) / 60_000))
      : undefined;
    const summary =
      input.summary?.trim() ||
      `Session closed after ${durationMinutes ?? '?'} minutes with ${captured.length} captured note${captured.length === 1 ? '' : 's'}.`;
    const capturedLines = captured.length
      ? captured
          .slice(0, 25)
          .map((note) => `- ${note.kind} · ${wikiLink(note.id, note.title)}`)
          .join('\n')
      : '_No notes were linked to this session._';
    const nextSteps = (input.nextSteps || []).filter(Boolean);
    const body = [
      session.body,
      '',
      '## Summary',
      summary,
      ...(nextSteps.length ? ['', '## Next steps', ...nextSteps.map((step) => `- ${step}`)] : []),
      '',
      '## Captured',
      capturedLines,
    ].join('\n');
    const updated = this.update(session.id, {
      body,
      status: input.status || 'done',
      metadata: {
        endedAt: new Date().toISOString(),
        durationMinutes,
        captured: captured.length,
        summary,
      },
    });
    this.clearPresence(agent, updated.id);
    return { session: updated, captured: captured.map((note) => this.index.summary(note)), counts };
    });
  }

  send(input: MessageInput): Note {
    const from = handle(input.from || this.defaultAgent);
    const to = input.to?.trim() === '*' ? '*' : handle(input.to || '*');
    const project = this.resolveProject(input.project);
    const kind = input.kind || 'message';
    const summary = input.body.trim();
    const body = [
      summary,
      ...(input.nextSteps?.length
        ? ['', '## Next steps', ...input.nextSteps.filter(Boolean).map((step) => `- ${step}`)]
        : []),
      ...(input.files?.length
        ? ['', '## Files', ...input.files.filter(Boolean).map((file) => `- \`${normalizeFilePath(file)}\``)]
        : []),
      '',
      '---',
      `From **${humanizeHandle(from)}** to **${to === '*' ? 'all agents' : humanizeHandle(to)}**${input.priority ? ` · Priority: ${input.priority}` : ''}`,
    ].join('\n');
    return this.write({
      kind,
      title: input.subject || `${kind === 'handoff' ? 'Handoff' : 'Message'} from ${humanizeHandle(from)}`,
      body,
      status: 'unread',
      project,
      agent: from,
      session: input.session,
      tags: [kind, ...(input.priority ? [input.priority] : [])],
      files: input.files,
      to: [to],
      replies_to: input.replyTo,
      metadata: {
        from,
        to,
        priority: input.priority || 'normal',
        kind,
        ...(input.nextSteps?.length ? { nextSteps: input.nextSteps } : {}),
      },
      no_auto_link: true,
    }).note;
  }

  inbox(options: InboxOptions): Note[] {
    return this.vault.withWriteLock(() => {
    this.index.refresh(true);
    const agent = handle(options.agent || this.defaultAgent);
    const project = options.project ? this.resolveProject(options.project) : undefined;
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const notes = Array.from(this.index.notes.values())
      .filter((note) => note.kind === 'message' || note.kind === 'handoff')
      .filter((note) => (project ? note.project === project : true))
      .filter((note) => note.to.includes(agent) || note.to.includes('*'))
      .filter((note) => (options.unreadOnly !== false ? note.status === 'unread' : true))
      .filter((note) => (options.includeDone ? true : note.status !== 'done'))
      .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
      .slice(0, limit);
    if (options.markRead) {
      const now = new Date().toISOString();
      for (const note of notes) {
        if (note.status === 'unread') {
          note.status = 'read';
          note.updated = now;
          this.vault.writeNote(note);
        }
      }
      this.index.refresh(true);
    }
    return notes;
    });
  }

  handoff(input: Omit<MessageInput, 'kind'>): Note {
    return this.send({ ...input, kind: 'handoff' });
  }

  captureChanges(options: CaptureOptions = {}): CaptureResult {
    return this.vault.withWriteLock(() => {
    const cwd = options.repo ? path.resolve(options.repo) : this.cwd;
    const root = repoRoot(cwd);
    if (!root) throw new Error(`Not a git repository: ${cwd}`);
    const project = this.resolveProject(options.project || projectNameForRepo(root));
    const agent = handle(options.agent || this.defaultAgent);
    const workspace = getWorkspace(root);
    if (!workspace) throw new Error('Could not read git workspace state.');
    const scope = options.scope || 'auto';
    const useWorkspace = scope === 'workspace' || (scope === 'auto' && !workspace.clean);
    if (useWorkspace) {
      const filtered = workspace.files.filter(
        (file) => !isSensitivePath(file.path) && !isIgnoredPath(file.path),
      );
      const fileNames = normalizeFiles(filtered.map((file) => file.path));
      const stats = countFileStats(filtered);
      const fp = fingerprint({
        head: workspace.head,
        branch: workspace.branch,
        files: filtered.map((file) => `${file.path}:${file.status}:${file.additions}:${file.deletions}`),
      });
      const dedupeKey = `workspace:${project}:${fp}`;
      const title = `Workspace changes — ${humanizeHandle(project)} — ${new Date().toLocaleString()}`;
      const diff = options.includeDiff
        ? getDiff(root, 'workspace', undefined, 12_000, filtered.map((file) => file.path))
        : '';
      const body = [
        `Uncommitted changes on branch \`${workspace.branch || 'detached'}\`${workspace.head ? ` at \`${workspace.head.slice(0, 7)}\`` : ''}.`,
        '',
        `**${filtered.length} file${filtered.length === 1 ? '' : 's'}** changed · +${stats.additions} −${stats.deletions}`,
        '',
        '## Files',
        statText(filtered),
        ...(diff
          ? ['', '## Diff', '```diff', diff.slice(0, 12_000), '```', diff.length >= 12_000 ? '_Diff truncated._' : '']
          : []),
      ].join('\n');
      const result = this.write({
        kind: 'change',
        title: truncate(title, 180),
        body,
        status: 'active',
        project,
        agent,
        session: options.session,
        tags: ['git', 'workspace', 'uncommitted'],
        files: fileNames,
        metadata: {
          source: 'git',
          scope: 'workspace',
          branch: workspace.branch,
          head: workspace.head,
          additions: stats.additions,
          deletions: stats.deletions,
          fileCount: filtered.length,
          fingerprint: fp,
          dedupe_key: dedupeKey,
        },
        dedupe_key: dedupeKey,
        no_auto_link: false,
      });
      return {
        notes: [result.note],
        created: result.created ? 1 : 0,
        existing: result.deduped ? 1 : 0,
        mode: 'workspace',
        summary: `${result.deduped ? 'Already captured' : 'Captured'} workspace changes: ${filtered.length} files, +${stats.additions} −${stats.deletions}.`,
      };
    }

    const commit = getCommit(root, options.commit || 'HEAD');
    if (!commit) throw new Error('No commit found to capture.');
    const captured = this.vault.readState<Record<string, Record<string, string>>>('captured', {});
    const projectCaptured = captured[project] || {};
    if (projectCaptured[commit.sha]) {
      const existing = this.index.getNote(projectCaptured[commit.sha]);
      if (existing) {
        return {
          notes: [existing],
          created: 0,
          existing: 1,
          mode: 'commit',
          summary: `Commit ${commit.shortSha} is already in memory as ${existing.id}.`,
        };
      }
    }
    const filtered = commit.files.filter(
      (file) => !isSensitivePath(file.path) && !isIgnoredPath(file.path),
    );
    const fileNames = normalizeFiles(filtered.map((file) => file.path));
    const stats = countFileStats(filtered);
    const dedupeKey = `commit:${project}:${commit.sha}`;
    const diff = options.includeDiff
      ? getDiff(root, 'commit', commit.sha, 12_000, filtered.map((file) => file.path))
      : '';
    const body = [
      `Committed by **${commit.authorName}**${commit.authorEmail ? ` <${commit.authorEmail}>` : ''} on branch \`${commit.branch || 'detached'}\` · ${new Date(commit.date).toLocaleString()}`,
      '',
      commit.body || '_No commit message body._',
      '',
      `**${filtered.length} file${filtered.length === 1 ? '' : 's'}** changed · +${stats.additions} −${stats.deletions}`,
      '',
      '## Files',
      statText(filtered),
      ...(diff
        ? ['', '## Diff', '```diff', diff.slice(0, 12_000), '```', diff.length >= 12_000 ? '_Diff truncated._' : '']
        : []),
    ].join('\n');
    const result = this.write({
      kind: 'change',
      title: truncate(commit.subject, 180),
      body,
      status: 'committed',
      project,
      agent,
      session: options.session,
      tags: ['git', 'commit', ...(commit.branch ? [commit.branch] : [])],
      files: fileNames,
      metadata: {
        source: 'git',
        scope: 'commit',
        sha: commit.sha,
        shortSha: commit.shortSha,
        author: commit.authorName,
        authorEmail: commit.authorEmail,
        branch: commit.branch,
        additions: stats.additions,
        deletions: stats.deletions,
        fileCount: filtered.length,
        committedAt: commit.date,
        dedupe_key: dedupeKey,
      },
      dedupe_key: dedupeKey,
      no_auto_link: false,
    });
    if (result.created) {
      projectCaptured[commit.sha] = result.note.id;
      const entries = Object.entries(projectCaptured).slice(-300);
      captured[project] = Object.fromEntries(entries);
      this.vault.writeState('captured', captured);
    }
    return {
      notes: [result.note],
      created: result.created ? 1 : 0,
      existing: result.deduped ? 1 : 0,
      mode: 'commit',
      summary: `${result.deduped ? 'Already captured' : 'Captured'} commit ${commit.shortSha}: ${commit.subject} · ${filtered.length} files, +${stats.additions} −${stats.deletions}.`,
    };
    });
  }

  captureFile(input: CaptureFileInput): Note | null {
    return this.vault.withWriteLock(() => {
    const project = this.resolveProject(input.project);
    const agent = handle(input.agent || this.defaultAgent);
    const cwd = input.cwd ? path.resolve(input.cwd) : this.cwd;
    const workspaceRoot = repoRoot(cwd) || cwd;
    const absolutePath = path.isAbsolute(input.path) ? input.path : path.resolve(cwd, input.path);
    let filePath = normalizeFilePath(path.relative(workspaceRoot, absolutePath));
    if (!filePath || filePath.startsWith('..')) return null;
    if (isSensitivePath(filePath) || isIgnoredPath(filePath) || filePath.includes('.cairn/')) {
      return null;
    }
    const dateKey = new Date().toISOString().slice(0, 10);
    const worklogKey = `${safeKey(agent)}|${safeKey(input.clientSession || 'adhoc')}|${safeKey(project)}|${dateKey}`;
    const worklogs = this.vault.readState<Record<string, WorklogState>>('worklogs', {});
    let state = worklogs[worklogKey];
    let note: Note | null = null;
    if (state?.notePath) note = this.vault.readNoteFile(state.notePath);
    const clientSession = input.clientSession
      ? this.getClientSession(agent, input.clientSession)
      : undefined;
    const sessionId = clientSession?.cairnSessionId;
    const now = new Date().toISOString();
    if (!note) {
      note = {
        id: newId(),
        kind: 'change',
        title: `Worklog — ${humanizeHandle(agent)} · ${humanizeHandle(project)} · ${dateKey}`,
        status: 'in_progress',
        project,
        agent,
        session: sessionId,
        tags: ['worklog', 'auto-captured'],
        files: [],
        to: [],
        related: [],
        supersedes: [],
        relations: [],
        created: now,
        updated: now,
        body: '',
        path: '',
        metadata: {
          source: 'hook',
          clientSession: input.clientSession,
          tool: input.tool,
          edits: 0,
          cwd,
        },
        aliases: [],
      };
      note.path = this.vault.makeNotePath(note);
    }
    if (!note.files.includes(filePath) && note.files.length < 250) note.files.push(filePath);
    note.session = sessionId || note.session;
    note.updated = now;
    note.status = 'in_progress';
    note.metadata = {
      ...note.metadata,
      lastTool: input.tool || note.metadata.lastTool,
      lastPath: filePath,
      lastEditAt: now,
      edits: Number(note.metadata.edits || 0) + 1,
      ...(input.clientSession ? { clientSession: input.clientSession } : {}),
    };
    const shown = note.files.slice(-100);
    note.body = [
      'Automatically captured from coding-agent file edits.',
      '',
      '## Files touched',
      ...shown.map((file) => `- \`${file}\``),
      ...(note.files.length > shown.length ? [`- _…and ${note.files.length - shown.length} more_`] : []),
      '',
      '## Activity',
      `Last edit **${new Date(now).toLocaleString()}**${input.tool ? ` via \`${input.tool}\`` : ''}.`,
      `${Number(note.metadata.edits || 0)} edit${Number(note.metadata.edits || 0) === 1 ? '' : 's'} captured in this worklog.`,
    ].join('\n');
    this.vault.writeNote(note);
    worklogs[worklogKey] = {
      noteId: note.id,
      notePath: note.path,
      agent,
      project,
      clientSession: input.clientSession,
      cairnSession: sessionId,
      createdAt: state?.createdAt || now,
      updatedAt: now,
      edits: Number(note.metadata.edits || 0),
    };
    const pruned = Object.entries(worklogs)
      .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))
      .slice(0, 300);
    this.vault.writeState('worklogs', Object.fromEntries(pruned));
    this.touchPresence(agent, { project, session: sessionId, cwd });
    return note;
    });
  }

  saveClientSession(agent: string, clientSession: string, state: ClientSessionState): void {
    this.vault.withWriteLock(() => {
    const sessions = this.vault.readState<Record<string, ClientSessionState>>('clientSessions', {});
    sessions[`${handle(agent)}:${clientSession}`] = state;
    const pruned = Object.entries(sessions)
      .sort((a, b) => Date.parse(b[1].startedAt) - Date.parse(a[1].startedAt))
      .slice(0, 300);
    this.vault.writeState('clientSessions', Object.fromEntries(pruned));
    });
  }

  getClientSession(agent: string, clientSession: string): ClientSessionState | undefined {
    const sessions = this.vault.readState<Record<string, ClientSessionState>>('clientSessions', {});
    return sessions[`${handle(agent)}:${clientSession}`];
  }

  touchPresence(
    agent: string,
    options: { project?: string; session?: string; cwd?: string; client?: string } = {},
  ): void {
    this.vault.withWriteLock(() => {
    const key = handle(agent);
    const presence = this.vault.readPresence();
    const existing = presence[key];
    const lastSeen = existing ? Date.parse(existing.lastSeen) : 0;
    if (
      existing &&
      Date.now() - lastSeen < 10_000 &&
      existing.session === options.session &&
      existing.project === options.project
    ) {
      return;
    }
    const now = new Date().toISOString();
    presence[key] = {
      agent: key,
      project: options.project ? handle(options.project) : existing?.project,
      session: options.session || existing?.session,
      cwd: options.cwd || existing?.cwd,
      client: options.client || existing?.client,
      startedAt: existing?.startedAt || now,
      lastSeen: now,
    };
    this.vault.writePresence(presence);
    });
  }

  clearPresence(agent: string, session?: string): void {
    this.vault.withWriteLock(() => {
    const key = handle(agent);
    const presence = this.vault.readPresence();
    const existing = presence[key];
    if (!existing) return;
    if (session && existing.session && existing.session !== session) return;
    delete presence[key];
    this.vault.writePresence(presence);
    });
  }

  context(project?: string, agent?: string): ContextData {
    this.index.refresh();
    const p = this.resolveProject(project);
    const a = handle(agent || this.defaultAgent);
    const notes = Array.from(this.index.notes.values())
      .filter((note) => note.project === p && note.status !== 'archived')
      .sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated));
    const byKind = (kinds: Kind[], statuses?: string[], limit = 6) =>
      notes
        .filter((note) => kinds.includes(note.kind))
        .filter((note) => !statuses || statuses.includes(note.status))
        .slice(0, limit)
        .map((note) => this.index.summary(note));
    const counts = this.index.kindCounts(p);
    return {
      project: p,
      agent: a,
      generatedAt: new Date().toISOString(),
      counts,
      total: notes.length,
      decisions: byKind(['decision'], ['accepted'], 6),
      proposals: byKind(['decision'], ['proposed'], 5),
      questions: byKind(['question'], ['open'], 5),
      risks: byKind(['risk'], ['open'], 4),
      tasks: byKind(['task'], ['todo', 'doing', 'blocked'], 4),
      changes: byKind(['change'], undefined, 6),
      sessions: byKind(['session'], ['active', 'done'], 3),
      conventions: notes
        .filter(
          (note) =>
            note.kind === 'spec' ||
            note.tags.includes('convention') ||
            note.tags.includes('architecture') ||
            note.tags.includes('rule'),
        )
        .slice(0, 5)
        .map((note) => this.index.summary(note)),
      handoffs: notes
        .filter((note) => note.kind === 'handoff')
        .filter((note) => note.status !== 'done')
        .filter((note) => !note.to.length || note.to.includes(a) || note.to.includes('*'))
        .slice(0, 5)
        .map((note) => this.index.summary(note)),
      messages: notes
        .filter((note) => note.kind === 'message')
        .filter((note) => note.status === 'unread')
        .filter((note) => note.to.includes(a) || note.to.includes('*'))
        .slice(0, 6)
        .map((note) => this.index.summary(note)),
      agents: this.agentsInfo(p).slice(0, 6),
      files: this.index.fileActivity(p, 6),
    };
  }

  renderContext(project?: string, agent?: string, compact = false): string {
    return renderContext(this.context(project, agent), { compact });
  }

  agentsInfo(project?: string): AgentInfo[] {
    this.index.refresh();
    const p = project ? this.resolveProject(project) : undefined;
    const presence = this.vault.readPresence();
    const map = new Map<string, AgentInfo>();
    const ensure = (name: string): AgentInfo => {
      const key = handle(name);
      if (!map.has(key)) {
        map.set(key, {
          id: `agent:${key}`,
          name: key,
          label: humanizeHandle(key),
          online: false,
          counts: {},
          total: 0,
          recent: [],
        });
      }
      return map.get(key)!;
    };
    for (const note of this.index.notes.values()) {
      if (p && note.project !== p) continue;
      if (note.status === 'archived') continue;
      if (note.agent) {
        const info = ensure(note.agent);
        info.total += 1;
        info.counts[note.kind] = (info.counts[note.kind] || 0) + 1;
        if (info.recent.length < 3) info.recent.push(this.index.summary(note));
      }
      for (const to of note.to) {
        if (to && to !== '*' && to !== 'all') ensure(to);
      }
    }
    for (const entry of Object.values(presence)) {
      if (p && entry.project && entry.project !== p) continue;
      const info = ensure(entry.agent);
      const lastSeen = Date.parse(entry.lastSeen);
      info.online = Number.isFinite(lastSeen) && Date.now() - lastSeen < 3 * 60_000;
      info.lastSeen = entry.lastSeen;
      info.project = entry.project;
      info.session = entry.session;
      if (entry.session) {
        const sessionNote = this.index.getNote(entry.session);
        if (sessionNote) {
          info.sessionTitle = sessionNote.title;
          info.goal = typeof sessionNote.metadata?.goal === 'string' ? sessionNote.metadata.goal : undefined;
        }
      }
    }
    for (const info of map.values()) {
      if (!info.session) {
        const session = Array.from(this.index.notes.values())
          .filter(
            (note) =>
              note.kind === 'session' &&
              note.agent === info.name &&
              (!p || note.project === p) &&
              note.status === 'active',
          )
          .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))[0];
        if (session) {
          info.session = session.id;
          info.sessionTitle = session.title;
          info.goal = typeof session.metadata?.goal === 'string' ? session.metadata.goal : undefined;
        }
      }
      info.recent.sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated));
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        b.total - a.total ||
        a.label.localeCompare(b.label),
    );
  }

  projectsInfo(): ProjectInfo[] {
    this.index.refresh();
    const map = new Map<string, ProjectInfo>();
    const ensure = (name: string): ProjectInfo => {
      const key = handle(name || 'workspace');
      if (!map.has(key)) {
        map.set(key, {
          name: key,
          label: humanizeHandle(key),
          total: 0,
          counts: {},
          agents: [],
          openDecisions: 0,
          openQuestions: 0,
          files: 0,
          lastActivity: new Date(0).toISOString(),
        });
      }
      return map.get(key)!;
    };
    const fileSets = new Map<string, Set<string>>();
    for (const note of this.index.notes.values()) {
      if (note.status === 'archived') continue;
      const info = ensure(note.project || 'workspace');
      info.total += 1;
      info.counts[note.kind] = (info.counts[note.kind] || 0) + 1;
      if (note.agent && !info.agents.includes(note.agent)) info.agents.push(note.agent);
      if (note.kind === 'decision' && note.status === 'proposed') info.openDecisions += 1;
      if (note.kind === 'question' && note.status === 'open') info.openQuestions += 1;
      if (Date.parse(note.updated) > Date.parse(info.lastActivity)) info.lastActivity = note.updated;
      if (note.files.length) {
        const key = info.name;
        if (!fileSets.has(key)) fileSets.set(key, new Set());
        for (const file of note.files) fileSets.get(key)!.add(file);
      }
    }
    for (const [key, files] of fileSets) {
      const info = map.get(key);
      if (info) info.files = files.size;
    }
    return Array.from(map.values()).sort(
      (a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity),
    );
  }

  stats(project?: string): VaultStats {
    this.index.refresh();
    const p = project ? this.resolveProject(project) : undefined;
    const byKind = this.index.kindCounts(p);
    let unreadMessages = 0;
    let activeSessions = 0;
    let noteCount = 0;
    for (const note of this.index.notes.values()) {
      if (p && note.project !== p) continue;
      noteCount += 1;
      if (note.kind === 'message' && note.status === 'unread') unreadMessages += 1;
      if (note.kind === 'session' && note.status === 'active') activeSessions += 1;
    }
    const edgeCount = p ? this.index.graph({ project: p }).edges.length : this.index.edgeCount;
    return {
      notes: p ? noteCount : this.index.noteCount,
      edges: edgeCount,
      projects: this.projectsInfo().length,
      agents: this.agentsInfo(p).length,
      byKind,
      unreadMessages,
      activeSessions,
      vaultPath: this.vault.dir,
      project: this.defaultProject,
    };
  }

  graph(options: GraphOptions = {}): ReturnType<VaultIndex['graph']> {
    return this.index.graph(options);
  }

  exportData() {
    this.index.refresh(true);
    return {
      generatedAt: new Date().toISOString(),
      vault: {
        path: this.vault.dir,
        name: this.vault.config.name,
        project: this.defaultProject,
      },
      notes: Array.from(this.index.notes.values()),
      edges: this.index.edges,
      graph: this.index.graph({ includeVirtual: true, limit: 2000, depth: 4 }),
      projects: this.projectsInfo(),
      agents: this.agentsInfo(),
    };
  }

  noteFilePath(note: Note): string {
    return path.join(this.vault.dir, note.path);
  }

  exists(): boolean {
    return fs.existsSync(this.vault.dir);
  }
}
