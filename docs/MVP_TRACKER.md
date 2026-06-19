# MVP Tracker

Last updated: 2026-06-19

## MVP Definition

Complete a generic delegation bridge that no longer requires Copilot as the primary target:

- Generic `agent_*` MCP tools are the primary subagent surface.
- Users bring their target; MVP-supported targets are OpenCode and Copilot.
- Existing Copilot behavior keeps working through compatibility aliases.
- Repo docs and tests make the current state and remaining work recoverable.

## Done

- Added target default state:
  - `default-target` state file.
  - `AGENT_COMPANION_DEFAULT_TARGET` env override.
  - legacy `COPILOT_COMPANION_DEFAULT_TARGET` env override.
  - current bootstrap fallback target: `opencode`.

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

- Preserved legacy MCP aliases:
  - `copilot_send` pins `target: "copilot"`.
  - Existing wait/status/reply/cancel aliases remain available by `job_id`.

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
  - Claude installer grants `agent_*` tools.
  - legacy `copilot_*` permissions remain granted for stale materialized agents.

- Added tests:
  - state tests for `default-target`.
  - MCP tool-list coverage for `agent_*` plus `copilot_*`.
  - fake OpenCode CLI smoke test.
  - target-aware status/inspect behavior.
  - permissions test update.

- Added repo docs:
  - [docs/ARCHITECTURE.md](ARCHITECTURE.md)
  - this tracker.

## MVP Limitations

- OpenCode adapter is single-shot CLI mode, not OpenCode server/ACP mode.
- OpenCode reply/re-steer is not supported yet.
- OpenCode restart resume is not supported yet; persisted nonterminal OpenCode jobs are marked `unreachable` after bridge restart.
- OpenCode permission auto-approval is opt-in only because it uses `--dangerously-skip-permissions`.
- Digest URI scheme is still `copilot-digest://` for compatibility.
- Server/plugin/template names still use `copilot-companion` / `copilot-bridge`.
- Goose and Aider are not implemented yet.

## Next Backlog

1. First-class onboarding:
   - implement the target-first setup/doctor flow from [docs/ONBOARDING_HANDOFF.md](ONBOARDING_HANDOFF.md).
   - remove the current Copilot hard requirement for OpenCode-only installs.
   - make SessionStart Copilot daemon prewarm target-aware.

2. OpenCode server/ACP adapter:
   - support in-flight reply/re-steer.
   - support restart resume.
   - stream events into richer digests.

3. Generic naming cleanup:
   - introduce `agent-digest://`.
   - decide whether/when to rename MCP server, plugin, state dirs, and template files.
   - keep migration/backcompat plan explicit before changing installed paths.

4. Target management UX:
   - add CLI/script to read/write `default-target`.
   - expose concise status output showing active default target and target matrix.
   - document OpenCode install/provider setup in one focused section.

5. Additional target adapters:
   - Goose first candidate for desktop/CLI/API plus MCP/ACP fit.
   - Aider second candidate for git-native terminal workflows.
   - Keep adapters capability-driven; do not assume reply/resume/parallel support.

6. Release validation:
   - run full Node test suite.
   - run Codex marketplace validation.
   - run Claude plugin validation.
   - manually smoke a real OpenCode install and a real Copilot install.

## Validation Commands

```bash
node --check bridge-server/server.mjs
node --check bridge-server/opencode-runtime.mjs
node --check bridge-server/target-registry.mjs
node --check lib/state.mjs
node --test lib/state.test.mjs bridge-server/server.test.mjs
node --test $(find bridge-server lib scripts hooks templates -name '*.test.mjs')
```
