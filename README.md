# Copilot Companion

GitHub Copilot delegation for Claude Code **and Codex CLI**, v0.0.1 — **dual-host plugin with subagent-isolated architecture**.

The entire public surface is a single subagent shipped inside this plugin (one
Markdown variant for Claude Code, one TOML variant for Codex CLI). Main Claude
or main Codex has **zero** direct MCP visibility into copilot-bridge; the MCP
server is declared only in the subagent's frontmatter and only the subagent
sees it. There is no slash command, no user-scope MCP registration, no
main-session hooks, no skill, no session opt-in, no pause. Sends through the
`general` template invoke Copilot's built-in `/fleet` orchestrator by default;
see [Parallel orchestration](#parallel-orchestration) for details and opt-out.

> **Host selection.** `setup.sh` defaults to `--host claude`. Pass `--host codex`
> for a Codex-only install or `--host both` to install both. Auto-detection
> from PATH is deliberately not done — installing for Codex would silently
> change the experience for existing Claude users who happen to also have
> Codex installed.

## Architecture at a glance

```
copilot-companion/                            ← plugin root
├── .claude-plugin/
│   └── plugin.json                           Claude Code plugin manifest
├── .codex-plugin/
│   └── plugin.json                           Codex CLI plugin manifest
├── templates/
│   ├── copilot-companion.md                  Claude subagent template (Markdown + YAML frontmatter)
│   └── copilot-companion.toml                Codex subagent template (TOML; runtime equivalent)
├── hooks/
│   ├── hooks.json                            Claude SessionStart + PostToolUse + UserPromptSubmit
│   ├── drain-completions.sh                  surfaces orphan Copilot completions (host-agnostic)
│   ├── install-deps.sh                       installs bridge-server node_modules
│   ├── install-agent.sh                      Claude SessionStart: materialize Markdown subagent
│   ├── install-agent-codex.sh                Codex SessionStart: materialize TOML subagent
│   └── prewarm-daemon.sh                     starts copilot-acp-daemon early
├── bridge-server/
│   ├── server.mjs                            `copilot` MCP tool, 5 actions:
│   │                                         send | wait | status | reply | cancel
│   ├── validation.mjs                        per-action field allow-lists, schemas
│   └── package.json                          runtime deps (MCP SDK)
├── lib/                                      state + logging + prompt utilities
│   ├── host.mjs                              host detection + per-host paths (claude | codex)
│   ├── state.mjs                             default-model + threads/ state layer
│   ├── log.mjs                               structured logging helper
│   ├── prompt-supervisor.mjs                 wraps Copilot prompts (rubber-duck, etc.)
│   └── prompt-inspect.mjs                    diagnostic dump for a Copilot prompt
├── scripts/
│   ├── copilot-acp-daemon.mjs                long-lived Copilot parent process
│   ├── copilot-acp-client.mjs                daemon stop/status CLI
│   ├── install-permissions.mjs               --host claude (Claude permissions); --host codex no-op
│   └── install-codex-hooks.mjs               read-merge-backup-write into ~/.codex/hooks.json
├── setup.sh                                  --host claude|codex|both (default: claude)
└── ~/.{claude,codex}/copilot-companion/      per-host runtime state (threads, jobs, default-model)
```

## Installation

`claude plugin install` only accepts plugins registered in a marketplace — there
is no `--plugin-dir` flag on the install subcommand. For persistent local
installs we ship a small `marketplace.json` alongside `plugin.json`, so adding
this directory registers a one-plugin dev marketplace that you can install from.

### Persistent install from this directory

```bash
# Register the local directory as a marketplace (one-time)
claude plugin marketplace add /path/to/copilot-companion

# Install the plugin from that marketplace
claude plugin install copilot-companion@copilot-companion-dev
```

Claude Code copies the plugin to `~/.claude/plugins/cache/`. On the first
session after install, the `SessionStart` hook runs `hooks/install-deps.sh`,
which installs the bridge-server's `node_modules` to
`${CLAUDE_PLUGIN_DATA}/bridge-server/` (persistent across plugin updates) and
symlinks it into `${CLAUDE_PLUGIN_ROOT}/bridge-server/node_modules` so Node's
ESM resolver finds `@modelcontextprotocol/sdk` via ancestor-directory walk.

To pick up changes you make to this directory, bump `version` in
`.claude-plugin/plugin.json`, then:

```bash
claude plugin marketplace update copilot-companion-dev
claude plugin update copilot-companion@copilot-companion-dev
```

### Session-scoped (no install, fastest iteration)

```bash
claude --plugin-dir /path/to/copilot-companion
```

Loads the plugin for one session directly from source — no marketplace, no
cache. Note that `${CLAUDE_PLUGIN_DATA}` is not created for `--plugin-dir`
runs; `install-deps.sh` falls back to `${CLAUDE_PLUGIN_ROOT}/.plugin-data/`
so ESM resolution still works. Alternatively run `bash setup.sh` once to
install deps directly into `bridge-server/node_modules/`.

### Via a published marketplace (end users)

Once submitted and approved:

```
/plugin marketplace add <marketplace-source>
/plugin install copilot-companion@<marketplace-name>
```

## Install for Codex CLI

`codex plugin` has no `install` subcommand on 0.128.0 — `codex plugin marketplace add|upgrade|remove` only registers a *catalog* of plugins, and the actual enable step happens in the desktop app/TUI. For our flow, `setup.sh --host codex` performs the install directly without needing a marketplace registration:

```bash
bash setup.sh --host codex
```

What that does, end-to-end:

1. **Materializes the TOML subagent** to `~/.codex/agents/copilot-companion.toml` (the only place Codex looks for unmanaged subagents — `~/.codex/agents/` and `<repo>/.codex/agents/` per `agent_roles.rs`). `${CLAUDE_PLUGIN_ROOT}` in the bridge MCP `args` is substituted to the absolute install path at materialization time, because Codex MCP `args` are runtime literals (no `${VAR}` expansion).
2. **Merges hook entries** into `~/.codex/hooks.json` via `scripts/install-codex-hooks.mjs`. Pre-existing user hooks are preserved (read-merge-backup-write); each managed entry carries `_managed_by: "copilot-companion"` so a later `--uninstall` only removes our entries. A timestamped backup is written before each modification. Hook commands embed an absolute plugin-root path because Codex does NOT expand `${CLAUDE_PLUGIN_ROOT}` for user-scope hooks (only plugin-scope hooks discovered through `append_plugin_hook_sources` get that env var injected).
3. **Skips Claude-specific steps**: no `~/.claude/settings.json` permission injection (Codex's permission/sandbox/trust model is not addressed by this plan), no `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (Codex's `features.multi_agent` is `Stable` and on by default).
4. **Writes a diagnostic marker** at `~/.codex/copilot-companion/.host` containing the literal `codex` so you can `cat` it to confirm what was installed where.

After setup, run `codex` and ask main Codex to delegate to Copilot (e.g. _"have copilot audit the auth module"_) — main Codex spawns the `copilot-companion` subagent via `spawn_agent`, the bridge starts inline, and the flow mirrors the Claude path. Session id continuity is handled server-side: Codex injects `_meta["x-codex-turn-metadata"].session_id` on every MCP request, and the bridge reads it directly — there is no `claude_session_id`/`host_session_id` to forward by hand.

**Completion delivery on Codex 0.130.0 (V1 `multi_agent`).** When the `copilot-companion` subagent reaches a final status, Codex's V1 completion watcher injects the subagent's terminal message into main's session conversation via `inject_user_message_without_turn(...)` — but `trigger_turn` is hardcoded `false` (`codex-rs/core/src/agent/control.rs:1012`), so main does NOT auto-resume. Main reads the previously-injected message on its next user prompt; just send any prompt (`any updates?`) to give main a turn and the result surfaces in conversation history. The `multi_agent_v2` feature flag is `UnderDevelopment` and its `spawn_agent` schema (`task_name + message`) is incompatible with this plugin's V1-style invocation (`prompt`), so we deliberately do not enable it — and even if enabled, the V2 path skips the completion watcher entirely (`codex-rs/core/src/agent/control.rs:320-334`), so it wouldn't fix auto-resume anyway. This is an upstream limitation, not a plugin bug.

If you'd rather install for both hosts in one shot:

```bash
bash setup.sh --host both
```

To remove only the Codex hook entries from `~/.codex/hooks.json` without uninstalling anything else:

```bash
node scripts/install-codex-hooks.mjs --plugin-root "$(pwd)" --uninstall --yes
```

## Prerequisites

- **Node.js ≥ 20**
- **GitHub Copilot CLI authenticated.** Install (`npm i -g @github/copilot`), then run `copilot` once interactively to complete GitHub OAuth. The daemon resolves the binary in order: `$COPILOT_BIN` → `command -v copilot` → `/opt/homebrew/bin/copilot`. On Linux, export the absolute path explicitly:
  ```bash
  export COPILOT_BIN=$(command -v copilot)
  ```
- **Agent Teams env var (Claude only)** — `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the shell (required for SendMessage-based thread continuity). On Codex this is unnecessary: `features.multi_agent` is `Stable` and on by default.

## Permissions (user setup)

The subagent invokes one MCP tool, `mcp__copilot-bridge__copilot`. Without an explicit allow rule, the first invocation in a session can surface a permission prompt — even with `defaultMode: "auto"`. Plugin-level `settings.json` cannot declare permissions (Claude Code honors only `agent` and `subagentStatusLine` there), so the entry must live in your user or project settings.

**Pick whichever fits your install path:**

### A. Source checkout (cloned repo, or running `--plugin-dir`)

Run once from the repo root:

```bash
node scripts/install-permissions.mjs --yes
```

`setup.sh` already runs this as Step 5; the standalone command exists so you can re-run or pre-empt without re-running the full setup. The script is idempotent, takes a timestamped backup of `~/.claude/settings.json` before writing, and preserves the existing order of your allow list.

### B. Marketplace install (`/plugin install copilot-companion@…`)

The plugin source lives under `~/.claude/plugins/cache/<hash>/...`, which isn't a stable path to hand-type. Use either:

1. **Click "Yes, don't ask again"** on the first permission prompt — Claude Code writes the entry to `~/.claude/settings.json` for you. One-time only.
2. **Pre-populate `~/.claude/settings.json`** before your first session:
   ```json
   {
     "permissions": {
       "allow": [
         "mcp__copilot-bridge__copilot"
       ]
     }
   }
   ```
   Or use `/permissions` inside Claude Code to add the rule via UI.

### Optional log-tailing diagnostics

Only useful if you want to inspect the bridge or daemon logs without prompts:

```json
{
  "permissions": {
    "allow": [
      "Bash(tail:*)",
      "Bash(ps:*)",
      "Read(//tmp/**)"
    ]
  }
}
```

> **Note on glob syntax**: `Read(//tmp/**)` uses a **double slash** because Claude Code treats `/x` as project-relative and `//x` as an absolute path. `Read(/tmp/**)` would silently fail to match. See the [permissions docs](https://code.claude.com/docs/en/permissions) for the full path-prefix rules.

### Project-scope alternative

Drop the same JSON into `.claude/settings.local.json` per repo if you'd rather only allow Copilot in specific projects (the file is gitignored by default and not checked in).

## Public surface

Two ways to delegate to Copilot from a Claude Code session:

**1. `/copilot <task>` — explicit slash command (recommended)**

```
/copilot scan the repo for unused exports
/copilot refactor the auth module to use async iterators
/copilot review my plan in docs/migration.md
```

The slash command is the fast path for explicit invocation. It spawns the
`copilot-companion` subagent in the background; results surface in your
next turn via the plugin's drain hook — no polling needed.

**2. Prose — main Claude routes via the subagent's description**

You can also just ask in natural language ("use copilot to scan the
repo…", "delegate this audit to copilot…") and main Claude will read the
subagent's `description` and spawn it via `Agent()`. Status checks,
replies, and cancellations on running jobs follow the same path.

You don't call the MCP tool directly in either path — the subagent owns
the entire copilot-bridge surface.

### Internal MCP surface (subagent-only)

```
copilot({ action: "send",   task, mode?, template?, template_args?, cwd?, thread?, max_wait_sec? })
copilot({ action: "wait",   job_id, max_wait_sec? })
copilot({ action: "status", job_id?, verbose? })
copilot({ action: "reply",  job_id, message })
copilot({ action: "cancel", job_id })
```

`send` enqueues the task and returns `status: "still_running"` with a
`job_id` immediately — the worker runs in the background. The subagent
then loops on `wait` (each up to `max_wait_sec`, default 480, max 1200 —
a single 20-min cap for all modes, sized to accommodate `/fleet` runs
that decompose into long-running sub-agents), emitting one short line
between iterations to reset the host's 600s stream-idle watchdog. The
underlying daemon caps each Copilot prompt at 25 min (`PROMPT_TIMEOUT_MS`
in `scripts/copilot-acp-daemon.mjs`); set `MCP_TOOL_TIMEOUT` on the
subagent's MCP env to ≥22 min so the host's per-tool budget doesn't
bite first (the shipped templates set `1320000`).

Terminal statuses returned by the bridge: `completed`, `failed`,
`cancelled`, `stuck` (supervisor trip — model misbehavior), **`timeout`**
(model turn did not finish within the wait budget — recoverable; main
should read `meta.digest_path` for partial sub-agent output before
deciding whether to re-dispatch), and **`unreachable`** (bridge socket
/ daemon process dead — `meta.detail` distinguishes `bridge_timeout`
from `bridge_daemon_unreachable`).

### Progress digest (`meta.digest_path`)

For every job that gets far enough to register a Copilot prompt, the
bridge maintains a smart-transcript file at
`/tmp/copilot-digest-<jobId>.md`. It is refreshed:

- on every `status` call against the job,
- on every supervisor interim alert (~60s during silence),
- on every terminal emit (final snapshot).

Contents (each section auto-skipped when empty):

- Header (job id, status, mode, template, thread, started/terminal timestamps, age).
- The task as dispatched.
- Final / partial assistant message (concatenated `message` chunks; partial on timeout).
- `/fleet` sub-agent reports (each paired with its `outputPreview`).
- Files touched (deduped paths from `tool_call.locations`, with touch counts).
- Tool-call summary (counts grouped by `kind`, plus sub-agent invocation count).
- Todos snapshot (the latest `plan` event's entries).

The path is surfaced via `meta.digest_path` on every terminal response
and via `digest_path` on the `still_running` wait response and on every
`status` reply. Reading the digest file is the canonical way for the
parent agent to track progress without making another bridge round-trip.

## Thread continuity

Multi-turn Copilot conversations are preserved via subagent resume, not via
main's state:

1. First send: the subagent calls the bridge with no `thread`. The bridge auto-generates `companion-<jobId>` and returns it in the response.
2. The subagent emits `MY_THREAD=<value>` as a visible line in its turn, so the handle is preserved in its conversation history.
3. On follow-up `SendMessage` from main, the subagent auto-resumes with its full prior context, reads `MY_THREAD=` from its own history, and passes it back to the bridge — Copilot resumes the same ACP session.
4. Main's context only carries the opaque `<agentId>`; it never sees or carries the thread name.

### SendMessage invocation form (important)

`SendMessage` validates its `message` param as a tagged union of *(a)* plain-text string or *(b)* a protocol object with `type ∈ {shutdown_request, shutdown_response, plan_approval_response}`. A raw `{"action":"send",...}` object matches neither and fails with `InputValidationError: path ["message"]` ("expected string" on one branch, "no matching discriminator" on the other). Always pass the payload as a **JSON-encoded string**, and always include a `summary`:

```js
// correct — message is a STRING
SendMessage({
  to:      <stored agentId>,
  summary: "follow-up task to copilot",      // 5-10 words, required
  message: '{"action":"send","task":"..."}'  // JSON-encoded string
})

// wrong — message is a raw object, fails schema validation
SendMessage({ to: <id>, message: {"action": "send", "task": "..."} })
```

The same rule applies to the Agent-spawn `prompt` field: pass the JSON payload as a string.

## Parallel orchestration

Every `send` invokes Copilot's built-in `/fleet` orchestrator by **default**,
regardless of template. The bridge prepends `/fleet ` to the prompt body;
Copilot's orchestrator decomposes the task, dispatches isolated sub-agents
in parallel where the work allows, polls for completion, and synthesizes a
final answer. Each sub-agent runs in its own context window with shared
filesystem access. Decomposition, dispatch, and synthesis all happen inside
Copilot — the bridge's only contribution is the slash command.

The natural fit is template-shaped:
- **`general`** — multi-file refactors, cross-component features, parallel ANALYZE.
- **`research`** — multi-source web research; sub-agents read different sources concurrently.
- **`plan_review`** — per-claim verification of a plan against the codebase.

**Opt-out**: pass `parallel: false` on the `send` payload when the task is
strictly linear or single-source (one-line typo fix, one-source research
question, trivially small plan). `/fleet`'s decomposition-analysis step
adds turn budget even when it concludes "no parallelism here", so for
genuinely linear work, opting out is faster.

```jsonc
// default — /fleet runs, sub-agents may dispatch in parallel
copilot({ action: "send", task: "refactor authentication across api/, ui/, and tests/" })

// opt-out for trivial linear work
copilot({ action: "send", task: "fix the typo in foo.ts:42", parallel: false })

// research with a single source — opt out
copilot({ action: "send", template: "research", task: "what is X (per docs.example.com)?", parallel: false })
```

When a task hits `status: "timeout"`, the bridge's `content` includes a
`parallel: false` retry suggestion as one of several recovery options —
main decides which to try.

## Design invariants

1. **Strict isolation.** The `copilot-bridge` MCP server is bundled with the plugin but the subagent's `tools:` list is the only path through which it's invoked. Main never calls the bridge directly.
2. **No activation lifecycle.** The bridge is spawned per subagent invocation by Claude Code's plugin MCP machinery. There's nothing to `start`, `stop`, or `pause`.
3. **Bounded blocking.** `send` returns immediately with `still_running`; each `wait` returns within `max_wait_sec ≤ 1200` (single 20-min cap for all modes). The companion's per-iteration "still running" emission resets Claude Code's 600s stream-idle watchdog; Codex callers raise `tool_timeout_sec` (the shipped TOML template sets `MCP_TOOL_TIMEOUT=1320000`).
4. **Orphan safety net.** Completion events are appended to `/tmp/copilot-completions.jsonl` with `consumed:false`; wait-terminal responses flip to `consumed:true`; the drain hook surfaces only unconsumed entries.
5. **Rubber-duck always on.** Appended to every `send` server-side for every template except `plan_review` (which has its own critique instructions baked in). Not in the schema.
6. **Model is config.** Read from `default-model` at worker start. Never a tool parameter.
7. **Node deps persist, code doesn't.** `bridge-server/node_modules` lives under `${CLAUDE_PLUGIN_DATA}` and survives plugin updates; bundled code under `${CLAUDE_PLUGIN_ROOT}` is re-copied on update.

## Subagent tool surface

The subagent declares these tools (full list in this plugin's `agents/copilot-companion.md` frontmatter):

```
mcp__copilot-bridge__copilot, Bash, Read, Write, Edit, Grep, Glob, WebFetch, TodoWrite
```

`mcp__copilot-bridge__copilot` is the canonical dispatch tool. All others exist for diagnostics, artifact handling, and self-sufficiency. See the frontmatter "Tool surface" and "Forbidden" sections for when each is appropriate.

## Diagnostics

`setup.sh` writes a one-line marker file under each host's directory at install time, advisory-only, useful when a system has both hosts installed and you want to confirm what landed where:

```bash
cat ~/.claude/copilot-companion/.host    # → "claude" if installed
cat ~/.codex/copilot-companion/.host     # → "codex"  if installed
```

Actual host-routing at runtime is decided by the `COPILOT_COMPANION_HOST` env var injected into the bridge's MCP `env:` block (set to `"codex"` literal in the materialized Codex TOML; not set on Claude, which falls back to the default). The marker files are NOT a fallback signal — with concurrent installs on both hosts, a fallback would be ambiguous.

To inspect host selection from inside a bridge process:

```bash
# Each bridge spawn logs its detected host once at startup.
grep '"event":"bridge.startup"' ~/.claude/copilot-companion/daemon.log
grep '"event":"bridge.startup"' ~/.codex/copilot-companion/daemon.log
```

(The log file is the bridge's structured JSONL log under the host's `copilot-companion` state directory; each entry includes a `host_detected` field with `claude` or `codex`.)

## Development

- `node --check` should pass on every `.mjs` after edits.
- Tests: `node --test $(find bridge-server lib scripts hooks templates -name '*.test.mjs')`
  — covers `bridge-server/{server,validation}.test.mjs`, `lib/{state,host,log,prompt-inspect,prompt-supervisor,heartbeat}.test.mjs`, `scripts/{copilot-acp-daemon,install-codex-hooks}.test.mjs`, `hooks/drain-completions.test.mjs`, and `templates/copilot-companion.toml.test.mjs`.
- Validate the Claude plugin manifest: `claude plugin validate .` from the plugin root.

## Out of scope

- Main Claude speaking to the bridge directly.
- Skill file / slash commands (gone in v6.1).
- Session opt-in, pause (removed).
- MCP elicitation (`NEEDS_USER_INPUT:` flow) — deferred to a future version.
