# Reliability remediation plan — Codex delegation

**Revision 2.** Revision 1 was root-caused from source and forensics. This revision was then
attacked by seven probes running **live experiments** (≈24 real `codex exec` runs, an
instrumented stdio MCP server driven by the real Claude Code 2.1.226 binary, a 2×2
process-kill matrix against the real codex binary, a 60-session/1,339-gap timing corpus) and
**primary-source research** (libuv source, Claude Code docs, the codex app-server JSON
schema). Five of revision 1's structural claims did not survive.

Everything below is either measured on this machine or cited. Where something is design
rather than evidence, it says so.

---

## 0. What changed since revision 1

| # | Revision 1 said | Evidence says |
|---|---|---|
| **S1** | Codex has no live control channel; mid-flight re-steering is impossible | **False.** `codex app-server` is a JSON-RPC 2.0 daemon (`--listen stdio://\|unix://\|ws://`, 95 client methods, 70 notifications) with `turn/steer` (inject input into a **running** turn), `turn/interrupt` (cancel, thread stays live), `thread/resume` (**rejoins a running thread**), `thread/read{includeTurns}`, and `item/*Delta` streaming. Proven live: a running 3×`sleep 20` turn was steered at t=12 s and the model abandoned its plan and answered `PINEAPPLE`; `turn/interrupt` returned `turn/completed status:"interrupted"`, and the next turn on that thread recalled the full history with no restart. |
| **S2** | Every companion-subagent spawn starts a new bridge and the host disposes the previous one | **Wrong mechanism.** Concurrent subagents **share one bridge process** — even across *different* agent types with byte-identical inline config. That shared process is **SIGINT'd when the FIRST of them finishes**; the survivor's in-flight `agent_wait` dies with `MCP error -32000: Connection closed`. Only non-overlapping invocations get a fresh process. Docs confirm: *"Inline servers … are connected when the subagent starts and disconnected when it finishes. String references share the parent session's connection."* |
| **S3** | `detached:true` + file-backed stdout is what makes a job survive | **Half wrong.** 2×2 with the real binary: pipe+no-detach → `turn_aborted`(+2.2 s); pipe+**detached** → `turn_aborted`(+8.0 s); **file**+no-detach → **task_complete**, output still growing 38.8 s after the parent died; file+detached → task_complete. **File-backed stdout alone gives survival; `detached` is neither necessary nor sufficient.** No signal ever reaches the child — it dies of EPIPE at its next stdout write. |
| **S4** | The live digest is the salvage artefact | **False, measured.** Codex emits its substance as **one atomic message at turn end** (903–5,596 chars at t == total duration); every intermediate message is a 211–418 char preamble. On the two jobs that were actually aborted, a live digest would have held 302 and 590 chars — **~0.2 %** of a 228–296 KB rollout. Worse: `writeOpenCodeDigest` is **not atomic** (20,945 of 119,401 concurrent reads returned 0 bytes), and hydrate's blind rewrite was measured shrinking a live digest **11,754 B → 228 B**. |
| **S5** | The idle watchdog needs a suspend guard, and the two must share one tick | **Non-problem on the production platform.** libuv on darwin uses `mach_continuous_time()`, which **counts sleep** — so `setTimeout` is already a correct wall deadline across suspend (confirmed: F9's own 40-min timer fired 2.6 s after wake). Linux uses `CLOCK_MONOTONIC`, which does not — so the two platforms have *opposite* semantics and ubuntu CI cannot exercise production behaviour even in principle. |

Two more, smaller but real:

- **`env: MCP_TOOL_TIMEOUT: "1320000"` in the agent frontmatter is inert.** Proven: the child
  receives the variable, the host ignores it. The field that works is a **sibling
  `timeout: 1320000`** on the server entry, which both raises the wall clock and floors the
  idle window. This is a live bug in the shipped template.
- **The real MCP budget** (from the 2.1.226 binary): stdio idle window **1,800,000 ms**
  (30 min), polled on a 30 s tick; wall clock default ~27.8 h. `clampWaitSec`'s 1200 s ceiling
  therefore has **600 s of headroom** and needs no change — but `server.mjs:18-20`'s "600 s
  stream-idle watchdog" comment is wrong and must be fixed.

---

## 1. What actually happened

| # | Reported as | Verdict | Actual mechanism |
|---|---|---|---|
| F1 | A status query kills in-flight jobs | **wrong trigger, wrong mechanism** | **A companion subagent *returning* is what kills its job.** Overlapping subagents share one bridge process; it is SIGINT'd when the first finishes. Status is only special because it is the *fastest thing that can finish*. Confirmed against the incident: job `codex-msk0v4yt-8m5a` was sent at 06:58:11 and the new bridge appeared at 07:02:01 — 229 s in, well inside the 480 s default wait, i.e. the owning subagent had returned. Negative control: `codex-mslng36t-q0dn` ran 3,597 s on one bridge with no second subagent. The child then dies of EPIPE at its next stdout write (measured: 1 ms for a 1 Hz writer, 56 s for a codex turn that writes rarely) — **no signal reaches it**. |
| F2 | Dead jobs discard on-disk work | **confirmed, and worse** | Single-shot CLI jobs have one content channel (`job.adapterResult`), populated only after the `await`. Hydrate then rewrites the digest from `adapterResult \|\| null` (`server.mjs:2855`) — measured shrinking a live 11,754 B digest to 228 B. And because codex emits its answer atomically at turn end, *no* live-progress design can salvage an aborted job's work product; only the rollout has it. |
| F3 | Error text misdiagnoses the failure | **confirmed** | `formatTerminalContent`'s `unreachable` branch (`server.mjs:1088-1108`) splits on **target**, not failure class, so every non-copilot lifecycle event inherits `verify CODEX_BIN…` from `lib/target-registry.mjs:176-178`. |
| F4 | The Codex sandbox mutated the repo index | **refuted** | Codex ran **zero content-mutating git commands** across all seven rollouts. The bridge runs zero git anywhere. The mutator: a **second concurrent Claude Code session** (`cfb725cd`) which at `2026-08-08T07:05:27.781Z` ran ``git diff --cached --name-only \| grep -vE … \| xargs git restore --staged``. (Note for any future fingerprinting idea: a bare `git status` rewrites `.git/index` to refresh the stat cache — measured `af229e77` → `fa39f40b` with no staging command.) |
| F5 | `strength` advertised but not wired | **refuted** | The bridge returned `STRENGTH_UNCONFIGURED` in **23 ms**. The **companion subagent** then re-sent 30 s later with `target:"codex"` and no strength — a reroute the parent never asked for (the parent's 7,352-byte dispatch contains zero occurrences of "codex", "opencode", "copilot" or "fallback"). |
| F6 | Status is unusable as a liveness probe | **confirmed** | `targets: listTargets()` ships unconditionally on two surfaces (`server.mjs:2453`, `:1994`) — 5,744 B, 85.6 % of the payload. |
| F7 | No progress signal for Codex | **confirmed, and partly unfixable on this transport** | The digest is written exactly twice. Worse: `codex exec --json` emits **no delta events at all** — progress granularity is one tick per shell command, and a reasoning-heavy, tool-free turn produces **no intermediate ticks whatsoever**. Real sub-turn progress exists only on the app-server stream (`item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/reasoning/textDelta`). |
| F8 / F10 | No thread continuity for Codex | **confirmed, buildable, verified** | `codex exec resume <UUID> [PROMPT]` works; the thread id is **stable across resumes** (4 rounds verified) and all turns **append to the same rollout file**, so a write-once durable mapping is correct. |
| F9 | Watchdog burns 10 min, produces nothing | **refuted** | macOS sleep (`pmset -g log`: Idle Sleep 13:56:53 IST / 5,247 s; Maintenance Sleep 15:49:19 / 3,523 s). Shape A's subagent never called `agent_send`. The bridge's own 40-min timer fired **2.6 s after wake** and produced an honest terminal status — i.e. the timer was already correct. |
| F11 | No `reply` for Codex | **refuted as stated** | Impossible through the **`codex exec` transport** — that is an adapter choice, not a codex limitation. `turn/steer` is real mid-flight injection. |

### The three real defects

1. **The bridge process's life is bound to a subagent's life**, and the codex child's life is
   bound to the bridge's stdout pipe. Two structural fixes, both cheap: **session-scope the
   bridge**, and **stop hydrate retiring/clobbering jobs it does not own**.
2. **Single-shot CLI jobs have no durable event channel.** The repo already solved this for
   Copilot (`promptEventsPath` + `appendPrivateFile` + `readPromptEvents`); codex should reuse
   it rather than invent a third mechanism.
3. **The bridge learns a codex thread id only after the job is over** → F8, F10, F11.

---

## 2. The decision that gates everything

**Codex transport: the `app-server` daemon, or the `exec` pipe?**

This is now the only decision that matters, because it determines whether roughly half the
plan gets built or deleted.

| | `codex exec` (today) | `codex app-server` |
|---|---|---|
| Survives bridge teardown | only with file-backed stdout (+ orphan risk) | **yes** — bridge drops a socket client, not a job |
| Progress | one tick per shell command; none at all on a reasoning-only turn | `item/*Delta` — real sub-turn streaming |
| Mid-flight steer | impossible | `turn/steer` ✅ |
| Cancel | SIGTERM, thread lost | `turn/interrupt`, thread stays live ✅ |
| Reattach after restart | no | `thread/resume` rejoins a **running** thread ✅ |
| Salvage | rollout file parsing (two schemas, encrypted reasoning) | `thread/read{includeTurns:true}` over RPC ✅ |
| Liveness | pid probe (PID-reuse-sensitive, and "alive" means "about to die") | `thread/loaded/list` — authoritative ✅ |
| Maturity | stable, shipped, tested here | **`[experimental]`** |

Adopting app-server **deletes** W2.2′, W3.1, W3.2′, W3.4′ and W4.3′ outright and reduces
W1.2′ and W1.4′ to protocol calls. It is also the pattern this repo already applied twice
(`copilot-acp-daemon.mjs` + `daemon-client.mjs`; `opencode serve` +
`opencode-server-runtime.mjs`) — and unlike Copilot, where 1,798 lines had to be authored,
**codex ships the daemon**. Estimated adapter: 150–300 lines mirroring
`opencode-server-runtime.mjs`, behind `CODEX_RUNTIME_ADAPTER=appserver|exec` (mirroring the
existing `OPENCODE_RUNTIME_ADAPTER=server|cli` switch), keeping `exec` as the fallback so
every existing test survives.

### The gating experiment — RUN 2026-08-10, PASSED

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

**Zero work lost, zero re-prompting, same `turnId`** — `019fea8b-7d80-7be2-8885-a9b112516e93`
throughout. This is precisely the failure that destroyed ~4 minutes of paid work twice in the
field report, and it is eliminated outright.

Four more results from the same session:

- **`thread/loaded/list`** returns `{data:[threadId,…]}` — an authoritative liveness primitive,
  immune to PID reuse. It replaces every `process.kill(pid,0)` heuristic in W1.4′.
- **`thread/read{includeTurns:true}`** returned the full transcript in **2.2 KB**, with every
  `agentMessage` carrying **`phase: "commentary" | "final_answer"`** — which solves the exact
  problem that made the exec digest worthless (preamble vs substance). ⚠️ **Caveat:** it
  returns *messages only* — no `commandExecution`, no `reasoning` items, though the rollout for
  the same thread has all three. So it is a complete **answer** salvage channel but **not** a
  tool-activity record.
- **`turn/steer` on a `workspace-write` turn**: accepted immediately (echoes the same
  `turnId`), injected as a `userMessage` item **at the next model boundary** — accepted at
  t=25.1 s, injected at t=155.5 s because the model was mid-reasoning. The turn then obeyed it
  (`PINEAPPLE`, `phase:"final_answer"`) and **created zero files** — no partial or corrupt
  state. ⚠️ Still unverified: the steer landed during *reasoning*, not during `apply_patch`.
- **`thread/start` returns the rollout `path` directly**, so W3.4′'s filename-correlation
  reasoning is unnecessary on this transport.

**Deployment note — do not use `app-server daemon`.** `codex app-server daemon start` fails on
this machine: *"managed standalone Codex install not found at
`~/.codex/packages/standalone/current/codex`"* — it requires the ChatGPT installer's build, not
the Homebrew cask. Use **`codex app-server --listen ws://127.0.0.1:<port>`**, a process the
bridge owns exactly as it owns `opencode serve`. `unix://` was not usable here: long scratch
paths hit `SUN_LEN`, `/tmp` is rejected (*"socket directory path exists and is not a
directory"* — it is a symlink), and `/private/tmp` gave `Operation not permitted` under the
sandbox. **Build on `ws://` with a `/readyz` + `/healthz` health probe** (the server advertises
both), mirroring `opencode-server-runtime.mjs`'s base-URL model.

### Follow-up probes — RUN 2026-08-10

**The server owns the work, not the client.** A turn ran **50 s with zero clients attached**
and completed normally. On reattach, `thread/loaded/list` still listed the thread,
`thread/resume` reported `status: {type:"active"}`, the reattached client received the
remaining live events and `turn/completed` (`THREEDONE`), and `thread/read` gave the full
transcript with `durationMs: 83511`. The bridge is a *detachable observer* — which is the
whole property this plan needs.

**⚠️ Approval auto-accept silently defeats the sandbox.** Measured matrix:

| `approvalPolicy` | `sandbox` | approvals fired | outcome |
|---|---|---|---|
| `never` | read-only | 0 | write **blocked** — sandbox is the hard boundary |
| `on-request` | workspace-write | 0 | wrote (in-sandbox; no approval needed) |
| `on-request` | read-only + `accept` | 1 | **WROTE — escalated past the sandbox** |
| `on-request` | read-only + `decline` | 2 | blocked; turn continued gracefully |

So a client that blanket-approves turns every sandbox setting into `danger-full-access`.
**The adapter must use `approvalPolicy: 'never'`** unless and until it implements a real
policy. Under `never`, no `ServerRequest` is ever sent and the sandbox is authoritative.

**The approval wire contract** (needed the moment `never` is relaxed) — note the decision
vocabulary differs **per method**, and getting it wrong reads as a denial:
- `item/commandExecution/requestApproval` → `{decision}`:
  `accept` | `acceptForSession` | `acceptWithExecpolicyAmendment` | `applyNetworkPolicyAmendment` | `decline` | `cancel`
- `item/fileChange/requestApproval` → `{decision}`: `accept` | `acceptForSession` | `decline` | `cancel`
- `item/permissions/requestApproval` → `{permissions, scope?, strictAutoReview?}`
- Legacy `execCommandApproval` / `applyPatchApproval` → `ReviewDecision`:
  `approved` | `approved_for_session` | `denied` | `abort` | …
- Also in the server→client set: `item/tool/requestUserInput`, `mcpServer/elicitation/request`,
  `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`.
- A client that answers `-32601` to everything works only until the first approval.

**`turn/steer` mid-`apply_patch` is safe.** Steer fired the instant
`item/started {type:"fileChange"}` arrived. The in-flight patch completed **atomically**
(`p01.txt`, exactly 400 lines, uncorrupted), no further files were created, the steer landed
as a `userMessage` 0.14 s later, and the turn ended `PINEAPPLE`. Steering applies at the next
model boundary, never mid-write.

**Config inheritance works — do not pin.** With `model: null`, `turn_context` recorded
`model: "gpt-5.6-sol"`, `effort: "xhigh"` — exactly `~/.codex/config.toml`. Pass nothing and
config stays the single source of truth. Bonus: `session_meta.originator` is taken from
`clientInfo.name`, so the bridge gets a free ownership stamp; `source` defaults to `"vscode"`.

### Broker probe — RUN 2026-08-10, architecture validated

A ~100-line broker prototype (owns one `codex app-server` over stdio, exposes a UDS,
remaps JSON-RPC ids per client) was built and exercised. Results:

**stdio alone gives NO survival.** `codex app-server` spawned as a child dies when its stdio
parent exits, and the in-flight turn ends `turn_aborted / reason:"interrupted"` — the same
failure as `codex exec`. The broker, not the transport, is what buys survival, and the broker
must therefore be long-lived and detached from any bridge process.

**The broker delivers the bridge lifecycle exactly.** Client 1 connected, started a thread and
a turn, and disconnected at t=6.2 s. **21 seconds passed with zero clients.** Client 2 — a
fresh process — connected, saw the thread in `thread/loaded/list`, got
`thread/resume → status:{type:"active"}`, received the live tail and `turn/completed`
(`BROKERDONE`). That is precisely "subagent spawns, works, returns; a later subagent picks up".

**Two-tier durability, both tiers measured:**
- *Bridge dies* (every subagent return): nothing lost — the broker keeps the turn running.
- *Broker dies* (rare): only the in-flight turn is lost. A fresh broker resumed the dead
  broker's thread from disk and the model knew exactly where it stopped — *"You asked for
  `sleep 40 && echo LONG`; no, it was interrupted before completion."*

**Broker death is clean but leaves a stale socket.** SIGKILLing the broker killed its
app-server child too (stdio pipe closed) with **no orphaned processes** — but the socket file
survives, because SIGKILL skips the unlink handler. **Socket presence is not liveness:** a
connect-probe against the stale socket returned `ECONNREFUSED`, which is the correct
safe-to-unlink test. The broker must connect-probe before binding and must never infer a live
broker from a present socket.

**Concurrency is correct; broadcast is not.** Two simultaneous clients on two threads got
their own correct answers (`ALPHA` / `BETA`), so id remapping is sound. But the prototype's
notification fan-out means client A also received client B's thread events — **a real broker
must filter notifications by threadId subscription**, or every bridge sees every other job.

**Error taxonomy** (all are JSON-RPC `-32600`; only the *message* distinguishes them, so the
adapter must key on text):
- `thread not loaded: <id>` — `thread/read` on a thread that has not been resumed. **`thread/read`
  is not a disk reader: resume first, then read.**
- `no rollout found for thread id <id>` — the same signature the exec transport emits;
  the `thread_not_resumable` class already added in W1.3′ covers both.
- `thread not found: <id>` — `turn/interrupt` / `turn/steer` on an unknown thread.
- `no active turn to steer` — steering an idle thread, or a stale `expectedTurnId`.
- ⚠️ **`turn/start` on a thread with a turn already in progress SUCCEEDS** and returns a new
  turn id rather than rejecting. The adapter must check thread status (or use `turn/steer`)
  before starting a turn, or it will silently double-dispatch.
- `turn/interrupt` returns `{}` and the turn settles `status:"interrupted"` with no answer.

### Transport — this corrects the `ws://` recommendation above

`--listen ws://` works, but it is **explicitly gated as experimental/unstable with bounded
queues** (overload returns RPC `-32001`), and OpenAI's guidance is not to depend on it in
production. **stdio is the stable transport.** Two further local results:
`--listen unix://<path>` accepts a connection and then immediately closes it without
answering `initialize` (it is not a plain JSON-RPC endpoint), and `app-server proxy --sock`
targets the *managed daemon's control socket* — which needs the standalone installer build
this machine does not have, so both are dead ends here.

**Therefore: the broker pattern, not a raw socket.** A long-lived broker process owns
`codex app-server` over **stdio** and exposes a UDS to bridge processes. This is precisely
what the repo already does twice — `scripts/copilot-acp-daemon.mjs` + `bridge-server/daemon-client.mjs`,
and the detached `opencode serve` in `opencode-server-runtime.mjs`. Codex plugs into the
existing pattern rather than needing a new one.

**Version pinning is mandatory.** There is no protocol version field; schemas drift with the
CLI and breakage surfaces only as a shape mismatch. Pin the codex version and vendor
`codex app-server generate-json-schema` output as a CI drift fixture.

Remaining cost: codex boots every configured MCP server **per thread**
(`mcpServer/startupStatus/updated` for `codex_apps` and `node_repl`, ready at 0.2–6.4 s), so
thread creation is not free.

---

## 3. Plan

### Wave 0 — seams and one-liners *(no dependencies, land first)*

**W0.1 — Test seams.** Add `_impl = { now, pidAlive }` + `_setForTest` to `server.mjs` (today
it exports only `_resetForTest`) and an injectable `now` to `codex-runtime.mjs`, following the
existing idiom at `opencode-server-runtime.mjs:81-141` and `daemon-client.mjs`. Land these
**before** W1.4′/W2.2′, not after. Use a long-lived node fake bin via `CODEX_BIN` (the idiom
already in `codex-runtime.test.mjs`) rather than a real `sleep`.

**W0.2 — Hygiene.**
- `if (routing.candidates?.length)` at `server.mjs:1997` — `publicIds()` returns `[]`, which
  is truthy, so an empty list ships on `PROFILE_UNKNOWN` and `STRENGTH_UNCONFIGURED` and is
  indistinguishable from a withheld one.
- Move `cancelRequested.add(jobId)` inside the successful-kill branch of `cancelCodexRun`.
- Switch `writeOpenCodeDigest` (`opencode-runtime.mjs:197`) and `writeDigest`
  (`lib/prompt-digest.mjs:62`) to the existing **`writePrivateFileAtomic`**
  (`lib/runtime-paths.mjs:35`). Measured: 20,945 of 119,401 concurrent reads returned 0 bytes
  without it. This is a precondition for the digest being operator-facing at all.

**W0.3 — The inert timeout field.** In `templates/agent-companion.md` (and the materialized
`~/.claude/agents/agent-companion.md`, and the Codex TOML if it mirrors it), replace
`env: { MCP_TOOL_TIMEOUT: "1320000" }` with a sibling **`timeout: 1320000`** on the server
entry. Proven: `env` reaches only the bridge child and is a host no-op; `timeout` both raises
the wall clock and floors the idle window at 1,320 s > `clampWaitSec`'s 1,200 s.

### Wave 1 — stop losing work

**W1.0 — Session-scoped bridge** *(medium; no code deps)* — **the structural F1 fix**
Declare `agent-bridge` once at session scope (project `.mcp.json` or `--mcp-config`) and
reference it **by name** from the subagent frontmatter (`mcpServers: ["agent-bridge"]`).
Measured: one process for the entire session, started at session startup, exiting only at
session end. Hydrate then runs once per session instead of once per subagent invocation, and
the first-finisher shared-teardown hazard disappears entirely.
- **Cost:** the five `agent_*` tool descriptions load into the main conversation's context —
  the documented reason inline scoping exists. Mitigate with `disallowedTools` on the main
  agent, or accept it (this user's `settings.json` already allowlists all five
  `mcp__agent-bridge__*` names at session scope).
- **Do not take the plugin `.mcp.json` route without a rename plan:** plugin servers are
  namespaced `mcp__plugin_agent-companion_agent-bridge__*`, which breaks the frontmatter
  `tools:` list and the settings allowlist.
- **Measure before committing:** does a string-referenced session server survive `/clear`,
  `/compact` and `/reload-plugins`? Docs cover only plugin servers across `/reload-plugins`.
  A bridge that dies on `/compact` reintroduces the whole problem.

**W1.4′ — Hydrate ownership guard** *(small; deps W0.1, W0.2)* — **was "liveness gate"**
Hydrate must **neither retire nor rewrite the digest** of a non-terminal job whose recorded
owner pid is alive and is not this process. Reuse the existing `pidAlive()` from
`lib/shared-runtime-registry.mjs` (it already treats EPERM as alive) rather than adding a raw
`process.kill`.

> **Hard constraint:** hydrate must never call `writeOpenCodeDigest` for a job it did not
> start. A fresh bridge has `adapterResult === null` by construction; writing renders a
> header-only stub over live content (measured 11,754 B → 228 B). If retirement must be
> recorded on disk, append a footer or write a sibling `-retired.md` — never rewrite the body.

Two invariants, not one: *must not retire another bridge's live job*, **and** *must not
overwrite another bridge's digest*.

Add a **fourth branch (d) — transport-close.** The dominant failure path has **no new bridge
and no hydrate at all**: the job dies inside a live process whose transport closed under it.
The bridge cannot self-defend; detect it after the fact — on bridge start, a ledger job whose
owning bridge pid is gone *and* whose codex child pid is gone is `bridge_transport_closed`,
routed to W1.3′'s `bridge_lifecycle` class with the resume offer.

The pid probe is **telemetry, not a resumability test**: a piped, non-detached codex child is
doomed at its next stdout write once the bridge dies, so "alive" describes a window of
seconds. Drop revision 1's "events-file mtime advancing" second discriminator until W1.2′
lands — until then the bridge is the digest's only writer, so mtime freezes exactly when the
owner dies (a *dead*-detector only: advancing ⇒ alive; frozen ⇒ unknown).

**W1.1 — Early thread-id capture** *(small; deps W0.1)* — unchanged in design
Fire `onSession(threadId)` from the collector's `thread.started` branch; persist on arrival
guarded by `!jobs.get(jobId)?.sessionId`; make the post-await patch
`result.sessionId ?? jobs.get(jobId)?.sessionId ?? null` so the `child.on('error')` path
cannot clobber a good id back to null.
Verified: `thread.started` is **line 1 at +0.20 s** in 12/12 runs, with `thread_id` at the top
level. Note `item.id` is **turn-scoped** and restarts at `item_0` every turn including resumes
— do not key state on it.

**W1.3′ — Failure-class classifier** *(small; can land with W0.2)*
Four classes as before — `bridge_lifecycle` (never names `binaryEnv`), `runtime_unavailable`
(**the only class allowed to**), `runtime_transport`, `unknown` — plus two the experiments
found:
- **`thread_not_resumable`** — keyed on the `-32600 / no rollout found for thread id` stderr
  signature. This is the load-bearing new failure mode W3.1 introduces.
- **`bridge_transport_closed`** — from W1.4′(d).

Three rendering fixes the experiments forced:
- **Inline both channels, not stderr alone.** A bad model gives exit=1 with **completely empty
  stderr** and everything on stdout; a bogus resume gives **completely empty stdout** with
  everything on stderr.
- **Unwrap one level of JSON.** `error.message` and `turn.failed.error.message` arrive as a
  JSON-encoded *string* containing `{error:{message}}`.
- Ungate `error` on the `timeout` and `cancelled` paths (`codex-runtime.mjs:205`).

**W1.2′ — Live progress seam, rebuilt on the existing Copilot architecture** *(medium; deps W1.1, W1.4′, W0.2)*
Two artefacts, not three — and the mechanism already exists in this repo:
1. **Tee** raw `codex exec --json` stdout line-by-line to `prompts/codex-<jobId>.jsonl` with
   the existing `appendPrivateFile` (mirroring `copilot-sdk-runtime.mjs:699`).
2. **Render** the digest as a pure view over that file through the existing
   `refreshDigestForJob` branch point (`server.mjs:615-621`), which already forks
   copilot→`writeDigest` / else→`writeOpenCodeDigest`.

Why this beats revision 1's in-memory `snapshot()`: append-only removes the torn-read class at
the source; the events-file mtime becomes the real second liveness discriminator W1.4′ lacks;
`job.adapterResult` never has to be mutated live, so *"never route through `updateJob`"* becomes
**structurally impossible to violate** rather than a rule someone must remember; and salvage
survives a SIGKILLed bridge, which an in-memory snapshot cannot.

Collector amendments, from the verified 0.147.0 census:
- **Consume `item.started`** for `command_execution` — it carries the full `command` and is the
  *only* event that exists while a command runs (12 s gaps observed). Keying progress on
  `item.completed` alone means a long build looks frozen.
- Carry **`exit_code` + `status` + truncated `aggregated_output`** into the toolCalls entry.
  Today a failed command (`status:"failed", exit_code:1`) renders identically to a successful one.
- `item.updated` **never occurs** — do not design for it.
- Keep the `reasoning` / `file_change` / `mcp_tool_call` / `web_search` / `todo_list` branches as
  documented *defined-but-never-observed-on-0.147.0* dead code with the citation in the comment.

> **State plainly what this does and does not buy.** It is a liveness probe and a progress log.
> It is **not** the salvage artefact: codex emits its answer atomically at turn end, so an
> aborted job's digest holds ~0.2 % of the work product. And it is **not** a probe main Claude
> can use unaided — the jobId is unguessable (`server.mjs:2015`) and main has no MCP access to
> the bridge. If a bridge-free discovery path is wanted, derive it from
> `$CLAUDE_CODE_SESSION_ID` via the existing per-session job ledger.

Optionally emit `notifications/progress` from `agent_wait` on the same throttle, using the
`progressToken` Claude Code already puts in `_meta`. Verified: it **does** reset the MCP idle
watchdog (a 70 s silent call aborts; the same call with progress completes), but it is **not
model-visible** on this host — the payload lands in `progressMessagesByToolUseID` and is
consumed only by the TUI spinner. So: watchdog insurance and a human-visible spinner, never a
model channel.

### Wave 2 — make observation cheap

**W2.1 — One envelope revision** *(medium; deps W1.2′)* — design, largely untested
Compact global status by default; `targets` / `profiles` / runtime blocks / `default_model`
behind `diagnostics:true`; `threads` + per-job routing metadata behind `verbose:true`;
`strengths` unconditional. Add `last_progress_at` (explicit `null`, never substituted with
`startedAt`) and an honest `ms_since_last_event` to **both** `buildJobResponse` and the inline
`still_running` envelope. Key routing-error payloads on the error code:
routing-resolution codes get ids + a `remedy` string; `TARGET_UNCONFIGURED` /
`TARGET_UNSUPPORTED` keep the full descriptor. Report `default_model` per target or omit it.

**W2.2′ — Codex idle watchdog, rebuilt** *(medium; deps W1.2′, and only if `exec` is retained)*
**Delete the suspend guard entirely.** Two quantities, not three:
- the **unchanged wall `setTimeout`** — already correct across suspend on macOS (libuv darwin
  uses `mach_continuous_time`, which counts sleep; verified on this machine, and F9's own timer
  fired 2.6 s after wake), and
- a **clamped idle accumulator**: `idleMs += Math.min(now - lastTick, tickInterval * 2)`, reset
  to 0 on any stdout byte.

The clamp is immune to suspend *and* to event-loop starvation without detecting either, is
platform-independent by construction (macOS and Linux have **opposite** libuv suspend
semantics, so ubuntu CI cannot exercise production behaviour), and is trivially unit-testable
with W0.1's injected `now`.

Thresholds, from a 60-session / 1,339-gap corpus of every completed codex run on this machine:
p95 = 61.7 s, p99 = 192.8 s, **max = 600.3 s**.
- `CODEX_STREAM_IDLE_MS = 900_000` as its **own** env-overridable constant. Do **not** export
  the 240 s value from `prompt-supervisor.mjs` — that number was calibrated against a protocol
  that streams thought deltas; codex streams none. 240 s would false-trip ~4 % of healthy
  sessions.
- **Ship it advisory-only in v1** (annotate the digest, do not kill). The corpus is one machine,
  one user, one reasoning-effort setting; lower effort shifts the distribution left.
- `no_session` at **60 s**, measured in clamped-idle units. Do not tighten to 15 s despite
  `thread.started` arriving at +0.2 s: codex boots every configured MCP server on each spawn,
  and a deliberately slow server (`sleep 45`, `startup_timeout_sec=40`) delayed it well past 15 s.
- Add the bounded `child.on('exit')` fallback (5 s grace, then settle with
  `stdout_not_closed_after_exit`) and an absolute ceiling on the SIGKILL branch. Measured gap
  between last stdout line and `close`: 1.2 s, so 5 s is comfortable.

### Wave 3 — thread continuity *(all of it deleted if app-server is adopted)*

**W3.1 — Durable thread → codex session mapping** *(small; deps W1.1)*
Write the thread id into the **existing** thread store (`writeThreadSid` / `retireThreadSid`,
`~/.claude/agent-companion/threads/`) so it outlives `JOB_RETENTION_MS`. Verified write-once:
the thread id is stable across 4 resumes and all turns append to one rollout file.
**Add a validity check:** before routing a `send` to resume, stat
`$CODEX_HOME/sessions/**/rollout-*-<thread_id>.jsonl`; if absent, `retireThreadSid` and fall
back to a fresh run with an explicit `thread_not_resumable, started a new thread` note.
Invariants: the adapter **never** passes `--ephemeral`, and `CODEX_HOME` is explicit.

**W3.2′ — `startCodexResumeRun`** *(large; deps W3.1)*
argv: `['exec','resume',<session_id>,'--skip-git-repo-check','--json',…,'-']`.
Verified flag inventory (use `codex exec help resume` — **`codex exec resume --help` is broken
in 0.147.0** and prints top-level help listing flags resume does not accept): no `-s/--sandbox`,
no `-C/--cd`, no `--add-dir`, no `-p/--profile`, no `--search`. `--dangerously-bypass-approvals-and-sandbox`
**is** accepted, so the adapter's `bypass` mode needs no translation. Working root goes through
spawn's own `cwd` (verified: thread created under `-C dirA`, resumed from process cwd dirB,
`pwd` reported dirB).

> **Revision 1 had this backwards.** Resume re-derives the sandbox from config. With no
> override it uses `~/.codex/config.toml`, falling back to codex's own **read-only** default —
> verified three times independently: a session started `-s read-only` and resumed with no `-c`
> still returned `patch rejected: writing is blocked by read-only sandbox`. Because the adapter
> starts jobs at `workspace-write`, **omitting `-c sandbox_mode=` silently DE-escalates** the
> resumed turn and surfaces as an unexplained model refusal. On a config that pins a permissive
> mode it escalates instead. Both directions are wrong: always emit the full override set —
> `-c sandbox_mode=… -c sandbox_workspace_write.network_access=… -c approval_policy=never` —
> and add a regression test asserting a resumed EXECUTE job can still write, checked against the
> rollout's per-turn `turn_context.sandbox_policy` record.

**W3.3′ — `agent_reply` for Codex** *(medium; deps W3.2′ or the app-server adapter)*
- **Under `exec`** — terminal → new turn on the same thread; running → queued steer applied at
  turn end; running + `interrupt:true` → cancel-then-resume. Label all three as **transport**
  limitations of `codex exec`, not codex limitations.
- **Under app-server** — `agent_reply` on a running job maps to `turn/steer` (real mid-flight,
  no restart, no cost beyond tokens); interrupt maps to `turn/interrupt` (thread stays live).
- Update `lib/target-registry.mjs:147-157`: `reply:false, resume:false` and the
  "architecture-forced" comment are both wrong. It must say **transport**-forced.

**W3.4′ — Rollout backstop** *(medium; deps W1.2′, W3.1 — **cut entirely if app-server lands**)*
Promoted from "residual case only" to the **primary salvage channel** on the exec transport,
for two measured reasons: the digest holds ~0.2 % of an aborted job's work, and **the live
stream is lossy** — reproduced 2/2, `codex exec --json` silently omits `command_execution`
items that the rollout records (sandbox-denied writes; controls ruled out "only the first
streams" and "non-zero exits are dropped").
- **Preconditions:** job terminal **and** non-`completed` **and** `sessionId` known. Drop
  "digest has no content section" — after W1.2′ an aborted job's digest *always* has one (the
  preamble), which would permanently suppress the backstop that holds the real content.
- **Two independent extractors.** The rollout uses `session_meta` / `event_msg` /
  `response_item` / `turn_context` / `world_state`; the live stream uses ThreadEvent. Zero
  overlap. `custom_tool_call.input` is a **JS snippet**, not a command string — recover shell
  activity from `custom_tool_call_output`'s embedded `{exit_code, output}` keyed by `call_id`.
- **No size-based skip.** Corrected measurement: **16** lines exceed 32 KB across the seven
  rollouts (not two) — 14 tool outputs, one 46 KB `session_meta` header carrying exactly the
  correlation metadata the backstop needs, and one 34 KB user message. Reasoning maxes at
  5,109 B and is unrecoverable anyway (`encrypted_content`, empty summary).
- Consider stamping a bridge-owned `session_meta.payload.originator` as a cheap ownership
  filter: eleven rollouts from six cwds landed in one 4-minute window during this review, two
  with byte-identical filename timestamps.

### Wave 4 — contract, guards, transport

**W4.1′ — Template/doc revision pass** *(medium; lands after the contract settles)*
Both templates in one host-neutral edit (so `agent-companion.toml.test.mjs`'s divergence
assertions still pass):
- **The no-re-route clause — F5's actual fix.** On any routing-resolution error the subagent
  returns the envelope and stops. It may not substitute a `target`, `profile`, or `strength`
  the parent did not supply. Extend the existing *"MCP unreachable ≠ permission to do the work
  yourself"* prohibition (`agent-companion.md:111`).
- Compact-status render rule; the codex reply/resume precondition (`md:54`, `:252`).
- One sentence in the ANALYZE preamble (`validation.mjs:119-122`): an empty
  `git diff --cached` is an environment observation about a possibly concurrently-mutated
  shared index, never a change-set verdict.

**Corrected negative-results list** for `docs/ARCHITECTURE.md` — revision 1 wanted to enshrine
two facts that are false:
- ~~"the 600 s figure appears nowhere in this repo"~~ — it does, at `server.mjs:18-20`. **Fix
  that comment** instead: it is the MCP *tool idle* timeout (stdio default 1,800,000 ms),
  satisfied by each `agent_wait` **returning**, not by a mid-call emission. Add the measured
  budget: *1200 s `clampWaitSec` vs a 1,800,000 ms stdio idle default = 600 s headroom; never
  raise past 1500 s without a per-server `timeout`.*
- ~~"`codex exec resume` cannot reattach to an in-flight turn"~~ — true of the **exec CLI**;
  false of codex, whose app-server `thread/resume` explicitly rejoins running threads.

Facts worth recording: the bridge executes no git and writes nothing inside a job's cwd;
`handleStatus`'s body performs no lifecycle mutation (both hydrate and `adoptHostSessionId` are
latched, so a call on an already-adopted bridge re-runs nothing); disposing a stdio MCP server
sends **SIGINT to that process only** — a non-detached grandchild is never signalled and dies at
its next stdout write (EPIPE, exit 1); the agent **must** be materialized into `~/.claude/agents/`
because plugin subagents silently lose `mcpServers`/`hooks`/`permissionMode`; MCP progress
notifications reset the idle watchdog but are not model-visible; `--output-last-message` is
**not** a salvage channel (never written on SIGTERM or `turn.failed`); the ThreadEvent stream
emits **no abort marker** on SIGTERM.

**W4.2′ — CI and guards** *(medium)*
- **Adopt the existing seam idiom**, don't invent one (`_impl` + `_setForTest`; injected `now`;
  `CODEX_BIN`/`OPENCODE_BIN` fake bins). Name the hydrate assertions at `server.test.mjs:567`
  and `:603` that W1.4′ invalidates.
- **Two concurrent jobs is a blocking test, not an audit item.** One bridge process
  demonstrably serves concurrent companion subagents (measured), so per-jobId keying of all
  adapter state is a **correctness requirement**.
- A transport-close test asserting *interrupted-with-resumable-thread* — the fresh-process
  hydrate test alone passes while the dominant failure mode goes untested.
- A shared contract fixture (agent_* schema field names + error codes) asserted by **both**
  template suites, so schema changes fail CI instead of drifting.
- Digest/events GC test.
- Record the real cross-platform-suspend rationale for the `now()` seam (opposite libuv
  semantics), not "flakiness".

**W4.3′ — Move codex off the owned-subprocess model** *(large; deps the transport decision)*
- **Preferred: the app-server daemon.** A bridge replacement then drops a socket client, not a
  job. No detach, no `unref`, no file-backed stdout, no pid+deadline file, no reaper, no EPIPE
  analysis, and orphans are answered by protocol (`thread/loaded/list`) rather than by `ps`.
- **If `exec` is retained: file-backed stdout WITHOUT `detached`.** Measured to give full
  survival while retaining free group-kill reapability. Gate it on
  `lib/shared-runtime-registry.mjs` — the runtime-neutral owner module extracted out of
  `opencode-server-runtime.mjs` in A1, which already owns leases, pid liveness, stale pruning,
  idle TTL and the reaper. Construct a registry with the broker's own `registryPath` / `key` /
  `identity` / `dispose` rather than re-deriving pruning, the two-phase disposal claim, or the
  reaper. Per the project's consolidate-don't-layer rule, the ownership machinery is **not**
  greenfield and must **not** be re-written inside the codex broker.

> **Re-attributed hazard.** The orphan risk belongs to *"the child's stdout is no longer a live
> bridge pipe"*, **not** to `detached:true`. That means any implementation of W1.2′ that hands
> codex a file or `'ignore'` for stdout, or that stops draining the pipe, **ships the orphan
> accidentally** — with no one deciding to. Attach the reaper precondition to the stdio
> decision, and audit `cancelCodexRun` first.

---

## 4. Sequence

```
W0.1 seams ─┬─► W1.4′ ownership guard ─┐
W0.2 hygiene┤                          ├─► W1.2′ tee+render ─┬─► W2.1 envelope
W0.3 timeout┘   W1.1 thread-id ────────┤                     └─► [gate] transport?
                W1.3′ classifier ──────┘                            │
W1.0 session scope (independent, measure /compact first)            ├─ app-server ⇒ build adapter; W2.2′/W3.1/W3.2′/W3.4′/W4.3′ DELETED
                                                                    └─ exec ⇒ W2.2′ → W3.1 → W3.2′ → W3.4′ → W4.3′
                                                          then W3.3′ → W4.1′ → W4.2′
```

**Minimum merge.** If only one thing ships: **W0.2 + W1.0 + W1.4′ + W1.3′ + W1.1**. Small, no
cross-wave dependencies, no transport commitment, and it converts silent destruction into an
honest, attributable failure with the thread id preserved.

**Do not build W2.2′, W3.1, W3.2′ or W3.4′ before the transport decision** — all four are
exec-specific work the daemon deletes rather than reuses.

## 5. Open decisions

1. ~~**Codex transport — app-server vs exec pipe.**~~ **RESOLVED 2026-08-10 in favour of
   app-server**, by the experiment in §2. What remains is a scheduling call, not a technical
   one: build the adapter now, or land the Wave-0/Wave-1 minimum merge first and build it
   next. Recommendation: **minimum merge first** (it is small, transport-neutral and fixes the
   false-verdict/clobber bugs that hurt regardless), then the adapter.
2. **Bridge scope — session-referenced vs inline frontmatter.** Session scope is measured to
   give one process per session and kills both hazards; the cost is five tool descriptions in
   main's context. Accept, or mitigate with `disallowedTools`? And: does it survive `/compact`?
3. **Is `stream_idle` a kill or an annotation in v1?** Recommendation: annotation. 900 s
   false-trips 0/60 sessions on this machine, but that is one machine at one reasoning effort.
4. **Job retention and artefact GC.** Are digests and the new per-job events JSONL unlinked
   with the ledger row? Does `digestJobIdsFromDisk()` accumulate orphans? Unmeasured.
5. **`model` in the send payload.** Recommendation unchanged: expose per-job, **unset by
   default** so `~/.codex/config.toml` (gpt-5.6-sol / xhigh) stays authoritative. Note a bad
   `-m` gives empty stderr and a nested JSON blob on stdout — W1.3′'s unwrap is what makes a
   typo legible.
6. **Default profiles for the four strengths.** Still untested by any probe. Recommendation
   unchanged: keep the hard-fail, fix the subagent (W4.1′).

## 6. Still unverified — and the experiment that would settle each

- ~~**The app-server survival claim.**~~ **Verified 2026-08-10** — see §2.
- **Whether a session-scoped bridge survives `/clear` and `/compact`.** Gates W1.0.
- ~~**`turn/steer` mid-`apply_patch`.**~~ **Resolved 2026-08-10** — safe; the in-flight patch
  completes atomically and the steer applies at the next model boundary.
- ~~**app-server approval routing.**~~ **Resolved 2026-08-10** — full wire contract captured;
  the adapter must run `approvalPolicy: 'never'`, because auto-accept escalates past the
  sandbox. Still open: the mapping of `AGENT_COMPANION_CODEX_SANDBOX_MODE` onto
  `thread/start`'s `sandbox`, and whether the bridge should ever expose an approval policy
  other than `never`.
- ~~**The broker.**~~ **Prototyped and measured 2026-08-10** — see "Broker probe" below. Still
  open: one-broker-per-workspace vs per-host, idle reaping policy, and whether the broker
  should be spawned lazily by the first bridge or by a SessionStart hook.
- **Whether `thread/read` ever carries tool items.** It returned messages only
  (`itemsView:"full"`), while the rollout for the same thread had `custom_tool_call`,
  `custom_tool_call_output` and `reasoning`. If tool activity is wanted in a salvage digest,
  either the live `item/*` stream must be teed or the rollout still parsed.
- **Whether `-c sandbox_mode="workspace-write"` on resume actually grants writes.** Only the
  read-only direction was proven, and read-only is also the no-flag default — so it is a
  confounded control. Needs one write-mode resume.
- **`turn/steer` mid-`apply_patch`.** Only exercised mid-`command_execution`. This is the risky
  case for exposing `agent_reply` on running write-mode jobs.
- **The `file_change` item shape.** Requires workspace-write, which every probe was forbidden.
  `fileChangeToolCalls`'s `{files:[…]}` vs `{path,kind}` guess (`codex-runtime.mjs:376-383`)
  remains untested, and "Files touched" depends on it.
- **Why the stream omits some `command_execution` items.** Reproduced 2/2 for sandbox-denied
  writes; the general rule is unknown.
- **`codex mcp-server` and `codex exec-server`.** Enumerated from `--help`, never spoken.
  `exec-server`'s `--concurrent-requests` and `--exit-on-stdin-close` look directly relevant.
- **Whether the connection-reuse key is the server name or a config hash.** If it is a hash, a
  trivial frontmatter difference silently changes the sharing behaviour.
- **Whether the first-finisher teardown is a Claude Code refcount bug.** Undocumented either
  way. Worth filing upstream with the repro.
