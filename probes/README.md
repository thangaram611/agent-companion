# Probes

Hand-run harnesses, outside `node --test` and the shipped plugin. They exercise
real runtimes and can spend Codex or Antigravity tokens. They test process
lifetimes, sandbox enforcement, restart recovery and control behavior that unit
fakes cannot establish. Measurement evidence lives in
[`docs/RELIABILITY_REMEDIATION.md`](../docs/RELIABILITY_REMEDIATION.md).

Smoke jobs use temporary workspaces but write live job/runtime state and Codex
rollouts. These are not read-only checks.

## `host-qualification/claude/` — Phase 2 host measurements

An isolated, passive fake MCP/provider fixture for Claude Code ownership,
cancellation, connection loss, cwd, follow-up and long-call measurements.
Preparation and `verify.mjs` are offline; live runs require explicit operator
execution and credentials and spend Claude tokens. Each run keeps its own
config, agents, logs and PID cleanup evidence. See the
[runbook](host-qualification/claude/RUNBOOK.md) for the first smoke command,
scenario matrix, TUI actions and limits. No production plugin is loaded.

## `host-qualification/codex/` — isolated Phase 2 host measurements

The [Codex runbook](host-qualification/codex/RUNBOOK.md) provides a passive fake
MCP/provider tree, hook logger, headless/PTY runners, scenario matrix and analyzer.
The operator runs live Codex sessions in a per-run `CODEX_HOME`; this harness
does not use the installed bridge. Start with `node probes/host-qualification/codex/runner.mjs smoke`.
Offline checks are explicit: `node probes/host-qualification/codex/self-check.mjs`.
Neither the harness nor its checks are discovered by `node --test`.

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
| `bridge-client.mjs` | Shared stdio MCP client, owner attribution, bounded waits and durable-record reader; no standalone probe. |

The broker-survival probes `appserver.mjs` and `appserver-control.mjs` have
been retired. Each execution now owns its provider process; a replacement
bridge reads a terminal result and never adopts a live execution.

The probes use the selected host's state home, or `AGENT_COMPANION_HOME` when
set. Their temporary workspaces remain available for inspection. Run readiness
checks before spending tokens:

```sh
AGENT_COMPANION_HOST=claude node scripts/onboard.mjs --list-targets
AGENT_COMPANION_HOST=claude node probes/smoke/smoke.mjs
AGENT_COMPANION_HOST=claude node probes/smoke/orphan.mjs
AGENT_COMPANION_HOST=claude node probes/smoke/acp-antigravity.mjs <available-model-id>
```
