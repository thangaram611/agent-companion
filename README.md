# Copilot Companion

GitHub Copilot delegation for Claude Code **and Codex CLI** — a dual-host plugin with a subagent-isolated architecture.

The entire public surface is a single subagent shipped inside this plugin (a
Markdown variant for Claude Code, a TOML variant for Codex CLI). Main Claude /
main Codex has **zero** direct MCP visibility into the bridge; the MCP server is
declared only in the subagent's frontmatter, so only the subagent sees it. There
is no slash command, no user-scope MCP registration, no skill, no session
opt-in. Host hooks handle only materialization, dependency prewarm, heartbeat,
and completion drain.

Sends default to `parallel: "auto"`: the bridge invokes Copilot's built-in
`/fleet` orchestrator only when the task looks broad enough to benefit (see
[Parallel orchestration](#parallel-orchestration)).

> **Host selection.** `setup.sh` defaults to `--host both`. Pass `--host claude`
> or `--host codex` to install one surface only.
>
> **Claude packaging caveat.** Claude plugin-bundled subagents ignore
> `mcpServers`, `hooks`, and `permissionMode` frontmatter for security. So the
> Claude `SessionStart` hook materializes `templates/copilot-companion.md` into
> `~/.claude/agents/copilot-companion.md`; that standalone agent owns the
> private MCP bridge.

## Architecture at a glance

```
copilot-companion/                            ← plugin root
├── .claude-plugin/
│   ├── plugin.json                           Claude Code plugin manifest
│   └── marketplace.json                      one-plugin marketplace (source "./")
├── .codex-plugin/
│   └── plugin.json                           Codex CLI plugin manifest
├── templates/
│   ├── copilot-companion.md                  Claude subagent (Markdown + YAML frontmatter)
│   └── copilot-companion.toml                Codex subagent (TOML; runtime equivalent)
├── hooks/
│   ├── hooks.json                            Claude SessionStart + PostToolUse + UserPromptSubmit
│   ├── hooks-codex.json                      Codex plugin-scoped lifecycle hooks
│   ├── node-tools.sh                         shared Node/npm resolver (GUI-launched hosts)
│   ├── drain-completions.sh                  surfaces orphan Copilot completions
│   ├── install-deps.sh                       installs bridge-server node_modules
│   ├── install-agent.sh                      Claude SessionStart: materialize Markdown subagent
│   ├── install-agent-codex.sh                Codex SessionStart: materialize TOML subagent
│   └── prewarm-daemon.sh                     starts copilot-acp-daemon early
├── bridge-server/
│   ├── server.mjs                            5 split MCP tools: copilot_send | copilot_wait
│   │                                         | copilot_status | copilot_reply | copilot_cancel
│   ├── copilot-runtime.mjs                   runtime adapter boundary (ACP default)
│   ├── copilot-sdk-runtime.mjs               experimental Copilot SDK adapter
│   ├── validation.mjs                        per-action field allow-lists, schemas, templates
│   └── package.json                          runtime deps (MCP + Copilot SDKs)
├── lib/                                      state + logging + prompt utilities
│   ├── host.mjs                              host detection + per-host paths (claude | codex)
│   ├── runtime-paths.mjs                     private runtime dirs for IPC, logs, digests
│   ├── state.mjs                             default-model + threads/ + job state layer
│   ├── log.mjs                               structured JSONL logger
│   ├── heartbeat.mjs                         daemon/bridge heartbeat
│   ├── prompt-digest.mjs                     smart transcript digest builder
│   ├── prompt-supervisor.mjs                 wraps Copilot prompts (stuck detection, alerts)
│   └── prompt-inspect.mjs                    diagnostic dump for a Copilot prompt
├── scripts/
│   ├── copilot-acp-daemon.mjs                long-lived Copilot parent process
│   ├── copilot-acp-client.mjs                daemon stop/status CLI
│   ├── install-permissions.mjs               --host claude (writes allow rules); --host codex no-op
│   ├── install-codex-hooks.mjs               source-checkout Codex hook materialization
│   ├── build-codex-marketplace.mjs           builds the Codex marketplace package
│   └── doctor.mjs                            environment diagnostics (--json supported)
├── setup.sh                                  --host claude|codex|both (default: both)
└── ~/.{claude,codex}/copilot-companion/      per-host state + private runtime/
```

## Prerequisites

- **Node.js ≥ 22.**
- **GitHub Copilot CLI authenticated.** `npm i -g @github/copilot`, then run
  `copilot` once interactively to complete GitHub OAuth. The daemon resolves the
  binary in order: `$COPILOT_BIN` → `command -v copilot` → `/opt/homebrew/bin/copilot`.
  On Linux, export the absolute path: `export COPILOT_BIN=$(command -v copilot)`.
- **`jq`** — required for hook delivery.
- **Claude only:** `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (needed for
  SendMessage-based thread continuity). On Codex this is unnecessary —
  `features.multi_agent` is stable and on by default.

## Install — Claude Code

`claude plugin install` only accepts plugins registered in a marketplace. The
repo is its own marketplace (`marketplace.json` has `source: "./"`), so adding
this directory registers a one-plugin marketplace named `copilot-companion`.

```bash
# one-time: register the local directory as a marketplace
claude plugin marketplace add /path/to/copilot-companion
# install from it
claude plugin install copilot-companion@copilot-companion
```

On the first session after install, the `SessionStart` hook runs
`hooks/install-deps.sh`, which installs the bridge-server's `node_modules` under
`${CLAUDE_PLUGIN_DATA}/bridge-server/` (persistent across plugin updates) and
symlinks it into `${CLAUDE_PLUGIN_ROOT}/bridge-server/node_modules` so Node's
ESM resolver finds `@modelcontextprotocol/sdk`.

To pick up local changes, bump `version` in `.claude-plugin/plugin.json`, then:

```bash
claude plugin marketplace update copilot-companion
claude plugin update copilot-companion@copilot-companion
```

**Session-scoped (no install, fastest iteration):**

```bash
claude --plugin-dir /path/to/copilot-companion
```

Loads the plugin for one session from source. `${CLAUDE_PLUGIN_DATA}` is not
created for `--plugin-dir` runs, so `install-deps.sh` falls back to
`${CLAUDE_PLUGIN_ROOT}/.plugin-data/`. Or run `bash setup.sh` once to install
deps directly into `bridge-server/node_modules/`.

## Install — Codex CLI

Codex marketplaces must have `.agents/plugins/marketplace.json` at the root and
plugin source under `./plugins/<name>`, so build the package first:

```bash
node scripts/build-codex-marketplace.mjs --out dist/codex-marketplace
codex plugin marketplace add dist/codex-marketplace
codex plugin add copilot-companion@copilot-companion --json
```

For release validation, use the repo-owned end-to-end check:

```bash
node scripts/validate-codex-release.mjs
```

It builds the marketplace package, installs it into an isolated `CODEX_HOME`,
and verifies the installed package shape. Pass `--keep` to retain the temporary
workspace for inspection.

The validator sets temporary `CODEX_HOME` and `HOME` values for every Codex CLI
call, so it does not modify your existing `~/.codex` state. It does not install
or update the Claude plugin; use `claude plugin validate .` for the Claude
manifest check.

The generated package installs plugin-scoped Codex hooks from
`hooks/hooks-codex.json`; it does not mutate `~/.codex/hooks.json`.

**Source-checkout dev path** (no marketplace round-trip) materializes the TOML
agent and dev hooks directly:

```bash
bash setup.sh --host codex      # or --host both
```

What that does:

1. Materializes the TOML subagent to `~/.codex/agents/copilot-companion.toml`
   (the only path Codex reads for unmanaged subagents). `${CLAUDE_PLUGIN_ROOT}`
   in the bridge MCP `args` is substituted to the absolute install path at
   materialization time, because Codex MCP `args` are runtime literals.
2. Merges dev hook entries into `~/.codex/hooks.json` via
   `scripts/install-codex-hooks.mjs` (read-merge-backup-write; each managed
   entry carries `_managed_by: "copilot-companion"`, so `--uninstall` removes
   only our entries).
3. Skips Claude-specific steps (no `~/.claude/settings.json` permission
   injection, no Agent Teams env var).
4. Writes a diagnostic marker at `~/.codex/copilot-companion/.host` containing
   the literal `codex`.

After setup, run `codex` and ask main Codex to delegate (e.g. _"have copilot
audit the auth module"_). Session continuity is handled server-side: Codex
injects `_meta["x-codex-turn-metadata"].session_id` on every MCP request and the
bridge reads it directly — no session id to forward by hand.

**Completion delivery (Codex V1 `multi_agent`).** When the subagent reaches a
terminal status, Codex injects its terminal message into main's conversation but
does not auto-resume. Send any prompt (`any updates?`) to give main a turn and
the result surfaces. Enable `multi_agent_v2` only once its public behavior is
stable and verified against this bridge.

To remove just the Codex hook entries:

```bash
node scripts/install-codex-hooks.mjs --plugin-root "$(pwd)" --uninstall --yes
```

## Permissions (Claude)

The subagent invokes the five split MCP tools and, on Claude, one
`echo "$CLAUDE_CODE_SESSION_ID"` probe so the bridge can tag queue rows to the
current session. Without explicit allow rules the first invocation can surface a
prompt. Plugin `settings.json` cannot declare permissions, so the entries live
in your user or project settings.

**Source checkout / `--plugin-dir`** — run once from the repo root (also Step 5
of `setup.sh`; idempotent, takes a timestamped backup, preserves allow-list
order):

```bash
node scripts/install-permissions.mjs --yes
```

**Marketplace install** — the cached plugin path isn't stable to hand-type, so
either click "Yes, don't ask again" on the first prompt, or pre-populate
`~/.claude/settings.json` (or `/permissions` in the UI):

```json
{
  "permissions": {
    "allow": [
      "mcp__copilot-bridge__copilot_send",
      "mcp__copilot-bridge__copilot_wait",
      "mcp__copilot-bridge__copilot_status",
      "mcp__copilot-bridge__copilot_reply",
      "mcp__copilot-bridge__copilot_cancel",
      "Bash(echo \"$CLAUDE_CODE_SESSION_ID\")"
    ]
  }
}
```

Use `.claude/settings.local.json` (gitignored) to scope this per repo.

Optional log-tailing diagnostics (only if you want to read logs without
prompts): allow `Bash(tail:*)`, `Bash(ps:*)`, and
`Read(//Users/<you>/.claude/copilot-companion/runtime/**)`. The double slash
marks an absolute path in Claude Code's permission syntax.

## Public surface

You don't call the MCP tools directly. Main Claude / main Codex reads the
subagent's `description` and spawns it via `Agent()` (Claude) / `spawn_agent`
(Codex) when the user asks for Copilot delegation, status, reply, or cancel.

### Internal MCP surface (subagent-only)

```
copilot_send({ task, cwd, mode?, template?, template_args?, thread?, max_wait_sec?, parallel? })
copilot_wait({ job_id, max_wait_sec? })
copilot_status({ job_id?, verbose? })
copilot_reply({ job_id, message })
copilot_cancel({ job_id })
```

`cwd` is required on every `send` and must be the absolute target repo/worktree
path. The bridge, CLI client, and daemon all reject a missing `cwd` rather than
defaulting to their own process cwd, so a delegated review never silently runs
in the plugin checkout.

`send` enqueues the task and returns `status: "still_running"` with a `job_id`
immediately; the worker runs in the background. The subagent then loops on
`wait` (each up to `max_wait_sec`, default 480, max 1200 — one 20-min cap for
all modes, sized for `/fleet` runs), emitting a short line between iterations to
reset the host's 600s stream-idle watchdog. The daemon caps each Copilot prompt
at 25 min (`PROMPT_TIMEOUT_MS` in `scripts/copilot-acp-daemon.mjs`). Codex
callers must set `tool_timeout_sec = 1320` on `[mcp_servers.copilot-bridge]`
(the shipped TOML template does this); env vars don't extend the host's MCP
tool-call budget.

**Terminal statuses:** `completed`, `failed`, `cancelled`, `stuck` (supervisor
trip — model misbehavior), `timeout` (model turn didn't finish within the wait
budget — recoverable; read the `meta.digest_uri` MCP resource before
re-dispatching), and `unreachable` (bridge socket / daemon dead — `meta.detail`
distinguishes `bridge_timeout` from `bridge_daemon_unreachable`).

### Templates and modes

Templates: `general` (default), `research`, `plan_review`. Modes (general only):
`EXECUTE` (default), `PLAN`, `ANALYZE`. `template_args` keys are validated per
template: `general` accepts `scope_hint`; `plan_review` requires `plan_path`
(absolute, or `"latest"`) and accepts `focus_directive`; `research` accepts
none.

### Runtime files and progress digest (`meta.digest_uri`)

For every job that registers a Copilot prompt, the bridge maintains private
files under `~/.{claude,codex}/copilot-companion/runtime/` (override the root
with `COPILOT_RUNTIME_DIR`; created `0700`):

- `copilot-acp.sock` — user-private daemon socket.
- `copilot-bridge.log`, `copilot-acp-daemon.log` — bridge/daemon logs.
- `prompts/copilot-acp-<promptId>.jsonl` — prompt event streams.
- `digests/copilot-digest-<jobId>.md` — smart transcript digests.
- `completions.jsonl` — completion queue drained by hooks.

The digest is refreshed on every `status` call, every supervisor interim alert
(~60s during silence), and every terminal emit. It contains a header, the task,
the final/partial assistant message, `/fleet` sub-agent reports, files touched,
a tool-call summary, and the latest todos snapshot (empty sections are skipped).

The digest is surfaced as `meta.digest_uri` on terminal responses, `digest_uri`
on `still_running` waits and per-job `status` replies, and as a `resource_link`
content block for `copilot-digest://<jobId>` whenever the digest file exists.
The bridge also advertises digests through MCP `resources/list`,
`resources/templates/list`, and `resources/read`. Reading that MCP resource is
the canonical way for the parent to track progress without another bridge
round-trip. Local filesystem paths are retained only as debug metadata
(`debug.digest_path` on per-job status/still-running responses and
`meta.debug_digest_path` on terminal envelopes).

### Runtime adapter (ACP default)

The bridge uses `COPILOT_RUNTIME_ADAPTER=acp` by default. Set it to `sdk` to opt
into the experimental `@github/copilot-sdk` backend, which preserves the same
`send`/`wait`/`status`/`reply`/`cancel` response shapes. SDK reasoning effort is
unset by default (model-specific); set `COPILOT_SDK_REASONING_EFFORT` only for
models verified to accept it. SDK in-flight prompts are marked non-resumable
after a bridge restart. ACP remains the default for restart-resumable jobs.

## Thread continuity

Multi-turn Copilot conversations are preserved per host:

1. **Claude** — first send omits `thread`; the bridge auto-generates
   `companion-<jobId>`, the subagent emits `MY_THREAD=<value>`, and later
   `SendMessage` resumes the subagent so it passes that thread back.
2. **Codex** — the bridge reads `_meta["x-codex-turn-metadata"].session_id` and
   persists a host-session→thread mapping under
   `~/.codex/copilot-companion/threads/by-host-session/`.

Main's context carries only the opaque subagent handle; it never carries the
thread name.

### SendMessage invocation form (Claude)

`SendMessage`'s `message` is a tagged union: plain-text string, or a protocol
object (`shutdown_request` / `shutdown_response` / `plan_approval_response`). A
raw `{"action":"send",...}` object matches neither and fails with
`InputValidationError: path ["message"]`. Pass the payload as a **JSON-encoded
string**, and always include a `summary`:

```js
SendMessage({
  to:      <stored agentId>,
  summary: "follow-up task to copilot",      // 5-10 words, required
  message: '{"action":"send","task":"..."}'  // JSON-encoded string
})
```

The same rule applies to the Agent-spawn `prompt` field.

## Parallel orchestration

Every `send` accepts `parallel: "auto" | "always" | "never"`:

- **`auto`** (default) — the bridge prepends `/fleet ` only when the task looks
  broad enough to benefit.
- **`always`** — forces Copilot's `/fleet` orchestrator.
- **`never`** — skips `/fleet`; use this for strictly linear or single-source
  work (one-line fix, single-source research, trivial plan). `/fleet`'s
  decomposition step costs turn budget even when it finds no parallelism, so
  skipping it is faster for genuinely linear work.

When `/fleet` runs, Copilot decomposes the task, dispatches isolated sub-agents
in parallel where the work allows, and synthesizes a final answer — all inside
Copilot; the bridge's only contribution is the slash command. The natural fit is
template-shaped: `general` for multi-file refactors / parallel ANALYZE,
`research` for multi-source web research, `plan_review` for per-claim plan
verification.

```jsonc
copilot_send({ task: "refactor authentication across api/, ui/, and tests/" })          // auto decides
copilot_send({ task: "audit auth, billing, and API routes", parallel: "always" })       // force /fleet
copilot_send({ task: "fix the typo in foo.ts:42", parallel: "never" })                   // skip /fleet
```

On `status: "timeout"`, the response `content` includes a `parallel: "never"`
retry suggestion among several recovery options.

## Design invariants

1. **Strict isolation.** The `copilot-bridge` MCP server is reachable only
   through the subagent's `tools:` list. Main never calls it directly.
2. **No activation lifecycle.** The bridge spawns per subagent invocation;
   nothing to start, stop, or pause.
3. **Bounded blocking.** `send` returns `still_running` immediately; each `wait`
   returns within `max_wait_sec ≤ 1200`. The per-iteration emission resets
   Claude Code's 600s watchdog; Codex raises `tool_timeout_sec`.
4. **Orphan safety net.** Completion events append to `completions.jsonl` with
   `consumed:false`; wait-terminal responses flip them to `consumed:true`; the
   drain hook surfaces only unconsumed entries.
5. **Rubber-duck always on.** Appended server-side to every `send` except
   `plan_review` (which has its own critique baked in). Not in the schema.
6. **Model is config.** Read from the host-routed `default-model` at worker
   start (fallback `gpt-5.5`) and forwarded to the daemon, which respawns
   Copilot when the configured model changes. Never a tool parameter.
7. **Node deps persist, code doesn't.** `bridge-server/node_modules` lives under
   `${CLAUDE_PLUGIN_DATA}` and survives updates; bundled code under
   `${CLAUDE_PLUGIN_ROOT}` is re-copied on update.

## Diagnostics

Install markers (advisory; useful when both hosts are installed):

```bash
cat ~/.claude/copilot-companion/.host    # → "claude" if installed
cat ~/.codex/copilot-companion/.host     # → "codex"  if installed
```

Runtime host-routing is decided by `COPILOT_COMPANION_HOST` in the bridge's MCP
`env:` block (set to `"codex"` in the materialized Codex TOML; unset on Claude,
which uses the default). Each bridge spawn logs its detected host once at startup
to the structured JSONL log at the host's state-dir root:

```bash
grep '"event":"bridge.startup"' ~/.claude/copilot-companion/daemon.log
grep '"event":"bridge.startup"' ~/.codex/copilot-companion/daemon.log
```

Each entry carries a `host_detected` field (`claude` or `codex`).

Compact environment report:

```bash
node scripts/doctor.mjs          # or --json
```

## Development

- `node --check` should pass on every `.mjs` after edits.
- Tests:
  `node --test $(find bridge-server lib scripts hooks templates -name '*.test.mjs')`
- Build and end-to-end validate the Codex marketplace package:
  `node scripts/validate-codex-release.mjs`.
- Validate the Claude plugin manifest: `claude plugin validate .` from the
  plugin root.

## Not supported

- Main Claude / main Codex calling the bridge directly.
- Slash commands or a skill file (the surface is the subagent only).
- Session opt-in or pause.
- MCP elicitation (`NEEDS_USER_INPUT:` flow) — deferred to a future version.
