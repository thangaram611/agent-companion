# OpenCode as a host: plan

Status: decided 2026-11-23 on `feat/vocabulary`; ships in 1.0.0 with the Copilot
CLI and Antigravity hosts.

## Goal

A lead in OpenCode uses the same six tools as a lead in Claude Code or Codex
CLI: it starts threads on any companion, gets a thread id at once, and gets the
result back without polling. With Copilot CLI and Antigravity after it, any of
the five agents can lead and any can be the companion.

## Decisions (2026-11-23, the user)

1. **One plugin per host, one bridge.** Agent-companion installs on every host
   as a plugin, and the plugin brings the tools. On Claude Code and Codex the
   plugin already bundles the bridge. The OpenCode plugin's server part
   registers the same bridge, so the six tools stay one implementation.
2. **Background jobs and an always-on wake, on every host.** `companion_send`
   returns at once; the result wakes the lead with a short notice in its
   conversation; `companion_wait` stays available to block. Rejected: blocking
   on send and stopping the companion when the link is cut. Hosts cancel a tool
   call at 1,320 s (Claude Code and Codex, measured), Esc would discard the
   companion's work, and the lead could not work in parallel.
3. **Make directory lifetime a setup option.** `--opencode-idle-timeout` sets
   the global `experimental.location_idle_timeout`. The user's own install
   uses `false`. Omitting the option preserves the existing config. With no
   override OpenCode unloads an idle directory after 60 minutes.
4. **Nothing on the companion side.** A companion that stops to ask a question
   ends its turn and the question reaches the lead as the result. Progress comes
   from the companion's own transcript in the live view.

## Measured (OpenCode 2.3.2, 2026-11-23)

Runs used isolated `HOME` and XDG folders and their own service ports. Session
turns used the free model `opencode/flint-40b-free`. Directory lifetime was
observed through a fixture MCP server. The live companion harness is in
`probes/opencode-host/`.

| Question | Result |
| --- | --- |
| Where does the MCP server run? | The TUI starts a shared background service, `opencode serve --service`, as its child. The service runs the MCP server. `opencode run` and `opencode api` in the same home reuse it. Without a running service, `opencode run` uses a private server and its MCP server exits with it. |
| Service lifetime | It outlives the TUI and ran idle for 60 minutes without exiting. Service settings are only `disabled`, `remote`, `hostname`, `port`, `password`, `cors` and `env`. |
| Directory lifetime | With `location_idle_timeout: "1 minute"` and the TUI open on an idle session, the MCP server got EOF 65 s later. An MCP call in flight (the lead blocked in a 150 s call) kept it loaded. The default is 60 minutes; `false` never unloads. |
| What keeps a directory loaded? | With a 1-minute timeout, the control, a session metadata PATCH every 20 s, a POST to the session's `/view` every 20 s, and an in-flight `POST /api/shell` running `sleep 170` all unloaded at 118–120 s. A running lead turn with an in-flight tool call kept the directory loaded. |
| Long companion job with an idle lead | The 3-minute job stopped with `bridge_loss` at 91 s while the metadata heartbeat was running. |
| Global config writer | `PATCH /api/experimental/config` accepts only `shell`. A shell PATCH edited the existing JSONC file and kept its comments. A timeout PATCH returned HTTP 400 and left it untouched. OpenCode reads global `opencode.json` first, then `opencode.jsonc`. |
| When does an edit apply? | With the global timeout changed from `false` to `"1 second"`, an open directory kept its original MCP process for 130 s. A control with a 1-second timeout unloaded. `opencode reload` rebuilt the open directory's MCP server and the config API reported `"1000 millis"`. At the 128 s check its MCP had exited and the directory had unloaded. |
| One bridge per what? | One MCP process per directory open in the service. Sessions in the same directory share it. |
| Who is calling? | Each `tools/call` carries `_meta["ai.opencode/sessionID"]` (plus `progressToken`). The MCP process environment has no OpenCode variables. |
| A subagent's call | Carries the subagent's own session id. `GET /api/session/<id>` returns its `parentID` and `agent`. |
| Server instructions | Reach the model (it repeated a code word given only in the fixture's `instructions`). |
| Tool approval | MCP tools ran without a prompt, with and without `--auto`. |
| Tool names | `<server>_<tool>`, so the lead sees `agent-bridge_companion_send`. |
| Wake while idle | `opencode api POST /api/session/<id>/prompt --data '{"text":…}'` returned in 0.2 s; the open TUI showed the message and the reply. |
| Wake mid-turn | The same call returned in 0.2 s with `delivery: "steer"`. The lead's running 40 s tool call was not interrupted; the lead answered the notice in that turn. `opencode run -s <id>` also works but blocks until its own turn ends (41 s). |
| Silent input | `POST /api/session/<id>/synthetic` with `resume: false` ran no turn and waited in the session inbox; the next prompt saw it. (Not used: decision 2.) |
| Presence | No server-side signal. The TUI writes `time.viewed` only when its terminal is focused and routed to the session after it went idle; our PTY runs never set it. A TUI plugin sees the routed session and focus. (Not used: decision 2.) |
| Plugins | `@opencode/plugin` 2.4.0: one package exports `./server`, `./tui`, `./gui-experimental` and `./rpc`; config key `plugins`; `opencode plugin add` accepts npm, git or a local path. The server part can register MCP servers (`ctx.mcp.transform`), tools, commands and RPC methods, and runs once per directory. 2.4.0 changed the TUI renderer contract. |
| Keeping the bridge out of companion jobs | The OpenCode companion runs a private `opencode serve`, which loads global plugins and MCP servers. A config override can disable an MCP entry only by restating it whole with `disabled: true`; plugin lists merge rather than replace. |
| Service port | One fixed port per machine and channel (49374 here). A second home's service on it makes the user's TUI fail to start. Probes set their own port and stop their service on exit. |

**Rechecked on 2.4.0 (2026-11-24).** The probe passed setup twice, one active
plugin entry, a connected bridge, the wake of an idle lead (128 s idle under
`false`) and the read. `opencode plugin add` still refuses a local path, so
setup links `plugins/agent-companion`. Two storage changes reached the
transcript reader: message parts moved to a `session_part` table and the shell
input names its directory `workdir`. A command that outlives its timeout now
moves to the background. With `sleep 30` and a five-second timeout, the first
`session.execution.succeeded` arrived while `GET /api/shell/<id>` still showed
`running` and a PID. On exit the API showed `exited` with exit code 0.
`session.inbox.enqueued` carried a synthetic shell result with that shell ID,
then `session.execution.started` and a second `session.execution.succeeded`
bracketed the answer. SQLite stored two `idle` rows. The adapter-facing SSE
stream emitted zero `session.idle` events.

An explicit `background: true` command produced the same running metadata and
automatic continuation when the server stayed open. Only the timeout move
included a timeout explanation in its tool output. The adapter checks the shell
call's `background` input. A foreground call moved by timeout keeps the job open
through its continuation, whose answer and usage become the result. An explicit
background call lets the job close at its first execution end. Closing the private
server there stopped the observed shell PID and left a running part with no
synthetic result. The work summary reports it as unfinished.

Between executions, Steer requires a running turn and is refused. Queue waits
for the final continuation. Native session interrupt in this gap returned
`interrupted: false` and left the shell running. Cancelling through
`POST /api/experimental/job/<id>/cancel` changed its status to `killed` and
enqueued a `cancelled` result that started another execution. Interrupt & Send
cancels the pending shells, interrupts their continuation when it starts, and
delivers the replacement on the same server once that execution ends. If the
continuation finishes before the interrupt arrives, its own terminal releases
the replacement.

A live check of the adapter on private GPU Ollama (`gpt-oss:20b`) returned
`HELD-DONE` from the automatic continuation. The transcript reader recovered
`HELD-DONE\n` and exit 0 on the original command. In the interrupt run the
job cancel returned HTTP 204, the continuation acknowledged the native
interrupt, and the replacement answered on the same private server. With two
held shells, the default native interrupt left the second cancelled result
parked in the inbox. Passing `resume=true` on the first continuation's interrupt
let the second continuation start. Both turns acknowledged interruption, the
replacement answered, and both recorded shell PIDs were gone after cleanup.

## Design

**Plugin** (`opencode-plugin/`, loaded from the checkout):

- `server`: registers `agent-bridge` (the checkout's launcher, with
  `AGENT_COMPANION_HOST=opencode`) through `ctx.mcp.transform`. When the
  environment marks a companion job (`AGENT_COMPANION_JOB`, set by the bridge
  for every companion it starts), it registers nothing.
- A TUI part (running-thread band and a `/companion` page, as in Claude Code)
  is a later step; it needs the 2.4.0 renderer contract and is not required
  for the tools or the wake.

**Host descriptor** (`lib/hosts/opencode.mjs`, about 50 lines, the shape of the
Claude and Codex ones):

- `configDir`: `${XDG_CONFIG_HOME:-~/.config}/opencode`; records in
  `agent-companion/` there.
- `leadFromCall`: `{ host: 'opencode', session: _meta["ai.opencode/sessionID"], agent: null }`;
  no id means `LEAD_REQUIRED`. A subagent session leads its own threads.
- `wakeStatus`: `opencode_prompt` when the bridge's parent is the shared
  service and the session has no `parentID`; otherwise `null` with reason
  `subagent` or `private_server` (an `--standalone` session's server is not the
  one `opencode api` reaches). The lead then uses `companion_wait`.
- `wake`: `opencode api POST /api/session/<session>/prompt` with the notice,
  10 s limit, like `codex queue`.
- `toolPrefix`: `agent-bridge_`.

**Install**: `setup.sh --host opencode` runs `opencode plugin add
<checkout>/opencode-plugin` and installs the bridge's dependencies, then asks
the user to restart the service (`opencode service restart`). `--host all`
installs every host; `both` keeps meaning Claude Code and Codex CLI.

**Startup re-wake**: a bridge that starts finds stored results nobody has read
(the startup scan already restores them) and wakes their leads once. It covers
a service restart or an unload that happened after a job finished.

**Lifetime.** While the lead is idle, OpenCode can unload the directory and
stop its bridge. The cleanup watcher records unfinished jobs as `bridge_loss`.
`setup.sh --host opencode --opencode-idle-timeout "8 hours"` gives jobs more
time. Setup edits the highest-precedence global JSONC or JSON document and
preserves its comments. `false` disables idle unloading. `default` removes
the key from both global documents if present. Run `opencode reload` after
jobs finish to apply the edit to open directories. The plugin installation's
service restart also loads the edited config. Stopping the service, upgrading
or rebooting still ends running jobs.

**Views**: `agent-companion ui` lists OpenCode-led jobs from the new state
folder.

## Steps

1. **Host descriptor and identity.** `lib/hosts/opencode.mjs`, registry entry,
   `leadFromCall`, wake status and wake. Check: unit tests for lead parsing
   (root, subagent, missing id), wake status (service parent, private server,
   subagent) and the wake command line; registry guard passes.
2. **Plugin and recursion guard.** `opencode-plugin/` server part; the
   companion-job marker in every companion's environment. Check: in an
   isolated home, `opencode plugin add` loads it, a session sees
   `agent-bridge_companion_*`, and an OpenCode companion job starts no bridge.
3. **Idle timeout and startup re-wake.** In an isolated home, set the option to
   `false` and check that a 3-minute job survives an idle lead and wakes it.
   With a 1-minute timeout, check that an idle directory unloads and a job
   that outlives it stops with `bridge_loss`. Test that setup preserves comments
   when setting a duration, disabling unloads and restoring the default.
   On startup, unread results wake their lead once and delivered results do not.
4. **Install.** `setup.sh --host opencode|all`, `scripts/onboard.mjs`, doctor.
   Check: in an isolated home, setup adds the plugin once (rerun keeps one),
   doctor reports it, and the user's real config is untouched.
5. **Live.** An isolated TUI on its own service port leads a thread on each
   companion it can reach for $0 (OpenCode, Copilot and Claude Code on local
   Ollama, Codex on Ollama), gets the wake, reads the result and follows up; a
   subagent lead gets `companion_wait` instead of a wake. Then the user's own
   OpenCode, with their word.
6. **Docs.** README Hosts, ARCHITECTURE, CLAUDE.md, THREAD_PLAN "Hosts built
   later", RELEASE_READINESS.
7. **TUI part (after the core).** Running-thread band and `/companion` page on
   the 2.4.0 contract.

## Risks

- The service port is machine-wide: a test that leaves its service running
  blocks the user's OpenCode. Every probe sets its own port and stops its
  service on exit.
- A finite idle timeout can stop companion jobs. With `false`, every opened
  directory keeps its MCP and language servers loaded until the service stops.
- OpenCode's 2.x plugin API is young (2.4.0 changed the TUI contract). The
  server part uses only `mcp.transform`, which keeps the surface small.
- `opencode api` resolves the service from the user's home. The bridge inherits
  the service's environment, so they match.
