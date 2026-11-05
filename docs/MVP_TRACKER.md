# MVP Tracker

Last updated: 2026-11-05

Current direction: active development of the approved conversational redesign.
Phase 1 removes the dispatch protocol and adds read-only discovery. Ownership,
lifetime and recovery changes have separate later gates.

## Current State

- The parent delegates in plain language: task, absolute repo/worktree path and
  optional companion/model preference. The child asks for a missing path.
- The ownerless catalog reports enabled companions, the default, model
  configuration, capabilities, readiness and the last checked version. An open
  choice uses a ready companion; model omission preserves its configuration.
- The bridge passes the child's message verbatim. The child relays the answer
  and questions, with its own focused checks kept separate. Refusals and failures
  do not authorize self-completion or a silent companion/model substitution.
- Claude Code and Codex CLI support OpenCode, Copilot, Codex, and Google
  Antigravity. The [companion matrix](ARCHITECTURE.md#companion-matrix) records
  transport capabilities.
- One `agent-companion` is one companion conversation. The host names its
  thread; an MCP send without one is refused. Continue the same agent for a
  follow-up, or start another for independent work. See
  [conversation ownership](../README.md#one-agent-companion-one-companion-conversation).
- Within the same route and cwd, a retry of the in-flight request reattaches;
  a different request returns `thread_busy`. Wait, cancel, or use `agent_reply`
  when the job reports `reply_available`.

## MVP Limitations

- The runtime-adapter environment setting selects the transport at spawn.
  Reply availability is per job; the catalog's companion capabilities do not
  establish that a particular job can accept a reply.
- Catalog readiness reflects the last check. Models that require session
  creation to enumerate are reported as such; a catalog read starts no session.
- Phase 1 does not fix the existing ownership, timeout or recovery defects.
  Live conversational acceptance follows integration. Codex desktop remains
  an unqualified host target for the later host-qualification phase.
- OpenCode `cli` and Codex `exec` cannot steer a running job or recover it
  after bridge restart.
  Copilot recovery depends on its ACP daemon surviving; Antigravity can load a
  session after its server restarts. Use the companion matrix when choosing a
  transport for follow-up work.
- Usage is present only when reported by the transport. Antigravity carries
  none; Codex app-server usage observed after a mid-turn bridge restart is
  marked `partial`. Terminal jobs expire after one hour when GC runs, and
  structured logs rotate, so neither is a durable adoption or cost ledger.
- Codex rollouts accumulate under `$CODEX_HOME/sessions` without automatic
  cleanup. Sandbox and permission boundaries are documented in
  [ARCHITECTURE.md](ARCHITECTURE.md#negative-results).

## Decisions

1. Release validation belongs in [RELEASE_READINESS.md](RELEASE_READINESS.md):
   readiness must be established on the candidate commit and installed versions.

2. **Historical, superseded 2026-11-05:** strength-routed profiles selected a
   configured route. Phase 1 replaces them with companion/model preferences and
   the catalog. Explicit refusal and no silent substitution remain the rule.
   Routing contract: [ARCHITECTURE.md](ARCHITECTURE.md#routing-contract).

3. OpenCode uses its HTTP server for reply, resume and streaming; an additional
   ACP adapter is not scheduled because those workflows already have a transport.

4. Codex uses the detached app-server broker for resumable work; the `exec`
   transport is for single-shot jobs because it has no live control channel.

5. **Historical, superseded 2026-11-05:** the review loop required parsed
   verdicts. Reviews now use ordinary conversation and the parent's requested
   answer format. Same-conversation follow-ups remain supported by the transports
   documented above. Former criteria: [DIRECTION_ASSESSMENT.md §5](DIRECTION_ASSESSMENT.md#5-review-loop).

6. Keep vendor-reported usage in one shared shape; model and cost are carried
   only when reported, so routing decisions cannot rely on invented prices.

7. Copilot and Antigravity share the descriptor-driven ACP daemon. It pins
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

10. Both plugin manifests and the private bridge package declare `0.1.0`.
    Build release artifacts from the reviewed commit; version metadata alone
    does not establish that the release gates pass.

## Next Backlog

- Harden the Codex exec smoke's digest assertion in `probes/smoke/smoke.mjs`:
  its unconditional `|| true` makes the thread-id check pass without evidence.
- Permission mirroring — the called agent should run with the calling agent's
  access mode (auto/manual/full access).

## Validation Commands

Use [Release Gates](RELEASE_READINESS.md#release-gates), including the
root-discovered test command. The gates are maintained there once.
