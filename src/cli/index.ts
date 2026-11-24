#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProjectName, findProjectRoot, initVault, resolveVaultDir, vaultExists, CAIRN_VERSION } from '../core/vault.js';
import { openStore, type Store } from '../core/store.js';
import { repoRoot } from '../core/git.js';
import {
  AuthManager,
  generatePassword,
  validatePassword,
} from '../core/auth.js';
import { redactSecrets } from '../core/redact.js';
import { renderNote, renderStats, renderTimeline } from '../core/format.js';
import { humanizeHandle, relativeTime } from '../core/text.js';
import { detectClientWiring, mcpCommand } from './connections.js';
import type { UiServer } from './ui-server.js';
import { ALL_SKILL_DIRS, cairnRuleText, cairnSkillText, skillDirsForClient } from './guides.js';
import { KINDS, type Kind } from '../core/types.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string[]>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const equals = raw.indexOf('=');
      if (equals !== -1) {
        const key = raw.slice(0, equals);
        const value = raw.slice(equals + 1);
        if (!values.has(key)) values.set(key, []);
        values.get(key)!.push(value);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        if (!values.has(raw)) values.set(raw, []);
        values.get(raw)!.push(next);
        i += 1;
      } else {
        flags.add(raw);
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      flags.add(token.slice(1));
      continue;
    }
    positionals.push(token);
  }
  return { flags, values, positionals };
}

const parsed = parseArgs(process.argv.slice(2));
const hasExplicitCommand = parsed.positionals.length > 0;
let command = parsed.positionals.shift() || 'start';
if (parsed.flags.has('version') && !hasExplicitCommand) command = 'version';
if (parsed.flags.has('help') && !hasExplicitCommand) command = 'help';
let forcedVaultDir: string | undefined;

function opt(name: string): string | undefined {
  return parsed.values.get(name)?.at(-1);
}

function optAll(name: string): string[] {
  const values = parsed.values.get(name) || [];
  return values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
}

function bool(name: string): boolean {
  if (parsed.flags.has(name)) return true;
  const value = opt(name);
  return value === 'true' || value === '1' || value === 'yes';
}

function num(name: string, fallback: number): number {
  const value = Number(opt(name));
  return Number.isFinite(value) ? value : fallback;
}

function envFlag(name: string): boolean {
  return process.env[name] === '1' || process.env[name] === 'true';
}

function envList(name: string): string[] {
  return String(process.env[name] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isLoopbackBind(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1';
}

interface BindPolicy {
  secureCookies: boolean;
  allowedHosts: string[];
}

function bindPolicy(host: string): BindPolicy {
  const secureCookies = bool('secure-cookie') || envFlag('CAIRN_SECURE_COOKIE');
  const allowedHosts = envList('CAIRN_ALLOWED_HOSTS');
  if (isLoopbackBind(host)) return { secureCookies, allowedHosts };
  if (!bool('allow-remote') && !envFlag('CAIRN_ALLOW_REMOTE')) {
    throw new Error(
      `Refusing to bind ${host}: that exposes the workspace beyond this machine. ` +
        'Pass --allow-remote (and put TLS in front) if you really mean it.',
    );
  }
  if (!allowedHosts.length) {
    throw new Error(
      `Remote mode requires CAIRN_ALLOWED_HOSTS. Example: CAIRN_ALLOWED_HOSTS=cairn.example.com cairn start --host 0.0.0.0 --allow-remote`,
    );
  }
  if (!secureCookies) {
    process.stderr.write(
      '[cairn] warning: remote mode without CAIRN_SECURE_COOKIE=1 sends the session cookie over plain HTTP. Terminate TLS and set it.\n',
    );
  }
  return { secureCookies, allowedHosts };
}

function ensureUiAuth(vaultDir: string): { auth: AuthManager; password?: string; created: boolean } {
  const envPassword = process.env.CAIRN_PASSWORD;
  if (envPassword) validatePassword(envPassword);
  const result = AuthManager.ensure(vaultDir, { password: envPassword });
  return { auth: result.auth, password: result.password, created: result.created };
}

function printPasswordNotice(password: string | undefined, created = true): void {
  if (password) {
    print('');
    print('  workspace password (shown once):');
    print(`    ${password}`);
    print('    Keep it for this one login. Cairn will then ask you to set your own');
    print('    workspace password before the workspace opens.');
    print('    Lost it? Run `cairn auth reset` to generate a fresh one.');
    return;
  }
  if (created && process.env.CAIRN_PASSWORD) {
    print('');
    print('  workspace password: set from CAIRN_PASSWORD');
  }
}

function printAuthStatus(vaultDir: string): void {
  if (!AuthManager.exists(vaultDir)) {
    print('  auth       not configured yet — created by the next `cairn start`');
    return;
  }
  const status = AuthManager.load(vaultDir).status();
  print(`  auth       password protected (updated ${new Date(status.updatedAt || Date.now()).toLocaleString()})`);
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveInputPath(input: string, cwd = process.cwd()): string {
  return path.resolve(cwd, expandHome(input));
}

function cliEntryPath(): string {
  const argvPath = process.argv[1];
  if (argvPath && /\.(ts|mts|cts)$/.test(argvPath)) {
    return path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
  }
  if (argvPath) return path.resolve(argvPath);
  return path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
}

function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}

function quoteShell(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function projectRootFor(cwd = process.cwd()): string {
  return findProjectRoot(cwd);
}

function intendedVaultDir(global = false, preferExisting = false): string {
  if (forcedVaultDir) return forcedVaultDir;
  const explicit = opt('vault');
  if (explicit) return resolveInputPath(explicit);
  if (global) return path.join(os.homedir(), '.cairn');
  if (preferExisting) return resolveVaultDir({ cwd: process.cwd() });
  return path.join(projectRootFor(), '.cairn');
}

function storeFor(agent: string, options: { lazy?: boolean; project?: string; autoInit?: boolean } = {}): Store {
  return openStore({
    vault: opt('vault'),
    cwd: opt('cwd') || process.cwd(),
    project: options.project || opt('project'),
    agent,
    autoInit: options.autoInit !== false,
    lazy: options.lazy,
  });
}

function print(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key|cookie)/i;

function scrubJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[redacted depth]';
  if (Array.isArray(value)) return value.map((entry) => scrubJson(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrubJson(entry, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return redactSecrets(value);
  return value;
}

function redactBackup(file: string, content: string): string {
  if (/\.json$/i.test(file)) {
    try {
      return `${JSON.stringify(scrubJson(JSON.parse(content)), null, 2)}\n`;
    } catch {
      // Invalid JSON is backed up as redacted text so the original can be recovered.
    }
  }
  return redactSecrets(content);
}

function backupFile(file: string, vaultDir: string): void {
  if (!fs.existsSync(file)) return;
  const backupDir = path.join(vaultDir, 'state', 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const relative =
    path.relative(process.cwd(), file).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) ||
    path.basename(file);
  const target = path.join(backupDir, `${relative}.${stamp}.bak`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(target, redactBackup(file, raw), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // chmod is a no-op on Windows.
    }
  } catch {
    // A binary or unreadable file is still worth preserving byte-for-byte.
    try {
      fs.copyFileSync(file, target);
      fs.chmodSync(target, 0o600);
    } catch {
      return;
    }
  }
  // Backups can contain client configuration; keep the history short.
  try {
    const backups = fs
      .readdirSync(backupDir)
      .filter((name) => name.endsWith('.bak'))
      .map((name) => {
        const abs = path.join(backupDir, name);
        return { abs, mtime: fs.statSync(abs).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of backups.slice(40)) fs.rmSync(entry.abs, { force: true });
  } catch {
    // Retention is best-effort.
  }
}

function readJsonFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`Refusing to modify ${file}: it is not valid JSON.`);
  }
}

function writeJsonFile(file: string, value: unknown, vaultDir: string, dryRun = false): void {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupFile(file, vaultDir);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const START_MARKER = '<!-- cairn:start -->';
const END_MARKER = '<!-- cairn:end -->';

function upsertInstructionBlock(file: string, vaultDir: string, text: string, dryRun = false): 'updated' | 'unchanged' {
  const block = `${START_MARKER}\n${text}\n${END_MARKER}`;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  let next: string;
  if (existing.includes(START_MARKER) && existing.includes(END_MARKER)) {
    next = existing.replace(
      new RegExp(`${START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      block,
    );
  } else {
    next = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}\n`;
  }
  if (next === existing) return 'unchanged';
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupFile(file, vaultDir);
    fs.writeFileSync(file, next, 'utf8');
  }
  return 'updated';
}

/**
 * Install the Cairn skill into the given project-relative skill directories.
 * Returns the files that changed (empty when every copy is current).
 */
function installSkill(cwd: string, vaultDir: string, dirs: string[], dryRun = false): string[] {
  if (!dirs.length) return [];
  const content = `${cairnSkillText()}\n`;
  const changed: string[] = [];
  for (const dir of dirs) {
    const file = path.join(cwd, dir, 'SKILL.md');
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      existing = '';
    }
    if (existing === content) continue;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      backupFile(file, vaultDir);
      fs.writeFileSync(file, content, 'utf8');
    }
    changed.push(path.relative(cwd, file).replace(/\\/g, '/'));
  }
  return changed;
}

function mcpServerEntry(client: string, vaultDir: string, project: string) {
  return {
    command: process.execPath,
    args: [
      cliEntryPath(),
      'mcp',
      '--vault',
      vaultDir,
      '--project',
      project,
      '--agent',
      client === 'claude-code' ? 'claude-code' : client,
    ],
  };
}

function mcpSnippet(client: string, rootKey: string, vaultDir: string, project: string): string {
  return JSON.stringify({ [rootKey]: { cairn: mcpServerEntry(client, vaultDir, project) } }, null, 2);
}

function hookCommand(hook: string, client: string, vaultDir: string, project: string): string {
  return [
    quoteShell(process.execPath),
    quoteShell(cliEntryPath()),
    'hook',
    hook,
    '--vault',
    quoteShell(vaultDir),
    '--project',
    quoteShell(project),
    '--agent',
    client,
  ].join(' ');
}

function installGitHook(
  vaultDir: string,
  project: string,
  dryRun = false,
  repo = process.cwd(),
): string | null {
  const root = repoRoot(repo);
  if (!root) return null;
  let gitPath: string;
  try {
    gitPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
  const hooksDir = path.isAbsolute(gitPath) ? gitPath : path.join(root, gitPath);
  const hookFile = path.join(hooksDir, 'post-commit');
  const markerStart = '# cairn:start';
  const markerEnd = '# cairn:end';
  const block = [
    markerStart,
    '# Auto-capture commits into Cairn memory. Managed by `cairn connect`.',
    `if command -v node >/dev/null 2>&1; then`,
    `  (node ${quoteShell(toPosix(cliEntryPath()))} capture-commit --vault ${quoteShell(toPosix(vaultDir))} --project ${quoteShell(project)} --repo ${quoteShell(toPosix(root))} --agent git >/dev/null 2>&1 &)`,
    'fi',
    markerEnd,
  ].join('\n');
  let existing = '';
  try {
    existing = fs.readFileSync(hookFile, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.includes(markerStart) && existing.includes(markerEnd)) {
    existing = existing.replace(
      new RegExp(`${markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`),
      '',
    );
  }
  let next = existing.trimEnd();
  if (!next) next = '#!/bin/sh';
  next = `${next}\n\n${block}\n`;
  if (!dryRun) {
    fs.mkdirSync(hooksDir, { recursive: true });
    backupFile(hookFile, vaultDir);
    fs.writeFileSync(hookFile, next, { encoding: 'utf8', mode: 0o755 });
    try {
      fs.chmodSync(hookFile, 0o755);
    } catch {
      // chmod is a no-op on Windows.
    }
  }
  return hookFile;
}

interface ConnectResult {
  client: string;
  files: string[];
  notes: string[];
}

function connectClient(client: string, dryRun = false): ConnectResult {
  const vaultDir = intendedVaultDir(bool('global'), true);
  if (!vaultExists(vaultDir) && !dryRun) {
    initVault(vaultDir, {
      cwd: process.cwd(),
      project: opt('project'),
      global: bool('global'),
    });
  }
  forcedVaultDir = vaultDir;
  const project = opt('project') || detectProjectName(process.cwd());
  const entry = mcpServerEntry(client, vaultDir, project);
  const files: string[] = [];
  const notes: string[] = [];
  const cwd = process.cwd();

  const writeServerConfig = (relative: string, rootKey = 'mcpServers') => {
    const file = path.join(cwd, relative);
    const config = readJsonFile(file);
    const servers = (config[rootKey] as Record<string, unknown> | undefined) || {};
    servers.cairn = entry;
    config[rootKey] = servers;
    writeJsonFile(file, config, vaultDir, dryRun);
    files.push(relative);
  };

  switch (client) {
    case 'claude-code': {
      writeServerConfig('.mcp.json');
      if (bool('no-hooks') === false) {
        const file = path.join(cwd, '.claude', 'settings.json');
        const settings = readJsonFile(file);
        const hooks = (settings.hooks as Record<string, Array<Record<string, unknown>>> | undefined) || {};
        const isOurs = (group: Record<string, unknown>, marker: string) => {
          const entries = Array.isArray(group.hooks) ? (group.hooks as Array<Record<string, unknown>>) : [];
          return entries.some(
            (hook) => typeof hook.command === 'string' && hook.command.includes('hook') && hook.command.includes(marker),
          );
        };
        const clean = (event: string, marker: string) =>
          (Array.isArray(hooks[event]) ? hooks[event] : []).filter((group) => !isOurs(group, marker));
        hooks.SessionStart = [
          ...clean('SessionStart', 'session-start'),
          { hooks: [{ type: 'command', command: hookCommand('session-start', 'claude-code', vaultDir, project), timeout: 15 }] },
        ];
        hooks.PostToolUse = [
          ...clean('PostToolUse', 'capture-file'),
          {
            matcher: 'Edit|Write|MultiEdit|NotebookEdit',
            hooks: [{ type: 'command', command: hookCommand('capture-file', 'claude-code', vaultDir, project), timeout: 10 }],
          },
        ];
        hooks.SessionEnd = [
          ...clean('SessionEnd', 'session-end'),
          { hooks: [{ type: 'command', command: hookCommand('session-end', 'claude-code', vaultDir, project), timeout: 10 }] },
        ];
        settings.hooks = hooks;
        writeJsonFile(file, settings, vaultDir, dryRun);
        files.push('.claude/settings.json');
      }
      const claudeMd = path.join(cwd, 'CLAUDE.md');
      if (upsertInstructionBlock(claudeMd, vaultDir, cairnRuleText(), dryRun) === 'updated') files.push('CLAUDE.md');
      const agentsMd = path.join(cwd, 'AGENTS.md');
      if (upsertInstructionBlock(agentsMd, vaultDir, cairnRuleText(), dryRun) === 'updated') files.push('AGENTS.md');
      notes.push('Claude Code: project MCP + SessionStart/PostToolUse/SessionEnd hooks + CLAUDE.md.');
      notes.push(
        `For user scope, run: claude mcp add --scope user cairn -- ${quoteShell(process.execPath)} ${quoteShell(cliEntryPath())} mcp --vault ${quoteShell(vaultDir)} --project ${quoteShell(project)} --agent claude-code`,
      );
      break;
    }
    case 'cursor': {
      writeServerConfig('.cursor/mcp.json');
      const ruleFile = path.join(cwd, '.cursor', 'rules', 'cairn.mdc');
      const content = `---\ndescription: Shared project memory via Cairn MCP\nalwaysApply: true\n---\n\n${cairnRuleText()}\n`;
      const existing = fs.existsSync(ruleFile) ? fs.readFileSync(ruleFile, 'utf8') : '';
      if (existing !== content) {
        if (!dryRun) {
          fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
          backupFile(ruleFile, vaultDir);
          fs.writeFileSync(ruleFile, content, 'utf8');
        }
        files.push('.cursor/rules/cairn.mdc');
      }
      notes.push('Cursor: project MCP config + always-on rule. Cursor hooks are not installed automatically.');
      break;
    }
    case 'antigravity': {
      writeServerConfig('.agents/mcp_config.json');
      const ruleFile = path.join(cwd, '.agents', 'rules', 'cairn.md');
      const content = `${cairnRuleText()}\n`;
      const existing = fs.existsSync(ruleFile) ? fs.readFileSync(ruleFile, 'utf8') : '';
      if (existing !== content) {
        if (!dryRun) {
          fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
          backupFile(ruleFile, vaultDir);
          fs.writeFileSync(ruleFile, content, 'utf8');
        }
        files.push('.agents/rules/cairn.md');
      }
      if (upsertInstructionBlock(path.join(cwd, 'AGENTS.md'), vaultDir, cairnRuleText(), dryRun) === 'updated') {
        files.push('AGENTS.md');
      }
      notes.push('Antigravity: workspace MCP config + workspace rule + AGENTS.md.');
      notes.push('Global option: copy the mcpServers block into ~/.gemini/config/mcp_config.json.');
      break;
    }
    case 'vscode': {
      writeServerConfig('.mcp.json');
      if (upsertInstructionBlock(path.join(cwd, 'AGENTS.md'), vaultDir, cairnRuleText(), dryRun) === 'updated') {
        files.push('AGENTS.md');
      }
      notes.push('VS Code / Copilot: .mcp.json at the workspace root.');
      break;
    }
    case 'codex': {
      if (upsertInstructionBlock(path.join(cwd, 'AGENTS.md'), vaultDir, cairnRuleText(), dryRun) === 'updated') {
        files.push('AGENTS.md');
      }
      print(`Add to ~/.codex/config.toml (or .codex/config.toml):\n\n[mcp_servers.cairn]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(entry.args)}\n`);
      notes.push('Codex: printed TOML; AGENTS.md updated. Config was not modified automatically.');
      break;
    }
    case 'gemini': {
      if (upsertInstructionBlock(path.join(cwd, 'GEMINI.md'), vaultDir, cairnRuleText(), dryRun) === 'updated') {
        files.push('GEMINI.md');
      }
      print(`Add to ~/.gemini/settings.json (or .gemini/settings.json):\n\n${mcpSnippet('gemini', 'mcpServers', vaultDir, project)}\n`);
      notes.push('Gemini: printed settings JSON; GEMINI.md updated. Settings were not modified automatically.');
      break;
    }
    case 'windsurf': {
      print(`Add to ~/.codeium/windsurf/mcp_config.json (or the Cortex-managed mcp_config.json):\n\n${mcpSnippet('windsurf', 'mcpServers', vaultDir, project)}\n`);
      notes.push('Windsurf: printed JSON. Config was not modified automatically.');
      break;
    }
    case 'zed': {
      print(
        `Add to ~/.config/zed/settings.json under "context_servers":\n\n${JSON.stringify(
          { context_servers: { cairn: { command: process.execPath, args: entry.args, env: {} } } },
          null,
          2,
        )}\n`,
      );
      notes.push('Zed: printed context_servers JSON. Config was not modified automatically.');
      break;
    }
    case 'omnirush':
    case 'opencode': {
      print(
        `Cairn server entry (OpenCode/Omnirush sidecar; add via the app UI if it manages servers in its DB):\n\n${JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: {
              cairn: {
                type: 'local',
                command: [process.execPath, ...entry.args],
                enabled: true,
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      notes.push('Omnirush/OpenCode: printed config. Omnirush may require adding local node servers through its UI/allowlist.');
      break;
    }
    case 'generic': {
      print(`Cairn MCP config (stdio):\n\n${mcpSnippet('generic', 'mcpServers', vaultDir, project)}\n`);
      notes.push('Generic MCP: printed JSON; add it to your client\'s MCP configuration.');
      break;
    }
    default:
      throw new Error(
        `Unknown client: ${client}. Supported: claude-code, cursor, antigravity, vscode, codex, gemini, windsurf, zed, omnirush, opencode, generic.`,
      );
  }

  if (bool('git-hooks')) {
    const hook = installGitHook(vaultDir, project, dryRun);
    if (hook) files.push(path.relative(cwd, hook).replace(/\\/g, '/'));
    else notes.push('Git hooks were requested but this directory is not a Git repository.');
  }

  const skillFiles = installSkill(cwd, vaultDir, skillDirsForClient(client), dryRun);
  if (skillFiles.length) {
    files.push(...skillFiles);
    notes.push(`Agent skill installed: ${skillFiles.join(', ')}.`);
  }

  return { client, files: Array.from(new Set(files)), notes };
}

async function commandInit(): Promise<void> {
  const global = bool('global');
  const dir = intendedVaultDir(global);
  const existed = vaultExists(dir);
  const config = initVault(dir, {
    cwd: process.cwd(),
    project: opt('project'),
    name: opt('name'),
    global,
  });
  print(`${existed ? 'Using existing' : 'Created'} Cairn vault`);
  print(`  path:    ${dir}`);
  print(`  project: ${config.project}`);
  print(`  format:  Markdown notes + YAML frontmatter (Obsidian-compatible)`);
  print('');
  print('Next:');
  print(`  cairn connect claude-code --vault ${quoteShell(dir)}${global ? ' --global' : ''}`);
  print(`  cairn ui --vault ${quoteShell(dir)}`);
  print('');
  print(`MCP stdio:  ${quoteShell(process.execPath)} ${quoteShell(cliEntryPath())} mcp --vault ${quoteShell(dir)}`);

  const clients = optAll('client');
  if (clients.length) {
    print('');
    for (const client of clients) {
      const result = connectClient(client);
      print(`Connected ${result.client}: ${result.files.length ? result.files.join(', ') : 'printed config only'}`);
      for (const note of result.notes) print(`  - ${note}`);
    }
  }
  if (bool('git-hooks')) {
    const hook = installGitHook(dir, config.project, false);
    if (hook) print(`Installed git post-commit hook: ${hook}`);
    else print('Git hook not installed: not a Git repository.');
  }
}

async function commandMcp(): Promise<void> {
  // The MCP SDK and zod are only needed by this command. Keep them out of
  // every other CLI invocation (hooks run on each agent tool call).
  const [{ createCairnMcpServer }, { StdioServerTransport }] = await Promise.all([
    import('../mcp/server.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
  ]);
  const store = storeFor(opt('agent') || process.env.CAIRN_AGENT || 'coding-agent', {
    autoInit: true,
  });
  const agent = opt('agent') || process.env.CAIRN_AGENT || 'coding-agent';
  const project = opt('project') || store.defaultProject;
  const server = createCairnMcpServer({
    store,
    agent,
    project,
    session: opt('session') || process.env.CAIRN_SESSION,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (process.env.CAIRN_DEBUG) {
    process.stderr.write(`[cairn] mcp ready · vault=${store.vaultDir} · project=${project} · agent=${agent}\n`);
  }
}

async function commandUi(): Promise<void> {
  const { startUiServer } = await import('./ui-server.js');
  const store = storeFor('human', { autoInit: true });
  const host = opt('host') || '127.0.0.1';
  const policy = bindPolicy(host);
  const authInfo = ensureUiAuth(store.vaultDir);
  const ui = await startUiServer({
    store,
    auth: authInfo.auth,
    port: num('port', 4242),
    host,
    open: bool('open'),
    webRoot: path.join(PACKAGE_ROOT, 'web'),
    allowedHosts: policy.allowedHosts,
    secureCookies: policy.secureCookies,
  });
  print(`Cairn ${CAIRN_VERSION} — shared memory workspace`);
  print(`  workspace: ${ui.url}`);
  print(`  vault:     ${store.vaultDir}`);
  print(`  project:   ${humanizeHandle(store.defaultProject)}`);
  print('  auth:      password required');
  printPasswordNotice(authInfo.password, authInfo.created);
  print('');
  print('MCP command for clients:');
  print(
    `  ${mcpCommand(store.vaultDir, store.defaultProject)}`,
  );
  print('');
  print('Press Ctrl+C to stop.');
  const shutdown = async () => {
    await ui.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

interface WorkspaceHealth {
  ok?: boolean;
  version?: string;
}

async function probeWorkspace(url: string): Promise<WorkspaceHealth | null> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const data = (await response.json()) as WorkspaceHealth;
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

function workspaceUrl(host: string, port: number): string {
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

function shouldOpenBrowser(): boolean {
  return bool('open') || (!bool('no-open') && Boolean(process.stdout.isTTY));
}

function printWorkspacePanel(store: Store, url: string, password?: string, created = false): void {
  const stats = store.stats();
  const wiring = detectClientWiring(process.cwd());
  print(`Cairn ${CAIRN_VERSION} — shared memory workspace\n`);
  print(`  vault      ${store.vaultDir}`);
  print(`  project    ${humanizeHandle(store.defaultProject)}`);
  print(`  memory     ${stats.notes} notes · ${stats.edges} links · ${stats.projects} projects · ${stats.agents} agents`);
  print(`  workspace  ${url}`);
  print(`  auth       password required for the workspace and API`);
  print('');
  print(`  MCP        ${mcpCommand(store.vaultDir, store.defaultProject)}`);
  if (wiring.length) {
    print(`  wired      ${wiring.map((entry) => `${entry.label} (${entry.file})`).join(', ')}`);
  } else {
    print('  wired      none in this directory — run `cairn connect <client>`');
  }
  printPasswordNotice(password, created);
  print('');
  print('  Manage memory in the workspace. Agents read and write it over MCP.');
  print('  Press Ctrl+C to stop.\n');
}

async function commandStart(): Promise<void> {
  const { startUiServer, openBrowser } = await import('./ui-server.js');
  const port = num('port', 4242);
  const host = opt('host') || '127.0.0.1';
  const policy = bindPolicy(host);
  const url = workspaceUrl(host, port);
  const store = storeFor('human', { autoInit: true });

  const clients = optAll('connect');
  if (clients.length) {
    const results = clients.map((client) => connectClient(client, bool('dry-run')));
    for (const result of results) {
      print(`connected ${result.client}: ${result.files.length ? result.files.join(', ') : 'printed config only'}`);
    }
    print('');
  }

  const existing = await probeWorkspace(url);
  if (existing) {
    print(`Cairn ${CAIRN_VERSION} workspace is already running.\n`);
    print(`  workspace  ${url}`);
    print(`  vault      ${store.vaultDir}`);
    print(`  project    ${humanizeHandle(store.defaultProject)}`);
    print('  auth       sign in with the password printed when this workspace started');
    print('');
    print('  Open it in the browser, or run `cairn status` for details.');
    if (shouldOpenBrowser()) openBrowser(url);
    return;
  }

  const authInfo = ensureUiAuth(store.vaultDir);
  let ui: UiServer;
  try {
    ui = await startUiServer({
      store,
      auth: authInfo.auth,
      port,
      host,
      open: false,
      webRoot: path.join(PACKAGE_ROOT, 'web'),
      allowedHosts: policy.allowedHosts,
      secureCookies: policy.secureCookies,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/EADDRINUSE|address already in use/i.test(message)) {
      throw new Error(`Port ${port} is already in use by another application. Try \`cairn start --port ${port + 1}\`.`);
    }
    throw error;
  }

  printWorkspacePanel(store, ui.url, authInfo.password, authInfo.created);
  if (shouldOpenBrowser()) openBrowser(ui.url);

  const shutdown = async () => {
    await ui.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function commandStatus(): Promise<void> {
  const cwd = process.cwd();
  const vaultDir = intendedVaultDir(bool('global'), true);
  const initialized = vaultExists(vaultDir);
  const port = num('port', 4242);
  const url = workspaceUrl(opt('host') || '127.0.0.1', port);
  const health = await probeWorkspace(url);
  const wiring = detectClientWiring(cwd);

  print(`Cairn ${CAIRN_VERSION} — status\n`);
  print(`  vault      ${initialized ? vaultDir : `${vaultDir} (not initialized)`}`);
  if (initialized) {
    const store = openStore({ vault: vaultDir, cwd, agent: 'human', autoInit: false });
    const stats = store.stats();
    print(`  project    ${humanizeHandle(store.defaultProject)}`);
    print(`  memory     ${stats.notes} notes · ${stats.edges} links · ${stats.projects} projects · ${stats.agents} agents`);
    printAuthStatus(vaultDir);
    print('');
    print(`  MCP        ${mcpCommand(store.vaultDir, store.defaultProject)}`);
  }
  print(`  workspace  ${health ? `${url} (running)` : `not running — run \`cairn start\``}`);
  if (wiring.length) {
    print(`  wired      ${wiring.map((entry) => `${entry.label} (${entry.file})`).join(', ')}`);
  } else {
    print('  wired      no MCP clients in this directory — run `cairn connect <client>`');
  }
}

async function commandSkill(): Promise<void> {
  if (bool('print')) {
    print(cairnSkillText());
    return;
  }
  if (bool('print-rule')) {
    print(cairnRuleText());
    return;
  }

  const cwd = process.cwd();
  const targets = ALL_SKILL_DIRS.map((dir) => path.join(dir, 'SKILL.md'));

  if (bool('install')) {
    const vaultDir = intendedVaultDir(bool('global'), true);
    if (!vaultExists(vaultDir)) {
      initVault(vaultDir, { cwd, project: opt('project'), global: bool('global') });
    }
    const files = installSkill(cwd, vaultDir, [...ALL_SKILL_DIRS]);
    print(`Cairn ${CAIRN_VERSION} — agent skill\n`);
    print(files.length ? `  wrote      ${files.join(', ')}` : '  current    both standard skill locations are up to date');
    print(`  rule       injected into CLAUDE.md / AGENTS.md by \`cairn connect\``);
    return;
  }

  print(`Cairn ${CAIRN_VERSION} — agent skill\n`);
  print(`  source     ${path.join(PACKAGE_ROOT, 'skills', 'cairn', 'SKILL.md')}`);
  print(`  rule       ${path.join(PACKAGE_ROOT, 'rules', 'cairn.md')}`);
  print('');
  for (const target of targets) {
    print(`  ${fs.existsSync(target) ? 'installed  ' : 'missing    '} ${target}`);
  }
  print('');
  print('  cairn skill --install      # write both skill locations');
  print('  cairn skill --print        # print the skill markdown');
  print('  cairn skill --print-rule   # print the always-on rule');
}


function commandAuth(subcommand: string, inlinePassword?: string): void {
  const vaultDir = intendedVaultDir(bool('global'), true);
  if (!vaultExists(vaultDir)) {
    throw new Error(`No Cairn vault at ${vaultDir}. Run \`cairn init\` first.`);
  }
  const action = subcommand || 'status';

  if (action === 'status') {
    print(`Cairn ${CAIRN_VERSION} — workspace auth\n`);
    print(`  vault      ${vaultDir}`);
    if (!AuthManager.exists(vaultDir)) {
      print('  password   not configured — created by the next `cairn start`');
      print('');
      print('  Set one now:  CAIRN_NEW_PASSWORD=… cairn auth set-password');
      return;
    }
    const auth = AuthManager.load(vaultDir);
    const status = auth.status();
    print('  password   configured');
    print(`  file       ${status.path}`);
    print(`  updated    ${status.updatedAt ? new Date(status.updatedAt).toLocaleString() : 'unknown'}`);
    print(`  session    ${Math.round((status.sessionTtlSeconds || 0) / 3600)}h cookie · signed out on reset`);
    if (auth.mustChangePassword()) {
      print('');
      print('  !!         the generated first-run password is still active —');
      print('              the login page will force you to set a new one.');
      print('              Or now:  CAIRN_NEW_PASSWORD=… cairn auth set-password');
    }
    return;
  }

  // `set-password` and `reset` accept the password via environment, --password flag,
  // or as an argument (e.g. `cairn auth reset <password>`).
  const positionalPassword = inlinePassword || parsed.positionals[1];
  const supplied =
    action === 'set-password'
      ? process.env.CAIRN_NEW_PASSWORD || opt('password') || positionalPassword
      : opt('password') || positionalPassword;
  if (supplied) validatePassword(supplied);
  if (action === 'set-password' && !supplied) {
    throw new Error(
      'Set CAIRN_NEW_PASSWORD (recommended), pass --password, or provide as argument. Example: cairn auth set-password <password>',
    );
  }
  if (action !== 'reset' && action !== 'set-password') {
    throw new Error(`Unknown auth command: ${action}. Use status, set-password, or reset.`);
  }

  const existing = AuthManager.exists(vaultDir) ? AuthManager.load(vaultDir) : null;
  let password: string | undefined;
  if (!existing) {
    const result = AuthManager.ensure(vaultDir, { password: supplied });
    password = result.password || supplied;
  } else if (action === 'reset') {
    password = existing.resetPassword(supplied || generatePassword());
  } else {
    existing.setPassword(supplied!);
    password = supplied;
  }

  print(`Cairn ${CAIRN_VERSION} — workspace auth updated\n`);
  print(`  vault      ${vaultDir}`);
  print('  sessions   all existing browser sessions were signed out');
  if (password) {
    print('');
    print('  workspace password:');
    print(`    ${password}`);
    print('  Shown once. Store it in your password manager.');
  }
}


async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      try {
        process.stdin.destroy();
      } catch {
        // ignore
      }
      resolve(data);
    }, 2500);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 2_000_000) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

interface HookInput {
  session_id?: string;
  sessionId?: string;
  conversationId?: string;
  cwd?: string;
  workspacePaths?: string[];
  source?: string;
  hook_event_name?: string;
  reason?: string;
  model?: string;
  modelName?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: { file_path?: string; path?: string };
  workspace_path?: string;
}

function hookClient(): string {
  return opt('agent') || 'coding-agent';
}

function hookProject(input: HookInput): string {
  if (opt('project')) return opt('project')!;
  const cwd = input.cwd || input.workspacePaths?.[0] || process.cwd();
  return detectProjectName(cwd);
}

async function commandHook(subcommand: string): Promise<void> {
  const raw = await readStdinText();
  let input: HookInput = {};
  if (raw.trim()) {
    try {
      input = JSON.parse(raw) as HookInput;
    } catch {
      input = {};
    }
  }
  const agent = hookClient();
  const clientSession =
    input.session_id || input.sessionId || input.conversationId || opt('client-session') || '';
  const cwd = input.cwd || input.workspacePaths?.[0] || opt('cwd') || process.cwd();
  const project = input.workspace_path || hookProject(input);

  try {
    if (subcommand === 'session-start') {
      const store = storeFor(agent, { project, autoInit: true });
      const result = store.sessionStart({
        agent,
        project,
        cwd,
        model: input.model || input.modelName,
        client: opt('client') || agent,
        source: input.source || input.hook_event_name,
        clientSession: clientSession || undefined,
        goal: opt('goal'),
      });
      if (clientSession) {
        store.saveClientSession(agent, clientSession, {
          cairnSessionId: result.session.id,
          notePath: result.session.path,
          agent,
          project,
          cwd,
          startedAt: result.session.created,
        });
      }
      const brief = [
        `Cairn shared memory is active for project "${project}" (session ${result.session.id}).`,
        '',
        store.renderContext(project, agent, true),
        '',
        'Recording rules: use memory_write for every meaningful decision (why + alternatives); call capture_changes after edits; use memory_inbox for messages/handoffs; never store secrets.',
      ].join('\n');
      const format = opt('format') || 'claude';
      if (format === 'claude') {
        print(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief } }));
      } else if (format === 'cursor') {
        print(JSON.stringify({ additional_context: brief }));
      } else if (format === 'antigravity') {
        print(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: brief } }] }));
      } else {
        print(brief);
      }
      return;
    }

    if (subcommand === 'capture-file') {
      const filePath = opt('path') || input.tool_input?.file_path || input.tool_input?.path;
      if (!filePath) return;
      const store = storeFor(agent, { project, autoInit: true, lazy: true });
      store.captureFile({
        path: filePath,
        tool: opt('tool') || input.tool_name || input.toolName,
        project,
        agent,
        clientSession: clientSession || undefined,
        cwd,
      });
      return;
    }

    if (subcommand === 'session-end') {
      const store = storeFor(agent, { project, autoInit: true });
      const mapping = clientSession ? store.getClientSession(agent, clientSession) : undefined;
      if (!mapping) {
        if (opt('session')) {
          store.sessionEnd({ session: opt('session'), agent, status: 'done' });
        }
        return;
      }
      store.sessionEnd({
        session: mapping.cairnSessionId,
        agent,
        status: 'done',
        summary: `Session ended via ${agent}${input.reason ? ` (${input.reason})` : ''}.`,
      });
      return;
    }

    throw new Error(`Unknown hook: ${subcommand}`);
  } catch (error) {
    try {
      const vault = opt('vault') || intendedVaultDir();
      if (vaultExists(vault)) {
        fs.appendFileSync(
          path.join(vault, 'state', 'hooks.log'),
          `[${new Date().toISOString()}] ${subcommand}: ${(error as Error).message}\n`,
          'utf8',
        );
      }
    } catch {
      // Hooks must never fail the host tool call.
    }
    if (process.env.CAIRN_DEBUG) {
      process.stderr.write(`[cairn] hook ${subcommand} failed: ${(error as Error).message}\n`);
    }
  }
}

async function commandCaptureCommit(): Promise<void> {
  const store = storeFor(opt('agent') || 'git', { autoInit: true });
  const result = store.captureChanges({
    scope: 'commit',
    commit: opt('commit') || 'HEAD',
    project: opt('project'),
    repo: opt('repo') || process.cwd(),
    includeDiff: bool('include-diff'),
    agent: opt('agent') || 'git',
    session: opt('session'),
  });
  if (!bool('quiet')) print(result.summary);
}

async function commandCaptureFile(): Promise<void> {
  const filePath = opt('path') || parsed.positionals[0];
  if (!filePath) throw new Error('Provide --path <file> or a positional file path.');
  const store = storeFor(opt('agent') || 'coding-agent', { autoInit: true, lazy: true });
  const note = store.captureFile({
    path: filePath,
    tool: opt('tool') || 'cli',
    project: opt('project'),
    agent: opt('agent') || 'coding-agent',
    clientSession: opt('client-session'),
    cwd: opt('cwd') || process.cwd(),
  });
  if (!note) {
    if (!bool('quiet')) print('Skipped: file is ignored or sensitive.');
    return;
  }
  if (!bool('quiet')) print(`Captured ${filePath} in worklog ${note.id} (${note.files.length} files).`);
}

function commandList(): void {
  const store = storeFor('human', { autoInit: true });
  const kinds = optAll('kind') as Kind[];
  const hits = store.search({
    query: opt('q') || opt('query') || '',
    project: bool('all') ? undefined : store.resolveProject(opt('project')),
    kinds: kinds.length ? kinds.filter((kind) => KINDS.includes(kind)) : undefined,
    status: opt('status'),
    limit: num('limit', 40),
    includeArchived: bool('archived'),
    sort: (opt('sort') as 'relevance' | 'updated' | 'created') || undefined,
  });
  if (bool('json')) {
    print(JSON.stringify(hits, null, 2));
    return;
  }
  if (!hits.length) {
    print('No notes found.');
    return;
  }
  print(`KIND        STATUS       UPDATED     TITLE`);
  for (const hit of hits) {
    const note = hit.note;
    print(
      `${note.kind.padEnd(11)} ${note.status.padEnd(12)} ${relativeTime(note.updated).padEnd(11)} ${note.title}  (${note.id})`,
    );
    if (hit.snippet && (opt('q') || opt('query'))) print(`  ${hit.snippet}`);
  }
  print('');
  print(`${hits.length} note${hits.length === 1 ? '' : 's'} · vault ${store.vaultDir}`);
}

async function commandShow(ref?: string): Promise<void> {
  if (!ref) throw new Error('Usage: cairn show <note-id>');
  const store = storeFor('human', { autoInit: true });
  const result = store.get(ref);
  if (!result) throw new Error(`Note not found: ${ref}`);
  print(renderNote(result));
}

async function commandContext(): Promise<void> {
  const store = storeFor('human', { autoInit: true });
  print(store.renderContext(opt('project'), opt('agent') || 'human'));
}

async function commandTimeline(): Promise<void> {
  const store = storeFor('human', { autoInit: true });
  const hits = store.timeline({
    project: opt('project'),
    agent: opt('agent'),
    days: num('days', 14),
    limit: num('limit', 60),
  });
  print(renderTimeline(hits, opt('project')));
}

async function commandStats(): Promise<void> {
  const store = storeFor('human', { autoInit: true });
  print(renderStats(store.stats(opt('project')) as unknown as Parameters<typeof renderStats>[0]));
}

async function commandExport(): Promise<void> {
  const store = storeFor('human', { autoInit: true });
  const data = store.exportData();
  const output = opt('out');
  if (output) {
    const file = resolveInputPath(output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    print(`Exported ${data.notes.length} notes and ${data.edges.length} edges to ${file}`);
    return;
  }
  print(JSON.stringify(data, null, 2));
}

function commandDoctor(): void {
  const vaultDir = intendedVaultDir(bool('global'), true);
  if (!vaultExists(vaultDir)) {
    const gitRoot = repoRoot(process.cwd());
    print('# Cairn doctor\n');
    print(`[${Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : '!!'}] Node.js: ${process.version}`);
    print(`[!!] Vault: ${vaultDir} (missing — run \`cairn init\`)`);
    print(`[${gitRoot ? 'ok' : '!!'}] Git: ${gitRoot || 'not a repository'}`);
    print('\nNo vault was created.');
    return;
  }
  const store = openStore({ vault: vaultDir, cwd: process.cwd(), agent: 'human', autoInit: false });
  const stats = store.stats();
  const checks: Array<{ ok: boolean; label: string; detail: string }> = [];
  checks.push({ ok: Number(process.versions.node.split('.')[0]) >= 20, label: 'Node.js', detail: process.version });
  checks.push({ ok: fs.existsSync(store.vaultDir), label: 'Vault', detail: store.vaultDir });
  checks.push({ ok: vaultExists(store.vaultDir), label: 'Config', detail: vaultExists(store.vaultDir) ? 'ok' : 'missing' });
  checks.push({ ok: stats.notes >= 0, label: 'Index', detail: `${stats.notes} notes · ${stats.edges} edges` });
  checks.push({
    ok: true,
    label: 'Projects',
    detail: store.projectsInfo().map((project) => `${project.name} (${project.total})`).join(', ') || 'none',
  });
  checks.push({
    ok: true,
    label: 'Agents',
    detail: store.agentsInfo().map((agent) => `${agent.name}${agent.online ? ' online' : ''}`).join(', ') || 'none',
  });
  const gitRoot = repoRoot(process.cwd());
  checks.push({ ok: Boolean(gitRoot), label: 'Git', detail: gitRoot || 'not a repository' });
  if (gitRoot) {
    try {
      const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: gitRoot,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      const hook = path.join(gitRoot, gitPath, 'post-commit');
      const installed = fs.existsSync(hook) && fs.readFileSync(hook, 'utf8').includes('# cairn:start');
      checks.push({ ok: installed, label: 'Git hook', detail: installed ? hook : 'not installed (cairn connect --git-hooks)' });
    } catch {
      checks.push({ ok: false, label: 'Git hook', detail: 'could not inspect hooks' });
    }
  }
  const projectFiles: Array<[string, string]> = [
    ['.mcp.json', 'Claude Code / VS Code'],
    ['.claude/settings.json', 'Claude hooks'],
    ['.cursor/mcp.json', 'Cursor'],
    ['.agents/mcp_config.json', 'Antigravity'],
    ['.codex/config.toml', 'Codex'],
  ];
  for (const [file, label] of projectFiles) {
    const full = path.join(process.cwd(), file);
    if (fs.existsSync(full)) {
      const content = fs.readFileSync(full, 'utf8');
      checks.push({ ok: content.includes('cairn'), label, detail: content.includes('cairn') ? file : `${file} (no cairn entry)` });
    }
  }
  const hookLog = path.join(store.vaultDir, 'state', 'hooks.log');
  if (fs.existsSync(hookLog)) {
    const lines = fs.readFileSync(hookLog, 'utf8').trim().split('\n').slice(-3);
    if (lines.join('').trim()) checks.push({ ok: true, label: 'Hook log', detail: lines.join(' | ') });
  }
  const presence = store.agentsInfo().filter((agent) => agent.online);
  checks.push({
    ok: true,
    label: 'Live presence',
    detail: presence.length ? presence.map((agent) => agent.name).join(', ') : 'no agents online',
  });
  print(`# Cairn doctor\n`);
  for (const check of checks) {
    print(`[${check.ok ? 'ok' : '!!'}] ${check.label}: ${check.detail}`);
  }
  print('');
  print(`Vault summary: ${stats.notes} notes, ${stats.edges} edges, ${stats.projects} projects, ${stats.agents} agents.`);
}

function printHelp(): void {
  print(`Cairn ${CAIRN_VERSION} — shared graph memory for coding agents

Usage:
  cairn [start] [--port 4242] [--open|--no-open] [--connect client[,client]] [--vault path]
  cairn status [--port 4242] [--vault path] [--global]
  cairn init [--global] [--project name] [--client claude-code] [--git-hooks]
  cairn mcp [--vault path] [--project name] [--agent handle] [--session id]
  cairn ui [--port 4242] [--open] [--vault path]
  cairn auth [status|reset|set-password] [password] [--vault path] [--password value]
  cairn reset [password]
  cairn connect <client> [--vault path] [--global] [--git-hooks] [--dry-run]
  cairn skill [--install|--print|--print-rule]
  cairn capture-commit [--repo path] [--commit ref] [--include-diff]
  cairn capture-file --path src/file.ts [--agent handle]
  cairn hook <session-start|capture-file|session-end>
  cairn list [--kind decision] [--project name] [--all] [--q text] [--json]
  cairn show <note-id>
  cairn context [--project name] [--agent handle]
  cairn timeline [--days 14] [--project name]
  cairn stats [--project name]
  cairn export [--out graph.json]
  cairn doctor

Clients:
  claude-code, cursor, antigravity, vscode, codex, gemini, windsurf, zed,
  omnirush, opencode, generic

Memory model:
  Every note is Markdown with YAML frontmatter in a .cairn vault. Wikilinks,
  typed relations, files, projects, agents, sessions, and handoffs form a graph.
  The MCP surface has 14 tools: context, write, update, search, get, link, graph,
  timeline, session start/end, capture changes, send, inbox, handoff.

Quick start:
  cairn                          # create/find the vault, serve the workspace, open it
  cairn start --connect claude-code --git-hooks
  cairn status                   # vault, memory, workspace, wired clients

Workspace security:
  The workspace and API require a password. The first 'cairn start' generates one
  and prints it once. The scrypt hash and session secret live in .cairn/state/auth.json.
  cairn auth status              # where auth lives, when it last changed
  cairn auth reset [new-pass]    # new password; signs out every browser
  cairn auth set-password [pass] # set specific password
  CAIRN_NEW_PASSWORD=… cairn auth set-password
  CAIRN_PASSWORD=…               # first-run only: choose the password non-interactively

  Remote / cloud (TLS required):
    CAIRN_ALLOWED_HOSTS=cairn.example.com CAIRN_SECURE_COOKIE=1
      cairn start --host 0.0.0.0 --allow-remote
    Refuses non-loopback binds unless --allow-remote is passed and
    CAIRN_ALLOWED_HOSTS is set. Put HTTPS in front; the cookie is Secure.

Agent skill:
  cairn skill                    # show where the skill and rule are installed
  cairn skill --install          # .agents/skills/cairn + .claude/skills/cairn
  cairn connect <client>         # also installs the skill for supported clients
`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'init':
      await commandInit();
      break;
    case 'mcp':
      await commandMcp();
      break;
    case 'start':
      await commandStart();
      break;
    case 'status':
      await commandStatus();
      break;
    case 'skill':
      await commandSkill();
      break;
    case 'ui':
      await commandUi();
      break;
    case 'connect': {
      const clients = parsed.positionals.length ? parsed.positionals : optAll('client');
      if (!clients.length) throw new Error('Usage: cairn connect <client> [more clients...]');
      const results: ConnectResult[] = [];
      for (const client of clients) results.push(connectClient(client, bool('dry-run')));
      print(`Cairn connect${bool('dry-run') ? ' (dry run)' : ''}`);
      print(`  vault:   ${intendedVaultDir(bool('global'))}`);
      print(`  project: ${opt('project') || detectProjectName(process.cwd())}`);
      print('');
      for (const result of results) {
        print(`${result.client}: ${result.files.length ? result.files.join(', ') : 'printed config only'}`);
        for (const note of result.notes) print(`  - ${note}`);
      }
      break;
    }
    case 'capture-commit':
      await commandCaptureCommit();
      break;
    case 'capture-file':
      await commandCaptureFile();
      break;
    case 'hook':
      await commandHook(parsed.positionals[0] || 'session-start');
      break;
    case 'list':
      commandList();
      break;
    case 'show':
      await commandShow(parsed.positionals[0]);
      break;
    case 'context':
      await commandContext();
      break;
    case 'timeline':
      await commandTimeline();
      break;
    case 'stats':
      await commandStats();
      break;
    case 'export':
      await commandExport();
      break;
    case 'doctor':
      commandDoctor();
      break;
    case 'auth':
      commandAuth(parsed.positionals[0] || 'status', parsed.positionals[1]);
      break;
    case 'reset':
    case 'reset-password':
      commandAuth('reset', parsed.positionals[0]);
      break;
    case 'set-password':
      commandAuth('set-password', parsed.positionals[0]);
      break;
    case 'version':
    case '--version':
    case '-v':
      print(CAIRN_VERSION);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\nRun \`cairn help\` for usage.`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cairn: ${message}\n`);
  process.exit(1);
});
