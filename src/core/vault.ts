import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  DEFAULT_STATUS,
  KIND_FOLDERS,
  KINDS,
  type Kind,
  type Note,
  type PresenceEntry,
  type Relation,
  type VaultConfig,
} from './types.js';
import { handle, shortId, slugify } from './ids.js';
import { normalizeFilePath } from './links.js';
import { isSensitivePath } from './redact.js';

export const CAIRN_VERSION = '0.1.0';
const CONFIG_FILE = 'config.json';

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function findUp(start: string, predicate: (dir: string) => boolean, maxDepth = 12): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < maxDepth; i++) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findProjectRoot(start = process.cwd()): string {
  const found = findUp(start, (dir) => fs.existsSync(path.join(dir, '.git')));
  return found || path.resolve(start);
}

export function detectProjectName(start = process.cwd()): string {
  const root = findProjectRoot(start);
  return handle(path.basename(root) || 'workspace');
}

export function resolveVaultDir(options: { vault?: string; cwd?: string } = {}): string {
  const explicit = options.vault || process.env.CAIRN_VAULT;
  if (explicit) return path.resolve(expandHome(explicit));
  const cwd = path.resolve(options.cwd || process.cwd());
  const localRoot = findUp(cwd, (dir) => fs.existsSync(path.join(dir, '.cairn', CONFIG_FILE)));
  if (localRoot) return path.join(localRoot, '.cairn');
  const globalVault = path.join(os.homedir(), '.cairn');
  if (fs.existsSync(path.join(globalVault, CONFIG_FILE))) return globalVault;
  return path.join(findProjectRoot(cwd), '.cairn');
}

export function vaultExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, CONFIG_FILE));
}

export interface InitOptions {
  cwd?: string;
  project?: string;
  name?: string;
  global?: boolean;
}

export function initVault(dir: string, options: InitOptions = {}): VaultConfig {
  const cwd = options.cwd || process.cwd();
  const project = handle(options.project || detectProjectName(cwd));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true, mode: 0o700 });
  const configPath = path.join(dir, CONFIG_FILE);
  if (fs.existsSync(configPath)) return loadConfig(dir);
  const config: VaultConfig = {
    version: 1,
    name: options.name || (options.global ? 'Personal memory' : project),
    project,
    createdAt: new Date().toISOString(),
    settings: { autoLink: true, redact: true },
  };
  atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n');
  const readmePath = path.join(dir, 'README.md');
  if (!fs.existsSync(readmePath)) atomicWrite(readmePath, vaultReadme(config));
  const ignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignorePath)) atomicWrite(ignorePath, 'state/\n*.tmp\n.DS_Store\n');
  return config;
}

export function loadConfig(dir: string): VaultConfig {
  const file = path.join(dir, CONFIG_FILE);
  const rawText = fs.readFileSync(file, 'utf8');
  let raw: Partial<VaultConfig>;
  try {
    raw = JSON.parse(rawText) as Partial<VaultConfig>;
  } catch {
    throw new Error(
      `Cairn config at ${file} is not valid JSON. Restore it from state/backups or re-run \`cairn init\`.`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Cairn config at ${file} must be a JSON object.`);
  }
  return {
    version: 1,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 160) : path.basename(dir),
    project: handle(typeof raw.project === 'string' && raw.project.trim() ? raw.project : 'workspace'),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    settings: {
      autoLink: raw.settings?.autoLink !== false,
      redact: raw.settings?.redact !== false,
    },
  };
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function vaultReadme(config: VaultConfig): string {
  return `# ${config.name}

This folder is a **Cairn memory vault** — a graph of Markdown notes shared by coding agents.

- Every note lives in \`notes/<kind>/\` with YAML frontmatter.
- Links use Obsidian-style \`[[note-id|title]]\` wikilinks. Frontmatter \`aliases\` include each note's id and title.
- The graph (backlinks, typed relations, files, projects, agents) is derived automatically.
- \`state/\` contains ephemeral presence and hook bookkeeping; it is safe to ignore or delete.
- Do not hand-edit ids. Everything else is plain Markdown and safe to edit.

Open the workspace with:

\`\`\`sh
cairn ui --vault "<this folder>"
\`\`\`

Learn more in the project README.
`;
}

export class Vault {
  readonly dir: string;
  readonly notesDir: string;
  readonly stateDir: string;
  readonly lockPath: string;
  config: VaultConfig;
  private lockDepth = 0;
  private lockFd: number | null = null;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    if (!vaultExists(this.dir)) {
      throw new Error(`No Cairn vault at ${this.dir}. Run \`cairn init\` first.`);
    }
    this.notesDir = path.join(this.dir, 'notes');
    this.stateDir = path.join(this.dir, 'state');
    this.lockPath = path.join(this.stateDir, '.write.lock');
    fs.mkdirSync(this.notesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.config = loadConfig(this.dir);
  }

  /**
   * Serialize read-modify-write operations across MCP, CLI, and UI processes.
   * Reentrant within one process so callers can compose operations safely.
   */
  withWriteLock<T>(fn: () => T, timeoutMs = 10_000): T {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return fn();
      } finally {
        this.lockDepth -= 1;
      }
    }
    const started = Date.now();
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } catch {
          // The pid is diagnostic only.
        }
        this.lockFd = fd;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (this.lockIsStale()) {
          try {
            fs.rmSync(this.lockPath, { force: true });
          } catch {
            // Another process may have removed it first.
          }
          continue;
        }
        if (Date.now() - started >= timeoutMs) {
          throw new Error(`Timed out waiting for another Cairn process to finish writing (${this.lockPath}).`);
        }
        sleepSync(20);
      }
    }
    this.lockDepth = 1;
    try {
      return fn();
    } finally {
      this.lockDepth = 0;
      if (this.lockFd !== null) {
        try {
          fs.closeSync(this.lockFd);
        } catch {
          // ignore
        }
        this.lockFd = null;
      }
      try {
        fs.rmSync(this.lockPath, { force: true });
      } catch {
        // ignore
      }
    }
  }

  private lockIsStale(): boolean {
    try {
      const stat = fs.statSync(this.lockPath);
      if (Date.now() - stat.mtimeMs > 20_000) return true;
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      const pid = Number((JSON.parse(raw) as { pid?: number }).pid);
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } catch {
      // If the lock vanished between open and stat, retry immediately.
      return true;
    }
  }

  reloadConfig(): VaultConfig {
    this.config = loadConfig(this.dir);
    return this.config;
  }

  listNoteFiles(): Array<{ rel: string; abs: string; mtimeMs: number; size: number }> {
    const out: Array<{ rel: string; abs: string; mtimeMs: number; size: number }> = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            const stat = fs.statSync(abs);
            out.push({
              rel: path.relative(this.dir, abs).split(path.sep).join('/'),
              abs,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
            });
          } catch {
            // A file can disappear between readdir and stat.
          }
        }
      }
    };
    walk(this.notesDir);
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    return out;
  }

  readNoteFile(rel: string): Note | null {
    const abs = path.resolve(this.dir, rel);
    if (!abs.startsWith(this.notesDir + path.sep) || !abs.endsWith('.md')) return null;
    let raw: string;
    let mtimeMs = Date.now();
    try {
      raw = fs.readFileSync(abs, 'utf8');
      mtimeMs = fs.statSync(abs).mtimeMs;
    } catch {
      return null;
    }
    return parseNote(raw, rel, mtimeMs);
  }

  makeNotePath(note: Pick<Note, 'id' | 'kind' | 'title' | 'created'>): string {
    const date = validDate(note.created)?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const folder = KIND_FOLDERS[note.kind] || 'notes';
    const slug = slugify(note.title) || note.kind;
    const base = `${folder}/${date}-${note.kind}-${slug}-${shortId(note.id)}`;
    let candidate = `notes/${base}.md`;
    let attempt = 1;
    while (fs.existsSync(path.join(this.dir, candidate))) {
      candidate = `notes/${base}-${attempt}.md`;
      attempt += 1;
      if (attempt > 50) {
        candidate = `notes/${base}-${Date.now()}.md`;
        break;
      }
    }
    return candidate;
  }

  writeNote(note: Note): Note {
    return this.withWriteLock(() => {
      if (!note.path) note.path = this.makeNotePath(note);
      const abs = path.resolve(this.dir, note.path);
      if (!abs.startsWith(this.notesDir + path.sep) || !abs.endsWith('.md')) {
        throw new Error(`Refusing to write outside the notes vault: ${note.path}`);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
      atomicWrite(abs, serializeNote(note), 0o600);
      return note;
    });
  }

  private stateFile(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(name)) {
      throw new Error(`Invalid vault state name: ${name}`);
    }
    return path.join(this.stateDir, `${name}.json`);
  }

  readState<T>(name: string, fallback: T): T {
    const file = this.stateFile(name);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeState(name: string, value: unknown): void {
    const file = this.stateFile(name);
    this.withWriteLock(() => {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      atomicWrite(file, JSON.stringify(value, null, 2) + '\n', 0o600);
    });
  }

  readPresence(): Record<string, PresenceEntry> {
    return this.readState<Record<string, PresenceEntry>>('presence', {});
  }

  writePresence(entries: Record<string, PresenceEntry>): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const pruned: Record<string, PresenceEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      const ts = Date.parse(entry.lastSeen);
      if (Number.isFinite(ts) && ts >= cutoff) pruned[key] = entry;
    }
    this.writeState('presence', pruned);
  }

  appendLog(name: string, message: string): void {
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(name)) return;
      const file = path.join(this.stateDir, `${name}.log`);
      const stamp = new Date().toISOString();
      const line = `[${stamp}] ${message.replace(/\r?\n/g, ' ').slice(0, 2000)}\n`;
      if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) {
        fs.truncateSync(file, 0);
      }
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // chmod is a no-op on Windows.
      }
    } catch {
      // Logging must never break a hook or request.
    }
  }
}

export function atomicWrite(file: string, content: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }
  try {
    fs.chmodSync(file, mode);
  } catch {
    // chmod is a no-op on Windows and on filesystems that do not support it.
  }
}

function validDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).filter((item): item is string => Boolean(item));
  }
  const single = asString(value);
  return single ? [single] : [];
}

function asRelations(value: unknown): Relation[] {
  if (!Array.isArray(value)) return [];
  const out: Relation[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const to = asString(rec.to);
    if (!to) continue;
    const type = handle(asString(rec.type) || 'relates_to');
    out.push({ to, type });
  }
  return out;
}

export function parseNote(raw: string, rel: string, mtimeMs = Date.now()): Note | null {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(match[1] || '');
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return null;
  const fm = frontmatter as Record<string, unknown>;
  const id = asString(fm.id);
  if (!id) return null;
  const kindValue = asString(fm.kind) || 'note';
  const kind = (KINDS.includes(kindValue as Kind) ? kindValue : 'note') as Kind;
  const fallbackDate = validDate(mtimeMs) || new Date().toISOString();
  const created = validDate(fm.created) || fallbackDate;
  const updated = validDate(fm.updated) || created;
  const body = normalized.slice(match[0].length).replace(/^\n+/, '').replace(/\s+$/, '');
  const metadata =
    fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata)
      ? (fm.metadata as Record<string, unknown>)
      : {};
  const files = asStringArray(fm.files)
    .map((file) => normalizeFilePath(file))
    .filter((file) => !isSensitivePath(file));
  return {
    id,
    kind,
    title: asString(fm.title) || path.basename(rel, '.md'),
    status: handle(asString(fm.status) || DEFAULT_STATUS[kind]),
    project: asString(fm.project) ? handle(asString(fm.project)!) : undefined,
    agent: asString(fm.agent) ? handle(asString(fm.agent)!) : undefined,
    session: asString(fm.session),
    tags: asStringArray(fm.tags).map((tag) => handle(tag)),
    files,
    to: asStringArray(fm.to).map((to) => (to.trim() === '*' ? '*' : handle(to))),
    related: asStringArray(fm.related),
    supersedes: asStringArray(fm.supersedes),
    repliesTo: asString(fm.replies_to) || asString(fm.repliesTo),
    relations: asRelations(fm.relations),
    created,
    updated,
    body,
    path: rel,
    metadata,
    aliases: asStringArray(fm.aliases),
  };
}

export function serializeNote(note: Note): string {
  const aliases = Array.from(new Set([note.id, note.title, ...note.aliases].filter(Boolean)));
  const frontmatter: Record<string, unknown> = {
    id: note.id,
    kind: note.kind,
    title: note.title,
    status: note.status,
  };
  if (note.project) frontmatter.project = note.project;
  if (note.agent) frontmatter.agent = note.agent;
  if (note.session) frontmatter.session = note.session;
  if (note.tags.length) frontmatter.tags = note.tags;
  if (note.files.length) frontmatter.files = note.files;
  if (note.to.length) frontmatter.to = note.to;
  if (note.related.length) frontmatter.related = note.related;
  if (note.supersedes.length) frontmatter.supersedes = note.supersedes;
  if (note.repliesTo) frontmatter.replies_to = note.repliesTo;
  if (note.relations.length) frontmatter.relations = note.relations;
  frontmatter.created = note.created;
  frontmatter.updated = note.updated;
  frontmatter.aliases = aliases;
  if (Object.keys(note.metadata).length) frontmatter.metadata = note.metadata;
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).replace(/\s+$/, '');
  return `---\n${yaml}\n---\n\n${note.body.trim()}\n`;
}
