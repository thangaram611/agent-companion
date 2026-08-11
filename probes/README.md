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

All three drive `bridge-server/server.mjs` over MCP stdio as a real client would, and dispatch
real Codex jobs. The repo root is derived from the script location; override with
`AGENT_COMPANION_REPO`.

| script | asserts |
|---|---|
| `smoke.mjs` | 12 checks: the five `agent_*` tools are the whole surface; an unconfigured `strength` hard-fails with `STRENGTH_UNCONFIGURED` and no silent fallback; an empty `candidates` list is withheld rather than shipped; a real Codex job completes end to end and actually does the work; **W1.1** — the thread id is persisted to the ledger *while the job is still running*; the digest carries content; the rollout is deterministically correlatable from the captured thread id. |
| `orphan.mjs` | 8 checks reproducing the original incident on the **exec** transport: bridge A starts a job, is SIGKILLed mid-run, bridge B hydrates on the same host session. Asserts hydrate does **not** clobber the digest, the detail is `target_child_orphaned_by_bridge_restart` rather than `target_adapter_non_resumable_after_restart`, the message never mentions `CODEX_BIN`, it names the salvage pointers, and the retirement note is a sibling file. |
| `appserver.mjs` | 15 checks running that same incident on the **app-server** transport (`CODEX_RUNTIME_ADAPTER=appserver`), where it should not be an incident at all. Bridge A dispatches a job whose turn is three sequential shell sleeps, banks the thread id (**W1.1**) and streams sub-turn text into the digest (**F7** — the exec stream emits no deltas; the task *asks* for a one-line opening message, because a preamble is the model's choice and a terse turn would fail F7 and W1.4′ on chattiness rather than on transport), then is SIGKILLed mid-turn. Asserts the broker and its `codex app-server` outlive it, the thread stays in `thread/loaded/list`, and a shell descendant of the app-server is **still running the turn with zero bridges alive**. Bridge B then hydrates on the same host session, resumes the *same* thread, and the job reaches `completed` with the expected answer ~70 s after the kill — zero work lost, no re-prompting. Also asserts the verdict is **not** the exec transport's `target_child_orphaned_by_bridge_restart`, that B's hydrate did not clobber A's streamed digest (**W1.4′** — A's text survives under "Carried forward from the previous bridge"), and that `reply_available`/`resume_available` are truthful both mid-turn and at terminal. |

```sh
node probes/smoke/smoke.mjs      # expect 12/12
node probes/smoke/orphan.mjs     # expect 8/8
node probes/smoke/appserver.mjs  # expect 15/15  (~90 s; spawns the shared broker)
```

`orphan.mjs` deliberately leaves one orphaned `codex exec` child alive for a few seconds —
that is the condition under test. It dies at its next stdout write.

`appserver.mjs` reaps the broker it used with **SIGTERM** on the way out (never SIGKILL, which
skips the unlink handler and leaves the stale socket every later start has to probe around).
It skips the reap if anyone else is on that broker — a thread loaded from another session, or a
client that is connected but has not started one yet. Those are the broker's own two idle gates
(`_cheapGatesHold`), and the second one matters because `thread/start` is a round trip: a bridge
inside it holds a connection and owns nothing yet. `probeCodexBrokerHealth` counts its own
connection, so "somebody else" is `clients - 1`, never `clients`. The bridge-side idle reaper
cannot do this job for it: `disposeBroker` refuses while any thread is loaded.

Each bridge logs into the run's temp dir (`AGENT_BRIDGE_LOG_FILE`): the restart-resume check is
asserted against B's *own* log line (`codex-appserver resume: <job> thread=<id>`, emitted by
nothing but the resume path) rather than by re-reading the thread id off the ledger, which only
bridge A ever writes. The answer check is likewise anchored and must differ from what A streamed
before the kill — the task string names the expected word, so a preamble that restates the
instruction would satisfy a substring test.

The probe also never calls `thread/resume` itself — resume is the status read on this
protocol, and subscribing *drains* the broker's pre-subscription ring, which would swallow the
events bridge B is about to hydrate on.

## `codex-app-server/` — transport and architecture validation

Everything here targets `codex app-server` (codex-cli 0.147.0). `broker.mjs` was the
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
>   pinned contract (`lib/codex-app-server-contract.mjs`'s `routeNotification` — 51 of 70
>   notifications carry the id flat, `thread/started` nests it, 18 are genuinely global).
>   Clients subscribe explicitly (`broker/subscribe` / `broker/unsubscribe`) or implicitly on
>   `thread/start` / `thread/resume` / `thread/fork`, so the common path costs no extra
>   round-trip. A bounded ring buffers notifications for a thread nobody has subscribed to yet
>   and is **drained** into the first subscriber — which is why a client must not `thread/resume`
>   a thread it does not intend to watch. `primary(threadId)` sends a server→client request to
>   exactly one client, so two bridges can never both answer the same approval.
> - **No idle reaper → two of them.** In the broker: `startIdleReaper` / `_onInactivityTick`
>   (15 min inactivity, 60 s recheck) refuses to exit while any client is connected, while any
>   host heartbeat is fresh (`lib/heartbeat.mjs`, the same sweep the Copilot daemon uses — the
>   TTLs are imported, not restated), or while `thread/loaded/list` is non-empty. In the bridge:
>   `reapIdleCodexBroker` in `bridge-server/codex-app-server-runtime.mjs`, driven by the leases
>   and two-phase disposal claim in `lib/shared-runtime-registry.mjs`, and called on
>   `server.mjs`'s GC tick. It SIGTERMs only a pid the live broker claims as its own.

### Running them

```sh
# ws:// transport (convenient for probing; NOT for production — see the plan)
codex app-server --listen ws://127.0.0.1:8795 &
node probes/codex-app-server/zeroclient.mjs /tmp/work ws://127.0.0.1:8795
node probes/codex-app-server/probe.mjs approval ws://127.0.0.1:8795 /tmp/work on-request read-only

# broker (the production shape)
SOCK=~/.claude/agent-companion/runtime/codex-broker.sock
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
