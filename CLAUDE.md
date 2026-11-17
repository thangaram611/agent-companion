# CLAUDE.md

## What this is

A delegation plugin: a **harness** (Claude Code or Codex CLI) spawns an isolated
`agent-companion` subagent, which uses `agent-bridge` to run work on a **companion** runtime
(OpenCode, GitHub Copilot CLI, Codex CLI, Google Antigravity, or Claude Code).
The parent talks to the subagent in plain language (what to do, the absolute repo path, optionally which companion or
model); the subagent sends that text verbatim through the private `agent_*` tools and brings the
companion's answer back. Both hosts register the bridge at plugin/session scope;
execution calls require a native child owner. Claude attributes it through a hook;
Codex supplies subagent metadata. The install matrix is two CLI hosts × five
companions. Codex desktop remains unqualified.

Read `README.md` for the user-facing contract and `docs/ARCHITECTURE.md` before any non-trivial
change. `docs/ARCHITECTURE.md` carries a **Negative Results** section: things that look wrong
in this code but are deliberate because a measurement overturned the obvious design. Check it
before "fixing" something surprising.

## Commands

Use [README.md — Development](README.md#development) for checks, packaging and
README asset regeneration. Discover tests from the repo root: directory allowlists
can omit the three cross-cutting guards in `test/`. CI's command is in
`.github/workflows/ci.yml`.

Regenerate the pinned codex wire contract (the only sanctioned way that fixture changes; the
generator prints what moved, classified — read the `ROUTING MOVED` block first, a moved thread
id is a live misrouting bug). The fixture's `codexVersion` is provenance, not a gate: after a
codex upgrade the drift test and the adapter's advisory probe compare the live schema, so a
version-only bump stays green and only a real schema change fails the test — the adapter still
starts either way and reports `contractStatus: match|drift|unverified`, never refusing to serve:

```bash
node scripts/gen-codex-app-server-contract.mjs
```

After a Copilot CLI upgrade, re-record its ACP fixtures with
`node probes/acp-record/record-copilot.mjs` (local Ollama, isolated homes, $0;
see `probes/README.md`) and read the `test/fixtures/acp/copilot/` diff.

`probes/` are hand-run harnesses that can spend host or companion tokens and
write live runtime state. They are outside `node --test`; see `probes/README.md`.

## Architecture

**One controller owns each execution.** Each job starts a cold provider runtime
in its own process group and loops over native turns while accepted input remains.
The controller owns the process tree, native history
reference, lease and terminal result. Pending send/wait/reply/cancel calls hold
the owner's lease; gaps consume its grace. Stop markers supply explicit owner-stop
evidence. On SIGINT, SIGTERM or stdin EOF, the bridge hands the recorded tree to
`scripts/cleanup-watcher.mjs`, which terminates it and saves a fenced result.
In-flight survival across bridge replacement is deliberately given up. Native
history remains; a later message to the same native child resumes it cold.
Provider processes and protocol connections are never shared across children.
Uncatchable bridge SIGKILL cannot run the handoff; recovery refuses to adopt a
live or unverified tree.

**No silent fallback.** Target/model/effort refusals are `TARGET_UNCONFIGURED`,
`TARGET_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE`, `MODEL_NOT_ALLOWED` and `EFFORT_NOT_ALLOWED`.
ACP authentication refusals are `AUTH_REQUIRED`, with the descriptor's sign-in steps;
relay them as setup problems without retrying or switching companion. Ownership,
history and execution refusals are separate, including `NATIVE_OWNER_REQUIRED`
and `FOLLOWUP_UNSUPPORTED`. Both role templates relay failures without changing
the parent's choice. Omitted target uses the configured default; omitted model
inherits configuration unless the conversation already has an override. Effort is
a conversation override too, supported by all five companions. Claude has static
levels `low`, `medium`, `high`, `xhigh`, `max`; Copilot validates and confirms the
session model's ACP `thought_level` option, including reporting inherited effort.
Codex catalog models, OpenCode and Antigravity validate model-specific levels before delivery.
Codex levels are unverified for models outside Codex's catalog: it confirms the
reported effort and lets the backend validate vocabulary during the turn. Before writing any
selection on existing history, Codex reads its model, OpenCode reads its variants,
and Antigravity checks the loaded session's advertised model family. OpenCode
selects a variant; Antigravity selects a model id suffix and reapplies it after
load. In both, effort overrides any level embedded in the model string. OpenCode
queries variants only for an effort override; inherited effort stays null. Refused effort is not saved on the conversation or written to native
selection state. Omission inherits; no saved effort default exists. Copilot's
spawn effort flag is removed; the option is validated before a config write.
Local Ollama BYOK makes Copilot testable; GitHub-hosted model qualification still
hits this account's `session/new` 403. The isolated free-backend harness is in
`probes/free-backends/`; never use the operator's live homes for it.
Send acknowledgements expose target,
selected/effective model and effort, and
resolved permission mode; effective effort is null unless the provider reports it.
Status adds activity (thinking, responding, running a command or retrying for Claude)
without retaining thinking content. The bridge delivers task text verbatim.

**Conversation identity comes from the host.** Claude's `hooks/name-thread.sh`
unconditionally overwrites `thread` with the child's `agent_id` or clears it.
Codex requires `_meta["x-codex-turn-metadata"].thread_source: subagent` and uses
its `thread_id`. A fresh spawn starts independent work. An identical busy send
reattaches; different text, model or effort returns `thread_busy`, and provider/cwd
mismatches fail explicitly. Catalog and status are ownerless observers: they
neither start work nor renew leases nor write execution state.

**Capabilities are provider facts.** Codex uses app-server, OpenCode uses its
2.x HTTP server, and Copilot/Antigravity use ACP. Claude Code uses its own `-p`
stream-json protocol; cold follow-up via the saved session. Codex and OpenCode
support steer (their default), queue and interrupt. Claude and Antigravity
support queue (their default) and interrupt; Copilot supports cancel only.
Antigravity interventions still need live qualification. There are no transport-selection knobs. Copilot cold follow-up is refused
until qualified; Antigravity reloads saved sessions. Per-companion model defaults
and one-shot legacy migration belong to `lib/state.mjs`.

**Interventions share one controller path.** `agent_reply` accepts an optional
`mode`; omission uses the execution's saved `interventionModes.default`.
Status reports per-mode `interventions` availability. The user's atomic, private
`inbox/<executionId>/<requestId>.json` requests are read on the tick after owner
stop/lease checks, without extending the lease. Outcomes are private atomic
files; close removes that execution's inbox. An accepted user message wakes
`agent_wait` with `user_intervened`, never an answer; durable notice receipts
prevent repeats, including after a wait gap. Both roles relay it and keep waiting.
User cancel produces a terminal result with cause `user_cancel`.
Terminal `meta.interventions` exposes each message's sender, mode, state and first
line, including `not_delivered` messages.

## Single-source-of-truth modules

| Module | Owns |
| --- | --- |
| `bridge-server/server.mjs` | MCP attribution, envelopes, resource routing, completion publication and bridge-loss handoff. |
| `bridge-server/controller/controller.mjs` | Native turn loop, interventions, inbox consumption, caller notices, owner requests, leases, stop observations and result decisions. |
| `bridge-server/controller/records.mjs` | Atomic conversation/execution/lease/result records, inbox I/O and cleanup, notice receipts, generation and writer fencing, immutable results. |
| `bridge-server/controller/process-supervisor.mjs` | Owned process groups, descendant census, termination and PID/birth-identity verification. |
| `bridge-server/adapters/{codex,opencode,acp,claude}.mjs` | Provider protocols, history loading, delivery acknowledgement, native progress, usage and model selection. |
| `scripts/cleanup-watcher.mjs` | Bridge-loss tree termination and the fenced terminal result; never more model work. |
| `lib/state.mjs` | Default target/model configuration and one-shot migration of legacy settings/history. |
| `lib/host.mjs` | Host conventions and sandbox guard; `AGENT_COMPANION_HOST` is authoritative, `.host` is diagnostic. |
| `lib/transcripts.mjs` and `lib/transcripts/` | Read-only native transcript location, format fingerprints, normalized in-memory items and live follow (`followTranscript`). |
| `lib/work-summary.mjs` | Native turn selection and bounded commands, edits, errors and worktree summary projection. |
| `lib/worktree-snapshot.mjs` | Bounded snapshots through a throwaway index and the diff-stat including any writer. |
| `lib/digest.mjs` | Read-only, on-demand execution digest from native transcript and result records. |
| `lib/target-registry.mjs` | Capabilities, readiness requirements and ACP descriptors. |
| `lib/command-probe.mjs` | The bounded synchronous probe shared by diagnostics; enforced by `test/exec-timeout-guard.test.mjs`. |
| `bridge-server/ui/jobs.mjs` | The live view's job list from both hosts' state and caller titles from host transcripts (Claude lead session, Codex rollout and session index), and the `jobs` entry that lists one Claude session's jobs for the pane. |
| `bridge-server/ui/rows.mjs` | Sanitizing native text, cell widths, item folding and wrapping, a job's transcript blocks, card head and pending lines for both views, and the cached row index. |
| `bridge-server/ui/follow.mjs` | One job's transcript follow and turn selection for both views, and the `follow` entry that streams them to the Claude pane as JSON lines. |
| `bridge-server/ui/model.mjs` | Live-view state, keys, message boxes and frame composition; `app.mjs` is only the Ink layer and the `ui` entry point. |
| `bridge-server/ui/inbox.mjs` | The views' only writes: atomic 0600 inbox request files, deleting each outcome read, and `send` (`launch-ui.sh send`) for the Claude pane's message box. |
| `hooks/mod.ts` | Claude Code's mod (Codex ignores it): each agent-companion subagent's agent-list row from the bridge's records, read on a clock only while a job runs, and the Companions pane that follows the view, its list rebuilt by a `jobs` child, one `follow` child per shown job. |
| `hooks/launch-ui.sh`, `scripts/install-ui-launcher.mjs` | Running the live view and the pane's `jobs` and `follow` children with the hooks' Node and the view's dependencies; the `~/.local/bin/agent-companion` launcher. |

## Things that will bite you

- **`templates/` is the source; the installed copy is generated.** `hooks/install-agent.sh`
  re-materializes `~/.claude/agents/agent-companion.md` on *every* session start, unconditionally.
  Edits to the installed copy are silently discarded. (A destination lacking the AUTO-INSTALLED
  sentinel is treated as hand-authored and left alone forever.)
- **Host parity is a test.** Both plugin manifests register the session transport.
  Claude uses sibling `timeout` in milliseconds; Codex uses `tool_timeout_sec`
  in seconds. `templates/host-parity.test.mjs` pins their effective settings.
- **The MCP timeout is a per-call wall.** Both hosts cancelled at 1320 s, with
  or without progress. Waits cap at 1200 s (default 480); parent messages become
  visible between waits. `env: { MCP_TOOL_TIMEOUT }` does not configure the host.
  See the dated host reports below and Architecture's host budgets.
- **The owner lease covers gaps, not total answer duration.**
  `AGENT_COMPANION_OWNER_GRACE_MS` defaults to 120000. Status/catalog do not
  renew it. The old 40-minute execution cutoffs and their knobs are gone.
- **Stop markers are advisory evidence.** `hooks/stop-owner.sh` writes
  `stops/<owner>.json` for Claude TaskStop and both hosts' SubagentStop. A changed
  marker closes that owner's execution on the next controller tick; an old
  marker cannot cancel a later follow-up. The lease is the missing-signal fallback.
- **Claude plugin tools are namespaced.** The installer qualifies the source
  reference to `plugin:agent-companion:agent-bridge` and tools to
  `mcp__plugin_agent-companion_agent-bridge__*`; the identity hook matches these
  as well as bare session tool names.
- **The live view lives in `bridge-server/ui/` for its imports.** ESM finds `ink`
  and `react` by walking up to `bridge-server/node_modules` (Claude's link); on
  Codex, `hooks/resolve-codex-deps.mjs` relocates bare package imports only from
  `bridge-server/` sources. A UI module elsewhere fails on both. Keep `lib/` free of
  package imports. Native text reaching the terminal goes through `rows.mjs`'s `clean`.
- **The mod has no Node.** `hooks/mod.ts` runs in Claude Code's mod
  environment: it imports only import-free files (`bridge-server/ui/rows.mjs`,
  `lib/model-name.mjs`, typed by their `.d.mts`) and reads records through
  `$.fs`; the pane's list comes from a `launch-ui.sh jobs` child it runs with
  `$.process.run`, and its transcript from a `launch-ui.sh follow` child it
  streams with `$.process.spawn`. Its tests run under `claude plugin test .`,
  not `node --test`.
- **Sandbox tests before imports.** Put `import '../test/sandbox-home.mjs';` first
  in suites that reach state/runtime code. `lib/state.mjs` binds `BASE_DIR` at
  import time, so setting env in the test body is too late for static imports.
  Setting env before a dynamic `await import(...)` also works. Under `node --test`,
  state/runtime access beneath the real account home throws; the completion
  hook exits 78. `test/runtime-sandbox-guard.test.mjs` enforces this. Runtime
  paths and logs deliberately re-read their env per call.
- **Never write into the installed Codex plugin.** codex-cli 0.164 fingerprints the plugin
  bundle before running any of its hooks and rejects symlinks: a `bridge-server/node_modules`
  link there made every hook fail. On Codex, `hooks/install-deps.sh` keeps dependencies in
  plugin data and `hooks/launch-agent-bridge.mjs` resolves the SDK imports from there.
- **Codex sandbox defaults are deliberately not codex's defaults** (`workspace-write` with
  network **on**), and in app-server `approvalPolicy: 'never'` is structural —
  accepting one approval was measured escalating past the sandbox. Do not make it configurable.
- **The ACP adapter answers `session/request_permission` itself.** Passing an
  approval flag does not guarantee an agent will stop asking. The answer comes
  from the descriptor's `acp.permission(env)`; leaving a request unanswered hangs
  the turn. Do not send MCP's `notifications/initialized` on ACP.
- **Claude companion startup and results need their native semantics.** The child
  prints nothing until the first user line; the following `system/init` confirms
  the session id and acknowledges delivery. Init can repeat every turn. A
  native `result` ends that turn even if the process stays alive; the controller
  continues accepted input or closes and verifies the owned tree. `subtype: success`
  with `is_error: true` is a failure (measured when not logged in). `--bare`
  skips OAuth/keychain, so the adapter never uses it. `total_cost_usd` is
  cumulative on resume, so cost is reported only for fresh history. The child
  denies `Agent(agent-companion)` and both bridge namespaces to prevent recursive
  delegation; user settings, hooks and plugins still load. These are protocol
  measurements on 2.1.319, not installed-host qualification.
- **Antigravity model selection is per session.** `session/load` forgets it,
  so the adapter applies the descriptor's `acp.setModel` after both new and loaded
  sessions. The server is Google's `agy_acp_server.par`, installed by
  `scripts/install-antigravity-acp.mjs`. Re-read `docs/MVP_TRACKER.md` item 8's
  account/terms assessment before widening what the bridge does with that login.
  All Antigravity work is paused since 2026-11-17 (switch to `agy acp` decided,
  queued in the tracker's Next Backlog); no changes or live runs until the user
  resumes it.

## Docs

| File | Use |
| --- | --- |
| `docs/ARCHITECTURE.md` | Layer boundaries, routing contract, state layout, **Negative Results**. |
| `docs/RELIABILITY_REMEDIATION.md` | Historical incident and protocol measurements; retired survival design explicitly labelled. |
| `docs/MVP_TRACKER.md` | What is done, what the current limitations are, what is next. |
| `docs/RELEASE_READINESS.md` | Release gates and source-backed vendor compatibility notes. |
| `docs/DIRECTION_ASSESSMENT.md` | Active redesign direction, review evidence and upgrade checks. |
| `docs/LIVE_VIEW_PLAN.md` | Live transcript view and interventions: agreed decisions, measured native-transcript evidence, steps with checks. |
| [Claude host report](probes/host-qualification/claude/REPORT-2026-11-05.md) | Claude 2.1.318 owner, stop/loss, cwd and per-call-wall measurements. |
| [Codex host report](probes/host-qualification/codex/REPORT-2026-11-05.md) | Codex 0.166.0 equivalent measurements; desktop and operator-only gaps remain unqualified. |
| [Claude companion report](probes/host-qualification/claude-companion/REPORT-2026-11-09.md) | Claude Code 2.1.319 as a companion: protocol measurements, live probe and installed runs on both hosts. |
| `probes/README.md` | Probe coverage, prerequisites and operating caveats. |

Commit subjects follow `type(scope): lowercase description of what changed and why`, often with
two clauses joined by "and".
