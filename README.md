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

Ask the model in your harness (the **lead**) to give a companion a task in an
absolute repo or worktree path. Name a companion, model or effort if you have a
preference. The lead sends the task directly and gets a thread id back. Use the
same thread for follow-ups or start a new one for independent work.

- **Bring your harness.** Install the Claude Code surface, the Codex CLI surface, or both.
- **Choose a companion.** Ask which companions and models are available. The
  catalog reports capabilities, configuration and last-checked readiness.
- **Keep working.** The lead can end its turn. The bridge keeps the job running
  and attempts to wake that conversation when the job ends.
- **Keep failures explicit.** A refused companion, model or effort comes back
  with the reason.

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

1. Ask, for example, “Have Codex review the changes in /absolute/path/to/repo.
   Keep it read-only and explain any bugs with file references.”
2. The lead calls `agent_send` with the task and absolute `cwd`. The companion
   sees the task verbatim, so the lead includes the context and constraints it needs.
3. The send returns a thread id, a job id and how the result will arrive. The
   lead can carry on, end its turn or call `agent_wait`.
4. When the job ends, the bridge can wake Claude Code through the session's inbox
   socket or Codex through `codex queue`. The hook delivers the result on session
   start, the next prompt (including the wake), or after a tool call. For a long
   answer the lead follows the reference with `agent_read`.
5. To continue the review or answer a question, the lead sends to the same
   thread. New text sent while the job runs is an intervention.

The catalog lists enabled companions, the default companion, capabilities, readiness and
the installed version seen at the last check. Each companion's `model.saved` and
`effort.saved` show its `settings.json` values, or null. `model.model` and `model.source`
show which bridge default applies after any model environment override. Each field's
`last_run` gives the last reported value across both hosts, its start time, age and
host, or null if no run reported it. The catalog starts no processes and writes no
state. A model list that needs a session is reported as "not enumerable without a session".
Each target's `capabilities.interventions` contains `{ default, steer, queue, interrupt }`:
`default` is a mode or null; `steer` and `interrupt` are booleans; `queue` is
`false`, `bridge` or `native`. These registry capabilities describe support;
`agent_status.interventions` reports which modes are usable on a job now.

The lead calls its session's bridge directly. Each job runs its own companion
process. [Current architecture](docs/ARCHITECTURE.md#flow)

<details>
<summary>Earlier subagent design (recording and diagram)</summary>

![Claude Code receiving a Codex answer through the earlier subagent](assets/readme/demo.gif)

![Retired subagent architecture](assets/readme/architecture.png)

</details>

## Supported Companions

![Companion capabilities](assets/readme/target-matrix.png)

The image shows an earlier release. The table lists the current capabilities.

| Companion | Per-job runtime | Follow-up by cold resume | In-flight messages (default first) | Model selection | History |
| --- | --- | --- | --- | --- | --- |
| OpenCode 2.x | Private authenticated `opencode serve` | Saved session | Steer, queue, interrupt | `provider/model`, optional variant | Vendor-persisted session |
| GitHub Copilot CLI | `copilot --acp` | Unsupported until qualified | Unsupported | Inherit or select a model advertised by the session | Session id retained; cold load unqualified |
| Codex CLI | `codex app-server` | `thread/resume` | Steer, queue, interrupt | Inherit or explicit override | Native thread and rollouts |
| Google Antigravity | `agy acp` over stdio | `session/load` with history replay | Steer, queue, interrupt | Session model and thought level after new/load | Native SQLite history |
| Claude Code | `claude -p` | `--resume` saved session | Queue, interrupt | Inherit or explicit override | Native transcripts |

All support send, wait, status and cancel. Every job starts in a new process;
accepted messages can continue it through several turns on the same live session.
There is no shared provider runtime or adapter-selection setting. Copilot
follow-ups return `FOLLOWUP_UNSUPPORTED` until cold loading is qualified.
An intervention through `agent_send` returns `intervention_unavailable` with reason `state` or `capability`
when the requested mode is unavailable; it never substitutes a mode.
Bridge loss stops the owned tree through the cleanup watcher and keeps native
history; in-flight work does not survive bridge replacement. The next message
to the same thread resumes saved history where supported. An unavailable history fails explicitly.

Configuration:

- Each wait is bounded. Ending the lead's turn or cancelling a wait leaves the
  job running. It ends on completion, failure, explicit cancel or bridge loss.
- Both hosts share target, model and effort defaults in
  `${XDG_CONFIG_HOME:-$HOME/.config}/agent-companion/settings.json`.
  With `AGENT_COMPANION_HOME` set, the file is `$AGENT_COMPANION_HOME/settings.json`.
  Each companion's saved effort is `companions.<id>.effort`.
  `AGENT_COMPANION_DEFAULT_TARGET` overrides its target. Inspect and change them
  with `agent-companion defaults` ([Defaults](#defaults)) or the live view's `d` panel.
- Save a per-companion model default with
  `node scripts/onboard.mjs --target <companion> --model <id> --set-default`.
  Setup accepts the same choice through
  `bash setup.sh --host <host> --target <companion> --model <id>`.
  `--model inherit` clears the saved default. `AGENT_COMPANION_CODEX_MODEL`,
  `AGENT_COMPANION_OPENCODE_MODEL` and `AGENT_COMPANION_CLAUDE_MODEL` override
  saved defaults where the host passes them (Claude host). An explicit request
  overrides the default for a new conversation. Follow-ups keep their selection.
- Copilot checks a saved or requested model when it opens a session. The bridge
  confirms the selected model before sending the task. A refusal lists the
  models the session offered. The bundled Copilot reviewer inherits the session model.
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
- Install Antigravity with `brew install --cask antigravity-cli`. Sign in with
  `agy acp --login` in a terminal or start one interactive `agy` session.
  Without a login, `session/new` returns -32000 "Authentication required" and
  the bridge reports `AUTH_REQUIRED`. Set `ANTIGRAVITY_BIN` to override `agy`.
  It replaces `ANTIGRAVITY_ACP_BIN`. The CLI keeps its default profile and
  conversations under `~/.gemini/antigravity-cli/`. On macOS, sign-in leaves
  a keychain item with service `gemini` and account `antigravity`.
  The old `.par` installer, `scripts/install-antigravity-acp.mjs`, was removed.
  Sign in again after migrating. Start a new conversation because the CLI
  cannot continue histories in `~/.gemini/antigravity-acp/`.
- `AGENT_COMPANION_ANTIGRAVITY_PERMISSION` defaults to `all`, which launches
  `agy acp --dangerously-skip-permissions`. With `edit` or `none`, the bridge
  answers the parent agent's requests, but a subagent can wait indefinitely
  for an approval the bridge never receives. Diagnostics mark both policies
  unready for unattended work. Google's FAQ names Claude Code among third-party
  software that must not use an Antigravity login. It calls wrapping `agy` in
  third-party agents unsupported on consumer plans. The account holder accepts
  the risk of suspension or termination. See [tracker item 8](docs/MVP_TRACKER.md).

See [Architecture](docs/ARCHITECTURE.md) for protocol and lifecycle details,
and [Diagnostics](#diagnostics) for installation problems.

### Defaults

```sh
agent-companion defaults                         # list saved values, sources and inheritance
agent-companion defaults codex --json            # inspect one companion
agent-companion defaults codex model=gpt-6.2-astra effort=high
agent-companion defaults codex effort=inherit    # clear effort, keep model
agent-companion defaults codex model=inherit
agent-companion defaults target=codex
agent-companion defaults target=inherit
```

Set either field or both. Every form accepts `--json`. For a new conversation,
the host's explicit choice wins, followed by the model environment override
(model only), the saved default, then the companion's own configuration.
Follow-ups keep the conversation’s selection.

Codex and OpenCode read native defaults for the current directory without a
turn. Claude, Copilot and Antigravity show what their last run reported and
how long ago it ran. If the two hosts have conflicting legacy defaults, the
listing shows both files and the command to resolve each conflict.

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
- `jq` for source-checkout setup.
- At least one companion runtime:
  - OpenCode on `PATH`, or `OPENCODE_BIN=/absolute/path/to/opencode`.
  - GitHub Copilot CLI on `PATH`, or `COPILOT_BIN=/absolute/path/to/copilot`.
  - Antigravity CLI on `PATH`, or `ANTIGRAVITY_BIN=/absolute/path/to/agy`,
    signed in with `agy acp --login`.
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
authentication stays inside Google's CLI. Agent Companion does not ask for or
store provider secrets.

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

# Save a default target for both hosts.
node scripts/onboard.mjs --target opencode --set-default
```

For a narrower install:

```bash
# Codex only, OpenCode default.
bash setup.sh --host codex --target opencode

# Claude only, Copilot default.
bash setup.sh --host claude --target copilot

# Codex host, Claude Code companion default.
bash setup.sh --host codex --target claude

# Install on Codex and save Haiku as the shared Claude companion model.
bash setup.sh --host codex --target claude --model haiku

# Install on Claude Code and select its Claude Code companion.
bash setup.sh --host claude --target claude

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
status shows each separately. The final status distinguishes installation from live
delegation verification and names the required fresh session/hook approval.

## Onboarding Commands

Inspect companions with `node scripts/onboard.mjs --list-targets`;
see [Diagnostics](#diagnostics) for readiness checks. The bridge catalog
also reports model configuration and capability limits.

For the full flag reference, run `node scripts/onboard.mjs --help`. `--plan --json` previews
selection and readiness without writes; `--smoke` explicitly opts into a real
companion task that can spend quota.

An ordinary onboarding rerun preserves existing configuration unless `--target`
explicitly selects a change. Readiness failure leaves the default untouched;
`--no-target-check` can defer readiness, but a failed requested smoke never
persists a new default. Codex smoke requires a completed assistant response
matching `ready`, not just a successful CLI exit.

A new conversation with no requested or configured target returns
`TARGET_UNCONFIGURED`. Routing selects the requested model, the companion's
environment override, or its saved model, in that order. An omitted selection
inherits native configuration. On upgrade, matching per-host defaults migrate
once. Conflicts are logged and their files are kept for inspection.
See [Architecture — State](docs/ARCHITECTURE.md#state).

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

The plugin registers `agent-bridge` for the session. Start a fresh Claude Code
session after upgrading to load the new tools.

For MCP timeout configuration and the host idle watchdog, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), "Host budgets".

### Claude Permissions

These are host permissions for bridge tools, separate from the Claude companion
permission modes described above. The lead needs permission to call the
bridge tools. Source checkout setup does this idempotently:

```bash
node scripts/install-permissions.mjs --host claude --yes
```

Marketplace installs can also approve the first prompt with "Yes, don't ask
again". The permission installer owns the allow-list.

Use `.claude/settings.local.json` if you want these permissions scoped to one
repository.

### Thread lifecycle

| Event | What happens |
| --- | --- |
| The lead ends its turn | The job continues. The bridge can wake the lead when it finishes. |
| Esc, a cancelled wait, or a stopped background wait | The wait ends. The job keeps running. |
| Compaction | The conversation keeps its id. `agent_status` lists its threads again. |
| Claude Code `/clear` | Old jobs keep running and stay on the companion page. The new conversation does not list their threads or receive their wakes. |
| Codex `/new` or `/quit` | Codex keeps the conversation you left loaded until it has been idle for `thread_unload_delay_secs` (60 s by default). A job finishing then can wake it unseen, and the delay starts again. When Codex closes that conversation, a job still running ends in bridge loss. Resuming it delivers unread results at your first prompt. Its threads stay on the companion page. |
| Host session exits | Bridge loss stops the owned process trees and fences their results. |
| You or the lead cancel a job | The job stops. The thread stays available for a supported follow-up. |

## Install For Codex CLI

The one-step source install is recommended:

```bash
bash setup.sh --host codex
```

It builds the local marketplace, registers it, atomically refreshes the
installed plugin even at the same version and verifies the effective MCP registry.
Start a fresh Codex session and re-trust the updated hooks.

To change how long Codex keeps a conversation you left loaded, and with it the
bridge and its jobs, add `--codex-unload-delay <seconds>`; `default` removes the
setting. Codex's own config writer edits `~/.codex/config.toml`, keeping its
comments. A shorter delay means fewer wakes into a conversation nobody watches,
and a running job stops sooner after you leave; a longer one the reverse. Codex
reads it when its app-server daemon starts: run `codex app-server daemon restart`
(it stops running Codex work) or restart Codex.

For package/release debugging, the underlying marketplace commands are:

```bash
node scripts/build-codex-marketplace.mjs --out dist/codex-marketplace
codex plugin marketplace add ./dist/codex-marketplace
codex plugin add agent-companion@agent-companion --json
```

Validate the package end to end in an isolated `CODEX_HOME`:

```bash
node scripts/validate-codex-release.mjs
```

The generated package registers `agent-bridge` and the lifecycle hooks at
Codex plugin scope. Its `/bin/bash` launcher resolves Node and installs bridge
dependencies without relying on the GUI process's `PATH`. It has no root
`.mcp.json`, so the Codex registration is not discovered by Claude.

Codex normalizes the raw server id for its model-visible tool namespace:
`agent-bridge` becomes `mcp__agent_bridge__agent_*`. The Codex lead sees that
namespace through deferred tools. Claude uses installed `mcp__plugin_agent-companion_agent-bridge__agent_*` names.
The plugin declares its internal bridge tools pre-approved so they remain
usable in headless `codex exec` sessions whose approval policy is `never`.
A user or managed plugin policy can still tighten that approval mode.

If an older source install left managed entries in
`$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`), setup removes only
entries carrying `_managed_by: "agent-companion"` so events are not delivered
twice. The cleanup can also be run directly with:

```bash
node scripts/install-codex-hooks.mjs --plugin-root "$(pwd)" --uninstall --yes
```

## Internal MCP Surface

Both hosts give the lead the same six tools. The host identifies the caller.
The bridge checks that a thread belongs to that lead before acting on it.

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `agent_catalog` | none | List companions, defaults, capabilities and cached readiness. |
| `agent_send` | `task`, absolute `cwd` for a new thread or `thread` to continue. Optional `title`, `target`, `model`, `effort`, `mode`. | Start a job, resume saved history, or send new text to a running job. |
| `agent_wait` | `thread` or `job_id`, optional `max_wait_sec` | Wait for a result, a user intervention or the budget to elapse. |
| `agent_read` | `thread`, optional `after`, `offset`, `limit` | Read posts in order. Follow the next call in the footer to page a long answer. |
| `agent_status` | Optional `thread` or `job_id`, optional `diagnostics` | With no arguments, list this lead's threads, titles, states and unread counts. A reference selects one job. |
| `agent_cancel` | `thread` or `job_id` | Stop the job. |

A new thread needs an absolute existing directory. A follow-up inherits that
directory and companion. Omit `thread` to work in a different repo or with
another companion. A new thread uses the configured defaults for choices the
lead omits. If there is no target, the bridge returns `TARGET_UNCONFIGURED`.

Name effort naturally, for example "use Claude with low effort". All five
companions accept `effort`. Claude accepts `low`, `medium`, `high`, `xhigh`, `max`;
Copilot and Antigravity validate effort against the selected model's ACP
`thought_level` option, then confirm its `currentValue`. Antigravity reapplies
the requested model and effort after each load. Codex catalog models and
OpenCode also validate offered levels before delivery. Codex uses thread config.
OpenCode selects an advertised variant. An effort override takes precedence
over a variant in the model string.
Invalid levels return `EFFORT_NOT_ALLOWED` with the offered levels or an
omit-effort hint. An effort confirmation mismatch returns
`CAPABILITY_UNAVAILABLE`; transport and history failures remain separate.
For Codex, **levels are unverified for models outside Codex's catalog**: the bridge
passes effort, requires matching `reasoningEffort`, and lets the backend reject bad
vocabulary with its own error message. On resume without a model override it still
reads the saved model before writing config. An unlisted model's effort can persist
on resume before the backend validates it during the turn.

On a new conversation, an explicit effort wins. Omission uses the companion's
saved effort, then its native configuration. Copilot reports the session option's
`currentValue`, including when inherited. Its BYOK path is testable against local
Ollama; qualification against GitHub-hosted models remains blocked by this account's
`session/new` 403. Accepted effort
is stored for the conversation: omitted follow-ups keep the override where cold
follow-up is supported, and explicit effort can change after completion. Refused
effort leaves the previous effort override or inheritance intact.

`agent_send` returns `still_running` with `thread` and `job_id` as soon as
the provider acknowledges delivery. The `delivery` field names the wake adapter
or the reason none is armed, and lists `agent_wait` as the fallback.
The acknowledgement includes `target`, `selected_model`, `selected_effort`, `effective_model`,
`effective_effort` and `permission_mode`. Selected fields are overrides; effective
fields reflect provider reports and are null when unknown. Claude reports its
model at init but does not report effective effort. Copilot and Antigravity
report the session's thought level. OpenCode queries variants only for an effort
override and derives effective effort from the reported variant settings.
Inheritance leaves it null.
Catalog permissions use the same resolver as launch and onboarding diagnostics.
Per-job status also includes `selected_effort`, `permission_mode` and `activity`.
Claude can report `thinking`,
`responding`, `running <command>` or `retrying`; other companions fall back to
command/text activity. Thinking content is never included, and terminal activity is null.

An identical retry on a running thread returns the existing job.
New text (up to 8,000 characters) uses the job's default intervention mode or
the requested `steer`, `queue` or `interrupt`. Status reports which modes the
job accepts. Changing model or effort while it runs returns `thread_busy`.

A wake carries a short notice and a reference. The hook can include up to
4,000 characters of the answer or just its reference when several finish together. A terminal tool response includes up to 8,000
characters plus a second text block with metadata. `agent_read` defaults to
8,000 characters per page and accepts up to 40,000. Use the footer's exact
`after` and `offset` to continue. A native subagent that acts as a lead uses
`agent_wait`. Claude inbox wakes require Claude Code 2.1.228 or later. A relocated
`CODEX_HOME` gets no wake because the Codex bridge does not inherit that setting.

`agent_wait` defaults to 480 seconds and caps each call at 1,200. A message
you send from the companion page returns `user_intervened` on a pending or
subsequent wait. The lead can wait again for the answer. Cancelling
from the page produces a terminal result with cause `user_cancel`.

User requests use the owning host's state inbox:
`inbox/<executionId>/<requestId>.json`, written atomically with mode 0600, holding
`{ requestId, executionId, mode, text, at }`. Cancel uses mode `cancel` and no text.
The controller reads live executions' inboxes on its tick. Only regular files are read, at most 64 KiB of JSON and 8000 text
characters. It writes `<requestId>.outcome.json` atomically with mode 0600:
`{ requestId, ok, status, reason?, interventionId? }`, then removes the request.
The view removes outcomes after reading; execution close removes the whole inbox,
including requests left behind. Rejected input reports its reason; input for an
execution not live in that bridge reports `state`. The saved execution's `interventionModes` snapshots its adapter's
capabilities for the view.

Terminal envelope statuses are `completed`, `failed` and `cancelled`; durable
results distinguish `completed`, `failed`, `interrupted`, `stopped` and
`delivery_unknown`. Metadata includes cause, native references and stop evidence.
When messages exist, `meta.interventions` adds `{ from, mode, state, first_line }`
for each, with the first line capped at 80 characters. Undelivered messages are marked
`not_delivered`. A job lists each native turn's answer once; a failed
turn ends the job and leaves remaining input undelivered.
Failures carry the provider's explanation in the answer text (in `partial_text` on status),
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
`usage_update` measures context occupancy. Antigravity sums each prompt response's
input, output, cache read, cache write, thought and total tokens. As for other
companions, the bridge includes cache reads in input. If work continues after
`end_turn`, the later reply has no counters and usage is marked `partial`.
The measured upstream error returned no usage. OpenCode reports tokens and cost
from its native events. Claude Code uses per-turn `result.usage` counters;
`modelUsage` and `total_cost_usd` include restored history. Cost is therefore
reported only for fresh history, and a reported cost does not establish a bill.

## Runtime State And Digests

Per-host state lives under:

```text
~/.claude/agent-companion/
~/.codex/agent-companion/
```

`conversations/` holds each thread's lead, title, directory and native history
reference. `executions/` and immutable `results/` hold progress and outcomes.
A receipt beside each result records delivery by a tool or hook. `reads/` holds
paging cursors. The hook checks `runtime/news/` for pending results. Claude
checks `runtime/sessions/` before waking a lead. User requests
and outcomes live in `inbox/`, and wait notices in `intervention-notices/`.
See [State](docs/ARCHITECTURE.md#state) for path overrides.

Logs live under `runtime/` in `agent-bridge.log`. See [State](docs/ARCHITECTURE.md#state) for record and recovery rules.

The bridge renders `agent-digest://<executionId>` on demand from the execution
and result records plus the companion's own native transcript. It includes the
request, models, effort, status, timestamps, final or partial answer, work summary
and that turn's transcript items in order. Preamble is collapsed to a count;
each item's output is capped at about 2 KB, with the native transcript path for
the rest. Running reads include the in-flight progress line. Missing or
unrecognized transcripts are explicitly labelled. Resources are listed from
execution records. Digest reads write nothing.
Existing files under `runtime/digests/` are left alone and are no longer written.

Results carry `workSummary`, exposed as `meta.work_summary` on terminal envelopes.
It includes failed commands with
exit codes and the total command count, transcript-reported edits, native errors,
transcript gaps, and the worktree diff-stat labelled as including any writer
between turn start and end. Omitted counts stay explicit. `meta.digest_uri` points to the full transcript view.

## Live View

`agent-companion ui` opens a terminal view of companion jobs from both hosts'
state directories: running jobs first, then the last 24 hours.
`setup.sh` installs the `agent-companion` launcher in `~/.local/bin`; it runs
this checkout's `hooks/launch-ui.sh` with the Node 26 the hooks resolve. When
`~/.local/bin` is not on `PATH`, setup prints the line to add; until then run
`~/.local/bin/agent-companion ui`, or `bash hooks/launch-ui.sh ui` from the
checkout. Its dependencies (Ink, React) install with the bridge's.

Each job card shows the thread's title (the lead's `title` on send or the
first line of the task), the companion and the project. The selected job's
header adds the host and lead session, model
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
empty box. A wait reports accepted user messages. Cancelling produces a terminal result. Ended jobs have
no box; a running job started by an older bridge shows a one-line hint instead.

The view's job writes are those messages and cancels: one 0600 request file
per send in the owning host's state directory, under
`inbox/<executionId>/`, and the deletion of each outcome file it has read. Drafts stay in memory.

`d` opens the defaults panel: the default companion and each companion's model
and effort, saved or what inherit resolves to, as `agent-companion defaults`
shows them. `⏎` edits the selected value and `⏎` saves it through the same
command's checks; an empty value clears it to inherit, and a refusal keeps the
draft and says why. Saving is the view's only other write, to `settings.json`.

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

### In Claude Code

A band above the prompt lists running threads with their title, companion,
model, current activity and elapsed time. It disappears when no thread is
running.

Open `/companion` to see this session's threads as cards, running first. Pick
a card to open its latest job in the pane. You can follow the native transcript,
see the outcome or message a running companion in a supported mode. Enter sends
the message, `mode ▸` changes mode, and `cancel job` asks for confirmation.
Copilot accepts cancel only. Use `← jobs` to return to the cards.

From the keyboard, `ctrl+x tab` gives the pane the keys, with the first card
(or a running job's message box, else `← jobs`) under the focus ring, where
each switch between the list and a job puts it again; Tab and the arrows move it, Enter presses, Esc hands the
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
includes last native activity, active command, retry state, partial text,
selected/effective model, native refs and stop evidence.

Install markers:

```bash
cat ~/.claude/agent-companion/.host
cat ~/.codex/agent-companion/.host
```

Bridge startups are lines in the bridge log:

```bash
grep bridge.startup ~/.claude/agent-companion/runtime/agent-bridge.log
grep bridge.startup ~/.codex/agent-companion/runtime/agent-bridge.log
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

The README illustrations are generated bitmaps. Before regenerating them,
update the prompts for the current thread flow and companion matrix. CI checks
only that the files exist. [Image specifications](assets/readme/PROMPTS.md)

Validate Claude packaging with `claude plugin validate .` and run the mod's
tests with `claude plugin test .`; Codex packaging and
isolated validation commands are in [Install For Codex CLI](#install-for-codex-cli).

The [probe index](probes/README.md) lists the live harnesses. Recheck lead
identity, delivery and wake behavior after a host upgrade with the
[direct-lead probes](probes/direct-lead/README.md). Live probes can spend quota.

## Design Invariants

- The host identifies the lead. The bridge mints the thread id and checks it on
  follow-ups. Companions receive the lead's task verbatim.
- Each job owns a cold provider process group. Bridge loss hands the tree to
  the cleanup watcher for termination, verification and a fenced result.
- A job can outlast its lead's turn or a cancelled wait. Only an explicit
  cancel, a terminal outcome or bridge loss ends the job.
- An ambiguous delivery is never resent automatically. An identical busy send
  returns the original job. New text on a busy thread uses an intervention mode.
- A hook and a terminal tool call compete for one delivery receipt. The result
  stays available through `agent_read`.
- Node dependencies persist under plugin data. Claude reaches them through a
  `bridge-server/node_modules` link; Codex's launcher resolves them from plugin
  data because its plugin bundles cannot contain symlinks.

## License

MIT. See [LICENSE](LICENSE).
