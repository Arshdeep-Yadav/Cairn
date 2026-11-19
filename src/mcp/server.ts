import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CAIRN_VERSION } from '../core/vault.js';
import { formatDate, humanizeHandle, relativeTime, truncate } from '../core/text.js';
import { KINDS } from '../core/types.js';
import { renderInbox, renderNote, renderSearch, renderStats, renderTimeline } from '../core/format.js';
import type { Store } from '../core/store.js';

export interface CairnMcpOptions {
  store: Store;
  agent: string;
  project: string;
  session?: string;
}

const KIND_VALUES = KINDS;

export function createCairnMcpServer(options: CairnMcpOptions): McpServer {
  const { store } = options;
  const agent = options.agent;
  const defaultProject = options.project;
  let currentSession: string | undefined = options.session;
  let lastPresence = 0;

  function touchPresence(): void {
    const now = Date.now();
    if (now - lastPresence < 15_000) return;
    lastPresence = now;
    try {
      store.touchPresence(agent, { project: defaultProject, session: currentSession, cwd: store.cwd });
    } catch {
      // Presence is best-effort.
    }
  }

  function fail(error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: 'text', text: `Cairn error: ${message}` }],
    };
  }

  async function execute(fn: () => string | Promise<string>): Promise<CallToolResult> {
    touchPresence();
    try {
      const text = await fn();
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return fail(error);
    }
  }

  function projectFor(project?: string, allProjects?: boolean): string | undefined {
    if (allProjects) return undefined;
    return store.resolveProject(project || defaultProject);
  }

  const instructions = `Cairn is the shared long-term memory for every coding agent working in this vault. It is a live graph: other agents read and write it, across sessions and projects.

BEFORE YOU WORK
- Call memory_context to load the project's decisions, open questions, risks, recent changes, and handoffs addressed to you.
- Use memory_search / memory_get to read relevant notes before changing code. Search first so you extend memory instead of duplicating it.

WHILE YOU WORK
- Record every meaningful decision, tradeoff, or rejected alternative as kind="decision" (status accepted or proposed). Include the why, alternatives considered, and consequences. One decision per note.
- Record durable learnings as kind="insight", unknowns as kind="question", constraints/dangers as kind="risk".
- After editing, run capture_changes to persist the git change set into memory, or use kind="change" with files when there is no git repo.
- Link notes by id using memory_link or memory_write's related/relations fields. Relationships are the point.
- Never store secrets, tokens, credentials, private keys, or full environment files. Be specific but concise.

COORDINATE
- memory_send is for agent-to-agent messages; memory_handoff hands unfinished work to another agent with context.
- memory_inbox shows messages and handoffs addressed to you. Set mark_read=true once handled.
- memory_start_session marks you online and returns the brief; memory_end_session records your summary and marks you offline.

Your handle is "${agent}". Your default project is "${defaultProject}". Tools default to both. Use all_projects=true when cross-project memory matters. The vault is at ${store.vaultDir}.`;

  const server = new McpServer(
    {
      name: 'cairn',
      title: 'Cairn — shared memory for agents',
      version: CAIRN_VERSION,
    },
    { instructions },
  );

  server.registerTool(
    'memory_context',
    {
      title: 'Get project memory brief',
      description:
        "Start here. Returns the project's living brief: decisions in force, proposals, open questions, risks, recent changes, handoffs, unread messages, active agents, and high-context files. Call at the start of a task or when switching projects. Optional focus runs a targeted search and appends matches. Response: Markdown with stable note ids for memory_get.",
      inputSchema: {
        project: z.string().optional().describe('Project handle. Defaults to this server\'s project.'),
        agent: z.string().optional().describe('Agent whose inbox/handoffs to include. Defaults to this server\'s agent.'),
        focus: z.string().optional().describe('Optional topic to search for and append to the brief.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const project = store.resolveProject(args.project || defaultProject);
        const inboxAgent = args.agent || agent;
        const brief = store.renderContext(project, inboxAgent);
        if (!args.focus?.trim()) return brief;
        const hits = store.search({ query: args.focus, project, limit: 5 });
        return `${brief}\n\n## Focus: ${args.focus}\n\n${renderSearch(hits, args.focus || '', project)}`;
      }),
  );

  server.registerTool(
    'memory_write',
    {
      title: 'Record a decision, change, or insight',
      description:
        'Write durable memory. Use one note per decision, change, insight, question, spec, risk, or task. Include the why, alternatives, and consequences; agents will rely on this later. Files are auto-linked to related notes. Never store secrets. Returns the new note id and path. For messages/handoffs use memory_send/memory_handoff; for sessions use memory_start_session.',
      inputSchema: {
        kind: z.enum(KIND_VALUES).describe('Note kind. Usually decision, change, insight, question, risk, task, spec, or note.'),
        title: z.string().min(1).max(180).describe('Short, specific title. This is the graph label; do not make it generic.'),
        body: z.string().optional().describe('Markdown body. For decisions: context, decision, why, alternatives, consequences.'),
        status: z.string().optional().describe('Lifecycle status. Decisions: proposed|accepted|rejected|superseded. Questions: open|answered. Risks: open|mitigated. Tasks: todo|doing|done. Defaults are sensible.'),
        project: z.string().optional().describe('Project handle. Defaults to this server\'s project.'),
        tags: z.array(z.string()).optional().describe('Lowercase tags, e.g. ["billing","architecture"].'),
        files: z.array(z.string()).optional().describe('Repo-relative file paths this note is about.'),
        related: z.array(z.string()).optional().describe('Note ids (or exact titles) to link with relates_to.'),
        supersedes: z.array(z.string()).optional().describe('Note ids of decisions this note replaces. Also consider setting the old note status to superseded.'),
        relations: z
          .array(z.object({ to: z.string(), type: z.string().optional() }))
          .optional()
          .describe('Typed edges: to = note id/title, type = relates_to|implements|supports|contradicts|depends_on|blocks|answers.'),
        to: z.array(z.string()).optional().describe('Agent recipients for message/handoff kinds.'),
        session: z.string().optional().describe('Session id. Defaults to this connection\'s active session.'),
        dedupe_key: z.string().optional().describe('Idempotency key scoped to project+kind. Repeating the same key returns the existing note.'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Small structured metadata (commit sha, branch, source URL). No secrets.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const session = args.session || currentSession;
        const result = store.write({
          kind: args.kind,
          title: args.title,
          body: args.body,
          status: args.status,
          project: args.project || defaultProject,
          agent,
          session,
          tags: args.tags,
          files: args.files,
          related: args.related,
          supersedes: args.supersedes,
          relations: args.relations?.map((relation) => ({
            to: relation.to,
            type: relation.type || 'relates_to',
          })),
          to: args.to,
          metadata: args.metadata,
          dedupe_key: args.dedupe_key,
        });
        const note = result.note;
        if (result.deduped) {
          return `Found existing **${note.kind}** \`${note.id}\` — **${note.title}** (dedupe key matched; nothing new written).\n\nStatus: ${note.status} · updated ${relativeTime(note.updated)}\nFile: \`${note.path}\`\n\nUse \`memory_get ${note.id}\` to read it.`;
        }
        const relatedTitles = note.related
          .slice(0, 5)
          .map((id) => store.index.getNote(id))
          .filter(Boolean)
          .map((entry) => `- ${entry!.title} (\`${entry!.id}\`)`);
        return [
          `Recorded **${note.kind}** \`${note.id}\` — **${note.title}**`,
          `project: ${humanizeHandle(note.project || '')} · status: ${note.status} · updated ${relativeTime(note.updated)}`,
          `file: \`${note.path}\``,
          ...(result.warnings.length ? ['', `Warnings: ${result.warnings.join(' ')}`] : []),
          ...(relatedTitles.length ? ['', 'Auto-linked context:', ...relatedTitles] : []),
          '',
          `Use \`memory_get ${note.id}\` to verify, or \`memory_link\` to add typed relationships.`,
        ].join('\n');
      }),
  );

  server.registerTool(
    'memory_update',
    {
      title: 'Update an existing note',
      description:
        'Update a note by id: append or replace its body, change status, tags, files, or typed relations. Append is the default for body edits, so outcomes can be added safely. Use status "read" for inbox items, "accepted"/"rejected"/"superseded" for decisions, "done" for handoffs/tasks.',
      inputSchema: {
        id: z.string().describe('Note id (or exact title).'),
        title: z.string().optional(),
        body: z.string().optional().describe('Markdown to append (default) or replace.'),
        append: z.boolean().optional().describe('Append to the body (default true). Set false to replace it.'),
        status: z.string().optional(),
        tags: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        relations: z
          .array(z.object({ to: z.string(), type: z.string().optional() }))
          .optional()
          .describe('Replaces the note\'s explicit typed relations.'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Merged into existing metadata.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const existing = store.get(args.id);
        if (!existing) throw new Error(`Note not found: ${args.id}`);
        const note = store.update(args.id, {
          title: args.title,
          body: args.body,
          append: args.append !== false,
          status: args.status,
          tags: args.tags,
          files: args.files,
          relations: args.relations?.map((relation) => ({
            to: relation.to,
            type: relation.type || 'relates_to',
          })),
          metadata: args.metadata,
        });
        return [
          `Updated **${note.kind}** \`${note.id}\` — **${note.title}**`,
          `status: ${note.status} · updated ${relativeTime(note.updated)}`,
          `file: \`${note.path}\``,
          '',
          `Use \`memory_get ${note.id}\` to read the current version.`,
        ].join('\n');
      }),
  );

  server.registerTool(
    'memory_search',
    {
      title: 'Search shared memory',
      description:
        'Search the shared vault across titles, bodies, tags, files, projects, and agents. Searches this project by default; set all_projects=true to search everything. Returns ranked notes with snippets and ids. Search before writing to avoid duplicate memory, and before coding to find prior decisions.',
      inputSchema: {
        query: z.string().describe('Keywords or a short phrase. Use quotes for an exact phrase.'),
        project: z.string().optional().describe('Project handle. Defaults to this server\'s project.'),
        all_projects: z.boolean().optional().describe('Search across every project in the vault.'),
        kinds: z.array(z.enum(KIND_VALUES)).optional().describe('Restrict to note kinds.'),
        status: z.union([z.string(), z.array(z.string())]).optional().describe('Restrict to one or more statuses.'),
        tags: z.array(z.string()).optional().describe('Require all of these tags.'),
        since_days: z.number().int().min(1).max(3650).optional().describe('Only notes updated in the last N days.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 12).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const project = projectFor(args.project, args.all_projects);
        const since = args.since_days
          ? new Date(Date.now() - args.since_days * 86_400_000).toISOString()
          : undefined;
        const hits = store.search({
          query: args.query,
          project,
          kinds: args.kinds,
          status: args.status,
          tags: args.tags,
          since,
          limit: args.limit ?? 12,
        });
        return renderSearch(hits, args.query, project);
      }),
  );

  server.registerTool(
    'memory_get',
    {
      title: 'Read a note and its links',
      description:
        'Read one note by id or exact title, with its full body, typed relations, links out, backlinks, files, session, and related notes. Use after memory_search or memory_context when an id looks relevant.',
      inputSchema: {
        id: z.string().describe('Note id (preferred) or exact title.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const result = store.get(args.id);
        if (!result) throw new Error(`Note not found: ${args.id}`);
        return renderNote(result);
      }),
  );

  server.registerTool(
    'memory_link',
    {
      title: 'Link two memories',
      description:
        'Create a typed edge between two notes. Relationship types: relates_to, implements, supports, contradicts, depends_on, blocks, answers, supersedes. Use this to make graph memory explicit — for example a change implements a decision, a risk blocks a task, or an answer answers a question.',
      inputSchema: {
        from: z.string().describe('Source note id or title.'),
        to: z.string().describe('Target note id or title.'),
        type: z.string().optional().describe('Relationship type (default relates_to).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const result = store.link(args.from, args.to, args.type || 'relates_to');
        return `Linked **${result.from.title}** \`${result.from.id}\` → **${result.to.title}** \`${result.to.id}\` · ${result.type}.`;
      }),
  );

  server.registerTool(
    'memory_graph',
    {
      title: 'Query graph memory',
      description:
        'Query the relationship graph around seed notes or a search query. Returns JSON {nodes, edges, stats}. Use for impact analysis: what implements, depends on, blocks, touches, or supersedes something. depth 1–4; include_files adds file nodes. Projects, agents, and files are virtual nodes with ids.',
      inputSchema: {
        seeds: z.array(z.string()).optional().describe('Note ids/titles to center the graph on.'),
        query: z.string().optional().describe('If no seeds, search this and use the top matches as seeds.'),
        depth: z.number().int().min(1).max(4).optional().describe('Traversal depth (default 2).'),
        kinds: z.array(z.enum(KIND_VALUES)).optional().describe('Restrict note node kinds.'),
        project: z.string().optional(),
        all_projects: z.boolean().optional(),
        include_files: z.boolean().optional().describe('Include file nodes and touches edges (default false).'),
        include_agents: z.boolean().optional().describe('Include agent and project hubs (default true).'),
        limit: z.number().int().min(10).max(500).optional().describe('Maximum nodes (default 200).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const project = projectFor(args.project, args.all_projects);
        const data = store.graph({
          seeds: args.seeds,
          query: args.query,
          depth: args.depth ?? 2,
          kinds: args.kinds,
          project,
          includeVirtual: true,
          limit: args.limit ?? 200,
        });
        let nodes = data.nodes;
        let edges = data.edges;
        const includeFiles = args.include_files === true;
        const includeAgents = args.include_agents !== false;
        const allowed = new Set(
          nodes
            .filter((node) => includeFiles || node.kind !== 'file')
            .filter((node) => includeAgents || (node.kind !== 'agent' && node.kind !== 'project'))
            .map((node) => node.id),
        );
        nodes = nodes.filter((node) => allowed.has(node.id));
        edges = edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to));
        const payload = {
          nodes,
          edges,
          stats: {
            ...data.stats,
            nodes: nodes.length,
            edges: edges.length,
            note: 'Virtual node kinds: file, project, agent, session, missing. Edge types include touches, part_of, authored_by, addressed_to, in_session, supersedes, implements.',
          },
        };
        return [
          `**Graph memory** · ${nodes.length} nodes · ${edges.length} edges${data.stats.truncated ? ' (truncated)' : ''}`,
          '',
          '```json',
          JSON.stringify(payload, null, 2),
          '```',
        ].join('\n');
      }),
  );

  server.registerTool(
    'memory_timeline',
    {
      title: 'Recent project activity',
      description:
        'Recent memory activity, newest first and grouped by day. Filter by project, agent, kinds, or days. Useful for catching up after time away or before a handoff.',
      inputSchema: {
        project: z.string().optional(),
        all_projects: z.boolean().optional(),
        agent: z.string().optional(),
        kinds: z.array(z.enum(KIND_VALUES)).optional(),
        days: z.number().int().min(1).max(365).optional().describe('Lookback window (default 14).'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const project = projectFor(args.project, args.all_projects);
        const hits = store.timeline({
          project,
          agent: args.agent,
          kinds: args.kinds,
          days: args.days ?? 14,
          limit: args.limit ?? 60,
        });
        return renderTimeline(hits, project);
      }),
  );

  server.registerTool(
    'memory_start_session',
    {
      title: 'Start an agent session',
      description:
        'Register this agent session, mark yourself online, and receive the project brief. Reuses a recent active session when one exists. The returned session id is used automatically by later writes on this connection. Call at the start of substantial work; include a concrete goal.',
      inputSchema: {
        goal: z.string().optional().describe('What this session is trying to accomplish.'),
        project: z.string().optional(),
        cwd: z.string().optional().describe('Working directory, for auditability.'),
        model: z.string().optional().describe('Model name, if useful for provenance.'),
        client: z.string().optional().describe('Client/IDE, e.g. claude-code, cursor, antigravity.'),
        client_session: z.string().optional().describe('The client\'s own session id, for hook deduplication.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const result = store.sessionStart({
          agent,
          project: args.project || defaultProject,
          goal: args.goal,
          cwd: args.cwd || store.cwd,
          model: args.model,
          client: args.client,
          clientSession: args.client_session,
        });
        currentSession = result.session.id;
        touchPresence();
        return [
          `Session \`${result.session.id}\` ${result.resumed ? 'resumed' : 'started'} for **${humanizeHandle(agent)}** · project ${humanizeHandle(result.session.project || '')}`,
          `Started: ${formatDate(result.session.created)}`,
          '',
          store.renderContext(result.session.project, agent),
        ].join('\n');
      }),
  );

  server.registerTool(
    'memory_end_session',
    {
      title: 'End an agent session',
      description:
        'Close the current or specified session with a summary, next steps, and the list of every note captured during it. Marks you offline. Call before finishing substantial work so the next agent can resume from a clean summary.',
      inputSchema: {
        session: z.string().optional().describe('Session id. Defaults to this connection\'s active session or your latest one.'),
        summary: z.string().optional().describe('What was accomplished, what changed, and what remains.'),
        next_steps: z.array(z.string()).optional().describe('Concrete follow-ups for the next agent.'),
        status: z.enum(['done', 'abandoned']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const result = store.sessionEnd({
          session: args.session || currentSession,
          agent,
          summary: args.summary,
          nextSteps: args.next_steps,
          status: args.status,
        });
        if (currentSession === result.session.id) currentSession = undefined;
        const captured = result.captured.length
          ? result.captured.slice(0, 25).map((note) => `- ${note.kind} — ${note.title} (\`${note.id}\`)`)
          : ['- No notes were linked to this session.'];
        return [
          `Session \`${result.session.id}\` closed.`,
          `**${result.session.title}**`,
          `Captured ${result.captured.length} note${result.captured.length === 1 ? '' : 's'}${Object.keys(result.counts).length ? `: ${Object.entries(result.counts).map(([kind, count]) => `${count} ${kind}`).join(', ')}` : ''}.`,
          '',
          '## Captured',
          ...captured,
          '',
          `File: \`${result.session.path}\``,
        ].join('\n');
      }),
  );

  server.registerTool(
    'capture_changes',
    {
      title: 'Capture git changes into memory',
      description:
        'Persist the current git change set as a change note with file list, stats, commit provenance, and automatic links to related decisions. scope=auto captures uncommitted work if present, otherwise HEAD. scope=commit takes an optional commit ref. Deduplicates identical captures. Diffs are omitted by default for safety.',
      inputSchema: {
        scope: z.enum(['auto', 'workspace', 'commit']).optional().describe('What to capture (default auto).'),
        commit: z.string().optional().describe('Commit ref for scope=commit (default HEAD).'),
        include_diff: z.boolean().optional().describe('Include a truncated diff (default false; may contain sensitive code).'),
        project: z.string().optional(),
        repo: z.string().optional().describe('Repository path. Defaults to this server\'s working directory.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const result = store.captureChanges({
          scope: args.scope || 'auto',
          commit: args.commit,
          includeDiff: args.include_diff === true,
          project: args.project || defaultProject,
          repo: args.repo,
          agent,
          session: currentSession,
        });
        const lines = [
          result.summary,
          '',
          ...result.notes.map(
            (note) =>
              `- **${note.title}** · \`${note.id}\` · ${note.files.length} files · ${relativeTime(note.updated)}`,
          ),
          '',
          `Use \`memory_get ${result.notes[0]?.id || ''}\` for the captured details.`,
        ];
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'memory_send',
    {
      title: 'Message another agent',
      description:
        'Send an agent-to-agent message. `to` is an agent handle such as "codex", "cursor", or "*" for every agent. Use for coordination, questions, review requests, or status. Messages appear in the recipient\'s memory_inbox and project brief. Use memory_handoff for substantial work transfer.',
      inputSchema: {
        to: z.string().describe('Recipient agent handle, or "*" to broadcast.'),
        subject: z.string().min(1).max(180),
        body: z.string().min(1).describe('Message body. Be specific and actionable.'),
        project: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        reply_to: z.string().optional().describe('Message id this replies to.'),
        files: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const note = store.send({
          from: agent,
          to: args.to,
          subject: args.subject,
          body: args.body,
          project: args.project || defaultProject,
          session: currentSession,
          priority: args.priority,
          replyTo: args.reply_to,
          files: args.files,
        });
        return [
          `Sent **${note.kind}** to **${args.to === '*' ? 'all agents' : humanizeHandle(args.to)}** · \`${note.id}\``,
          `**${note.title}**`,
          '',
          `File: \`${note.path}\``,
          '',
          'Set `mark_read=true` in memory_inbox once you process the response.',
        ].join('\n');
      }),
  );

  server.registerTool(
    'memory_inbox',
    {
      title: 'Read messages and handoffs',
      description:
        'Read messages and handoffs addressed to you (or broadcast). Unread only by default. Set mark_read=true after processing, or include_done=true to review closed handoffs. Use memory_update with status "done" to close a handoff.',
      inputSchema: {
        project: z.string().optional(),
        all_projects: z.boolean().optional().describe('Include messages from all projects.'),
        unread_only: z.boolean().optional().describe('Default true.'),
        mark_read: z.boolean().optional().describe('Mark returned messages as read (default false).'),
        include_done: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const project = args.all_projects ? undefined : store.resolveProject(args.project || defaultProject);
        const notes = store.inbox({
          agent,
          project,
          unreadOnly: args.unread_only !== false,
          markRead: args.mark_read === true,
          includeDone: args.include_done === true,
          limit: args.limit ?? 20,
        });
        return renderInbox(notes, agent);
      }),
  );

  server.registerTool(
    'memory_handoff',
    {
      title: 'Hand off work to another agent',
      description:
        'Hand unfinished work to another agent with a structured brief: summary, next steps, open questions, and files. Creates a handoff note addressed to them, linked to the current session. Use when another agent must continue without asking you what happened.',
      inputSchema: {
        to: z.string().describe('Recipient agent handle.'),
        summary: z.string().min(1).describe('What is done, what state the work is in, and what the next agent must know.'),
        next_steps: z.array(z.string()).optional().describe('Concrete numbered actions to take next.'),
        open_questions: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        title: z.string().optional().describe('Short handoff title.'),
        project: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      execute(() => {
        const body = [
          `## Summary`,
          args.summary,
          ...(args.open_questions?.length
            ? ['', '## Open questions', ...args.open_questions.filter(Boolean).map((item) => `- ${item}`)]
            : []),
        ].join('\n');
        const note = store.handoff({
          from: agent,
          to: args.to,
          subject: args.title || truncate(`Handoff: ${args.summary.replace(/\s+/g, ' ')}`, 90),
          body,
          project: args.project || defaultProject,
          session: currentSession,
          priority: args.priority,
          nextSteps: args.next_steps,
          files: args.files,
        });
        return [
          `Handoff created for **${humanizeHandle(args.to)}** · \`${note.id}\``,
          `**${note.title}**`,
          '',
          ...(args.next_steps?.length ? [`Next steps: ${args.next_steps.length}`] : []),
          `File: \`${note.path}\``,
          '',
          `They will see it in \`memory_inbox\`. Track completion with \`memory_update\` status "done".`,
        ].join('\n');
      }),
  );

  server.registerResource(
    'vault-overview',
    'cairn://overview',
    {
      title: 'Cairn vault overview',
      description: 'Vault statistics and the current project brief.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const stats = store.stats(defaultProject);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: `${renderStats(stats as unknown as Parameters<typeof renderStats>[0])}\n\n${store.renderContext(defaultProject, agent)}`,
          },
        ],
      };
    },
  );

  server.registerResource(
    'project-brief',
    new ResourceTemplate('cairn://projects/{project}/brief', {
      list: undefined,
      complete: {
        project: () => store.projectsInfo().map((project) => project.name),
      },
    }),
    {
      title: 'Project memory brief',
      description: 'The living brief for a project: decisions, open threads, changes, agents, and files.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const rawProject = Array.isArray(variables.project) ? variables.project[0] : variables.project;
      const project = String(rawProject || defaultProject);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: store.renderContext(project, agent),
          },
        ],
      };
    },
  );

  return server;
}
