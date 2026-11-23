# CLAUDE.md

## What this is

The **lead** in Claude Code or Codex CLI calls `agent-bridge` directly. It sends
a task and absolute cwd to OpenCode, GitHub Copilot CLI, Codex CLI, Google
Antigravity or Claude Code. The bridge returns a thread id, runs the job and
delivers the result to that lead. Codex desktop remains unqualified.

Read `README.md` for the user-facing contract and `docs/ARCHITECTURE.md` before any non-trivial
change. `docs/ARCHITECTURE.md` carries a **Negative Results** section: things that look wrong
in this code but are deliberate because a measurement overturned the obvious design. Check it
before "fixing" something surprising.

## Commands

Use [README.md — Development](README.md#development) for checks, packaging and
README asset regeneration. Discover tests from the repo root: directory allowlists
can omit cross-cutting guards in `test/`. CI's command is in
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

**One controller owns each job.** Each job starts a cold companion runtime
in its own process group and loops over native turns while accepted input remains.
The controller owns the process tree, history reference and terminal result.
SIGINT, SIGTERM or stdin EOF hands the recorded tree to the cleanup watcher for
termination and a fenced result. SIGKILL cannot run the handoff. Recovery
refuses to adopt a live or unverified tree. A later job resumes supported
native history in a fresh process.

**The host identifies the lead.** Claude's PreToolUse hook writes `lead` from
`session_id` and optional `agent_id`. Codex uses turn metadata. The bridge
issues a thread id. A caller using another lead's thread gets `THREAD_NOT_YOURS`.
Starting work from a recorded companion session gets `RECURSION_REFUSED`.

**No silent fallback.** A thread keeps its companion and canonical cwd.
Companion/model/effort refusals are `COMPANION_UNCONFIGURED`, `COMPANION_UNSUPPORTED`,
`CAPABILITY_UNAVAILABLE`, `MODEL_NOT_ALLOWED` and `EFFORT_NOT_ALLOWED`. ACP
authentication refusals are `AUTH_REQUIRED`, with the descriptor's sign-in steps;
they are setup problems, not reasons to retry or switch companion. Lead, history
and execution refusals are separate: `LEAD_REQUIRED`, `THREAD_NOT_YOURS`,
`RECURSION_REFUSED` and `FOLLOWUP_UNSUPPORTED`. Omitted companion uses the
configured default; omitted model inherits configuration unless the thread
already has an override. Effort is a thread override too, supported by all five
companions. Claude has static levels `low`, `medium`, `high`, `xhigh`, `max`.
Copilot sets a requested model after `session/new` through
`session/set_config_option` and confirms `currentValue`. A model refusal lists
the session's advertised ids. Copilot and Antigravity validate and confirm the
selected model's ACP `thought_level` and report inherited effort. Codex catalog
models and OpenCode also validate model-specific levels before delivery. Codex
levels are unverified for models outside Codex's catalog: it confirms the
reported effort and lets the backend validate vocabulary during the turn. Before
writing any selection on existing history, Codex reads its model. OpenCode
queries variants only for an effort override, which takes precedence over a
variant in the model string. Inherited OpenCode effort stays null. Refused effort
is not saved on the thread or written to native selection state. On a new
thread, omitted effort uses the companion's saved default, then native
configuration. Copilot's spawn effort flag is removed; the option is validated
before a config write. Local Ollama BYOK makes Copilot testable; GitHub-hosted
model qualification still hits this account's `session/new` 403. The isolated
free-backend harness is in `probes/free-backends/`; never use the operator's live
homes for it. Send acknowledgements expose the job, thread, companion,
selected/effective model and effort, resolved permission mode and which wake is
armed; effective effort is null unless the companion reports it. Status adds
activity (thinking, responding, running a command or retrying for Claude)
without retaining thinking content. The bridge delivers task text verbatim.

**Capabilities are provider facts.** Codex uses app-server, OpenCode uses its
2.x HTTP server, and Copilot/Antigravity use ACP. Claude Code uses its own `-p`
stream-json protocol; cold follow-up via the saved session. Codex, OpenCode and
Antigravity default to steer and support queue and interrupt. Claude defaults to
queue and supports interrupt. Copilot supports cancel only. There are no
transport-selection knobs. Copilot cold follow-up is refused until qualified.
Routing applies model defaults only on a new thread. Both hosts share
`settings.json` and its one-shot migration in `lib/state.mjs`.

**Interventions share one controller path.** New text sent to a running thread
is an intervention with an optional `mode`; omission uses the execution's saved
`interventionModes.default`, and repeating the original send returns the
existing job. Status reports per-mode `interventions` availability. The views'
atomic, private `inbox/<executionId>/<requestId>.json` requests are read on the
controller's tick. Outcomes are private atomic files; close removes that
execution's inbox. An accepted user message wakes `companion_wait` with
`user_intervened`, never an answer; durable notice receipts prevent repeats,
including after a wait gap. User cancel produces a terminal result with cause
`user_cancel`. The terminal metadata's `interventions` lists each message's
sender, mode, state and first line, including `not_delivered` messages.

## Single-source-of-truth modules

| Module | Owns |
| --- | --- |
| `bridge-server/server.mjs` | MCP wiring, startup and bridge-loss handoff. |
| `bridge-server/tools.mjs` | Six tool schemas and handlers, lead checks, routing, paged reads and digest resources. |
| `bridge-server/delivery.mjs` | Result notices, session news markers, exclusive delivery receipts and answer excerpts. |
| `bridge-server/controller/controller.mjs` | Native turn loop, interventions, user inbox and job lifecycle. |
| `bridge-server/controller/records.mjs` | Atomic records, inbox I/O, notice receipts, generation and writer fences, shared terminal result builder. |
| `bridge-server/controller/process-supervisor.mjs` | Owned process groups, descendant census, termination and PID/birth-identity verification. |
| `bridge-server/adapters/{codex,opencode,acp,claude}.mjs` | Provider protocols, history loading, delivery acknowledgement, native progress, usage and model selection. |
| `scripts/cleanup-watcher.mjs` | Bridge-loss tree termination and the fenced terminal result; never more model work. |
| `lib/state.mjs` | Shared companion, model and effort settings, atomic model/effort edits and one-shot migration of legacy defaults. |
| `lib/hosts/` | Host registry, paths, lead identity, wake adapters and sandbox guard. |
| `hooks/hook.sh` and `hooks/hook.mjs` | Hook entry for Claude identity, session registration and delivery on session start, prompt submit and post-tool events. |
| `lib/transcripts.mjs` and `lib/transcripts/` | Read-only native transcript location, format fingerprints, normalized in-memory items and live follow (`followTranscript`). |
| `lib/work-summary.mjs` | Native turn selection and bounded commands, edits, errors and worktree summary projection. |
| `lib/worktree-snapshot.mjs` | Bounded snapshots through a throwaway index and the diff-stat including any writer. |
| `lib/digest.mjs` | Read-only, on-demand execution digest from native transcript and result records. |
| `lib/target-registry.mjs` | Capabilities, readiness requirements and ACP descriptors. |
| `lib/command-probe.mjs` | The bounded synchronous probe shared by diagnostics; enforced by `test/exec-timeout-guard.test.mjs`. |
| `bridge-server/ui/jobs.mjs` | Both hosts' job lists, thread titles and lead session names. The pane lists the latest job per thread in its session. |
| `bridge-server/ui/defaults.mjs` | The package-free `defaults` command and the live view's defaults panel (`d`): saved choices, native inheritance, validation, saves and legacy conflict resolution. |
| `bridge-server/ui/rows.mjs` | Sanitizing native text, cell widths, item folding and wrapping, a job's transcript blocks, card head and pending lines for both views, and the cached row index. |
| `bridge-server/ui/follow.mjs` | One job's transcript follow and turn selection for both views, and the `follow` entry that streams them to the Claude pane as JSON lines. |
| `bridge-server/ui/model.mjs` | Live-view state, keys, message boxes and frame composition; `app.mjs` is only the Ink layer and the `ui` entry point. |
| `bridge-server/ui/inbox.mjs` | The views' job writes: atomic 0600 inbox request files, deleting each outcome read, and `send` (`launch-ui.sh send`) for the Claude pane's message box. |
| `hooks/mod.ts` | Claude's running-thread band above the prompt and the `/companion` pane. A card opens its thread's latest job. |
| `hooks/launch-ui.sh`, `scripts/install-ui-launcher.mjs` | The `~/.local/bin/agent-companion` launcher, the live view and its package-free `defaults`, `jobs`, `follow` and `send` commands. |

## Things that will bite you

- **Silence never ends a job.** A quiet companion may be thinking or retrying
  offline for hours (Claude's retry watchdog), which no gap can tell from a
  stopped one. A job ends on its native turn's end, `companion_cancel`, a user
  cancel or bridge loss. Esc and a cancelled or stopped wait never end it.
- **Claude identity must fail closed.** PreToolUse replaces any supplied lead
  before send, wait, read, status or cancel. Keep `onFailure: "block"` for a
  failed or timed-out hook.
- **Claude plugin tools are namespaced.** Claude names them
  `mcp__plugin_agent-companion_agent-bridge__*`; the identity hook and the mod
  match these as well as bare session tool names.
- **Host parity is a test.** Both plugin manifests register the bridge. Claude
  uses sibling `timeout` in milliseconds; Codex uses `tool_timeout_sec` in
  seconds. `test/hosts.test.mjs` pins their effective settings.
- **The empty hook path starts no process.** On ordinary prompt and post-tool
  events the stub reads stdin with Bash builtins and checks the session news
  marker. Keep Node off that path.
- **One delivery module arbitrates the hook/tool race.** Use `delivery.mjs`
  for both. A result is claimed once: after a hook delivery a tool call returns
  a note and `delivered_by: "hook"` in place of the text; after a tool delivery
  repeated calls return the text again. A wake attempt, `companion_status` and
  `companion_read` never claim. The read cursor lives in a separate record so a
  controller rewrite cannot roll it back.
- **Claude needs two JSON lines on the inbox socket.** Send the auth object,
  then `{"type":"user","message":{"role":"user","content":"…"}}`. Plain text
  starts no turn. Recheck the session id because `/clear` reuses the socket.
- **Codex can wake an unseen lead.** After `/new` or `/quit`, the daemon keeps
  the old conversation loaded until idle for `thread_unload_delay_secs` (60 s
  by default), and a wake restarts that delay. Its shutdown is bridge loss for
  a job still running. Nothing tells a watched conversation from a left one, so
  do not add a presence gate; `setup.sh --codex-unload-delay` is the one knob,
  read when Codex's daemon starts.
- **The MCP wall is per call.** Both hosts cancelled at 1,320 s even with
  progress. Waits default to 480 s and cap at 1,200. Claude's mod must match
  only `companion_send` so a long main-conversation wait can move to the background.
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
  hook exits 78. `test/runtime-sandbox-guard.test.mjs` enforces this. Shared settings, runtime
  paths and logs re-read their env per call.
- **Never write into the installed Codex plugin.** codex-cli 0.164 fingerprints the plugin
  bundle before running any of its hooks and rejects symlinks: a `bridge-server/node_modules`
  link there made every hook fail. On Codex, `hooks/install-deps.sh` keeps dependencies in
  plugin data and `hooks/launch-agent-bridge.mjs` resolves the SDK imports from there.
- **Codex waits for its bridge.** The Codex manifest marks agent-bridge
  `required`. As an optional server, the first window on a cold daemon (or an
  in-process one) started its first turn without the bridge's tools. The cost:
  a bridge that cannot start keeps Codex from opening; fix the install
  (`setup.sh --host codex`) rather than dropping the flag.
- **Codex sandbox defaults are deliberately not codex's defaults** (`workspace-write` with
  network **on**), and in app-server `approvalPolicy: 'never'` is structural —
  accepting one approval was measured escalating past the sandbox. Do not make it configurable.
- **The ACP adapter answers `session/request_permission` itself.** Passing an
  approval flag does not guarantee a companion will stop asking. The answer comes
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
  denies the bridge tool namespaces to prevent recursive
  delegation; user settings, hooks and plugins still load. These are protocol
  measurements on 2.1.319, not installed-host qualification.
- **Antigravity runs one `agy acp` per job.** Cold `session/load` must replay
  history. Reapply requested model and thought level after each load. At
  `end_turn`, keep the turn open while a non-daemon command is running or a
  subagent has yet to report. Re-read `docs/MVP_TRACKER.md` item 8's
  account/terms assessment before widening what the bridge does with that login.

## Docs

| File | Use |
| --- | --- |
| `docs/THREAD_PLAN.md` | Thread contract, measured host behavior and future host adapters. |
| `docs/ARCHITECTURE.md` | Layer boundaries, routing contract, state layout, **Negative Results**. |
| `docs/RELIABILITY_REMEDIATION.md` | Historical incident and protocol measurements; retired survival design explicitly labelled. |
| `docs/MVP_TRACKER.md` | What is done, what the current limitations are, what is next. |
| `docs/RELEASE_READINESS.md` | Release gates and source-backed vendor compatibility notes. |
| `docs/DIRECTION_ASSESSMENT.md` | Active redesign direction, review evidence and upgrade checks. |
| `docs/LIVE_VIEW_PLAN.md` | Live transcript view and interventions: agreed decisions, measured native-transcript evidence, steps with checks. |
| `docs/DEFAULTS_PLAN.md` | User model/effort defaults: agreed decisions, measured companion and host facts, steps with checks. |
| `docs/CODE_MODE_PLAN.md` | Code Mode and browser parameters for companions (backlog): decisions, measurements across companions and browsers, open decisions, steps with checks. |
| [Claude host report](probes/host-qualification/claude/REPORT-2026-11-05.md) | Claude 2.1.318 owner, stop/loss, cwd and per-call-wall measurements. |
| [Codex host report](probes/host-qualification/codex/REPORT-2026-11-05.md) | Codex 0.166.0 equivalent measurements; desktop and operator-only gaps remain unqualified. |
| [Claude companion report](probes/host-qualification/claude-companion/REPORT-2026-11-09.md) | Claude Code 2.1.319 as a companion: protocol measurements, live probe and installed runs on both hosts. |
| `probes/README.md` | Probe coverage, prerequisites and operating caveats. |

Commit subjects follow `type(scope): lowercase description of what changed and why`, often with
two clauses joined by "and".
