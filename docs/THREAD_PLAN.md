# Threads: the lead talks to the companion without a subagent: plan

Status: released as 1.0.0 (2026-11-23). Steps 0 to 8 are done, checked live on
both hosts and in installed form, and merged to main. Every fact under Evidence was measured
on 2026-11-22 unless it says otherwise.

## Goal

Today the lead spawns a native `agent-companion` subagent that re-types the brief
to the bridge and re-types the companion's answer back. It reads everything in
the middle and can change it; one 65 KB Codex report took the subagent 19 minutes
to relay. This plan removes it. The lead calls the bridge itself, the bridge owns
the conversation as a thread, and the lead is woken when the thread has news.

The change reaches identity, the tool surface, delivery, hooks, both host
packages, the views and most of the largest tests, so the plan also fixes the
structure those parts share: adding a companion, a tool, an acknowledgement
field or a host should touch a handful of files, not thirty to forty. Every
shipped behaviour is listed in [THREAD_FEATURES.md](THREAD_FEATURES.md) and must
still hold at the end. The code and test measurements behind the structure
choices are in [THREAD_AUDIT.md](THREAD_AUDIT.md).

## Decisions (2026-11-22)

Decisions 1 to 9, 11 and 12 are the user's. 10 turns their direction (no pickup
of threads across sessions) into a rule. 13 to 23 are proposed here to complete
the design and stand once this plan is approved.

1. **The lead calls the bridge directly.** No native subagent sits between the
   lead and the companion. Every host gets the same tools.
2. **A thread is owned by the bridge.** It is linear, lives outside both models
   and records the lead's messages, the companion's answers, human messages and
   cancels. The first send returns the thread reference; the lead passes it to
   continue.
3. **Send returns at once and says exactly what it did:** which companion it
   started, where, under which thread, and how news will reach the lead.
4. **Wait is optional.** It is one blocking tool, the same on every host. A lead
   that just ends its turn still gets the result.
5. **A job ends on an explicit cancel only,** or on its own completion, a user
   cancel from the companion page, or bridge loss. A cancelled wait or an Esc
   never ends a job. There is no pause: stop, and a later send resumes.
6. **Results always carry the reference.** The text is inline when small and left
   out when too big; the lead reads the rest by reference. The same rule applies
   to what the companion is sent.
7. **A companion's question is a turn-end post.** The lead's reply resumes the
   companion from its saved history. No mid-turn ask tool.
8. **One wake adapter per host,** hidden from the models. Claude Code uses the
   session's inbox socket. Codex CLI uses `codex queue`.
9. **Hooks keep today's events:** session start, prompt submit and after a tool
   call. No holding of turns and no new hook mechanisms.
10. **A thread belongs to the conversation that started it.** The listing shows
    only that conversation's threads. After `/clear` or in a new session the old
    threads are not listed and not woken; they stay on the companion page.
    Codex keeps a conversation the user left loaded until it has been idle for
    `thread_unload_delay_secs` (60 s by default): a job ending then wakes it
    unseen, and one still running ends in bridge loss. The wake stays as it is,
    since Codex tells no one which conversation a window shows (2026-11-23).
    `setup.sh --codex-unload-delay <seconds>` sets that delay, opt-in: shorter
    means fewer unseen wakes and running jobs stopping sooner after the user
    leaves, longer the reverse.
11. **No shared bridge server.** The bridge stays the host session's own child,
    and no job runs outside the lead's session. On Codex the session is the
    daemon's conversation, so each conversation's bridge is the daemon's child.
12. **Antigravity is in scope again** (pause lifted 2026-11-22).
13. **Six tools, one changed set.** `agent_reply` folds into `companion_send` (a send
    to a running thread is an intervention with a `mode`), and `companion_read` is
    new. `companion_status` with no arguments lists the caller's threads.
14. **Sizes.** A wake notice or hook injection inlines an answer up to 4,000
    characters. `companion_read` pages at 8,000 characters by default and 40,000 at
    most. Both sit under every cap measured below.
15. **The lead's identity comes from the host on every call,** never from the
    model: the hook's session id on Claude, turn metadata on Codex. The thread
    reference is the only id the model carries.
16. **A subagent may still be a lead.** Any native subagent that calls the tools
    owns its own threads. It gets no wake (it is inside a turn) and uses wait.
17. **Recursion is refused from records, not from flags.** A call whose caller is
    a companion session that any bridge started is refused.
18. **The `agent-companion` subagent role is deleted** in step 2, with the old
    tool surface, so no later step has to keep its templates and prose tests
    alive. Nothing merges before step 8 passes.
19. **OpenCode, Copilot CLI and Antigravity as hosts are specified here and built
    later,** one host per milestone, under tracker decision 9's adoption check.
    Nothing in steps 0 to 8 depends on them.
20. **Three registries, and nothing else lists their members:** companions
    (`lib/companion-registry.mjs`, exists), hosts (`lib/hosts/`, new) and tools
    (`bridge-server/tools.mjs`, new). Every other list of companions, hosts or
    tools is derived from them.
21. **One delivery implementation.** The completion queue, its receipts and the
    shell drain become one Node module used by the tools and by one hook entry.
    The shell part shrinks to a stub that starts no process when there is no
    news, which keeps the measured fork budget.
22. **Legacy that no lead can reach is deleted:** the phase-1 migration and the
    legacy threads, jobs and history. The settings migration from per-host
    defaults stays, because it has not been in a release yet.
23. **A test pins a behaviour, once.** The rules are under Tests. Total test
    lines end below today's.

## Evidence

Probes live in `.drafts/direct-main/` (ignored by git) and move to
`probes/direct-lead/` in step 0. They use isolated homes, a fake job server and,
where a model is needed, Haiku, a scripted Responses-API stand-in, the free
OpenCode model or `gemini-3.8-flash-low`.

### Claude Code 2.1.330

- **The main conversation can call the bridge.** Its PreToolUse payload has
  `session_id`, `prompt_id` and `tool_use_id` and no `agent_id`. End to end with
  the real bridge and a free OpenCode job of 150 s, the lead received the result
  and every owned process was verified gone.
- **Inbox socket.** Each session binds one. `CLAUDE_CODE_MESSAGING_SOCKET` and
  `CLAUDE_CODE_MESSAGING_TOKEN` reach hooks and the MCP server's own
  environment. Two lines start a turn on an idle session:
  `{"type":"auth","token":…}` then
  `{"type":"user","message":{"role":"user","content":"…"}}`. The model reads
  "Another Claude session sent a message: …". The docs describe the socket, the
  two variables, the auth line and a script posting to its own session. They do
  not give the message line, and they name hooks and Bash commands, not MCP
  servers, as receiving the variables. The line is the same shape as Claude's
  documented stream-json user input and comes from the program's own debug
  text. A plain text line starts no turn, with or without the auth line.
- **Who may post.** Posted by the MCP server (a child of the session) it is
  delivered in bypass-permissions mode. Posted by an unrelated process with the
  token it is held for approval there (`peer_message_hold`, cause
  `no-mode-asserted`).
- **Busy and bursts.** A post during a 25 s tool call was delivered 0.2 s after
  the call returned, inside the same turn. Two posts back to back arrived as two
  turns. Docs: about a million characters per message, identical repeats within
  a short window are dropped, 50 queued at most.
- **`/clear`.** `SessionEnd` (reason `clear`), then `SessionStart` (source
  `clear`) with a new session id. The socket path and the MCP server process
  stay. A post after `/clear` lands in the new conversation.
- **Compaction.** `SessionStart` (source `compact`) with the same session id.
- **Prompt hook.** `UserPromptSubmit` fires for a socket-posted message, so the
  result hook runs on the wake's own event.
- **Cancels.** Esc on a foreground wait sends `notifications/cancelled` (reason
  `AbortError: user-cancel`). `TaskStop` on a backgrounded wait sends it too.
- **Tool results.** 30.9k characters arrived inline. 71.8k and 307k were saved to
  a file by Claude Code and the lead was given the path, checksums matching.
  Docs: hook `additionalContext` is capped at 10,000 characters.
- **Wait.** A direct wait still running at 120 s moves to the background and its
  result wakes the idle lead. The 1320 s per-call wall still applies (docs).
- **Other wakes that work but are not used:** a hook-started waiter that exits 2
  (12 minutes passed), a mod's `$.prompt.submit` (307k characters inline), a Stop
  hook that holds then refuses the stop (12 minutes passed).

### Codex CLI 0.171.0

- **The root thread can call the bridge.** Turn metadata has
  `thread_id == session_id` and `thread_source: "user"`. The call blocks the
  turn; nothing moves it to the background.
- **`codex queue --thread <id> --message <text>`** from another process started a
  turn on an idle root at once, with default settings. To a busy root it started
  a new turn right after the running one. Two in a row gave two turns. The text
  arrives as a user message and `UserPromptSubmit` fires for it.
- **The daemon** (2026-11-23). By default the TUI runs its conversations in a
  managed app-server daemon per Codex home; `--dangerously-bypass-hook-trust` or
  `--no-daemon` keeps them in the TUI. The bridge and every hook are the
  daemon's children, shared by every window on that home.
- **`/new` and `/quit`** (2026-11-23, both modes). `/new` starts the new
  conversation and its own MCP server at once and leaves the old one loaded.
  SessionStart for the new one fires only at its first prompt; nothing ends the
  old one. A queue to the old one starts a turn that no screen draws, and its
  prompt hook runs. Codex shuts a conversation down once it is idle about a
  minute with no client ("has no subscribers and is idle"), closing its MCP
  server: a job still running ended in bridge loss 62 s after `/new`. After
  `/quit` the same happens with no window open. The research note that a queue
  to a left thread starts no turn had no run behind it.
- **The unload delay** (2026-11-23). The minute is `thread_unload_delay_secs`,
  a top-level `config.toml` key (default 60 since openai/codex#57242, 1800
  before). The daemon reads it when it starts and fixes it per conversation; an
  override on `thread/resume` of a loaded conversation was ignored (unloaded at
  61.2 s). At 0, the conversation left unloaded 1.3 s after `/new` and its
  running job ended in bridge loss at 1.8 s. Codex unloads to free each
  conversation's MCP servers (openai/codex#11324) and its writer lock
  (openai/codex#41849).
- **A wake restarts the delay.** `/quit` at 0 s, a wake at 53 s, unload at
  113 s. A woken lead keeps its conversation loaded while it works, then for
  the delay again. Leaving does not stop a running turn: a pending `companion_wait`
  delivered into the conversation left. Resuming that conversation delivers an
  unread result at its first prompt.
- **No presence signal** (2026-11-23). Status, read state,
  `canAcceptDirectInput`, the loaded list, files, locks and the log are the
  same for a watched conversation and a left one; neither `inject_items` nor a
  blocked prompt changes them. Codex has no subscriber API
  (openai/codex#58423 asks for one).
- **A prompt hook can block** with `{"decision":"block","reason":…}`: no model
  call, and a watching window shows the reason. A second hook that blocked did
  not stop ours from claiming the result, so a block would have to live in
  `hooks/hook.mjs` and claim nothing. Not used.
- **Optional MCP servers can miss the first turn** (2026-11-23). On a cold
  daemon or in an in-process window, a prompt given at launch reached the model
  before the bridge listed its tools ("omitting pending optional MCP server",
  145 ms). The Codex manifest marks the bridge `required`: the first request
  then carried all six tools, and a bridge that cannot start keeps Codex from
  opening.
- **Subagents** (2026-11-23). A native subagent gets its own MCP server and fires
  no SessionStart; its hooks carry the root's `session_id` and its own thread id
  as `agent_id`.
- **Output cut.** A 71.8k-character tool result reached an unknown model as about
  12k: head, `…N tokens truncated…`, tail, no file. With
  `[mcp_servers.<server>.tools.<tool>] output_token_limit = 40000` the whole
  result arrived. Source read, not measured: known models keep about 48 KB.
- **`structuredContent` replaces text** in what the model reads (source read).
- **Background shell.** A background `exec_command` that exited started no turn.
- **Stop hook.** Exit 2 with stderr continues the turn with the text as a hook
  prompt (12 minutes passed). Not used.

### Hosts built later

- **OpenCode 2.3.2.** Starts the stdio server from the project's `opencode.json`.
  The lead calls the tool; the call's `_meta["ai.opencode/sessionID"]` names the
  session. `opencode run -s <id> "<text>"` from another process put a message
  into the lead's live session, which answered it. The MCP server is a child of
  OpenCode's server, not of one session.
- **Copilot CLI 1.0.114.** The MCP server's environment has
  `COPILOT_AGENT_SESSION_ID`. `--resume=<id> -p` from another process is refused
  while the session is open. An extension that calls `joinSession()` and then
  `session.send(text)` woke the idle lead; extensions need `--experimental`.
- **Antigravity 1.5.13.** MCP servers come from `agy mcp add` (measured) or a
  plugin's `mcp_config.json` (its own plugin guide). Each call's `_meta` has `antigravity.google/conversation_id`
  and `root_conversation_id`. Only commands the session itself runs get
  `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`; hooks get the
  conversation id only and MCP servers get nothing. A detached waiter started by
  such a command ran `agentapi send-message <conversation> <text>` and the idle
  lead acted on it 17 s later. From outside the same call is refused ("missing
  CSRF token"). `agy --conversation <id> -p` runs the turn in its own process
  and the open session does not show it.

### All five hosts

| Check | Result |
| --- | --- |
| Lead calls the tool itself | Works on all five |
| Wake after 20 s idle | Works on all five |
| Wake after 65 minutes idle | Works on all five (Claude at 3,907 s; Antigravity acted 4 s after its waiter sent) |

### Differential

Codex surveyed every delivery path on both hosts from source and docs, without
seeing these measurements. It agreed on identical tools, one store, short notices
with a reference, the same hooks as recovery, a host-specific idle wake and
`codex queue`. It differed on the Claude wake (it chose the mod's prompt submit
and left the socket unranked for two unknowns, both measured since). Its cautions
are adopted: keep "accepted", "wake attempted" and "read" as separate states, and
do not hold a turn open.

## Design

### Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `companion_catalog` | none | `default_companion` with its source, and `companions` with model and effort defaults, capabilities and readiness |
| `companion_send` | `task`; `cwd` on a new thread; optional `thread`, `companion`, `model`, `effort`, `mode`, `title` | At once: `thread`, `job_id`, companion, model, effort, permission mode, and `delivery` (which wake is armed, or why none) |
| `companion_wait` | `thread` or `job_id`, `max_wait_sec` | The next news or the terminal state |
| `companion_read` | `thread`; optional `after`, `offset`, `limit` | The thread's posts after `after`, long text paged, with a footer naming the range and the next offset |
| `companion_cancel` | `thread` or `job_id` | The terminal state |
| `companion_status` | optional `thread`, `job_id`, `diagnostics` | With no arguments: the caller's threads, each with companion, state, title and unread count |

- A send with no `thread` starts a thread. A send with a `thread` whose companion
  is idle resumes it. A send to a running thread is an intervention: `mode` is
  steer, queue or interrupt, defaulting to the job's saved default, and an
  unavailable mode is refused as today. An identical send to a running thread
  reattaches.
- A terminal result is a plain text block (the answer, or its first page) and a
  second block of metadata. No `structuredContent` and no output schema, so
  Codex shows the text itself.
- Every call from a lead that does not own the thread is refused with
  `THREAD_NOT_YOURS`.

### Identity and store

- **Lead identity.** Claude: the PreToolUse hook writes
  `lead = { session, agent }` over anything the model supplied, and still blocks
  the call if it cannot run. Codex: `thread_id`, `session_id` and `thread_source`
  from turn metadata. The thread reference is a short bridge-minted id.
- **Store.** The record in `threads/<thread>.json` stores `thread`, `lead`, `title`,
  `companion` and the latest `jobId`. Its read cursor is a
  sibling record, `reads/<thread>.json`, written under the thread's lock: the
  controller rewrites the thread record after awaits, which would drop a
  cursor written in between. Its posts are the records in `jobs/` in generation order
  with their results and interventions. No new event log.
- **Removed records:** `stops/`, `attachments/` and the "owner away" display.

### Delivery

Three layers, in this order on every host:

1. **Wake.** When a job reaches a terminal state the bridge sends one short
   notice to the lead's conversation: thread, companion, status and how to read
   it. A wake is an attempt and never marks the result as read.
2. **Hooks.** Unread results are delivered at the same three events as today
   (session start, prompt submit, after a tool call), keyed by the lead's
   conversation id. Because the prompt hook fires for the wake's own message on
   both hosts, the answer arrives with the notice in one turn. The hook inlines
   up to 4,000 characters and otherwise gives the head and the reference.
3. **Wait and read.** `companion_wait` blocks; `companion_read` pages.

| Host | Wake adapter | Sent only when |
| --- | --- | --- |
| Claude Code | Bridge writes the two lines to its own session's inbox socket | The lead is the main conversation and its session id is still current for this process |
| Codex CLI | Bridge runs `codex queue --thread <lead thread>` | The lead is a root thread |
| OpenCode (later) | Bridge runs `opencode run -s <lead session>`, detached | The session id is known |
| Copilot CLI (later) | The plugin's extension calls `session.send` | The extension has registered for the lead's session |
| Antigravity (later) | A waiter the lead starts with one command runs `agentapi send-message` | The lead ran the command |

- **Current session on Claude.** A SessionStart hook records
  `{socket, session id}` for the process. The bridge reads it before posting, so
  a wake after `/clear` is not sent. The token is read from the environment and
  never written to disk.
- **Codex home.** Codex passes none of its environment to the MCP server
  (measured again on 0.171.0), so the bridge runs `codex queue` against the same
  home it already uses for its own state, the default `~/.codex`. A relocated
  `CODEX_HOME` gets no wake, the same limit the bridge's records have today.
- **Unavailable wake.** The send response says so and names wait as the way to
  get the result. Subagent leads always get this. So does Claude Code older than
  2.1.228, which has no socket token.

### Lifecycle

| Event | Effect |
| --- | --- |
| Lead ends its turn | Nothing; the job runs and the wake follows |
| Esc, cancelled wait, stopped background wait | The wait returns; the job runs on |
| Compaction | Same conversation id; `companion_status` lists the threads again |
| `/clear` (Claude) | Old threads are not listed and not woken; their jobs run on; they stay on the companion page |
| `/new`, `/quit` (Codex) | The conversation left stays loaded until idle for `thread_unload_delay_secs` (60 s by default): a job ending then wakes it unseen, and the delay starts again. Codex then shuts it down, which is bridge loss for a job still running. Resuming it delivers unread results at the first prompt; its threads stay on the companion page |
| Host session exits | Bridge loss: owned process trees are stopped and results fenced, as today |
| `companion_cancel`, user cancel | The job stops; the thread stays and a later send resumes |

### Recursion guard

Before starting a job the bridge looks up the caller's conversation ids among the
native sessions of jobs in both state homes. A match is refused with
`RECURSION_REFUSED`. The Claude companion keeps its `--disallowedTools` guard.

## Features

[THREAD_FEATURES.md](THREAD_FEATURES.md) lists 143 shipped behaviours with their
source and pinning test. All of them hold after step 8 except these, which
change by design:

| Today | After |
| --- | --- |
| The parent briefs a subagent, which asks for a missing path | The lead calls `companion_send`; a new thread without an absolute `cwd` is refused |
| `NATIVE_OWNER_REQUIRED` for a root caller | Root callers are leads; `THREAD_NOT_YOURS` and `RECURSION_REFUSED` guard instead |
| Follow-up by messaging the same subagent; a new subagent for new work | `companion_send` with the thread; `companion_send` without one |
| `agent_reply` | `companion_send` to a running thread with a `mode` |
| A different task on a busy conversation returns `thread_busy` | It is an intervention in the default mode; an identical send still reattaches |
| An aborted owner call or a stop marker ends the job (`owner_stop`) | Neither ends a job |
| Status shows owner attached or detached | Removed with the attachment record |
| A result is claimed once by the owner call or the drain hook | Claimed once by the lead's call or the hook, through one module |
| Titles from the subagent's description | `title` on send, else the task's first line |
| A row per companion subagent in Claude's agent list | Running threads listed above the prompt with the same fields |
| The pane opens on entering a companion subagent's view; a card opens that view | The pane opens on `/companion`; a card opens the job |
| Setup and session start install the agent file | Removed with the role |
| The Claude companion denies `Agent(agent-companion)` | It keeps denying the bridge's tools; the role no longer exists |
| Ambiguous legacy history is refused (`thread_ambiguous`) | Legacy history is not read at all (decision 22) |
| `companion_status` without a job lists every execution in the store | It lists the caller's threads only (decisions 10 and 13) |
| A terminal result is one JSON envelope with `content` and `meta` | Two text blocks: the answer, paged past 8,000 characters, then the metadata (step 4) |
| A reply to a closed job returns `reply_unavailable` (reason `state`) | A `mode` with no running job is refused as invalid; text alone on an ended thread is a follow-up (step 2) |
| Completions go to a session-tagged queue with one publication receipt per execution | A per-session news marker; the result and its delivery receipt are the record (step 4) |
| One bridge binds to one host session id (`BRIDGE_SID_CONFLICT`) | Codex still binds, one bridge per conversation; Claude's bridge serves the new conversation after `/clear` (decision 10) |
| Logs: `agent-bridge.log` and a `daemon.log` JSONL stream whose one event is `bridge.startup` | `bridge.startup` is a line in `agent-bridge.log`; `daemon.log` is gone (step 0) |

## Structure

What the last changes of each kind cost (audit section 7):

| Change | Files touched | Why |
| --- | --- | --- |
| A fifth companion | 40 | Companion names hard-coded in about 15 places |
| A field in the send acknowledgement | 31 | Three result builders, two role templates and their tests |
| A tool change | 35 | Tool names repeated in hooks, permissions, templates and five tests |
| A second host | 23 | Host paths and `if`s spread over hooks, scripts and setup |

Target layout:

- `bridge-server/server.mjs`: MCP wiring, startup and bridge loss only.
- `bridge-server/tools.mjs`: one entry per tool with its schema, validation and
  handler. `validation.mjs`'s field tables move into the entries.
- `bridge-server/delivery.mjs`: unread state per thread, the deliver-once claim,
  notice text and the size rules.
- `lib/hosts/`: one descriptor per host (state directory, plugin-data path,
  tool-name prefix, lead identity from a call, wake adapter) and the registry.
  `lib/host.mjs` folds into it. `hooks/host-paths.sh` is the one shell copy of
  the path rules, held to the registry by one test.
- `hooks/hook.sh` and `hooks/hook.mjs`: one stub and one Node entry for every
  hook event, replacing `drain-completions.sh`, `name-thread.sh` and
  `stop-owner.sh`.
- `bridge-server/controller/records.mjs`: one result builder, shared by finish,
  recovery and the cleanup watcher.
- Adapters, the process supervisor, transcripts, work summary, digest and the
  live view keep their shape.

Deleted, with the audit's line counts: both role templates (459), both agent
installers (150), the legacy history and phase-1 migration (about 240), unused
exports, parameters and fields (about 240), the install mode of
`install-codex-hooks.mjs` (about 125), and the queue code in `server.mjs`
(about 90). The contract's test-only validators (about 420) move to `test/`.

Targets, counted at step 8 on a sample change of each kind: a new tool touches
`tools.mjs`, its test and the docs; a new acknowledgement field touches the
adapter, the one result builder, the tool entry and their tests; a new companion
touches its descriptor, adapter, transcript reader and their tests; a new host
touches its descriptor, two manifests and their test.

## Tests

Today: 17,137 test lines in 70 files against 14,195 source lines, six inline
fake adapters, and the same behaviour pinned in up to five files (audit
section 2).

Rules:

1. A test pins something a user or another module can observe. No test asserts
   on prose, comments or the text of a source file. Generated manifests are
   checked for structure.
2. Each behaviour has one home: the tool surface in `test/tools.test.mjs`,
   controller invariants in `test/controller/`, provider protocols beside their
   adapters, hooks in `hooks/hook.test.mjs`, views in the UI and mod tests.
3. One shared fake adapter and one controller setup in
   `test/controller/helpers.mjs`.
4. Every row of THREAD_FEATURES.md names its pinning test. Step 8 walks the
   list.
5. A step adds no more test lines than source lines unless it adds a provider
   fake. Each commit body states both deltas.
6. One guard, `test/registry-guard.test.mjs`, fails when a companion or host id
   is hard-coded outside its registry.

| Today | After |
| --- | --- |
| `bridge-server/server.test.mjs` (1,124 lines) | `test/tools.test.mjs`, one scenario table through `dispatch` |
| `hooks/drain-completions.test.mjs` (528) | `hooks/hook.test.mjs` |
| Three template tests (534) and `hooks/install-agent.test.mjs` (170) | Deleted with the role |
| `templates/host-parity.test.mjs` (171) | `test/hosts.test.mjs`, one table over the host registry |
| Four duplicated contract tests in `test/incident-regressions.test.mjs` | Folded into the controller tests |
| `lib/migration.test.mjs` (191) | Reduced to the settings migration |
| Adapter, transcript, supervisor and UI suites | Unchanged unless a step names them |

Mod tests (`hooks/*.test.ts`) still run under `claude plugin test .` and not in
CI; step 7 runs them by hand.

## Steps

The work happens in a worktree off main. Record the full suite once in step 0.
After each step run the test files that step touches and their direct
dependents; the full suite runs once more at step 8, before asking to merge. One
commit per step, each with its own check and the source and test line deltas in
its body. Live checks use isolated homes and never the operator's.

Order of work. Steps 0 and 1 touch different files and run side by side. Step 2
runs alone; every later step builds on it. Then three tracks run side by side
in their own worktrees: steps 3 then 6, steps 4 then 5, and step 7. They are
integrated in step order, and the live checks of steps 3 to 6 run once on the
integrated branch. Step 8 is last. A step never polishes a file that a later
step deletes or replaces.

### Step 0: Baseline, probes and dead weight

No behaviour changes in this step.

- Record the full suite and the line totals (14,195 source, 17,137 test).
- Move `.drafts/direct-main/` to `probes/direct-lead/` with a README.
- Delete what nothing uses and no later step rewrites (audit section 6): the
  exports with no importer, the test-only helpers in `lib/` (except
  `agentsDir`, which step 1 removes with `lib/host.mjs`), `Controller.steer`,
  the install mode of `install-codex-hooks.mjs` and the stale comments. Route
  the one `lib/log.mjs` event through the logger in use.
- Move the contract's test-only validators to `test/`.
- Put the shared fake adapter and controller setup in
  `test/controller/helpers.mjs` and use them in the files with inline fakes
  that survive. `bridge-server/server.test.mjs` is left alone; step 2 replaces
  it.
- Fold the four duplicated tests in `test/incident-regressions.test.mjs` into the
  controller tests (audit section 2).

Check: the affected suites pass with no assertion changed except in tests
deleted with their code.

### Step 1: Registries

No behaviour changes in this step.

- Derive every companion list from `lib/companion-registry.mjs` (audit section 7a
  names the places).
- Add `lib/hosts/` with the two descriptors and `hooks/host-paths.sh`; replace
  the host `if`s that only pick a path or a name (audit section 3).
- Add `test/registry-guard.test.mjs` and `test/hosts.test.mjs`.

Check: the guard passes; the affected suites pass unchanged.

### Step 2: Tool table, lead identity and the thread reference

- Add `bridge-server/tools.mjs`; `server.mjs` keeps wiring, startup and bridge
  loss.
- The lead comes from the host descriptor: the hook field on Claude
  (`hooks/name-thread.sh` writes `lead` until step 4 replaces it), turn metadata
  on Codex. `callArgs` (`server.mjs:745-770`) goes.
- Mint the thread reference; key the thread record by it, with `lead` and
  `title`; check ownership on every call.
- Fold `agent_reply` into `companion_send`. `companion_status` with no arguments lists
  the caller's threads.
- Send uses the one routing function, `resolveRouting`, which the live path
  skips today.
- Delete the legacy history, the phase-1 migration and the legacy thread and job
  helpers.
- Drop the unused parameters and fields (`verbose`, `max_wait_sec` on send,
  `prompt_id`, `session_id`, `debug`, `session_reborn`) and announce the
  package's version.
- Delete the subagent role: `templates/`, both agent installers and their hook
  entries, the three template tests, `hooks/install-agent.test.mjs`, the role's
  text in the MCP instructions, and the agent install in `setup.sh`.
- Replace `bridge-server/server.test.mjs` with `test/tools.test.mjs`.

Check: scenarios for both hosts' identity, a forged `lead` and `thread`,
`THREAD_NOT_YOURS`, follow-up, intervention through send, and an empty listing
for a second conversation. `scripts/setup-codex-install.test.mjs` runs once
here, because setup changed. Live: `probes/direct-lead/e2e.mjs` passes with the
shipped hook in place of the probe hook.

### Step 3: What ends a job

- Remove the abort path (`controller.mjs:71-76,88-92`), the stop markers
  (`hooks/stop-owner.sh`, `readStop`, the tick check at `:295-298`, both hook
  manifests' entries) and the attachment record.
- One result builder in `records.mjs` for finish, recovery and the cleanup
  watcher.

Check: the tests that pin the old behaviour are rewritten
(`controller.test.mjs` 185, 195, 204; `interventions.test.mjs` 138, 212, 297;
`hooks.test.mjs` 99-100). Live on both hosts: Esc on a pending wait leaves the
job running and a later wait returns its result.

### Step 4: Results, `companion_read` and one delivery path

- Terminal results as a text block plus metadata; drop `structuredContent` and
  the output schema (`server.mjs:277-287,590-610`).
- Add `companion_read` with the read cursor and paging.
- Add `bridge-server/delivery.mjs`. The queue file, its move-aside rewrite, the
  heartbeat and the receipt code in `server.mjs:61-87,137-153,323-347` go.
- Add `hooks/hook.sh` and `hooks/hook.mjs`; delete `drain-completions.sh` and
  `name-thread.sh`. The stub reads the payload with shell builtins and starts
  Node only when the session has unread news or the event needs it (lead
  identity before a tool call, session start).
- Apply the 4,000 and 8,000 character rules in the tool results and the hook.

Check: a result raced by a tool call and the hook is delivered once; the stub's
empty path starts no process (a fake `node` on `PATH` records calls); paging and
footer scenarios. Live: a 70 KB answer read in full on Claude and on Codex with
the scripted model, compared byte for byte with the stored result.

### Step 5: Wake

- Add the Claude and Codex wake adapters to their host descriptors and the
  `delivery` field of the send response.
- Record the current session at session start on Claude.
- Tag unread news with the lead's conversation id, not the bridge's inherited
  session id.

Check: scenarios against a fake socket and a fake `codex`. Live on each host,
Codex through its daemon as installed: idle wake, busy wake, two results at
once, `/clear` (no wake, thread still on the companion page) or `/new` (a job
ending within the minute wakes only the conversation left; one still running
ends in bridge loss; both threads stay on record), an idle hour, and two leads
in one project each receiving only their own results.

### Step 6: Recursion guard

Check: a scenario with the shared fake adapter. Live: a Codex companion with the
plugin loaded calls `companion_send` and is refused.

### Step 7: Views

- `hooks/mod.ts`: record sends from the main conversation (`:417-429` ignores
  them today), key cards by thread, and list running threads above the prompt
  with title, companion, model, activity and elapsed time. The mod must keep
  hooking `companion_send` only: a mod hook that can match a tool turns off Claude
  Code's move to the background for that tool (mod API types), which
  `companion_wait` relies on.
- `bridge-server/ui/jobs.mjs`: list by the lead's conversation; title from
  `title`, else the task's first line.
- Remove the attachment row from `ui/rows.mjs`.

Check: `claude plugin test .`, the UI suites, and a live run through the real
send path with the pane and the companion page open. Done by hand, not through a
subagent.

### Step 8: Docs, manifests and the feature walk

- Rewrite both plugin manifests' descriptions for the new contract and name all
  five companions.
- Update `README.md`, `docs/ARCHITECTURE.md` (with the negative results above),
  `CLAUDE.md` and `docs/MVP_TRACKER.md`. Version 0.3.0, released as 1.0.0 (2026-11-23).
- Walk THREAD_FEATURES.md: each row holds or is in the table under Features, and
  names its pinning test.
- `setup.sh --codex-unload-delay <seconds|default>` (decision 10), written
  through Codex's own config writer.
- Count the totals against step 0 and the files a sample change of each kind
  touches against the Structure targets.

Check: the full suite; test lines below 17,137; an installed-form run on each
host, after a Claude session restart and after `setup.sh --host codex` with
hooks re-trusted.

## Hosts built later

Each is its own milestone with its own install surface and the same tools.

| Host | Needs | Check |
| --- | --- | --- |
| OpenCode | MCP entry in `opencode.json`; lead id from `_meta`; the `run -s` adapter. The bridge lives as long as OpenCode's server, so a job there ends with that server | Idle wake in a live session; a job stops when the server stops |
| Copilot CLI | Plugin with the MCP server and an extension that registers per session and sends notices; wake only with experimental mode on | Idle wake; `/clear` sends nothing to the new session |
| Antigravity | Plugin with `mcp_config.json`, an allow rule for the wake command, and the send response asking the lead to run it | Idle wake after the command; without it, the result arrives through wait |

The tracker's terms note still applies to Antigravity: the bridge must not wrap
`agy -p`, and this design does not.

## After merge

- Old sessions keep the old tools until restarted; Codex needs
  `setup.sh --host codex` and hook re-trust.
- Re-run `probes/direct-lead/` after each Claude Code or Codex upgrade and read
  the diff, as with the Codex wire contract.

## Risks

- **The inbox message line is undocumented.** If it changes, the wake fails
  silently and the result still arrives through the hooks at the next prompt or
  through wait. The probe detects the change.
- **`codex queue` is experimental.** Same fallback.
- **A Codex conversation the user left can get an unseen turn.** Until it has
  been idle for `thread_unload_delay_secs` after `/new` or `/quit`, a finished
  job wakes it; the lead runs that turn in its own permission mode. A gate needs
  a subscriber API Codex lacks. `--codex-unload-delay` shortens the window at
  the cost of stopping running jobs sooner.
- **A Claude setting can stop the wake.** If the user sets messages from other
  sessions to hold or refuse, the bridge's own post is held or dropped too
  (docs). Same fallback.
- **A wake cannot be confirmed.** Neither host acknowledges it. Results stay
  unread until a hook, a wait or a read delivers them.
- **A broken bridge install stops Codex from opening.** The cost of marking it
  required; setup repairs it, and `enabled = false` turns the plugin off.
- **Codex cuts large tool output silently** for models it has no metadata for.
  The 8,000-character page stays under the measured cut.
- **Step 4 replaces a hook with a hard-won fork budget and race fixes.** Its
  check measures both before the old script is deleted: the empty path starts
  no process, and a raced result is delivered once.
