# Probes

Hand-run harnesses, outside `node --test` and the shipped plugin. They exercise
real runtimes and can spend host or companion tokens. They test process
lifetimes, sandbox enforcement, restart recovery and control behavior that unit
fakes cannot establish. Measurement evidence lives in
[`docs/RELIABILITY_REMEDIATION.md`](../docs/RELIABILITY_REMEDIATION.md).

Smoke jobs use temporary workspaces but write live execution records and runtime state and Codex
rollouts. These are not read-only checks. The `free-backends/` runner below keeps
all companion homes, workspaces and bridge state in its own temporary directory.

## `free-backends/` — isolated free-backend effort checks

| script | asserts |
|---|---|
| `free-backends/run.mjs [codex\|claude\|copilot\|opencode ...]` | Runs the shared effort probe against local Ollama for Codex, Claude and Copilot, checking each turn's proxy wire effort; OpenCode uses `opencode/flint-40b-free` and provider-reported effort. Defaults to these four companions. Antigravity and its existing probe are untouched. |
| `free-backends/proxy.mjs` | Runner-owned loopback proxy to local Ollama. Logs only canonical endpoint path and model/effort leaves, without headers, query strings or message content. Importing it opens no listener. |

Install the selected companion CLIs and Ollama using Homebrew. Prepare Ollama
manually (the measured `gpt-oss:20b` download is about 13 GB on a 24 GB RAM machine):

```sh
brew install ollama
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

Leave that server running; in another terminal:

```sh
ollama pull gpt-oss:20b
node probes/free-backends/run.mjs
```

Run the last command from the worktree root. The runner only checks Ollama's
reachability and pulled model via `/api/tags`; it never starts or stops Ollama.
Agent system prompts need context **at least 32768**. The active context setting
is not detectable by this harness; the operator must start Ollama with that setting.
The live harness has not been run during implementation.

Each companion gets a fresh temporary `HOME`, empty working directory,
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `COPILOT_HOME`, all four XDG roots, and
`AGENT_COMPANION_HOME`. The bridge always starts from this worktree, independent
of `AGENT_COMPANION_REPO`. Environment construction allowlists only `PATH` and
the selected companion's binary override (`CODEX_BIN`, etc.); it does not import
global instructions, credentials, plugins or config overrides. Codex receives
a custom Responses provider config, Claude receives `ANTHROPIC_BASE_URL` and
the dummy `ANTHROPIC_AUTH_TOKEN=ollama`, and Copilot receives offline OpenAI BYOK
settings. Copilot inherits `COPILOT_MODEL=gpt-oss:20b` without a bridge model override.
These env vars survive the adapters, including Claude's env scrubber.

OpenCode uses its documented [XDG config location](https://opencode.ai/docs/cli/config/)
and explicit [`OPENCODE_DB` override](https://opencode.ai/docs/troubleshooting/),
both inside the temporary home, with isolated XDG data/state/cache paths. Its
free model needs no copied credentials; this isolation choice has hermetic coverage
and awaits live verification. Antigravity needs its existing login and has no
custom backend, so this runner does not start it or read its home.

Every acquired bridge is stopped before advancing, and the proxy closes on success,
failure or handled signals (`SIGINT`, `SIGTERM`, `SIGHUP`). Bridge startup failure
also closes the child; unresponsive exit escalates from EOF to TERM/KILL. The printed
artifact directory is retained for review, including filtered `wire.jsonl`, native
history and isolated bridge records. No global setup is changed.

Codex's custom model is absent from its catalog: this probe checks a backend
vocabulary rejection, then `low` on a fresh and a cold resumed turn. Claude and
OpenCode run two valid turns after a pre-delivery refusal; Copilot runs one and
skips unsupported cold follow-up. BYOK does not qualify GitHub-hosted Copilot
models, still blocked by the measured account 403. The proxy currently accepts
only local Ollama; its upstream could point elsewhere in a future extension.
Cloud API backends are outside this harness's scope.

## `host-qualification/claude/` — Phase 2 host measurements

An isolated, passive fake MCP/provider fixture for Claude Code ownership,
cancellation, connection loss, cwd, follow-up and long-call measurements.
Preparation and `verify.mjs` are offline; live runs require explicit operator
execution and credentials and spend Claude tokens. Each run keeps its own
config, agents, logs and PID cleanup evidence. See the
[runbook](host-qualification/claude/RUNBOOK.md) for the first smoke command,
scenario matrix, TUI actions and limits. No production plugin is loaded. The [2026-11-05 report](host-qualification/claude/REPORT-2026-11-05.md)
records the measured rows and remaining operator actions; it does not qualify
provider cleanup.

## `host-qualification/codex/` — isolated Phase 2 host measurements

The [Codex runbook](host-qualification/codex/RUNBOOK.md) provides a passive fake
MCP/provider tree, hook logger, headless/PTY runners, scenario matrix and analyzer.
The operator runs live Codex sessions in a per-run `CODEX_HOME`; this harness
does not use the installed bridge. Start with `node probes/host-qualification/codex/runner.mjs smoke`.
Offline checks are explicit: `node probes/host-qualification/codex/self-check.mjs`.
Neither the harness nor its checks are discovered by `node --test`. The
[2026-11-05 report](host-qualification/codex/REPORT-2026-11-05.md) records identity,
stop/loss and long-call measurements; desktop remains separate.

## `smoke/` — end-to-end against the real bridge

These scripts drive `bridge-server/server.mjs` over MCP stdio. The repo root is
derived from the script location; override with `AGENT_COMPANION_REPO`.

These Phase 3 probes supply simulated native-child metadata on every owner
request. They test the controller and adapters, not host hook attribution.
They have been updated for the new surface; source checks alone do not qualify
a live provider run.

| script | asserts |
|---|---|
| `smoke.mjs` | Six MCP tools, invalid-model refusal, real Codex app-server work, persisted history and turn ids, native usage, digest content and verified runtime exit. Spends one turn. |
| `orphan.mjs` | Bridge EOF hands work to the cleanup watcher; verified stopped result survives restart, and status preserves the digest and result. Spends one Codex turn. Does not test uncatchable SIGKILL. |
| `acp-antigravity.mjs` | Completion without invented usage, cold history reuse in a new process, explicit unsupported-steer refusal, cancellation, acknowledged model selection and bridge-loss cleanup. Requires login and an available model id; spends five turns. |
| `claude.mjs` | Catalog/readiness, invalid-model refusal, fresh usage/cost, cold history reuse in a new process without cost, unsupported reply then cancel, and read-only transcript presence. Requires `claude` installed and signed in; budget four Haiku turns. Writes native transcripts into the operator's `~/.claude/projects` for the temporary cwd. |
| `effort.mjs <target> [model]` | Invalid effort refused before delivery, lowest advertised level with selected/effective metadata, then cold follow-up omitting effort in a new process. Two trivial turns; Copilot skips unsupported cold follow-up and spends at most one. Refreshes target readiness; not run as part of implementation. |
| `bridge-client.mjs` | Shared stdio MCP client, owner attribution, bounded waits and durable-record reader; no standalone probe. |

The probes use the selected host's state home, or `AGENT_COMPANION_HOME` when
set. Their temporary workspaces remain available for inspection.

The Claude probe refreshes parsed auth-status readiness and skips model work if
Claude is not ready or login is unverified. Use an isolated `AGENT_COMPANION_HOME`
for its bridge records. Native Claude transcripts are not cleaned up by the probe.

Run readiness checks before spending tokens:

```sh
AGENT_COMPANION_HOST=claude node scripts/onboard.mjs --list-targets
AGENT_COMPANION_HOST=claude node probes/smoke/smoke.mjs
AGENT_COMPANION_HOST=claude node probes/smoke/orphan.mjs
AGENT_COMPANION_HOST=claude node probes/smoke/acp-antigravity.mjs <available-model-id>
AGENT_COMPANION_HOST=claude node probes/smoke/claude.mjs
```

The effort probe obtains dynamic offered levels from the bridge's refusal hint;
static CLI enums come from the catalog. It fails before the valid send when no
levels are advertised. Effective effort is required for Codex, OpenCode,
Antigravity and Copilot; Claude remains unknown unless reported. Copilot's levels
come from the session model's `thought_level` option; GitHub-hosted session creation
can fail with this machine's account 403. A skipped
Copilot cold follow-up is not a pass. To select a model, append its available id
(OpenCode accepts `provider/model#variant`; effort overrides the variant). These commands
are hand-run and spend tokens; they have not been executed for this change:

```sh
AGENT_COMPANION_HOST=claude node probes/smoke/effort.mjs claude
AGENT_COMPANION_HOST=claude node probes/smoke/effort.mjs codex
AGENT_COMPANION_HOST=claude node probes/smoke/effort.mjs opencode
AGENT_COMPANION_HOST=claude node probes/smoke/effort.mjs antigravity
AGENT_COMPANION_HOST=claude node probes/smoke/effort.mjs copilot
```
