# Codex CLI host qualification — Phase 2

Passive, hand-run measurements for **codex-cli 0.166.0**. No live Codex host was
run while building this harness. `ready` means a runnable definition exists,
not that Codex passed. Nothing here is imported by production or named for
`node --test` discovery.

## First run

From this worktree root, run the cheapest smoke:

```bash
node probes/host-qualification/codex/runner.mjs smoke
```

It makes one root catalog call, starts no native child/provider, and checks
preapproval, metadata and hooks. The host bound is **110 seconds**; normal
post-exit observation is 6.1 seconds, and cleanup allows two 3-second passes.
Allow under three minutes on an awake, responsive machine. Reaching the bound
is an incomplete measurement, not guaranteed model completion. Expected cost:
one short model turn at the operator's preserved model/effort; no provider tokens.

The runner prints the run directory. Inspect `analysis.md`, `analysis.json`,
`stderr.log`, `mcp.jsonl` and `hooks.jsonl`. Require an actual catalog response,
root metadata, requested model/effort, and actual hook deliveries before broader
runs. Missing hook output is a setup gap, not evidence that a hook kind is absent.

To inspect expanded prompts/config without copying auth or launching Codex:

```bash
node probes/host-qualification/codex/runner.mjs smoke --prepare-only
node probes/host-qualification/codex/runner.mjs --list
```

Each definition expands into `prompt.txt`, `scenario.json`, `config.toml`,
`command.json` and `manifest.json`. A prepared directory is for inspection;
run the scenario again to create a fresh supervised run. Existing outputs are
never reused. Do not launch the saved argv outside its supervisor.

## Prerequisites and isolation

- POSIX macOS/Linux, Node 22+, bash and `ps`. Python 3 and a real terminal are
  needed only for TUI mode. Git only validates an existing worktree, read only.
- Default CLI: `/opt/homebrew/bin/codex`; override with `--binary /absolute/path`.
  At operator launch, `--version` must report `codex-cli 0.166.0`. The inspected
  installation was `/opt/homebrew/Caskroom/codex/0.166.0/bin/codex`.
- `ps -p PID -o lstart= -o pgid= -o stat=` must work. The runner aborts before
  host launch if PID inspection fails; cleanup never silently skips birth checks.
- Outputs default to ignored `.runs/` under this directory, mode 0700. Override
  with `--out /absolute/new/run`. Destinations under the real `.codex`, `.claude`
  or source home are rejected, including through existing symlink ancestors.
- **Only `SOURCE_HOME/auth.json` is copied**, at launch, into
  `RUN/codex-home/auth.json` with mode 0600. SOURCE_HOME is `--source-home`, the
  invoking CODEX_HOME, or `~/.codex`, in that order. No keychain/login action occurs;
  `cli_auth_credentials_store="file"` is forced. A keychain-only account needs
  an operator-provided file-auth source before running. No other account file
  is copied. The isolated copy, including any refresh, is deleted after cleanup
  or launch failure. **Nothing is written back.**
- Only top-level `model` and `model_reasoning_effort` strings are selected from
  source `config.toml` (or `--source-config FILE`). Its contents are never logged
  or copied. Missing values or a selected profile require `--model VALUE
  --effort VALUE` from the effective configuration. No child model is overridden.
  Custom provider/endpoint settings are not copied; the standard account route
  used on 4 Nov is assumed.
- Child environment is allowlisted to PATH, HOME, CODEX_HOME, TMPDIR, PWD, TERM
  and LANG. No API-key environment, installed plugin, account hooks or memories
  are copied. `--no-daemon`, `--ignore-rules`, read-only sandbox, disabled plugins,
  apps, memories, shell and web search constrain the run. Workspace config/hooks
  are skipped through an untrusted project entry. Managed policy can still apply.
- Headless mode retains `--ignore-user-config --ephemeral`, generated `-c`
  overrides, per-run fixture preapproval and **`fork_turns="none"`**. Optional
  `--persistent` saves host rollouts inside the isolated home. TUI is persistent
  and reads that generated home config so changes can be observed.
- The generated logging hooks use the invocation-only
  `--dangerously-bypass-hook-trust` flag. Review `config.toml` first if needed.
  No trust entry or plugin is installed in the real account.

## Commands and scenario status

Set once, from the worktree root:

```bash
HQ=probes/host-qualification/codex/runner.mjs
```

Every `ready` headless row is unattended-safe **after smoke confirms setup**,
on an awake machine. Effects are fixture processes and the isolated host's model
calls. Short runs have a 240-second host bound; expect 1–4 minutes and several
model/tool turns. Identity/cwd and server-loss controls use two native children.
High reasoning effort can reach the bound. Add up to 6 seconds for cleanup.

| Scenario | Mode / status | Exact command | Measures |
|---|---|---|---|
| smoke | headless / ready | `node "$HQ" smoke` | Root metadata, preapproval, hooks; cheapest first run |
| identity | headless / ready | `node "$HQ" identity` | Root, owning child, status sibling, same-child follow-up |
| cwd-worktree | headless / ready | `node "$HQ" cwd-worktree --workspace "$PWD" --child-cwd "$PWD/probes"` | Worktree root and explicit child provider cwd, hook cwd, MCP input/server cwd |
| cwd-symlink | headless / ready | `node "$HQ" cwd-symlink --workspace "$PWD" --child-cwd "$PWD/probes"` | Logical symlink to the worktree versus canonical cwd |
| cwd-validation | headless / ready | `node "$HQ" cwd-validation` | Inherited cwd, missing/relative/nonexistent inputs, different-workspace wait |
| interrupt-startup | headless / ready | `node "$HQ" interrupt-startup` | Interrupt in send pre-hook before provider dispatch |
| interrupt-wait | headless / ready | `node "$HQ" interrupt-wait` | Pending-wait cancellation and same-child follow-up |
| interrupt-dispatch-gap | headless / ready | `node "$HQ" interrupt-dispatch-gap` | Dispatch acknowledgement to first wait; owner catalog in the gap |
| interrupt-between-waits | headless / ready | `node "$HQ" interrupt-between-waits` | Returned bounded wait, owner catalog, second wait held |
| child-complete | headless / ready | `node "$HQ" child-complete` | Normal child completion while execution lives; subsequent follow-up |
| native-close | headless / needs operator action | `node "$HQ" native-close` | Uses close_agent only if actually exposed; reports unavailable otherwise |
| owner-graceful | headless / ready | `node "$HQ" owner-graceful` | Natural exec exit with detached execution alive |
| owner-sigint | headless / ready | `node "$HQ" owner-sigint` | SIGINT to the recorded disposable host during a wait |
| owner-sigkill | headless / ready | `node "$HQ" owner-sigkill` | Host crash, transport EOF, descendant survival |
| server-sigkill | headless / ready | `node "$HQ" server-sigkill` | Target MCP death, root liveness, independent witness child connection |
| server-sigint | headless / ready | `node "$HQ" server-sigint` | Target MCP SIGINT/connection loss with witness control |
| followup-busy | headless / ready | `node "$HQ" followup-busy` | Ordinary followup_task and actual delivery relative to wait/cancel |
| steer | headless / ready | `node "$HQ" steer` | Explicit interrupt then same-child followup_task and delivery |
| long-silent | headless / ready | `node "$HQ" long-silent` | 1800-second request against production's 1320-second timeout |
| long-progress | headless / ready | `node "$HQ" long-progress` | Same deadline control with actual progress notifications |
| tui-compact | TUI / needs operator action | `node "$HQ" tui-compact` | Manual /compact, connection/identity and same-child follow-up |
| tui-new | TUI / needs operator action | `node "$HQ" tui-new` | /new equivalent of clear; old execution and child reachability |
| tui-restart | TUI / needs operator action | `node "$HQ" tui-restart` | Config change and actual MCP reload if supported |
| tui-stop | TUI / needs operator action | `node "$HQ" tui-stop` | Actual UI stop versus OS SIGINT |
| tui-auto-compact | TUI / needs operator action | `node "$HQ" tui-auto-compact --auto-compact-tokens 4000` | Automatic compaction stimulus, hook/identity observations |
| suspend-wake | TUI / needs operator action | `node "$HQ" suspend-wake` | Operator sleep/wake, clocks, delayed callbacks, connection state |
| clock-observe | TUI / needs operator action | `node "$HQ" clock-observe` | Externally authorized clock/delay observation; no clock mutation |

Native close never substitutes interrupt when unavailable. Steering is explicitly
interrupt-plus-follow-up, not a claim about a separate steer API. Ordinary busy
follow-up uses `followup_task`, not `send_message`.

For an independent **host** control, run a long-wait scenario in another terminal
and directory while killing the target host, then hand both runs back. Automatic
server-loss controls test two child MCP connections within one host only.

## Fixture behavior and phase timing

Send returns immediately with an execution id and starts a detached worker. The
worker spawns a command in its group; the command spawns a grandchild in a new
group. All record PID, birth, PGID, cwd, parent and heartbeats. No process forwards
signals. Natural fake completion occurs after the scenario's intended lifetime.
Explicit stop writes a per-execution request each fake process observes.

All inbound/outbound JSON-RPC, full `_meta`, cancellation reasons, EOF and
catchable signals are logged. SIGKILL is uncatchable; its send is recorded by the
supervisor. Cancellation only releases the pending response; EOF/signals exit
the server. **Neither terminates fake providers.** Cleanup is external and marked.

Startup is held by PreToolUse(send), dispatch gap by the first PreToolUse(wait),
and between-waits by the second. Default gates last 45 seconds. Catalog is
instant and observational, including owner reads inside both gaps. Gates perturb
scheduling: these tests measure interruption inside a pre-tool hook, not arbitrary
model thinking or the earliest native spawn handshake.

The root polls fixture phases before native control: at least 5 seconds after
SubagentStart and 2 seconds inside the requested phase. Example:

```bash
node "$HQ" interrupt-dispatch-gap --after-spawn-sec 15 --after-phase-sec 2 --gate-sec 60
```

The fixture holds the phase rather than relying on a blind sleep after spawn.
Model scheduling can overshoot N seconds. Analysis records the actual pre/post
hook bounds, phase and spawn offset. Ambiguous/missing spawn identity gives a
null offset. Missing gates or a control outside the intended phase are unqualified.
Logging hooks do not rewrite inputs, inject context or approve tools.

Native control hooks are stronger evidence than model-supplied before/after
catalog labels. Correlate raw hook targets with MCP owner metadata. Claimed child
cwd, hook cwd and server process.cwd are separate observations; the provider
launches in canonical supplied cwd. A provider cwd does not prove the native
child's cwd changed: the installed native API may not expose a cwd parameter.
The cwd-validation refusals are fixture checks, not proof that a model clarified
ambiguous workspace context on its own.
Optional claimed_owner on send never selects identity; MCP metadata does.
This fixture does not implement production ownership/lease enforcement.

## Long calls

Defaults request 30 minutes with tool_timeout_sec=1320 and a 37-minute host
bound. A timeout near 22 minutes is an outcome, not a shortened fixture wait.
Progress is emitted every 10 seconds only if the host supplies a progress token;
missing tokens leave the progress control unqualified. Budget 22–37 minutes per
run, at most about 74 minutes for the pair. Expected cost is a few model turns;
fake waiting does not consume provider tokens. To permit a full 25–35 minute call:

```bash
node "$HQ" long-silent --wait-sec 1500 --tool-timeout-sec 2160
node "$HQ" long-progress --wait-sec 2100 --tool-timeout-sec 2160 --wall-sec 2400
```

No host deadline, idle reset, or safe reattachment grace is assumed from a config
value. The fixture advertises ordinary MCP tools, not MCP tasks; native task
comparison remains unimplemented.

## Hook coverage

The generated config wires the 14 event names found in the installed 0.166.0
binary's hook enum and current official reference: PreModelRequest,
PostModelRequest, PreToolUse, PermissionRequest, PostToolUse, PreCompact,
PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart,
SubagentStop, Stop, Interrupt. Full stdin and logger process cwd are saved;
analysis lists actual fields, including session/agent/thread/turn/tool IDs and
cwd when present. Missing identifiers are never synthesized. A hook session id
does not automatically identify a child. There is no documented Codex TaskStop
or dedicated MCPRestart hook in this schema; neither is invented. PermissionRequest
may never fire for this preapproved fixture.

The repo hook file currently uses only SessionStart, UserPromptSubmit and
PostToolUse. This isolated config tests the broader set. Flag/event strings were
inspected without launching a host; delivery still needs live confirmation.
References checked 5 Nov 2026: [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [hooks and trust](https://learn.chatgpt.com/docs/hooks).

## TUI / PTY

The driver supplies a POSIX PTY, records raw output and input-delivery times,
forwards resize and keystrokes, and restores the terminal on normal exit/SIGTERM.
It records the host PID before allowing exec. No screen parser verifies command
acceptance. A real terminal must answer device queries; these runs are **not
unattended-safe**. Default host bound is 10 minutes, or 30 for suspend-wake.
Cost depends on operator turns within that bound; avoid token-heavy loops.

Launch the TUI scenario above. In another terminal set RUN to the printed path.
After initial UI setup in the isolated home, submit the prompt:

```bash
RUN=/absolute/printed/run
node "$HQ" --action prompt --run-dir "$RUN"
```

When the intended phase and UI readiness are visible, choose the relevant action:

```bash
node "$HQ" --action compact --run-dir "$RUN"
node "$HQ" --action new --run-dir "$RUN"
node "$HQ" --action stop --run-dir "$RUN"
node "$HQ" --action followup --run-dir "$RUN"
node "$HQ" --action mark --run-dir "$RUN" --note 'Observed UI outcome and native target'
node "$HQ" --action quit --run-dir "$RUN"
```

Stop submits Escape; UI focus/state may change its meaning. Use the installed
stop affordance manually and mark it if different. Compact/new submit /compact
and /new; busy turns may defer/reject them. Input delivery is not completion.
Require hooks/UI evidence. After /new the old child may be unreachable: the
follow-up prompt records failure rather than creating a replacement.

For settings-driven restart:

```bash
node "$HQ" --action restart --run-dir "$RUN"
```

This changes only the fixture env generation in isolated CODEX_HOME/config.toml
and saves config-after-change.toml. Observe auto reload, or use an actual MCP
reload UI if the installed version offers one and mark it. There is no guessed
/mcp restart command. Require a new server PID/initialize with the changed
restart_generation, old-connection loss and same-owner metadata correlation.
If no reload path exists, report unavailable/pending.

Auto compaction requires actual PreCompact/PostCompact with auto trigger. Idle
waiting does not grow context; the threshold may need further ordinary fixture
conversation. Suspend/wake or clock actions require separate operator authority;
mark before/after and perform them manually. The harness never changes clocks
or suspends the machine. Its dual-clock observations cannot qualify production
timer semantics or establish owner death by themselves.

## Analysis, cleanup and handoff

```bash
node probes/host-qualification/codex/analyze.mjs "$RUN"
node "$HQ" --cleanup "$RUN"
```

Analysis writes a full matrix row in analysis.json and a short index in
analysis.md: identity per call; signal and delay from each host event; actual
phase/spawn offset; survival at the first sample 5–6.5 seconds after the event
and at observation end; actual hook fields; saved-state availability; same-child
receipt markers. Missing samples/identity/receipt stay unknown. Signal windows
are explicit; later signals remain in raw received_signals. Match connection,
owner and request before assigning causality. A native pre-hook proves an
attempt; delivery needs the child's later catalog marker and identity.

Samples are roughly 500 ms apart. kill-zero establishes PID existence; fresh
heartbeats establish activity. observation_end precedes external_cleanup_started.
Cleanup signals individual recorded PIDs, checks birth identity, rescans for
late descendants, escalates TERM to KILL, and writes cleanup-verification.json.
No kill-by-name or broad process-group kill. Zombies/reused PIDs are not reported
absent. Non-absence sets exit code 2. Exit 0 means supervision finished, not that
the host qualified; read the row and warnings. External cleanup is never native stop proof.

Cleanup-only is idempotent on the original path. If the runner itself was
SIGKILLed, invoke cleanup manually; it cannot execute finally after SIGKILL.
Do not delete evidence while recorded processes remain alive. Use `stty sane`
from another terminal if an abrupt PTY failure left the terminal raw.

After cleanup, hand back the complete run directory (including hidden files),
CLI version, scenario/options and TUI observations. Verify auth removal first:

```bash
test ! -e "$RUN/codex-home/auth.json"
tar --exclude='auth.json' --exclude='auth.json.*' -czf "$RUN.handoff.tgz" -C "$(dirname "$RUN")" "$(basename "$RUN")"
```

Logs contain native IDs, prompts and full metadata intentionally; review before
sharing outside the measurement team. Analyze works on relocated copies;
cleanup refuses relocated manifests so it cannot signal an analyst's PIDs.
File availability is not cold-resume proof. Headless ephemeral runs intentionally
lack durable native rollouts; repeat with --persistent if those are required.

## Local checks and known gaps

```bash
node probes/host-qualification/codex/self-check.mjs
```

Offline checks prepare all 27 scenarios, exercise real fixture processes through
synthetic JSON-RPC, and supervise a Node fake host crash. They test metadata,
progress, cancel/EOF survival, explicit stop, cwd validation, phase logging,
+5-second activity, final absence, wall deadlines, synthetic auth removal and
PTY transport with a Node echo child. No Codex or account auth is used.

The implementation sandbox rejected ps with EPERM. JS syntax and Python driver
compilation passed; offline checks passed with explicit test-only substitution:

```bash
node probes/host-qualification/codex/self-check.mjs --stub-ps
```

That option prepends a temporary fake ps to the self-check PATH. Real OS birth
and PGID inspection remain unverified here. Live runner never selects the stub;
the operator should run the plain self-check. No live hooks, native control,
timeout, TUI behavior or host qualification is claimed by local checks.

First live runs must confirm flag/config acceptance, auth isolation, hook loading
and payloads, inherited model/effort, preapproval, ephemeral fork-none spawn,
connection identity, actual native controls, phase gates and progress tokens.
Remaining proof gaps: unavailable native close, MCP tasks, earliest spawn
handshake interruption, unattended TUI automation, native cold-host resume,
safe grace selection, production timers and host-triggered provider cleanup.

## Codex desktop

Reuse candidates: MCP fixture, process/hook loggers, evidence format and analyzer.
Desktop needs its own isolated registration, build capture, UI driver and owner
event timestamps. CLI argv/no-daemon, ephemeral/fork behavior, host PID ownership,
TUI keys, settings reload and hook/quit/stop semantics cannot be carried over as
claims. Do not point the working desktop at this CODEX_HOME.

## Sources and file inventory

Inspected worktree files: CLAUDE.md; probes/README.md; root README development
and contract sections; docs/ARCHITECTURE.md including Negative Results;
bridge-server/server.mjs callArgs; hooks/hooks-codex.json; .codex-plugin/plugin.json.

Read-only plan/evidence base:
`/Users/thanga-5521/.codex/visualizations/2026/10/27/01a17bab-d307-7342-8d32-d7c9c367f1a8/agent-companion-feasibility-2026-11-04/`.
Read REVISED-PLAN.md section 2 and host-codex REPORT.md, server.cjs, worker.cjs,
supervise.py and results.json. Raw copies under
`/private/tmp/ac-fx-1104-nXV3hB/host-codex/` supplied both session command.json
and prompt files plus session2 mcp.jsonl, identities.json, supervisor.jsonl and
cleanup-verification.json. Some session artifacts were absent from the archive.
The old supervisor used existing account auth, not an isolated home copy; this
runner adds auth isolation while reusing its model/effort, preapproval, fork-none
and passive-server/supervisor patterns. Those originals were not modified.

| Delivered file | Responsibility |
|---|---|
| .gitignore | Ignores run evidence and bytecode |
| common.mjs | Logging, timestamps, recorded PID identity and cleanup |
| server.mjs | Passive four-tool MCP fixture and full frame recording |
| worker.mjs | Worker, command, separate-group grandchild and heartbeats |
| hooks.mjs | Hook stdin logging and bounded pre-tool gates |
| scenarios.mjs | Scenario config and complete prompt expansion |
| runner.mjs | Isolated setup, auth, supervision and operator actions |
| pty-driver.py | PTY transport and input/output capture |
| analyze.mjs | Matrix row, timings, survival, state and follow-up |
| self-check.mjs | Hand-run offline verification |
| RUNBOOK.md | Commands, scenario statuses, limits and handoff |
| ../../README.md | Short probe discovery section |
