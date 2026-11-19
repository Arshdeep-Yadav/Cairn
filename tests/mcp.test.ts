import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-mcp-'));
const vault = path.join(tempRoot, 'vault');
const repo = path.join(tempRoot, 'repo');

let client: Client;
let transport: StdioClientTransport;
let decisionId = '';
let riskId = '';

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((entry): entry is { type: 'text'; text: string } => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
}

function noteId(text: string): string {
  const match = text.match(/\b01[0-9a-z]{24}\b/);
  if (!match) throw new Error(`No note id in response:\n${text}`);
  return match[0];
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(firstText(result));
  return firstText(result);
}

beforeAll(async () => {
  execFileSync(process.execPath, [CLI, 'init', '--vault', vault, '--project', 'smoke'], {
    cwd: tempRoot,
    stdio: 'pipe',
  });

  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'events.ts'), 'export const log: string[] = [];\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'agent@cairn.test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test Agent'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'Add the event log'], { cwd: repo });

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--vault', vault, '--project', 'smoke', '--agent', 'test-agent'],
    stderr: 'pipe',
  });
  client = new Client({ name: 'cairn-smoke', version: '1.0.0' });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('cairn mcp surface', () => {
  it('lists the fourteen memory tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toHaveLength(14);
    expect(names).toContain('memory_context');
    expect(names).toContain('capture_changes');
    expect(names).toContain('memory_handoff');
  });

  it('runs a full decision, risk, and handoff workflow', async () => {
    const brief = await call('memory_context');
    expect(brief).toContain('Cairn memory');

    const session = await call('memory_start_session', {
      goal: 'Verify the memory workflow end to end',
      client: 'vitest',
    });
    expect(session).toContain('Session');
    expect(session).toContain('started');

    const decisionText = await call('memory_write', {
      kind: 'decision',
      title: 'Adopt an append-only event log',
      body: '## Decision\n\nEvery state change appends to [[events]].\n\n## Why\n\nReplay and audit both need an ordered history.',
      status: 'proposed',
      tags: ['architecture'],
      files: ['events.ts'],
    });
    decisionId = noteId(decisionText);
    expect(decisionText).toContain('Adopt an append-only event log');

    const riskText = await call('memory_write', {
      kind: 'risk',
      title: 'Poison events can stall replay',
      body: 'A malformed event can stop the replay loop unless the reader skips and reports it.',
      status: 'open',
      related: [decisionId],
    });
    expect(riskText).toContain('Auto-linked context');
    riskId = noteId(riskText.replace(decisionId, ''));

    const updateText = await call('memory_update', {
      id: decisionId,
      status: 'accepted',
      body: 'Accepted after the replay prototype.',
    });
    expect(updateText).toContain('accepted');

    const linkText = await call('memory_link', {
      from: riskId,
      to: decisionId,
      type: 'blocks',
    });
    expect(linkText).toContain('blocks');

    const search = await call('memory_search', { query: 'append-only event log' });
    expect(search).toContain('Adopt an append-only event log');

    const note = await call('memory_get', { id: riskId });
    expect(note).toContain('Poison events can stall replay');
    expect(note).toContain('blocks');

    const graph = await call('memory_graph', {
      seeds: [decisionId],
      depth: 2,
      include_files: true,
    });
    expect(graph).toContain('Graph memory');
    expect(graph).toContain('Adopt an append-only event log');

    const timeline = await call('memory_timeline', { days: 1 });
    expect(timeline).toContain('Adopt an append-only event log');

    const capture = await call('capture_changes', { scope: 'commit', repo });
    expect(capture).toContain('Add the event log');
    expect(capture).toContain('1 file');

    const message = await call('memory_send', {
      to: '*',
      subject: 'Replay prototype is ready',
      body: 'The append-only log prototype is on the branch. Please review the poison-event handling.',
      priority: 'high',
    });
    expect(message).toContain('Sent');

    const inbox = await call('memory_inbox', { mark_read: true });
    expect(inbox).toContain('Replay prototype is ready');

    const handoff = await call('memory_handoff', {
      to: 'codex',
      summary: 'Replay works; poison-event reporting still needs tests.',
      next_steps: ['Add a malformed-event test', 'Wire the report into memory'],
      files: ['events.ts'],
    });
    expect(handoff).toContain('Handoff created');
    expect(handoff).toContain('Next steps: 2');
    expect(handoff).not.toContain('· \n');

    const ended = await call('memory_end_session', {
      summary: 'Validated the full memory pipeline.',
      next_steps: ['Add poison-event tests'],
    });
    expect(ended).toContain('closed');
    expect(ended).toContain('Captured');
  }, 30_000);

  it('serves both memory resources', async () => {
    const resources = await client.listResources();
    expect(resources.resources.some((resource) => resource.uri === 'cairn://overview')).toBe(true);

    const overview = await client.readResource({ uri: 'cairn://overview' });
    const overviewText = overview.contents
      .filter((entry): entry is { uri: string; text: string; mimeType?: string } => 'text' in entry)
      .map((entry) => entry.text)
      .join('\n');
    expect(overviewText).toContain('Cairn');

    const brief = await client.readResource({ uri: 'cairn://projects/smoke/brief' });
    const briefText = brief.contents
      .filter((entry): entry is { uri: string; text: string; mimeType?: string } => 'text' in entry)
      .map((entry) => entry.text)
      .join('\n');
    expect(briefText).toContain('Poison events can stall replay');
  });
});
