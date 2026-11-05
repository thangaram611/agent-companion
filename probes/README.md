# Probes

Hand-run harnesses, outside `node --test` and the shipped plugin. They exercise
real runtimes and can spend Codex or Antigravity tokens. They test process
lifetimes, sandbox enforcement, restart recovery and control behavior that unit
fakes cannot establish. Measurement evidence lives in
[`docs/RELIABILITY_REMEDIATION.md`](../docs/RELIABILITY_REMEDIATION.md).

Smoke jobs use temporary workspaces but write live job/runtime state and Codex
rollouts. `codex-app-server/probe.mjs` and `wsclient.mjs` write logs in the shell's
working directory; run them from a scratch directory and give them a scratch
workspace. These are not read-only checks.

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

## `codex-app-server/` — transport and architecture validation

These scripts isolate protocol behavior. The committed wire contract is generated
from codex-cli 0.166.0 (`lib/codex-app-server-contract.json`); that provenance does
not certify a live probe run. These historical broker experiments do not qualify the Phase 3 owned-runtime
controller in `bridge-server/controller/`.

| script | proves |
|---|---|
| `broker.mjs` | Prototype for one stdio app-server, one upstream initialize handshake and per-client JSON-RPC id remapping over a Unix socket. It broadcasts notifications and has no idle reaper. |
| `bclient.mjs` | `start` opens a turn and disconnects; `attach` reconnects and watches the same thread. The gap between invocations determines the zero-client interval. |
| `conc.mjs` | Two concurrent clients receive their own thread's answers; also reports cross-thread notifications from the prototype's broadcast. |
| `errs.mjs` | Prints errors for nonexistent ids, stale turn ids and idle-thread control, then exercises a second `turn/start` on a busy thread, steering and interruption. The nonexistent-id cases cannot establish how an unloaded real thread behaves. |
| `unloaded.mjs` | Completes a real turn, kills the server and compares read, steer, interrupt and resume on a fresh server. A disk-backed thread can be readable/resumable while control reports `thread not found`; that message alone does not mean its history is lost. Uses `/opt/homebrew/bin/codex`. |
| `probeA.mjs` | Starts a stdio server and exits mid-turn, printing a `HANDOFF` record for observing the child lifetime and for `probeB.mjs`. |
| `probeB.mjs` | Resumes that thread in a fresh server, reads its history and asks the model which commands it completed. |
| `wsclient.mjs` | WebSocket roles for starting a turn, reattaching, steering, interrupting, reading history and listing loaded threads. |
| `zeroclient.mjs` | Disconnects for 50 seconds during a turn, then reconnects to inspect whether it continued. |
| `probe.mjs` | Scenarios for approval/sandbox enforcement, steering during a patch task, model/effort inheritance and error inspection. Approval requests are accepted unless `--deny` is passed. |
| `stdio-lib.mjs` | Shared stdio JSON-RPC helper for `probeA.mjs` and `probeB.mjs`; no standalone experiment. |

### Running them

Use absolute script paths from a scratch directory so probe logs stay there:

```sh
REPO=/path/to/agent-companion
WORK=$(mktemp -d)
cd "$WORK"

# WebSocket transport for protocol experiments.
codex app-server --listen ws://127.0.0.1:8795 &
node "$REPO/probes/codex-app-server/zeroclient.mjs" "$WORK" ws://127.0.0.1:8795
node "$REPO/probes/codex-app-server/probe.mjs" approval ws://127.0.0.1:8795 "$WORK" on-request read-only

# Prototype broker: keep its socket outside the shipped runtime directory.
SOCK="$WORK/proto-broker.sock"
node "$REPO/probes/codex-app-server/broker.mjs" "$SOCK" "$WORK/broker.log" &
node "$REPO/probes/codex-app-server/bclient.mjs" "$SOCK" start "$WORK"
node "$REPO/probes/codex-app-server/bclient.mjs" "$SOCK" attach <threadId>
```

`probe.mjs approval` deliberately accepts approvals to measure whether they allow
writes outside a read-only sandbox. The production adapter pins
`approvalPolicy: 'never'`; do not copy this probe's auto-accept handler into it.
Measured transport constraints and sandbox results belong in
[`docs/ARCHITECTURE.md` — Negative Results](../docs/ARCHITECTURE.md#negative-results)
and [`docs/RELIABILITY_REMEDIATION.md`](../docs/RELIABILITY_REMEDIATION.md).
