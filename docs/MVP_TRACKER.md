# MVP Tracker

Last updated: 2026-11-15

Current direction: active development of the approved conversational redesign.
The shipped controller owns one cold provider runtime per execution. Qualification
remains separate from implementation; see the release gates below.

## Current State

- The parent delegates in plain language: task, absolute repo/worktree path and
  optional companion/model preference. The child asks for a missing path.
- The ownerless catalog reports enabled companions, the default, model
  configuration, each companion's saved model and effort and its last run's
  reported values, capabilities, readiness and the last checked version. An open
  choice uses a ready companion; model omission preserves its configuration.
- Defaults (2026-11-18, docs/DEFAULTS_PLAN.md): one `settings.json` for both hosts
  holds the default companion and each companion's model and effort.
  - A new conversation uses the host's explicit choice, then the model env knob,
    then the saved default, then the companion's own configuration; follow-ups
    keep theirs.
  - `agent-companion defaults` and the live view's `d` panel list, validate, save
    and clear them, and show what inherit resolves to.
  - Onboarding and setup still save the target and model with
    `--target <companion> --model <id|inherit>`.
  - Copilot's model is selected through the session's model option.
- The bridge passes the child's message verbatim. The child relays the answer
  and questions, with its own focused checks kept separate. Refusals and failures
  do not authorize self-completion or a silent companion/model substitution.
- Claude Code and Codex CLI support OpenCode, Copilot, Codex, Google
  Antigravity and Claude Code. The
  [companion matrix](ARCHITECTURE.md#companion-matrix) records transport capabilities.
- One `agent-companion` is one companion conversation. The host names its
  thread; an MCP send without one is refused. Continue the same agent for a
  follow-up, or start another for independent work. See
  [conversation ownership](../README.md#one-agent-companion-one-companion-conversation).
- Within the same route and cwd, a retry of the in-flight request reattaches;
  a different request returns `thread_busy`. Wait, cancel, or use `agent_reply`
  when the job's `interventions` reports the requested mode available.

- One controller owns each answer's process group, owner attachment and immutable
  result. Silence never ends a job: stop hooks and attributed cancellation close
  owned work; bridge loss hands its
  tree to the cleanup watcher. Native history survives for a cold follow-up.
- CLI host measurements are recorded in the
  [Claude 2.1.318 report](../probes/host-qualification/claude/REPORT-2026-11-05.md)
  and [Codex 0.166.0 report](../probes/host-qualification/codex/REPORT-2026-11-05.md).
  They establish ownership/signals and the 1320 s per-call wall, not cleanup.

- Step 6 (2026-11-09) closes the first-use feedback on invoker effort selection
  for Claude, launch transparency, silent-thinking activity and companion/cwd
  mismatch remedies. Both host roles pass named effort and relay launch/activity
  fields. Selected effort survives cold follow-up and bridge-loss results;
  provider-reported effective effort remains separate. No new state files.

- Done — Live-view Step 1 (2026-11-15): native transcript readers for all five
  companions, work summary on terminal results, and on-demand `agent-digest://`
  rendering without a second transcript copy. Both roles relay the summary and
  transcript pointer. Copilot in-turn native failures override an apparent ACP
  success; ACP acknowledgements no longer mistake protocol request ids for native
  turn ids.
  Fixture and local suite checks are separate from installed-host qualification.

## MVP Limitations

- All five companions accept conversation-level effort, and a saved effort
  default applies to a new conversation when the host names none. Codex catalog models, OpenCode and Antigravity validate
  advertised levels before delivery and verify the reported selection. Levels are
  unverified for models outside Codex's catalog: start/resume confirms the reported
  effort, with vocabulary checked by the backend during the turn. Resume can persist
  an unlisted model's selection before that check. Claude validates its CLI enum.
  Copilot validates the session model's ACP `thought_level` before writing, confirms
  the value, and reports inherited effort. It is now testable via local Ollama BYOK;
  qualification against GitHub-hosted models remains blocked by this account's 403.
  The 2026-11-12 measurements establish backend behavior, not installed-host
  qualification. `probes/free-backends/run.mjs` provides isolated homes and optional
  wire-effort assertions; implementation validation is hermetic, with live execution
  left to the reviewer.

- Copilot cold follow-up is unsupported (`FOLLOWUP_UNSUPPORTED`) pending account
  resolution and qualification of cross-process history loading. It must not
  silently open a new conversation. Copilot accepts no interventions;
  Antigravity and Claude Code support queue and interrupt. Codex and OpenCode
  also support in-flight steer. Unsupported modes return `reply_unavailable`.
- OpenCode 1.x is dropped; only the authenticated 2.x HTTP contract is shipped.
- Codex desktop remains unqualified. TUI-only rows require operator actions:
  compaction, UI stop/restart, native close, suspend/wake and clock observation.
  Claude `/clear` was measured preserving the bridge; unattended `/compact`
  was not evidenced. Neither result qualifies the rest of the TUI matrix.
- In-flight survival across bridge replacement is deliberately given up.
  SIGINT/SIGTERM/EOF trigger watcher handoff; uncatchable bridge SIGKILL cannot
  execute that handoff. Startup never adopts a live/unverified tree.
- Catalog readiness reflects the last check. Models requiring a session to
  enumerate are reported as such; reading the catalog starts no session.
- Usage is present only when reported by the provider. Antigravity 1.1.1 reports
  none. New execution/result records have no one-hour expiry; delivery-queue TTLs
  and rotating logs do not make a complete adoption/cost history.
- Claude reports cost only for fresh history; resumed native cost includes the
  conversation total. Tokens are per turn. User hooks and plugins load in the
  child; slow hooks can push startup past the 10 s protocol delivery bound.
  Claude transcripts remain under `~/.claude/projects` (or the configured Claude
  directory) without bridge cleanup, and follow-ups need those files.
- Codex rollouts accumulate under `$CODEX_HOME/sessions` without automatic
  cleanup. Sandbox boundaries are in [Architecture](ARCHITECTURE.md#negative-results).
- Antigravity is paused on `agy_acp_server.par` 1.1.1 (registry: 1.5.0) pending
  the switch in decision 8. Unreproduced here: t3code reports that Antigravity
  ends a turn that hit an upstream API error with `end_turn` and the error as
  reply text, and a quota exhaustion with `refusal`. The bridge would report the
  first as `completed`.

## Decisions

1. Release validation belongs in [RELEASE_READINESS.md](RELEASE_READINESS.md):
   readiness must be established on the candidate commit and installed versions.

2. **Historical, superseded 2026-11-05:** strength-routed profiles selected a
   configured route. Phase 1 replaces them with companion/model preferences and
   the catalog. Explicit refusal and no silent substitution remain the rule.
   Routing contract: [ARCHITECTURE.md](ARCHITECTURE.md#routing-contract).

3. **Historical, superseded 2026-11-05:** OpenCode used a shared HTTP server
   for reply/resume/streaming beside a CLI transport. It now starts a private
   2.x server per execution, cold-loads history, and supports steer, queue and interrupt.

4. **Historical, superseded 2026-11-05:** Codex used a detached app-server
   broker for survival and an exec transport for single-shot work. It now uses
   one owned app-server per answer; history resumes cold and live work stops
   when its bridge is lost.

5. **Historical, superseded 2026-11-05:** the review loop required parsed
   verdicts. Reviews now use ordinary conversation and the parent's requested
   answer format. Same-conversation follow-ups remain supported by the transports
   documented above. Former criteria: [DIRECTION_ASSESSMENT.md §5](DIRECTION_ASSESSMENT.md#5-review-loop).

6. Keep vendor-reported usage in one shared shape; model and cost are carried
   only when reported, so routing decisions cannot rely on invented prices.

7. Copilot and Antigravity share the descriptor-driven ACP protocol adapter, with separate
   per-execution processes. It pins
   protocol v1 and refuses a different answer; protocol changes need explicit
   adapter qualification.

8. Antigravity uses Google's registry ACP server, `agy_acp_server.par`, with
   credentials held by that server. The integration is limited to its stdio
   protocol; the bridge does not reuse the OAuth token or call Google's backend.
   The [registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
   names Google as the publisher, and Google's
   [Zed instructions](https://antigravity.google/docs/ide/extensions/zed)
   document registry installation with personal OAuth. This is the basis for
   the integration decision, not an explicit authorization of orchestrators.
   Google's [terms §6](https://antigravity.google/terms) and
   [FAQ](https://antigravity.google/docs/faq) restrict third-party access;
   the FAQ also excludes wrapping `agy -p` in third-party agents on consumer
   plans. Whether a custom ACP orchestrator is permitted remains unconfirmed.
   Account risk stays with the operator; recheck this boundary before widening
   the integration.

   **Re-read 2026-11-17, switch decided, all Antigravity work paused.** The
   [FAQ](https://antigravity.google/docs/faq) now names this host directly:
   "Why can't I use third-party software (such as Claude Code, OpenClaw, or
   OpenCode) with my Antigravity login? … a violation of our Terms of Service
   … can result in suspension or termination", and "Wrapping `agy` inside
   third-party coding agents or applications … is not supported under consumer
   plans". For third-party agents it recommends a Gemini Enterprise or AI Studio
   API key. Google's [ACP page](https://antigravity.google/docs/ide/extensions/acp/)
   says "Any ACP client can launch Antigravity CLI", lists only editors,
   registers `agy acp` for every client except Android Studio, and no longer
   mentions `agy_acp_server.par`. The user decided to move to Homebrew
   `agy acp` and keep the personal Google login, accepting the account risk,
   with every Antigravity change and live run paused until they resume it.
   The queued work is in [Next Backlog](#next-backlog).

9. Additional companions or transports require recurring use and an adoption
   check; the available paired-review evidence is insufficient to justify expansion.
   **Accepted scope, 2026-11-09:** the user approved Claude Code as the fifth
   companion, with `bypassPermissions` by default and recursive Agent Companion
   delegation denied. Steps 1–2 implement the adapter and integration with
   hermetic tests; Step 3 adds role parity and documentation. This accepted
   addition does not remove the adoption policy for further expansion.
   Step 4 (2026-11-09) ran the live probe and installed runs on both hosts; see the
   [companion report](../probes/host-qualification/claude-companion/REPORT-2026-11-09.md).
   Claude Code 2.1.319 was measured; older versions are **UNVERIFIED**.
   `--permission-prompts` needs at least 2.1.259; that flag minimum does not
   qualify older versions of the complete integration.

10. Both plugin manifests and the private bridge package declare `0.2.0`.
    Build release artifacts from the reviewed commit; version metadata alone
    does not establish that the release gates pass.

11. **Direction, 2026-11-19.** The USP: any agent talks to any other agent
    natively, from whichever host the owner starts in. About 20% of 300 recent
    jobs used something OpenAI's codex-plugin-cc lacks (follow-ups to a thread
    other than the repo's latest, non-Codex companions, Codex as host). The claim
    is only as true as the qualified host × companion pairs; Copilot follow-up and
    Antigravity are known gaps. agent-companion stays TypeScript in its own repo:
    no merge with vigil, no Rust rewrite, no pause feature. No new work on
    Claude-host steering, Copilot or Antigravity until records show use. The next
    milestone is walk-away reliability.

12. **Silence never ends a job (2026-11-19).** The 120 s owner grace killed healthy
    owners waiting out an outage under Claude's retry watchdog. Codex and Fable
    differentials both chose stop-on-evidence only; the user agreed. A stop with
    no signal (Esc between waits) lets the job finish its turn; status shows
    `owner_detached_at` and the user can cancel. Evidence: ARCHITECTURE Negative
    Results, owner silence.

## Next Backlog

- Walk-away reliability (decision 11), in order:
  1. Outage through the bridge, 8 and 50 min, Codex companion first (`codex exec`
     waited for the network; app-server through the adapter is unmeasured).
  2. Suspend/wake mid-`agent_wait`, including a cancel right after wake.
  3. Confirm the Claude companion child inherits `CLAUDE_CODE_RETRY_WATCHDOG`.
  4. Measure Esc on a subagent between waits: does `$.agent.list()` report
     `killed` or SubagentStop fire? If so, write a stop marker from it.
  5. Check the Claude adapter's wait for a queued input's final lifecycle event
     (`bridge-server/adapters/claude.mjs` ~116) for an unbounded wait.
- Study codex-plugin-cc's design (app-server wrapper, rescue subagent, resume)
  for improvements; the user runs it as a trial later, not now.
- Qualify Codex desktop as the third host and finish operator-only TUI rows.
- Resolve Copilot account access, then qualify cold history loading before
  enabling follow-up; a capability advertisement is insufficient.
- Phase 5: include a workspace-diff summary on failure, with explicit observation
  limits; partial assistant text does not establish what changed on disk.
- Permission mirroring remains a separate decision: align called-agent access
  with the caller only after the desired policy and acceptance checks are agreed.
- Antigravity (paused 2026-11-17; resume only on the user's word):
  1. Switch the runtime to Homebrew `agy acp`. Measured 2026-11-17: `agy` 1.5.9
     has `acp` with `--login`, `--sandbox`, `--dangerously-skip-permissions`,
     `--disable-telemetry` and `--process-per-session`. Google documents
     credentials cached by `agy` and `-32000 "Authentication required"` without
     them. Re-measure every 1.1.1 fact in Architecture's Negative Results
     (protocol answer, `session/load` survival, per-session model, permission
     requests, usage, credential store), then retire
     `scripts/install-antigravity-acp.mjs` and its probe.
  2. Reproduce, then fix, the suspected upstream-error-as-success. Capture a real
     failing turn first, e.g. a model the account cannot use. Evidence so far is
     t3code's `apps/server/src/provider/acp/AntigravityTurnOutcome.ts`: it names
     native step type 17 `CORTEX_STEP_TYPE_ERROR_MESSAGE` and reads the turn's
     last step for `Error <code>, Message: …, Status: …`, `QUOTA_EXHAUSTED` and
     reset times. Our `lib/transcripts/antigravity.mjs` reads step 17 only as a
     permission-refused tool call (the one local row, 2026-11-17, is a denial);
     the controller's native-error override is Copilot-only. The fix would make
     that override a target-registry setting instead of an id check.
- Defaults from inside a host (deferred 2026-11-18; the CLI and the live-view
  panel come first, see [Defaults plan](DEFAULTS_PLAN.md)):
  1. Codex skill `agent-companion:companion`. Measured on codex-cli 0.170.0: a
     plugin cannot add slash commands, because `commands/*.md` was not exposed on
     install under either manifest layout. A plugin skill appears as
     `<plugin>:<name>`, is invoked with a `$` mention or `/skills`, and the model
     carries it out in a turn. `.codex-plugin/plugin.json`
     `"skills": "./codex-skills/"` keeps it out of Claude. Under
     `workspace-write`, the turn's shell cannot write the settings file (any
     `$HOME` path outside the workspace is denied), so a save asks for
     escalation; a show does not.
  2. Claude `/companion` subcommands (`/companion defaults …`). The mod's
     `command.run` receives everything typed after the name as `e.args` and
     `CommandSpec.argumentHint` shows a hint
     (`.claude-plugin/types/claude-code/index.d.ts:2112`). It runs with no
     model turn and would call `launch-ui.sh defaults …` through
     `$.process.run`. Plain `/companion` keeps opening the pane.
- Generic ACP companions (deferred 2026-11-17): run any agent from the
  [ACP registry](https://agentclientprotocol.com/get-started/registry) (about 45,
  e.g. Gemini, Goose, Cursor, Qwen) or a local ACP command through the shared ACP
  adapter, as t3code does ([providers-acp.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md)).
  Each agent's quirks are per-agent facts (see Negative Results: approval flags,
  advertised `loadSession`, usage shapes), so an unqualified agent would get
  conservative defaults: no cold follow-up, cancel only, no usage. Needs decision
  9's adoption check and a named agent the user would actually use.

## Validation Commands

Use [Release Gates](RELEASE_READINESS.md#release-gates), including the
root-discovered test command. The gates are maintained there once.
