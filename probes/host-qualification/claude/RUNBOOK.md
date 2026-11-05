# Claude host qualification (Phase 2)

This is an operator-run measurement harness, not a lifecycle controller. It calls
Claude Code only when you pass `--execute` or use `execute RUN`. The downstream
provider is entirely fake. No production module imports these files, and none is
named for discovery by `node --test`.

The starting point is the **4 November run2** session-level named-reference
topology. The newline JSON-RPC reader, passive signal/EOF logging, detached
worker and hook capture are adapted from that harness. This version separates
dispatch from wait, adds the separate-group grandchild, in-band identity,
phase gates, run isolation, analysis and cleanup. The dated reference is
[REPORT.md](</Users/thanga-5521/.codex/visualizations/2026/10/27/01a17bab-d307-7342-8d32-d7c9c367f1a8/agent-companion-feasibility-2026-11-04/host-claude/REPORT.md>).
The acceptance questions come from [plan section 2](</Users/thanga-5521/.codex/visualizations/2026/10/27/01a17bab-d307-7342-8d32-d7c9c367f1a8/agent-companion-feasibility-2026-11-04/REVISED-PLAN.md>).
Neither those old observations nor the offline check qualifies a new live run.

## Prerequisites and isolation

- macOS or Linux, Node 22+, Bash, and `ps` supporting `lstart`, `stat`, `pgid`,
  `command`. Process inspection must be permitted. Execution refuses before
  launching Claude if PID identity cannot be checked.
- Operator-installed Claude Code **2.1.318**, available as `claude` in PATH.
  The runner captures `--version` and `--help` in the run directory, validates
  the version and required flags, and refuses unsupported flags. To measure a
  different version intentionally, prepare with `--expected-version VERSION`.
  Nothing installs, upgrades or logs in to Claude.
- Authentication is **inherited** by default: the host runs against the
  operator's default Claude config directory, so the existing keychain login is
  used and nothing is read, copied or logged in by the harness. Measured on
  2.1.318: a redirected `CLAUDE_CONFIG_DIR` answers `Not logged in`, so
  redirecting it is opt-in. Pass `--isolated-config` to point
  `CLAUDE_CONFIG_DIR` at `RUN/host-home`; that mode requires
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the launching terminal's
  environment and never automates a login. Inheriting the config directory can
  expose user-level agents and managed policy to the run; the analyzer lists
  any agent, hook or MCP server that is not ours as an isolation defect.
- TUI only: an actual terminal and Python 3 with `venv`. The runner creates
  `RUN/venv` using `python3 -m venv`; `pty-driver.py` uses only the standard library.
  There is no package download or global Python install.

Every run goes under `probes/host-qualification/claude/runs/`. Existing run
directories are never overwritten. Empty `--setting-sources`, explicit settings,
strict MCP config and explicit agents isolate the host; `CLAUDE_CONFIG_DIR` is
redirected only with `--isolated-config`. Headless inherited-auth runs pass
`--no-session-persistence`, so transcript availability is measured in isolated
or TUI mode.
Agents are materialized in `RUN/host-home/agents` and `RUN/agents.json`; the CLI
definition uses `mcpServers: ["fixture"]`, never an inline per-child server.
The independent control agent references `fixture_control`. Only fixture tools
and native Agent/SendMessage/TaskStop/TaskOutput are allowed. No installed
plugin or production agent definition is used. Session persistence is enabled
inside the run so transcript availability can be measured.

The runner inherits only a small environment allowlist (PATH, locale, HOME
unchanged, terminal/temp, proxy/certificate settings and the two authentication
variables). Host IPC, model overrides and MCP timeout environment variables
are omitted. Credential values are never written by the harness. Managed host
policy can still affect a run; unexpected tools, hooks, agents or transcript
paths outside RUN invalidate the isolation claim. The analyzer records such
paths but does not read them.

## First live run: `smoke`

Run from this worktree after setting credentials privately:

```bash
node probes/host-qualification/claude/runner.mjs smoke --execute
```

This is the intended **sub-$1, under-three-minute first run**: Haiku, a **$0.50
CLI estimate cap**, a **130-second host wall bound**, then seven seconds of
observation and bounded cleanup. Expect roughly 1–2 minutes and less than
$0.50 with the small prompts; this estimate is unmeasured here. A budget cap
is not a billing guarantee: the host can overshoot it on an in-flight request.
Both parent and native child consume Claude tokens; fake workers consume none.
The runner records the actual model/cost when the host emits them.

The smoke sends fake work, stops a pending child wait, observes descendants
past five seconds, and attempts SendMessage to the same child. Check
`analysis.json` for a native owner match, TaskStop/native-ID mapping, actual
pending-wait phase, cancellation delay, all three descendant observations,
the resume marker under the same owner, and `cleanup.allGone: true`.
Absence of a signal or a missed phase is a result, not a passing qualification.

Preparation alone costs nothing and never executes `claude`:

```bash
node probes/host-qualification/claude/runner.mjs smoke --run-dir probes/host-qualification/claude/runs/smoke-review
# Inspect that directory's prompt.txt, settings.json, agents.json, mcp.json and command.json.
node probes/host-qualification/claude/runner.mjs execute probes/host-qualification/claude/runs/smoke-review
```

## Scenario commands and status

Set this once in a terminal at the worktree root:

```bash
PROBE="$PWD/probes/host-qualification/claude"
node "$PROBE/runner.mjs" list
```

`ready` means the scenario, runner and analyzer are implemented; **live evidence
still requires the operator**. No row has been live-qualified by this change.
All headless rows are unattended-safe after the smoke confirms authentication,
isolation and PID inspection. They require no personal file access or shell
tool permission. Stop on a permission/configuration failure; do not grant broad
permissions to complete a measurement. TUI rows need supervision and have no
CLI dollar cap (that flag is print-mode only).

| Scenario / exact command | Mode / status | Measures |
|---|---|---|
| `node "$PROBE/runner.mjs" smoke --execute` | headless / ready | First pending stop, identity, survival, resume |
| `node "$PROBE/runner.mjs" stop-startup --execute` | headless / ready | TaskStop before first dispatch; first-send pre-hook held 25 s |
| `node "$PROBE/runner.mjs" stop-pending --execute` | headless / ready | Stop with an attributable MCP wait pending |
| `node "$PROBE/runner.mjs" stop-dispatch-gap --execute` | headless / ready | Dispatch ACK to first wait; first wait pre-hook held 30 s |
| `node "$PROBE/runner.mjs" stop-between-waits --execute` | headless / ready | Three-second wait, catalog read, second wait pre-hook held 30 s |
| `node "$PROBE/runner.mjs" normal-completion --execute` | headless / ready | Natural SubagentStop with fake execution still live; same-child resume |
| `node "$PROBE/runner.mjs" parent-exit --execute` | headless / ready | Parent final answer/print-mode exit while child work is pending |
| `node "$PROBE/runner.mjs" parent-sigkill --execute` | headless / ready | Controlled parent crash; EOF, missing hooks, tree survival |
| `node "$PROBE/runner.mjs" fixture-sigkill --execute` | headless / ready | Server killed while two children use independent connections; retry/respawn and failure seen by child |
| `node "$PROBE/runner.mjs" fixture-sigint --execute` | headless / ready | SIGINT server-loss control with parent alive |
| `node "$PROBE/runner.mjs" busy-followup --execute` | headless / ready | Native SendMessage acceptance and first observed action on follow-up |
| `node "$PROBE/runner.mjs" explicit-steering --execute` | headless / ready | Explicit change-of-course message via SendMessage; interruption versus delayed action |
| `node "$PROBE/runner.mjs" cwd --execute` | headless / ready | Explicit parent path, child's report, hook cwd, MCP received path and server cwd |
| `node "$PROBE/runner.mjs" cwd-inherited --execute` | headless / ready | Working path taken from child's host context |
| `node "$PROBE/runner.mjs" cwd-missing --execute` | headless / ready | Clarification when parent supplies no usable working path |
| `node "$PROBE/runner.mjs" cwd-ambiguous --execute` | headless / ready | Clarification between two possible working paths |
| `node "$PROBE/runner.mjs" cwd-relative --execute` | headless / ready | Explicit relative-path rejection |
| `node "$PROBE/runner.mjs" cwd-nonexistent --execute` | headless / ready | Nonexistent-path rejection |
| `node "$PROBE/runner.mjs" cwd-symlink --execute` | headless / ready | Canonical cwd through a symlink inside this worktree |
| `node "$PROBE/runner.mjs" cwd-change --execute` | headless / ready | Refuse same-execution continuation in a different workspace |
| `node "$PROBE/runner.mjs" identity-negative --execute` | headless / ready | Clear fabricated parent owner; allow ownerless catalog; refuse ownerless send |
| `node "$PROBE/runner.mjs" long-silent --execute` | headless / ready | 33-minute pending wait, no progress, server timeout 1,320,000 ms |
| `node "$PROBE/runner.mjs" long-progress --execute` | headless / ready | Same wait with progress every 10 s |
| `node "$PROBE/runner.mjs" clear --execute` | TUI / needs operator action | `/clear`, session/child identity and connection continuity |
| `node "$PROBE/runner.mjs" compact --execute` | TUI / needs operator action | Manual `/compact`; PreCompact trigger and MCP continuity |
| `node "$PROBE/runner.mjs" settings-restart --execute` | TUI / needs operator action | Run-local settings/MCP edit and actual restart behavior |
| `node "$PROBE/runner.mjs" ui-stop --execute` | TUI / needs operator action | `/tasks` user stop and native resume refusal/success |
| `node "$PROBE/runner.mjs" tui-steering --execute` | TUI / needs operator action | User input directly to the busy child's transcript |
| `node "$PROBE/runner.mjs" native-close --execute` | TUI / needs operator action | `/exit` with execution live |
| `node "$PROBE/runner.mjs" auto-compact --execute` | TUI / needs operator action | Genuine automatic compaction under operator-induced context pressure |
| `node "$PROBE/runner.mjs" suspend-wake --execute` | TUI / needs operator action | Operator sleep/wake, callback gaps and connection state |
| `node "$PROBE/runner.mjs" clock-jump --execute` | TUI / needs operator action | Disposable-machine clock change versus monotonic timestamps |
| `node "$PROBE/runner.mjs" delayed-callbacks --execute` | TUI / needs operator action | Pause/resume only the recorded fixture server |

Other short headless runs default to **210 s / $1 estimate cap**, commonly
1–3 minutes and $0.10–$1 on Haiku. Long runs default to **36 minutes / $1.50
cap**; waiting itself does not require model turns, but timeout/recovery may.
TUI runs have a **10-minute wall bound**, no dollar cap, and model costs vary
with operator input. Context-pressure/compaction can cost more than the short
runs. They are never unattended-safe. No machine suspend or clock change is
automated by the harness.

## Timing, identity and the passive boundary

The parent waits for an observer-reported phase, then waits one second and
issues its native action. `--event-delay-sec N` changes that delay;
`--after-spawn-sec N` asks the observer to return no earlier than N seconds
after SubagentStart (still waits for the requested phase). Native model latency
is additional. The analyzer records the actual phase and spawn-to-action time;
it cannot force TaskStop to arrive at an exact millisecond.

`--startup-sec N` and `--gap-sec N` change the pre-hook holds. Startup is before
the first send reaches MCP, not a blocked send response. `send` always ACKs
without waiting for worker completion. Gap holds occur before a wait reaches
MCP; there is no owner-bound MCP call during the hold. They are logged and
interruptible by the host. If Claude waits for a hook before returning Agent,
or kills a hook unexpectedly, the timing window may be missed. Record it.
These artificial holds do **not** choose a safe production grace duration.

Every fixture tool's PreToolUse hook spreads the original input and overwrites
`thread` with the hook's native `agent_id`, as `hooks/name-thread.sh` does.
The measurement extends this to wait/stop/catalog and clears `thread` when no
native ID exists, closing the fabricated-parent-owner case. The server uses
this in-band thread. ToolUseId is only an offline diagnostic join; no live
identity side channel is introduced. Missing or nonunique joins stay unverified.
TaskStop mapping requires exact ID agreement with both native Agent response
and SubagentStart; it is not inferred from a model summary.

`catalog` returns immediately and writes only protocol observations. It never
starts work, changes a phase, attaches an owner or renews anything. The fixture
has no lease. `stop` acknowledges a **recorded request**, explicitly reports
`cleanupImplemented:false`, and leaves all fake processes alone. Cancellation
is logged while the fake wait continues. EOF/SIGINT end only the server.
Workers eventually finish on their configured simulation timer, independently;
normal runs set this later than the host wall bound. Only the external runner
cleans up the recorded fixture PIDs after observation.

The cleanup never signals by name or process group. It checks the saved PID,
OS birth time and run-directory argv marker, sends TERM then KILL to individual
recorded PIDs, rescans for late child spawns, and verifies exit. Zombies are
reported as exited/unreaped. Unverified identity is not killed or called gone.
Hook processes are recorded too. The supervisor is not crash-proof: if it is
SIGKILLed, run `cleanup RUN` afterward. Workers have a planned finite lifetime.

## Long pending calls

Use matching pairs; do not change several knobs at once:

```bash
node "$PROBE/runner.mjs" long-silent --wait-sec 1500 --server-timeout-ms 1320000 --execute
node "$PROBE/runner.mjs" long-progress --wait-sec 1500 --server-timeout-ms 1320000 --execute
node "$PROBE/runner.mjs" long-silent --wait-sec 2100 --server-timeout-ms 2400000 --execute
node "$PROBE/runner.mjs" long-progress --wait-sec 2100 --server-timeout-ms 2400000 --execute
```

Wait range is 1500–2100 seconds; the default is 1980. Unless explicitly
overridden, wall time is wait + 180 seconds. `timeout` is a sibling field on
each MCP server entry, in milliseconds. No timeout environment override is
applied. The host may floor an idle timer rather than use this as a hard total
deadline; a configured value is not measured behavior. Raw progress frames,
progressToken presence, cancelled requests, tool failures and elapsed times
are the evidence. The child uses one long wait and reports background-task
handles if the host supplies one; no native MCP task implementation is faked.

## TUI operator actions

The Python adapter allocates a real PTY, forwards terminal input/resizes and
captures raw ANSI output in `terminal.log`. It does not interpret the UI or
solve dialogs. The runner prints the run directory before launch. Wait for
`PARENT_READY` and confirm a pending fixture wait before acting. In a second
terminal, set `RUN` to the printed absolute run directory.

```bash
node "$PROBE/runner.mjs" action "$RUN" clear
node "$PROBE/runner.mjs" action "$RUN" compact
node "$PROBE/runner.mjs" action "$RUN" settings-restart
node "$PROBE/runner.mjs" action "$RUN" native-close
# After clear/compact/restart/stop, use the ORIGINAL native child ID from hooks.jsonl:
node "$PROBE/runner.mjs" action "$RUN" resume ORIGINAL_CHILD_ID
```

Use only the action belonging to the current scenario. `clear`, `compact`,
`native-close` and `resume` enqueue terminal text. The PTY logs when it actually
writes it; that alone does not prove Claude accepted the command. The compact
row needs `PreCompact` (manual), and clear needs the new session/transcript
evidence. If the prompt is busy or a dialog is open, inspect the terminal.

`settings-restart` edits only this run's settings and MCP generation env field.
It **does not** forcibly kill a server or silently substitute a reconnect. If
the CLI does not watch a `--mcp-config` file, record that negative result. A
later `/mcp` reconnect is a separate operator action: mark it first with
`action "$RUN" manual-reconnect`, then use the menu and record what happened.

For `ui-stop`, mark `action "$RUN" ui-stop`, then select the original child
in `/tasks` and stop it. Mark `ui-stop-completed` immediately afterward. For
`tui-steering`, mark `tui-steering`, open the busy child's native transcript and
send: “Change course now. Call catalog with marker=steering-delivered, then
finish.” Record the UI acknowledgement and whether the wait was interrupted.
The headless explicit-steering row tests an explicit native **message**; it
does not pretend a nonexistent interrupt flag is available.

For auto-compaction, the operator adds context in this isolated conversation
until a real `PreCompact` with `trigger:auto` occurs. Mark the start and end.
No synthetic manual compact counts as automatic. This can exceed the cost
estimate; there is no automated context-flooding loop.

For suspend/wake, mark `before-suspend` and `after-wake` around an operator
controlled sleep. Do not sleep a working machine merely to complete this
harness. For clock changes use an expendable test machine, mark `before-clock`
and `after-clock` and record the adjustment in the optional final action
argument. The harness never changes system time. For delayed callbacks:

```bash
node "$PROBE/runner.mjs" action "$RUN" pause-fixture
# After the chosen delay:
node "$PROBE/runner.mjs" action "$RUN" continue-fixture
```

Per-process monotonic timestamps, wall timestamps and heartbeat gaps are raw
evidence. The analyzer's ordinary delay calculations use wall time; clock-jump
and suspend cases require manual review and cannot qualify a destructive timer.
Independent wall-clock injection/awake-time policy belongs to the future
controller, which this harness does not implement.

## Analysis, cleanup and handoff

```bash
node "$PROBE/analyze.mjs" "$RUN"
node "$PROBE/runner.mjs" cleanup "$RUN"  # recovery after an interrupted supervisor
```

`analysis.json` contains per-call native/in-band identity, actual event phase,
signals and delay windows, worker/leaf/grandchild observations at +5 s and
measurement end, hooks, gaps, native responses, saved fake state, transcript
availability and same-child delivery. It reports sampled time offsets instead
of claiming exact five-second precision. Missing samples are unknown. Death
after `cleanup_start` never supplies host cleanup proof. Saved fake history is
not proof of native provider cold resume. Same-child continuation requires a
subsequent fixture call under the original native ID, not just an acknowledgement.

Hand back the **whole run directory** with `scenario.json`, generated configs,
`command.json`, version/help capture, `hooks.jsonl`, `events.jsonl`,
`heartbeats.jsonl`, `samples.jsonl`, `controller.jsonl`, `pids.jsonl`,
`executions/`, raw host output, `host-home` transcripts, `exit.json`,
`cleanup.json` and `analysis.json`. `venv/` can be omitted. Keep raw evidence
unchanged. It contains native IDs, local paths and fixture transcripts; use a
private handoff, not a public issue. No credential files should have been
created; if the operator logged in manually, remove those from a *copy* before
handoff and record the omission. No automatic upload is performed.

## Offline checks and first-run assumptions

```bash
node "$PROBE/verify.mjs"
```

This uses only local fake protocol clients and a generated fake executable.
It materializes all scenarios; checks hooks, owner refusal, cwd validation,
progress, passive cancellation/EOF, tree heartbeats, analysis and cleanup.
Where `ps` is permitted it also checks process groups and the full runner with
the fake host. In restricted sandboxes it marks these checks unverified,
confirms the runner refuses before host launch, and waits for its short-lived
fake workers' planned exit. Inspect `runs/offline-*/verification.json` for the
actual checks and limitations. No live Claude was run to develop this harness.

The first live run must confirm: CLI flag acceptance; isolated config/agent
loading; credential routing; hook updatedInput and matching; agent_id on
**every** private call; TaskStop ID mapping; named MCP reference behavior;
version/model/cost capture; and PID inspection/cleanup. Later runs must confirm
PreCompact delivery, long-call timeout/progress behavior, actual follow-up
delivery, TUI command acceptance and settings watching. Current official
[CLI flags](https://code.claude.com/docs/en/cli-reference),
[hook schema](https://code.claude.com/docs/en/hooks), and
[named MCP references and resume](https://code.claude.com/docs/en/sub-agents)
inform the configuration, but the installed 2.1.318 behavior remains the target
of measurement. The current docs are not a version-pinned proof.

Remaining qualification boundaries: no production cleanup/lease implementation;
no native provider cold-history test; no native MCP-task-mode comparison;
no second independent parent for crash isolation; no Git worktree creation or
worktree switching (the runs are already inside this supplied worktree).
`fixture-sigkill` provides two independent **connections in one parent**;
it does not claim separate-parent isolation. Cwd and messages reported by the
model remain distinct from hook/MCP/process evidence. No row alone approves
the Phase 2 gate across Claude, Codex CLI and desktop.
