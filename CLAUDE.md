# CLAUDE.md

## What this is

A delegation plugin: a **harness** (Claude Code or Codex CLI) spawns an isolated
`agent-companion` subagent, which uses `agent-bridge` to run work on a **companion** runtime
(OpenCode, GitHub Copilot CLI, Codex CLI, or Google Antigravity). Claude scopes the MCP server to the subagent.
Current Codex forbids role-local MCP authority, so its plugin registers the internal bridge at
session scope and the child inherits it; main can see the schemas, but direct use is unsupported.
The matrix is 2 harnesses × 4 companions, and two companions ship two transports each — parity
across that matrix is the product, not an implementation detail.

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
codex upgrade the drift test and the broker's boot probe compare the live schema, so a
version-only bump stays green and only a real schema change fails the test — the broker still
boots either way and reports `contractStatus: match|drift|unverified`, never refusing to serve:

```bash
node scripts/gen-codex-app-server-contract.mjs
```

`probes/` are hand-run harnesses that can spend Codex or Antigravity tokens and
write live runtime state. They are outside `node --test`; see `probes/README.md`.

## Architecture

**The bridge is disposable; the runtimes are not.** Claude owns it through the standalone
agent's MCP frontmatter; Codex owns it through the plugin/session registration inherited by the
agent role. Either host may replace the bridge process. Anything that must outlive that process
therefore lives in a detached runtime with its own socket — shared by every bridge on the
machine that resolves to the same host home, so the two hosts get one each — never in bridge
memory. This is the single most load-bearing fact in the repo.

**No silent fallback, anywhere.** An unresolvable send returns an explicit `ok:false` envelope
(`TARGET_UNCONFIGURED`, `TARGET_UNSUPPORTED`, `STRENGTH_UNCONFIGURED`, `STRENGTH_AMBIGUOUS`,
`PROFILE_UNKNOWN`, `PROFILE_AMBIGUOUS`, `ROUTING_CONFLICT`, `CAPABILITY_UNAVAILABLE`,
`MODEL_NOT_ALLOWED`). Treat that list as closed — both agent templates enumerate all nine, and
both forbid the subagent from re-sending with a target the harness never supplied. Both template
suites pin the list, so update `resolveRouting`, both templates and both template suites
when adding a routing refusal. The envelope echoes candidate ids only where candidates exist; the
capability-gate refusals (`TARGET_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE`, `MODEL_NOT_ALLOWED`)
carry none.

**Conversation identity comes from the host.** Claude's `hooks/name-thread.sh`
writes the subagent's `agent_id` into the send's `thread`; Codex's
`_meta["x-codex-turn-metadata"].thread_id` wins in `callArgs`. MCP sends without a
thread are refused. A new spawn starts a conversation; a message to the same
agent continues it. On a busy thread, only the same task, mode, template and
`template_args` can reattach, after target/profile/cwd checks. Different work
returns `thread_busy`; it must wait, cancel or use a supported reply.

**Capabilities and runtime selection are distinct.** Read capabilities from
`lib/target-registry.mjs`. A profile's `adapter` declares capabilities but does
not choose the spawned transport; the runtime environment does. OpenCode and
Codex record the starting adapter per job for reply/resume. ACP jobs do not;
Copilot re-reads `COPILOT_RUNTIME_ADAPTER` on each call.

## Single-source-of-truth modules

Consolidation here is enforced, in several cases by tests that grep the source tree. Adding a
second reader/definition is how these break.

| Module | Owns |
| --- | --- |
| `lib/host.mjs` | The only place that chooses claude-vs-codex conventions. `AGENT_COMPANION_HOST` is authoritative; `.host` marker files are diagnostic only, never a fallback. |
| `lib/target-registry.mjs` | What a companion can do (capabilities) **and** what it takes to be ready (onboarding). Two concerns, one descriptor, deliberately. For the ACP companions the `acp` block is also everything the daemon needs to run them. |
| `lib/profile-registry.mjs` | The **only** reader of `profiles.json`. `test/profile-registry-guard.test.mjs` fails on any other reference to `readProfilesRaw` / `PROFILES_FILE`. |
| `lib/command-probe.mjs` | `probeCommand` is the **only** sanctioned synchronous shell-out from bridge code. It stays dependency-free so broker preflight does not initialize durable state. `test/exec-timeout-guard.test.mjs` fails on any duplicate or unbounded one. |
| `lib/shared-runtime-registry.mjs` | Leases + two-phase disposal for the detached shared runtimes (one per host home). A `dispose` that does anything before the destructive act must call `confirmDisposal()` as late as possible and abort when it returns false. |

## Things that will bite you

- **`templates/` is the source; the installed copy is generated.** `hooks/install-agent.sh`
  re-materializes `~/.claude/agents/agent-companion.md` on *every* session start, unconditionally.
  Edits to the installed copy are silently discarded. (A destination lacking the AUTO-INSTALLED
  sentinel is treated as hand-authored and left alone forever.)
- **Host parity is a test, not a convention.** Claude configures the bridge in the standalone
  agent frontmatter (YAML `env:` + `timeout` in ms); Codex configures it in
  `.codex-plugin/plugin.json` (`env` + `tool_timeout_sec` in seconds). Mechanism may diverge;
  capability may not — `templates/host-parity.test.mjs` enforces it. A knob documented only in
  a comment counts as *not set*.
- **MCP timeouts:** the working fields are a **sibling** `timeout:` on the Claude server entry
  (ms) and `tool_timeout_sec` in the Codex plugin manifest. `env: { MCP_TOOL_TIMEOUT }` reaches
  the child and is ignored by the host. The idle window those fields floor is Claude Code's
  own `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (30 min default for stdio; pinned with
  `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` in `docs/ARCHITECTURE.md` "Host budgets"). Never raise
  `clampWaitSec` past 1500 s without a per-server timeout.
- **Sandbox tests before imports.** Put `import '../test/sandbox-home.mjs';` first
  in suites that reach state/runtime code. `lib/state.mjs` binds `BASE_DIR` at
  import time, so setting env in the test body is too late for static imports.
  Setting env before a dynamic `await import(...)` also works. Under `node --test`,
  state/runtime access beneath the real account home throws; the completion
  hook exits 78. `test/runtime-sandbox-guard.test.mjs` enforces this. Runtime
  paths and logs deliberately re-read their env per call.
- **`bridge-server/server.test.mjs`'s fake-OpenCode-CLI test is timing-sensitive** (a 5 s poll
  budget). It has been observed failing under full-suite concurrency and passing in ~0.6 s alone
  — re-run the file before treating it as a real regression.
- **Never write into the installed Codex plugin.** codex-cli 0.164 fingerprints the plugin
  bundle before running any of its hooks and rejects symlinks: a `bridge-server/node_modules`
  link there made every hook fail. On Codex, `hooks/install-deps.sh` keeps dependencies in
  plugin data and `hooks/launch-agent-bridge.mjs` resolves the SDK imports from there.
- **Codex sandbox defaults are deliberately not codex's defaults** (`workspace-write` with
  network **on**), and under the app-server transport `approvalPolicy: 'never'` is structural —
  accepting one approval was measured escalating past the sandbox. Do not make it configurable.
- **The ACP daemon answers `session/request_permission` itself.** Passing an
  approval flag does not guarantee an agent will stop asking. The answer comes
  from the descriptor's `acp.permission(env)`; leaving a request unanswered hangs
  the turn. Do not send MCP's `notifications/initialized` on ACP.
- **Antigravity model selection is per session.** `session/load` forgets it,
  so the daemon applies the descriptor's `acp.setModel` after both new and loaded
  sessions. The server is Google's `agy_acp_server.par`, installed by
  `scripts/install-antigravity-acp.mjs`. Re-read `docs/MVP_TRACKER.md` item 8's
  account/terms assessment before widening what the bridge does with that login.

## Docs

| File | Use |
| --- | --- |
| `docs/ARCHITECTURE.md` | Layer boundaries, routing contract, state layout, **Negative Results**. |
| `docs/RELIABILITY_REMEDIATION.md` | The measured evidence behind the codex/app-server design. Cited by name from source comments. |
| `docs/MVP_TRACKER.md` | What is done, what the current limitations are, what is next. |
| `docs/RELEASE_READINESS.md` | Release gates and source-backed vendor compatibility notes. |
| `docs/DIRECTION_ASSESSMENT.md` | Maintenance scope and review-loop design evidence. |
| `probes/README.md` | Probe coverage, prerequisites and operating caveats. |

Commit subjects follow `type(scope): lowercase description of what changed and why`, often with
two clauses joined by "and".
