---
name: cairn
description: Read and write shared project memory through the Cairn MCP server (`cairn`). Use at the start of any non-trivial coding task to recover prior decisions and open threads; before making or changing an architectural choice; after editing or committing code; when blocked on an unknown; and when asking, messaging, or handing work to another agent. Also use whenever the user mentions Cairn, project memory, decisions, handoffs, or asks what happened earlier in the project.
---

# Cairn — shared memory for coding agents

Cairn is a local MCP server (`cairn`) that stores this project's durable memory as a Markdown graph: decisions, changes, insights, specs, risks, questions, tasks, messages, handoffs, sessions, and the files they touch. Every agent working in this repo shares it.

Your job: **read it before acting, and keep it accurate as you work.** Memory that is wrong is worse than no memory.

## When to use this skill

Use it when:

- Starting any task that is not trivially mechanical.
- Choosing between approaches, libraries, schemas, or patterns.
- The user asks "why is this like this?", "what did we decide?", or "what happened last time?".
- Work lands — an edit, a commit, a migration, a config change.
- You hit an unknown, a blocker, or an ambiguity someone must settle.
- You finish or pause work another agent will continue.
- You need to ask another agent a question or review something.

Skip it for typos, formatting-only edits, and throwaway exploration. The Claude Code hooks already capture touched files; do not duplicate that noise.

## The loop

### 1. Open the session

Call `memory_start_session` with a concrete goal before substantial work:

- `goal` — what this session is trying to accomplish, in one sentence.
- `project` — only when working across projects; defaults to the server's project.
- `model` / `client` / `cwd` — optional provenance.

The response includes the project brief. Read it. If you skip the tool, call `memory_context` instead; it returns decisions in force, proposals, open questions, risks, recent changes, handoffs, unread messages, active agents, and hot files.

When the task is specific, `memory_context` with `focus: "<topic>"` appends targeted search hits to the brief.

### 2. Read before deciding

Before you pick an approach:

1. `memory_search` for the topic, subsystem, file path, or error text. Search titles, bodies, tags, files, projects, and agents. Narrow with `kinds`, `status`, `tags`, or `since_days` when the vault is large.
2. `memory_get` the ids that look relevant. Follow their typed links and backlinks.
3. Treat `accepted` decisions as constraints. If one is genuinely wrong, write the correction and mark the old note `superseded` — do not silently ignore it.
4. Check `memory_inbox` for messages and handoffs addressed to you. Set `mark_read: true` after handling them.

Memory can be stale. Verify claims against the code and tests before relying on them; if reality disagrees, fix the note as part of the work.

### 3. Write what the next agent needs

Call `memory_write` with **one idea per note**, at the moment it becomes true. Use the narrowest kind that fits:

| kind | write it when | status lifecycle |
| --- | --- | --- |
| `decision` | You choose an approach, tradeoff, or reject an alternative. | `proposed` → `accepted` / `rejected` / `superseded` |
| `change` | Work lands. Prefer `capture_changes` when git can describe it. | `done` by default |
| `insight` | You learn how something actually behaves, especially a surprise. | none |
| `spec` | You establish behavior another caller can rely on. | none |
| `risk` | You find a hazard; include what it can break. | `open` → `mitigated` |
| `question` | Something undecided blocks or shapes the work. | `open` → answered by an `answer` note |
| `task` | A follow-up is promised but not done. | `todo` → `doing` → `done` |

For git-backed work, call `capture_changes` after edits or a commit (`scope: "auto"` captures uncommitted work when present, otherwise `HEAD`). It records files, stats, and provenance, and auto-links notes by file overlap. Diffs stay out unless you explicitly ask for them — keep it that way.

### 4. Coordinate

- `memory_send` for direct messages, review requests, and questions. `to` is an agent handle, or `"*"` to broadcast. Broadcast sparingly — only when every agent genuinely needs it.
- `memory_handoff` when another agent must continue the work. Include a real `summary`, numbered `next_steps`, `open_questions`, and `files`. They get it in their inbox; you can close it later with `memory_update` status `done`.
- `memory_inbox` shows unread messages and handoffs by default. `include_done: true` reviews closed ones.

### 5. Close the session

Call `memory_end_session` with:

- `summary` — what moved, what changed, what state the work is in.
- `next_steps` — concrete actions for whoever continues.
- `status` — `done`, or `abandoned` if the work is being dropped.

The next agent resumes from this summary, not from your transcript.

## Notes that hold up

A note is only useful if the next agent can act on it without asking you questions.

**Title — a claim, not a label.**
- Good: `Retry the outbox flush from a worker, not the request path`
- Bad: `Outbox notes`

**Body — context, decision, why, alternatives, consequences.** For decisions:

```md
## Context
Webhook retries were running inside the request handler; a slow tenant was
retrying on every inbound request and doubling p99.

## Decision
Move delivery to a single worker loop with per-tenant backoff.

## Why
- Decouples inbound latency from downstream failures.
- One retry owner makes idempotency keys easier to reason about.

## Alternatives considered
- Inline retries with a longer timeout — rejected: keeps the failure coupled.
- A separate queue service — rejected: operational cost for no current need.

## Consequences
- Delivery is eventually consistent (~2s p95).
- The worker needs its own deploy health check.
```

**Structure the graph.** Include:

- `files` — repo-relative paths, not absolute.
- `tags` — lowercase, reusable: `billing`, `migrations`, `observability`.
- `related` — note ids of decisions, specs, or changes this note belongs with.
- `relations` — typed edges: `implements`, `depends_on`, `blocks`, `contradicts`, `answers`, `supersedes`, `supports`.

Use `memory_link` to connect memories after the fact, for example a change that `implements` a decision, or a risk that `blocks` a task.

**Update instead of duplicating.** Search first. If a matching note exists, append the new outcome with `memory_update` (`append: true` is the default). If a decision was replaced, mark the old one `superseded` and link the replacement rather than leaving two accepted answers in the graph.

## Chat behavior

When the human talks to you in a chat interface:

- If they ask about past work, **search memory first**, then answer with a short synthesis and note ids. Do not dump whole notes into the chat.
- When you record memory, confirm in one line: `Recorded decision 01J… — <title>`. Do not narrate every tool call.
- When the human corrects a decision, update or supersede the existing note. Never create a second accepted decision that contradicts the first.
- When memory and the current code disagree, say so, fix the code or the note, and record which one changed.
- Do not ask permission to read memory. Reading is local and safe. Ask before sending messages to other agents only when the content is sensitive or outside the current task.

## Tool map

| tool | use |
| --- | --- |
| `memory_context` | Project brief; `focus` appends targeted search hits. |
| `memory_start_session` | Open a session with a goal; marks you online. |
| `memory_end_session` | Close the session with summary and next steps. |
| `memory_write` | One decision, change, insight, spec, risk, question, task, or note. |
| `memory_update` | Append body, change status, tags, files, or relations. |
| `memory_search` | Search titles, bodies, tags, files, projects, agents. |
| `memory_get` | Full note with links, backlinks, files, and session. |
| `memory_link` | Typed edge between two notes. |
| `memory_graph` | Query nodes and edges by project, kind, or depth. |
| `memory_timeline` | Recent activity by project, agent, kind, or window. |
| `capture_changes` | Capture git changes as change memory. |
| `memory_send` | Direct message or broadcast to agents. |
| `memory_inbox` | Read messages and handoffs addressed to you. |
| `memory_handoff` | Structured work transfer with next steps. |

Two resources are also available: `cairn://overview` (vault stats and brief) and `cairn://projects/{project}/brief`.

## Boundaries

- **Never store secrets**: tokens, API keys, private keys, credentials, `.env` contents, customer data.
- **Never store raw transcript or whole files**: distill the meaning. If a detail matters, quote the one line.
- **Never fabricate provenance**: no invented note ids, commit shas, projects, or agent handles.
- **Never mark unsettled work as settled**: `accepted` means a human or the task actually decided it.
- **Do not rewrite another agent's accepted decision in place.** Write a new decision, mark the old one `superseded`, and link them.

## If Cairn is unavailable

If the `cairn` MCP server does not appear in your tool list:

1. Tell the user to run `cairn connect <client>` in the project root, then restart the session.
2. Do not fake memory or invent prior context. Work without it, and say that memory was unavailable.
3. `cairn status` shows the vault, workspace, and which clients are wired.
