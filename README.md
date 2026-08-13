# Agent Companion

![Agent Companion hero](assets/readme/hero.png)

Agent Companion is a delegation plugin for coding agents built around one
public contract:

> Come with any harness and attach any companion of your choice to it.

A **harness** is the parent coding-agent surface you already work in. Supported
now: **Claude Code** and **Codex CLI**.

A **companion** is the downstream agent runtime that receives delegated work.
Supported now: **OpenCode**, **GitHub Copilot CLI**, and **Codex CLI** (Codex CLI
can be both the harness and a downstream companion — the two roles are
independent; running Codex as a companion does not require Codex as the harness,
or vice versa).

Routing is one-to-many: connect multiple companion profiles at once, give each
profile strengths, and let the harness ask for a strength instead of a concrete
runtime. A send may name a strength, a configured profile, or a bare companion;
the bridge resolves it to exactly one companion profile.

The product posture is deliberately companion-neutral:

- **Bring your harness.** Install the Claude Code surface, the Codex CLI surface,
  or both.
- **Attach your companion.** Choose `opencode`, `copilot`, or `codex` on each
  send, route by strength or profile, or persist one bridge default.
- **Keep the parent clean.** Main Claude and main Codex never see the bridge MCP
  server directly.
- **Use one public surface.** The subagent owns the generic `agent_*` tools:
  `agent_send`, `agent_wait`, `agent_status`, `agent_reply`, and
  `agent_cancel`.
- **Avoid silent behavior.** If a send selects nothing and nothing is
  configured, `agent_send` returns `TARGET_UNCONFIGURED` with onboarding
  guidance; an unresolvable profile or strength gets its own named error.
- **Route by strengths.** Companion profiles advertise strengths such as
  `reviewer` or `web_researcher`; harnesses request the strength and never
  hard-code a vendor/runtime choice.

Implementation note: today the CLI and MCP schema still use `host` for harness
selection and `target` for companion selection. Those names are stable public
flags for the MVP.

Current implementation status lives in [docs/MVP_TRACKER.md](docs/MVP_TRACKER.md).
Architecture details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Public release gates live in [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md).
The delivered onboarding design record lives in
[docs/ONBOARDING_HANDOFF.md](docs/ONBOARDING_HANDOFF.md).

## What It Does

Agent Companion turns a natural-language delegation request into a background
job owned by an isolated subagent:

1. The parent harness decides to spawn the `agent-companion` subagent.
2. The subagent calls its private `agent-bridge` MCP server.
3. The bridge resolves the selected companion, creates a job, and returns
   quickly.
4. The companion runtime runs the work in the requested `cwd`.
5. The bridge writes progress digests and emits one terminal completion event.
6. The subagent reports the result back to the harness.

That means token-heavy work can happen outside the parent's main context while
still giving the parent a structured result, status checks, cancellation, and
digest links.

![Agent Companion architecture](assets/readme/architecture.png)

## Supported Harnesses

| Harness | Install selector | Status |
| --- | --- | --- |
| Claude Code | `--host claude` | implemented |
| Codex CLI | `--host codex` | implemented |

Future harnesses should add a host install surface, subagent template, hook or
completion delivery path, and session-routing adapter without changing the
companion runtime boundary.

## Supported Companions

| Companion | Runtime | Send | Wait | Status | Cancel | Reply | Restart resume |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode (cli, default) | `opencode run --format json --dir <cwd>` | yes | yes | yes | yes | no | no |
| OpenCode (server) | `opencode serve` over HTTP | yes | yes | yes | yes | yes | yes |
| GitHub Copilot CLI | ACP daemon path | yes | yes | yes | yes | yes | yes, with ACP |
| Codex CLI (exec, default) | `codex exec --json` (one-shot subprocess) | yes | yes | yes | yes | no | no |
| Codex CLI (app-server) | `codex app-server` behind a shared broker | yes | yes | yes | yes | yes | yes |

Notes:

- OpenCode ships two adapters, selected by `OPENCODE_RUNTIME_ADAPTER`:
  - `cli` (default) is the single-shot `opencode run` adapter.
  - `server` drives a long-lived `opencode serve` HTTP server and adds in-flight
    reply/re-steer, restart resume, and streamed event digests. One shared server
    roots each job at its own `cwd` via the `?directory=` query param. The server
    is detached and survives bridge restarts (like the Copilot daemon) so a
    respawned bridge reattaches instead of re-spawning.
  - Server-mode binds `127.0.0.1` and is unsecured; permission handling follows
    OpenCode's own config (the `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip`
    flag applies to the cli adapter only).
  - `AGENT_COMPANION_OPENCODE_MODEL=provider/model` pins a model. In server mode
    it is the fallback for any job whose profile pins none; on `cli` it reaches
    the job as the synthesized default profile's model. A profile's own `model`
    wins either way, and unset leaves OpenCode's configured default in place.
- Copilot keeps `/fleet` parallel orchestration. `parallel: "auto"` can prepend
  `/fleet` for broad Copilot tasks; OpenCode and Codex remain single-job.
- Codex ships two adapters, selected by `CODEX_RUNTIME_ADAPTER`:
  - `exec` (default) is the single-shot `codex exec --json` adapter, and it is
    send-only: that pipe has no live control channel and leaves no daemon to
    reattach to after a bridge restart. The limit is the **transport**, not codex.
  - `appserver` talks JSON-RPC to a shared broker that owns one long-lived
    `codex app-server`, and adds in-flight reply (`turn/steer` injects into the
    running turn — nothing is cancelled and no work is discarded), restart
    resume (`thread/resume` rejoins a *running* thread; if the broker itself
    died, the rollout on disk still yields the transcript and only the in-flight
    turn is lost) and real sub-turn streamed digests. Cancel becomes
    `turn/interrupt`, which ends the turn and leaves the thread live.
  - Under `appserver` the approval policy is pinned to `never` and is not
    configurable: a client that accepts one approval escalates past the sandbox
    (measured), so the sandbox stays the hard boundary. The broker is detached
    and shared machine-wide, and is reaped once it has been idle with no live
    job anywhere.
- Sandbox behaviour is the same for both codex adapters. Sandbox defaults to
  `workspace-write` with network **ON** by default — the inverse of codex's own
  `codex exec` default (network OFF) — because a companion that can't `npm
  install` fails tasks confusingly; opt out per job with
  `AGENT_COMPANION_CODEX_NETWORK=off`. Override the sandbox mode with
  `AGENT_COMPANION_CODEX_SANDBOX_MODE=read-only|workspace-write|danger-full-access|bypass`
  (`danger-full-access` and `bypass` are both dangerous and flagged as such;
  `bypass` exists for environments that already sandbox the bridge itself,
  since macOS Seatbelt sandboxes do not nest). `.git`/`.codex`/`.agents` stay
  read-only inside the workspace even under `workspace-write` (a carve-out that
  wins over any extra writable roots); jobs that must write git internals need
  `danger-full-access` or `bypass`. Every delegated job persists a full rollout
  transcript under `$CODEX_HOME/sessions` (default `~/.codex/sessions`) with no
  auto-cleanup in v1 — that rollout is what `appserver` recovery reads back
  (`thread/resume` re-loads a thread from it even after the broker dies). The
  `codex exec resume <thread_id>` lever this once anticipated was dropped when
  the app-server transport landed; see
  [docs/RELIABILITY_REMEDIATION.md](docs/RELIABILITY_REMEDIATION.md) "Wave 3".
  Codex inherits the user's own `~/.codex/config.toml` by default (no
  `--ignore-user-config` for real jobs): every enabled MCP server
  boots on each spawn and can stall the first turn up to its configured
  `startup_timeout_sec`, and shell env is inherited into the child minus
  `*KEY*`/`*SECRET*`/`*TOKEN*` names. Optional model pin for the default
  profile: `AGENT_COMPANION_CODEX_MODEL=<model id>` (a profile's own `model`
  wins); timeout default 40 minutes, override with
  `AGENT_COMPANION_CODEX_TIMEOUT_MS`.
- Goose and Aider are tracked as future companion adapter candidates.

## Strength Routing

Shipped 2026-06-23. `resolveRouting` is the bridge's only routing brain, and it
never falls back silently: every request it cannot resolve comes back as a named
error. Ambiguity and unknown-key errors echo the candidate ids; the
capability-gate refusals (`TARGET_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE`,
`MODEL_NOT_ALLOWED`) name the offending companion in `target` instead. Every
envelope carries the public `targets` and `profiles` lists.

One `agent_send` resolves to exactly one companion profile. A send may carry:

| Field | Meaning |
| --- | --- |
| `strength` | Preferred. Route to the configured profile that declares this label. |
| `profile` | A specific configured profile id. Mutually exclusive with `strength`. |
| `target` | A bare companion: `opencode`, `copilot`, or `codex`. |
| *(none)* | The configured default profile wins — see Internal MCP Surface for the full zero-input order. |

Passing both `strength` and `profile` is `ROUTING_CONFLICT`. A `target` passed
*alongside* one of them is read as an assertion, not a selector: if it disagrees
with the resolved profile's companion, that is `ROUTING_CONFLICT` too.

A profile pins one companion, optionally a model and an adapter, and declares
strengths drawn from a closed vocabulary: `reviewer`, `web_researcher`,
`planner`, `fast_executor`. Profiles inherit capabilities from their companion
and never re-declare them. Author them with onboarding:

```bash
node scripts/onboard.mjs --define-profile copilot_claude_sonnet_4_6 \
  --companion copilot --model claude-sonnet-4.6 --strength web_researcher
node scripts/onboard.mjs --define-profile copilot_gpt_5_4 \
  --companion copilot --model gpt-5.4 --strength reviewer
node scripts/onboard.mjs --define-profile opencode_provider_model \
  --companion opencode --model provider/model --strength fast_executor
node scripts/onboard.mjs --set-default-profile copilot_gpt_5_4
```

Ambiguity is an error rather than a coin flip. When several profiles declare the
same strength — or several target the same bare companion — the configured
`defaultProfile` breaks the tie only when it is itself one of the candidates —
it has to declare that strength, or target that companion. Otherwise the send
fails `STRENGTH_AMBIGUOUS` or `PROFILE_AMBIGUOUS`. With no `profiles.json` at all the
bridge synthesizes a single profile from `default-target`, so an install that
never authored a profile routes exactly as it did before.

Two open items:

- `STRENGTH_CAPABILITY_REQUIREMENTS` ships empty: no strength yet demands a
  capability, so the pre-spawn capability gate is fully wired but inert.
- A profile's `adapter` field is a capability *declaration*. The transport a job
  actually starts on is still whatever `OPENCODE_RUNTIME_ADAPTER` /
  `CODEX_RUNTIME_ADAPTER` says at spawn, frozen per job from there.

## Requirements

- Node.js `>= 22`.
- `npm`.
- `jq` for hook delivery.
- At least one companion runtime:
  - OpenCode on `PATH`, or `OPENCODE_BIN=/absolute/path/to/opencode`.
  - GitHub Copilot CLI on `PATH`, or `COPILOT_BIN=/absolute/path/to/copilot`.
  - Codex CLI on `PATH`, or `CODEX_BIN=/absolute/path/to/codex`, authenticated
    via `codex login` (ChatGPT plan) or an API key.
- Claude Code CLI when installing the Claude surface.
- Codex CLI when installing the Codex surface.

OpenCode authentication and provider setup stays inside OpenCode. Copilot
authentication stays inside Copilot CLI. Codex authentication stays inside
Codex CLI. Agent Companion does not ask for or store provider secrets.

## Fast Path

From the repository root, pick the harness surface you actually use:

```bash
# Codex source-checkout install, without selecting a default target yet.
bash setup.sh --host codex --target none

# Or Claude source-checkout install, without selecting a default target yet.
bash setup.sh --host claude --target none

# See target readiness and next steps.
node scripts/onboard.mjs --list-targets

# Persist a default target for Codex state.
AGENT_COMPANION_HOST=codex node scripts/onboard.mjs --target opencode --set-default

# Or persist a default target for Claude state.
AGENT_COMPANION_HOST=claude node scripts/onboard.mjs --target opencode --set-default
```

For a narrower install:

```bash
# Codex only, OpenCode default.
bash setup.sh --host codex --target opencode

# Claude only, Copilot default.
bash setup.sh --host claude --target copilot

# Harness/plugin surface only. Every send must select a companion explicitly.
bash setup.sh --host both --target none
```

`setup.sh --host both --target auto` selects the only ready target for both
hosts. If multiple targets are ready, pass the target explicitly.

## Onboarding Commands

Targets:

```bash
node scripts/onboard.mjs --list-targets
node scripts/onboard.mjs --doctor
node scripts/onboard.mjs --target opencode --set-default
node scripts/onboard.mjs --target copilot --set-default
node scripts/onboard.mjs --target codex --set-default
node scripts/onboard.mjs --target opencode --smoke
```

Companion profiles (ids, models and strength labels only — never secrets):

```bash
node scripts/onboard.mjs --list-profiles
node scripts/onboard.mjs --define-profile <id> --companion opencode|copilot|codex \
  [--model <m>] [--adapter <transport>] [--strength <labels>]
node scripts/onboard.mjs --assign-strength <id> --strength <labels>
node scripts/onboard.mjs --set-default-profile <id>
```

`--adapter` takes `cli|server` for OpenCode and `exec|appserver` for Codex.
Copilot has no profile-selectable adapter; its transport is host-level.
`--strength` takes a comma-separated subset of `reviewer`, `web_researcher`,
`planner`, `fast_executor`.

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--host` | Label/scope onboarding output as `claude`, `codex`, or `both`. |
| `--target` | Select `opencode`, `copilot`, `codex`, `auto`, or `none`. |
| `--set-default` | Write `~/.{claude,codex}/agent-companion/default-target`. |
| `--json` | Emit machine-readable reports. |
| `--no-target-check` | Persist the target even if readiness checks fail. |
| `--smoke` | Run an opt-in target smoke task when supported. |
| `--yes` / `-y` | Strict non-interactive mode: skip the smoke confirmation, and fail rather than prompt on an ambiguous target or warn on a strength conflict. |

For standalone host-specific writes, set `AGENT_COMPANION_HOST=codex` or
`AGENT_COMPANION_HOST=claude` on the command. `setup.sh` does this for each
host when it delegates to onboarding.

`AGENT_COMPANION_DEFAULT_PROFILE` overrides the persisted `defaultProfile`, and
`AGENT_COMPANION_DEFAULT_TARGET` overrides the persisted `default-target`. The
default profile is consulted first; `default-target` answers only when no
default profile is configured. With nothing configured at all and `agent_send`
omitting `target`, the bridge refuses the send instead of guessing.

## Install For Claude Code

This repo is its own local marketplace. Register it once, then install the
plugin:

```bash
claude plugin marketplace add /path/to/agent-companion
claude plugin install agent-companion@agent-companion
```

For fastest source iteration:

```bash
claude --plugin-dir /path/to/agent-companion
```

Claude plugin-bundled subagents ignore `mcpServers`, `hooks`, and
`permissionMode` frontmatter for security. Agent Companion handles that by
materializing `templates/agent-companion.md` to:

```text
~/.claude/agents/agent-companion.md
```

The standalone materialized agent owns the private MCP bridge.

The agent's MCP call deadline is set per host, on the server entry itself:
`timeout: 1320000` (milliseconds) in the Claude frontmatter, `tool_timeout_sec =
1320` in the Codex TOML. Both clear the bridge's own 1200s wait cap
(`clampWaitSec`) so the bridge always answers before the host abandons the call.
On the Claude side this must be a **sibling of `command`/`args`**, not an `env:`
entry — an `MCP_TOOL_TIMEOUT` environment variable reaches the bridge child
process but the host ignores it, and it silently buys nothing. The per-server
field also floors the MCP idle window, which is what keeps a long silent
`agent_wait` from being cut at the host's watchdog tick.

### Claude Permissions

The subagent needs permission to call the split MCP tools. Source checkout setup
does this idempotently:

```bash
node scripts/install-permissions.mjs --host claude --yes
```

Marketplace installs can also approve the first prompt with "Yes, don't ask
again". The allow-list shape is:

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

Use `.claude/settings.local.json` if you want these permissions scoped to one
repository.

### Optional: `SendMessage` subagent resume

Nothing in this plugin requires it. The bridge implements its own reply, wait,
status and restart-resume over HTTP (`agent_reply` / `agent_wait` /
`agent_status`, plus the `reply_available` / `resume_available` flags described
in `docs/ARCHITECTURE.md`) — none of which goes through Claude Code's
`SendMessage`.

If you separately want Claude Code's built-in subagent resume — reattaching to
a *completed* subagent's thread with its context intact — that is gated behind
an experimental flag you can set yourself:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

`setup.sh` does **not** set this for you. It is an experimental Claude Code
flag with effects well beyond this plugin, so opting in is your call.

## Install For Codex CLI

Build a local Codex marketplace package:

```bash
node scripts/build-codex-marketplace.mjs --out dist/codex-marketplace
codex plugin marketplace add dist/codex-marketplace
codex plugin add agent-companion@agent-companion --json
```

Validate the package end to end in an isolated `CODEX_HOME`:

```bash
node scripts/validate-codex-release.mjs
```

The generated package uses plugin-scoped Codex hooks from
`hooks/hooks-codex.json`; it does not mutate live `~/.codex/hooks.json`.

For source-checkout development:

```bash
bash setup.sh --host codex
```

That path materializes:

```text
~/.codex/agents/agent-companion.toml
```

and merges managed dev hook entries into `~/.codex/hooks.json`. Managed entries
carry `_managed_by: "agent-companion"` and can be removed with:

```bash
node scripts/install-codex-hooks.mjs --plugin-root "$(pwd)" --uninstall --yes
```

Codex V1 `multi_agent` surfaces the terminal subagent message on the next parent
turn. If a job has finished and main Codex has not resumed, send a short prompt
such as `any updates?`.

## Internal MCP Surface

You normally do not call these tools yourself. The host reads the subagent
description and spawns it when you ask for delegation, status, reply, or cancel.

```text
agent_send({
  task,
  cwd,
  target?,
  strength?,       // preferred routing input; mutually exclusive with profile
  profile?,        // a specific configured profile id; mutually exclusive with strength
  mode?,
  template?,
  template_args?,
  thread?,
  max_wait_sec?,
  parallel?
})

agent_wait({ job_id, max_wait_sec? })
agent_status({ job_id?, verbose?, diagnostics? })
agent_reply({ job_id, message })
agent_cancel({ job_id })
```

Important rules:

- `cwd` is required on every send and must be an absolute target repo/worktree
  path.
- `target` may be `opencode`, `copilot`, or `codex`. Prefer `strength`, or
  `profile` when you need one specific configured profile.
- With `target`, `strength` and `profile` all omitted, resolution uses the
  default profile — `AGENT_COMPANION_DEFAULT_PROFILE`, else the `defaultProfile`
  key in `profiles.json` — and routes to that profile's companion. A default
  profile naming no configured profile fails with `PROFILE_UNKNOWN` rather than
  falling through. Only when no default profile is configured does resolution
  fall back to `AGENT_COMPANION_DEFAULT_TARGET`, then the host `default-target`
  state file. With no `profiles.json` the bridge synthesizes one profile from
  `default-target`, so a legacy install resolves identically.
- `agent_send` returns `still_running` immediately with a `job_id` — except when
  it reattaches to an in-flight job on the same thread and host session (a
  respawned bridge hydrates persisted jobs at startup), where it blocks like
  `agent_wait` up to `max_wait_sec`.
- `agent_wait` blocks in bounded intervals. The wait defaults to 480 seconds and
  is capped at 1200 seconds.
- `agent_status({ diagnostics: true })` embeds the same environment report as
  `node scripts/doctor.mjs --json`.

Terminal statuses are `completed`, `failed`, `cancelled`, `stuck`, `timeout`,
and `unreachable`.

## Templates, Modes, And Parallelism

Templates:

| Template | Purpose |
| --- | --- |
| `general` | Default implementation, review, and analysis work. |
| `research` | Multi-source research. |
| `plan_review` | Plan verification with a required `plan_path`. |

### Output wrapper

Copilot-target output for the `general` and `research` templates carries a
server-appended `RUBBER-DUCK: clean|revised` verdict line. It is not
configurable and there is no payload field controlling it. `plan_review` has
its own critique built in and skips the wrapper, and OpenCode MVP output is
relay-only so it never carries one.

This lives here rather than in the subagent descriptions because it describes
what the caller *receives*, not how to construct a call — and the server
already appends a self-explaining footer next to the verdict at the point of
consumption.

General modes:

| Mode | Purpose |
| --- | --- |
| `EXECUTE` | Implement or carry out the requested task. |
| `PLAN` | Produce a plan without changing code. |
| `ANALYZE` | Diagnose or review without implementation. |

Parallelism:

```jsonc
agent_send({ task: "audit auth, billing, and API routes", target: "copilot", parallel: "always" })
agent_send({ task: "fix the typo in src/foo.ts", target: "opencode", parallel: "never" })
```

`parallel: "auto"` is the default. It can use Copilot `/fleet` only for broad
Copilot tasks.

## Runtime State And Digests

Per-host state lives under:

```text
~/.claude/agent-companion/
~/.codex/agent-companion/
```

Configuration and the job ledger sit at that state root:

```text
.host                                   install marker
default-target                          persisted bare-companion default
default-model                           persisted Copilot model default
profiles.json                           companion profiles and `defaultProfile`
threads/                                thread → companion session ids
jobs/                                   persisted job ledger, replayed on hydrate
daemon.log                              structured JSONL event log, rotated at 10 MB
```

`daemon.log` is the one the Diagnostics section greps. Everything else lives one
level down, under each host's `runtime/` directory:

```text
agent-bridge.log                        human-readable bridge trace
copilot-acp.sock                        Copilot ACP daemon socket
copilot-acp-daemon.log                  Copilot ACP daemon log
copilot-otel-traces.jsonl               Copilot OTEL traces
codex-app-server.sock                   codex app-server broker socket
codex-app-server-broker.log             codex app-server broker log
codex-broker.json                       codex broker leases and disposal claim
opencode-servers.json                   pooled `opencode serve` registry
heartbeats/                             host-liveness files the daemons reap against
prompts/copilot-acp-<promptId>.jsonl    per-prompt event stream
digests/agent-digest-<jobId>.md         rendered progress digests
completions.jsonl                       orphan completion queue
```

Both shared-runtime registries survive bridge restarts, for different reasons.
`opencode-servers.json` holds the only record of a server's ephemeral `--port 0`
address, so it is how a respawned bridge reattaches to a still-listening
`opencode serve` instead of spawning a duplicate. The broker's address is the
fixed socket above, so a bridge finds it by connect-probing the socket and
re-records what it adopted; `codex-broker.json` is bookkeeping — the leases,
`lastUsedAt` and disposal claim that keep a broker still in use from being
reaped.

The bridge surfaces progress as:

```text
agent-digest://<jobId>
```

Digests include the task, final or partial assistant output, target output,
tool-call summaries, files touched, and latest todo snapshots when available.
The MCP resource is the canonical way for the parent to inspect progress
without another raw filesystem read.

## Diagnostics

```bash
node scripts/doctor.mjs
node scripts/doctor.mjs --json
node scripts/onboard.mjs --doctor
node scripts/onboard.mjs --list-targets
```

Install markers:

```bash
cat ~/.claude/agent-companion/.host
cat ~/.codex/agent-companion/.host
```

Bridge startup events are JSONL:

```bash
grep '"event":"bridge.startup"' ~/.claude/agent-companion/daemon.log
grep '"event":"bridge.startup"' ~/.codex/agent-companion/daemon.log
```

## Development

Run the project checks locally:

```bash
bash -n setup.sh hooks/*.sh
find . -name '*.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 -n1 node --check
find . -name '*.test.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 node --test --experimental-test-coverage
```

These are the shell-syntax, JavaScript-syntax and test steps
`.github/workflows/ci.yml` runs; CI additionally runs `npm ci` and
`npm audit --omit=dev --audit-level=moderate` in `bridge-server/`. Discovery is anchored at
the repo root rather than an allow-list of directories, because an allow-list
omitting `test/` skips the two cross-cutting guard suites — the `profiles.json`
single-reader guard and the sync-exec timeout guard.

Package validation:

```bash
node scripts/build-codex-marketplace.mjs --out dist/codex-marketplace
node scripts/validate-codex-release.mjs
claude plugin validate .
```

## Design Invariants

- The `agent-bridge` MCP server is subagent-only.
- Main Claude and main Codex never call the bridge directly.
- The bridge is spawned per invocation; there is no activation lifecycle.
- Sends are non-blocking — the one exception is reattaching to an in-flight job
  on the same thread, which blocks like a wait — and every wait is bounded.
- Orphan completions are stored in `completions.jsonl` and drained by hooks.
- Model choice is configuration, not a public tool parameter.
- Node dependencies persist under plugin data; bundled source updates with the
  plugin package.

## Not Supported

- Direct parent-agent calls to the bridge.
- Slash commands or skills as the public surface.
- Session opt-in or pause.
- OpenCode CLI in-flight reply/re-steer (server mode supports it).
- OpenCode CLI restart resume (server mode supports it).
- Codex `exec` in-flight reply/re-steer (app-server mode supports it via
  `turn/steer`).
- Codex `exec` restart resume (app-server mode supports it via `thread/resume`).
- MCP elicitation or `NEEDS_USER_INPUT` flows.

## Repository Map

```text
.claude-plugin/        Claude plugin manifest and local marketplace manifest
.codex-plugin/         Codex plugin manifest
.github/workflows/     CI: shell syntax, JS syntax, tests with coverage, prod audit
assets/readme/         README PNG assets plus editable SVG diagram sources
bridge-server/         MCP server plus companion runtime adapters
docs/                  Architecture, tracker, onboarding, and release readiness
hooks/                 Claude and Codex lifecycle hooks
lib/                   Shared state, host routing, diagnostics, prompt helpers
probes/                Hand-run codex app-server and smoke harnesses, outside CI
scripts/               Setup, onboarding, marketplace build, release validation
templates/             Claude Markdown and Codex TOML subagent templates
test/                  Cross-cutting guard suites and codex app-server doubles
setup.sh               Host install and target onboarding entry point
```

## License

MIT. See [LICENSE](LICENSE).
