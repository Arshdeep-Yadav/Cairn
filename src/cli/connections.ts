import fs from 'node:fs';
import path from 'node:path';

export type ClientCategory = 'editors' | 'terminal' | 'universal';
export type ClientInstallMode = 'writes' | 'prints';

export interface ClientSetup {
  id: string;
  name: string;
  note: string;
  category: ClientCategory;
  install: ClientInstallMode;
}

/** Coding systems the CLI can wire, grouped the way the setup UI presents them. */
export const CLIENT_SETUPS: ClientSetup[] = [
  { id: 'claude-code', name: 'Claude Code', note: 'MCP server, session hooks, CLAUDE.md, and a skill', category: 'editors', install: 'writes' },
  { id: 'cursor', name: 'Cursor', note: 'Project MCP config and an always-on rule', category: 'editors', install: 'writes' },
  { id: 'antigravity', name: 'Antigravity', note: 'Workspace MCP config, rule, AGENTS.md, and a skill', category: 'editors', install: 'writes' },
  { id: 'vscode', name: 'VS Code / Copilot', note: 'Workspace .mcp.json, AGENTS.md, and a rule', category: 'editors', install: 'writes' },
  { id: 'windsurf', name: 'Windsurf', note: 'Prints the MCP config to paste', category: 'editors', install: 'prints' },
  { id: 'zed', name: 'Zed', note: 'Prints the context_servers entry', category: 'editors', install: 'prints' },
  { id: 'codex', name: 'Codex', note: 'Prints TOML and updates AGENTS.md', category: 'terminal', install: 'prints' },
  { id: 'gemini', name: 'Gemini CLI', note: 'Prints settings JSON and updates GEMINI.md', category: 'terminal', install: 'prints' },
  { id: 'opencode', name: 'OpenCode', note: 'Prints a local server entry and installs the skill', category: 'terminal', install: 'prints' },
  { id: 'omnirush', name: 'Omnirush', note: 'Prints a local server entry and installs the skill', category: 'terminal', install: 'prints' },
  { id: 'hermes', name: 'Hermes Agent', note: 'Prints a stdio MCP entry; AGENTS.md and the shared skill are installed', category: 'terminal', install: 'prints' },
  { id: 't3-code', name: 'T3 Code', note: 'Prints a stdio MCP entry; AGENTS.md and the shared skill are installed', category: 'terminal', install: 'prints' },
  { id: 'pi', name: 'Pi', note: 'Prints a stdio MCP entry; AGENTS.md and the shared skill are installed', category: 'terminal', install: 'prints' },
  { id: 'command-code', name: 'Command Code', note: 'Prints a stdio MCP entry; AGENTS.md and the shared skill are installed', category: 'terminal', install: 'prints' },
  { id: 'generic', name: 'Anything else', note: 'Stdio MCP snippet and the shared skill', category: 'universal', install: 'prints' },
];

export interface WiredClient {
  id: string;
  label: string;
  file: string;
}

/**
 * MCP command shown to humans. Uses absolute paths because GUI-launched clients
 * do not inherit npm's global bin directory on PATH.
 */
export function mcpCommand(vaultDir: string, project: string, agent = '<handle>'): string {
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  const entry = path.resolve(import.meta.dirname, 'index.js');
  return `${quote(process.execPath)} ${quote(entry)} mcp --vault ${quote(vaultDir)} --project ${quote(project)} --agent ${agent}`;
}

/**
 * Inspect the current directory for client configs that already point at Cairn.
 * Read-only: never creates or rewrites anything.
 */
export function detectClientWiring(cwd: string): WiredClient[] {
  const found: WiredClient[] = [];
  const readJson = (relative: string): Record<string, unknown> | null => {
    try {
      const file = path.join(cwd, relative);
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf8');
      const value = JSON.parse(raw) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const hasCairn = (config: Record<string, unknown> | null, rootKey = 'mcpServers'): boolean => {
    if (!config) return false;
    const servers = config[rootKey];
    return Boolean(servers && typeof servers === 'object' && 'cairn' in (servers as Record<string, unknown>));
  };

  if (hasCairn(readJson('.mcp.json'))) found.push({ id: 'claude-code', label: 'Claude Code / VS Code', file: '.mcp.json' });
  if (hasCairn(readJson('.cursor/mcp.json'))) found.push({ id: 'cursor', label: 'Cursor', file: '.cursor/mcp.json' });
  if (hasCairn(readJson('.agents/mcp_config.json'))) found.push({ id: 'antigravity', label: 'Antigravity', file: '.agents/mcp_config.json' });
  if (hasCairn(readJson('.gemini/settings.json'))) found.push({ id: 'gemini', label: 'Gemini CLI', file: '.gemini/settings.json' });
  if (hasCairn(readJson('.vscode/mcp.json'), 'servers')) found.push({ id: 'vscode', label: 'VS Code', file: '.vscode/mcp.json' });

  const opencode = readJson('opencode.json');
  if (opencode && typeof opencode.mcp === 'object' && opencode.mcp && 'cairn' in (opencode.mcp as Record<string, unknown>)) {
    found.push({ id: 'opencode', label: 'OpenCode / Omnirush', file: 'opencode.json' });
  }

  try {
    const settingsFile = path.join(cwd, '.claude', 'settings.json');
    if (fs.existsSync(settingsFile) && fs.readFileSync(settingsFile, 'utf8').includes('cairn')) {
      found.push({ id: 'claude-code', label: 'Claude Code hooks', file: '.claude/settings.json' });
    }
  } catch {
    // Unreadable settings: ignore for display purposes.
  }
  return found;
}
