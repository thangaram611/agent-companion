# Direction Assessment

Last updated: 2026-11-05

## 1. Direction

Complete the conversational redesign with per-execution ownership, cold history
resume and verified cleanup. Protect the independent review workflow. Expansion
requires a recurring unmet workflow with success criteria agreed before implementation;
[MVP_TRACKER.md](MVP_TRACKER.md) holds the current
state, limitations and next steps.

Keep companion credentials in the vendor runtime. A working protocol does
not establish permission to use an account through it; the Antigravity
integration boundary and unresolved terms question are tracker item 8.

## 2. Usage evidence

Independent read-only review is the workflow to protect. Its value is in
concrete findings the caller can verify. Agreement between reviewers does
not establish correctness, and limited adoption does not establish poor
review quality. Tracker item 9 records the resulting expansion decision.

The caller should record its own assessment before reading the companion's
verdict, then verify the findings. This is a review protocol for the caller;
the bridge does not enforce independent judgment.

The [Claude 2.1.318](../probes/host-qualification/claude/REPORT-2026-11-05.md) and
[Codex 0.166.0](../probes/host-qualification/codex/REPORT-2026-11-05.md) host reports
fix the signal/timeout assumptions: pending calls can be cancelled, gaps need
leases/markers, and progress does not extend the 1320 s per-call wall. They do
not qualify cleanup. Desktop, operator TUI rows, installed-form acceptance and
Copilot cold load remain explicit [release gates](RELEASE_READINESS.md#release-gates).

## 5. Review loop

**Superseded 2026-11-05 by Phase 1's conversational contract.** Reviews now carry
ordinary task instructions and the parent's desired answer format. The bridge
passes the child's message verbatim and does not parse verdicts or append review
instructions. Same-conversation follow-up now cold-resumes saved history in a new process
where qualified. Bridge loss stops live work; the former parser requirements
and in-flight survival evidence below are historical.

The former acceptance contract was a read-only review with a parsed verdict and a
follow-up that retains the conversation's context:

- A completed `review` exposes `meta.verdict` as `agree`, `disagree`, or `null`
  with a reason when the verdict is missing, malformed or conflicting. The
  verdict does not change the job's completion status.
- On Codex app-server, a follow-up on the same companion conversation resumes
  the recorded Codex thread, including across bridge replacement. It must
  fail explicitly if that recorded thread cannot be resumed.
- Keep numbered findings and a verdict line. Add structured findings only if
  a caller needs to branch on them; prose is sufficient for the current loop.

`bridge-server/validation.test.mjs`, `bridge-server/server.test.mjs` and
`bridge-server/codex-app-server-runtime.test.mjs` covered the parser and
continuity paths under that contract. The retired `probes/smoke/review-loop.mjs`
checked a planted defect, same-thread follow-up across a bridge SIGKILL, and per-turn usage against a
real runtime. It is no longer a release gate; current probes are listed in `probes/README.md`.

## 7. Re-verify on upgrade

- Codex: whether `apply_role_to_config_inner` starts honouring `mcp_servers`.
  If it does, role-local registration on the Codex host becomes possible and
  the session-scope workaround in `.codex-plugin/plugin.json` can be retired;
  `templates/agent-companion.toml.test.mjs` asserts the current absence.
- Claude Code: `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` behaviour for a
  session-scoped MCP server called by a subagent. A task id instead of the expected
  wait envelope would break the blocking-wait contract; see
  [Host budgets](ARCHITECTURE.md#host-budgets).
- ACP: qualify protocol and transport changes before changing the v1 pin or
  cold-runtime lifecycle. Agent-advertised session loading is insufficient;
  verify that the vendor's sessions survive its process.
- Antigravity: recheck Google's client-access terms and the registry server's
  model, permission, usage and session-loading behaviour before an upgrade.
- Usage: record paired findings and durations while available. The retention
  limits in [MVP Limitations](MVP_TRACKER.md#mvp-limitations) prevent the retained records and
  delivery queue from serving as a complete usage history.
