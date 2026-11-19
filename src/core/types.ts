export const KINDS = [
  'decision',
  'change',
  'insight',
  'question',
  'answer',
  'handoff',
  'message',
  'session',
  'spec',
  'risk',
  'task',
  'note',
  'project',
  'agent',
] as const;

export type Kind = (typeof KINDS)[number];

export const KIND_LABELS: Record<Kind, string> = {
  decision: 'Decision',
  change: 'Change',
  insight: 'Insight',
  question: 'Question',
  answer: 'Answer',
  handoff: 'Handoff',
  message: 'Message',
  session: 'Session',
  spec: 'Spec',
  risk: 'Risk',
  task: 'Task',
  note: 'Note',
  project: 'Project',
  agent: 'Agent',
};

/** Plural folder per kind, inside the notes vault. */
export const KIND_FOLDERS: Record<Kind, string> = {
  decision: 'decisions',
  change: 'changes',
  insight: 'insights',
  question: 'questions',
  answer: 'answers',
  handoff: 'handoffs',
  message: 'messages',
  session: 'sessions',
  spec: 'specs',
  risk: 'risks',
  task: 'tasks',
  note: 'notes',
  project: 'projects',
  agent: 'agents',
};

export const DEFAULT_STATUS: Record<Kind, string> = {
  decision: 'accepted',
  change: 'active',
  insight: 'active',
  question: 'open',
  answer: 'answered',
  handoff: 'unread',
  message: 'unread',
  session: 'active',
  spec: 'active',
  risk: 'open',
  task: 'todo',
  note: 'active',
  project: 'active',
  agent: 'active',
};

export const STATUS_OPTIONS: Record<Kind, string[]> = {
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  change: ['active', 'in_progress', 'committed', 'captured', 'archived'],
  insight: ['active', 'archived'],
  question: ['open', 'answered', 'archived'],
  answer: ['answered', 'archived'],
  handoff: ['unread', 'read', 'done'],
  message: ['unread', 'read'],
  session: ['active', 'done', 'abandoned'],
  spec: ['draft', 'active', 'archived'],
  risk: ['open', 'mitigated', 'accepted'],
  task: ['todo', 'doing', 'done', 'blocked'],
  note: ['active', 'archived'],
  project: ['active', 'paused', 'archived'],
  agent: ['active', 'archived'],
};

export const EDGE_TYPES = [
  'mentions',
  'relates_to',
  'supersedes',
  'implements',
  'supports',
  'contradicts',
  'depends_on',
  'blocks',
  'answers',
  'replies_to',
  'touches',
  'part_of',
  'authored_by',
  'in_session',
  'addressed_to',
  'handoff_to',
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];
export type AnyEdgeType = EdgeType | (string & {});

export interface Relation {
  to: string;
  type: AnyEdgeType;
}

export interface Note {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  project?: string;
  agent?: string;
  session?: string;
  tags: string[];
  files: string[];
  to: string[];
  related: string[];
  supersedes: string[];
  repliesTo?: string;
  relations: Relation[];
  created: string;
  updated: string;
  body: string;
  /** Path relative to the vault root, POSIX separators. */
  path: string;
  metadata: Record<string, unknown>;
  aliases: string[];
}

export interface NoteInput {
  kind: Kind;
  title: string;
  body?: string;
  status?: string;
  project?: string;
  agent?: string;
  session?: string;
  tags?: string[];
  files?: string[];
  to?: string[];
  related?: string[];
  supersedes?: string[];
  replies_to?: string;
  relations?: Relation[];
  metadata?: Record<string, unknown>;
  /** Idempotency key, scoped to project + kind. */
  dedupe_key?: string;
  /** Only used by imports and seeds. Not exposed over MCP. */
  created?: string;
  updated?: string;
  /** Disable automatic related-note linking. */
  no_auto_link?: boolean;
}

export interface NotePatch {
  title?: string;
  body?: string;
  append?: boolean;
  status?: string;
  project?: string;
  agent?: string;
  tags?: string[];
  files?: string[];
  to?: string[];
  related?: string[];
  supersedes?: string[];
  relations?: Relation[];
  metadata?: Record<string, unknown>;
}

export interface NoteSummary {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  project?: string;
  agent?: string;
  session?: string;
  tags: string[];
  files: string[];
  to: string[];
  created: string;
  updated: string;
  path: string;
  snippet: string;
  degree: number;
}

export interface Edge {
  from: string;
  to: string;
  type: AnyEdgeType;
  weight: number;
}

export type NodeKind = Kind | 'file' | 'project' | 'agent' | 'session' | 'missing' | 'tag';

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  noteId?: string;
  status?: string;
  project?: string;
  agent?: string;
  path?: string;
  degree: number;
  updated?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: AnyEdgeType;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodes: number;
    edges: number;
    totalNotes: number;
    totalEdges: number;
    truncated: boolean;
    seeds?: string[];
  };
}

export interface SearchOptions {
  query?: string;
  kinds?: Kind[];
  project?: string;
  agent?: string;
  status?: string | string[];
  tags?: string[];
  session?: string;
  files?: string[];
  to?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
  sort?: 'relevance' | 'updated' | 'created';
}

export interface SearchHit {
  note: NoteSummary;
  score: number;
  snippet: string;
  matched: string[];
}

export interface GraphOptions {
  seeds?: string[];
  query?: string;
  depth?: number;
  kinds?: Kind[];
  project?: string;
  edgeTypes?: string[];
  includeVirtual?: boolean;
  limit?: number;
}

export interface VaultConfig {
  version: 1;
  name: string;
  project: string;
  createdAt: string;
  settings: {
    autoLink: boolean;
    redact: boolean;
  };
}

export interface PresenceEntry {
  agent: string;
  project?: string;
  session?: string;
  cwd?: string;
  client?: string;
  startedAt?: string;
  lastSeen: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  label: string;
  online: boolean;
  lastSeen?: string;
  project?: string;
  session?: string;
  sessionTitle?: string;
  goal?: string;
  counts: Record<string, number>;
  total: number;
  recent: NoteSummary[];
}

export interface ProjectInfo {
  name: string;
  label: string;
  total: number;
  counts: Partial<Record<Kind, number>>;
  agents: string[];
  openDecisions: number;
  openQuestions: number;
  files: number;
  lastActivity: string;
}

export interface VaultStats {
  notes: number;
  edges: number;
  projects: number;
  agents: number;
  byKind: Partial<Record<Kind, number>>;
  unreadMessages: number;
  activeSessions: number;
  vaultPath: string;
  project: string;
}

export interface ContextData {
  project: string;
  agent?: string;
  generatedAt: string;
  counts: Partial<Record<Kind, number>>;
  total: number;
  decisions: NoteSummary[];
  proposals: NoteSummary[];
  questions: NoteSummary[];
  risks: NoteSummary[];
  tasks: NoteSummary[];
  changes: NoteSummary[];
  sessions: NoteSummary[];
  conventions: NoteSummary[];
  handoffs: NoteSummary[];
  messages: NoteSummary[];
  agents: AgentInfo[];
  files: Array<{ path: string; noteCount: number }>;
}

export interface SessionStartInput {
  agent: string;
  project?: string;
  goal?: string;
  cwd?: string;
  model?: string;
  client?: string;
  source?: string;
  clientSession?: string;
  session?: string;
}

export interface SessionResult {
  session: Note;
  resumed: boolean;
  context: ContextData;
}

export interface CaptureOptions {
  project?: string;
  repo?: string;
  scope?: 'auto' | 'workspace' | 'commit';
  commit?: string;
  includeDiff?: boolean;
  agent?: string;
  session?: string;
}

export interface CaptureResult {
  notes: Note[];
  created: number;
  existing: number;
  mode: 'workspace' | 'commit';
  summary: string;
}

export interface MessageInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  project?: string;
  session?: string;
  priority?: 'low' | 'normal' | 'high';
  replyTo?: string;
  kind?: 'message' | 'handoff';
  nextSteps?: string[];
  files?: string[];
}

export interface InboxOptions {
  agent: string;
  project?: string;
  unreadOnly?: boolean;
  markRead?: boolean;
  limit?: number;
  includeDone?: boolean;
}

export interface WorklogState {
  noteId: string;
  notePath: string;
  agent: string;
  project: string;
  clientSession?: string;
  cairnSession?: string;
  createdAt: string;
  updatedAt: string;
  edits: number;
}

export interface ClientSessionState {
  cairnSessionId: string;
  notePath: string;
  agent: string;
  project: string;
  cwd?: string;
  startedAt: string;
}
