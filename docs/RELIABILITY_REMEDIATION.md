# Codex delegation — reliability evidence

Measured constraints behind the Codex adapters, detached broker and recovery guards.
The experiments used codex-cli 0.147.0 and Claude Code 2.1.226 in August 2026 unless
another version or date is named. These are dated observations, not fresh measurements
of each CLI release. The harnesses are in [`probes/`](../probes/README.md); they run real
models and are not unit tests.

[`ARCHITECTURE.md`](ARCHITECTURE.md) owns the current layer boundaries, routing and
state layout. The section numbers and evidence IDs here are cited by source comments
and tests.

## 0. Host and process constraints

- **S1 — Control is transport-specific.** `codex exec` has no mid-flight control
  channel. The app-server's steer, interrupt and running-thread resume are measured
  in §2.
- **S2 — Claude's inline MCP lifetime is shared.** Overlapping subagents share one
  bridge process, even across different agent types with byte-identical inline config.
  That process receives SIGINT when the first subagent finishes; a survivor's
  `agent_wait` fails with `MCP error -32000: Connection closed`. Non-overlapping
  invocations get a fresh process. This measurement concerns Claude's inline server;
  the host-specific registration boundary is in `ARCHITECTURE.md`.
- **S3 — File-backed stdout determines exec survival.** The real-binary 2×2 matrix:
  pipe + no detach → `turn_aborted` after 2.2 s; pipe + detached → `turn_aborted`
  after 8.0 s; file + no detach → `task_complete`, still writing 38.8 s after the
  parent died; file + detached → `task_complete`. `detached:true` is neither
  necessary nor sufficient. A child whose stdout is not a live bridge pipe needs
  an owner and a reaper.
- **S4 — Progress is not the work product.** The exec census and salvage limits are
  recorded under F7; the digest's atomicity and ownership measurements are W0.2
  and W1.4′.
- **S5 / F9 — macOS timers count sleep.** libuv on darwin uses
  `mach_continuous_time()`, which counts suspend; Linux uses `CLOCK_MONOTONIC`,
  which does not. In the incident, `pmset -g log` recorded sleeps of 5,247 s and
  3,523 s, and the bridge's 40-minute timer fired **2.6 s after wake**. Ubuntu CI
  cannot exercise the macOS suspend behaviour. W0.1 keeps the clock injectable.

**Host wait budgets.** The Claude Code 2.1.226 binary's stdio idle window is
1,800,000 ms, polled every 30 s; its default wall limit is about 27.8 h. An
`env: { MCP_TOOL_TIMEOUT }` entry reaches only the child and does not configure
that host timeout. A sibling `timeout` on the server entry sets the wall budget
and floors the idle window. See `ARCHITECTURE.md` **Host budgets and observability**
for the template settings and the two Claude host-shell variables.

**Progress notifications are not a model channel.** A 70 s silent MCP call aborts;
the same call emitting progress completes. The notifications reset the idle
watchdog, but their payload reaches the TUI spinner, not the model.

## 1. Incident and exec evidence

**F1 — First-finisher teardown.** On Claude's inline MCP lifecycle, a companion
subagent returning can close the shared bridge while another job is running (S2).
The status subagent is a trigger only because it can finish quickly. Incident job
`codex-msk0v4yt-8m5a` was sent at 06:58:11 and a fresh bridge appeared at 07:02:01,
229 s into the 480 s default wait. The negative control, `codex-mslng36t-q0dn`, ran
3,597 s on one bridge without a second subagent. No signal reaches the exec child:
it dies of EPIPE at its next stdout write, measured at 1 ms for a 1 Hz writer and
56 s for a Codex turn that writes rarely. A live pid therefore does not prove
recoverability. §2 measures the detached broker's survival boundary.

**F4 — The bridge is not an index mutator.** Across the seven incident rollouts,
Codex ran zero content-mutating git commands. A concurrent Claude session ran
`git restore --staged` at 2026-08-08T07:05:27.781Z. Even a bare `git status` can
rewrite `.git/index` to refresh its stat cache: measured hash change
`af229e77` → `fa39f40b` without a staging command. An index fingerprint alone is
not evidence of staging.

**F5 — A refusal must survive the subagent.** The bridge returned
`STRENGTH_UNCONFIGURED` in 23 ms; the companion subagent re-sent 30 s later with
`target:"codex"`, although the parent's 7,352-byte dispatch named no target or
fallback. Both templates prohibit substituting routing input after a refusal.

**F6 — Descriptor payload cost.** The incident's global status payload devoted
5,744 B, 85.6 % of its bytes, to `targets: listTargets()`. Global status still
includes target descriptors; that measurement is not a byte count for today's
registry. Per-job status avoids that global list.

**F7 — Exec progress and salvage limits.** `codex exec --json` emits no text deltas.
The measured runs emitted substance as one atomic message at turn end
(903–5,596 chars); intermediate messages were 211–418-char preambles. The two
aborted jobs yielded only 302 and 590 chars, about **0.2 %** of their 228–296 KB
rollouts. A reasoning-heavy, tool-free turn can therefore have no intermediate
progress ticks. App-server deltas and `thread/read` have different semantics (§2).

The live exec stream is also lossy: two sandbox-denied-write runs omitted
`command_execution` items present in their rollouts. Controls ruled out both
“only the first command streams” and “all non-zero exits are dropped”; the general
rule is unknown. `--output-last-message` is never written on SIGTERM or
`turn.failed`, and SIGTERM produces no ThreadEvent abort marker.

The rollout and live stream are different schemas. In the seven-rollout corpus,
16 lines exceeded 32 KB: fourteen tool outputs, a 46 KB `session_meta` header,
and a 34 KB user message. Reasoning reached 5,109 B but carried encrypted content
with an empty summary. A size cutoff or a live-stream parser cannot safely stand
in for a rollout reader.

**Exec timing corpus.** Across 60 completed sessions and 1,339 inter-event gaps:
p95 = 61.7 s, p99 = 192.8 s, max = 600.3 s. A 240 s idle cutoff would false-trip
about 4 % of healthy sessions; 900 s tripped none in this corpus. This is one
machine, user and reasoning-effort setting, not a portable kill threshold. The
exec adapter uses a wall deadline and has no idle watchdog. A deliberately slow
MCP server (`sleep 45`, `startup_timeout_sec=40`) delayed `thread.started` beyond
15 s despite its usual +0.20 s arrival. The measured last-stdout-to-close gap was
1.2 s.

## 2. App-server and broker evidence

`CODEX_RUNTIME_ADAPTER=appserver` selects a detached broker owning one
`codex app-server` over stdio. `exec` is the default. The broker, rather than a
bridge-owned app-server child, supplies the survival property.

### Running-thread recovery — measured 2026-08-10

Bridge A opened a thread and started a ~60 s turn (three sequential `sleep 12` shell calls).
At t≈19 s, **A was SIGKILLed** (its own pid, mid-turn, during the shell work). Bridge B then
connected fresh and called `thread/resume`.

```
A  t=0.16  thread/start   -> thread 019fea8b-7cfb…, path=~/.codex/sessions/…/rollout-…jsonl
A  t=0.17  turn/start     -> turn 019fea8b-7d80…, status inProgress
A  t=5.33  item/agentMessage/delta  "Starting" / " the" / " three" …   ← token-level stream
A  t=7.77  item/started commandExecution  "/bin/zsh -lc 'sleep 12 && echo STEP1'"
   ── kill -9 A ──   (daemon survives; `pgrep` shows the turn already on STEP2)
B  t=0.02  thread/resume  -> returns in 20 ms, SAME thread
B  t=5.86  item/started commandExecution  "…sleep 12 && echo STEP3"      ← same turnId
B  t=17.82 item/commandExecution/outputDelta  "STEP3\n"
B  t=21.46 item/completed agentMessage  text:"FINISHED"  phase:"final_answer"
B  t=22.05 turn/completed  status completed, durationMs 60684
```

**Zero work lost, zero re-prompting, same `turnId`** —
`019fea8b-7d80-7be2-8885-a9b112516e93` throughout.

The real-bridge probe `probes/smoke/appserver.mjs` recorded 17/17 assertions on
2026-08-11: bridge A was SIGKILLed mid-turn, the broker, app-server and shell
work survived with zero bridges attached, and bridge B resumed the same thread.
The job completed 72.6 s after the kill with its answer and A's streamed digest
intact. Two assertions read the applied sandbox policy from the rollout.

A separate zero-client experiment left the turn running for 50 s. On reattach,
`thread/resume` reported `status:{type:"active"}`, delivered the remaining live
events, and completed `THREEDONE` with `durationMs:83511`.

### Broker lifetime and routing

**stdio alone gives NO survival.** `codex app-server` spawned as a child dies when its stdio
parent exits, and the in-flight turn ends `turn_aborted / reason:"interrupted"` — the same
failure as `codex exec`. The broker, not the transport, is what buys survival, and the broker
must therefore be long-lived and detached from any bridge process.

The broker experiment disconnected client 1 at t=6.2 s, spent 21 s with zero
clients, then let a fresh client resume the active thread and receive
`BROKERDONE`.

**Two-tier durability, both tiers measured:**

- *Bridge dies:* nothing lost — the broker keeps the turn running.
- *Broker dies:* only the in-flight turn is lost. A fresh broker resumed the dead
  broker's thread from disk and the model knew exactly where it stopped — *“You asked for
  `sleep 40 && echo LONG`; no, it was interrupted before completion.”*

**Socket presence is not liveness.** SIGKILL killed the broker's app-server child
without orphaning a process, but left the socket file. Connecting returned
`ECONNREFUSED`. The current connect probe permits unlink only on `ECONNREFUSED`,
`ENOENT` or `ENOTSOCK`; an indeterminate error such as `EMFILE` or `EACCES`
refuses startup with `BROKER_SOCKET_INDETERMINATE`.

**Concurrency requires subscription routing.** Two simultaneous clients on separate
threads received their correct `ALPHA` / `BETA` answers, but broadcasting also
exposed each thread's events to the other client. The broker routes by thread
subscription. Connection-scoped notifications have a separate decline/drop rule;
see `ARCHITECTURE.md` **Blast radius**.

**Loaded is not active.** `thread/loaded/list` identifies loaded threads, including
completed and interrupted ones. Both reapers read their turns and require
positive idle/terminal evidence; unreadable or unknown state keeps the broker
alive. Broker clients, host heartbeats and bridge leases supply the other
lifetime guards.

### Error taxonomy

These measured errors all use JSON-RPC `-32600`; their messages distinguish them:

- `no rollout found for thread id <id>` — `thread/resume` has nothing readable on disk.
- `thread not loaded: <id>` — `thread/read` has no readable rollout for that id.
- `thread not found: <id>` — interrupt/steer cannot find the thread in this process;
  it may still be recoverable from disk.
- `no active turn to steer` / `no active turn to interrupt` — an idle thread or a
  turn that has ended.
- `expected active turn id A but found B` — a stale turn id; the request fails
  rather than controlling the wrong turn.

`probes/codex-app-server/unloaded.mjs` measured a completed thread after killing
its app-server, then asked a fresh app-server:

| call | result |
|---|---|
| `thread/loaded/list` | `[]` — not loaded here |
| `thread/read` | OK, full transcript, without a prior resume |
| `turn/interrupt` / `turn/steer` | `-32600 thread not found: <id>` |
| `thread/resume` | OK, `status:{type:"idle"}` |

An all-zero, nonexistent thread id also yields `thread not found`; that message
cannot establish loss. The adapter resumes any thread this connection did not
start before interrupting or steering it. W1.3′ keeps this distinction in failure
classification.

**`turn/start` on a busy thread succeeds**, returning another turn id. The adapter
must check activity before dispatch, or it can double-dispatch work.
`turn/interrupt` returns `{}`; the turn then settles `interrupted` with no answer.
Steer requires `expectedTurnId`, and interrupt requires `turnId`; omitting either
fails deserialization. The active-id and confirmation measurements are in
**Wave 3 — thread continuity**.

### Sandbox and configuration

**Approval auto-accept silently defeats the sandbox.** Measured matrix:

| `approvalPolicy` | `sandbox` | approvals fired | outcome |
|---|---|---|---|
| `never` | read-only | 0 | write blocked |
| `on-request` | workspace-write | 0 | in-sandbox write succeeded |
| `on-request` | read-only + `accept` | 1 | write succeeded past the sandbox |
| `on-request` | read-only + `decline` | 2 | blocked; turn continued |

The adapter pins `approvalPolicy:'never'` structurally. `thread/start` and
`thread/resume` both receive an explicit sandbox mode and approval policy.
The exec resume experiment likewise showed that omitting the sandbox override
re-derives it from config, with a read-only default; continuity alone does not
preserve the requested sandbox.

**Network policy lives on the turn.** `thread/start` / `thread/resume` take a
bare sandbox mode, while `turn/start` takes `sandboxPolicy`. The app-server's
network defaults are restrictive; omitting exec's network override defers to
config. Both adapters explicitly send the resolved setting. Measured 2026-08-11:
`workspaceWrite` with `networkAccess:true` produced
`turn_context.sandbox_policy = {"type":"workspace-write","network_access":true,…}`
in the rollout while preserving the configured model and effort.

The mode enum is kebab-case; policy tags are camelCase. Against the real 0.147.0
server, requests aimed at an all-zero thread id accepted `workspaceWrite` with a
boolean network flag, `readOnly` with `false`, and `dangerFullAccess` far enough
to return `thread not found`. `workspace-write` as a policy tag, a string network
flag, and a missing `type` all failed deserialization. The contract checker
validates request field presence, not these nested shapes; the adapter tests
assert the measured tag vocabulary.

A per-turn `sandboxPolicy` replaces the policy; it does not patch it. Its default
`writableRoots:[]` does not carry extra roots from config.toml. The job cwd is
separately recorded in `turn_context.workspace_roots`; additional configured
roots remain an unmeasured limitation.

**Config inheritance works.** Omitting the model preserves the user's configured
model and effort. `threadParams` adds a model only for a profile override.
`session_meta.originator` comes from `clientInfo.name`; `source` defaults to
`"vscode"`. Each thread starts its configured MCP servers: the measured
`codex_apps` and `node_repl` readiness times were 0.2–6.4 s.

### Transport and contract

The broker exposes a UDS and owns app-server stdio. The measured alternatives
have different contracts: `--listen unix://` accepted a connection then closed
it without answering `initialize`; `app-server proxy --sock` targets the managed
daemon's control socket; `app-server daemon start` required a standalone install
at `~/.codex/packages/standalone/current/codex`. The measured WebSocket surface
is experimental, has bounded queues and reports overload as `-32001`.

There is no protocol version field. The generated fixture
`lib/codex-app-server-contract.json` records **codex-cli 0.164.0** as provenance.
The drift test and broker boot probe compare schemas through `compareContracts`;
a version-only change is not drift. The broker reports `match`, `drift` or
`unverified` and continues serving. Regeneration is through
`scripts/gen-codex-app-server-contract.mjs`.

## 3. Evidence behind the guards

**W0.1 — Clock seam.** Adapter durations use an injectable clock because macOS
and Linux have different suspend semantics (S5), not because timing assertions
are inherently flaky.

**W0.2 — Atomic digests.** A non-atomic writer produced 20,945 empty reads out of
119,401 concurrent reads. Both digest writers use `writePrivateFileAtomic`.
The cancellation test also pins that a failed pid kill leaves no cancellation
marker behind.

**W1.1 — Early thread-id capture.** Exec's `thread.started` was line 1 at +0.20 s
in 12/12 runs. Its callback persists the id while the run is in flight; an error
must not overwrite a captured id with null. App-server `thread/start` returns
the id and rollout path before the turn starts. Exec item ids are turn-scoped
and restart at `item_0` across resumes.

**W1.2′ — Collector evidence.** `item.started` carries the command while it runs
(12 s gaps measured); waiting for `item.completed` hides in-flight work.
Completion adds status, exit code and output to the same entry. In the 0.147.0
exec census, `item.updated` never occurred, and reasoning, file-change, MCP,
web-search and todo items were defined but unobserved. Their parser branches
are not live validation of those shapes.

**W1.3′ — Failure classification.** Only `runtime_unavailable` suggests checking
the binary. `bridge_lifecycle`, `runtime_transport`, `thread_not_resumable` and
`unknown` preserve other causes. Definitive bridge details take precedence over
text heuristics. `bridge_transport_closed` belongs to `bridge_lifecycle`.
The unrecoverable-thread signatures are the first two in **Error taxonomy**,
not the bare `-32600` code or `thread not found`.

Classification uses error/stderr evidence, not assistant stdout. Display retains
both channels: a bad model produced empty stderr with its reason on stdout;
a bogus resume produced empty stdout with its reason on stderr. Nested JSON
error strings need one level of unwrapping. Timeout and cancellation retain
their error text.

**W1.4′ — Hydrate ownership guard.** Another live bridge's non-terminal job must
not be retired. Its streamed digest must survive recovery and every later
render. An empty accumulator rendered over a live digest shrank it from
11,754 B to 228 B. A separate recovery case with a persisted answer shrank
7,507 B to 351 B when the first live delta arrived. `writeJobDigest` carries
forward the actual text, not a latched decision or a size comparison: a shorter
follow-up answer is valid. The regression tests exercise both paths.

**W2.1 — Envelope evidence.** Routing errors omit empty candidate lists.
`ms_since_last_event` is not necessarily a progress timestamp: without an inspect
value, job responses use elapsed job age, or zero at terminal. Global status
includes target descriptors, runtime blocks, threads and running-job routing;
`diagnostics:true` adds doctor/profile detail.

### Wave 3 — thread continuity

**F8 / F10 / F11.** The exec CLI's thread id stayed stable across four resume
rounds, all appending to one rollout. The bridge's exec adapter is single-shot;
app-server supplies its reply and recovery surface. Follow-up app-server sends
resume the companion id stored for the caller's thread and profile. The host
names each agent-companion conversation; `ARCHITECTURE.md` **Routing Contract**
defines that identity and the busy-thread refusal.

**W3.3′ — Control requires the active turn id.** On codex-cli 0.147.0,
`turn/steer` without `expectedTurnId` and `turn/interrupt` without `turnId`
both returned `-32600 Invalid request: missing field`. Both fields remain
required in the generated contract. The adapter resolves the id from the live
job or `thread/read`'s last `inProgress` turn and throws if neither supplies it.
A completed id cannot control a second running turn: both methods returned
`expected active turn id A but found B` in that experiment.

Both fakes validate required fields and refuse unimplemented methods. They do
not claim that an absent fixture method is absent from the binary: the measured
0.147.0 binary accepted 136 methods while its generated schema exposed 95.
A restart-only smoke test passing 15/15 gives no evidence for steer/interrupt;
`probes/smoke/appserver-control.mjs` separately recorded 18/18 on 2026-08-11,
covering both the banked turn id and the restarted bridge's read fallback.

**A steer is confirmed, not assumed.** RPC acceptance is `steered`; observing the
matching injected `userMessage` is `steer_confirmed`. The opening prompt is also
a `userMessage`, so confirmation matches the injected text. The default window
is 5 s (`AGENT_COMPANION_CODEX_STEER_CONFIRM_MS`). An unconfirmed steer can still
land at the next model boundary: measured 130 s during reasoning, and 0.14 s
when sent at the first `fileChange` event. That patch completed as one intact
400-line file, no further files were created, and the turn answered `PINEAPPLE`.

## 4. Evidence limits

- **`thread/read` tool activity.** The measured response (`itemsView:"full"`)
  contains messages and their `commentary` / `final_answer` phases, but no
  command or reasoning items present in the same rollout. It is an answer
  salvage channel, not a demonstrated tool-activity record.
- **Exec `file_change`.** No such item appeared in the read-only census. Its
  `{files:[…]}` versus `{path,kind}` shape remains unverified; app-server's
  schema-backed `changes:[{diff,kind,path}]` does not establish the exec shape.
- **Additional writable roots.** The per-turn policy's interaction with a
  non-empty config.toml roots list needs a measurement (§2).
- **Shared broker environment.** Executable identity is checked before reuse;
  other differences between dispatching bridges' environments are not a
  demonstrated isolation boundary.
- **Claude lifecycle.** The connection-reuse key (server name versus config
  hash), session-server survival across `/clear` and `/compact`, and whether
  first-finisher teardown is a refcount bug remain unverified.
