# Direction Assessment and Next-Item Handoff

Last updated: 2026-09-11 (assessment made 2026-09-09).
Status: §5 shipped 2026-09-10 (df198b0); §4 item 3 shipped 2026-09-10
(67ed198); §4 item 4's transport shipped 2026-09-11 (4e42893) and its second
companion, Antigravity, the same day (f6343ea) — see the correction under
item 4; §4 item 5 pinned 2026-09-11. Nothing in §4 is open. The next item is
the profile experiment, `docs/MVP_TRACKER.md` item 9: use the second
companion for a week and let the ledger judge before any further build.

This document answers three questions with evidence: is the direction right,
what would improve it, and what to take up next. §1 is the verdict, §2 and §3
are the evidence, §4 the ranked improvements, §5 the handoff for the review
loop (since shipped; kept as the record of what was built and why).
Everything version-specific is dated; §7 lists what to re-verify on upgrade.

## 1. Verdict

**The direction is right. The emphasis is off.**

Right, confirmed externally (§3):

- The async job lifecycle plus explicit refusal is the moat. Neither harness
  implements MCP Tasks as a client, so the detached runtime with bounded waits
  is still the only working design. Every competitor lacks status, cancel or
  steer. Upstream users are filing the exact bugs this bridge refuses to have.
- Spawning each vendor's own CLI is the only ToS-clean route. Anthropic banned
  Claude Pro/Max OAuth reuse outside Claude Code (enforced 2026-04-04),
  including the Agent SDK. The proxy category lost its Claude leg; this design
  did not.
- The companion set is well chosen: by monthly npm downloads OpenCode is #1,
  Codex #3 and Copilot CLI #4 (Copilot's 11k GitHub stars mislead).

Off, measured locally (§2):

- The 2×3×2 matrix, the strength router and the onboarding surface are the
  *product*; the *usage* is one cell: Claude host → Codex companion → read-only
  review with a verdict, often over several rounds.
- Those review rounds restart cold. The bridge thread is reused, the Codex
  thread is not; the operator has been re-explaining the prior round in prose.
- No job records token usage, so no routing or cost decision can be evidence-
  based, which is this repo's own standard.

## 2. Usage evidence (Claude-host ledger, 2026-09-09)

Source: `~/.claude/agent-companion/jobs/` (104 jobs, 2026-07 to 2026-09) and
`~/.codex/agent-companion/jobs/` (2 jobs).

| Measure | Value |
| --- | --- |
| Jobs by companion | codex 101 · copilot 3 · opencode 0 (not installed on this machine) |
| Jobs by month | Jul 9 · Aug 85 · Sep 10 |
| Jobs by status | completed 74 · cancelled 12 · unreachable 16 · failed 1 · stuck 1 |
| Jobs by codex adapter | exec 48 · appserver 53 |
| Jobs naming a `strength` or `profile` | 0 (no `profiles.json` exists) |
| Jobs by mode/template | EXECUTE/general 54 · ANALYZE/general 48 · ANALYZE/plan_review 2 |
| Completed durations | 37 under 1 min · 15 about 1 min · long tail to 29 min |
| Codex-host jobs | 2, both smoke |

What the tasks actually are: every EXECUTE row is a probe or smoke task
(`sleep 15`, `pwd`, "reply with the magic word"). Every non-smoke delegation is
an **independent read-only review with an explicit AGREE/DISAGREE verdict**:
code reviews of commits and working trees, plan reviews, skill reviews, and
"verify these fixes and give a final verdict" follow-ups. Rounds are chained
by hand: "FOLLOW-UP review: you (a previous Codex job) reviewed … and returned
DISAGREE with …", then "FINAL round: …".

**Rounds restart cold.** Three rounds on 2026-08-14 shared the bridge thread
`companion-codex-msss6u4l-t4uw` but recorded three different
`companionSessionId`s (`019fffbb…`, `019fffc9…`, `019fffcd…`). The cause is
structural, not incidental:

- `bridge-server/server.mjs` reads the thread → session map only for Copilot
  (`if (target === 'copilot') previousSid = readThreadSid(...)`, ~line 2991)
  and writes it only from the Copilot session-capture path (~line 1816).
  `~/.claude/agent-companion/threads/` holds 3 Copilot `.sid` files and 0 Codex.
- `runCodexAppServerWorker` (`server.mjs` ~line 2267) receives `thread` but
  only logs it, then calls `startCodexThreadWithBrokerRecovery({ cwd, model })`
  → `thread/start` (`bridge-server/codex-app-server-runtime.mjs`,
  `startCodexThread` ~line 1602). `resumeCodexThread` (~line 1707) exists and
  already carries model and sandbox, but is used only for restart recovery and
  status reads, never for a follow-up send.

**No usage accounting.** Jobs carry no token or cost fields.
`codex-app-server-runtime.mjs` ~line 709 discards codex `tokenUsage`
notifications as "observability only"; the Copilot daemon writes OTEL traces
nobody aggregates; the OpenCode event stream's usage is not read.

**Reliability trend is good.** 15 of the 16 unreachable jobs are the exec
transport's orphan incident (2026-08-10..13), fixed by the app-server
transport. The app-server era has one unreachable and one failed job, both
from the 2026-09-02 codex upgrade incident that commits `23bf339` and
`d024a2a` addressed.

## 3. External research (2026-09-09)

Four independent research passes plus direct source checks. Items marked
UNVERIFIED were not confirmed against a primary source.

### 3.1 Hosts

- **MCP Tasks: neither host.** Claude Code closed the request as not planned
  ([claude-code#52137](https://github.com/anthropics/claude-code/issues/52137));
  `openai/codex` at rust-v0.153.4 has no `tasks/get`. The 2026-07-28 MCP
  revision moved Tasks into a Draft extension, deprecated Sampling/Roots/
  Logging, and replaced server-initiated elicitation with client retries
  ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks)).
  The bridge's poll design stands.
- **Claude Code knobs to pin** ([mcp docs](https://code.claude.com/docs/en/mcp)):
  `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (MCP calls over 2 min auto-background,
  v2.1.212+, documented as main-conversation only with subagent calls
  excluded outright; unmeasured live on this host, so §7 keeps it) and
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (30 min stdio / 5 min HTTP, v2.1.187+,
  which matches the 1,800,000 ms this repo measured and is now a knob). Both
  pinned 2026-09-11 in `docs/ARCHITECTURE.md` "Host budgets and observability".
  Per-server `timeout` has a 1000 ms floor and is not extended by progress
  notifications. Plugin-bundled agents still strip `mcpServers`/`hooks`
  ([sub-agents](https://code.claude.com/docs/en/sub-agents)), so the
  materialization in `hooks/install-agent.sh` stays load-bearing. Agent teams
  remain experimental; the Workflow tool is GA.
- **`claude -p` for a future Claude companion** ([headless](https://code.claude.com/docs/en/headless)):
  `--bare` skips hooks, skills, agents, plugins and MCP discovery and is
  documented as the future default for `-p`; `system/init` is the first stream
  event and carries `session_id`; `--max-budget-usd` exists. Nested `claude`
  is blocked by inherited `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`
  ([#26190](https://github.com/anthropics/claude-code/issues/26190),
  [#32618](https://github.com/anthropics/claude-code/issues/32618)); an adapter
  must unset them, `--strict-mcp-config` alone is not the recursion guard.
  The ToS change ([The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/))
  means the adapter must spawn the real `claude` binary, never the Agent SDK.
- **Codex 0.153.4 agent roles: docs ahead of code.** The
  [subagents page](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  says a custom agent file may declare `mcp_servers`. At rust-v0.153.4 the role
  file parser (`codex-rs/agent-roles/src/agent_role_config.rs`,
  `RawAgentRoleFileToml` with a flattened `ConfigToml` and
  `deny_unknown_fields`) accepts the key without error, but
  `codex-rs/core/src/agent/role.rs` `apply_role_to_config_inner` copies a
  closed list (developer_instructions, model, reasoning effort/summary/
  verbosity, personality, service_tier, features, skills) and **drops
  `mcp_servers` silently**. The session-scope registration in
  `.codex-plugin/plugin.json` stays correct; the finding is recorded in
  `docs/ARCHITECTURE.md` Negative Results. Subagents are on by default now
  (`[agents]` table). `codex app-server --listen ws://` exists but is
  vendor-labelled experimental ([app-server docs](https://learn.chatgpt.com/docs/app-server.md));
  keep the broker.

### 3.2 Agent Client Protocol (ACP)

[agentclientprotocol.com](https://agentclientprotocol.com/get-started/agents),
governed by Zed and JetBrains.

- v1 is stable (`protocolVersion: 1`; SDKs 1.0 on 2026-06-25; latest v1.7.0 on
  2026-08-20). v2 is a draft (2026-07-20) that renames `session/load` to
  `session/resume` and adds a running/idle/requires_action state machine
  ([v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft)).
- **No mid-turn steering**: a client must wait for idle or `session/cancel`
  first ([v2 prompt RFD](https://agentclientprotocol.com/rfds/v2/prompt)).
- **stdio is the only stable transport**; HTTP/WebSocket is an active RFD
  ([transports RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)).
  The detached-daemon pattern stays necessary.
- Official registry with launch commands:
  `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  (40 agents on 2026-09-09).
- Native ACP agents: Copilot CLI (`copilot --acp`), OpenCode (`opencode acp`),
  Gemini CLI (`gemini --acp` — wire yes; consumer login gone since
  2026-06-18, see §4 item 4), Goose, Kiro, Cursor (`cursor-agent acp`), Qwen,
  Kimi, Droid, Mistral Vibe, Auggie, Junie, Cline. Adapter only: Codex
  (`@agentclientprotocol/codex-acp`), Claude Code
  (`@agentclientprotocol/claude-agent-acp`). None: Amp (community adapter),
  Aider.
- `scripts/copilot-acp-daemon.mjs` uses five ACP methods (`initialize`,
  `session/new`, `session/prompt`, `session/cancel`, `session/update`). It is
  a generic ACP daemon wrapped in Copilot specifics (binary resolution, yolo
  flags, OTEL export, output-shape parsing, rubber-duck).

### 3.3 Companions by adoption

npm downloads for the month ending 2026-09-06; stars from the GitHub API.

| CLI | Stars | npm/month | Headless | ACP / MCP-server |
| --- | --- | --- | --- | --- |
| Claude Code | 144k | 81.5M | `-p` | `claude mcp serve` (primitive tools, not a turn) |
| Codex CLI | 123k | 76.0M | `codex exec --json` | `codex app-server`, `codex mcp` |
| Copilot CLI | 11k | 10.5M | `-p` | ACP native |
| OpenCode | 206k | 9.8M | `opencode run` | ACP native, `opencode serve` |
| Gemini CLI | 107k | 1.45M | `-p --output-format json` | ACP native |
| Goose | 54k | n/a | `goose run` | ACP both roles, `goose mcp` |
| Aider | 49k | 0.56M (PyPI) | `--message` | neither; last push 2026-05-22 |

Aider is stalled and Kimi CLI is being wound down; neither is worth adapter
work. Goose comes free with a generic ACP transport.

### 3.4 Competitors and what users ask for

- PAL MCP (ex zen-mcp, 11.7k stars): its `clink` tool is this repo's concept
  without background jobs, status or cancel; last commit 2025-12-15
  ([repo](https://github.com/BeehiveInnovations/pal-mcp-server)).
- claw-orchestrator (570 stars): a superset with checkpoints, steer, cancel,
  councils in worktrees, a JSONL cost ledger and `maxBudgetUsd`, and MCP, ACP
  and HTTP surfaces ([repo](https://github.com/Enderfga/claw-orchestrator)).
- deliberation (144 stars): consensus protocol with blind commitment (the
  caller posts its verdict before seeing peers) and no self-approval
  ([repo](https://github.com/antonbabenko/deliberation)).
- oh-my-openagent (69k stars): category routing like this repo's strengths but
  with a paid → backup → free fallback chain, the opposite of the no-fallback
  rule here.
- OpenAI Symphony: an orchestration spec plus Elixir reference; whether it
  drives Codex over app-server is UNVERIFIED
  ([OpenAI](https://openai.com/index/open-source-codex-orchestration-symphony/)).
- CLIProxyAPI (51k stars) is the subscription-reuse category; now ToS-hostile
  for Claude.
- Upstream asks that match this design: stuck background tasks burning tokens
  ([claude-code#75314](https://github.com/anthropics/claude-code/issues/75314)),
  silent model fallback ([#43869](https://github.com/anthropics/claude-code/issues/43869)),
  mid-flight steer ([#58708](https://github.com/anthropics/claude-code/issues/58708)),
  cross-consulting Claude and Codex ([HN: Mysti](https://news.ycombinator.com/item?id=46365105)).
- Cross-model consensus is weakly supported empirically: a 2026-08-02 write-up
  citing ICML 2025 work reports that when two models err they give the same
  wrong answer about 60% of the time, and that agreement correlates weakly with
  correctness ([article](https://www.digitalapplied.com/blog/cross-model-review-consensus-verification-2026);
  underlying papers UNVERIFIED). The value of a second vendor is reasoning
  diversity, not a vote.

## 4. Improvements, ranked

1. **Codex thread continuity on follow-up sends** (small). A send on an
   existing thread whose last Codex job recorded a session id should
   `thread/resume` that thread and `turn/start` on it instead of
   `thread/start`, and write the Codex `.sid` the way Copilot does.
2. **A `review` template with a structured verdict** (small). Require a final
   verdict line and parse it into the terminal envelope's `meta`, the way the
   `RUBBER-DUCK:` line is classified today (`classifyRubberDuck`,
   `server.mjs` ~line 1729). Document blind commitment as the protocol: the
   parent records its own verdict before reading the companion's.
3. **A usage ledger per job** (small). Capture codex `tokenUsage`, Copilot
   `usage_update`/OTEL and OpenCode event usage into a target-neutral
   `usage` field on the job, the digest and terminal `meta`. This is the only
   way a strength such as `fast_executor` can ever be justified.
4. **A generic ACP transport** (medium to large). Turn the Copilot daemon into
   a companion-agnostic ACP daemon parameterised from `lib/target-registry.mjs`
   (command, args, env), with Gemini CLI as the first new companion. Reply
   becomes cancel plus re-prompt, as OpenCode server mode already does;
   `session/load` is optional per agent, so resume is a per-descriptor
   capability. Pin protocol v1; v2 renames methods.
   **Correction 2026-09-11:** the transport shipped (`docs/MVP_TRACKER.md`
   item 7) but the "Gemini CLI first" premise did not survive the live auth
   gate. §3.2's list of native ACP agents was accurate for the wire, not for
   access: Gemini CLI stopped serving individual, AI Pro and AI Ultra Google
   logins on 2026-06-18 (API keys and Code Assist Standard/Enterprise still
   work). This paragraph first also ruled Antigravity out ("no ACP mode and
   a ToS that forbids third-party clients on its login"); **tracker item 8
   supersedes that sentence.** `agy` still has no ACP mode, but Google
   publishes its own ACP server to the registry (`antigravity-acp`, the
   binary Zed, JetBrains and Xcode launch), and the terms prohibit software
   that takes the Antigravity OAuth token to call Google's backend, which a
   stdio client of Google's signed server is not. Antigravity shipped as the
   second ACP companion the same day (`f6343ea`); item 8 holds the sources,
   the reading and its caveats.
5. **Pin the new host budgets** in `docs/ARCHITECTURE.md` "Host budgets":
   `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` and `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`.
   Done 2026-09-11 ("Host budgets and observability").

Do not pursue: the codex WebSocket listener (vendor-experimental; the broker
stays), MCP Tasks (no host client), an Aider adapter (stalled, no ACP or MCP),
a Kimi CLI adapter (wound down). Recommend dropping Aider from the planned
matrix in `docs/ARCHITECTURE.md` and `docs/MVP_TRACKER.md`; Goose stays as an
ACP row.

Demoted: **Claude companion for the Codex host**, previously the agreed next
expansion. The Codex host has two smoke jobs, and the adapter's constraints
grew (real `claude` binary only, unset `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`,
`--bare`). Take it up when the Codex host is actually in use.

## 5. Handoff, shipped 2026-09-10 (df198b0): make the review loop first-class

Items 1 and 2 as one change. It is the only workflow in use, it is days of
work rather than weeks, and it leaves the matrix alone. The generic ACP
transport (item 4) is the structural item after it.

### 5.1 Success criteria (write these before code)

A hand-run probe under `probes/smoke/`, in the style of
`appserver-control.mjs`, against the real bridge and broker:

1. Round one: `agent_send` with `template: "review"` on a repo with a planted
   defect returns `completed` with `meta.verdict = "disagree"` and the defect
   named in the body.
2. Round two: `agent_send` on the **same thread** with only "address finding 1;
   re-verdict" as the task. Assert the job's `companionSessionId` equals round
   one's, `thread/read` shows both turns on one Codex thread, and the body
   references round one without the task restating it.
3. Restart survival is unchanged: SIGKILL the bridge between rounds; round two
   still resumes the same thread (the rollout under `$CODEX_HOME/sessions` is
   what `thread/resume` loads).
4. A verdict line that is missing or malformed yields `meta.verdict = null`
   with a `verdict_reason`, never a guessed value; `completed` is not remapped.
5. Regression guards: the exec adapter (`CODEX_RUNTIME_ADAPTER=exec`) is
   unaffected; a fresh thread still opens with `thread/start`; the four
   existing smokes stay 12/12, 8/8, 17/17, 18/18.

Unit coverage: `bridge-server/codex-app-server-runtime.test.mjs` for the
resume-on-send branch using `test/fake-codex-app-server.mjs` (every frame
built through the pinned wire contract), `bridge-server/validation.test.mjs`
for the template and verdict parser, and both template suites for the enum.

### 5.2 Code anchors

- `bridge-server/server.mjs` ~line 2991: `readThreadSid` is gated on
  `target === 'copilot'`. Extend to codex/appserver (profile-namespaced, as
  for Copilot) and pass the prior session id into `runCodexAppServerWorker`.
- `bridge-server/server.mjs` ~line 2267 `runCodexAppServerWorker`: today
  `thread` is only logged; branch on a prior session id and call
  `resumeCodexThread` (`codex-app-server-runtime.mjs` ~line 1707, already
  sends model and sandbox) before `turn/start`; fall back to `thread/start`
  only when there is no prior id. Note the Negative Result: `turn/start` on a
  busy thread does not reject, so check thread status first, as the existing
  reply path does.
- `bridge-server/server.mjs` ~line 1816: the Copilot `writeThreadSid` site.
  Add the equivalent for codex where `companionSessionId` is persisted
  (`worker.thread_started`, ~line 2296).
- `lib/state.mjs` ~lines 251 and 264: `readThreadSid` / `writeThreadSid`.
- Template touchpoints (the seven files that carry `plan_review` today):
  `bridge-server/validation.mjs` (`formatPrompt` ~line 211, enum),
  `bridge-server/validation.test.mjs`, `bridge-server/server.mjs` (schema
  enum ~line 3761 and the rubber-duck wrapper decision ~line 1757, which
  `review` should skip as `plan_review` does), `templates/agent-companion.md`,
  `templates/agent-companion.toml`, `README.md`, `docs/ARCHITECTURE.md`.
- Verdict parsing precedent: `classifyRubberDuck` (`server.mjs` ~line 1729)
  and the footer at ~line 1403. Put the verdict in `meta` (and the digest),
  not only in the footer, so the parent can branch without parsing prose.

### 5.3 Non-goals for this item

No new routing code, strength, profile or companion. No change to the exec
adapter. No cost ledger (item 3 is separate). No blind-commitment enforcement
in the bridge; it is a documented protocol for the parent.

### 5.4 Open questions for the implementer

- Does the `review` template need a structured findings list, or is a single
  verdict line plus free-form findings enough for the parent's loop? Start
  with the line; add structure only if the parent needs to branch on findings.
- **Decided 2026-09-10: thread reuse applies to every codex/appserver send
  on an existing thread, not only `review`.** The template already promises
  continuity on daemon-backed adapters; a fresh thread opts out by omitting
  `thread`. The exec adapter is unchanged.

## 6. Doc corrections carried by this assessment

- `docs/ARCHITECTURE.md` Negative Results: the codex 0.153.4 role-file
  `mcp_servers` parse-but-drop entry (added 2026-09-10).
- `docs/MVP_TRACKER.md` Next Backlog: item 5 points here.
- Item 5 of §4, the two Claude Code host-budget knobs: pinned 2026-09-11 in
  `docs/ARCHITECTURE.md` "Host budgets and observability".

## 7. Re-verify on upgrade

- Codex: whether `apply_role_to_config_inner` starts honouring `mcp_servers`.
  If it does, role-local registration on the Codex host becomes possible and
  the session-scope workaround in `.codex-plugin/plugin.json` can be retired;
  `templates/agent-companion.toml.test.mjs` asserts the current absence.
- Claude Code: `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` behaviour for an
  agent-local MCP server inside a subagent; whether `--bare` became the `-p`
  default.
- ACP: v2 promotion out of draft (method renames — the generic daemon refuses
  any answer but v1) and whether the HTTP/WebSocket transport RFD lands, which
  would let a daemon-less ACP adapter exist.
- Antigravity: whether `agy` gains an ACP mode (antigravity-cli#31), and whether
  Google ever states in its own voice which clients may launch its
  `antigravity-acp` server (shipped as the second ACP companion on 2026-09-11 on
  the reading in tracker item 8); either makes
  the next companion a descriptor.
- Ledger: re-run the §2 queries; the case for item 4 strengthens only if a
  second companion actually gets used.
