# Probes

Hand-run harnesses, not part of the shipped plugin and not part of `node --test`.
They exist because several design decisions in
[`docs/RELIABILITY_REMEDIATION.md`](../docs/RELIABILITY_REMEDIATION.md) rest on behaviour
that cannot be asserted from source — process lifetimes, sandbox enforcement, host teardown,
and an experimental JSON-RPC surface. Each script here produced a specific claim in that
document. Re-run them when the codex CLI or Claude Code is upgraded; that is exactly the
drift they are meant to catch.

They spawn real `codex` runs and therefore cost tokens. None of them touch the repo.

## `smoke/` — end-to-end against the real bridge

All five drive `bridge-server/server.mjs` over MCP stdio as a real client would, and dispatch
real Codex jobs. The repo root is derived from the script location; override with
`AGENT_COMPANION_REPO`.

| script | asserts |
|---|---|
| `smoke.mjs` | 13 checks: the five `agent_*` tools are the whole surface; an unconfigured `strength` hard-fails with `STRENGTH_UNCONFIGURED` and no silent fallback; an empty `candidates` list is withheld rather than shipped; a real Codex job completes end to end and actually does the work; **W1.1** — the thread id is persisted to the ledger *while the job is still running*; the digest carries content; the rollout is deterministically correlatable from the captured thread id; and the terminal `meta.usage` is the exec stream's `turn.completed` usage in the shared shape (`source: codex-exec`, input and output above zero, total = input + output). |
| `orphan.mjs` | 8 checks reproducing the original incident on the **exec** transport: bridge A starts a job, is SIGKILLed mid-run, bridge B hydrates on the same host session. Asserts hydrate does **not** clobber the digest, the detail is `target_child_orphaned_by_bridge_restart` rather than `target_adapter_non_resumable_after_restart`, the message never mentions `CODEX_BIN`, it names the salvage pointers, and the retirement note is a sibling file. |
| `appserver.mjs` | 17 checks running that same incident on the **app-server** transport (`CODEX_RUNTIME_ADAPTER=appserver`), where it should not be an incident at all. Bridge A dispatches a job whose turn is three sequential shell sleeps, banks the thread id (**W1.1**) and streams sub-turn text into the digest (**F7** — the exec stream emits no deltas; the task *asks* for a one-line opening message, because a preamble is the model's choice and a terse turn would fail F7 and W1.4′ on chattiness rather than on transport), then is SIGKILLed mid-turn. Asserts the broker and its `codex app-server` outlive it, the thread stays in `thread/loaded/list`, and a shell descendant of the app-server is **still running the turn with zero bridges alive**. Bridge B then hydrates on the same host session, resumes the *same* thread, and the job reaches `completed` with the expected answer ~70 s after the kill — zero work lost, no re-prompting. Also asserts the verdict is **not** the exec transport's `target_child_orphaned_by_bridge_restart`, that B's hydrate did not clobber A's streamed digest (**W1.4′** — A's text survives under "Carried forward from the previous bridge"), and that `reply_available`/`resume_available` are truthful both mid-turn and at terminal. The last two of the 17 are not part of that incident: they read the turn's sandbox back off the rollout — that `turn/start`'s `sandboxPolicy` was **applied** (`turn_context.sandbox_policy` = workspace-write with network access, not merely accepted by the server), and that applying it did not pin the model or the effort, which stay inherited from `~/.codex/config.toml`. |
| `review-loop.mjs` | 16 checks that the **review loop** is first-class on the same transport (docs/DIRECTION_ASSESSMENT.md §5): a `template: "review"` send over a three-line repository with a planted defect settles `completed` with a **parsed** `meta.verdict = "disagree"` and the defect named in the body; the codex thread id is persisted as the thread's `.sid` and the thread was opened with `thread/start` (`resumed=false` on the bridge's own log line). The defect is then fixed, the bridge is **SIGKILLed**, and a fresh bridge sends "Finding 1 has been addressed in the working tree; re-verdict." on the same `thread` — asserting the new job's `companionSessionId` equals round one's, the fresh bridge logged `resumed=true`, the body refers to round one's subject although the task never restated it, `thread/read` shows both rounds as turns of one codex thread, and `agent_status` stays truthful at terminal. Round two's verdict is asserted parsed (`agree` or `disagree`), not for its value — the model's judgment is not what is under test. Both rounds assert `meta.usage` read off `thread/tokenUsage/updated` (`source: codex-app-server`, not `partial`), and round two's is asserted to be this turn's own on the resumed thread — the app-server's `total` is thread-cumulative, and the bridge baselines it. |
| `appserver-control.mjs` | 18 checks on the **control** surface of the same transport, which `appserver.mjs` never touched: `agent_reply` steering a RUNNING turn (`turn/steer` with the `expectedTurnId` the protocol requires) and the turn obeying the injected instruction instead of the one it started with, and `agent_cancel` interrupting a running turn (`turn/interrupt` with `turnId`) with the job settling `cancelled` and **the thread surviving** — still in `thread/loaded/list`, `thread/resume` → `idle` with its last turn recorded `interrupted`, and `thread/read` still returning the history. Also asserts the steer confirmation is an *observation*: `steered` (the server accepted it) and `steer_confirmed` (the injected `userMessage` was seen coming back) are separate fields. And it exercises **both** turn-id sources against the real server: the banked one from `turn/started`, and — with the id deliberately withheld, mid-turn — the restarted-bridge fallback that reads the running turn off `thread/read {includeTurns:true}`, whose response shape nothing but the fakes asserted before. |

```sh
node probes/smoke/smoke.mjs             # expect 13/13
node probes/smoke/orphan.mjs            # expect 8/8
node probes/smoke/appserver.mjs         # expect 17/17  (~90 s; spawns the shared broker)
node probes/smoke/appserver-control.mjs # expect 18/18  (~35 s; spawns the shared broker)
node probes/smoke/review-loop.mjs       # expect 16/16  (two short review turns; spawns the shared broker)
```

After a Codex/Homebrew upgrade, first capture the read-only installation and
broker comparison with:

```sh
CODEX_RUNTIME_ADAPTER=appserver node scripts/doctor.mjs --json
```

Doctor does not start or stop the broker. A selected/running path, version, or
identity mismatch must be resolved by the bridge's guarded idle restart before
the app-server smokes are treated as evidence for the new installation.

`orphan.mjs` deliberately leaves one orphaned `codex exec` child alive for a few seconds —
that is the condition under test. It dies at its next stdout write.

All three app-server probes reap the broker they used with **SIGTERM** on the way out (never SIGKILL, which
skips the unlink handler and leaves the stale socket every later start has to probe around).
It skips the reap if another client is connected or any loaded thread is active or cannot be
proved idle. A completed/idle thread may remain loaded and no longer pins the broker. The client
gate matters because `thread/start` is a round trip: a bridge inside it holds a connection and
owns nothing yet. `probeCodexBrokerHealth` counts its own connection, so "somebody else" is
`clients - 1`, never `clients`. The bridge-side reaper and upgrade restart use the same
active-turn check plus leases and a two-phase disposal claim.

Each bridge logs into the run's temp dir (`AGENT_BRIDGE_LOG_FILE`): the restart-resume check is
asserted against B's *own* log line (`codex-appserver resume: <job> thread=<id>`, emitted by
nothing but the resume path) rather than by re-reading the thread id off the ledger, which only
bridge A ever writes. The answer check is likewise anchored and must differ from what A streamed
before the kill — the task string names the expected word, so a preamble that restates the
instruction would satisfy a substring test.

`appserver.mjs` also never calls `thread/resume` itself — resume is the status read on this
protocol, and subscribing *drains* the broker's pre-subscription ring, which would swallow the
events bridge B is about to hydrate on. `appserver-control.mjs` does resume, and may: by the
time it asks, the job it is asking about is already terminal and nothing is watching that
thread. Before interrupting, it waits (on a connection of its own, via `thread/read`) until
the turn's user message is readable off the thread: codex writes that message to the rollout
after `task_started`, and an interrupt ~2 s after `turn/start` can win that race and leave a
turn with no input text for the history check to find (measured 2026-09-10 on 0.154.0: the
rollout held `session_meta`, `task_started`, the developer message and `turn_aborted`, nothing
else). The turn is two 15 s sleeps, so the interrupt still lands mid-turn. It asserts the interrupt's turn id against the bridge's own
`agent:cancel codex-appserver interrupt` log line for the same reason `appserver.mjs` reads B's
resume line — the ledger's `turnId` only proves the *worker* banked one, not that the interrupt
sent it. (`agent_cancel` waits up to 5 s for the job to settle and then answers with the
terminal envelope, which does not carry the cancel metadata at all.)

## `codex-app-server/` — transport and architecture validation

Everything here targets `codex app-server` (first measured on codex-cli 0.147.0; the wire
contract is generated from 0.154.0 — the 0.152.1 → 0.154.0 delta was purely additive: one
client request, optional fields on `agentMessage` and `Thread`, nothing moved). The transport behavior was last fully re-measured on
0.150.1 on 2026-08-28 with identical results: all four `smoke/` scripts (12/12, 8/8, 17/17,
18/18), `unloaded.mjs`, `errs.mjs` (through the prototype broker), and `probe.mjs`'s `approval`
matrix (workspace-write/on-request wrote with 0 approvals; read-only + one accepted approval
**wrote — still escalates past the sandbox**; `--deny` blocked), `inherit` (turn_context model
`gpt-5.6-sol` / effort `xhigh` from `config.toml`, approval `never`), `sandbox` (workspace-write:
`cwd=ok`, `git=blocked`) and `errors`. Not re-run: the prototype-broker scripts `bclient.mjs`,
`conc.mjs`, the ws role scripts `zeroclient.mjs` / `probeA.mjs` / `probeB.mjs` / `wsclient.mjs`,
and the `steerpatch` scenario — every claim they made is now asserted end-to-end by the shipped
broker's smokes. `broker.mjs` was the
**architecture prototype**; the shipped broker is `scripts/codex-app-server-broker.mjs` and
the bridge-side client is `bridge-server/codex-app-server-runtime.mjs`. Read the prototype for
the *idea*, never as a description of the current design — the two gaps it left open are the
two things a naive broker gets wrong, and both are closed in the shipped one.

| script | proves |
|---|---|
| `broker.mjs` | The broker pattern. Owns one `codex app-server` over **stdio** (the stable transport), exposes a unix socket, remaps JSON-RPC ids per client, and performs the single `initialize` handshake on everyone's behalf. Its id remapping and single-handshake design survive intact in the shipped broker. Its two deliberate gaps are **now closed** — see below; do not carry them forward. |
| `bclient.mjs` | The bridge lifecycle through the broker: `start` opens a thread and disconnects; `attach` reconnects later and rides the same running turn to completion. Measured with 21 s of zero clients in between. |
| `conc.mjs` | Two concurrent clients on two threads get their own correct answers (id remapping is sound) — and demonstrates the broadcast leak that a real broker must fix. |
| `errs.mjs` | The error taxonomy. Everything is JSON-RPC `-32600` and only the *message* distinguishes cases. Catches the `turn/start`-on-a-busy-thread trap: it **succeeds** instead of rejecting. ⚠️ Every case here uses the all-zero thread id, i.e. a thread that exists **nowhere** — so its readings of `thread not loaded` and `thread not found` do not generalize to a real thread. `unloaded.mjs` is the control that shows they don't. |
| `unloaded.mjs` | The broker-restart case, and the control for `errs.mjs`. Runs a real turn, SIGKILLs the app-server, and asks a **fresh** one about the same thread. Result: `thread/read` returns the full transcript **with no prior resume** (so it *is* a disk reader), `thread/resume` succeeds `idle` (fully recoverable), but `turn/interrupt`/`turn/steer` answer `thread not found` — which therefore means "not loaded into this process", never "gone". This is why the adapter resumes before interrupting or steering a thread it did not start, and why `thread not found` is excluded from `thread_not_resumable`. |
| `probeA.mjs` | `codex app-server` over stdio dies with its stdio parent, aborting the in-flight turn — so stdio alone buys no survival. Prints a `HANDOFF` line for `probeB.mjs`. |
| `probeB.mjs` | After that server's death, a **fresh** server resumes the thread from disk with history intact — the model correctly reports which commands it never finished. |
| `wsclient.mjs` | The original gating experiment over `ws://`: client A is SIGKILLed mid-turn, client B `thread/resume`s and rides the *same* `turnId` to completion. Also has `S`/`I`/`R`/`L` roles for steer, interrupt, `thread/read` and `thread/loaded/list`. |
| `zeroclient.mjs` | A turn survives **50 s with zero clients attached**; `thread/resume` reports `status: active` on reattach and delivers the tail. |
| `probe.mjs` | Scenario runner: `approval` (the sandbox-escalation matrix), `sandbox`, `steerpatch` (steer fired mid-`apply_patch`), `inherit` (`config.toml` model/effort inheritance), `errors`. |
| `stdio-lib.mjs` | Shared stdio JSON-RPC helper for `probeA`/`probeB`. |

> **Both of `broker.mjs`'s "known gaps, deliberately left in" are closed.** Where each landed:
>
> - **Broadcast → per-thread subscription.** `SubscriptionTable` in
>   `scripts/codex-app-server-broker.mjs` routes every notification by threadId through the
>   pinned contract (`lib/codex-app-server-contract.mjs`'s `routeNotification` — 60 of 81
>   notifications carry the id flat on 0.152.1, `thread/started` nests it, 5 are scoped to the
>   connection that asked for them and are declined at `initialize` / dropped if seen, 15 are
>   genuinely global).
>   Clients subscribe explicitly (`broker/subscribe` / `broker/unsubscribe`) or implicitly on
>   `thread/start` / `thread/resume` / `thread/fork`, so the common path costs no extra
>   round-trip. A bounded ring buffers notifications for a thread nobody has subscribed to yet
>   and is **drained** into the first subscriber — which is why a client must not `thread/resume`
>   a thread it does not intend to watch. `primary(threadId)` sends a server→client request to
>   exactly one client, so two bridges can never both answer the same approval.
> - **No idle reaper → two of them.** In the broker: `startIdleReaper` / `_onInactivityTick`
>   (15 min inactivity, 60 s recheck) refuses to exit while any client is connected, while any
>   host heartbeat is fresh (`lib/heartbeat.mjs`, the same sweep the Copilot daemon uses — the
>   TTLs are imported, not restated), or while a loaded thread's
>   `thread/read {includeTurns:true}` shows an active turn or cannot prove
>   inactivity. Completed/idle loaded threads do not block. In the bridge:
>   `reapIdleCodexBroker` in `bridge-server/codex-app-server-runtime.mjs`, driven by the leases
>   and two-phase disposal claim in `lib/shared-runtime-registry.mjs`, and called on
>   `server.mjs`'s GC tick. It SIGTERMs only a pid the live broker claims as its own.

### Running them

```sh
# ws:// transport (convenient for probing; NOT for production — see the plan)
codex app-server --listen ws://127.0.0.1:8795 &
node probes/codex-app-server/zeroclient.mjs /tmp/work ws://127.0.0.1:8795
node probes/codex-app-server/probe.mjs approval ws://127.0.0.1:8795 /tmp/work on-request read-only

# broker (the PROTOTYPE, not the shipped one — see the table above)
# Deliberately not under ~/.{claude,codex}/agent-companion/runtime/: the shipped
# broker owns codex-app-server.sock there, and a prototype in the same directory
# invites a bridge to adopt it.
SOCK=$(mktemp -d)/proto-broker.sock
node probes/codex-app-server/broker.mjs "$SOCK" /tmp/broker.log &
node probes/codex-app-server/bclient.mjs "$SOCK" start /tmp/work    # prints THREADID=...
node probes/codex-app-server/bclient.mjs "$SOCK" attach <threadId>
```

> **Safety note.** `probe.mjs approval` intentionally replies `accept` to approval requests.
> That is how the escalation was demonstrated: **accepting an approval writes files a
> `read-only` thread must not be able to write.** Never copy that auto-accept into the
> adapter — production must run `approvalPolicy: 'never'`, where the sandbox is the hard
> boundary and no approval request is ever sent.

### Dead ends, so they are not retried

- `--listen unix://<path>` accepts a connection and then closes it without answering
  `initialize`. It is not a plain JSON-RPC endpoint.
- `codex app-server proxy --sock` targets the *managed daemon's* control socket, which
  requires the ChatGPT-installer standalone build at
  `~/.codex/packages/standalone/current/codex`. A Homebrew cask install fails with
  "managed standalone Codex install not found".
- Unix socket paths are subject to `SUN_LEN` (~104 chars), and `/tmp` is rejected because it
  is a symlink. `~/.claude/agent-companion/runtime/` works.
