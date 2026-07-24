# Release Readiness

Last updated: 2026-07-24

This page is the public-readiness checklist for the harness + companion launch.
It records the source-backed compatibility assumptions behind the repo copy,
setup flow, and next backlog.

## Public Positioning

Slogan:

> Come with any harness and attach any companion of your choice to it.

Current vocabulary:

| Product term | Current implementation term | Supported now |
| --- | --- | --- |
| Harness | `host` | Claude Code, Codex CLI |
| Companion | `target` | OpenCode, GitHub Copilot CLI, Codex CLI |
| Companion profile | not implemented yet | planned |
| Strength | not implemented yet | planned |

Current routing is still one-to-one: one `agent_send` resolves to one companion
target runtime. The future direction is one-to-many companion profiles routed by
strengths such as `reviewer`, `web_researcher`, `planner`, or `fast_executor`.

## Source-Backed Compatibility Notes

Claude Code plugins:

- Claude Code documents plugins as self-contained component bundles that can
  include agents, hooks, MCP servers, skills, and other components:
  <https://code.claude.com/docs/en/plugins-reference>.
- Claude plugin-shipped agents do not support `hooks`, `mcpServers`, or
  `permissionMode` frontmatter. This repo keeps the marketplace/plugin package
  and materialized standalone agent path separate for that reason.

Codex plugins:

- Codex requires `.codex-plugin/plugin.json` and documents `interface` metadata
  for install-surface copy:
  <https://developers.openai.com/codex/plugins/build>.
- Codex plugins can bundle lifecycle hooks through the manifest or the default
  `hooks/hooks.json` path, and plugin-bundled hooks still go through trust
  review:
  <https://developers.openai.com/codex/hooks>.

OpenCode companion:

- The `cli` adapter (default) uses the documented non-interactive `opencode run`
  path. OpenCode documents `--format`, `--model`, `--attach`, and `--dir` flags
  for `run`: <https://opencode.ai/docs/cli/>.
- The `server` adapter (`OPENCODE_RUNTIME_ADAPTER=server`) drives `opencode serve`
  over HTTP for reply/resume/streamed digests. Verified against the live server
  API (opencode 1.17.9): `POST /session?directory=<cwd>` roots a session at a cwd,
  `POST /session/{id}/prompt_async` runs it, `POST /session/{id}/abort` cancels,
  the directory-scoped `GET /event?directory=<cwd>` SSE stream carries
  `message.part.updated` + a terminal `session.idle`, and `GET /session/status`
  reports per-session busy/idle. One detached server is shared and reused across
  restarts.
- `opencode models` lists configured provider models in `provider/model` form,
  which is the right basis for future OpenCode companion profiles:
  <https://opencode.ai/docs/cli/>.
- OpenCode also documents `opencode acp` for ACP-compatible editors:
  <https://opencode.ai/docs/acp/>. The server adapter already covers reply/resume,
  so an ACP stdio adapter is deferred.
- OpenCode permissions are configured as `allow`, `ask`, or `deny`; the `cli`
  adapter exposes opt-in `--dangerously-skip-permissions`, while the `server`
  adapter follows OpenCode's own permission config (no hidden auto-approval):
  <https://opencode.ai/docs/permissions/>.

GitHub Copilot CLI companion:

- GitHub documents Copilot CLI authentication through `/login`, workspace trust
  prompts, and tool approval prompts:
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview>.
- Copilot CLI model selection is documented through `--model=MODEL` or
  `COPILOT_MODEL`. The cited CLI reference enumerates the full supported-model
  table — `claude-sonnet-4.6` (default), `claude-haiku-4.5`, `gpt-5.4`,
  `gpt-5.3-codex`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`,
  `mai-code-1-flash`, and `auto` — which is the basis for the `ALLOWED_MODELS`
  set in `lib/state.mjs`:
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>.
  Public docs and defaults should not advertise an undocumented Copilot model id.

Codex CLI companion:

- **Pinned to codex-cli 0.145.0** (the installed/verified version). The
  `--json` ThreadEvent schema (`thread.started`/`item.*`/`turn.*`/top-level
  `error`) and the `-c sandbox_workspace_write.network_access=<bool>` override
  key are version-sensitive; a silently-renamed key degrades without an error
  since the adapter does not pass `--strict-config`. Re-verify against
  `codex --version` before bumping the pin.
- `codex exec --json` is documented as the non-interactive entrypoint
  (`codex exec --help`; `learn.chatgpt.com/docs/non-interactive-mode`). Default
  sandbox is `read-only` (edit-incapable); the bridge always passes
  `--sandbox workspace-write` (or an explicit override) plus
  `--skip-git-repo-check` (codex refuses non-git cwds by default, and the
  bridge dispatches into arbitrary cwds).
- `codex login status` is documented as exiting 0 with credentials present,
  non-zero otherwise, and is explicitly called out as automation-friendly
  (`learn.chatgpt.com/docs/developer-commands`). Live-verified on 0.145.0: the
  verdict prints to **stderr** with **empty stdout** in both the logged-in
  ("Logged in using ChatGPT") and logged-out ("Not logged in", confirmed via
  `CODEX_HOME=$(mktemp -d) codex login status; echo $?` → exit 1) cases — the
  stock stdout-based auth probe would false-red a logged-in machine, hence the
  descriptor's `auth.checkByExitCode: true`.
- Sandbox modes (`read-only`/`workspace-write`/`danger-full-access`) and the
  `--dangerously-bypass-approvals-and-sandbox` escape hatch are documented at
  `learn.chatgpt.com/docs/sandboxing`; network-in-workspace-write defaults OFF
  in codex's own default and is maintainer-confirmed working via `-c
  sandbox_workspace_write.network_access=true` on macOS CLI
  (openai/codex#13373). The `.git`/`.codex`/`.agents` read-only carve-out
  inside writable roots — which wins over `--add-dir`/`writable_roots` — is
  documented in openai/codex#24461.
- Seatbelt (macOS sandbox-exec) does not nest; `codex sandbox` runs a no-turn
  sandbox preflight. Both are DeepWiki/local-`--help`-sourced, not from the
  primary docs site.

## Release Gates

Automated gates:

```bash
bash -n setup.sh hooks/*.sh
find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.mjs' -print0 | xargs -0 -n1 node --check
node --test --experimental-test-coverage $(find bridge-server lib scripts hooks templates -path '*/node_modules' -prune -o -type f -name '*.test.mjs' -print)
node scripts/validate-codex-release.mjs
claude plugin validate .
```

Manual smoke gates before a public tag:

1. Claude Code source checkout install with `bash setup.sh --host claude --target none`.
2. Codex CLI source checkout install with `bash setup.sh --host codex --target none`.
3. OpenCode default-target onboarding and one real delegated send.
4. Copilot default-target onboarding and one real delegated send.
5. Codex marketplace build/install using `node scripts/validate-codex-release.mjs`.
6. Claude marketplace install or `claude --plugin-dir` smoke.
7. Codex CLI companion (downstream target) default-target onboarding and one
   real delegated send, including a network-using step (e.g. a trivial
   `npm install`/fetch inside the sandbox) to prove the
   `AGENT_COMPANION_CODEX_NETWORK` override actually reaches the sandbox — not
   just that a send completes.

### Smoke evidence

Recorded 2026-06-23 (macOS, Node 24.15.0). All six gates pass. The harness
install smokes (1, 2, 6) were run under a sandboxed `$HOME` so the real
`~/.claude` / `~/.codex` were never written, then the sandbox was deleted and
the real config verified byte-identical.

- **Gate 1 — Claude source install: PASS.** `bash setup.sh --host claude --target none`
  (sandboxed `$HOME`) materialized the subagent, merged the `agent-bridge`
  permission into `settings.json`, added the agent-teams env, and wrote the host
  marker.
- **Gate 2 — Codex source install: PASS.** `bash setup.sh --host codex --target none`
  (sandboxed `$HOME`) materialized the TOML subagent, merged `hooks.json`, and
  wrote the host marker.
- **Gate 3 — OpenCode delegated send: PASS.** OpenCode `1.17.9` connected to
  Ollama Cloud (free `gpt-oss:120b`). Drove the bridge `dispatch()`
  (`agent_send` → still_running + job_id → `agent_wait` → `completed`); the
  companion echoed the requested token, 0 tool calls, digest written. Cost $0.
- **Gate 4 — Copilot delegated send: PASS.** Copilot CLI `1.0.61` authenticated;
  bridge send→wait→`completed` through the ACP daemon using the default model
  `claude-sonnet-4.6`, ACP session established, digest written.
- **Gate 5 — Codex marketplace validate: PASS.** `node scripts/validate-codex-release.mjs`.
- **Gate 6 — Claude marketplace install: PASS.** `claude plugin marketplace add .`
  then `claude plugin install agent-companion@agent-companion` (sandboxed `$HOME`)
  installed `agent-companion@agent-companion` v0.0.1, disabled by default (matches
  `defaultEnabled: false`).
- **Gate 7 — Codex CLI companion delegated send: PASS (2026-07-24, codex-cli
  0.145.0, ChatGPT auth).** Three live checks, all green:
  - **JSONL schema** — one throwaway `codex exec --json` turn (read-only,
    `--ignore-user-config --ephemeral`) emitted exactly the parsed ThreadEvent
    shapes: `thread.started.thread_id`, `item.completed`/`agent_message.text`,
    `turn.completed.usage`.
  - **Bridge dispatch** — `dispatch()` driven directly under a temp
    `AGENT_COMPANION_HOME`: job `codex-mryly512-9gal` completed a real
    workspace-write file edit (exact content verified), digest written,
    thread id persisted as `companionSessionId`,
    `reply_available/resume_available` false.
  - **Full chain incl. network override** — headless Claude Code with
    `--plugin-dir` → `agent-companion` subagent → bridge → codex: job
    `codex-mrym3itg-jpfj` wrote `NETCHECK.txt` containing `200` from a live
    `curl https://example.com` (proves `-c
    sandbox_workspace_write.network_access=true` reached the Seatbelt
    sandbox); job `codex-mrym5oqi-29s7` verified the subagent-wrapper path
    end-to-end.

OpenCode server adapter (added 2026-06-23, same environment):

- **Send: PASS.** `OPENCODE_RUNTIME_ADAPTER=server` with free `ollama-cloud/gpt-oss:120b`.
  Drove the real bridge `dispatch()` against a live detached `opencode serve`:
  `agent_send` → still_running → `agent_wait` → `completed`; assistant token echoed,
  digest written, server pool observable in `agent_status`, no orphaned server.
- **Reply (re-steer): PASS.** Sent a long turn, re-steered it mid-flight; the
  follow-up (`-r1` prompt on the same session) overrode the original task and
  completed. The superseded original turn did not terminalize the job.
- **Cancel: PASS.** Aborted a running turn via the HTTP session abort; the job
  reported `cancelled` even though OpenCode emitted no MessageAbortedError (the
  bridge's cancel intent is authoritative).

Strength routing, companion profiles, multiple models per companion, and the
OpenCode `acp` stdio adapter remain unimplemented; do not claim them until those
paths have code and tests.
