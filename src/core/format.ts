import type { ContextData, Note, NoteSummary, SearchHit } from './types.js';
import type { GetResult } from './store.js';
import { humanizeHandle, relativeTime, stripMarkdown, truncate } from './text.js';

function titleCaseProject(project: string): string {
  return humanizeHandle(project) || project;
}

function line(summary: NoteSummary, options: { showKind?: boolean; showAgent?: boolean } = {}): string {
  const bits = [
    options.showKind === false ? summary.status : `${summary.kind}/${summary.status}`,
    options.showAgent && summary.agent ? humanizeHandle(summary.agent) : undefined,
    `\`${summary.id}\``,
    relativeTime(summary.updated),
  ].filter(Boolean);
  return `- **${summary.title}** — ${bits.join(' · ')}`;
}

function section(title: string, items: string[]): string[] {
  if (!items.length) return [];
  return ['', `## ${title}`, ...items];
}

export function renderContext(data: ContextData, options: { compact?: boolean } = {}): string {
  const compact = options.compact === true;
  const project = titleCaseProject(data.project);
  const agent = humanizeHandle(data.agent || 'agent');
  const counts = [
    `${data.total} notes`,
    `${data.counts.decision || 0} decisions`,
    `${data.counts.change || 0} changes`,
    `${data.counts.question || 0} questions`,
  ];
  const out: string[] = [
    `# Cairn memory · ${project}`,
    `${counts.join(' · ')} · updated ${relativeTime(data.generatedAt)}${data.agent ? ` · agent **${agent}**` : ''}`,
  ];

  const take = <T,>(items: T[]): T[] => (compact ? items.slice(0, 3) : items);
  if (!data.total) {
    out.push(
      '',
      'No memory has been recorded for this project yet.',
      '',
      'Start by recording a decision with `memory_write`, then capture changes with `capture_changes`.',
    );
    return out.join('\n');
  }

  out.push(
    ...section(
      'Decisions in force',
      take(data.decisions).map((item) => line(item, { showKind: false })),
    ),
  );
  out.push(
    ...section(
      'Awaiting a decision',
      take(data.proposals).map((item) => line(item, { showKind: false })),
    ),
  );
  out.push(
    ...section(
      'Open questions',
      take(data.questions).map((item) => line(item, { showKind: false })),
    ),
  );
  out.push(
    ...section(
      'Risks',
      take(data.risks).map((item) => line(item, { showKind: false })),
    ),
  );
  out.push(
    ...section(
      'In progress',
      take(data.tasks).map((item) => line(item, { showKind: false })),
    ),
  );
  out.push(
    ...section(
      'Recent changes',
      take(data.changes).map((item) =>
        line(item, { showKind: false, showAgent: true }),
      ),
    ),
  );
  out.push(
    ...section(
      `Handoffs & messages for ${agent}`,
      [
        ...take(data.handoffs).map((item) => line(item, { showKind: false })),
        ...take(data.messages).map((item) => line(item, { showKind: false })),
      ],
    ),
  );
  out.push(
    ...section(
      'Working notes',
      take(data.conventions).map((item) => line(item, { showKind: false })),
    ),
  );
  if (!compact) {
    out.push(
      ...section(
        'Active agents',
        data.agents
          .filter((entry) => entry.online)
          .slice(0, 5)
          .map(
            (entry) =>
              `- **${entry.label}** · online${entry.goal ? ` · ${truncate(entry.goal, 90)}` : entry.project ? ` · ${humanizeHandle(entry.project)}` : ''}${entry.session ? ` · \`${entry.session}\`` : ''}`,
          ),
      ),
    );
    out.push(
      ...section(
        'Files with the most context',
        data.files.slice(0, 5).map((file) => `- \`${file.path}\` · ${file.noteCount} notes`),
      ),
    );
    out.push(
      ...section(
        'Recent sessions',
        data.sessions.slice(0, 3).map((item) => line(item, { showKind: false })),
      ),
    );
  }
  if (!compact) {
    out.push(
      '',
      '---',
      'Use `memory_get <id>` for full context, `memory_search` to explore, and `memory_graph` for relationships.',
    );
  }
  const text = out.join('\n');
  return compact ? truncate(text, 2200) : text;
}

export function renderSearch(hits: SearchHit[], query: string, project?: string): string {
  const scope = project ? ` · project ${project}` : '';
  if (!hits.length) {
    return `No memory found for **${query || '(empty query)'}**${scope}.\n\nTry fewer words, or record this as new memory with \`memory_write\`.`;
  }
  const lines = [`# ${hits.length} result${hits.length === 1 ? '' : 's'} for “${query || 'recent notes'}”${scope}`, ''];
  hits.forEach((hit, index) => {
    const note = hit.note;
    lines.push(
      `${index + 1}. **${note.title}**`,
      `   ${note.kind}/${note.status} · ${humanizeHandle(note.project || '')}${note.agent ? ` · ${humanizeHandle(note.agent)}` : ''} · ${relativeTime(note.updated)} · \`${note.id}\``,
    );
    if (hit.snippet) lines.push(`   ${hit.snippet.replace(/\s+/g, ' ')}`);
    lines.push(`   ${note.path}`);
  });
  lines.push('', 'Use `memory_get` with an id for the full note and its links.');
  return lines.join('\n');
}

export function renderNote(result: GetResult): string {
  const { note } = result;
  const meta = [
    `**${note.kind}**`,
    `status: ${note.status}`,
    note.project ? `project: ${humanizeHandle(note.project)}` : undefined,
    note.agent ? `agent: ${humanizeHandle(note.agent)}` : undefined,
    `updated ${relativeTime(note.updated)}`,
  ].filter(Boolean);
  const out = [
    `# ${note.title}`,
    meta.join(' · '),
    `id: \`${note.id}\``,
    `created: ${note.created}`,
    `file: \`${note.path}\``,
    ...(note.tags.length ? [`tags: ${note.tags.map((tag) => `#${tag}`).join(' ')}`] : []),
    ...(note.to.length ? [`to: ${note.to.map(humanizeHandle).join(', ')}`] : []),
    ...(note.session ? [`session: \`${note.session}\``] : []),
    '',
    note.body.trim() || '_Empty note._',
  ];
  if (note.supersedes.length) {
    out.push('', '## Supersedes', ...note.supersedes.map((ref) => `- \`${ref}\``));
  }
  if (note.relations.length) {
    out.push(
      '',
      '## Relations',
      ...note.relations.map((relation) => `- ${relation.type} → \`${relation.to}\``),
    );
  }
  const outgoing = result.outgoing.filter((entry) => entry.node.kind !== 'project' && entry.node.kind !== 'agent');
  const backlinks = result.backlinks.filter(
    (entry) => entry.node.kind !== 'project' && entry.node.kind !== 'agent' && entry.node.kind !== 'file',
  );
  if (outgoing.length) {
    out.push(
      '',
      '## Links out',
      ...outgoing.slice(0, 20).map((entry) => `- ${entry.edge.type} → ${entry.node.label} (\`${entry.node.id}\`)`),
    );
  }
  if (backlinks.length) {
    out.push(
      '',
      '## Linked from',
      ...backlinks.slice(0, 20).map((entry) => `- ${entry.node.label} — ${entry.edge.type} (\`${entry.node.id}\`)`),
    );
  }
  if (note.files.length) {
    out.push('', '## Files', ...note.files.slice(0, 40).map((file) => `- \`${file}\``));
  }
  if (result.related.length) {
    out.push(
      '',
      '## Related',
      ...result.related.map(
        (entry) => `- **${entry.note.title}** · ${entry.types.join(', ')} · \`${entry.note.id}\``,
      ),
    );
  }
  return out.join('\n');
}

export function renderInbox(notes: Note[], agent: string): string {
  if (!notes.length) return `# Inbox for ${humanizeHandle(agent)}\n\nNo unread messages or handoffs.`;
  const out = [`# Inbox for ${humanizeHandle(agent)} · ${notes.length} item${notes.length === 1 ? '' : 's'}`, ''];
  for (const note of notes) {
    const from = typeof note.metadata?.from === 'string' ? note.metadata.from : note.agent;
    out.push(
      `## ${note.kind === 'handoff' ? 'Handoff' : 'Message'} · ${note.title}`,
      `${from ? `from ${humanizeHandle(from)} · ` : ''}${note.status} · ${relativeTime(note.updated)} · \`${note.id}\``,
      '',
      truncate(stripMarkdown(note.body), 700),
      '',
    );
  }
  out.push('Mark items read with `memory_update` (`status: "read"`), or reply with `memory_send` and `reply_to`.');
  return out.join('\n');
}

export function renderTimeline(hits: SearchHit[], project?: string): string {
  if (!hits.length) return 'No recent activity.';
  const out = [`# Timeline${project ? ` · ${titleCaseProject(project)}` : ''}`, ''];
  let currentDay = '';
  for (const hit of hits) {
    const day = new Date(hit.note.created).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    if (day !== currentDay) {
      currentDay = day;
      out.push(`## ${day}`);
    }
    out.push(line(hit.note, { showAgent: true }));
  }
  return out.join('\n');
}

export function renderStats(stats: {
  notes: number;
  edges: number;
  projects: number;
  agents: number;
  unreadMessages: number;
  activeSessions: number;
  vaultPath: string;
  project: string;
  byKind: Record<string, number | undefined>;
}): string {
  const kinds = Object.entries(stats.byKind)
    .filter(([, count]) => count)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .map(([kind, count]) => `- ${kind}: ${count}`)
    .join('\n');
  return [
    '# Cairn vault',
    `- Vault: \`${stats.vaultPath}\``,
    `- Default project: ${humanizeHandle(stats.project)}`,
    `- Notes: ${stats.notes}`,
    `- Graph edges: ${stats.edges}`,
    `- Projects: ${stats.projects}`,
    `- Agents: ${stats.agents}`,
    `- Active sessions: ${stats.activeSessions}`,
    `- Unread messages: ${stats.unreadMessages}`,
    '',
    '## Notes by kind',
    kinds || '- No notes yet',
  ].join('\n');
}
