import fs from 'node:fs';
import path from 'node:path';
import { handle } from './ids.js';
import {
  agentNodeId,
  extractWikiLinks,
  fileNodeId,
  missingNodeId,
  normalizeFilePath,
  normalizeRef,
  projectNodeId,
  type WikiLink,
} from './links.js';
import { humanizeHandle, stripMarkdown } from './text.js';
import type {
  AnyEdgeType,
  Edge,
  GraphData,
  GraphEdge,
  GraphNode,
  GraphOptions,
  Kind,
  NodeKind,
  Note,
  NoteSummary,
  SearchHit,
  SearchOptions,
} from './types.js';
import type { Vault } from './vault.js';

interface Entry {
  note: Note;
  signature: string;
  wiki: WikiLink[];
  lowerTitle: string;
  lowerBody: string;
  lowerTags: string;
  lowerProject: string;
  lowerAgent: string;
  plain: string;
  plainCompact: string;
}

export interface TargetInfo {
  id: string;
  label: string;
  kind: NodeKind;
  note?: Note;
  project?: string;
  path?: string;
  status?: string;
  updated?: string;
}

export interface Neighbor {
  edge: Edge;
  node: GraphNode;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where', 'which', 'into',
  'about', 'have', 'has', 'are', 'was', 'were', 'will', 'would', 'should', 'could', 'our', 'your',
  'how', 'why', 'who', 'all', 'any', 'can', 'not', 'but', 'its', 'it', 'is', 'of', 'to', 'in', 'on',
  'a', 'an', 'as', 'at', 'by', 'or', 'be', 'we', 'i',
]);

function tokensFor(query: string): string[] {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}_'/-]+/gu) || [])
    .map((token) => token.replace(/^[-'/]+|[-'/]+$/g, ''))
    .filter((token) => token.length > 1 || /[\u3400-\u9fff]/.test(token))
    .filter((token) => !STOPWORDS.has(token));
  return Array.from(new Set(tokens)).slice(0, 14);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (count < 20) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function dateMs(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

export class VaultIndex {
  readonly vault: Vault;
  notes = new Map<string, Note>();
  virtual = new Map<string, TargetInfo>();
  edges: Edge[] = [];
  warnings: string[] = [];

  private entries = new Map<string, Entry>();
  private parseFailures = new Map<string, string>();
  private bySlug = new Map<string, Note>();
  private byAlias = new Map<string, Note>();
  private byPath = new Map<string, Note>();
  private outgoing = new Map<string, Edge[]>();
  private backlinks = new Map<string, Edge[]>();
  private degrees = new Map<string, number>();
  private fileNotes = new Map<string, Set<string>>();
  private edgeMap = new Map<string, Edge>();
  private lastRefresh = 0;
  private refreshMs: number;
  private built = false;
  private treeMtime = '';
  private lastFullScan = 0;
  private static readonly FULL_SCAN_MS = 30_000;

  constructor(vault: Vault, options: { refreshMs?: number } = {}) {
    this.vault = vault;
    this.refreshMs = options.refreshMs ?? 250;
  }

  /** Cheap O(#kind-folders) fingerprint of the notes tree.
   *  Cairn writes are atomic renames into notes/<kind>/, which bump that subdirectory's
   *  mtime. If the fingerprint is unchanged, no note was added/removed/renamed and the
   *  entries cache is still valid — skip the O(n) walk. A periodic full scan catches
   *  hand-edited files whose content mtime changed without touching a directory mtime. */
  private fingerprint(): string {
    const mtimes: number[] = [];
    try {
      for (const entry of fs.readdirSync(this.vault.notesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          mtimes.push(fs.statSync(path.join(this.vault.notesDir, entry.name)).mtimeMs);
        } catch {
          // A subdir may be created and removed between readdir and stat.
        }
      }
    } catch {
      // The notes dir may not exist yet on first run.
    }
    mtimes.sort((a, b) => a - b);
    return mtimes.join(',');
  }

  refresh(force = false): void {
    const now = Date.now();
    if (!force && this.built && now - this.lastRefresh < this.refreshMs) return;
    if (!force && this.built && this.treeMtime !== '' && now - this.lastFullScan < VaultIndex.FULL_SCAN_MS) {
      if (this.fingerprint() === this.treeMtime) return;
    }
    this.lastRefresh = now;
    this.lastFullScan = now;
    const files = this.vault.listNoteFiles();
    this.treeMtime = this.fingerprint();
    const seen = new Set<string>();
    let changed = !this.built;
    for (const file of files) {
      seen.add(file.rel);
      const signature = `${file.mtimeMs}:${file.size}`;
      const existing = this.entries.get(file.rel);
      if (existing && existing.signature === signature) continue;
      if (this.parseFailures.get(file.rel) === signature) continue;
      try {
        const note = this.vault.readNoteFile(file.rel);
        if (!note) {
          this.parseFailures.set(file.rel, signature);
          if (existing) {
            this.entries.delete(file.rel);
            changed = true;
          }
          continue;
        }
        this.parseFailures.delete(file.rel);
        this.entries.set(file.rel, this.makeEntry(note, signature));
        changed = true;
      } catch (error) {
        this.parseFailures.set(file.rel, signature);
        this.warnings.push(`Could not read ${file.rel}: ${(error as Error).message}`);
      }
    }
    for (const rel of Array.from(this.entries.keys())) {
      if (!seen.has(rel)) {
        this.entries.delete(rel);
        changed = true;
      }
    }
    for (const rel of Array.from(this.parseFailures.keys())) {
      if (!seen.has(rel)) this.parseFailures.delete(rel);
    }
    if (changed || !this.built) this.rebuild();
  }

  private makeEntry(note: Note, signature: string): Entry {
    const plain = stripMarkdown(note.body);
    return {
      note,
      signature,
      wiki: extractWikiLinks(note.body),
      lowerTitle: note.title.toLowerCase(),
      lowerBody: plain.toLowerCase(),
      lowerTags: note.tags.join(' ').toLowerCase(),
      lowerProject: (note.project || '').toLowerCase(),
      lowerAgent: (note.agent || '').toLowerCase(),
      plain,
      plainCompact: plain.replace(/\s+/g, ' ').trim(),
    };
  }

  private rebuild(): void {
    this.notes.clear();
    this.bySlug.clear();
    this.byAlias.clear();
    this.byPath.clear();
    this.virtual.clear();
    this.edgeMap.clear();
    this.fileNotes.clear();
    this.warnings = [];
    const notes = Array.from(this.entries.values())
      .map((entry) => entry.note)
      .sort((a, b) => dateMs(b.updated) - dateMs(a.updated));
    for (const note of notes) {
      if (this.notes.has(note.id)) {
        this.warnings.push(`Duplicate note id ${note.id} at ${note.path}; keeping the newest.`);
        continue;
      }
      this.notes.set(note.id, note);
    }
    const canonical = Array.from(this.notes.values());
    for (const note of canonical) {
      const stem = path.basename(note.path, '.md').toLowerCase();
      const slug = normalizeRef(stem);
      if (stem && !this.bySlug.has(stem)) this.bySlug.set(stem, note);
      if (slug && !this.bySlug.has(slug)) this.bySlug.set(slug, note);
      const titleKey = normalizeRef(note.title);
      if (titleKey && !this.byAlias.has(titleKey)) this.byAlias.set(titleKey, note);
      for (const alias of note.aliases) {
        const key = normalizeRef(alias);
        if (key && !this.byAlias.has(key)) this.byAlias.set(key, note);
      }
      const relKey = note.path.toLowerCase();
      this.byPath.set(relKey, note);
      this.byPath.set(relKey.replace(/\.md$/, ''), note);
    }

    for (const note of canonical) {
      const entry = this.entries.get(note.path);
      if (note.project) {
        this.addEdge(note.id, projectNodeId(note.project), 'part_of');
        this.registerVirtual(projectNodeId(note.project), 'project', humanizeHandle(note.project), {
          project: note.project,
        });
      }
      if (note.agent) {
        this.addEdge(note.id, agentNodeId(note.agent), 'authored_by');
        this.registerVirtual(agentNodeId(note.agent), 'agent', humanizeHandle(note.agent), {
          project: note.project,
        });
      }
      if (note.session) {
        const sessionNote = this.resolveNote(note.session);
        if (sessionNote) {
          this.addEdge(note.id, sessionNote.id, 'in_session');
        } else {
          const id = `session:${normalizeRef(note.session) || note.session}`;
          this.addEdge(note.id, id, 'in_session');
          this.registerVirtual(id, 'session', `Session ${note.session.slice(-6)}`, {
            project: note.project,
          });
        }
      }
      for (const to of note.to) {
        if (to === '*' || to === 'all' || to === 'everyone') continue;
        this.addEdge(note.id, agentNodeId(to), 'addressed_to');
        this.registerVirtual(agentNodeId(to), 'agent', humanizeHandle(to), {
          project: note.project,
        });
      }
      for (const file of note.files) {
        const id = fileNodeId(note.project, file);
        this.addEdge(note.id, id, 'touches');
        this.registerVirtual(id, 'file', path.basename(file), {
          project: note.project,
          path: normalizeFilePath(file),
        });
        const key = normalizeFilePath(file).toLowerCase();
        if (!this.fileNotes.has(key)) this.fileNotes.set(key, new Set());
        this.fileNotes.get(key)!.add(note.id);
      }
      for (const ref of note.related) {
        const target = this.resolveTarget(ref, note.project);
        this.addEdge(note.id, target.id, 'relates_to');
      }
      for (const ref of note.supersedes) {
        const target = this.resolveTarget(ref, note.project);
        this.addEdge(note.id, target.id, 'supersedes');
      }
      if (note.repliesTo) {
        const target = this.resolveTarget(note.repliesTo, note.project);
        this.addEdge(note.id, target.id, 'replies_to');
      }
      for (const relation of note.relations) {
        const target = this.resolveTarget(relation.to, note.project);
        this.addEdge(note.id, target.id, relation.type || 'relates_to');
      }
      if (entry) {
        for (const link of entry.wiki) {
          const target = this.resolveTarget(link.target, note.project);
          const type: AnyEdgeType = target.kind === 'file' ? 'touches' : 'mentions';
          this.addEdge(note.id, target.id, type);
        }
      }
    }

    this.edges = Array.from(this.edgeMap.values());
    this.outgoing.clear();
    this.backlinks.clear();
    this.degrees.clear();
    for (const edge of this.edges) {
      if (!this.outgoing.has(edge.from)) this.outgoing.set(edge.from, []);
      if (!this.backlinks.has(edge.to)) this.backlinks.set(edge.to, []);
      this.outgoing.get(edge.from)!.push(edge);
      this.backlinks.get(edge.to)!.push(edge);
      this.degrees.set(edge.from, (this.degrees.get(edge.from) || 0) + 1);
      this.degrees.set(edge.to, (this.degrees.get(edge.to) || 0) + 1);
    }
    this.built = true;
  }

  private addEdge(from: string, to: string, type: AnyEdgeType, weight = 1): void {
    if (!from || !to || from === to) return;
    const edgeType = handle(String(type || 'relates_to')).replace(/\//g, '-');
    const key = `${from}\u0000${to}\u0000${edgeType}`;
    const existing = this.edgeMap.get(key);
    if (existing) {
      existing.weight = Math.min(9, existing.weight + weight);
      return;
    }
    this.edgeMap.set(key, { from, to, type: edgeType, weight });
  }

  private registerVirtual(
    id: string,
    kind: NodeKind,
    label: string,
    extra: { project?: string; path?: string; status?: string; updated?: string } = {},
  ): void {
    const current = this.virtual.get(id);
    if (current) {
      if (!current.project && extra.project) current.project = extra.project;
      if (!current.path && extra.path) current.path = extra.path;
      return;
    }
    this.virtual.set(id, { id, kind, label, ...extra });
  }

  resolveNote(ref: string): Note | null {
    if (!ref) return null;
    let raw = ref.trim();
    if (raw.startsWith('[[') && raw.endsWith(']]')) raw = raw.slice(2, -2).split('|')[0] || '';
    raw = raw.split('#')[0]?.trim() || '';
    if (!raw) return null;
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Keep the raw value if it is not valid URI encoding.
    }
    const byId = this.notes.get(raw);
    if (byId) return byId;
    const lower = raw.toLowerCase();
    const byPath = this.byPath.get(lower) || this.byPath.get(lower.replace(/\.md$/, ''));
    if (byPath) return byPath;
    const normalized = normalizeRef(raw);
    return (
      this.bySlug.get(lower) ||
      this.bySlug.get(normalized) ||
      this.byAlias.get(normalized) ||
      this.byAlias.get(lower) ||
      null
    );
  }

  getNote(ref: string): Note | null {
    this.refresh();
    return this.resolveNote(ref);
  }

  resolveTarget(ref: string, project?: string): TargetInfo {
    const raw = ref.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
    const note = this.resolveNote(raw);
    if (note) {
      return {
        id: note.id,
        label: note.title,
        kind: note.kind,
        note,
        project: note.project,
        status: note.status,
        updated: note.updated,
      };
    }
    const lower = raw.toLowerCase();
    if (lower.startsWith('file:')) {
      let filePath = raw.slice(5).trim();
      const prefix = `${project || 'workspace'}:`;
      if (filePath.toLowerCase().startsWith(prefix.toLowerCase())) filePath = filePath.slice(prefix.length);
      const normalized = normalizeFilePath(filePath);
      const id = fileNodeId(project, normalized);
      this.registerVirtual(id, 'file', path.basename(normalized), { project, path: normalized });
      return { id, label: path.basename(normalized), kind: 'file', project, path: normalized };
    }
    if (lower.startsWith('project:')) {
      const name = handle(raw.slice(8));
      const id = projectNodeId(name);
      this.registerVirtual(id, 'project', humanizeHandle(name), { project: name });
      return { id, label: humanizeHandle(name), kind: 'project', project: name };
    }
    if (lower.startsWith('agent:')) {
      const name = handle(raw.slice(6));
      const id = agentNodeId(name);
      this.registerVirtual(id, 'agent', humanizeHandle(name), { project });
      return { id, label: humanizeHandle(name), kind: 'agent', project };
    }
    if (lower.startsWith('session:')) {
      const sessionRef = raw.slice(8).trim();
      const sessionNote = this.resolveNote(sessionRef);
      if (sessionNote) {
        return {
          id: sessionNote.id,
          label: sessionNote.title,
          kind: 'session',
          note: sessionNote,
          project: sessionNote.project,
          status: sessionNote.status,
          updated: sessionNote.updated,
        };
      }
      const id = `session:${normalizeRef(sessionRef) || sessionRef}`;
      this.registerVirtual(id, 'session', `Session ${sessionRef.slice(-6)}`, { project });
      return { id, label: `Session ${sessionRef.slice(-6)}`, kind: 'session', project };
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|cpp|cc|c|h|hpp|md|json|ya?ml|toml|sql|sh|bash|css|scss|html|vue|svelte|astro)$/i.test(raw)) {
      const normalized = normalizeFilePath(raw);
      const id = fileNodeId(project, normalized);
      this.registerVirtual(id, 'file', path.basename(normalized), { project, path: normalized });
      return { id, label: path.basename(normalized), kind: 'file', project, path: normalized };
    }
    const id = missingNodeId(raw);
    this.registerVirtual(id, 'missing', raw, { project });
    return { id, label: raw, kind: 'missing', project };
  }

  nodeInfo(id: string, degreeOverride?: number): GraphNode | null {
    const note = this.notes.get(id);
    if (note) {
      return {
        id: note.id,
        label: note.title,
        kind: note.kind,
        noteId: note.id,
        status: note.status,
        project: note.project,
        agent: note.agent,
        degree: degreeOverride ?? this.degrees.get(id) ?? 0,
        updated: note.updated,
      };
    }
    const target = this.virtual.get(id);
    if (!target) return null;
    return {
      id: target.id,
      label: target.label,
      kind: target.kind,
      project: target.project,
      path: target.path,
      degree: degreeOverride ?? this.degrees.get(id) ?? 0,
      updated: target.updated,
    };
  }

  degree(id: string): number {
    return this.degrees.get(id) || 0;
  }

  summary(note: Note): NoteSummary {
    const entry = this.entries.get(note.path);
    const plain = entry?.plain || stripMarkdown(note.body);
    return {
      id: note.id,
      kind: note.kind,
      title: note.title,
      status: note.status,
      project: note.project,
      agent: note.agent,
      session: note.session,
      tags: note.tags,
      files: note.files,
      to: note.to,
      created: note.created,
      updated: note.updated,
      path: note.path,
      snippet: plain.slice(0, 240).replace(/\s+/g, ' ').trim(),
      degree: this.degree(note.id),
    };
  }

  search(options: SearchOptions = {}): SearchHit[] {
    this.refresh();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const query = (options.query || '').trim();
    const phrases = Array.from(query.matchAll(/"([^"]+)"/g)).map((match) => match[1]!.toLowerCase());
    const tokens = tokensFor(query.replace(/"[^"]*"/g, ' '));
    const filter = this.buildFilterPredicate(options);
    // Collect lightweight records first, then build summary/snippet only for the
    // notes that survive the sort + slice — not all candidates.
    const rows: Array<{ note: Note; entry: Entry; score: number; matched: Set<string> }> = [];

    for (const note of this.notes.values()) {
      if (!filter(note)) continue;
      const entry = this.entries.get(note.path);
      if (!entry) continue;
      const matched = new Set<string>();
      let score = 0;
      if (tokens.length) {
        let allMatched = true;
        for (const token of tokens) {
          let tokenScore = 0;
          if (entry.lowerTitle.includes(token)) {
            tokenScore += 12;
            matched.add('title');
            if (entry.lowerTitle.startsWith(token)) tokenScore += 4;
          }
          if (entry.lowerTags.includes(token)) {
            tokenScore += 8;
            matched.add('tags');
          }
          if (entry.lowerProject.includes(token)) {
            tokenScore += 4;
            matched.add('project');
          }
          if (entry.lowerAgent.includes(token)) {
            tokenScore += 4;
            matched.add('agent');
          }
          if (note.kind.includes(token)) {
            tokenScore += 2;
            matched.add('kind');
          }
          const occurrences = countOccurrences(entry.lowerBody, token);
          if (occurrences > 0) {
            tokenScore += 1.5 + Math.min(occurrences, 8);
            matched.add('body');
          }
          if (tokenScore === 0) allMatched = false;
          score += tokenScore;
        }
        if (!allMatched) continue;
        for (const phrase of phrases) {
          if (entry.lowerTitle.includes(phrase)) {
            score += 30;
            matched.add('title');
          } else if (entry.lowerBody.includes(phrase)) {
            score += 12;
            matched.add('body');
          }
        }
      }
      const ageDays = Math.max(0, (Date.now() - dateMs(note.updated)) / 86_400_000);
      score += 4 * Math.exp(-ageDays / 14);
      score += Math.min(2, this.degree(note.id) * 0.12);
      if (note.status === 'proposed' || note.status === 'open' || note.status === 'unread') {
        score += 0.5;
      }
      rows.push({ note, entry, score, matched });
    }

    const sort = options.sort || (query ? 'relevance' : 'updated');
    if (sort === 'created') {
      rows.sort((a, b) => dateMs(b.note.created) - dateMs(a.note.created));
    } else if (sort === 'updated' || !query) {
      rows.sort((a, b) => dateMs(b.note.updated) - dateMs(a.note.updated));
    } else {
      rows.sort((a, b) => b.score - a.score || dateMs(b.note.updated) - dateMs(a.note.updated));
    }
    return rows.slice(offset, offset + limit).map(({ note, entry, score, matched }) => ({
      note: this.summary(note),
      score: Number(score.toFixed(3)),
      snippet: this.snippet(entry, tokens, phrases),
      matched: Array.from(matched),
    }));
  }

  private snippet(entry: Entry, tokens: string[], phrases: string[]): string {
    const plain = entry.plainCompact;
    if (!plain) return '';
    const candidates = [...phrases, ...tokens];
    // Search case-insensitively (tokens/phrases are lowercased), display original case.
    const lower = plain.toLowerCase();
    let index = -1;
    for (const candidate of candidates) {
      const found = lower.indexOf(candidate);
      if (found !== -1 && (index === -1 || found < index)) index = found;
    }
    if (index === -1) return plain.slice(0, 220) + (plain.length > 220 ? '…' : '');
    const start = Math.max(0, index - 70);
    const end = Math.min(plain.length, index + 150);
    return `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`;
  }

  private buildFilterPredicate(options: SearchOptions): (note: Note) => boolean {
    const kindsSet = options.kinds?.length ? new Set(options.kinds) : null;
    const targetProject = options.project ? handle(options.project) : null;
    const targetAgent = options.agent ? handle(options.agent) : null;
    const targetSession = options.session || null;
    const requiredTags = options.tags?.length ? options.tags.map(handle) : null;
    const includeArchived = Boolean(options.includeArchived);
    const statuses = options.status
      ? (Array.isArray(options.status) ? options.status : [options.status]).map(handle)
      : null;
    const sinceMs = options.since ? dateMs(options.since) : null;
    const untilMs = options.until ? dateMs(options.until) : null;
    const createdSinceMs = options.createdSince ? dateMs(options.createdSince) : null;
    const targetTo = options.to ? handle(options.to) : null;
    const targetFiles = options.files?.length
      ? options.files.map((file) => normalizeFilePath(file).toLowerCase())
      : null;

    return (note: Note): boolean => {
      if (kindsSet && !kindsSet.has(note.kind)) return false;
      if (targetProject && note.project !== targetProject) return false;
      if (targetAgent && note.agent !== targetAgent) return false;
      if (targetSession && note.session !== targetSession) return false;
      if (!includeArchived && note.status === 'archived') return false;
      if (statuses && !statuses.includes(note.status)) return false;
      if (createdSinceMs !== null && dateMs(note.created) < createdSinceMs) return false;
      if (sinceMs !== null && dateMs(note.updated) < sinceMs) return false;
      if (untilMs !== null && dateMs(note.updated) > untilMs) return false;
      if (targetTo && !note.to.some((entry) => entry === targetTo || entry === '*')) return false;
      if (requiredTags) {
        const noteTags = new Set(note.tags);
        if (!requiredTags.every((tag) => noteTags.has(tag))) return false;
      }
      if (targetFiles) {
        const noteFiles = note.files.map((file) => file.toLowerCase());
        const matches = targetFiles.some((needle) =>
          noteFiles.some(
            (candidate) => candidate === needle || candidate.endsWith(`/${needle}`) || needle.endsWith(`/${candidate}`),
          ),
        );
        if (!matches) return false;
      }
      return true;
    };
  }

  graph(options: GraphOptions = {}): GraphData {
    this.refresh();
    const limit = Math.min(Math.max(options.limit ?? 400, 1), 2000);
    const depth = Math.min(Math.max(options.depth ?? 2, 1), 4);
    const includeVirtual = options.includeVirtual !== false;
    const edgeTypes = new Set((options.edgeTypes || []).map(handle));
    const kinds = new Set<Kind>(options.kinds || []);
    const project = options.project ? handle(options.project) : undefined;

    const edgeAllowed = (edge: Edge) => !edgeTypes.size || edgeTypes.has(handle(edge.type));
    const nodeAllowed = (id: string, isSeed = false): { allowed: boolean; note?: Note } => {
      const note = this.notes.get(id);
      if (note) {
        if (isSeed) return { allowed: true, note };
        if (kinds.size && !kinds.has(note.kind)) return { allowed: false, note };
        if (project && note.project !== project) return { allowed: false, note };
        return { allowed: true, note };
      }
      if (!this.virtual.has(id)) return { allowed: false };
      if (!includeVirtual) return { allowed: false };
      if (project) {
        const virtual = this.virtual.get(id)!;
        if (virtual.kind === 'project' && virtual.project !== project) return { allowed: false };
        if (virtual.project && virtual.project !== project) return { allowed: false };
      }
      return { allowed: true };
    };

    const adjacency = new Map<string, Edge[]>();
    for (const edge of this.edges) {
      if (!edgeAllowed(edge)) continue;
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
      adjacency.get(edge.from)!.push(edge);
      adjacency.get(edge.to)!.push(edge);
    }

    let seeds = (options.seeds || [])
      .map((seed) => this.resolveNote(seed)?.id || (this.virtual.has(seed) ? seed : null))
      .filter((seed): seed is string => Boolean(seed));
    if (!seeds.length && options.query) {
      seeds = this.search({ query: options.query, limit: 5, project }).map((hit) => hit.note.id);
    }

    const included = new Set<string>();
    if (seeds.length) {
      type QueueItem = { id: string; distance: number };
      const queue: QueueItem[] = seeds.map((id) => ({ id, distance: 0 }));
      const seedSet = new Set(seeds);
      const seen = new Set<string>();
      let head = 0;
      while (head < queue.length && seen.size < limit * 4) {
        const current = queue[head++]!;
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        const allowed = nodeAllowed(current.id, seedSet.has(current.id));
        if (!allowed.allowed) continue;
        included.add(current.id);
        if (current.distance >= depth) continue;
        for (const edge of adjacency.get(current.id) || []) {
          const other = edge.from === current.id ? edge.to : edge.from;
          if (seen.has(other)) continue;
          const otherAllowed = nodeAllowed(other);
          if (!otherAllowed.allowed) continue;
          queue.push({ id: other, distance: current.distance + 1 });
        }
      }
    } else {
      for (const note of this.notes.values()) {
        if (kinds.size && !kinds.has(note.kind)) continue;
        if (project && note.project !== project) continue;
        if (note.status === 'archived') continue;
        included.add(note.id);
      }
      if (includeVirtual) {
        for (const edge of this.edges) {
          if (!edgeAllowed(edge)) continue;
          if (included.has(edge.from) && this.virtual.has(edge.to)) included.add(edge.to);
          if (included.has(edge.to) && this.virtual.has(edge.from)) included.add(edge.from);
        }
      }
    }

    const seedSet = new Set(seeds);
    const ranked = Array.from(included)
      .map((id) => this.nodeInfo(id))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((a, b) => {
        const aSeed = seedSet.has(a.id) ? 1 : 0;
        const bSeed = seedSet.has(b.id) ? 1 : 0;
        if (aSeed !== bSeed) return bSeed - aSeed;
        const aNote = a.noteId ? 1 : 0;
        const bNote = b.noteId ? 1 : 0;
        if (aNote !== bNote) return bNote - aNote;
        if (a.kind === 'file' && b.kind !== 'file') return 1;
        if (b.kind === 'file' && a.kind !== 'file') return -1;
        return b.degree - a.degree || dateMs(b.updated || '') - dateMs(a.updated || '');
      });
    const kept = ranked.slice(0, limit);
    const keptIds = new Set(kept.map((node) => node.id));
    const localDegrees = new Map<string, number>();
    const graphEdges: GraphEdge[] = [];
    for (const edge of this.edges) {
      if (!edgeAllowed(edge)) continue;
      if (!keptIds.has(edge.from) || !keptIds.has(edge.to)) continue;
      graphEdges.push({ from: edge.from, to: edge.to, type: edge.type, weight: edge.weight });
      localDegrees.set(edge.from, (localDegrees.get(edge.from) || 0) + 1);
      localDegrees.set(edge.to, (localDegrees.get(edge.to) || 0) + 1);
    }
    for (const node of kept) node.degree = localDegrees.get(node.id) || 0;
    kept.sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
    return {
      nodes: kept,
      edges: graphEdges,
      stats: {
        nodes: kept.length,
        edges: graphEdges.length,
        totalNotes: this.notes.size,
        totalEdges: this.edges.length,
        truncated: ranked.length > kept.length,
        seeds: seeds.length ? seeds : undefined,
      },
    };
  }

  neighbors(id: string): { outgoing: Neighbor[]; backlinks: Neighbor[] } {
    this.refresh();
    const note = this.notes.get(id);
    const targetId = note?.id || id;
    const make = (edge: Edge): Neighbor | null => {
      const otherId = edge.from === targetId ? edge.to : edge.from;
      const node = this.nodeInfo(otherId);
      return node ? { edge, node } : null;
    };
    return {
      outgoing: (this.outgoing.get(targetId) || []).map(make).filter((entry): entry is Neighbor => Boolean(entry)),
      backlinks: (this.backlinks.get(targetId) || []).map(make).filter((entry): entry is Neighbor => Boolean(entry)),
    };
  }

  relatedNotes(id: string, limit = 8): Array<{ note: Note; types: string[]; direction: string }> {
    this.refresh();
    const scores = new Map<
      string,
      { note: Note; weight: number; types: Set<string>; directions: Set<string> }
    >();
    const collect = (edges: Edge[], direction: string) => {
      for (const edge of edges) {
        const otherId = edge.from === id ? edge.to : edge.from;
        const note = this.notes.get(otherId);
        if (!note || note.id === id) continue;
        if (!scores.has(otherId)) {
          scores.set(otherId, { note, weight: 0, types: new Set(), directions: new Set() });
        }
        const entry = scores.get(otherId)!;
        entry.weight += edge.weight * (edge.type === 'mentions' ? 0.4 : 1);
        entry.types.add(edge.type);
        entry.directions.add(direction);
      }
    };
    collect(this.outgoing.get(id) || [], 'outgoing');
    collect(this.backlinks.get(id) || [], 'incoming');
    return Array.from(scores.values())
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          dateMs(b.note.updated) - dateMs(a.note.updated),
      )
      .slice(0, limit)
      .map((entry) => ({
        note: entry.note,
        types: Array.from(entry.types),
        direction: Array.from(entry.directions).join('+'),
      }));
  }

  notesTouchingFiles(
    files: string[],
    options: { project?: string; excludeId?: string; kinds?: Kind[]; limit?: number } = {},
  ): Array<{ note: Note; shared: number }> {
    this.refresh();
    const shared = new Map<string, number>();
    const project = options.project ? handle(options.project) : undefined;
    for (const file of files) {
      const key = normalizeFilePath(file).toLowerCase();
      const ids = this.fileNotes.get(key);
      if (!ids) continue;
      for (const id of ids) {
        if (id === options.excludeId) continue;
        shared.set(id, (shared.get(id) || 0) + 1);
      }
    }
    const priority: Partial<Record<Kind, number>> = {
      decision: 6,
      spec: 5,
      insight: 4,
      risk: 4,
      question: 3,
      change: 2,
      task: 2,
    };
    const out: Array<{ note: Note; shared: number }> = [];
    for (const [id, count] of shared) {
      const note = this.notes.get(id);
      if (!note) continue;
      if (project && note.project !== project) continue;
      if (options.kinds?.length && !options.kinds.includes(note.kind)) continue;
      if (note.status === 'archived') continue;
      out.push({ note, shared: count });
    }
    return out
      .sort(
        (a, b) =>
          b.shared - a.shared ||
          (priority[b.note.kind] || 0) - (priority[a.note.kind] || 0) ||
          dateMs(b.note.updated) - dateMs(a.note.updated),
      )
      .slice(0, Math.min(options.limit ?? 6, 20));
  }

  notesBySession(sessionId: string): Note[] {
    this.refresh();
    return Array.from(this.notes.values())
      .filter((note) => note.session === sessionId)
      .sort((a, b) => dateMs(b.created) - dateMs(a.created));
  }

  kindCounts(project?: string): Partial<Record<Kind, number>> {
    this.refresh();
    const counts: Partial<Record<Kind, number>> = {};
    for (const note of this.notes.values()) {
      if (project && note.project !== handle(project)) continue;
      if (note.status === 'archived') continue;
      counts[note.kind] = (counts[note.kind] || 0) + 1;
    }
    return counts;
  }

  fileActivity(project?: string, limit = 8): Array<{ path: string; noteCount: number }> {
    this.refresh();
    const counts = new Map<string, Set<string>>();
    for (const note of this.notes.values()) {
      if (note.status === 'archived') continue;
      if (project && note.project !== handle(project)) continue;
      for (const file of note.files) {
        const key = normalizeFilePath(file);
        if (!counts.has(key)) counts.set(key, new Set());
        counts.get(key)!.add(note.id);
      }
    }
    return Array.from(counts.entries())
      .map(([file, notes]) => ({ path: file, noteCount: notes.size }))
      .sort((a, b) => b.noteCount - a.noteCount || a.path.localeCompare(b.path))
      .slice(0, limit);
  }

  get noteCount(): number {
    this.refresh();
    return this.notes.size;
  }

  get edgeCount(): number {
    this.refresh();
    return this.edges.length;
  }
}
