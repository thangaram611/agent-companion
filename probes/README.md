# Probes

Hand-run harnesses, outside `node --test` and the shipped plugin. They exercise
real runtimes and can spend host or companion tokens. They test process
lifetimes, sandbox enforcement, restart recovery and control behavior that unit
fakes cannot establish. Measurement evidence lives in
[`docs/RELIABILITY_REMEDIATION.md`](../docs/RELIABILITY_REMEDIATION.md).

Smoke jobs use temporary workspaces but write live execution records and runtime state and Codex
rollouts. These are not read-only checks. The `free-backends/` runner below keeps
all companion homes, workspaces and bridge state in its own temporary directory.

## `acp-record/` — Copilot ACP record and replay

`acp-record/record-copilot.mjs` drives the bridge's real `AcpAdapter` and process
supervisor through four fresh sessions: `turn-command` (`echo fixture-ok` with
tool/output evidence), `effort` (set and confirm `thought_level: low`), `cancel`
(interrupt once the model streams; require `cancelled`), and `signed-out`
(no BYOK environment; require `session/new` -32000 and adapter `AUTH_REQUIRED`).
It is hand-run, outside `node --test`. The committed fixtures were recorded
2026-11-18 on Copilot CLI 1.0.113 with local `gpt-oss:20b`. Each selects the
requested model after `session/new` and confirms `currentValue` before
prompting. `cancel` interrupts once the model streams (its first thought or
message chunk); 1.0.113 answers that prompt without usage counters.

Install Copilot CLI and Homebrew Ollama, then start Ollama manually:

```sh
brew install copilot-cli ollama
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

Leave the server running. In another terminal, from the repository root:

```sh
ollama pull gpt-oss:20b
node probes/acp-record/record-copilot.mjs
```

That command records all four scenarios. Optional positional scenario names
select a subset. `COPILOT_BIN` may point to a particular CLI executable. The
recorder reuses `free-backends/run.mjs`'s `checkOllama` and `companionEnv`: local
Ollama at `http://127.0.0.1:11434`, model `gpt-oss:20b`, and **$0 provider cost**.
It checks the pulled model but cannot detect the running server's context size;
start it with at least 32768 as above. It never starts or stops Ollama.

Every scenario has a disposable HOME, workspace, tmp, provider homes, XDG roots
and bridge state. Only PATH and the binary override come from the operator;
credentials, installed instructions and provider settings are not inherited.
State environment is set before runtime imports. The recorder does not read or
write the operator's `~/.copilot`, `~/.codex`, `~/.claude` or `~/.gemini`.
`signed-out` removes all BYOK keys and must fail before a prompt is sent.

A Node tee in `COPILOT_BIN` forwards the original stdio bytes and records both
directions. It scrubs each frame **before writing even a temporary capture**:
root/home/cwd/tmp/binary paths become `/fixture/...`, opaque session/tool/request
ids are renumbered consistently, and semantic ids and model text are retained.
Token-like text (GitHub tokens, `github_pat_`, `sk-`, Bearer credentials), or a
remaining operator username/home path, refuses the capture. No raw traffic log
is saved. Failed scenarios exit nonzero and leave any previous fixture intact;
temporary homes and captures are removed. Native stderr passes through the tee
unchanged and is discarded by the adapter; it is not recorded.

Successful captures overwrite `test/fixtures/acp/copilot/<scenario>.jsonl`.
The first line identifies `acp-replay`, companion, the first `copilot --version`
line, ISO recording time, scenario and model (`null` for signed-out); following
lines are `{dir: 'client'|'agent', frame}`. **Re-record after a Copilot upgrade;
review the git diff.** Re-run the acceptance suite:

```sh
node --test bridge-server/adapters/acp-replay.test.mjs
```

The suite automatically uses those four files when present and explicitly skips
missing live recordings. `ACP_FAKE_REPLAY=<fixture path>` switches the existing
fake to strict method/order replay, including notifications and replies to agent
permission/unsupported-method requests. It maps request and session ids and
returns -32603 plus stderr on mismatch, including errors to pending prompts
when a notification mismatches. It never skips ahead.

Replay preserves recorded order, not timing, pipe chunk boundaries or tool
effects. It checks method/order and id relationships, not arbitrary client
parameters or permission-result contents; it cannot branch on a changed prompt
or reproduce an unrecorded interaction. Only ACP stdout/stdin are captured:
stderr, native session files and the older OTEL usage fallback are not replayed.
Local BYOK recordings do not qualify GitHub-hosted authentication/model behavior.

## `free-backends/` — isolated free-backend effort checks

| script | asserts |
|---|---|
| `free-backends/run.mjs [codex\|claude\|copilot\|opencode ...]` | Runs the shared effort probe against local Ollama for Codex, Claude and Copilot, checking each turn's proxy wire effort; OpenCode uses `opencode/flint-40b-free` and provider-reported effort. Defaults to these four companions. |
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
and awaits live verification. Antigravity uses the signed-in `agy` profile.
This runner skips it and never reads its home.

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
| `acp-antigravity.mjs` | Completion with prompt usage and a digest, cold history reuse in a new process, default steer during a command, cancel, a background command's file and final reply, confirmed model selection and bridge-loss cleanup. Logs whether the model waited in the prompt or the bridge kept the turn open. Starts seven jobs. Requires a signed-in `agy` CLI and an available model id. |
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
Antigravity and Copilot; Claude remains unknown unless reported. Copilot and
Antigravity get levels from the session model's `thought_level` option.
GitHub-hosted Copilot session creation can fail with this machine's account 403. A skipped
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
