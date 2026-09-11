# MVP Tracker

Last updated: 2026-09-11

## MVP Definition

Complete a generic delegation bridge that no longer requires Copilot as the
primary companion:

- Generic `agent_*` MCP tools are the only subagent surface.
- Users bring their harness; supported harnesses are Claude Code and Codex CLI.
- Users attach their companion; supported companions are OpenCode, Copilot,
  Codex, and Gemini.
- Copilot keeps working as a first-class companion adapter (no legacy MCP
  aliases).
- Repo docs and tests make the current state and remaining work recoverable.

## Done

- Added target default state:
  - `default-target` state file.
  - `AGENT_COMPANION_DEFAULT_TARGET` env override.
  - no silent fallback: an unconfigured target resolves to `unset`.

- Added target registry:
  - `opencode` descriptor.
  - `copilot` descriptor.
  - target capability metadata exposed through `agent_status`.

- Added generic MCP surface:
  - `agent_send`
  - `agent_wait`
  - `agent_status`
  - `agent_reply`
  - `agent_cancel`

- Implemented OpenCode MVP adapter:
  - resolves `OPENCODE_BIN` or `opencode`.
  - runs `opencode run --dir <cwd> --format json <prompt>`.
  - exposes permission mode and timeout via `agent_status().opencode_runtime`.
  - supports `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip` for OpenCode's dangerous auto-approval flag.
  - enforces `AGENT_COMPANION_OPENCODE_TIMEOUT_MS` with a 40-minute default.
  - supports send, wait, status, cancel.
  - parses NDJSON/text output into the standard terminal envelope without selecting tool output as the assistant message.
  - writes digest files for raw stdout/stderr and final/partial message.

- Kept Copilot adapter behavior intact:
  - ACP daemon path still works.
  - `/fleet` parallel orchestration still applies only to Copilot.
  - reply/resume was Copilot-only at this pass; the OpenCode `server` and Codex
    `appserver` adapters added it later.

- Updated subagent templates:
  - use `agent_*` tools.
  - document optional `target`.
  - document the bring/configure-your-target posture: OpenCode and Copilot at
    this pass, and both templates name Codex CLI too since its adapter landed.
  - keep Claude session-id forwarding and Codex MCP `_meta` behavior.

- Updated permissions:
  - Claude installer grants the `agent_*` tools only (no legacy `copilot_*` grants, no legacy migration code).

- Completed the full rename + legacy removal:
  - removed `copilot_*` MCP aliases and the `copilot:` error namespace (now `agent:`).
  - removed legacy env (`COPILOT_COMPANION_DEFAULT_TARGET`, `AGENT_COMPANION_OPENCODE_SKIP_PERMISSIONS`) and the silent `opencode` bootstrap fallback (unconfigured target now errors with onboarding guidance).
  - renamed the product identity to `agent-*` everywhere: MCP server `agent-bridge`, digest scheme `agent-digest://`, env prefix `AGENT_COMPANION_*`/`AGENT_RUNTIME_*`, state dir `~/.{claude,codex}/agent-companion/`, repo/plugin/subagent/template names `agent-companion`.

- First-class onboarding (this pass):
  - `lib/target-registry.mjs` (moved from `bridge-server/`) now carries install/auth/permission/smoke metadata.
  - `lib/target-diagnostics.mjs` — `inspectTarget`/`inspectTargets`/`targetReadinessSummary` (default target via `readDefaultTarget` in `lib/state.mjs`).
  - `lib/doctor.mjs` is target-aware: `targets` + `defaultTarget` sections, and `ok` no longer requires Copilot.
  - `scripts/onboard.mjs` — `--host/--target/--set-default/--yes/--json/--smoke/--list-targets/--doctor/--no-target-check`.
  - `setup.sh` — `--target opencode|copilot|auto|none`, `--no-target-check`, `--skip-tests`; dropped the Copilot hard requirement; delegates target validation/default-write to `onboard.mjs`; gates the Copilot reviewer agent by target.
  - `hooks/prewarm-target.sh` (renamed from `prewarm-daemon.sh`) only prewarms the Copilot daemon when the default target is `copilot`.

- Added tests:
  - state tests for `default-target` (unset/env/config, no fallback).
  - MCP tool-list coverage for `agent_*` only.
  - target diagnostics (opencode/copilot/both/none, env overrides), target-aware doctor, onboarding planner + CLI exit codes.
  - fake OpenCode CLI smoke test, target-aware status/inspect, permissions test update.

- Added repo docs:
  - [docs/ARCHITECTURE.md](ARCHITECTURE.md)
  - this tracker.

- Public positioning and release-readiness alignment (this pass):
  - README now leads with the harness + companion slogan and defines the product
    vocabulary.
  - Public docs distinguish one-to-one `target` routing from the one-to-many
    companion profile router, still ahead at this pass and shipped since (see
    backlog item 2).
  - [docs/RELEASE_READINESS.md](RELEASE_READINESS.md) records source-backed
    compatibility notes and public release gates.
  - Claude and Codex plugin manifests describe the same harnesses and
    companions as the rest of the docs: both name OpenCode, GitHub Copilot, and
    Codex CLI, and the Codex manifest's long description records strength-routed
    companion profiles as shipped rather than future.
  - `setup.sh` install copy maps `--host` to harness and `--target` to today's
    companion selector without renaming stable flags.
  - Copilot default-model fallback now uses a currently documented Copilot CLI
    model (`claude-sonnet-4.6`), and Copilot model validation is separated from
    the Codex subagent role model allow-list.

- Added the Codex CLI companion adapter (send-only v1):
  - `bridge-server/codex-runtime.mjs` spawns `codex exec --json` (resolves
    `CODEX_BIN` or `codex`), one resolver for sandbox + network
    (`resolveCodexSandbox`), a D10 ThreadEvent JSONL collector
    (`createCodexCollector`), and `cancelCodexRun`.
  - `lib/target-registry.mjs` carries the `codex` descriptor: `implemented:
    true`, `reply:false`/`resume:false` as the `codex exec` baseline (forced by
    that transport — a one-shot non-interactive subprocess with no control
    channel and nothing to reattach to — not by codex;
    `CODEX_RUNTIME_ADAPTER=appserver` flips both true), permissive
    `modelSelection`, and the documented consequences (network-on-by-default
    inversion, the `.git`/`.codex`/`.agents` carve-out, rollout accumulation,
    MCP-boot/env-inheritance, the nested-sandbox caveat) as descriptor notes.
  - `bridge-server/server.mjs` consolidates the non-copilot worker/cancel/info
    dispatch into one `CLI_RUNTIMES` table (`opencode`, `codex`) instead of a
    third id-literal branch; digest routing needed no change (`writeOpenCodeDigest`
    was already target-neutral, so codex jobs render `# codex job ...` for free).
  - `lib/target-diagnostics.mjs` gained an exit-code auth mode
    (`descriptor.auth.checkByExitCode`) for `codex login status`, which prints
    its verdict to stderr with empty stdout in both the logged-in and
    logged-out case on 0.145.0 — the stock stdout-based probe would have
    false-red a logged-in machine — and a sandbox-aware `probePermission` path
    (`descriptor.permission.dangerousModes`) that flags BOTH
    `danger-full-access` and `bypass` as dangerous.
  - `scripts/onboard.mjs` gained a config-isolated codex smoke branch
    (`--ignore-user-config --ephemeral --sandbox read-only`, the one
    deliberate exception to inheriting the user's own codex config).
  - Verified at build time: logged-out `codex login status` exits non-zero
    (`CODEX_HOME=$(mktemp -d) codex login status` → exit 1, empty stdout,
    "Not logged in" on stderr) — confirms the exit-code auth mode.

## MVP Limitations

- Routing supports strength/profile/target: `agent_send` accepts `strength`
  (preferred) or `profile` beside `target`, resolved by `resolveRouting` against
  `profiles.json` with no silent fallback. Multiple companion profiles and
  multiple model profiles per companion are supported.
- Strength labels `reviewer`, `web_researcher`, `planner`, and `fast_executor`
  are live `agent_send` fields (open strings validated against the registry);
  `STRENGTH_CAPABILITY_REQUIREMENTS` is wired but an empty no-op in v1.
- OpenCode has two adapters selected by `OPENCODE_RUNTIME_ADAPTER`: `cli`
  (default, single-shot `opencode run`) and `server` (`opencode serve` HTTP).
- OpenCode reply/re-steer and restart resume work in `server` mode only; in `cli`
  mode they are unsupported and persisted nonterminal cli jobs are marked
  `unreachable` after bridge restart.
- OpenCode `cli` permission auto-approval is opt-in via
  `--dangerously-skip-permissions`; `server` mode follows OpenCode's own
  permission config (the bridge does not auto-approve).
- OpenCode `acp` stdio mode is not implemented; server mode covers reply, resume,
  and streamed digests.
- Codex has two adapters selected by `CODEX_RUNTIME_ADAPTER`: `exec` (default,
  single-shot `codex exec`) and `appserver` (a detached shared broker owning one
  `codex app-server`, over JSON-RPC).
- Codex reply/re-steer and restart resume work in `appserver` mode only; in
  `exec` mode they are unsupported and persisted nonterminal exec jobs are
  retired `unreachable` after bridge restart. The limit is the **transport**, not
  codex — `turn/steer` is real mid-flight injection and `thread/resume` rejoins a
  running thread.
- Codex `appserver` pins `approvalPolicy: 'never'` and does not expose it: a
  client that accepts one approval escalates past the sandbox (measured).
- Codex has no `/fleet`-equivalent parallel orchestration; every delegated job
  persists a rollout transcript under `$CODEX_HOME/sessions` with no auto-cleanup
  in v1; nested Seatbelt sandboxing is documented, not worked around (use
  `AGENT_COMPANION_CODEX_SANDBOX_MODE=bypass` in an externally-sandboxed bridge).
- Copilot and Antigravity ride the generic ACP daemon (item 8); Goose is a
  descriptor away. Aider was dropped (2026-09-09 assessment: stalled, no ACP or
  MCP).
- README diagram assets are current as of 2026-08-13 and are now reproducible:
  every PNG is rendered from a committed SVG by
  `bash scripts/render-readme-assets.sh` (headless Chrome, byte-deterministic).
  `target-matrix` carries one row per transport, `architecture` shows the
  routing brain, all three adapters and the detached shared runtimes, and `hero`
  gained an SVG source it never had. `scripts/validate-codex-release.mjs` still
  asserts only that the files exist, never their content, so an SVG edit that is
  never re-rendered stays invisible to CI — re-run the script in the same
  commit.

## Next Backlog

1. Release validation:
   - run full Node test suite.
   - run Codex marketplace validation.
   - run Claude plugin validation.
   - manually smoke a real OpenCode install and a real Copilot install — done
     2026-06-23: both companions pass a real bridge delegated send (OpenCode via
     Ollama Cloud free `gpt-oss:120b`; Copilot via `claude-sonnet-4.6`).
   - All eight pre-tag smoke gates pass: gates 1-6 recorded 2026-06-23, gate 7
     (Codex CLI companion delegated send, including the network override) added
     2026-07-24, and gate 8 (Codex app-server transport: restart survival via
     `probes/smoke/appserver.mjs`, reply/steer and cancel/interrupt via
     `probes/smoke/appserver-control.mjs`) added 2026-08-11. Harness install
     smokes ran under a sandboxed `$HOME`, real config verified untouched. See
     [docs/RELEASE_READINESS.md](RELEASE_READINESS.md) "Smoke evidence".

2. Strength-routed companion profiles — DONE (2026-06-23). Built per
   [docs/STRENGTH_ROUTING_HANDOFF.md](STRENGTH_ROUTING_HANDOFF.md) across phases
   P1–P5 with the committed regressions green:
   - `lib/profile-registry.mjs` is the single producer of `profiles.json`
     (`loadProfiles`), with a source-scanning single-producer guard test.
   - `resolveRouting` in `bridge-server/server.mjs` is the sole SEND routing
     brain: constraint-consistency precedence, six new no-silent-fallback codes on
     top of the existing `TARGET_UNCONFIGURED` / `TARGET_UNSUPPORTED` /
     `MODEL_NOT_ALLOWED` (nine in total — see docs/ARCHITECTURE.md "Routing
     Contract"), and
     a pre-spawn capability gate. Per-profile model reaches both the Copilot
     daemon and both OpenCode adapters; Copilot `.sid` files are namespaced by
     profile.
   - doctor/status surface profile readiness and an id-free `strengths[]` view;
     onboarding authors profiles via `--define-profile`/`--assign-strength`/
     `--set-default-profile`/`--list-profiles` (ids/models/labels only).
   - legacy installs route byte-identically via a synthesized default profile.

3. OpenCode server/ACP adapter — DONE (2026-06-23, server mode):
   - `bridge-server/opencode-server-runtime.mjs` drives `opencode serve` over HTTP
     behind `OPENCODE_RUNTIME_ADAPTER=server`.
   - in-flight reply/re-steer via abort + re-prompt on the same session.
   - restart resume by reattaching to the surviving detached server +
     persisted `ses_` id / `baseUrl`, with a transcript level-check.
   - streamed `/event` digests via a directory-scoped SSE accumulator
     (`session.idle` terminal marker).
   - per-job `reply_available` / `resume_available` flags; one shared server
     pooled in `runtime/opencode-servers.json`.
   - ACP stdio mode (`opencode acp`) intentionally deferred — server mode covers
     all three goals.
   - Verified end to end against a real `opencode serve` + free `ollama-cloud`
     model: send→completed, reply re-steer, and cancel→cancelled all pass.

4. Additional companion adapters:
   - Codex CLI — DONE (send-only v1): `codex exec --json` adapter; see the Done
     section above for the full breakdown.
   - Codex app-server — DONE (2026-08-11), and it closes what this entry used to
     defer. `CODEX_RUNTIME_ADAPTER=appserver` puts reply (`turn/steer`), restart
     resume (`thread/resume`) and streamed sub-turn digests on a detached shared
     broker owning one `codex app-server`; proved end to end by
     `probes/smoke/appserver.mjs` (bridge SIGKILLed mid-turn, the job still
     completes with no work lost).
   - Thread continuity via `codex exec resume <thread_id>` is **deleted, not
     deferred** — the transport gate fired, and
     [docs/RELIABILITY_REMEDIATION.md](RELIABILITY_REMEDIATION.md) "Wave 3"
     records what replaced each piece. The rollout under `$CODEX_HOME/sessions`
     is still what recovery reads, now via `thread/resume` / `thread/read`.
   - Still deferred for codex: fleet/parallel, and the shared opencode+codex
     spawn-core extraction.
   - The generic ACP transport — DONE with item 7 below; a second native ACP
     agent is a descriptor plus an install/auth block. Gemini CLI was built
     on it and dropped at the auth gate; Antigravity CLI is next (item 7's
     handoff). Goose stays an ACP row.
   - Aider dropped (stalled upstream, no ACP or MCP surface).
   - Keep adapters capability-driven: read reply/resume/parallel support from
     the descriptor, which the selected adapter may upgrade.

5. Make the review loop first-class — DONE (2026-09-10). The Claude-host
   ledger showed the product used as one cell of the matrix: Claude → Codex
   read-only reviews with a verdict, chained by hand over rounds that restarted
   a cold Codex thread each time. Built per
   [docs/DIRECTION_ASSESSMENT.md](DIRECTION_ASSESSMENT.md) §5:
   - Codex thread continuity on follow-up sends: a codex/app-server send on a
     thread whose last job recorded a thread id resumes it (`thread/resume`,
     via the generalized `openCodexThreadWithBrokerRecovery`) and `turn/start`s
     on it; `thread/start` opens only a thread with no recorded id. The id is
     persisted as the thread's `.sid` the way Copilot's is, restored on
     hydrate, and retired — with the job failing explicitly — when it no longer
     resumes on a healthy broker. Applies to every app-server send on an
     existing thread, not only `review`; the exec adapter is unchanged.
   - A `review` template (`bridge-server/validation.mjs`): read-only, never
     auto-fleets, skips the rubber-duck wrapper, and requires a final
     `VERDICT: agree|disagree` line that `classifyReviewVerdict` parses into
     the job at `retainTerminalJob` and from there into wait `meta.verdict`,
     the queue event, the body footer and both digest writers — `null` with
     `verdict_reason` (`missing` | `malformed` | `conflicting`) when it cannot
     be read, never guessed, never remapping `completed`.
   - Proof: `probes/smoke/review-loop.mjs` (14 checks against the real bridge,
     broker and codex: a planted defect parses to `disagree`; bridge SIGKILLed
     between rounds; round two resumes the same thread, names round one's
     finding without the task restating it, and `thread/read` shows both turns
     on one thread) plus unit coverage in the server, runtime, validation and
     both template suites. The four existing smokes stay 12/12, 8/8, 17/17,
     18/18. The same assessment ranks what follows (usage ledger, generic ACP
     transport) and demotes the Codex-host → Claude companion until that host
     is in use.

6. Per-job usage ledger — DONE (2026-09-10; criteria written first, then the
   failing reproduction, then the code —
   [docs/DIRECTION_ASSESSMENT.md](DIRECTION_ASSESSMENT.md) §4 item 3). Shipped:
   `lib/usage.mjs` (the shape and the four readers), the codex accumulator and
   exec collector, the Copilot daemon's OTEL read, both OpenCode adapters, the
   `retainTerminalJob` move to `job.usage`, and every surface. Verified live:
   `smoke.mjs` 13/13 (exec usage), `review-loop.mjs` 16/16 (app-server usage on
   a fresh and a resumed thread), and both OpenCode adapters through the bridge
   on opencode 1.18.30 + `ollama-cloud/gpt-oss:120b` (server: model, cost,
   cached input; CLI: tokens and cost, no model on that stream), after
   verifying the shapes against its OpenAPI document and SDK types. Success
   criteria, as written before code:
   - **One shape, defined once** in `lib/usage.mjs`: `usage` is an object with
     six integer-or-null counters that every transport fills under the same
     keys — `input_tokens`, `output_tokens`, `cached_input_tokens`,
     `cache_write_input_tokens`, `reasoning_output_tokens`, `total_tokens` —
     plus `source` (which transport signal it came from), and `model`, `cost`,
     `cost_unit` only when the transport reports them. A counter the transport
     does not report is `null`; a job whose transport reported nothing has NO
     `usage` key at all, never zeros.
   - **Captured where each transport already emits it, measured 2026-09-10:**
     codex app-server from `thread/tokenUsage/updated` through the accumulator,
     as THIS turn's usage on a resumed thread (`total` is thread-cumulative,
     so the first notification's `total − last` is the baseline); codex exec
     from `turn.completed.usage` (five snake_case counters, no total, no model,
     codex-cli 0.154.0); Copilot from the OTEL file exporter the daemon already
     enables — one `invoke_agent` span per prompt keyed by
     `gen_ai.conversation.id` = the ACP session id, with tokens, cache read and
     write, reasoning, model and `github.copilot.cost` (the ACP stream carries
     no usage kind and `session/prompt` answers only `{stopReason}`; the span
     landed 0.00 s after the result in the measurement) — attached by the
     daemon to the prompt summary; OpenCode server mode from the assistant
     `message.updated` info (`tokens`, `cost`, `modelID`, per its OpenAPI
     document) and the transcript loader; OpenCode CLI from the `step_finish`
     event's part on `opencode run --format json` — both measured through the
     bridge the same day on opencode 1.18.30 with `ollama-cloud/gpt-oss:120b`
     at $0, once an Ollama Cloud key was configured (`cost: 0`, model on the
     server path only, OpenCode's cache-inclusive `total` carried as reported).
   - **One path to every surface:** adapters put `usage` on the summary they
     already build; `retainTerminalJob` moves it to `job.usage` (the ledger),
     and wait `meta.usage`, the queue event's `meta.usage`, `agent_status`
     `usage` and both digest writers' `**Usage:**` line render from the job.
     A live codex app-server digest shows usage mid-turn from the snapshot.
   - **A restart-resumed job is honest about what it saw:** a codex app-server
     turn resumed mid-flight by a fresh bridge reports only the calls observed
     after the resume, flagged `partial: true`; a tier-2 `thread/read` salvage
     and a Copilot prompt that did not complete carry no usage.
   - **Smokes:** `smoke.mjs` (exec) asserts `meta.usage` with input and output
     tokens above zero and `source: codex-exec`; `review-loop.mjs` asserts the
     same for the app-server on both rounds, the second on the resumed
     thread. The other three stay 8/8, 17/17, 18/18.
   - Non-goals: no routing, strengths, profiles or currency estimation; no
     new companion; no change to the review loop.

7. Generic ACP transport — DONE (2026-09-11). The second companion is NOT
   shipped: Gemini CLI was built, measured and then dropped on the live auth
   gate (below), and its successor has no ToS-clean ACP path yet. Built per
   [docs/DIRECTION_ASSESSMENT.md](DIRECTION_ASSESSMENT.md) §4 item 4, criteria
   written before any code:
   - **One daemon, parameterised from the descriptor.**
     `scripts/acp-daemon.mjs --companion <id>` is the only ACP daemon
     implementation. Everything companion-shaped is the descriptor's `acp`
     block in `lib/target-registry.mjs`: spawn argv, extra child env, files
     rotated at spawn, `clientInfo.name`, the default model, whether
     `session/load` is honoured, the answer to `session/request_permission`,
     the usage reader and the `session/update` kinds the agent was measured
     to emit. `scripts/copilot-acp-daemon.mjs` is the Copilot binding of the
     same classes, so `scripts/copilot-acp-daemon.test.mjs` runs **unchanged**
     (13/13). No companion-id branch anywhere in the daemon.
   - **Copilot is byte-identical where an operator can see it:** spawn argv
     (`--acp --model <m> --reasoning-effort xhigh --no-ask-user
     --allow-all-tools --allow-all-paths --allow-all-urls --experimental`),
     OTEL env and trace rotation, the socket/log/prompt-stream paths and their
     `COPILOT_*` overrides, `clientInfo.name`, the `.sid` files, the
     rubber-duck wrapper and footer, `/fleet`, the prompt-timeout and
     empty-completed retirements, the IPC commands and response shapes.
     Pinned by the unchanged suite, an argv/paths test against the
     descriptor, and one real Copilot job through the bridge after the
     refactor (job `copilot-mtwil1g9-e4si`, 33 s, Copilot CLI 1.0.83, the
     identical argv in the daemon log, `RUBBER-DUCK: clean`, `meta.usage`
     from OTEL at cost 3 premium requests). Deliberate deviations, all
     operator-facing text: no MCP `notifications/initialized` after
     `initialize` and `clientCapabilities` instead of `capabilities` (both
     spec corrections; the live job was unaffected), the digest heading and
     the empty-completed error naming the registry's `GitHub Copilot CLI`
     rather than `Copilot`, the unreachable hint saying `grep acp-daemon`,
     and the reply acknowledgement stating that ACP has no mid-turn steer.
     The drift log surfaced four `session/update` kinds Copilot 1.0.83 now
     emits (`available_commands_update`, `session_info_update`,
     `config_option_update`, `usage_update`); the descriptor declares them.
   - **One detached daemon per ACP companion per host home**, with its own
     socket (`runtime/<companion>-acp.sock`), log and prompt streams,
     recorded in `runtime/acp-daemons.json` through
     `lib/shared-runtime-registry.mjs` (leases from the bridge GC tick,
     two-phase disposal whose `stop` is sent only after `confirmDisposal()`)
     beside the daemon's own inactivity reaper — the codex broker's shape.
     The bridge keys the daemon path on `capabilities.acp`, `/fleet` on
     `capabilities.parallel` and the rubber-duck wrapper on `acp.rubberDuck`.
   - **Protocol v1 is pinned.** An agent answering any other version is
     refused: child killed, prompt failed `ACP_PROTOCOL_MISMATCH` naming the
     version, job settled `unreachable` with `detail: acp_protocol_mismatch`
     (class `runtime_unavailable`, `meta.protocol_answered`), daemon status
     naming it. Never adapted — the v2 draft renames `session/load` to
     `session/resume`. Measured: Copilot 1.0.83 and Gemini 0.59.0 both
     answer `1` even to a request for `2`.
   - **`session/load` is per-descriptor ANDed with the agent's
     advertisement.** Copilot declares false (process-local sessions,
     github/copilot-cli#1767 — it advertises `loadSession: true` all the
     same, measured); the fake agent's descriptor declares true and the
     daemon loads a session it no longer holds instead of minting fresh,
     replayed history ignored, answering `sessionLoaded: true`.
   - **Permission requests are answered by the daemon, per descriptor
     policy** (`all` | `edit` | `none`): the first `allow_once` option or
     the first `reject_once`, recorded as a `permission` event in the prompt
     stream; an undeclared client method (`fs/*`, `terminal/*`) is answered
     `-32601`; an agent never waits on the bridge.
   - **Update-kind drift is flagged, not swallowed:** a kind missing from
     `acp.updates` is logged once per kind and still parsed generically.
   - **The reproduction:** `test/fake-acp-agent.mjs`, an ACP agent over stdio
     with its own companion descriptor (`fakeAcpDescriptor`), driven through
     `FAKE_ACP_BIN` / `COPILOT_BIN` the way `test/fake-codex-app-server.mjs`
     is driven — scripted updates, `_meta.quota` and standard `usage`,
     `session/request_permission`, `session/load`, cancel, undeclared kinds,
     a configurable `protocolVersion`. `scripts/acp-daemon.test.mjs` drives
     the daemon with it over real stdio; `bridge-server/server.test.mjs`
     drives the real detached daemon end to end (one daemon, one session,
     two sends) with no stub below the bridge.
   - **Gates:** full root-anchored `node --test` green; the five codex smokes
     13/13, 8/8, 17/17, 18/18, 16/16 on 2026-09-11; README,
     `docs/ARCHITECTURE.md`, both templates and the registry updated.
   - **Why the second companion is not Gemini CLI, with evidence.** The whole
     Gemini descriptor was built and measured on 2026-09-11 against 0.59.0
     (`gemini --acp` answers v1, advertises `loadSession`, puts the turn's
     tokens on the prompt response under `_meta.quota.token_count`, asks via
     `session/request_permission`, and overrides `--approval-mode yolo` to
     `default` in an untrusted folder). At the live auth gate the operator's
     individual Google account was refused: "This client is no longer
     supported for Gemini Code Assist for individuals. To continue using
     Gemini, please migrate to the Antigravity suite of products." Google's
     transition post and deprecation page confirm: since 2026-06-18 Gemini
     CLI stopped serving Code Assist for individuals, AI Pro and AI Ultra;
     it "will remain accessible via paid Gemini and Gemini Enterprise Agent
     Platform API keys" and Code Assist Standard/Enterprise licenses. The
     operator chose not to run on an API key; the descriptor, its onboarding,
     tests, docs and smoke were removed and the CLI uninstalled. The
     measurements stay in `docs/ARCHITECTURE.md` Negative Results.
   - **Handoff — next session, Antigravity CLI.** Facts gathered 2026-09-11,
     to start from: (1) `agy` (Homebrew cask `antigravity-cli`, 1.2.0, a
     closed-source Go rewrite) has **no ACP mode**; the feature request
     google-antigravity/antigravity-cli#31 has been open since 2026-05-20
     with 192 comments and no Google response; its headless mode is `-p`,
     a one-shot pipe with no streaming, cancel or resume. (2) Google's
     Antigravity FAQ: "Using third party software, tools, or services to
     access Antigravity is a violation of our Terms of Service … If you
     would like to use a third party coding agent with Gemini, we recommend
     using a Vertex or AI Studio API key." (3) The ACP registry's
     `antigravity-acp` entry (v1.1.1) is Google's own IDE-extension server
     (`agy_acp_server.par`, dl.google.com/agy-extensions), used by the Zed
     and JetBrains extensions on the Antigravity login. (4) Community
     `agy-acp` adapters wrap `agy -p` and rely on
     `--dangerously-skip-permissions`. So the questions to settle before
     writing a descriptor: whether the bridge, as a client of Google's own
     ACP server binary, is inside or outside that FAQ (this repo's rule from
     §1 of the assessment is ToS-clean or not at all); whether that binary
     runs headless with cached `agy` credentials and answers protocol v1; and
     whether its session/load, permission and usage shapes are what the fake
     agent already models. The transport needs nothing: a descriptor with an
     `acp` block plus install/auth/permission/smoke, and the suites in this
     item are the ones it inherits.
   - Non-goals held: no HTTP/WebSocket ACP transport, no routing or strength
     change, no change to the codex or opencode adapters.

8. Antigravity as the second ACP companion — DONE (2026-09-11). Gate 0
   (access and terms) was settled with primary sources before any code, and the
   criteria below were written before the descriptor. Start-of-day state was
   item 7's handoff; what moved since is the first bullet.
   - **Gate 0.1 — `agy` still has no ACP mode, but Google now ships an ACP server
     of its own.** Homebrew cask `antigravity-cli` 1.2.0 (released 2026-09-10,
     installed today; `brew update` reports nothing newer). `agy --help` and
     `--helpfull` on 1.2.0 list no `--acp`, JSON-RPC or serve flag; the headless
     surface is `-p` with `--input-format stream-json` / `--output-format
     stream-json` (one NDJSON turn per line), `--dangerously-skip-permissions`,
     `--mode accept-edits|plan`, `--sandbox`. The CHANGELOG from 1.1.19 to 1.2.0
     has no ACP entry. google-antigravity/antigravity-cli#31 is still open
     (192 comments, last 2026-08-21, no Google reply). What changed: the ACP
     registry's `antigravity-acp` entry was added by PR #542 on 2026-08-20 —
     the day of @antigravity's "Antigravity IDE extensions are here! Now
     available for Visual Studio Code, Visual Studio, Zed, and JetBrains." —
     and bumped to 1.1.1 by PR #567 from `ivanporty@google.com` on 2026-09-03.
     Its `agent.json` says `authors: ["Google LLC"]`, `license: proprietary`,
     `license_url: https://antigravity.google/terms`, and launches
     `./agy_acp_server.par` from `dl.google.com/agy-extensions` (linux adds
     `--uid=`). The darwin-arm64 zip (316 MB) holds `agy_acp_server.par` and
     `localharness_external`, both Mach-O arm64 signed `Developer ID
     Application: Google LLC (EQHXZ8M8AV)`; `--version` reports "Built on Thu
     Sep 3 00:22:52 2026 … //cloud/developer_experience/antigravity_extensions/
     acp_server". Its only flags are `--debug` and `--notices` (absl
     boilerplate aside): no model, no approval mode, no allow-dir.
   - **Gate 0.2 — ToS reading: INSIDE, with the risk named.** The texts, read
     2026-09-11:
     - antigravity.google/terms, section 6 (no effective date shown): "You must
       not abuse, harm, interfere with, or disrupt the Service. This includes,
       but is not limited to, using the Service in connection with products not
       provided by us. Using third party software, tools, or services to access
       the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of
       this Agreement. Such actions may be grounds for suspension or
       termination of your Antigravity and/or Gemini CLI accounts."
     - antigravity.google/docs/faq, "Why can't I use third party software (e.g.
       Claude Code, OpenClaw, OpenCode) with my Antigravity login?": "Using
       third party software, tools, or services to access Antigravity is a
       violation of our Terms of Service, and severely degrades the experience
       for legitimate product users. Such actions may be grounds for suspension
       or termination of your account. … If you would like to use a third party
       coding agent with Gemini, we recommend using a Vertex or AI Studio API
       key."
     - Google's own definition of the banned conduct (a gemini-cli maintainer,
       google-gemini/gemini-cli discussion #20632, 2026-02-27): "use of 3rd
       party tools or proxies to access Antigravity resources and quotas";
       "Using third-party software, tools, or services to harvest or piggyback
       on Gemini CLI's OAuth authentication to access our backend services is a
       direct violation."
     - The registry Google published to (agentclientprotocol.com): "an easy way
       for developers to distribute their ACP-compatible agents to any client
       that speaks the protocol." Google's submitting PR #542: "Google
       Antigravity is Google's AI coding agent server implementing the Agent
       Client Protocol (ACP)" and "Verified live ACP handshake & auth methods:
       Auth OK: oauth-personal(agent), oauth-business(agent),
       gemini-api-key(agent), agent-platform(agent)".
     - Google's Zed page (antigravity.google/docs/ide/extensions/zed): install
       via "External Agents > Add > Install from Registry"; prerequisite "a
       Google Account with any Antigravity plan (including the free tier) or
       Gemini Enterprise"; auth "Google Accounts (Individual): OAuth for
       personal Google AI subscriptions (Free, Pro, Ultra tiers)". Xcode 27
       gets the same server through Settings > Intelligence.
     The reading. Every prohibited example — OpenClaw, Claude Code, OpenCode on
     an Antigravity login — is software that takes the Antigravity OAuth token
     and calls Google's backend itself; the maintainer's words are "piggyback
     on … OAuth authentication to access our backend services". This bridge
     would do neither: it never sees the token (it lives in
     `~/.gemini/antigravity-acp/`, read by Google's process) and never calls
     the backend; it is a stdio client of Google's own signed agent server,
     which is exactly what Zed, JetBrains and Xcode are — third-party products
     Google documents against the same binary, the same registry and the same
     personal OAuth. Google published that server to a registry whose stated
     purpose is any client that speaks the protocol, verified `oauth-personal`
     in its own PR, and points registry consumers at these terms as the
     license. That is the structure §1 of the assessment already relies on for
     codex, copilot and opencode: spawn the vendor's own binary and let it hold
     the credential. The sentence "using the Service in connection with
     products not provided by us", read literally, would also forbid Zed and
     Xcode, so it cannot mean what it literally says; its gloss is the OpenClaw
     example. Two honest caveats: Google has not written "any ACP client" in
     its own voice — the registry submission is the closest statement — and
     Google's docs list five editors, not orchestrators; the account risk stays
     with the operator, who chose to proceed on this reading.
   - **Gate 0.3 — account.** `agy` is not logged in on this machine (no
     `~/.gemini/antigravity-cli/`, nothing in the keychain); the ACP server is
     not either (no `~/.gemini/antigravity-acp/`, `session/new` answers
     `-32000 Authentication required`). The two do not share credentials: the
     server resolves its home to `~/.gemini` (`$GEMINI_HOME` honoured) and its
     own `antigravity-acp/settings.json`, and ignores the `oauth_creds.json`
     the morning's Gemini CLI attempt left there. Plan tier: unknown until the
     login; Google's Zed page says any plan including free suffices. The
     terms' data clause applies to whatever tier answers: "Google employees
     and contractors may access, view, review and use Interactions. If you
     don't want your Interactions used in this way, navigate to settings to
     change your preference" — how the ACP server exposes that preference is
     a measurement, recorded below once made.
   - **Measured before the descriptor, unauthenticated (no turn spent).**
     `initialize` with `protocolVersion: 1` is answered `1` (13.7 s cold, 1.0 s
     warm); with `2` it is answered `2` — so the daemon's v1 pin holds with no
     change (the registry-forum report that it "negotiates protocolVersion 2"
     is the client asking for 2). `agentInfo` `antigravity-acp` /
     `agy_acp_server_1.1.1`; `agentCapabilities.loadSession: true`,
     `sessionCapabilities: {list, resume}`, `mcpCapabilities: {http, sse}`,
     `promptCapabilities: {image, audio, embeddedContext}`, `auth: {logout}`;
     `authMethods`: `oauth-personal` ("Log in with Google"), `oauth-business`,
     `gemini-api-key`, `agent-platform`. `session/new` without credentials:
     `-32000 Authentication required`, data naming the `authenticate` method
     and the `auth.type` key of `~/.gemini/antigravity-acp/settings.json`.
     Still to measure once logged in: `session/prompt` update kinds, where
     usage lands (`usage_update`, `PromptResponse.usage`, `_meta`, or
     nowhere), `session/request_permission` shape and whether a settings key
     silences it, `session/cancel`, `session/load` across a server restart,
     model selection (`config_option_update` / `session/set_config_option`),
     and the tier the login reports.
   - **Success criteria (written before code):**
     1. One `antigravity` descriptor in `lib/target-registry.mjs` with an `acp`
        block the fake-agent shape already models; **no change to
        `scripts/acp-daemon.mjs`** unless a measurement forces one, and then
        `scripts/copilot-acp-daemon.test.mjs` still passes unchanged.
     2. The daemon spawns the registry's `agy_acp_server.par`, never `agy`
        (`agy` has no ACP mode; the `.par` is the binary Google ships for ACP
        clients). `scripts/install-antigravity-acp.mjs` installs it: reads the
        live registry `agent.json`, downloads the platform archive, verifies
        the Google LLC Developer ID signature on macOS, unpacks under
        `~/.local/share/agent-companion/antigravity-acp/<version>/` and points
        `current` at it; `ANTIGRAVITY_ACP_BIN` overrides the path. Onboarding,
        doctor and README name this command; the cask is optional and
        unreferenced.
     3. The auth probe spends no turn: it reads the server's own credential
        files (measured after login), never `session/new`.
     4. The permission policy is the daemon's answer to
        `session/request_permission`, from
        `AGENT_COMPANION_ANTIGRAVITY_PERMISSION=all|edit|none` (default
        `all`), the shape Gemini's had minus the flag the server does not take.
     5. Usage is read from wherever the measurement finds it, through
        `lib/usage.mjs`, `source: antigravity-acp`; absent when nothing is
        reported.
     6. `acp.loadSession` is true only if a session measured to survive a
        server restart loads; `acp.updates` lists exactly the kinds measured.
     7. Target enum and docs: `TARGET_IDS`, `VALID_TARGETS`, both plugin
        manifests, `setup.sh`, onboarding usage strings, `prewarm-target.sh`,
        both agent templates and their suites, README matrix and notes,
        `docs/ARCHITECTURE.md` Companion Matrix, CLAUDE.md, `probes/README.md`.
     8. `probes/smoke/acp-antigravity.mjs`, modelled on the dropped
        `acp-gemini.mjs` (908193b): send with `meta.usage`, thread continuity
        on one session, reply as cancel + re-prompt with the honest
        acknowledgement, cancel, and a bridge SIGKILL mid-turn with bridge B
        rejoining the same prompt id.
     9. Gates before done: full root-anchored `node --test`; the five codex
        smokes still 13/13, 8/8, 17/17, 18/18, 16/16; one real Copilot job
        through the bridge (shared daemon code path); the Antigravity probe
        green against the real bridge; this item marked done with the date;
        commit in `type(scope): …` style and push.
   - **Measured after the login, before the descriptor (agy_acp_server 1.1.1,
     2026-09-11; every prompt was on a throwaway cwd).** The operator signed
     in with `oauth-personal`; the server recorded `auth.type` in
     `~/.gemini/antigravity-acp/settings.json`, put the token in the login
     keychain (service `gemini`, account `antigravity-acp`) and logged
     `loadCodeAssist … currentTier: free-tier (Antigravity)` with the privacy
     notice that human reviewers may read prompts and code for up to 18
     months unless the account opts out. `session/new` answers `modes`
     (`default`, `auto_edit`, `yolo`), `configOptions` (a `model` select —
     `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-*`,
     `gemini-3.6-flash-*`, `gemini-pro-agent`, `gemini-3.1-pro-low`; current
     `gemini-3.7-flash-high`) and `models.availableModels`, then emits
     `available_commands_update` (`plan`, `logout`). A prompt that reads a
     file emits `tool_call`, `tool_call_update`, `agent_message_chunk` (and
     `agent_thought_chunk` when it thinks) and answers `{stopReason:
     "end_turn"}` — no `usage`, no `_meta`, no `usage_update` on the stream:
     usage is nowhere on the ACP surface. (The server's stderr echoes the
     internal harness's `usageUpdate` frames — promptTokenCount,
     candidatesTokenCount, thoughtsTokenCount — as debug logging; not read.)
     In `default` mode a shell command and a file write each arrive as
     `session/request_permission` (kind `execute` with allow_always /
     allow_once / reject_once, kind `edit` with allow_once / reject_once; the
     allow_always option carries an `agy.security.warning` about prompt
     injection); a read never asks; after `session/set_mode yolo` nothing
     asks. `session/cancel` mid-turn answers `stopReason: cancelled` after a
     "context canceled" chunk. The server process killed, a fresh one
     `session/load`s the id, replays twelve updates (`user_message_chunk`
     included) and the follow-up answers from memory; `session/list` answers
     on v1 too. `session/set_config_option {configId: model}` switches the
     model and echoes `currentValue`; `session/set_model` answers `{}`; an
     unknown id is `-32602 "Model 'x' is not available for the current
     authentication method"` with `availableModels`; and the loaded session
     comes back on the default model with the mode reset. Cold start to the
     `initialize` answer 13.7 s, warm 1.0 s; `--version` 1.2 s.
   - **Shipped (2026-09-11).** `antigravity` descriptor in
     `lib/target-registry.mjs` with `antigravityAcpPaths`,
     `resolveAntigravityPermission` and `probeAntigravityAuth`;
     `scripts/install-antigravity-acp.mjs` (registry-driven install with the
     Developer ID check on macOS, `--check`, `--login` driving `authenticate`
     over stdio and echoing the tier); **one daemon change, forced by the
     model measurement**: `acp.setModel` names the request the daemon sends
     after `session/new` and again after `session/load` when a model is
     pinned (`_applySessionModel`; Copilot's descriptor has no hook and
     `scripts/copilot-acp-daemon.test.mjs` passes unchanged, 13/13). The auth
     probe hook (`descriptor.auth.probe` with an injected reader, runner and
     platform) returned to `lib/target-diagnostics.mjs`. The fake agent
     accepts a bare spawn, answers `session/set_config_option` and forgets
     the model on load. `test/fake-acp-agent.mjs`'s own descriptor stays the
     neutral one; Antigravity's is driven through the same fake via
     `ANTIGRAVITY_ACP_BIN` in `scripts/acp-daemon.test.mjs` (descriptor, model
     on new and on load, the -32602 refusal reaching prompt-bg) and
     `bridge-server/server.test.mjs` (send without wrapper/fleet/usage, reply
     wording, the enum, and an end-to-end run where the daemon is stopped
     between rounds so round two `session/load`s on a fresh daemon). Docs:
     README matrix, notes, requirements, onboarding, usage table and runtime
     files; both diagram SVGs re-rendered; ARCHITECTURE matrix, ACP paragraph
     and four Negative Results; both templates; CLAUDE.md; probes/README;
     RELEASE_READINESS gate 9; DIRECTION_ASSESSMENT §7.
   - **Gates, 2026-09-11.** `probes/smoke/acp-antigravity.mjs` 24/24 against
     the real bridge, daemon and server (send 22 s with two tool calls and no
     `usage` key; round two on the same session from memory; reply as cancel
     + re-prompt with the follow-up winning; cancel → `cancelled`; bridge A
     SIGKILLed mid-turn, the daemon outlived it, bridge B hydrated the same
     prompt id and the job completed; a `gemini-3.8-flash-low` pin sent to
     the daemon landed as `session/set_config_option ok` in its log). One
     real Copilot job through the same bridge: `copilot-mtwm2l8q-uqhz`,
     completed in 54 s, `RUBBER-DUCK: clean`, `meta.usage` from OTEL
     (`claude-sonnet-5`, cost 3), both daemons registered side by side in
     `acp_daemons`. Doctor: `antigravity` installed (build stamp
     `Built on Thu Sep 3 00:22:52 2026`), authenticated (keychain item
     present), permission `all`, ready. `claude plugin validate .` and the
     codex marketplace build pass. Full root-anchored `node --test`: 685/685
     (the exec-timeout guard caught the installer's first, unbounded
     shell-outs; every one is now bounded and the script is a listed
     exception); the five codex smokes 13/13, 8/8, 17/17, 18/18, 16/16;
     `npm audit` clean.
   - Non-goals: no HTTP/WebSocket ACP, no routing or strength change, no
     change to the codex or opencode adapters, no API-key auth path unless the
     operator asks for one; the `yolo` session mode is not set (the daemon's
     answer is the policy); the stderr usage frames are not read.

## Validation Commands

```bash
node --check bridge-server/server.mjs
node --check bridge-server/validation.mjs
node --check bridge-server/opencode-runtime.mjs
node --check bridge-server/opencode-server-runtime.mjs
node --check bridge-server/codex-runtime.mjs
node --check bridge-server/codex-app-server-runtime.mjs
node --check lib/profile-registry.mjs
node --check lib/target-registry.mjs
node --check lib/target-diagnostics.mjs
node --check lib/doctor.mjs
node --check scripts/onboard.mjs
node --check scripts/acp-daemon.mjs
node --check scripts/install-antigravity-acp.mjs
node --check lib/state.mjs
find . -name '*.test.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 node --test
node scripts/validate-codex-release.mjs
claude plugin validate .
```
