import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { handle } from './ids.js';
import { redactSecrets } from './redact.js';

export interface GitFileChange {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  date: string;
  branch: string | null;
  files: GitFileChange[];
  additions: number;
  deletions: number;
}

export interface GitWorkspace {
  root: string;
  branch: string | null;
  head: string | null;
  clean: boolean;
  files: GitFileChange[];
  additions: number;
  deletions: number;
}

function git(args: string[], cwd: string, timeout = 8000): string | null {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string | null {
  const out = git(['rev-parse', '--show-toplevel'], cwd);
  return out ? path.resolve(out.trim()) : null;
}

export function currentBranch(cwd: string): string | null {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)?.trim() || null;
}

export function headSha(cwd: string): string | null {
  return git(['rev-parse', 'HEAD'], cwd)?.trim() || null;
}

export function projectNameForRepo(root: string): string {
  return handle(path.basename(root));
}

function parseNumstat(raw: string | null): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>();
  if (!raw) return map;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const add = parts[0] === '-' ? null : Number(parts[0]);
    const del = parts[1] === '-' ? null : Number(parts[1]);
    let file = parts.slice(2).join('\t');
    if (file.includes(' => ')) {
      const brace = file.match(/^(.*?)\{(.*?) => (.*?)\}(.*)$/);
      file = brace ? `${brace[1]}${brace[3]}${brace[4]}` : file.split(' => ').pop()!;
    }
    map.set(file.trim(), {
      additions: Number.isFinite(add as number) ? add : null,
      deletions: Number.isFinite(del as number) ? del : null,
    });
  }
  return map;
}

function parseNameStatus(raw: string | null): Array<{ path: string; status: string }> {
  const out: Array<{ path: string; status: string }> = [];
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = (parts[0] || 'M').slice(0, 1);
    const file = parts.length >= 3 ? parts[parts.length - 1]! : parts[1];
    if (file) out.push({ path: file.trim(), status });
  }
  return out;
}

export function getCommit(cwd: string, ref = 'HEAD'): GitCommit | null {
  const root = repoRoot(cwd);
  if (!root) return null;
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`], root)?.trim();
  if (!sha) return null;
  const format = git(['show', '-s', '--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%b', sha], root);
  if (!format) return null;
  const lines = format.split('\n');
  const authorName = lines[2]?.trim() || 'unknown';
  const subject = lines[5]?.trim() || '(no subject)';
  const body = lines.slice(6).join('\n').trim();
  const files = parseNameStatus(git(['show', '--format=', '--name-status', sha], root));
  const numstat = parseNumstat(git(['show', '--format=', '--numstat', sha], root));
  let additions = 0;
  let deletions = 0;
  const merged = files.map((file) => {
    const counts = numstat.get(file.path);
    additions += counts?.additions ?? 0;
    deletions += counts?.deletions ?? 0;
    return { ...file, additions: counts?.additions ?? null, deletions: counts?.deletions ?? null };
  });
  return {
    sha,
    shortSha: lines[1]?.trim() || sha.slice(0, 7),
    subject,
    body,
    authorName,
    authorEmail: lines[3]?.trim() || '',
    date: lines[4]?.trim() || new Date().toISOString(),
    branch: currentBranch(root),
    files: merged,
    additions,
    deletions,
  };
}

export function getWorkspace(cwd: string): GitWorkspace | null {
  const root = repoRoot(cwd);
  if (!root) return null;
  const branch = currentBranch(root);
  const head = headSha(root);
  const status = git(['status', '--porcelain=v1', '-uall'], root);
  const files: GitFileChange[] = [];
  if (status) {
    for (const line of status.split('\n')) {
      if (!line.trim()) continue;
      const statusCode = line.slice(0, 2).trim() || '?';
      let file = line.slice(3).trim();
      if (file.startsWith('"') && file.endsWith('"')) {
        file = file.slice(1, -1).replace(/\\"/g, '"');
      }
      if (file.includes(' -> ')) file = file.split(' -> ').pop()!.trim();
      files.push({ path: file, status: statusCode, additions: null, deletions: null });
    }
  }
  const numstat = parseNumstat(head ? git(['diff', 'HEAD', '--numstat'], root) : git(['diff', '--numstat'], root));
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const counts = numstat.get(file.path);
    file.additions = counts?.additions ?? null;
    file.deletions = counts?.deletions ?? null;
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { root, branch, head, clean: files.length === 0, files, additions, deletions };
}

function filterDiffSections(diff: string, allowed: Set<string>): string {
  if (!allowed.size) return '';
  const out: string[] = [];
  let keep = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      keep = Boolean(match && (allowed.has(match[1]!) || allowed.has(match[2]!)));
    }
    if (keep) out.push(line);
  }
  return out.join('\n');
}

/**
 * Return a diff limited to `allowedPaths` (when provided) and redacted.
 * Passing an empty allowlist returns an empty string rather than every diff:
 * capture callers must always derive the list from already-filtered files.
 */
export function getDiff(
  cwd: string,
  scope: 'workspace' | 'commit',
  commit?: string,
  maxChars = 16000,
  allowedPaths?: string[],
): string {
  const root = repoRoot(cwd);
  if (!root) return '';
  const args =
    scope === 'commit'
      ? ['show', '--format=', '--patch', '--no-ext-diff', commit || 'HEAD']
      : ['diff', 'HEAD', '--patch', '--no-ext-diff'];
  let allowed: Set<string> | null = null;
  if (allowedPaths) {
    const paths = Array.from(new Set(allowedPaths.map((entry) => entry.trim()).filter(Boolean)));
    if (!paths.length) return '';
    allowed = new Set(paths);
    args.push('--', ...paths);
  }
  let diff = git(args, root, 12000) ?? '';
  if (allowed) diff = filterDiffSections(diff, allowed);
  return redactSecrets(diff).slice(0, maxChars);
}

export function recentCommits(cwd: string, limit = 10): Array<{ sha: string; subject: string; date: string }> {
  const raw = git(['log', `-${Math.max(1, limit)}`, '--format=%H%x09%aI%x09%s'], cwd);
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...rest] = line.split('\t');
      return { sha: sha || '', date: date || '', subject: rest.join('\t') };
    })
    .filter((entry) => entry.sha);
}