# CLAUDE.md

## What this is

A delegation plugin: a **harness** (Claude Code or Codex CLI) spawns an isolated
`agent-companion` subagent, which uses `agent-bridge` to run work on a **companion** runtime
(OpenCode, GitHub Copilot CLI, Codex CLI, or Google Antigravity). The parent talks to the
subagent in plain language (what to do, the absolute repo path, optionally which companion or
model); the subagent sends that text verbatim through the private `agent_*` tools and brings the
companion's answer back. Both hosts register the bridge at plugin/session scope;
execution calls require a native child owner. Claude attributes it through a hook;
Codex supplies subagent metadata. The install matrix is two CLI hosts × four
companions. Codex desktop remains unqualified.

Read `README.md` for the user-facing contract and `docs/ARCHITECTURE.md` before any non-trivial
change. `docs/ARCHITECTURE.md` carries a **Negative Results** section: things that look wrong
in this code but are deliberate because a measurement overturned the obvious design. Check it
before "fixing" something surprising.

## Commands

Use [README.md — Development](README.md#development) for checks, packaging and
README asset rendering. Discover tests from the repo root: directory allowlists
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

`probes/` are hand-run harnesses that can spend host or companion tokens and
write live runtime state. They are outside `node --test`; see `probes/README.md`.

## Architecture

**One controller owns each execution.** Each answer starts a cold provider runtime
in its own process group. The controller owns the process tree, native history
reference, lease and terminal result. Pending send/wait/reply/cancel calls hold
the owner's lease; gaps consume its grace. Stop markers supply explicit owner-stop
evidence. On SIGINT, SIGTERM or stdin EOF, the bridge hands the recorded tree to
`scripts/cleanup-watcher.mjs`, which terminates it and saves a fenced result.
In-flight survival across bridge replacement is deliberately given up. Native
history remains; a later message to the same native child resumes it cold.
Provider processes and protocol connections are never shared across children.
Uncatchable bridge SIGKILL cannot run the handoff; recovery refuses to adopt a
live or unverified tree.

**No silent fallback.** Target/model refusals are `TARGET_UNCONFIGURED`,
`TARGET_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE` and `MODEL_NOT_ALLOWED`. Ownership,
history and execution refusals are separate, including `NATIVE_OWNER_REQUIRED`
and `FOLLOWUP_UNSUPPORTED`. Both role templates relay failures without changing
the parent's choice. Omitted target uses the configured default; omitted model
inherits configuration unless the conversation already has an override. Codex
receives no model key when inheriting. The bridge delivers task text verbatim.

**Conversation identity comes from the host.** Claude's `hooks/name-thread.sh`
unconditionally overwrites `thread` with the child's `agent_id` or clears it.
Codex requires `_meta["x-codex-turn-metadata"].thread_source: subagent` and uses
its `thread_id`. A fresh spawn starts independent work. An identical busy send
reattaches; different text or model returns `thread_busy`, and provider/cwd
mismatches fail explicitly. Catalog and status are ownerless observers: they
neither start work nor renew leases nor write execution state.

**Capabilities are provider facts.** Codex uses app-server, OpenCode uses its
2.x HTTP server, and Copilot/Antigravity use ACP. There are no transport-selection
knobs. Only Codex supports in-flight steer. Copilot cold follow-up is refused
until qualified; Antigravity reloads saved sessions. Per-companion model defaults
and one-shot legacy migration belong to `lib/state.mjs`.

## Single-source-of-truth modules

| Module | Owns |
| --- | --- |
| `bridge-server/server.mjs` | MCP attribution, envelopes, digest/completion publication and bridge-loss handoff. |
| `bridge-server/controller/controller.mjs` | Execution lifecycle, owner requests, leases, stop observations and result decisions. |
| `bridge-server/controller/records.mjs` | Atomic conversation/execution/lease/result records, generation and writer fencing, immutable results. |
| `bridge-server/controller/process-supervisor.mjs` | Owned process groups, descendant census, termination and PID/birth-identity verification. |
| `bridge-server/adapters/{codex,opencode,acp}.mjs` | Provider protocols, history loading, delivery acknowledgement, native progress, usage and model selection. |
| `scripts/cleanup-watcher.mjs` | Bridge-loss tree termination and the fenced terminal result; never more model work. |
| `lib/state.mjs` | Default target/model configuration and one-shot migration of legacy settings/history. |
| `lib/host.mjs` | Host conventions and sandbox guard; `AGENT_COMPANION_HOST` is authoritative, `.host` is diagnostic. |
| `lib/target-registry.mjs` | Capabilities, readiness requirements and ACP descriptors. |
| `lib/command-probe.mjs` | The bounded synchronous probe shared by diagnostics; enforced by `test/exec-timeout-guard.test.mjs`. |

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
- **Antigravity model selection is per session.** `session/load` forgets it,
  so the adapter applies the descriptor's `acp.setModel` after both new and loaded
  sessions. The server is Google's `agy_acp_server.par`, installed by
  `scripts/install-antigravity-acp.mjs`. Re-read `docs/MVP_TRACKER.md` item 8's
  account/terms assessment before widening what the bridge does with that login.

## Docs

| File | Use |
| --- | --- |
| `docs/ARCHITECTURE.md` | Layer boundaries, routing contract, state layout, **Negative Results**. |
| `docs/RELIABILITY_REMEDIATION.md` | Historical incident and protocol measurements; retired survival design explicitly labelled. |
| `docs/MVP_TRACKER.md` | What is done, what the current limitations are, what is next. |
| `docs/RELEASE_READINESS.md` | Release gates and source-backed vendor compatibility notes. |
| `docs/DIRECTION_ASSESSMENT.md` | Active redesign direction, review evidence and upgrade checks. |
| [Claude host report](probes/host-qualification/claude/REPORT-2026-11-05.md) | Claude 2.1.318 owner, stop/loss, cwd and per-call-wall measurements. |
| [Codex host report](probes/host-qualification/codex/REPORT-2026-11-05.md) | Codex 0.166.0 equivalent measurements; desktop and operator-only gaps remain unqualified. |
| `probes/README.md` | Probe coverage, prerequisites and operating caveats. |

Commit subjects follow `type(scope): lowercase description of what changed and why`, often with
two clauses joined by "and".
