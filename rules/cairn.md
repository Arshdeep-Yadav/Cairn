## Shared memory — Cairn

This project's long-term memory lives in **Cairn**, a local MCP server named `cairn`. Every coding agent shares it. It is not a log: it is the project's brain. Read it before acting, and keep it true as you work.

### Start every task

1. Call `memory_start_session` with a concrete goal, then read the returned brief — or call `memory_context` directly.
2. Before choosing an approach, run `memory_search` for the topic, file, or error. Open relevant hits with `memory_get`. Treat accepted decisions as constraints; if one is wrong, supersede it explicitly instead of ignoring it.
3. Check `memory_inbox` when the brief shows unread messages or handoffs.

### Write memory as you go

Call `memory_write` with one idea per note, at the moment it becomes true:

| kind | write when |
| --- | --- |
| `decision` | You choose an approach or reject an alternative. Status `proposed` until settled, then `accepted`. |
| `change` | Work lands. Prefer `capture_changes` for git-backed changes. |
| `insight` | You learn how something actually behaves. |
| `spec` | You establish behavior another caller can rely on. |
| `risk` | You find a hazard; include the blast radius. |
| `question` | Something undecided blocks or shapes the work. Answer with `kind:"answer"`. |
| `task` | A follow-up is promised but not done. |

Call `capture_changes` after edits or commits. It records files, stats, and provenance, and links them to related decisions. Do not paste diffs.

### Make notes usable

- The title is a claim: "Postgres advisory locks serialize migrations", not "DB stuff".
- The body carries context, the decision or finding, **why**, alternatives rejected, and consequences. Assume the next agent cannot ask you anything.
- Add repo-relative `files`, `tags`, and `related` note ids.
- Add typed edges with `memory_link` or `relations`: `implements`, `depends_on`, `blocks`, `contradicts`, `answers`, `supersedes`, `supports`, `relates_to`.
- Search first and extend with `memory_update` instead of writing near-duplicates. Append outcomes to the existing note.
- When a decision is validated mark it `accepted`; when it is replaced mark it `superseded` and link the replacement.

### Coordinate

- `memory_send` for direct messages, review requests, and questions. Use `to:"*"` only when every agent needs it.
- `memory_handoff` when another agent must continue the work: summary, next steps, open questions, files.
- `memory_inbox` for what is addressed to you. Set `mark_read:true` once handled, and close finished handoffs with status `done`.

### Close

Call `memory_end_session` with a summary of what moved, concrete next steps, and blockers. The next agent resumes from your summary, not your transcript.

### Never

- Store secrets, tokens, private keys, credentials, `.env` contents, or personal data.
- Store raw transcripts, full command output, or whole files. Distill the meaning.
- Mark a decision `accepted` unless it was actually settled.
- Invent note ids, project handles, or agent handles.

Memory can be stale: verify against the code and tests. If reality disagrees, fix the note.
