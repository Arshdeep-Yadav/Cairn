import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

const cache = new Map<string, string>();

function readGuide(relative: string): string {
  const cached = cache.get(relative);
  if (cached !== undefined) return cached;
  const file = path.join(PACKAGE_ROOT, relative);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`Cairn is missing its agent guide (${relative}). Reinstall cairn-memory.`);
  }
  cache.set(relative, text);
  return text;
}

/** The always-on rule block injected into CLAUDE.md, AGENTS.md, and client rule files. */
export function cairnRuleText(): string {
  return readGuide(path.join('rules', 'cairn.md'));
}

/** The long-form agent skill installed into supported skill directories. */
export function cairnSkillText(): string {
  return readGuide(path.join('skills', 'cairn', 'SKILL.md'));
}

/** Project-relative skill directories, per client. Empty means the client gets the rule only. */
export function skillDirsForClient(client: string): string[] {
  switch (client) {
    case 'claude-code':
      return ['.claude/skills/cairn'];
    case 'antigravity':
    case 'opencode':
    case 'omnirush':
    case 'hermes':
    case 't3-code':
    case 'pi':
    case 'command-code':
    case 'generic':
      return ['.agents/skills/cairn'];
    default:
      return [];
  }
}

/** Every standard project skill location, used by `cairn skill --install`. */
export const ALL_SKILL_DIRS = ['.agents/skills/cairn', '.claude/skills/cairn'] as const;
