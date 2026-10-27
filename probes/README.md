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

## `smoke/` — end-to-end against the real bridge

These scripts drive `bridge-server/server.mjs` over MCP stdio. The repo root is
derived from the script location; override with `AGENT_COMPANION_REPO`.

| script | asserts |
|---|---|
| `smoke.mjs` | The five-tool MCP surface, unconfigured-strength refusal without empty candidates, real Codex exec work, early thread-id persistence, digest content, rollout correlation and terminal usage. Requires `reviewer` to be unconfigured. |
| `orphan.mjs` | Cannot reach its orphan checks: its send lacks a thread and its tool wrapper supplies an unsupported session-id argument. The script's checks cover exec bridge death, digest preservation, lifecycle attribution and sibling retirement notes. |
| `appserver.mjs` | An in-flight turn survives bridge SIGKILL with zero bridges alive; the replacement bridge resumes the same thread, preserves streamed output and completes the work. Reads the applied sandbox, model and effort from the rollout and checks reply/resume flags. |
| `review-loop.mjs` | A review parses the planted defect's verdict; after a fix and bridge SIGKILL, a follow-up resumes the same conversation and recalls its subject. Checks parsed verdicts, truthful status and per-turn usage on the resumed thread. Round two's verdict value is the model's judgment, not an assertion. |
| `acp-antigravity.mjs` | Antigravity completion without usage, daemon/socket/stream identity, conversation memory, cancel-and-reprompt reply, cancellation, bridge-restart recovery on the same prompt and a model pin applied through `session/set_config_option`. Requires the ACP server to be signed in; spends about six turns. |
| `appserver-control.mjs` | Live steering and cancellation with the required turn ids; distinguishes accepted steering from observed confirmation. Exercises both the banked turn id and `thread/read` fallback, and checks that an interrupted thread retains readable history. |

The smoke scripts read `~/.claude/agent-companion/` directly. Their bridge must
use that same state home. Codex smokes need routing to select Codex; a configured
default profile takes precedence over `AGENT_COMPANION_DEFAULT_TARGET`.
`smoke.mjs` also requires the exec adapter. The Antigravity probe selects its
target explicitly.

```sh
AGENT_COMPANION_HOST=claude AGENT_COMPANION_DEFAULT_TARGET=codex CODEX_RUNTIME_ADAPTER=exec node probes/smoke/smoke.mjs
AGENT_COMPANION_HOST=claude AGENT_COMPANION_DEFAULT_TARGET=codex node probes/smoke/appserver.mjs
AGENT_COMPANION_HOST=claude AGENT_COMPANION_DEFAULT_TARGET=codex node probes/smoke/appserver-control.mjs
AGENT_COMPANION_HOST=claude AGENT_COMPANION_DEFAULT_TARGET=codex node probes/smoke/review-loop.mjs
AGENT_COMPANION_HOST=claude node probes/smoke/acp-antigravity.mjs
```

After a Codex installation upgrade, capture the read-only installation and
broker comparison before running a smoke:

```sh
AGENT_COMPANION_HOST=claude CODEX_RUNTIME_ADAPTER=appserver node scripts/doctor.mjs --json
```

Doctor does not start or stop the broker. A selected/running path, version or
identity mismatch must be resolved by the bridge's guarded idle restart before
an app-server smoke establishes behavior for the selected installation.

The three app-server smokes attempt to SIGTERM only the broker pid they observed,
with no other connected client and no loaded thread outside their own set. They
do not inspect those threads' activity. SIGTERM runs socket cleanup; SIGKILL
leaves a stale socket. `probeCodexBrokerHealth` counts its own connection, so the
other-client count is `clients - 1`.

Resume is also a subscription: it drains the broker's buffered events into that
client. `appserver.mjs` therefore observes the broker without calling
`thread/resume` itself, leaving the replacement bridge to receive those events.
It verifies recovery against that bridge's own log and an anchored final answer,
not just the persisted thread id or a preamble echo. `appserver-control.mjs`
waits for the turn's user input to be readable before interrupting; otherwise
cancellation can race the rollout write and leave no input for the history check.

## `codex-app-server/` — transport and architecture validation

These scripts isolate protocol behavior. The committed wire contract is generated
from codex-cli 0.164.0 (`lib/codex-app-server-contract.json`); that provenance does
not certify a live probe run. Use the shipped broker in
`scripts/codex-app-server-broker.mjs` for production behavior.

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
