# Architecture

Cairn is deliberately boring: a folder of Markdown files, an in-memory derived index, and three servers (MCP stdio, CLI, HTTP) sharing one store. No database, no cloud, no daemon that must keep running for the memory to exist.

```
 src/core/    the vault (truth) and the graph (derived)
 src/mcp/     14 tools + 2 resources over stdio
 src/cli/     init/connect/hooks/capture + the UI server
 web/         no-build workspace app (vanilla JS)
```

## The vault is the source of truth

```
vault/
├── cairn.config.json        # name, project, settings { autoLink, redact }
├── README.md                # generated orientation page
├── notes/<kind>/YYYY-MM-DD-<kind>-<slug>-<id>.md
└── state/
    ├── auth.json            # scrypt password hash + session secret (0600)
    ├── .write.lock          # cross-process read-modify-write lock
    ├── sessions/            # session bookkeeping
    ├── inbox/               # per-agent unread markers
    └── backups/             # redacted copies of every client file connect touched
```

A note is Markdown with YAML frontmatter:

```yaml
---
id: 01J9ZK3W7Q4M8N2P6R8T0V2X4A   # ULID-ish, immutable
kind: decision                    # decision | change | insight | question | answer
                                  # spec | risk | task | message | handoff | session | note
title: Move rate limiting to the edge
status: accepted                  # kind-specific lifecycle
project: orbit-api
agent: cursor
session: 01J9ZK3W7Q4M8N2P6R8T0V2X4B
created: 2026-11-17T09:14:00.000Z
tags: [performance, edge]
files: [src/edge/limiter.ts]      # -> 'touches' edges to file nodes
related: [<id>]                   # -> 'relates_to'
relations:                        # typed edges
  - to: <id>
    type: implements
supersedes: [<id>]                # -> 'supersedes'
dedupe_key: <optional>            # repeated writes upsert instead of duplicating
aliases: [<id>, <title>]          # keeps Obsidian wikilinks resolving
metadata: {...}                   # tool-specific payload (commit sha, question status, …)
---

Body is free Markdown. Everything is hand-editable except `id`.
```

- **Kinds** map to folders; the kind also selects the status machine (`decision`: proposed → accepted/rejected/superseded; `question`: open → answered; `risk`: open → mitigated; `task`: open → done; `handoff`: open → completed…).
- **Writes are atomic** (temp file + rename, `0600` on POSIX), serialized by a reentrant cross-process lock at `state/.write.lock`, and pass a redaction pass first (see Security).
- **Deletion is lazy**: removing a note that others link to leaves a `missing` placeholder node, so the graph never has dangling references.

## The graph is derived

`src/core/indexer.ts` scans the vault into memory and builds:

- **Nodes** — one per note, plus virtual nodes for `project`, `agent`, `session`, and `file` (files come from frontmatter `files:`, agents from `agent:`, and so on). Node radius/degree comes from edge count, which is what the UI's force layout and label rules use.
- **Edges**, typed:

| Edge | From |
| --- | --- |
| `relates_to` | frontmatter `related:`, and auto-links between notes that share a `dedupe_key` |
| `<custom>` | frontmatter `relations:` — anything beyond the standard set is preserved as-is |
| `supersedes` | frontmatter `supersedes:` |
| `touches` / `mentions` | `[[wikilinks]]` — `file`-shaped targets become `touches`, note targets `mentions` |
| `authored_by` | note → agent node |
| `in_session` | note → session node |
| `part_of` | note → project node |
| `addressed_to` / `handoff_to` | message/handoff → agent nodes |
| `replies_to` / `answers` | message threading and question→answer links |

- **Backlinks** are computed in the same pass, so `memory_get` and the inspector can show incoming references without a second index.
- **`autoLink`** (vault setting) adds `relates_to` edges between notes that reference the same files, so "everything that touched `limiter.ts`" is one hop.

Nothing in the index is persisted; it is rebuilt from disk on every server start. The Markdown folder remains the only durable state — if you delete the index, you lose nothing. This is the same contract Obsidian uses.

## The store

`src/core/store.ts` wraps vault + indexer and implements every operation the MCP tools, CLI, and UI server share: write/update/search (ranked, with snippets), graph queries (seeds + depth + relation filters), timeline (grouped by day), sessions, capture, messages, inbox, handoffs.

`defaultProject` resolves in a fixed order: **explicit argument → vault config `project` → `detectProjectName(cwd)`** (folder name / package name). All three servers pass the same resolution, so a note written by the MCP server, the CLI, and the UI lands identically.

## The MCP server

`src/mcp/server.ts` runs over stdio with the official SDK and registers 14 tools + 2 resources (`cairn://overview`, `cairn://projects/{project}/brief`). One server instance = one agent: its `--agent` handle stamps every write, and `memory_start_session` opens the session that later writes auto-link to (`in_session`).

Responses are tuned for agent consumption: short ids plus titles, counts first, then details; errors are single-line and actionable. `memory_context` composes the same brief the UI's Brief page and `cairn context` CLI command show — one format, three surfaces.

## Hooks & capture

The Claude Code connector wires three hooks plus a git hook. They call back into the CLI (`cairn hook session-start|capture-file|session-end`, `cairn capture-commit`), which uses the same store:

- `SessionStart` → session note; on stdout, `hookSpecificOutput.additionalContext` carries the brief into the model's context.
- `PostToolUse` (Edit/Write) → files appended to a rolling per-day worklog note per agent (a `change`), so even never-committed edits have provenance.
- `SessionEnd` → session closed with a summary.
- git `post-commit` → the commit's change set captured with sha/author/branch/files/stats; file overlap auto-links it to related decisions.

Capture pipelines run path filters before anything is read: `.env*`, key/credential files, `node_modules`, build output, lockfiles, media, and the vault itself are skipped. Diffs are not stored unless explicitly requested — captures record *what changed*, never the patch body.

## The UI server and app

`cairn ui` starts `node:http` on `127.0.0.1`:

- **Authentication gate** (`src/core/auth.ts`): passwords are salted scrypt hashes in `state/auth.json`; sessions are HMAC-signed `HttpOnly`, `SameSite=Strict` cookies with a 12-hour TTL, plus an in-memory server-side allowlist so logout/reset/restart revoke access. Failed logins are throttled per client address.
- **Request guards**: `Host` is parsed and allowlisted before URL handling (malformed hosts get 400, unknown hosts 403), `Origin` and `Sec-Fetch-Site` are checked, mutations require `Content-Type: application/json` and a session-bound CSRF token (double-submit cookie + `X-Cairn-CSRF`). Only `/api/health`, `/api/auth/login`, `/api/auth/status`, `/login*`, `/favicon.svg`, and `/manifest.webmanifest` are public.
- JSON API (`/api/*`) over the same store — health, notes, graph payload, timeline, messages, handoffs, agents, projects, stats, search, and mutations (write/update/link/status/inbox). Every route except the public list above returns 401 without a session.
- **SSE** (`/api/events`) for live updates; the web app subscribes and refreshes lists and the graph in place. MCP writes from another agent appear in an open UI within a second. The stream is authenticated like every other route.
- Static assets are two explicit allowlists (`/`, `/index.html`, `/app.js`, `/styles.css` behind auth; `/login`, `/login.js`, `/login.css`, `/favicon.svg`, `/manifest.webmanifest` public); the response CSP is strict, and there are no external fonts, scripts, or CDNs. The whole app is `web/` — no build step.

The app is a single-page vanilla JS workspace: Brief, force-directed canvas graph (pan/zoom/drag, kind filters, inspector), timeline, decisions/changes/questions/risks, messages/handoffs, agents with presence, projects, search, command palette (⌘K), quick capture (N), and light/dark/system themes.

## Security posture

- **Password by default.** The UI/API requires a session; only health, login, auth status, the must-change challenge, and login assets are public. The first launch generates a 20-character password and prints it once; that generated password cannot open a lasting session — the login page forces a permanent replacement before the workspace is usable. The stored secret is a salted scrypt hash, never plaintext. `cairn auth reset` / `set-password` rotate the session secret, so existing cookies stop validating.
- **Sessions and CSRF.** Signed `HttpOnly`, `SameSite=Strict` cookies; 12-hour TTL; server-side allowlist; logout revokes immediately. Mutations need a session-bound double-submit CSRF token, JSON content type, an allowed `Origin`, and `Sec-Fetch-Site: same-origin|none`.
- **Host and bind policy.** Host is parsed before URL construction and checked against `localhost`, loopback addresses, the bound host, and `CAIRN_ALLOWED_HOSTS`. Non-loopback binds are refused without `--allow-remote` + a non-empty allowlist. `CAIRN_SECURE_COOKIE=1` marks cookies `Secure` for TLS-terminated deployments; Cairn itself has no TLS.
- **Redaction at the boundary** (`src/core/redact.ts`): titles, bodies, backups, and requested diffs are scanned for private keys, `sk`/`pk`-style keys, GitHub/Slack/Google/AWS/JWT token shapes, and `password=`/`api_key=`/`token=` assignments; matches are replaced with `[redacted …]`. This is pattern-based best effort, not a guarantee; `redact: false` turns it off.
- **Capture safety**: `isSensitivePath` (env files, `.npmrc`, keys, credential stores) and `isIgnoredPath` (dependency/build dirs, lockfiles, binary media) gate every capture. Diffs are omitted unless requested, restricted to the already-filtered file list, section-filtered, and redacted.
- **Files and concurrency**: read-modify-write operations take a reentrant lock (`state/.write.lock`) shared across MCP, CLI, and UI processes; note/state writes are atomic with `0600` file / `0700` directory modes on POSIX. Windows inherits profile ACLs. Config backups are redacted, capped at 40, and `0600`.
- **Residual risk**: memory is plaintext Markdown, so anyone with filesystem access can read it; a signed-in browser tab is trusted until expiry/revocation; there is one shared workspace password and no per-user accounts or audit log. Keep the default loopback bind unless you front it with TLS and a proxy.

## Testing

`tests/mcp.test.ts` spawns the real server (`dist/cli/index.js` over stdio in a temp vault) and exercises the full agent workflow with an SDK client: tool list, decision → risk → link → update → search → get → graph → timeline → capture_changes → send → inbox → handoff → end_session, plus both resources. `tests/security.test.ts` drives the real HTTP server: unauthenticated route blocking, login/logout revocation, CSRF and content-type enforcement, forged/malformed hosts, lockout, path traversal, path-filtered diffs, state-name guards, the cross-process write lock, and the first-login `must-change` challenge (generated password cannot open a session, replacement password clears the flag). This is the product's contract test; `npm test` runs it after a fresh build.
