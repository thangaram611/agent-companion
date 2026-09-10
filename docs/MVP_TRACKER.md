# MVP Tracker

Last updated: 2026-09-10

## MVP Definition

Complete a generic delegation bridge that no longer requires Copilot as the
primary companion:

- Generic `agent_*` MCP tools are the only subagent surface.
- Users bring their harness; supported harnesses are Claude Code and Codex CLI.
- Users attach their companion; supported companions are OpenCode, Copilot, and Codex.
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
- Goose and Aider are not implemented yet.
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
   - Goose first candidate for desktop/CLI/API plus MCP/ACP fit.
   - Aider second candidate for git-native terminal workflows.
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
   a fresh and a resumed thread), and the OpenCode shapes against both its
   OpenAPI document (opencode 1.18.30) and its SDK types. Success criteria, as
   written before code:
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
     document) and the transcript loader; OpenCode CLI from `step_finish`
     parts when the JSON stream carries them (schema-derived, not live-measured
     — no provider on this machine — and said so in the registry notes).
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
node --check lib/state.mjs
find . -name '*.test.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 node --test
node scripts/validate-codex-release.mjs
claude plugin validate .
```
