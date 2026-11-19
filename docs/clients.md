# Wiring Cairn into your coding system

Cairn runs as a **local MCP stdio server**. Any client that supports MCP can load it. The fastest path is the connector built into the CLI — it edits (or prints) the right config files for you, and backs up everything it touches (redacted) into `vault/state/backups/`.

```sh
npx cairn connect <client…> [--vault .cairn] [--project <name>] [--git-hooks] [--dry-run]
```

Multiple clients at once is fine: `npx cairn connect claude-code cursor antigravity`.

Supported: `claude-code`, `cursor`, `antigravity`, `vscode`, `codex`, `gemini`, `windsurf`, `zed`, `omnirush`, `opencode`, `generic`.

The server entry is always the same shape:

```json
{
  "command": "node",
  "args": ["<path-to-cairn>/dist/cli/index.js", "mcp", "--vault", "<vault>", "--project", "<project>", "--agent", "<client>"]
}
```

`--project` scopes writes when a client can't pass it; `--agent` is the handle that shows up as the author on every note (pass `--agent <name>` to `connect` to override).

## What every connection installs

Cairn ships an agent guide in two forms, and `connect` installs the right one for each client:

| Artifact | Purpose | Written to |
| --- | --- | --- |
| **Rule** | Compact, always-on session contract: read first, write decisions and changes as work happens, never store secrets. | The client's native rule location: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/cairn.mdc`, or `.agents/rules/cairn.md`. |
| **Skill** | Long-form playbook with the full loop, note templates, examples, tool map, and chat behavior. Loaded on demand by skill-aware clients. | `.claude/skills/cairn/SKILL.md` (Claude Code) or `.agents/skills/cairn/SKILL.md` (Antigravity, OpenCode, Omnirush, generic). |

```sh
npx cairn skill              # show where the skill and rule are installed
npx cairn skill --install    # write both standard skill locations
npx cairn skill --print      # print the skill markdown
npx cairn skill --print-rule # print the always-on rule
```

Clients without skill support still get the rule, so the agent knows the session loop either way.

---

## Claude Code (full integration)

```sh
npx cairn connect claude-code --git-hooks
```

| File | What gets written |
| --- | --- |
| `.mcp.json` | `mcpServers.cairn` — project-scope MCP server. |
| `.claude/settings.json` | `SessionStart` (start session + inject brief as `additionalContext`), `PostToolUse` on `Edit\|Write\|MultiEdit\|NotebookEdit` (rolling worklog capture), `SessionEnd` (close session). |
| `CLAUDE.md` / `AGENTS.md` | A marked `<!-- cairn:start -->` instruction block teaching the tools. |
| `.claude/skills/cairn/SKILL.md` | The Cairn agent skill: read/write workflow, note quality, coordination, chat behavior. |
| `.git/hooks/post-commit` | With `--git-hooks`: every commit captured as change memory. |

Re-running is idempotent: existing Cairn hook groups are replaced, other hooks are preserved, and the instruction block is updated in place. Only existing files get backed up.

For user scope instead of project scope:

```sh
claude mcp add --scope user cairn -- node <path-to-cairn>/dist/cli/index.js mcp --vault .cairn --project <project> --agent claude-code
```

If you don't want hooks: `npx cairn connect claude-code --no-hooks`.

## Cursor

```sh
npx cairn connect cursor
```

| File | What gets written |
| --- | --- |
| `.cursor/mcp.json` | `mcpServers.cairn` |
| `.cursor/rules/cairn.mdc` | Always-apply rule with the Cairn instructions. |

Cursor's own hooks are not installed automatically. Restart or reload the window after connecting; approve the server in Cursor's MCP settings if prompted.

## Antigravity

```sh
npx cairn connect antigravity
```

| File | What gets written |
| --- | --- |
| `.agents/mcp_config.json` | `mcpServers.cairn` (workspace scope) |
| `.agents/rules/cairn.md` | Workspace rule |
| `AGENTS.md` | Instruction block |
| `.agents/skills/cairn/SKILL.md` | The Cairn agent skill |

Global option: copy the `mcpServers` block from `.agents/mcp_config.json` into `~/.gemini/config/mcp_config.json`.

## VS Code / GitHub Copilot

```sh
npx cairn connect vscode
```

Writes `.mcp.json` at the workspace root (VS Code's standard project-level MCP config) plus the `AGENTS.md` instruction block. VS Code asks for approval before starting a project MCP server — pick **Allow** when the toast appears.

## Codex

```sh
npx cairn connect codex
```

Updates `AGENTS.md` and **prints** the TOML snippet — Codex config is not auto-edited. Add it to `~/.codex/config.toml` (or `.codex/config.toml` for project scope):

```toml
[mcp_servers.cairn]
command = "node"
args = ["<path-to-cairn>/dist/cli/index.js", "mcp", "--vault", ".cairn", "--project", "<project>", "--agent", "codex"]
```

## Gemini CLI

```sh
npx cairn connect gemini
```

Updates `GEMINI.md` and prints the JSON snippet. Add it to `~/.gemini/settings.json` (or `.gemini/settings.json` for project scope):

```json
{
  "mcpServers": {
    "cairn": {
      "command": "node",
      "args": ["<path-to-cairn>/dist/cli/index.js", "mcp", "--vault", ".cairn", "--project", "<project>", "--agent", "gemini"]
    }
  }
}
```

## Windsurf

```sh
npx cairn connect windsurf
```

Prints the JSON snippet — Windsurf config is not auto-edited. Add it to `~/.codeium/windsurf/mcp_config.json` (or your Cortex-managed `mcp_config.json`), then reload Windsurf.

## Zed

```sh
npx cairn connect zed
```

Prints the JSON snippet — Zed config is not auto-edited. Add it to `~/.config/zed/settings.json` under `context_servers`:

```json
{
  "context_servers": {
    "cairn": {
      "command": "node",
      "args": ["<path-to-cairn>/dist/cli/index.js", "mcp", "--vault", ".cairn", "--project", "<project>", "--agent", "zed"],
      "env": {}
    }
  }
}
```

## Omnirush / OpenCode

```sh
npx cairn connect omnirush opencode
```

Prints an OpenCode-style config block. If your client manages local servers in its database or UI, add the `mcp.cairn` entry through the app instead:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cairn": {
      "type": "local",
      "command": ["node", "<path-to-cairn>/dist/cli/index.js", "mcp", "--vault", ".cairn", "--project", "<project>", "--agent", "opencode"],
      "enabled": true
    }
  }
}
```

Some local-server allowlists require approving `node` processes launched outside the app — approve the Cairn entry on first run.

## Anything else (generic)

```sh
npx cairn connect generic
```

Prints the standard stdio snippet. Any MCP client that accepts `command` + `args` works. Clients that only accept full URLs can use an MCP proxy that spawns the process and bridges stdio.

---

## The security boundary

The workspace password protects the **HTTP UI and API** (`cairn start`, `cairn ui`). MCP is a stdio process launched by your coding client: it runs as your OS user and reads/writes the vault directly, so it does not ask for the web password. Only wire clients you trust; anything that can read `.cairn/` can read all of its memory.

- `state/auth.json` holds the scrypt hash and session secret — treat it as private, never commit or share it.
- `cairn auth status | reset | set-password` manages the web password; reset and change sign out every browser.
- If you expose the UI beyond this machine, set `CAIRN_ALLOWED_HOSTS`, terminate TLS in front, set `CAIRN_SECURE_COOKIE=1`, and pass `--allow-remote`. Never port-forward the raw HTTP port.

---

## Global vault vs project vault

| Mode | Vault location | Best for |
| --- | --- | --- |
| Project (default) | `<project>/.cairn/` | One project, one memory; notes carry `project:` scope. Version or ignore it per your policy. |
| Global (`--global`) | `~/.cairn/` | One shared memory across many repos; every client points at the same vault, and each note still records which project it belongs to. |

With a global vault, pass `--project <name>` in each client's server entry so writes from different repos stay separated.

## Verifying

```sh
npx cairn status         # vault, memory stats, workspace state, wired clients
npx cairn doctor         # read-only health check: vault found, note count, graph size, warnings
npx cairn list           # recent notes as seen from this directory
npx cairn context        # the same brief agents get on session start
```

`status` also shows the exact MCP command to paste into any client. The workspace UI repeats it with a copy button on the **Connect agents** page and on **Agents**.

`doctor` never creates or modifies anything. If it reports "no vault found", run `npx cairn init` (or `connect`, which inits as a side effect) first.

## Uninstalling

```sh
npx cairn connect --dry-run          # review what would change
```

Then remove the `cairn` entry from each client config, the marked block from `CLAUDE.md` / `AGENTS.md`, the hook groups named in `.claude/settings.json`, and delete the vault folder if you no longer want the memory. Redacted copies of every edited file are in `vault/state/backups/`.
