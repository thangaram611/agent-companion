# Live view and interventions: plan

Written before the 1.0.0 vocabulary: tools `agent_*` are now `companion_*`, and `target` is `companion`; see docs/VOCABULARY_PLAN.md.

Status: agreed 2026-11-15. Step 0 landed as 4e536d0; Step 1 as 2222e9b, 229b310
and 2c9577b; Step 2 as 37e7b0e through 497a740. Step 3 is built and probed
on `feat/interventions` (outcome below). Step 4 is not started.

## Goal

While a companion works, the person watching the host can read its transcript
live and intervene. The calling agent learns of every intervention at once and
receives a curated handover at the end, not the whole transcript.

## Decisions

Agreed with the owner on 2026-11-15:

| Topic | Decision |
| --- | --- |
| Source of truth | Each companion's own transcript. The bridge stores no second copy. |
| In-flight work | The execution record's existing `progress` (partial text, active command, activity), overwritten on each update. |
| Detail | Everything the companion records. Preamble (system/developer text, instruction files) collapsed by default. |
| Handover to the caller | Final answer plus a work summary: transcript-reported edits and commands, and a labelled git diff-stat of the worktree between turn start and end. The full transcript is readable on demand. Replaces today's digest. |
| Interventions | One controller feature with two senders: the caller through `agent_reply` modes and the user through an inbox. Modes: steer, queue, interrupt & send, cancel. Each companion's own default applies. |
| Caller awareness | A user intervention makes the caller's pending `agent_wait` return early with what happened. |
| When messages are accepted | Only while the job runs. Once a job has ended, or the caller has returned, the view is read-only for it. |
| Job result with interventions | A job ends only when nothing is pending. Its result lists each turn's answer once, in order, labelled with the message it answers; an interrupted turn reads "interrupted before answering" without partial text. No answer reaches the caller twice. |
| The user's messages | Delivered verbatim like the caller's; the execution record and the caller's early return name the sender. |
| Native attach | Not built. |
| UI | Shared Node core first, then a terminal UI in Ink 8, then a Claude Code mod: progress on each companion job's agent row and a Companions pane (the MCP progress line was dropped in Step 4). The web page is deferred for its own design discussion. |
| Runtime | Node 26 (current LTS) required; use its features. |

## Evidence

Measured in isolated homes unless noted. Spike artefacts are under `/tmp`
(`claude-queue-spike`, `codex-attach-spike`, `oc-attach-spike`,
`copilot-events-spike`, `agy-measure` with its decoder in `agy-measure-run`).

### Native transcripts

| Companion | Location | Format | Live? | Id mapping | Version fingerprint |
| --- | --- | --- | --- | --- | --- |
| Codex 0.169 | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl` | JSONL; `response_item`, `event_msg` (`item_completed` with `CommandExecution`, `AgentMessage`, web search), `token_count` | Yes: 27→45 lines in 25 s during a turn (observed read-only on a live bridge run). Completed items only; no deltas. | `Thread.path` in app-server responses, marked `[UNSTABLE]`; else glob on thread id | Record types; `session_meta` |
| Claude Code 2.1.325 | `$CLAUDE_CONFIG_DIR/projects/<dir>/<sessionId>.jsonl` | JSONL; `user`, `assistant`, `system`, `attachment` and bookkeeping records | Yes, per message: measured for an interactive session (read-only) and for the bridge's non-bare `-p` companion in an isolated home | The adapter already scans for it (`claudeTranscriptExists`) | Message records carry `version` (e.g. `2.1.325`); bookkeeping records do not |
| Copilot 1.0.112 | `$COPILOT_HOME/session-state/<sessionId>/events.jsonl` | JSONL; `user.message`, `assistant.turn_start/end`, `assistant.message` (whole, no deltas), `tool.execution_start` (with the command) and `tool.execution_complete` (exit code, output), `session.usage_record` | Yes, at event boundaries: a running tool is on disk from its start; text lands when the message completes | Directory name equals the ACP session id (measured) | `session.start` carries `version: 1`, `producer`, `copilotVersion` |
| OpenCode 2.3.0 | `opencode.db` (`OPENCODE_DB` or XDG data) | SQLite; `session_v2`, `session_message` rows ordered by `seq`, JSON `data`; types `user`, `assistant` (with `content`), `idle`, `model-switched`, `agent-switched` | Rows are created when a step starts and updated when it completes (1–3 s later); updates in between were not observed | Session id | Latest `migration.id` |
| Antigravity 1.1.1 (superseded) | `$GEMINI_HOME/antigravity-acp/conversations/<sessionId>.db` | SQLite (WAL); `steps(idx, step_type, status, step_format, step_payload…)`; payloads are protobuf with no published schema | Yes, per step: a running command is on disk with status 2 and flips to 3 when done (measured on a live bridge job, the operator's real home) | File name equals the bridge's history id, the ACP session id (measured) | `step_format`, and the field numbers below |

The following decoder measurements describe the retired 1.1.1 server. For the
CLI store and step types measured 2026-11-22 on agy 1.5.13, macOS, see
[Architecture](ARCHITECTURE.md#state). A schema-less
wire decode read everything needed from a live job: step type 14 is user input
(text at field 19.2); 15 is the model's reply (text at 20.1, model id at 5.24.8,
tool calls at 20.7 with id, name and JSON arguments); 21 is a command (command
line at 28.23, output at 28.21, cwd at 28.2). Status 2 is running and 3 is done.
These field numbers were the reader's fixture; any unknown step type or missing
field yields "format unrecognized", never a guess.

### Interventions

| Companion | Own default mid-turn | Steer | Interrupt & send | Cancel |
| --- | --- | --- | --- | --- |
| Codex | Steer: `Enter` submits immediately, `Tab` queues (`codex-rs/tui/src/bottom_pane/chat_composer.rs` at rust-v0.169.0; `steer` feature graduated) | `turn/steer`; spike: mid-turn input restarted generation inside the same turn | `turn/interrupt`, then `turn/start` on the same thread | Existing |
| Claude Code | Queue. A message written during a tool call joined the same turn after the tool finished, as "The user sent a new message while you were working"; written during final text it ran as the next turn | Effectively, at tool boundaries | `interrupt` with `send_now: true` started a new turn on the same session | Existing; `cancel_async_message` drops a queued message |
| OpenCode | Steer: a prompt sent mid-turn is acknowledged `delivery: "steer"` and reaches the model between steps of the same run | Measured (2.3.0) | Abort, then a prompt with only the new text: measured | Existing |
| Antigravity (agy 1.5.13) | Steer | Second `session/prompt` mid-turn | `session/cancel`, then prompt on the same session | Existing |
| Copilot | Follow-up is refused (`FOLLOWUP_UNSUPPORTED`) | No | No | Existing |

Step 3's measurements (2026-11-15; Claude 2.1.325, Codex 0.169.0, OpenCode
2.3.0; loopback mocks and OpenCode's free model, isolated homes, $0; evidence in
`/tmp/step3-measure/`):

- Claude on the adapter's real startup path (no `--bare`) matches the spike: a
  message written during a tool call joins the running turn; one written during
  the final text runs as the next turn; a message written after `result` to the
  live process starts another turn in the same session; `interrupt` with
  `send_now`, `cancel_async_message` and requeue behave as before. Each message
  reports `command_lifecycle` states (queued, started, completed, cancelled) by
  UUID. `result` carries no pending list, and the gap before a queued turn
  starts was about 3 ms in one sample, so the controller tracks accepted UUIDs
  until each completes or is cancelled; no timer decides the queue is empty.
- Codex through the bridge's own connection: `agent_reply` steer was confirmed
  in the same native turn; the next model request carried the steer text; the
  rollout records it as a second user message in that turn, and the job
  completed. Interrupt & send at the app-server: `turn/interrupt`, then
  `turn/start` with only the new text on the same thread, gives a distinct turn;
  the rollout records the abort and the new message under the new turn.
- OpenCode: see the table. The answer reflected both prompts.

### Rejected options

- **Native attach.** Codex: a second client (`codex --remote … resume <thread>`)
  rendered the turn live, could steer, and interrupted it with Esc or Ctrl+C; the
  bridge would have to move app-server from stdio to a private Unix socket
  speaking WebSocket (measured: `101 Switching Protocols` on `/rpc`). OpenCode:
  `opencode --server <url> --session <id>` with `OPENCODE_PASSWORD` attached and
  steered; its input was visible to the bridge as `session.inbox.enqueued`.
  Claude only attaches `--bg` sessions. Copilot and the retired Antigravity
  1.1.1 server had none in this measurement.
  Neither working option has a read-only mode.
- **A bridge-written event log.** It would duplicate the transcript.
- **MCP progress as the main view.** It is one line. Claude shows the message in
  its spinner (`RELIABILITY_REMEDIATION.md` §0 measurement); Codex 0.169 only
  writes it to tracing logs (`rmcp-client/src/logging_client_handler.rs`).

### UI platform

- Claude Code mods (2.1.325, "EARLY ACCESS: may change without notice"): a probe
  mod redrew a band from a file appended by another process within a second,
  with no model call. `hooks/hooks.json` can carry the plugin's command hooks
  and a `modules` entry together (`claude plugin validate` passed on a copy).
  Not measured: redraw while the main loop is busy.
- Ink 8.0.0 (npm, 2026-10-03): Node >=22, React >=19.3, ESM.
- OpenTUI 0.9.0 (npm, 2026-11-14): Bun or Node >=26.4 with `--experimental-ffi`;
  Node CI covers Linux x64 only. Not chosen.
- Node 26.13.1 is the LTS line "Lithium" (nodejs.org/dist/index.json).
  `node:sqlite` is a release candidate there (Stability 1.2 since v25.7.0).

## Non-goals

Native attach, a web page (until its own design), Windows, and any change to
what the companion is asked: task text stays verbatim.

## Steps

Each step lands and is tested alone. Before each step, measure its open
unknowns in isolated homes; a failed measurement changes the step, not the
evidence.

### Step 0: Node 26 floor

Raise `engines.node` to `>=26` in both `package.json` files, make doctor and the
dependency installer refuse older Node with the upgrade command, and run the
test suite and CI on Node 26.

Check: the suite passes on Node 26; doctor reports a clear refusal on Node 24.

### Step 1: Transcript core and handover

- One module locates and reads each companion's native transcript and yields a
  normalized, in-memory item list: user, assistant, reasoning, tool call, tool
  result, edit, usage, status. It stores nothing.
- Adapters record where their transcript lives as a native reference, such as
  Codex's `Thread.path`.
- Each reader reports the native format version but never gates on it, because
  companions release often. Every record type is mapped, listed as known
  bookkeeping, or returned as a counted `unrecognized` item, never a guess.
- At turn start the controller records a worktree snapshot with a throwaway
  index (`GIT_INDEX_FILE=<tmp> git add -A && git write-tree`), leaving the user's
  index untouched. At terminal it builds the handover summary: final answer,
  edits and commands with exit codes from the transcript, errors,
  interventions, usage, and the labelled git diff-stat.
- `agent-digest://<id>` renders from the transcript on demand. The controller
  stops writing `runtime/digests/`.

Measure first (done; see Outcome): Antigravity's other step types, OpenCode
in-place updates, the Claude `-p` transcript, Codex `Thread.path` on resume.

Check: per-companion fixtures captured from isolated runs; a drift test fails on
an unknown record type; summary unit tests; the git snapshot leaves `git status`
and the index unchanged; the full suite passes.

Outcome (2026-11-15):

- Measured: Codex returns `thread.path` on both thread/start and thread/resume;
  the bridge's `nativeTurnId` is the transcript's native turn id for Codex,
  Claude and OpenCode across first, follow-up and failed turns; Copilot runs one
  session per execution; Antigravity turns are selected by step timestamps.
- Fixtures from isolated captures missed the operator's real record types
  (Codex code-mode `exec`, extension tools, compaction, MCP and subagent calls;
  Claude and Copilot bookkeeping). Mappings were extended from structure-only,
  scrubbed samples taken locally. Read-only over real stores: Codex 150/150 and
  Copilot 33/33 files fully recognized, Claude 146/150 (31 of 44,397 items in
  four rare types stay explicit).
- Defects fixed: a Copilot in-turn provider failure (429 after Copilot's own
  retries) arrived as reply text with `end_turn` and was reported completed;
  its native `session.error` now makes the result failed. The ACP adapter
  reported the JSON-RPC request id as `nativeTurnId`; delivery is now
  acknowledged with `nativeTurnId: null` and `promptRequestId`.
- Verified through the real bridge in isolated homes for Codex, Claude,
  OpenCode and Copilot: work summaries, the git diff-stat in a git worktree, and
  `agent-digest://` rendered on demand with no `runtime/digests/` written.
- Not captured in this step: an Antigravity provider failure (reproduced on
  2026-11-22 with a corrupt image), or OpenCode row updates between a step's
  start and completion.
- For Step 2: an incremental JSONL read re-parses the whole file to keep tool
  joins and turn ids right, then returns only new items. The 10,000-line gate
  must include that cost.

### Step 2: Read-only terminal UI

Decided with the owner on 2026-11-15 (mockup: `docs/mockups/live-view-tui.html`):

- Layout A: two panes. The left list has one two-line card per job: status
  glyph, job title and age, then dim `companion · project`. The right pane
  shows the selected job: one dim header line with only what the card lacks
  (host › lead session, model, effort, tokens, branch), then the transcript.
  The live line appears once, as the transcript's last line. A finished job
  opens on its outcome (result line, git change list, answer), transcript
  below. Each fact appears once; five emphasis levels as in the mockup.
- Narrow terminals (under about 110 columns): one pane at a time. The list
  fills the screen, Enter opens the job full width, Esc returns.
- Jobs: all jobs from both hosts' state directories, running first, then the
  last 24 hours; a key shows older ones; `/` filters.
- Job title: the calling subagent's task description where the host records
  it (measured available on the Claude host: the record's `hostSessionId`
  leads to the lead session's transcript, whose Agent call result names the
  subagent id), otherwise the first line of the task. The lead session's
  title comes from that transcript too.
- Detail: preamble hidden until asked for; command and tool output folded to
  the first and last few lines with a count; a key expands an item or all.
- Read-only. Built by Claude or an Opus subagent, not Codex.
- Launch: setup.sh installs an `agent-companion` launcher in `~/.local/bin`
  that runs the plugin's UI with a Node 26 it resolves the way the hooks do.
  A Claude plugin `bin/` reaches only Claude's own Bash tool and blocks
  claude.ai and Cowork installs, so it is not used.
- In-flight text comes from the execution's `progress`; it is essential for
  OpenCode, which writes reply text to its own store only when a step
  completes (measured: a 70 s reply landed in one write).
- JSONL is followed by cursor reads on change; SQLite by polling with the
  reader's row cursor.
- Ink 8 with alternate screen, indexed wrapped rows and visible-row rendering.
- Dependencies install through `hooks/install-deps.sh` into plugin data on both
  hosts; nothing generated or symlinked inside the Codex bundle.

Measure first: the Codex host's caller information (owner thread → parent
thread and its name); that `~/.local/bin` is on PATH or what setup must say
when it is not; how the launcher finds the plugin root and Node on each host.

Check: a 10,000-line append, scroll, resize and collapse test with no frame over
an agreed budget (set from a first measurement); headless snapshot tests; a
manual read-only run against live jobs. If the gate fails, switch to Ratatui
before Step 3.

Outcome (2026-11-15, `feat/live-tui`, not merged):

- Measured, Codex caller information (read-only, the owner's files): a Codex
  execution's `owner` is the calling subagent's thread and `hostSessionId`
  the root session. The subagent's rollout `session_meta` names its task
  (`agent_path`, `/root/<task_name>` from `spawn_agent`), nickname and
  `parent_thread_id`. The `spawn_agent` message in the parent's rollout is
  encrypted (codex-cli 0.168), so no longer description is readable.
  `$CODEX_HOME/session_index.jsonl` names the threads someone named (2 of 4 lead
  sessions); `state_5.sqlite` titles are first user messages in a private,
  versioned store and are not read. Codex jobs are titled by the task name
  (underscores as spaces). Claude jobs use the Agent call's
  `toolUseResult.description` matched by `agentId` (40 of 40 recent jobs);
  lead transcripts reach 140 MB, so each is scanned once and then only its
  appended bytes. The lead title is the latest `custom-title`, else `ai-title`.
- Measured, launcher: `~/.local/bin` is on the owner's PATH (`~/.zprofile`).
  Setup installs a two-line launcher that runs the checkout's
  `hooks/launch-ui.sh`; off PATH, it prints the export line and edits no shell
  file. The launch script resolves Node with `hooks/node-tools.sh` and finds
  ink and react in the checkout's `bridge-server/node_modules` (setup's `npm ci`
  or Claude's link into plugin data), else in Codex plugin data through the
  bridge's resolver preload, which now relocates any bare package import from
  `bridge-server/` sources. It installs nothing; the UI lives in
  `bridge-server/ui/` for this resolution.
- Measured, reader cost: a whole-file cursor read takes about 30 ms for 40 MB and
  171 ms for a 140 MB Claude transcript (real stores). `followTranscript` keeps
  the parse state and reads only appended bytes; tests compare it with cursor
  reads at every append.
- Gate (`bridge-server/ui/perf.test.mjs`): a running Codex job's JSONL grows to
  10,020 items (17 MB) in 200 batches of 50 and 20 single appends; then 182 key
  frames through Ink's stdin, 10 resizes across wide and narrow, 24 expand and
  collapse frames, each timed to the flushed frame on a fake TTY. Apple M-series,
  Node 26.13.1, five runs: append p95 8.3–9.2 ms, max 17.4–21.4; keys p95
  7.8–9.1, max 16.9–21; resize max 57–63; expand all max 37–51; opening the
  10,026-item job cold 55–78 ms. Budget, about three times that: append and keys
  p95 25, max 60; resize 200; expand p95 120, max 200. Re-reading the whole file
  per append measured append p95 27.1 ms and fails. Ink passes; Ratatui is not
  needed.
- Gate revised 2026-11-17: the fixed budget failed CI with no regression.
  GitHub's runner with coverage measured append p95 39.9 ms, keys 35.9, resize
  247 and expand 166, about four times this Mac (CI runs at 7c2e839 and 7180c3c).
  The gate now times every action at ~500 items and again at 10,000 in the same
  run. Appending, scrolling and typing may be at most three times slower at the
  larger size; expand-all and resize may grow at most linearly. Large over small
  medians: current code 1.0–2.0 across plain, coverage and slow-core runs (about
  seven times slower than plain); re-reading the whole file per tick 6.5–9.4 on
  appends; a row cache that never hits 3.8–6.7 on appends, keys and typing. The
  test carries the full table.
- Headless snapshots at 150 and 80 columns for a running, a finished and a
  failed job, and the narrow list; a manual read-only run on the owner's live
  state in a pty (alternate screen, keys, exit).
- Decided while building: tokens come only from the result's usage (running
  transcripts report usage per message or cumulative per thread, which does not
  sum to a turn); the header says "done in 24h" to match the list window; the
  item cursor shows only when the transcript has focus; an answer or provider
  error repeated in the transcript reads "shown above"; an active record with
  no result and no live process is `unknown`; native text loses terminal
  escapes, bidi overrides and control characters, and no frame row contains a
  newline (a heredoc command wraps as continuation rows).
- Fixed in review: a refused command was also counted as failed in the outcome
  line. Setup's `npm ci` emptied Claude's plugin-data install through the
  checkout's `node_modules` link (reproduced; it happened to the owner's live
  plugin on a Codex refresh); setup now removes only the link first, and
  Claude's next session start links it again.
- Open: opening a job replays its transcript once, so selecting through very
  large transcripts can stall for that read (171 ms at 140 MB). OpenCode and
  Antigravity polling is covered by the reader fixtures, not by the gate.
  Codex desktop as a host is unchecked.

### Step 3: Interventions

Design (decided 2026-11-15, after the measurements above):

- One controller entry, `intervene({ executionId, from: 'caller' | 'user', mode, text })`,
  under the conversation lock. Modes are steer, queue, interrupt (interrupt &
  send) and cancel. A mode the companion lacks is refused, never substituted.
  Each intervention is recorded on the execution (sender, mode, text, time,
  delivery state) before it reaches the companion.
- A job is a loop of native turns. After each turn ends, the controller continues
  while the companion reports pending input (Claude's queued UUIDs) or the
  bridge holds a queued message (delivered as the next turn on the same live
  session). Interrupt & send ends the running turn natively, then delivers only
  the new text. The job ends when nothing is pending; the result lists each
  turn's answer once, labelled with the message it answers. A failed turn ends
  the job; messages still queued are reported as not delivered.
- Per companion (own default first): Codex steer (`turn/steer`), queue (next
  `turn/start`), interrupt (`turn/interrupt` then `turn/start`). Claude queue
  (written at once; Claude decides same or next turn), interrupt (`send_now`).
  OpenCode steer (mid-turn prompt), queue, interrupt (abort then prompt).
  Antigravity steer (mid-turn prompt), queue and interrupt (`session/cancel`
  then prompt), all measured live on agy 1.5.13. Copilot cancel only.
- The user's path is an inbox file (0600) in the owning host's state, read on
  the controller tick like stop markers. Messages are accepted only while the
  job runs and the owner has not stopped; otherwise the inbox entry is refused
  with a visible reason.
- Inbox contract (shared by 3b-3 and 3c): the live view writes one request per
  file, atomically (temporary file, then rename), mode 0600, at
  `<host state dir>/inbox/<executionId>/<requestId>.json` with
  `{ requestId, executionId, mode, text, at }`; mode is steer, queue, interrupt
  or cancel (cancel has no text). The owning bridge's controller reads its live
  executions' inbox directories on its tick, applies each request as
  `from: 'user'`, then writes `<requestId>.outcome.json`
  (`{ requestId, ok, status, reason?, interventionId? }`, same atomic write) and
  removes the request. A request for an execution that is not live in that
  bridge is answered with reason `state`. The view deletes an outcome after
  reading it; the controller removes the execution's inbox directory when the
  execution closes, so a request left there is moot (the job has ended). Only
  regular files are read, with the text capped; a user cancel stops the job
  with cause `user_cancel`. At start the controller records the
  adapter's `interventions` capability on the execution as `interventionModes`,
  so the view offers only the modes that job supports, plus cancel.
- `agent_wait` returns early with `user_intervened` (sender, mode, text, time,
  no answer); the subagent relays it and waits again. `agent_reply` gains
  `mode`, defaulting to the companion's own. Status reports per-mode
  availability instead of `reply_available`. Both role templates and the
  host-parity test change.
- The live view gains an input box and cancel (built by Claude or an Opus
  subagent, not Codex), approved as `docs/mockups/live-view-interventions.html`:
  a running job's pane reads like the companion's own app, with the input box
  pinned under the live line. Opening a running job focuses the box; ⏎ sends in
  the mode shown, which starts on the companion's default; shift+⇥ cycles the
  modes that job supports; ctrl+j adds a line; ↑↓ and PgUp/PgDn scroll; ctrl+o
  expands all outputs; ctrl+x cancels the job after one confirmation; esc
  returns to the list and keeps the draft; ctrl+c clears the draft, then quits.
  A sent message waits between the live line and the box with its state until
  the companion takes it. Ended or failed jobs show no box and keep the step 2
  keys. Transcript labels: `task` (the lead's request), `lead` (its later
  messages) and `you`.

Build order, each a separate brief and commit:

1. 3b-1: the controller's turn loop, intervention records and modes, with the
   Codex and Claude adapters.
2. 3b-2: OpenCode, Antigravity and Copilot capabilities and adapters.
3. 3b-3: the inbox, `agent_wait` early return, `agent_reply` modes, status,
   both templates and host parity.
4. 3c: the live view's message box and cancel.
5. 3d: isolated live probes through the bridge for Claude, Codex and OpenCode
   (the step 3 harnesses), and a live Antigravity run on the owner's login.

Check: controller tests for every mode × capability, including refusal after the
job ends or the caller returns, queued messages behind a failed turn, and a
Claude message that becomes the next turn; template and host-parity tests; the
probes above; the full suite passes.

Outcome (2026-11-15, branch `feat/interventions`):

- Built in five briefs: the turn loop with Codex and Claude (1678928), OpenCode
  and Antigravity (2e5ec76), the inbox, early notice, reply modes and the
  registry as the one source of each companion's modes (61ee448), and the input
  box (4c7eeff, c025fe3, merged as d4e7ccb). 860 tests pass.
- Fixed in review: single-turn answers stay unlabelled; labels address the
  caller (`User's message`, `Caller's message`); a steer between turns no longer
  dereferences a missing turn; a job's usage sums its turns, with Claude's
  cumulative `total_cost_usd` turned into each turn's share (measured: usage is
  per turn, cost is cumulative); OpenCode publishes a stop-time interrupt on its
  acknowledgement again and drains only for interrupt & send; drafts are cleaned
  like native text.
- Live probes through the real bridge from the branch (`/tmp/step3-measure/3d`,
  isolated bridge state; Claude and Codex on loopback mocks, OpenCode on its
  free model, Antigravity on the owner's login): Claude 54, Codex 59, OpenCode
  26 and Antigravity 41 checks passed, none failed. They cover inbox requests
  written with the view's own helper, outcomes (0600, consumed once), exactly
  one early notice per user message, labelled multi-turn results, interrupt
  then answer, user cancel (`user_cancel`), inbox removal at close and no
  surviving process. Antigravity's queue and interrupt worked on the same ACP
  session.
- Not measured: installed hosts' hook attribution with interventions (the
  probes use the free-backends client's synthetic subagent metadata); how
  tmux and other multiplexers report shift+⇥.
- Open: the draft has no cursor movement (←/→, Home/End); the view creates the
  inbox directory itself, so a job that closes in between can leave an empty
  directory.

### Step 4: Claude pane and agent rows

Decided 2026-11-17 with the owner, after the measurements below; approved as
`docs/mockups/live-view-claude-pane.html`:

- A mod shipped in this plugin (Claude Code only; Codex ignores it). It follows
  Claude Code's theme: theme colour keys, never raw colours, and a pane opened
  with `backgroundColor: "transparent"` (the default pane colour measured as a
  visible mismatch against the chat).
- Agent rows: each agent-companion subagent's row in Claude Code's agent list
  carries its job's progress: title, companion · model, the live line (the
  running command, responding, a queued message of the person's, retrying) and
  elapsed time, refreshed while it runs. Other subagents' rows are untouched.
- One pane, "Companions", that follows the view the person has on screen: with
  the main conversation in view it lists this session's companion jobs as the
  live view's cards (running first); picking one switches Claude Code to that
  subagent's view (`$.ui.view`), and with an agent-companion subagent in view
  the pane shows its job like the live view's job pane: the same labels,
  folding, pending messages and input box, cancel included. Any other view
  shows the list. `/companion` opens it at any width. Changed 2026-11-18
  (`docs/DEFAULTS_PLAN.md` step 1): a job's start no longer opens it; entering
  an agent-companion subagent's view opens it unasked (wide terminals only, the
  keys left at the prompt), and the return to the main conversation closes that
  pane unless the person took it since (its keys, a press in it, `/companion`).
- Reuse, never copy: text through `bridge-server/ui/rows.mjs`; the transcript
  from the core reader in a Node child streamed with `$.process.spawn`; inbox
  requests and outcomes through `bridge-server/ui/inbox.mjs` in a Node child.
- The MCP progress line is dropped: its text reaches only the calling loop's
  spinner, a subagent's own view; the agent row is where the lead's view looks.

Measure first: whether Claude shows progress for a subagent's tool call, and
whether the pane redraws while the main loop is busy.

Measured 2026-11-17 on Claude Code 2.1.326 with a probe mod loaded into a live
session (mod API types for that build; the probe recorded and changed nothing):

- A pane redraws while the main loop is busy: a `$.clock.every(1000)` pane got
  20 ticks during a 20 s Bash call, each followed by a redraw about 2 ms later.
- The spawn's `agentId` is the execution owner: `agent.spawn` answered
  `ad540b80…` for a background agent-companion subagent; that subagent's
  `agent_send` call carried the same `agentId`, and the bridge recorded it as
  `thread`. The `agent_send` result in the same `tool.call` hook gives the
  `job_id`, so a mod maps agent to job without reading records.
- The lead's at-a-glance agent list asks a `ui.render` `AgentRow` hook for each
  subagent at spawn and about every 5 s (four asks in 15 s); a hook may replace
  the row's `body`. That row is where an in-flight line reaches the lead's own
  view. `ToolProgress` covers only the run-in-background hint, and MCP progress
  text reaches only the calling loop's spinner (earlier measurement), which for
  a subagent is its own view.
- Panes opened unasked are placed from 144 columns (110 once the person has
  opened one); below that they wait. The terminal surface has an `Input`
  element; `$.ui.view({ agentId })` switches to the subagent's view.
- `$.fs.read` reads byte ranges up to 4 MiB; `$.fs.write` has neither a mode nor
  an atomic rename, so inbox requests go through `bridge-server/ui/inbox.mjs` in
  a Node child (`$.process.run`), keeping one writer. `$.process.spawn` streams
  a child's output without a permission prompt. `bridge-server/ui/rows.mjs`
  has no imports, so a mod in this plugin can reuse its cleaning, folding and
  wrapping.
- Side finding: a probe job whose cwd sat inside `~/.claude` (a git repository)
  made the worktree snapshot hash that repository: 32 loose objects (~200 KiB),
  index and tree untouched. Expected behaviour of the snapshot; probes use a
  cwd outside any repository the owner did not choose.

Check: `claude plugin validate`; mod tests under `claude plugin test`; a manual
live run.

Live run (2026-11-17, Claude Code 2.1.326, 175 columns, OpenCode free model at
$0, driven through computer use and the owner's keys). Working: agent rows
(live line, interrupted outcome), the pane opening by itself, the list, a card
switching the view, the job's transcript, the box's keys and growth, steer sent
from the pane (the lead got `user_intervened`, the companion answered), the
mode cycle, cancel with its confirmation (`user_cancel`, the lead told), `←
jobs`, the keys handed back to the chat. Fixed on the way: the pane never opened
by itself (the row's clock found the job before `agent_send` answered); the box
floated, overflowed its field and dropped newlines from view (the engine sizes
an `Input` from the pane's width less its hint, so it now sits between rules,
the pane's full width, growing with its draft); a cancelled job's view had no
outcome (the follow ended in the stopping gap); OpenCode's cancel-killed command
read as failed (now `unfinished`); messages from you or the lead are drawn whole.

Open after the run:
- A steer that joined a turn the job's stop then cut off is recorded
  `not_delivered` (controller's turn end and `discardInterventions`), though the
  companion read it. Plan: a terminal state for messages that reached the
  companion's turn and got no answer, kept apart from `not_delivered`; both
  roles relay it; README and Architecture updated.
- `/companion` in the typeahead after viewing an agent and returning is still
  unverified live.
- Engine look, not ours: a card under the mouse is highlighted as the focused
  one is, and a focused card's hotkey digit keeps its accent shade.
- On main: `bridge-server/adapters/acp-replay.test.mjs` "recorded Copilot wire:
  cancel" hangs to its 15 s timeout when run alone and passes after the file's
  other tests; it timed out once in a full run.

## Risks

- The native formats are private. Expect reader breakage on companion upgrades;
  the fingerprints make it explicit, and fixtures make the fix quick.
- The mod API may change without notice; failures are isolated to the pane.
- Changing `agent_reply` changes the lead's contract on both hosts.
- The git snapshot writes loose objects into the repository's object store;
  `git gc` reclaims them.
