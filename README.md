# Agent Companion

Generic AI delegation for Claude Code **and Codex CLI** — a dual-host plugin with a subagent-isolated bridge.

Target posture:

- **Bring your target:** callers choose a target per send or configure one once
  for the bridge.
- **Supported now:** OpenCode via `opencode run --format json --dir <cwd>` and
  GitHub Copilot CLI via the ACP daemon path.
- **MCP tools:** `agent_send`, `agent_wait`, `agent_status`, `agent_reply`, `agent_cancel` — the only surface. There are no legacy `copilot_*` aliases.

The durable implementation tracker lives in [docs/MVP_TRACKER.md](docs/MVP_TRACKER.md).
The (now-implemented) onboarding design record lives in
[docs/ONBOARDING_HANDOFF.md](docs/ONBOARDING_HANDOFF.md), and the architecture in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The entire public surface is a single subagent shipped inside this plugin (a
Markdown variant for Claude Code, a TOML variant for Codex CLI). Main Claude /
main Codex has **zero** direct MCP visibility into the bridge; the MCP server is
declared only in the subagent's frontmatter, so only the subagent sees it. There
is no slash command, no user-scope MCP registration, no skill, no session
opt-in. Host hooks handle only materialization, dependency prewarm, heartbeat,
and completion drain.

Sends should either include `target` or rely on the configured target
(`AGENT_COMPANION_DEFAULT_TARGET` env or the `default-target` state file written
by onboarding). **There is no silent fallback** — if nothing is configured and
no `target` is passed, `agent_send` returns a `TARGET_UNCONFIGURED` error
pointing at `scripts/onboard.mjs`. `parallel: "auto"` applies to Copilot, where
the bridge can invoke Copilot's built-in `/fleet` orchestrator when broad tasks
look worth decomposing. OpenCode runs are single-shot CLI runs; richer
server/ACP integration is tracked as follow-up work.

> **Host selection.** `setup.sh` defaults to `--host both`. Pass `--host claude`
> or `--host codex` to install one surface only.
>
> **Claude packaging caveat.** Claude plugin-bundled subagents ignore
> `mcpServers`, `hooks`, and `permissionMode` frontmatter for security. So the
> Claude `SessionStart` hook materializes `templates/agent-companion.md` into
> `~/.claude/agents/agent-companion.md`; that standalone agent owns the
> private MCP bridge.

## Architecture at a glance

```
agent-companion/                            ← plugin root
├── .claude-plugin/
│   ├── plugin.json                           Claude Code plugin manifest
│   └── marketplace.json                      one-plugin marketplace (source "./")
├── .codex-plugin/
│   └── plugin.json                           Codex CLI plugin manifest
├── templates/
│   ├── agent-companion.md                  Claude subagent (Markdown + YAML frontmatter)
│   └── agent-companion.toml                Codex subagent (TOML; runtime equivalent)
├── hooks/
│   ├── hooks.json                            Claude SessionStart + PostToolUse + UserPromptSubmit
│   ├── hooks-codex.json                      Codex plugin-scoped lifecycle hooks
│   ├── node-tools.sh                         shared Node/npm resolver (GUI-launched hosts)
│   ├── drain-completions.sh                  surfaces orphan Copilot completions
│   ├── install-deps.sh                       installs bridge-server node_modules
│   ├── install-agent.sh                      Claude SessionStart: materialize Markdown subagent
│   ├── install-agent-codex.sh                Codex SessionStart: materialize TOML subagent
│   └── prewarm-target.sh                     starts copilot-acp-daemon early
├── bridge-server/
│   ├── server.mjs                            generic MCP tools: agent_send | agent_wait
│   │                                         | agent_status | agent_reply | agent_cancel
│   ├── target-registry.mjs                   target descriptors + default target resolution
│   ├── opencode-runtime.mjs                  OpenCode CLI adapter
│   ├── copilot-runtime.mjs                   runtime adapter boundary (ACP default)
│   ├── copilot-sdk-runtime.mjs               experimental Copilot SDK adapter
│   ├── validation.mjs                        per-action field allow-lists, schemas, templates
│   └── package.json                          runtime deps (MCP + Copilot SDKs)
├── lib/                                      state + logging + prompt utilities
│   ├── host.mjs                              host detection + per-host paths (claude | codex)
│   ├── runtime-paths.mjs                     private runtime dirs for IPC, logs, digests
│   ├── state.mjs                             default-model + default-target + threads/ + jobs
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
└── ~/.{claude,codex}/agent-companion/      per-host state + private runtime/
```

## Prerequisites

- **Node.js ≥ 22.**
- **At least one supported target runtime.**
  - **OpenCode target:** install/configure OpenCode and make `opencode`
    available on `PATH`, or set `OPENCODE_BIN=/absolute/path/to/opencode`.
    Non-interactive `opencode run` will reject permission prompts unless you
    configure an OpenCode agent with the required permissions or set
    `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip` to pass
    `--dangerously-skip-permissions`.
  - **Copilot target:** install/authenticate GitHub Copilot CLI
    (`npm i -g @github/copilot`, then run `copilot` once interactively). The
    daemon resolves the binary in order: `$COPILOT_BIN` → `command -v copilot`
    → `/opt/homebrew/bin/copilot`.
- **`jq`** — required for hook delivery.
- **Claude only:** `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (needed for
  SendMessage-based thread continuity). On Codex this is unnecessary —
  `features.multi_agent` is stable and on by default.

### Onboarding a target

Onboarding is target-first and never prompts for or stores provider secrets
(authenticate with the vendor tools). Check readiness and select a default:

```bash
node scripts/onboard.mjs --list-targets          # readiness for every target
node scripts/onboard.mjs --doctor                # full environment doctor
node scripts/onboard.mjs --target opencode --set-default   # select + persist
```

`setup.sh` takes the same `--target opencode|copilot|auto|none` (default
`none` — host/plugin surface only) and delegates validation to `onboard.mjs`.
An OpenCode-only install never needs Copilot, and vice versa.

## Install — Claude Code

`claude plugin install` only accepts plugins registered in a marketplace. The
repo is its own marketplace (`marketplace.json` has `source: "./"`), so adding
this directory registers a one-plugin marketplace named `agent-companion`.

```bash
# one-time: register the local directory as a marketplace
claude plugin marketplace add /path/to/agent-companion
# install from it
claude plugin install agent-companion@agent-companion
```

On the first session after install, the `SessionStart` hook runs
`hooks/install-deps.sh`, which installs the bridge-server's `node_modules` under
`${CLAUDE_PLUGIN_DATA}/bridge-server/` (persistent across plugin updates) and
symlinks it into `${CLAUDE_PLUGIN_ROOT}/bridge-server/node_modules` so Node's
ESM resolver finds `@modelcontextprotocol/sdk`.

To pick up local changes, bump `version` in `.claude-plugin/plugin.json`, then:

```bash
claude plugin marketplace update agent-companion
claude plugin update agent-companion@agent-companion
```

**Session-scoped (no install, fastest iteration):**

```bash
claude --plugin-dir /path/to/agent-companion
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
codex plugin add agent-companion@agent-companion --json
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

1. Materializes the TOML subagent to `~/.codex/agents/agent-companion.toml`
   (the only path Codex reads for unmanaged subagents). `${CLAUDE_PLUGIN_ROOT}`
   in the bridge MCP `args` is substituted to the absolute install path at
   materialization time, because Codex MCP `args` are runtime literals.
2. Merges dev hook entries into `~/.codex/hooks.json` via
   `scripts/install-codex-hooks.mjs` (read-merge-backup-write; each managed
   entry carries `_managed_by: "agent-companion"`, so `--uninstall` removes
   only our entries).
3. Skips Claude-specific steps (no `~/.claude/settings.json` permission
   injection, no Agent Teams env var).
4. Writes a diagnostic marker at `~/.codex/agent-companion/.host` containing
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
      "mcp__agent-bridge__agent_send",
      "mcp__agent-bridge__agent_wait",
      "mcp__agent-bridge__agent_status",
      "mcp__agent-bridge__agent_reply",
      "mcp__agent-bridge__agent_cancel",
      "Bash(echo \"$CLAUDE_CODE_SESSION_ID\")"
    ]
  }
}
```

Use `.claude/settings.local.json` (gitignored) to scope this per repo.

Optional log-tailing diagnostics (only if you want to read logs without
prompts): allow `Bash(tail:*)`, `Bash(ps:*)`, and
`Read(//Users/<you>/.claude/agent-companion/runtime/**)`. The double slash
marks an absolute path in Claude Code's permission syntax.

## Public surface

You don't call the MCP tools directly. Main Claude / main Codex reads the
subagent's `description` and spawns it via `Agent()` (Claude) / `spawn_agent`
(Codex) when the user asks for target-agent delegation, status, reply, or cancel.

### Internal MCP Surface (Subagent-Only)

```
agent_send({ task, cwd, target?, mode?, template?, template_args?, thread?, max_wait_sec?, parallel? })
agent_wait({ job_id, max_wait_sec? })
agent_status({ job_id?, verbose?, diagnostics? })
agent_reply({ job_id, message })
agent_cancel({ job_id })
```

`target` is optional on `agent_send`, but callers should treat target choice as
explicit or configured. Supported values are `opencode` and `copilot`; an
omitted target resolves through `AGENT_COMPANION_DEFAULT_TARGET` then
`~/.{claude,codex}/agent-companion/default-target`. There is **no** silent
fallback — an unconfigured target makes `agent_send` return a
`TARGET_UNCONFIGURED` error pointing at onboarding.

`cwd` is required on every `send` and must be the absolute target repo/worktree
path. The bridge, CLI client, and target adapters all reject a missing `cwd`
rather than defaulting to their own process cwd, so a delegated review never
silently runs in the plugin checkout.

`send` enqueues the task and returns `status: "still_running"` with a `job_id`
immediately; the worker runs in the background. The subagent then loops on
`wait` (each up to `max_wait_sec`, default 480, max 1200 — one 20-min cap for
all modes, sized for `/fleet` runs), emitting a short line between iterations to
reset the host's 600s stream-idle watchdog. The daemon caps each Copilot prompt
at 25 min (`PROMPT_TIMEOUT_MS` in `scripts/copilot-acp-daemon.mjs`). Codex
callers must set `tool_timeout_sec = 1320` on `[mcp_servers.agent-bridge]`
(the shipped TOML template does this); env vars don't extend the host's MCP
tool-call budget.

**Terminal statuses:** `completed`, `failed`, `cancelled`, `stuck` (supervisor
trip — model misbehavior), `timeout` (target turn didn't finish within the wait
budget — recoverable; read the `meta.digest_uri` MCP resource before
re-dispatching), and `unreachable` (bridge socket / target runtime unavailable
— `meta.detail` distinguishes bridge/runtime failure modes).

`agent_status({ diagnostics: true })` adds the same environment/runtime doctor
report as `node scripts/doctor.mjs --json` to the global status response. The
companion should use this MCP-native path for routine diagnostics before falling
back to raw shell/log inspection.

### Templates and modes

Templates: `general` (default), `research`, `plan_review`. Modes (general only):
`EXECUTE` (default), `PLAN`, `ANALYZE`. `template_args` keys are validated per
template: `general` accepts `scope_hint`; `plan_review` requires `plan_path`
(absolute, or `"latest"`) and accepts `focus_directive`; `research` accepts
none.

### Runtime files and progress digest (`meta.digest_uri`)

For every job that registers target output, the bridge maintains private files
under `~/.{claude,codex}/agent-companion/runtime/` (override the root with
`AGENT_RUNTIME_DIR`; created `0700`):

- `copilot-acp.sock` — user-private Copilot daemon socket.
- `agent-bridge.log`, `copilot-acp-daemon.log` — bridge and Copilot daemon logs.
- `prompts/copilot-acp-<promptId>.jsonl` — Copilot prompt event streams.
- `digests/agent-digest-<jobId>.md` — smart transcript digests.
- `completions.jsonl` — completion queue drained by hooks.

The digest is refreshed on every `status` call, every supervisor interim alert
(~60s during silence), and every terminal emit. It contains a header, the task,
the final/partial assistant message, captured target output, `/fleet` sub-agent
reports when present, files touched, a tool-call summary, and the latest todos
snapshot (empty sections are skipped).

The digest is surfaced as `meta.digest_uri` on terminal responses, `digest_uri`
on `still_running` waits and per-job `status` replies, and as a `resource_link`
content block for `agent-digest://<jobId>` whenever the digest file exists.
The bridge also advertises digests through MCP `resources/list`,
`resources/templates/list`, and `resources/read`. Reading that MCP resource is
the canonical way for the parent to track progress without another bridge
round-trip. Local filesystem paths are retained only as debug metadata
(`debug.digest_path` on per-job status/still-running responses and
`meta.debug_digest_path` on terminal envelopes).

### Targets and Runtime Adapters

**OpenCode MVP adapter**

- Uses `OPENCODE_BIN` or `opencode`.
- Spawns `opencode run --dir <cwd> --format json <prompt>`.
- Permission mode is visible in `agent_status()` under `opencode_runtime`.
  Set `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip` only when you accept
  OpenCode's dangerous auto-approval behavior.
- Runtime timeout defaults to 40 minutes. Override with
  `AGENT_COMPANION_OPENCODE_TIMEOUT_MS=<milliseconds>`.
- Supports send/wait/status/cancel.
- Does not yet support in-flight reply or restart resume; those require a
  server/ACP mode adapter and are tracked in [docs/MVP_TRACKER.md](docs/MVP_TRACKER.md).

**Copilot adapter**

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
   `~/.codex/agent-companion/threads/by-host-session/`.

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

## Parallel Orchestration

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
agent_send({ task: "refactor authentication across api/, ui/, and tests/", target: "copilot" })       // auto decides
agent_send({ task: "audit auth, billing, and API routes", target: "copilot", parallel: "always" })    // force /fleet
agent_send({ task: "fix the typo in foo.ts:42", target: "opencode", parallel: "never" })              // OpenCode single-shot
```

On `status: "timeout"`, the response `content` includes a `parallel: "never"`
retry suggestion among several recovery options.

## Design invariants

1. **Strict isolation.** The `agent-bridge` MCP server is reachable only
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
cat ~/.claude/agent-companion/.host    # → "claude" if installed
cat ~/.codex/agent-companion/.host     # → "codex"  if installed
```

Runtime host-routing is decided by `AGENT_COMPANION_HOST` in the bridge's MCP
`env:` block (set to `"codex"` in the materialized Codex TOML; unset on Claude,
which uses the default). Each bridge spawn logs its detected host once at startup
to the structured JSONL log at the host's state-dir root:

```bash
grep '"event":"bridge.startup"' ~/.claude/agent-companion/daemon.log
grep '"event":"bridge.startup"' ~/.codex/agent-companion/daemon.log
```

Each entry carries a `host_detected` field (`claude` or `codex`).

MCP-native environment report from the companion:

```jsonc
agent_status({ diagnostics: true })
```

Direct CLI equivalent:

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
