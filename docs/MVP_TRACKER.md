# MVP Tracker

Last updated: 2026-06-23

## MVP Definition

Complete a generic delegation bridge that no longer requires Copilot as the
primary companion:

- Generic `agent_*` MCP tools are the only subagent surface.
- Users bring their harness; supported harnesses are Claude Code and Codex CLI.
- Users attach their companion; supported companions are OpenCode and Copilot.
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
  - reply/resume remains Copilot-only in the MVP.

- Updated subagent templates:
  - use `agent_*` tools.
  - document optional `target`.
  - document the bring/configure-your-target posture with OpenCode and Copilot supported now.
  - keep Claude session-id forwarding and Codex MCP `_meta` behavior.

- Updated permissions:
  - Claude installer grants the `agent_*` tools only (no legacy `copilot_*` grants, no legacy migration code).

- Completed the full rename + legacy removal:
  - removed `copilot_*` MCP aliases and the `copilot:` error namespace (now `agent:`).
  - removed legacy env (`COPILOT_COMPANION_DEFAULT_TARGET`, `AGENT_COMPANION_OPENCODE_SKIP_PERMISSIONS`) and the silent `opencode` bootstrap fallback (unconfigured target now errors with onboarding guidance).
  - renamed the product identity to `agent-*` everywhere: MCP server `agent-bridge`, digest scheme `agent-digest://`, env prefix `AGENT_COMPANION_*`/`AGENT_RUNTIME_*`, state dir `~/.{claude,codex}/agent-companion/`, repo/plugin/subagent/template names `agent-companion`.

- First-class onboarding (this pass):
  - `lib/target-registry.mjs` (moved from `bridge-server/`) now carries install/auth/permission/smoke metadata.
  - `lib/target-diagnostics.mjs` — `inspectTarget`/`inspectTargets`/`selectConfiguredTarget`/`targetReadinessSummary`.
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
  - Public docs distinguish today's one-to-one `target` routing from the future
    one-to-many companion profile router.
  - [docs/RELEASE_READINESS.md](RELEASE_READINESS.md) records source-backed
    compatibility notes and public release gates.
  - Claude and Codex plugin manifests now describe the supported harnesses and
    companions consistently.
  - `setup.sh` install copy maps `--host` to harness and `--target` to today's
    companion selector without renaming stable flags.
  - Copilot default-model fallback now uses a currently documented Copilot CLI
    model (`claude-sonnet-4.6`), and Copilot model validation is separated from
    the Codex subagent role model allow-list.

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
- Goose and Aider are not implemented yet.

## Next Backlog

1. Release validation:
   - run full Node test suite.
   - run Codex marketplace validation.
   - run Claude plugin validation.
   - manually smoke a real OpenCode install and a real Copilot install — done
     2026-06-23: both companions pass a real bridge delegated send (OpenCode via
     Ollama Cloud free `gpt-oss:120b`; Copilot via `claude-sonnet-4.6`).
   - All six pre-tag smoke gates pass (harness install smokes ran under a
     sandboxed `$HOME`, real config verified untouched). See
     [docs/RELEASE_READINESS.md](RELEASE_READINESS.md) "Smoke evidence".

2. Strength-routed companion profiles — DONE (2026-06-23). Built per
   [docs/STRENGTH_ROUTING_HANDOFF.md](STRENGTH_ROUTING_HANDOFF.md) across phases
   P1–P5 with the committed regressions green:
   - `lib/profile-registry.mjs` is the single producer of `profiles.json`
     (`loadProfiles`), with a source-scanning single-producer guard test.
   - `resolveRouting` in `bridge-server/server.mjs` is the sole SEND routing
     brain: constraint-consistency precedence, six no-silent-fallback codes, and
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
   - Goose first candidate for desktop/CLI/API plus MCP/ACP fit.
   - Aider second candidate for git-native terminal workflows.
   - Keep adapters capability-driven; do not assume reply/resume/parallel support.

## Validation Commands

```bash
node --check bridge-server/server.mjs
node --check bridge-server/validation.mjs
node --check bridge-server/opencode-runtime.mjs
node --check bridge-server/opencode-server-runtime.mjs
node --check lib/profile-registry.mjs
node --check lib/target-registry.mjs
node --check lib/target-diagnostics.mjs
node --check lib/doctor.mjs
node --check scripts/onboard.mjs
node --check lib/state.mjs
node --test $(find bridge-server lib scripts hooks templates test -name '*.test.mjs')
node scripts/validate-codex-release.mjs
claude plugin validate .
```
