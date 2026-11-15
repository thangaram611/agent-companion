# Live view and interventions: plan

Status: agreed 2026-11-15. Step 0 landed as 4e536d0; Step 1 as 2222e9b, 229b310
and 2c9577b; Step 2 as 37e7b0e through 497a740. Steps 3–4 are not started.

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
| After the caller returns | The view is read-only. |
| Native attach | Not built. |
| UI | Shared Node core first, then a terminal UI in Ink 8, then a Claude Code pane and an MCP progress line. The web page is deferred for its own design discussion. |
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
| Antigravity 1.1.1 | `$GEMINI_HOME/antigravity-acp/conversations/<sessionId>.db` | SQLite (WAL); `steps(idx, step_type, status, step_format, step_payload…)`; payloads are protobuf with no published schema | Yes, per step: a running command is on disk with status 2 and flips to 3 when done (measured on a live bridge job, the operator's real home) | File name equals the bridge's history id, the ACP session id (measured) | `step_format`, and the field numbers below |

Antigravity is the weak link: its steps are undocumented protobuf. A schema-less
wire decode read everything needed from a live job: step type 14 is user input
(text at field 19.2); 15 is the model's reply (text at 20.1, model id at 5.24.8,
tool calls at 20.7 with id, name and JSON arguments); 21 is a command (command
line at 28.23, output at 28.21, cwd at 28.2). Status 2 is running and 3 is done.
These field numbers are the reader's fixture; any unknown step type or missing
field yields "format unrecognized", never a guess.

### Interventions

| Companion | Own default mid-turn | Steer | Interrupt & send | Cancel |
| --- | --- | --- | --- | --- |
| Codex | Steer: `Enter` submits immediately, `Tab` queues (`codex-rs/tui/src/bottom_pane/chat_composer.rs` at rust-v0.169.0; `steer` feature graduated) | `turn/steer`; spike: mid-turn input restarted generation inside the same turn | `turn/interrupt`, then `turn/start` on the same thread | Existing |
| Claude Code | Queue. A message written during a tool call joined the same turn after the tool finished, as "The user sent a new message while you were working"; written during final text it ran as the next turn | Effectively, at tool boundaries | `interrupt` with `send_now: true` started a new turn on the same session | Existing; `cancel_async_message` drops a queued message |
| OpenCode | Prompts are acknowledged `delivery: "steer"` through `session.inbox.*`; mid-turn behaviour not measured | Not measured | `/interrupt`, then prompt | Existing |
| Antigravity | ACP runs one prompt at a time: queue | No | `session/cancel`, then load and prompt | Existing |
| Copilot | Follow-up is refused (`FOLLOWUP_UNSUPPORTED`) | No | No | Existing |

Only Claude's interrupt & send was measured end to end; the Codex, OpenCode and
Antigravity sequences are compositions of protocol calls the adapters already
use. The Claude measurement ran with `--bare` for isolation, which the adapter
never uses. One process ran several turns in the same session. Trap: the controller
treats Claude's `result` as terminal and closes the tree, so a message queued
during the final text would be lost unless the controller delivers it.

### Rejected options

- **Native attach.** Codex: a second client (`codex --remote … resume <thread>`)
  rendered the turn live, could steer, and interrupted it with Esc or Ctrl+C; the
  bridge would have to move app-server from stdio to a private Unix socket
  speaking WebSocket (measured: `101 Switching Protocols` on `/rpc`). OpenCode:
  `opencode --server <url> --session <id>` with `OPENCODE_PASSWORD` attached and
  steered; its input was visible to the bridge as `session.inbox.enqueued`.
  Claude only attaches `--bg` sessions. Copilot and Antigravity have none.
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
- Not captured: an Antigravity provider failure; OpenCode row updates between a
  step's start and completion.
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

- Controller: `intervene({ executionId, from: 'caller' | 'user', mode, text })`
  under the conversation lock, recorded on the execution.
- The user's path is an inbox file (0600) the controller reads on its tick, like
  stop markers. A stop marker for the owner (the caller has returned) makes the
  inbox refuse with a visible reason.
- Adapters advertise per-mode support. Queue falls back to delivering a
  follow-up on the same native history after the turn ends; interrupt & send
  interrupts, then follows up with only the new text.
- Claude: hold a message queued during the final text and deliver it as the next
  turn, never lose it at `result`.
- `agent_wait` returns early with `user_intervened` (mode, text, time); the
  subagent relays it and waits again.
- `agent_reply` gains `mode`, defaulting to the companion's own. Status reports
  per-mode availability instead of `reply_available`. Both role templates and
  the host-parity test change.
- The UI gains cancel and a message box with a mode choice.

Measure first: Claude's queue on the adapter's real startup path (no `--bare`);
OpenCode mid-turn steer; Codex steer through the bridge's own connection.

Check: controller tests for every mode × capability, including refusal after
the caller returns; isolated live probes for Claude, Codex and OpenCode; template
and host-parity tests; the full suite passes.

### Step 4: Claude pane and progress line

- A pane per running job, tied to its Agent row through `agent.spawn`'s
  `agentId`, which is the execution's owner.
- The mod has no Node and `$.fs.read` stops at 4 MiB, so it streams the core
  reader through `$.process.spawn`. Controls write the same inbox.
- The bridge sends MCP progress with the in-flight line during `agent_wait`.

Measure first: whether Claude shows progress for a subagent's tool call, and
whether the pane redraws while the main loop is busy.

Check: `claude plugin validate`; mod tests under `claude plugin test`; a manual
live run.

## Risks

- The native formats are private. Expect reader breakage on companion upgrades;
  the fingerprints make it explicit, and fixtures make the fix quick.
- The mod API may change without notice; failures are isolated to the pane.
- Changing `agent_reply` changes the lead's contract on both hosts.
- The git snapshot writes loose objects into the repository's object store;
  `git gc` reclaims them.
