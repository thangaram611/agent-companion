# Direct-lead probes

Hand-run harnesses behind [THREAD_PLAN.md](../../docs/THREAD_PLAN.md): the lead
conversation calls the bridge itself, and the bridge wakes it when a job ends.
They measure host behaviour, not bridge code: whether a lead can call an MCP
tool, what identity the call carries, how long results reach the model, and
which out-of-band post starts a turn on an idle session. Every run writes under
`runs/` here (ignored by git). The 2026-11-22 evidence is not in git; the plan
records what it showed.

Each run uses isolated homes and a fake job server or the scripted model.
Exceptions: `run.mjs`, `tui-run.mjs` and `e2e.mjs` drive Claude Code with your
login on Haiku (budget-capped per run), `e2e.mjs` adds the free OpenCode model,
and the Antigravity part of `long/run-all.sh` uses your Antigravity login and
leaves its conversations in that account's history. Interactive `agy` may show
first-run screens; never type into it blind.

## Files

| File | Measures |
| --- | --- |
| `fixture.mjs` | Fake job server (newline JSON-RPC over stdio): a job that sleeps, then returns N KB. It can post back to the session's inbox socket. |
| `run.mjs` | Headless Claude (stream-json) whose main conversation calls the fake server: inline vs file results, move to the background, wake. |
| `tui-run.mjs`, `tui-send.mjs`, `tui.py`, `screen.py` | The same in an interactive terminal under a scripted PTY. |
| `e2e.mjs` | Main conversation → the real bridge → a free OpenCode job → result back to the lead. |
| `lead-hook.mjs` | Probe-only PreToolUse hook that names the lead session as owner. |
| `hook.mjs`, `env-hook.mjs` | Record hook payloads, and which messaging variables a hook process gets. |
| `sock.mjs` | Post one line to a session's own inbox socket. |
| `rewake.mjs`, `stop-inject.mjs`, `modprobe/` | Wakes measured and not used: an `asyncRewake` hook, a Stop hook that holds and injects, a mod's `$.prompt.submit`. |
| `codex/` | Isolated Codex host with a scripted Responses-API model (`fake-model.mjs`); `prepare.mjs`, `tui.mjs`, `exec.sh`. |
| `opencode/`, `copilot/` | Isolated OpenCode and Copilot CLI hosts with the fake server registered. |
| `long/run-all.sh` | Idle-then-wake on all five hosts side by side (default idle one hour). |

## Run

From this directory:

```sh
node run.mjs inline --seconds 20 --kb 30          # result inline
node run.mjs bg --seconds 150 --kb 70             # backgrounded wait, then wake
node e2e.mjs e2e                                  # real bridge, free OpenCode job
node codex/prepare.mjs q                          # prints RUN; then codex/exec.sh RUN "<prompt>"
long/run-all.sh 3900                              # all five hosts, 65 minutes idle
```

Re-run after each Claude Code or Codex upgrade and compare with the plan's
Evidence section.
