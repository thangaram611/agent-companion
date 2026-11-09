# MVP Tracker

Last updated: 2026-11-09

Current direction: active development of the approved conversational redesign.
The shipped controller owns one cold provider runtime per execution. Qualification
remains separate from implementation; see the release gates below.

## Current State

- The parent delegates in plain language: task, absolute repo/worktree path and
  optional companion/model preference. The child asks for a missing path.
- The ownerless catalog reports enabled companions, the default, model
  configuration, capabilities, readiness and the last checked version. An open
  choice uses a ready companion; model omission preserves its configuration.
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
  when the job reports `reply_available`.

- One controller owns each answer's process group, lease and immutable result.
  Stop hooks and attributed cancellation close owned work; bridge loss hands its
  tree to the cleanup watcher. Native history survives for a cold follow-up.
- CLI host measurements are recorded in the
  [Claude 2.1.318 report](../probes/host-qualification/claude/REPORT-2026-11-05.md)
  and [Codex 0.166.0 report](../probes/host-qualification/codex/REPORT-2026-11-05.md).
  They establish ownership/signals and the 1320 s per-call wall, not cleanup.

## MVP Limitations

- Copilot cold follow-up is unsupported (`FOLLOWUP_UNSUPPORTED`) pending account
  resolution and qualification of cross-process history loading. It must not
  silently open a new conversation. ACP, OpenCode and Claude Code in-flight
  steer are unsupported.
  A running Claude job refuses replies with `reply_unavailable`; wait or cancel.
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

## Decisions

1. Release validation belongs in [RELEASE_READINESS.md](RELEASE_READINESS.md):
   readiness must be established on the candidate commit and installed versions.

2. **Historical, superseded 2026-11-05:** strength-routed profiles selected a
   configured route. Phase 1 replaces them with companion/model preferences and
   the catalog. Explicit refusal and no silent substitution remain the rule.
   Routing contract: [ARCHITECTURE.md](ARCHITECTURE.md#routing-contract).

3. **Historical, superseded 2026-11-05:** OpenCode used a shared HTTP server
   for reply/resume/streaming beside a CLI transport. It now starts a private
   2.x server per answer, cold-loads history, and refuses in-flight steer.

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

## Next Backlog

- Add an onboarding option that persists a per-companion default model. Codex
  does not forward the shell environment to the bridge, so on the Codex host the
  `AGENT_COMPANION_*_MODEL` knobs are inert and only a saved default can pin a model.
- Qualify Codex desktop as the third host and finish operator-only TUI rows.
- Resolve Copilot account access, then qualify cold history loading before
  enabling follow-up; a capability advertisement is insufficient.
- Phase 5: include a workspace-diff summary on failure, with explicit observation
  limits; partial assistant text does not establish what changed on disk.
- Permission mirroring remains a separate decision: align called-agent access
  with the caller only after the desired policy and acceptance checks are agreed.

## Validation Commands

Use [Release Gates](RELEASE_READINESS.md#release-gates), including the
root-discovered test command. The gates are maintained there once.
