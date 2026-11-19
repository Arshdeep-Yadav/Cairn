/**
 * Cairn — shared graph memory for coding agents.
 *
 * Public programmatic surface. The MCP server and CLI are the primary
 * integrations; these exports are for embedding Cairn in another tool.
 */

export { createCairnMcpServer, type CairnMcpOptions } from './mcp/server.js';
export { startUiServer, openBrowser, type UiServer, type UiServerOptions } from './cli/ui-server.js';
export {
  Store,
  openStore,
  type StoreOptions,
  type OpenStoreOptions,
  type SessionEndInput,
  type SessionEndResult,
  type CaptureFileInput,
  type WriteResult,
  type GetResult,
} from './core/store.js';
export { VaultIndex, type Neighbor, type TargetInfo } from './core/indexer.js';
export {
  Vault,
  initVault,
  loadConfig,
  resolveVaultDir,
  detectProjectName,
  findProjectRoot,
  vaultExists,
  parseNote,
  serializeNote,
  CAIRN_VERSION,
  type InitOptions,
} from './core/vault.js';
export {
  KINDS,
  KIND_LABELS,
  KIND_FOLDERS,
  DEFAULT_STATUS,
  STATUS_OPTIONS,
  EDGE_TYPES,
  type AnyEdgeType,
  type AgentInfo,
  type CaptureOptions,
  type CaptureResult,
  type ContextData,
  type Edge,
  type EdgeType,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type GraphOptions,
  type InboxOptions,
  type Kind,
  type MessageInput,
  type NodeKind,
  type Note,
  type NoteInput,
  type NotePatch,
  type NoteSummary,
  type PresenceEntry,
  type ProjectInfo,
  type Relation,
  type SearchHit,
  type SearchOptions,
  type SessionResult,
  type SessionStartInput,
  type VaultConfig,
  type VaultStats,
} from './core/types.js';
export {
  renderContext,
  renderInbox,
  renderNote,
  renderSearch,
  renderStats,
  renderTimeline,
} from './core/format.js';
export { newId, ulid, shortId, handle, safeKey, slugify } from './core/ids.js';
export { redactSecrets, isSensitivePath, isIgnoredPath } from './core/redact.js';
export { extractWikiLinks, wikiLink, normalizeFilePath } from './core/links.js';
export { detectProjectName as detectProject } from './core/vault.js';
