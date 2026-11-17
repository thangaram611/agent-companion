# Agent Companion

![Agent Companion hero](assets/readme/hero.png)

Agent Companion is a delegation plugin for coding agents built around one
public contract:

> Come with any harness and attach any companion of your choice to it.

A **harness** is the parent coding-agent surface you already work in. Supported
now: **Claude Code** and **Codex CLI**.

A **companion** is the downstream agent runtime that receives delegated work.
Supported now: **OpenCode**, **GitHub Copilot CLI**, **Codex CLI**, **Google
Antigravity** and **Claude Code**. Both Codex CLI and Claude Code can be a harness
or a companion; the two roles are independent.

Talk to the `agent-companion` subagent in plain language. Give it the task, the
absolute repo or worktree path, and any companion or model preference. Follow-ups
to the same subagent cold-resume saved history where supported; a new subagent starts
independent work. Run long work in the background.

The product posture is deliberately companion-neutral:

- **Bring your harness.** Install the Claude Code surface, the Codex CLI surface,
  or both.
- **Attach your companion.** Name OpenCode, Copilot, Codex, Antigravity or
  Claude Code, or let the subagent choose a ready companion from the catalog. Set a default if useful.
- **Keep the parent workflow clean.** Delegated work runs through the isolated
  subagent. Both hosts register the internal bridge at plugin/session scope;
  execution calls require the native child owner.
- **Discover available choices.** Ask what companions and models are available.
  The read-only catalog reports configuration, capabilities and readiness.
- **Keep failures explicit.** The subagent relays refusals and terminal failures.
  The delegated work stays with the companion; failure does not authorize the
  subagent to finish it or silently choose another companion or model.

Implementation note: today the CLI and MCP schema still use `host` for harness
selection and `target` for companion selection. Those names are stable public
flags for the MVP.

Current implementation status lives in [docs/MVP_TRACKER.md](docs/MVP_TRACKER.md).
Architecture details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Public release gates live in [docs/RELEASE_READINESS.md](docs/RELEASE_READINESS.md).
The project is in active development. The shipped controller owns one cold
provider runtime per answer. Codex desktop and Copilot cold follow-up remain
unqualified; local tests do not replace installed-host acceptance.

## What It Does

![One plain-language delegation to the Codex companion from Claude Code](assets/readme/demo.gif)

1. The parent spawns `agent-companion` with a plain-language request and an
   absolute repo or worktree path. The subagent asks if the path is missing.
2. The subagent honours a named companion and model. When the choice is open,
   it reads the catalog once, chooses a ready companion and leaves the model
   to that companion's configuration.
3. It sends a clear message with the task, context, constraints and desired
   answer. The bridge passes that message to the companion verbatim.
4. The controller starts a provider process in its own process group, loads
   saved history when continuing, and sends the message once. It records progress
   and the result, terminates the owned tree and publishes completion.
5. The subagent waits with a bounded budget, then returns the companion's answer
   as given. It relays questions to the parent and keeps any checks of its own
   under a separate heading.

For example: "Ask Codex to review the changes in /absolute/path/to/repo. Keep it
read-only and explain any bugs with file references." Send the next message to
that same subagent to continue the review. The parent chooses what a good answer
looks like; the bridge adds no instructions or required answer format.

The catalog lists enabled companions, the default companion, per-companion model
configuration, intervention/resume/cancel/model-selection capabilities, readiness and
the installed version seen at the last check. An unset model default is reported
as inheriting the companion's own configuration. A list that needs a session is
reported as "not enumerable without a session". Reading the catalog starts no
work and changes no job, ownership, lease or result state. Each target's
`capabilities.interventions` contains `{ default, steer, queue, interrupt }`:
`default` is a mode or null; `steer` and `interrupt` are booleans; `queue` is
`false`, `bridge` or `native`. These registry capabilities describe support;
`agent_status.interventions` reports which modes are usable on a job now.

![Agent Companion architecture](assets/readme/architecture.png)

The shipped flow: harness, subagent, session-scoped bridge, one controller per
answer, one cold companion runtime per answer. Details are in
[Architecture](docs/ARCHITECTURE.md#flow).

## Supported Companions

![Companion capabilities](assets/readme/target-matrix.png)

The table below is the current capability contract.

| Companion | Per-job runtime | Follow-up by cold resume | In-flight messages (default first) | Model selection | History |
| --- | --- | --- | --- | --- | --- |
| OpenCode 2.x | Private authenticated `opencode serve` | Saved session | Steer, queue, interrupt | `provider/model`, optional variant | Vendor-persisted session |
| GitHub Copilot CLI | `copilot --acp` | Unsupported until qualified | Unsupported | Inherit or supported explicit model | Session id retained; cold load unqualified |
| Codex CLI | `codex app-server` | `thread/resume` | Steer, queue, interrupt | Inherit or explicit override | Native thread and rollouts |
| Google Antigravity | `agy_acp_server.par` over ACP | `session/load` | Queue, interrupt (live qualification pending) | Session model after new/load | Native SQLite history |
| Claude Code | `claude -p` | `--resume` saved session | Queue, interrupt | Inherit or explicit override | Native transcripts |

All support send, wait, status and cancel. Every job starts in a new process;
accepted messages can continue it through several turns on the same live session.
There is no shared provider runtime or adapter-selection setting. Copilot
follow-ups return `FOLLOWUP_UNSUPPORTED` until cold loading is qualified.
`agent_reply` returns `reply_unavailable` with reason `state` or `capability`
when the requested mode is unavailable; it never substitutes a mode.
Bridge loss stops the owned tree through the cleanup watcher and keeps native
history; in-flight work does not survive bridge replacement. The next message
to the same native child resumes cold. An unavailable history fails explicitly.

Configuration:

- `AGENT_COMPANION_OWNER_GRACE_MS` controls the owner attachment grace (default
  120000 ms). Pending send/wait/reply/cancel calls hold the lease; status and
  catalog do not. Stop hooks write owner markers. Total execution has no
  40-minute cutoff; each wait is still bounded by the host's per-call timeout.
- `AGENT_COMPANION_DEFAULT_TARGET` overrides the `default-target` file.
- Save a per-companion model default with
  `node scripts/onboard.mjs --target <companion> --model <id> --set-default`.
  Select the host state with `AGENT_COMPANION_HOST=claude|codex`, or use
  `bash setup.sh --host <host> --target <companion> --model <id>`.
  `--model inherit` clears the saved default. `AGENT_COMPANION_CODEX_MODEL`,
  `AGENT_COMPANION_OPENCODE_MODEL` and `AGENT_COMPANION_CLAUDE_MODEL` override
  saved defaults where the host passes them (Claude host). An explicit request
  overrides the default; with neither set, the companion inherits its own configuration.
- OpenCode requires 2.x and uses server permissions from its configuration.
  Its private loopback password is kept in memory, never in durable records.
- Codex defaults to `workspace-write` with network enabled. Use
  `AGENT_COMPANION_CODEX_NETWORK=off` or
  `AGENT_COMPANION_CODEX_SANDBOX_MODE=read-only|workspace-write|danger-full-access|bypass`.
  `bypass` maps to `danger-full-access`; approval policy stays fixed at `never`.
  `.git`/`.codex`/`.agents` remain read-only under `workspace-write`, even with
  extra writable roots. The measured approval/sandbox constraints are in
  [Architecture](docs/ARCHITECTURE.md#negative-results).
- Codex inherits configured MCP servers, whose startup can delay a turn.
  Rollouts persist under `$CODEX_HOME/sessions` (default `~/.codex/sessions`)
  without automatic cleanup. No model key is sent when inheriting its model.
- `AGENT_COMPANION_CLAUDE_PERMISSION` accepts `default`, `acceptEdits`, `plan`,
  `auto`, `dontAsk` or `bypassPermissions` (case-insensitive). Unset or unrecognized
  values use `bypassPermissions`, which skips permission checks and is flagged
  dangerous in diagnostics. Permission prompts are disabled for every mode.
  `AGENT_COMPANION_CLAUDE_MODEL` optionally sets a model default; without an
  explicit or saved default, Claude Code uses its own model configuration.
  Codex does not forward the shell environment to the bridge, so on the Codex
  host use a saved default to pin a model across conversations. These model env
  knobs take no effect there; explicit per-request model choices still work.
- Install and sign in to Antigravity with
  `node scripts/install-antigravity-acp.mjs --login`. It verifies Google's
  signature on macOS and installs under
  `~/.local/share/agent-companion/antigravity-acp/`;
  `ANTIGRAVITY_ACP_BIN` overrides the binary. Credentials remain with the
  server under `~/.gemini/antigravity-acp/` and the login keychain.
  `AGENT_COMPANION_ANTIGRAVITY_PERMISSION=all|edit|none` controls permission
  answers (default `all`). Use the real project cwd: its sandbox resolves
  symlinks. Model selection is reapplied after each history load. Google's
  FAQ names Claude Code among third-party software that must not use an
  Antigravity login, and calls wrapping `agy` in third-party agents unsupported
  on consumer plans; suspension or termination of the account is the stated
  risk, and it is the account holder's. The
  account/terms assessment remains [tracker item 8](docs/MVP_TRACKER.md).

See [Architecture](docs/ARCHITECTURE.md) for protocol and lifecycle details,
and [Diagnostics](#diagnostics) for installation problems.

### Claude Code as a companion

Agent Companion runs the user's installed, unmodified Claude Code binary with
that user's own credentials and does not use the Agent SDK; see the
[vendor terms](https://code.claude.com/docs/en/legal-and-compliance).
The binary handles login; the bridge does not implement login, extract credentials
or proxy Anthropic requests. Billing follows the user's own plan or API setup.

A Claude Code host can delegate to a separate Claude Code companion process.
The child cannot delegate again through Agent Companion. User/project settings,
hooks, plugins and CLAUDE.md still load; background tasks are disabled.
Transcripts stay in `~/.claude/projects` (or `CLAUDE_CONFIG_DIR/projects` when
configured), and follow-ups resume them in a new process. The bridge retains the
session id and does not clean up those transcripts. In-flight messages default
to queue: Claude decides whether they join this turn or start the next one.
Interrupt sends the new message immediately through Claude's native control.
Steer is refused. Usage reports per-turn tokens; cost is
reported only for fresh history because Claude's resumed cost is cumulative.

Claude Code 2.1.319 was measured as the companion, including installed delegation
from Codex CLI 0.167.0 and a nested run from a Claude Code parent; see the
[companion report](probes/host-qualification/claude-companion/REPORT-2026-11-09.md).
Older versions remain unverified. `--permission-prompts` requires at least 2.1.259.
See the [release gates](docs/RELEASE_READINESS.md#release-gates).

## Requirements

- Node.js `>= 26`.
- `npm`.
- `jq` for hook delivery.
- At least one companion runtime:
  - OpenCode on `PATH`, or `OPENCODE_BIN=/absolute/path/to/opencode`.
  - GitHub Copilot CLI on `PATH`, or `COPILOT_BIN=/absolute/path/to/copilot`.
  - Google's Antigravity ACP server, installed by
    `node scripts/install-antigravity-acp.mjs` (or
    `ANTIGRAVITY_ACP_BIN=/absolute/path/to/agy_acp_server.par`) and signed in
    with `--login`.
  - Codex CLI on `PATH`, or `CODEX_BIN=/absolute/path/to/codex`, authenticated
    via `codex login` (ChatGPT plan) or an API key.
  - Claude Code `claude` on `PATH`, or `CLAUDE_BIN=/absolute/path/to/claude`,
    signed in with the user's own Claude account or configured with
    `ANTHROPIC_API_KEY`.
- Claude Code CLI when installing the Claude surface.
- Codex CLI when installing the Codex surface.

OpenCode authentication and provider setup stays inside OpenCode. Copilot
authentication stays inside Copilot CLI. Codex authentication stays inside
Codex CLI. Claude authentication stays inside Claude Code. Antigravity
authentication stays inside Google's ACP server and the login keychain. Agent Companion does not ask for or store provider secrets.

## Fast Path

From the repository root, preview setup or pick the harness surface you use:

```bash
# Detect installed harnesses and preview changes without installing anything.
bash setup.sh --dry-run

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

# Codex host, Claude Code companion default.
bash setup.sh --host codex --target claude

# Pin Haiku for the Claude Code companion on the Codex host.
bash setup.sh --host codex --target claude --model haiku

# Claude Code host, separate Claude Code companion default.
bash setup.sh --host claude --target claude

# Persist Claude as the default companion for Codex state.
AGENT_COMPANION_HOST=codex node scripts/onboard.mjs --target claude --set-default

# Harness/plugin surface only. Keep any existing companion configuration.
bash setup.sh --host both --target none
```

Without `--host`, setup detects the installed CLI. If both are installed, it
asks which to use in a terminal; non-interactive runs must pass `--host`.
Without `--target`, existing target and model defaults are preserved.
On a clean install, the only ready companion is selected; multiple or zero ready
companions require a choice (or `--target none` to attach one later).

`setup.sh --host both --target auto` selects the only ready target for both
hosts explicitly. If multiple targets are ready, pass the target explicitly.
`--target none` leaves existing configuration untouched; it does not clear a default.

Setup checks prerequisites and companion readiness before installation and
shows the intended changes. Interactive runs confirm that plan; `--yes` skips
confirmation. Explicit flags also work without a terminal. `--dry-run` applies
nothing. No setup path runs a quota-spending companion task.

A new default is saved after installation and checks pass. A missing binary or
authentication blocks the change unless `--no-target-check` explicitly defers
readiness. An environment override that would mask the new target is explained
instead of silently replaced.

If installation stops partway, setup lists completed stages and keeps the
previous companion configuration. Fix the reported error and rerun the same
command; completed installation steps are safe to repeat. A failure while
configuring the second harness can leave the first harness configured, and the
status shows each separately. User-owned agent files are preserved and require
manual reconciliation. The final status distinguishes installation from live
delegation verification and names the required fresh session/hook approval.

## Onboarding Commands

Inspect companions with `node scripts/onboard.mjs --list-targets`;
see [Diagnostics](#diagnostics) for readiness checks. The subagent's catalog
also reports model configuration and capability limits.

For the full flag reference, run `node scripts/onboard.mjs --help`. `--plan --json` previews
selection and readiness without writes; `--smoke` explicitly opts into a real
companion task that can spend quota.

For standalone host-specific writes, set `AGENT_COMPANION_HOST=codex` or
`AGENT_COMPANION_HOST=claude` on the command. `setup.sh` does this for each
host when it delegates to onboarding.

An ordinary onboarding rerun preserves existing configuration unless `--target`
explicitly selects a change. Readiness failure leaves the default untouched;
`--no-target-check` can defer readiness, but a failed requested smoke never
persists a new default. Codex smoke requires a completed assistant response
matching `ready`, not just a successful CLI exit.

`AGENT_COMPANION_DEFAULT_TARGET` overrides the persisted `default-target`.
If `agent_send` omits `target` and no default is configured, the bridge returns
`TARGET_UNCONFIGURED`. Onboarding saves per-companion model defaults in
`default-model` (Copilot) or `default-model-<companion>` files. The model env
knobs listed under Configuration override these files where the host passes them.
A request can supply an explicit model override;
otherwise the companion uses its configuration. Legacy configuration migration
is described in [Architecture — State](docs/ARCHITECTURE.md#state).

## Install For Claude Code

This repo is its own marketplace. Register it once, from GitHub or from a
local checkout path, then install the plugin:

```bash
claude plugin marketplace add thangaram611/agent-companion   # or /path/to/agent-companion
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

The materialized agent references the session-scoped plugin server by name.
The installer qualifies it to `plugin:agent-companion:agent-bridge` and tool
names to `mcp__plugin_agent-companion_agent-bridge__*`.

For MCP timeout configuration and the host idle watchdog, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), "Host budgets".

### Claude Permissions

These are host permissions for bridge tools, separate from the Claude companion
permission modes described above. The subagent needs permission to call the
split MCP tools. Source checkout setup does this idempotently:

```bash
node scripts/install-permissions.mjs --host claude --yes
```

Marketplace installs can also approve the first prompt with "Yes, don't ask
again". The permission installer owns the allow-list.

Use `.claude/settings.local.json` if you want these permissions scoped to one
repository.

### One agent-companion, one companion conversation

Each spawned `agent-companion` is one conversation with the companion. To
continue it — a follow-up, or the answer to a question the companion asked —
main sends the same agent-companion a message (`SendMessage` on Claude Code,
`followup_task` on Codex); to start fresh, it spawns a new one. Neither main nor
the subagent carries a thread: the host names it after the calling agent.
Claude Code shows a subagent's `agent_id` only to hooks, so the plugin's
`PreToolUse` hook (`hooks/name-thread.sh`) overwrites `thread` on
send/wait/reply/cancel; Codex sends the caller's own thread id in MCP `_meta`, which the
bridge reads. A send that reaches the bridge with neither is refused. Measured
on [Claude Code 2.1.318](probes/host-qualification/claude/REPORT-2026-11-05.md)
and [codex-cli 0.166.0](probes/host-qualification/codex/REPORT-2026-11-05.md):
separate children have separate owners and same-child resume preserves identity.
The earlier Claude 2.1.310 measurement required no experimental SendMessage flag.

## Install For Codex CLI

The one-step source install is recommended:

```bash
bash setup.sh --host codex
```

It builds the local marketplace, registers it, atomically refreshes the
installed plugin even at the same version, verifies the effective MCP registry,
and eagerly materializes the custom agent before reporting success. Start a
fresh Codex session after it finishes.

For package/release debugging, the underlying marketplace commands are:

```bash
node scripts/build-codex-marketplace.mjs --out dist/codex-marketplace
codex plugin marketplace add ./dist/codex-marketplace
codex plugin add agent-companion@agent-companion --json
```

On a completely clean manual install, the first new session loads the plugin
and its SessionStart hook materializes the custom agent after role discovery;
open one further session before delegating. `setup.sh` avoids that two-session
bootstrap by materializing the role eagerly.

Validate the package end to end in an isolated `CODEX_HOME`:

```bash
node scripts/validate-codex-release.mjs
```

The generated package registers `agent-bridge` and the lifecycle hooks at
Codex plugin scope. Its `/bin/bash` launcher resolves Node and installs bridge
dependencies without relying on the GUI process's `PATH`. It has no root
`.mcp.json`, so the Codex registration is not discovered by Claude.

Codex normalizes the raw server id for its model-visible tool namespace:
`agent-bridge` becomes `mcp__agent_bridge__agent_*`. The Codex role uses that
underscore form through Codex's `functions.exec` deferred-tool wrapper; Claude
uses installed `mcp__plugin_agent-companion_agent-bridge__agent_*` names.
The plugin declares its internal bridge tools pre-approved so they remain
usable in headless `codex exec` sessions whose approval policy is `never`.
A user or managed plugin policy can still tighten that approval mode.

Current Codex intentionally prevents an agent role from adding MCP authority.
The custom TOML role therefore contains behavior only; it inherits the bridge
registered by `.codex-plugin/plugin.json`. That registration is technically
visible to main Codex as well as the child. Delegated work goes through the
`agent-companion` subagent. The ownerless catalog can be read for discovery.

The materialized role lives at:

```text
~/.codex/agents/agent-companion.toml
```

It uses plugin-scoped hooks. If an older source install left managed entries in
`$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`), setup removes only
entries carrying `_managed_by: "agent-companion"` so events are not delivered
twice. The cleanup can also be run directly with:

```bash
node scripts/install-codex-hooks.mjs --plugin-root "$(pwd)" --uninstall --yes
```

Codex V1 `multi_agent` surfaces the terminal subagent message on the next parent
turn. If a job has finished and main Codex has not resumed, send a short prompt
such as `any updates?`.

## Internal MCP Surface

The parent talks to the subagent in plain language. These tools are its private
transport; the parent needs no dispatch schema. The catalog is ownerless and
read-only. Execution and continuation belong to the subagent.

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `agent_catalog` | none | Enabled companions, default, model configuration, effort selection/levels, resolved permission (mode, source, risk), capabilities, readiness and last checked version. No job hydration, state writes or session creation. |
| `agent_send` | `task`, `cwd`; optional `target`, `model`, `effort`, `max_wait_sec` | Send the child's exact message to one companion. |
| `agent_wait` | `job_id`, `max_wait_sec` | Wait for a terminal result, user intervention notice, or the budget to elapse. |
| `agent_status` | optional `job_id`, `verbose`, `diagnostics` | Observe records and per-mode `interventions` availability; diagnostics includes cached target checks. |
| `agent_reply` | `job_id`, `message`; optional `mode` (`steer`, `queue`, `interrupt`) | Send in the requested mode, or the execution's default when omitted. Message limit: 8000 characters. |
| `agent_cancel` | `job_id` | Cancel the named job. |

Every send requires an absolute existing repo/worktree `cwd`. The host supplies
conversation identity as described in
[One agent-companion, one companion conversation](#one-agent-companion-one-companion-conversation).
Omitting `target` uses the configured default. Omitting `model` uses the
companion's configuration. Refusals are `TARGET_UNCONFIGURED`,
`TARGET_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE`, `MODEL_NOT_ALLOWED` and `EFFORT_NOT_ALLOWED`; the
subagent relays them and stops instead of changing the request to get around them.

Name effort naturally, for example "use Claude with low effort". All five
companions accept `effort`. Claude accepts `low`, `medium`, `high`, `xhigh`, `max`;
Copilot validates per-model levels from its ACP `thought_level` option before
writing `session/set_config_option`, then confirms the reported value. Its CLI
enum is not a model capability list. Codex catalog models, OpenCode and Antigravity
also validate offered levels before delivery. Codex uses thread config, OpenCode uses an advertised
model variant, and Antigravity uses an advertised model id with a level suffix.
For OpenCode and Antigravity, effort chooses the level even if the model string
names a different variant or suffix; selected and effective models show the result.
Invalid levels return `EFFORT_NOT_ALLOWED` with the offered levels or an
omit-effort hint. A selection confirmation mismatch returns
`CAPABILITY_UNAVAILABLE`; transport and history failures remain separate.
For Codex, **levels are unverified for models outside Codex's catalog**: the bridge
passes effort, requires matching `reasoningEffort`, and lets the backend reject bad
vocabulary with its own error message. On resume without a model override it still
reads the saved model before writing config. An unlisted model's effort can persist
on resume before the backend validates it during the turn.

Omission inherits native configuration; Copilot reports the session option's
`currentValue`, including when inherited. Its BYOK path is testable against local
Ollama; qualification against GitHub-hosted models remains blocked by this account's
`session/new` 403. Accepted effort
is stored for the conversation: omitted follow-ups keep the override where cold
follow-up is supported, and explicit effort can change after completion. Refused
effort leaves the previous effort override or inheritance intact. There is no
saved effort default or new environment knob.

`agent_send` returns `still_running` with a `job_id` after delivery acknowledgement.
It includes `target`, `selected_model`, `selected_effort`, `effective_model`,
`effective_effort` and `permission_mode`. Selected fields are overrides; effective
fields reflect provider reports and are null when unknown. Claude reports its
model at init but does not report effective effort. Copilot reports its advertised
thought level. OpenCode queries variants only for an effort override, then derives
effective effort from the reported variant settings; inheritance leaves it null.
Antigravity derives effort from the reported model’s advertised level suffix. Catalog permissions use the
same resolver as launch and onboarding diagnostics. Per-job status also includes
`selected_effort`, `permission_mode` and `activity`: Claude can report `thinking`,
`responding`, `running <command>` or `retrying`; other companions fall back to
command/text activity. Thinking content is never included, and terminal activity is null. An identical
retry on the same in-flight job reattaches to its delivery acknowledgement.
The controller compares text/model/effort after checking provider and canonical cwd. A different task,
model or effort on a busy conversation returns `thread_busy`; target and cwd conflicts
have their own mismatch errors. `provider_mismatch` names the bound companion
and cwd and tells the parent to spawn a new agent-companion for the requested
companion. `cwd_mismatch` names the bound path and offers that path or a new
agent-companion for the other repo. Wait, cancel, or use `agent_reply` in an
available mode. `agent_status.interventions` contains `default` (the job's preferred
mode, or null), and `steer`, `queue`, `interrupt` booleans describing availability
now. After close all three are false. Refusals preserve `state` or `capability`;
an unsupported mode is never replaced with another one.
`agent_wait` defaults to 480 seconds and is
capped at 1200 seconds per call. The subagent reuses the chosen budget; new
parent messages are visible between waits.

An accepted user message returns the owner's pending wait immediately with
`status: user_intervened` and `intervention: { from: 'user', mode, text, at }`.
`at` is the controller's acceptance time in epoch milliseconds. It carries no
answer (`content`) or terminal metadata. Each notice is reported once, with a
durable receipt; messages accepted between waits are returned by the next wait
before any terminal answer. Both roles relay the notice in one line and keep
waiting. User cancel is a normal terminal result with cause `user_cancel`.

User requests use the owning host's state inbox:
`inbox/<executionId>/<requestId>.json`, written atomically with mode 0600, holding
`{ requestId, executionId, mode, text, at }`. Cancel uses mode `cancel` and no text.
The controller reads live executions' inboxes on its tick, after owner stop and
lease checks. Only regular files are read, at most 64 KiB of JSON and 8000 text
characters. It writes `<requestId>.outcome.json` atomically with mode 0600:
`{ requestId, ok, status, reason?, interventionId? }`, then removes the request.
The view removes outcomes after reading; execution close removes the whole inbox,
including requests left behind. Rejected input reports its reason; input for an
execution not live in that bridge reports `state`. User input never renews the
owner lease. The saved execution's `interventionModes` snapshots its adapter's
capabilities for the view.

Terminal envelope statuses are `completed`, `failed` and `cancelled`; durable
results distinguish `completed`, `failed`, `interrupted`, `stopped` and
`delivery_unknown`. Metadata includes cause, native references and stop evidence.
When messages exist, `meta.interventions` adds `{ from, mode, state, first_line }`
for each, with the first line capped at 80 characters. The subagent reports
`not_delivered` messages. A job lists each native turn's answer once; a failed
turn ends the job and leaves remaining input undelivered.
Failures carry the provider's explanation in `content` (status: `partial_text`),
after any partial answer and a blank line. The explanation is one line, capped at
500 characters; error data, headers and response bodies are excluded. Failure
codes in `detail` are unchanged, including failures before delivery acknowledgement.
A missing delivery acknowledgement is never retried automatically. Read the
actual result; protocol completion alone does not prove a requested test ran.

## Usage

Metered jobs carry `usage` on terminal metadata, wait/status responses, the
result records and digests. Missing counters are `null`; a job with no reported usage
has no `usage` key. Transport readers and the shared shape are defined in
`lib/usage.mjs`.

Codex app-server follow-ups report the current turn's usage, not the thread's
cumulative total. Bridge loss ends that execution; a replacement never resumes
an in-flight turn. Missing native counters remain absent.
Copilot uses native prompt counters when available and falls back to OTEL;
`usage_update` measures context occupancy, not turn tokens. Antigravity's ACP
surface reports no usage (measured on 1.1.1). OpenCode reports tokens and cost
from its native events. Claude Code uses per-turn `result.usage` counters;
`modelUsage` and `total_cost_usd` include restored history. Cost is therefore
reported only for fresh history, and a reported cost does not establish a bill.

## Runtime State And Digests

Per-host state lives under:

```text
~/.claude/agent-companion/
~/.codex/agent-companion/
```

`AGENT_COMPANION_HOME` overrides the state home; `CODEX_HOME` relocates Codex.
`conversations/`, `executions/`, `leases/` and immutable `results/` hold ownership,
history references, progress and verified cleanup evidence. `stops/` carries
advisory owner-stop markers; `completions/` holds per-execution publication
receipts. `inbox/` holds user requests and outcomes; `intervention-notices/` holds
the caller's durable notice receipts. The hook queue is `runtime/completions.jsonl`. Legacy history/configuration
is migrated once, preserving native ids and refusing ambiguous mappings.

Logs live under `runtime/`; the structured event log retains the
historical filename `daemon.log` at the state root. It does not imply a running
service. See [State](docs/ARCHITECTURE.md#state) for record and recovery rules.

The bridge renders `agent-digest://<executionId>` on demand from the execution
and result records plus the companion's own native transcript. It includes the
request, models, effort, status, timestamps, final or partial answer, work summary
and that turn's transcript items in order. Preamble is collapsed to a count;
each item's output is capped at about 2 KB, with the native transcript path for
the rest. Running reads include the in-flight progress line. Missing or
unrecognized transcripts are explicitly labelled. Resources are listed from
execution records. Reads write nothing and never renew the owner's lease.
Existing files under `runtime/digests/` are left alone and are no longer written.

Results carry `workSummary`, exposed as `meta.work_summary` on terminal envelopes.
Both host roles relay its non-empty parts after the answer: failed commands with
exit codes and the total command count, transcript-reported edits, native errors,
transcript gaps, and the worktree diff-stat labelled as including any writer
between turn start and end. Omitted counts stay explicit. The `meta.digest_uri`
and result resource link remain the pointer to the full transcript view.

## Live View

`agent-companion ui` opens a terminal view of companion jobs from both hosts'
state directories: running jobs first, then the last 24 hours.
`setup.sh` installs the `agent-companion` launcher in `~/.local/bin`; it runs
this checkout's `hooks/launch-ui.sh` with the Node 26 the hooks resolve. When
`~/.local/bin` is not on `PATH`, setup prints the line to add; until then run
`~/.local/bin/agent-companion ui`, or `bash hooks/launch-ui.sh ui` from the
checkout. Its dependencies (Ink, React) install with the bridge's.

Each job card shows the caller's own title for the job (on Claude, the
description the lead gave its agent-companion subagent; on Codex, the
subagent's task name), otherwise the task's first line, then the companion and
project. The selected job's header adds only the host and lead session, model
and effort, tokens (finished jobs) and branch. Below it is that job's turn from
the companion's own native transcript, followed as it grows, with the
in-flight activity from the execution record as the last line. A finished job
opens on its outcome: result, git change list, errors and answer. Command and
tool output is folded to its first and last lines; the preamble is hidden.
In the transcript, `task` is the lead's request, `lead` its later messages and
`you` yours. Under 110 columns one pane shows at a time.

A running job's pane ends in a message box, as in the companion's own app, and
opening the job focuses it. `Enter` sends the draft in the mode shown under the
box, which starts on the companion's own default: `steer` joins the running
turn, `queue` runs after it, and `interrupt` stops the turn, then sends. Only
the modes that job's companion supports are offered; Copilot offers cancel
only. A sent message waits between the live line and the box with its state
(waiting for the bridge, queued, joined) until the companion's transcript shows
it. A refusal shows once in red with its reason, and the text returns to an
empty box. The lead learns of each message or cancel at once. Ended jobs have
no box; a running job started by an older bridge shows a one-line hint instead.

The view's only writes are those messages and cancels: one 0600 request file
per send in the owning host's state directory, under
`inbox/<executionId>/`, and the deletion of each outcome file it has read. It
renews no lease and starts no work. Drafts stay in memory.

On the job list and on ended jobs:

| Key | Action |
| --- | --- |
| `↑` `↓`, `j` `k` | Select a job; in the transcript, move between items |
| `Enter`, `Tab`, `Esc` | Open or focus the job (a running job's message box); back to the list |
| `PgUp` `PgDn`, `Space` | Scroll the transcript a page |
| `g`, `G` | Transcript top; bottom, following new items |
| `e`, `E` | Expand the current item; all items |
| `p` | Show the preamble (system and instruction text) |
| `f` | Follow new items on or off |
| `/` | Filter jobs (`Enter` keeps, `Esc` clears) |
| `o` | Show jobs older than 24 hours |
| `?`, `q`, `Ctrl+C` | Keys; quit |

In a running job's message box:

| Key | Action |
| --- | --- |
| Typing, `Enter` | Write; send in the shown mode |
| `Shift+Tab` | Next mode the companion supports |
| `Ctrl+J` | New line (also `Shift+Enter` or `Alt+Enter` where the terminal tells them apart) |
| `↑` `↓`, `PgUp` `PgDn` | Scroll the transcript; scrolling back to the end follows again |
| `Ctrl+O` | Expand or fold all outputs |
| `Ctrl+X` | Cancel the job, after one `y`/`n` confirmation |
| `Esc` | Back to the list; the draft is kept |
| `Ctrl+C` | Clear the draft; on an empty box, quit |

### In Claude Code's agent list

The plugin also carries a Claude Code mod, `hooks/mod.ts` (Codex ignores it).
Each agent-companion subagent's row in the agent list under the prompt shows
its job: the lead's title for it, the companion and model, what the companion
is doing (the running command, responding, your queued message, retrying) and
the elapsed time; once the job ends, its outcome and duration. The rows refresh
every second while a job runs, from the same execution records, and the mod
writes nothing. Other subagents' rows stay as Claude Code draws them.

The mod also opens a **Companions** pane when a companion job starts (on
terminals from 144 columns; `/companion` opens it at any width and gives it
the keys). With the main conversation in view it lists this session's jobs as
cards, running first, then the nine newest, the older ones counted; the list
is read again from the execution records at the session's start (a resumed
session included) and at each open. Pick a card to switch to its subagent's
view; where Claude Code cannot show that subagent (a resumed session has none
of its earlier ones), the pane shows the job itself. With a companion subagent
in view the pane shows that job read-only, as the live view's job pane does:
its turn from the companion's own transcript, pending messages and the live
line, or the outcome once it ended. `← jobs` goes back. The list and the
transcript come from small Node children (`launch-ui.sh jobs`, and
`launch-ui.sh follow` per shown job, ended when the view or the job changes).

From the keyboard, `ctrl+x tab` gives the pane the keys, with the first card
(or `← jobs`) under the focus ring, where each switch between the list and a
job puts it again; Tab and the arrows move it, Enter presses, Esc hands the
keys back. While the pane holds them:

| Key | Action |
| --- | --- |
| `1`–`9` | Open that card's job |
| `b` | `← jobs`: back to the list |

## Diagnostics

```bash
node scripts/doctor.mjs
node scripts/doctor.mjs --json
```

Doctor checks common prerequisites, target readiness and the selected Codex
executable/helper installation, including quarantine evidence. It does not start
model work or remove quarantine. There is no persistent provider process to
compare against the selected installation.

Catalog's Codex entry and `agent_status` expose the advisory contract status as
`contractStatus: match|drift|unverified` (the shipped field name). The adapter
checks the schema once per bridge when Codex starts; catalog/status do not run
that probe. Diagnostics on status reads cached target checks. Execution status
includes lease, last native activity, active command, retry state, partial text,
selected/effective model, native refs and stop evidence.

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
omitting `test/` skips cross-cutting checks such as the sync-exec timeout guard
and the runtime sandbox guard.

The live view's performance gate, `bridge-server/ui/perf.test.mjs`, runs with
the suite: appending, scrolling, typing in the message box, resizing and
expand/collapse are timed at a ~500-item transcript and again at 10,000 items in
the same run. It fails when appending, scrolling or typing gets more than three
times slower at the larger size, or when expand-all or resize grows faster than
the transcript, so machine speed and coverage do not decide it. Measurements are
in the test and in
[docs/LIVE_VIEW_PLAN.md](docs/LIVE_VIEW_PLAN.md#step-2-read-only-terminal-ui).
Its headless snapshots are `bridge-server/ui/ui.test.mjs.snapshot`; after an
intended change, regenerate them with `node --test --test-update-snapshots
bridge-server/ui/ui.test.mjs` and review the diff.

README images are generated bitmaps. Their specifications live in
[assets/readme/PROMPTS.md](assets/readme/PROMPTS.md); regenerate from those
prompts (Codex's `imagegen` skill produced the current set) and check every
label before committing. CI checks only that the files exist.

Validate Claude packaging with `claude plugin validate .` and run the mod's
tests with `claude plugin test .`; Codex packaging and
isolated validation commands are in [Install For Codex CLI](#install-for-codex-cli).

Current live probes are listed in [probes/README.md](probes/README.md):
`smoke.mjs`, `orphan.mjs`, `acp-antigravity.mjs`, and the two host-qualification
harnesses. Live probes spend quota and are separate from the root test suite.

## Design Invariants

- The parent delegates in plain language to a native `agent-companion` child.
  The companion does the work; the child relays answers and actual failures.
- Both hosts register the bridge at plugin/session scope. Execution calls require
  the host-supplied native child owner; catalog and status are ownerless reads.
- One controller owns each execution and one cold provider process group per
  answer. Provider processes and protocol connections are never shared by children.
- Pending owner calls hold a lease; gaps consume configurable grace. Stop markers
  and attributed cancellation close the owner. Observers cannot renew its lease.
- Bridge loss hands recorded trees to the cleanup watcher. It terminates and
  verifies them, keeps native history and writes a fenced immutable result.
  A replacement never adopts live work; subsequent answers cold-resume history.
- Delivery is acknowledged once and is never automatically resent after an
  ambiguous failure. Busy matching sends reattach; different work is refused.
- Results are immutable and generation-fenced. Completion publication is keyed
  by execution id, and hooks drain the session-tagged queue. Every wait is bounded.
- Companion/model choices are honoured and text is delivered verbatim. Missing
  history and unsupported follow-up fail explicitly, with no silent substitute.
- Node dependencies persist under plugin data. Claude reaches them through a
  `bridge-server/node_modules` link; Codex's launcher resolves them from plugin
  data because its plugin bundles cannot contain symlinks.

## License

MIT. See [LICENSE](LICENSE).
