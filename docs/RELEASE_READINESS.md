# Release Readiness

Last updated: 2026-09-03

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
| Companion | `target` | OpenCode (`cli`/`server`), GitHub Copilot CLI, Codex CLI (`exec`/`appserver`) |
| Companion profile | `profile` — a `profiles.json` entry | yes, `agent_send({ profile })` |
| Strength | `strength` | yes — `reviewer`, `web_researcher`, `planner`, `fast_executor` |

Routing is one-to-many: a harness connects several companion profiles at once,
and each `agent_send` resolves to exactly one of them. The request names a
`strength` (preferred), a `profile` id, or a bare `target`; with none of those,
the configured default profile wins. `resolveRouting` in
`bridge-server/server.mjs` is the sole routing brain, and it never falls back
silently — an unresolvable, ambiguous, or capability-gated request returns an
`ok:false` envelope naming the failure, echoing the candidate ids where
candidates exist.
Two honest limits sit behind that: `STRENGTH_CAPABILITY_REQUIREMENTS` ships
empty (no strength yet demands a capability), and a profile's `adapter` field is
a capability declaration rather than transport selection at spawn — the
transport a job starts on is still whatever `OPENCODE_RUNTIME_ADAPTER` /
`CODEX_RUNTIME_ADAPTER` says, frozen per job in the ledger.

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
- Codex agent roles intentionally cannot add MCP authority: the bounded role
  overlay omits `mcp_servers`, and the upstream regression test asserts that a
  child retains the parent's MCP set. Agent Companion therefore declares its
  bridge in the Codex-only plugin manifest, where the child inherits it:
  <https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/core/src/agent/role.rs#L33-L119>,
  <https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/core/src/agent/role_tests.rs#L403-L480>.
- Codex 0.152.1 supports the inline native `mcpServers` object and resolves a
  relative `cwd` against the installed plugin root. This preserves the 1320s
  tool timeout and avoids a root `.mcp.json` that Claude might also discover:
  <https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/core-plugins/src/manifest.rs#L446-L470>,
  <https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/codex-mcp/src/plugin_config.rs#L281-L289>.

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
  which is the form an OpenCode companion profile's `model` takes:
  <https://opencode.ai/docs/cli/>.
- OpenCode also documents `opencode acp` for ACP-compatible editors:
  <https://opencode.ai/docs/acp/>. The adapter set is `cli` and `server`, and
  the server adapter already covers reply/resume, so an ACP stdio adapter stays
  deferred — it is the one item on this page with no code behind it.
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

- **Wire contract generated from codex-cli 0.154.0** (`lib/codex-app-server-contract.json`
  records that `codexVersion` as provenance; the `exec` stream census in
  `bridge-server/codex-runtime.mjs` was taken on 0.147.0, and the historical
  0.147.0 → 0.150.1 and 0.152.1 → 0.154.0 app-server deltas were purely additive). The version is
  **not** the gate: the drift test compares the configured CLI's live schema and
  the broker boot probe compares its selected binary's schema to the fixture, so
  a version-only bump passes and only a real schema change fails the test —
  classified, routing moves first.
  The broker never refuses to boot on it: it reports `contractStatus: match|drift|unverified`
  on `initialize` / `broker/status` and keeps serving. The `--json` ThreadEvent schema (`thread.started`/`item.*`/`turn.*`/
  top-level `error`) and the `-c sandbox_workspace_write.network_access=<bool>`
  override key are version-sensitive; a silently-renamed key degrades without an
  error since neither adapter passes `--strict-config`. Re-verify against
  the configured and selected `codex --version` before bumping the pin.
- **Two transports ship, selected by `CODEX_RUNTIME_ADAPTER`**: `exec` (default,
  `bridge-server/codex-runtime.mjs`) and `appserver`
  (`bridge-server/codex-app-server-runtime.mjs` plus the detached broker in
  `scripts/codex-app-server-broker.mjs`). `exec` is send-only; `appserver` adds
  reply, restart resume, and streamed sub-turn digests. Where a note below names
  a flag the bridge passes, that note is `exec`-only: the app-server carries the
  same decisions as JSON-RPC params instead of argv.
- `codex exec --json` is documented as the non-interactive entrypoint
  (`codex exec --help`; `learn.chatgpt.com/docs/non-interactive-mode`). Default
  sandbox is `read-only` (edit-incapable); on the `exec` adapter the bridge
  always passes `--sandbox workspace-write` (or an explicit override) plus
  `--skip-git-repo-check` (codex refuses non-git cwds by default, and the
  bridge dispatches into arbitrary cwds).
- On the `appserver` adapter the broker spawns bare `codex app-server` — no
  sandbox flag, no `--skip-git-repo-check` — and the sandbox travels as params
  on the wire. `thread/start` and `thread/resume` carry `sandbox`, the bare
  kebab-case mode enum; `turn/start` carries `sandboxPolicy`, a camelCase tagged
  union (`{type:'workspaceWrite', networkAccess}`, `{type:'readOnly',
  networkAccess:false}`, `{type:'dangerFullAccess'}`) that is where the network
  bit actually lives. Both adapters resolve the mode from the same
  `AGENT_COMPANION_CODEX_SANDBOX_MODE` resolver, so the transports agree by
  construction; `bypass` — an exec-transport spelling, one CLI flag that removes
  the sandbox and the approvals together — collapses onto `dangerFullAccess`
  here, because the app-server splits those into independent params. Every
  `sandboxPolicy` variant defaults `networkAccess` to its restrictive value —
  the inverse of exec, where omitting the `-c` key defers to the user's
  `config.toml` and fails open — so the adapter states the network explicitly on
  both transports. Measured 2026-08-11 against 0.147.0's own schema; the applied
  policy is read back off the rollout's `turn_context.sandbox_policy`.
- Under `appserver`, `approvalPolicy` is pinned to `never` and no caller or env
  var can override it: a measured `read-only` thread that accepted one approval
  wrote a file, so the sandbox — not the approval prompt — is the boundary. The
  control surface is `turn/steer` for reply (injected into the running turn,
  nothing cancelled), `turn/interrupt` for cancel (the thread stays live and
  resumable), `thread/resume` for restart recovery, and `thread/read` as the
  over-RPC salvage channel. `turn/interrupt` requires `turnId` and `turn/steer`
  requires `expectedTurnId`; omitting either is an unconditional `-32600`.
- The broker is one detached process per host home at a fixed socket path
  under that home (so the Claude and Codex harnesses own one each),
  owning one `codex app-server` over stdio; the bridge is a detachable client,
  which is what lets a job outlive the bridge that started it. The app-server
  child is deliberately not detached — it must die with its broker.
- App-server startup is gated on a complete Codex/`codex-code-mode-host` pair.
  The configured/PATH Codex remains the desired-version anchor; a matching
  unquarantined pair under `$CODEX_HOME/plugins/.plugin-appserver/` may replace
  an incomplete or quarantined configured pair without symlinks or xattr
  mutation. A complete quarantined configured pair is advisory rather than a
  hard failure when no usable fallback exists. Quarantine inspection is
  tri-state: probe failures remain indeterminate and never count as confirmed
  attribute absence.
- `initialize` and `broker/status` expose the exact running version, invoked and
  canonical paths, helper, source, stat identity, and quarantine verdict. Each
  send compares those with a fresh installation inspection and safely replaces
  a stale broker only when clients, leases and active-turn reads permit it.
  Configuration `EPERM` and dead-broker failures during `thread/start` receive
  one guarded restart/retry.
- A live, known-zero-tool `turn/completed` with a universal pre-execution
  command blocker is not accepted as success. A recovered `thread/read`
  transcript is remapped only when it explicitly names the unavailable runner.
  The result is `unreachable`, detail `codex_code_mode_host_unavailable`, and
  machine-readable `failure_class: runtime_unavailable` across status, wait and
  notification surfaces; ordinary zero-tool answers remain completed.
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
find . -name '*.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 -n1 node --check
find . -name '*.test.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 node --test --experimental-test-coverage
(cd bridge-server && npm audit --omit=dev --audit-level=moderate)
node scripts/validate-codex-release.mjs
claude plugin validate .
```

On the audit gate: every advisory the bridge has ever carried came in through
`@modelcontextprotocol/sdk`'s HTTP-transport dependencies (`hono`, `express`,
`ajv`, `express-rate-limit`), which a stdio-only server never loads. Measured
2026-08-28 on five advisories: bumping the SDK cleared none of them, because
the patched versions already sat inside the ranges the SDK declares — only the
lockfile was stale. The fix for that class is `npm update <the transitives>`
in `bridge-server/` with `package.json` untouched, never an SDK bump or an
`overrides` block; upstream (modelcontextprotocol/typescript-sdk#2042) reached
the same conclusion. Gate re-verified clean that day.

The first four commands are the same work `.github/workflows/ci.yml` does in its
`Shell syntax`, `JavaScript syntax`, `Tests with coverage`, and `Production
dependency audit` steps; the last two are release-only and have no CI
counterpart. Discovery is anchored at the repo root rather than at a directory
allowlist, because the allowlist these lines replaced omitted `test/` and so
skipped the two cross-cutting guard suites —
`test/exec-timeout-guard.test.mjs` (bounded shell-outs) and
`test/profile-registry-guard.test.mjs` (single reader of `profiles.json`) — the
exact drift this gate exists to catch. Measured 2026-08-13: the allowlist
discovered 37 test files, the root-anchored form discovers 39.

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
8. Codex CLI companion on the app-server transport
   (`CODEX_RUNTIME_ADAPTER=appserver`): `node probes/smoke/appserver.mjs` for
   restart survival, `node probes/smoke/appserver-control.mjs` for the
   reply/steer and cancel/interrupt control paths, and
   `node probes/smoke/review-loop.mjs` for the review loop (a parsed `review`
   verdict, and a follow-up send resuming the same codex thread across a
   bridge SIGKILL). All three drive the real bridge against a real broker and
   a real `codex app-server`, and all three spend real tokens. Run `CODEX_RUNTIME_ADAPTER=appserver node scripts/doctor.mjs --json`
   before and after a Codex package upgrade; record the selected and running
   path/version/helper, and require no stale-runtime warning before the smoke.
9. One real Copilot send through the bridge after any change to
   `scripts/acp-daemon.mjs` (Copilot rides the generic daemon), checking the
   spawn argv in `copilot-acp-daemon.log`, the rubber-duck footer, the OTEL
   `meta.usage` and the `acp_daemons.copilot` registry entry on `agent_status`.
   Recorded 2026-09-11 on Copilot CLI 1.0.83: job `copilot-mtwil1g9-e4si`
   completed in 33 s with the identical argv, `RUBBER-DUCK: clean`, usage
   `source: copilot-otel` (cost 3 premium requests), daemon pid recorded.

### Smoke evidence

Recorded 2026-06-23 (macOS, Node 24.15.0), extended 2026-07-24 for gate 7 and
2026-08-11 for gate 8, and re-verified on the live hosts 2026-09-03 with
Claude Code 2.1.259 and codex-cli 0.152.1. All eight gates pass. The original
harness install smokes
(1, 2, 6) were run under a sandboxed `$HOME` so the real `~/.claude` /
`~/.codex` were never written, then the sandbox was deleted and the real config
verified byte-identical.

- **Gate 1 — Claude source install: PASS.** `bash setup.sh --host claude --target none`
  (sandboxed `$HOME`) materialized the subagent, merged the `agent-bridge`
  permission into `settings.json`, added the agent-teams env, and wrote the host
  marker. The 2026-09-03 live reinstall and the user's exact interactive
  `claude` alias both loaded the materialized agent and called bridge status
  without a permission denial.
- **Gate 2 — Codex source install: PASS.** `bash setup.sh --host codex --target none`
  (sandboxed `$HOME`) materialized the TOML subagent, merged `hooks.json`, and
  wrote the host marker. On 2026-09-03 the installed Codex plugin's parent and
  named `agent-companion` child both called the manifest-declared bridge under
  `approval_policy=never`; Codex exposes the raw server `agent-bridge` to the
  model as deferred `functions.exec` tools named `mcp__agent_bridge__*`.
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
  `defaultEnabled: false`). A live uninstall/reinstall on 2026-09-03 refreshed
  that cache byte-for-byte, it was enabled at user scope, and delegated job
  `codex-mtl4zzpn-oc8j` completed through the Codex app-server in 15 seconds
  with one tool call and the requested working directory. The equivalent Codex
  parent → named child → bridge job `codex-mtl4u87x-irqo` completed in 13
  seconds with one tool call.
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
- **Gate 8 — Codex app-server transport: PASS (2026-08-11, codex-cli 0.147.0; re-verified 2026-08-28 on codex-cli 0.150.1 — all four smokes 12/12, 8/8, 17/17, 18/18, plus the `unloaded`/`errs` taxonomy and the `probe.mjs` approval/inherit/sandbox/errors scenarios, all identical to the 0.147.0 measurements; see `probes/README.md`).**
  Both probes green against the real bridge, the real broker and a real
  `codex app-server`:
  - **Restart survival** — `probes/smoke/appserver.mjs`, 17/17. Bridge A
    dispatches, banks the thread id and streams sub-turn text into the digest,
    then is SIGKILLed mid-turn; the broker, its `codex app-server` and a live
    shell descendant keep running the turn with zero bridges alive. Bridge B
    hydrates on the same host session, resumes the *same* thread, and the job
    reaches `completed` with the answer intact and A's streamed text preserved
    under "Carried forward from the previous bridge". The verdict is explicitly
    not the exec transport's `target_child_orphaned_by_bridge_restart`. Two of
    the 17 checks read the applied sandbox back off the rollout —
    `turn_context.sandbox_policy` is workspace-write with network access, and
    applying it pinned neither model nor effort — and a final one holds
    `agent_status` to the truth at terminal: `reply_available` false (the turn
    is over) with `resume_available` still true (the thread is not).
  - **Control surface** — `probes/smoke/appserver-control.mjs`, 18/18.
    `agent_reply` steers a running turn (`turn/steer` with the required
    `expectedTurnId`) and the turn obeys the injected instruction instead of the
    one it started with; `agent_cancel` interrupts (`turn/interrupt` with
    `turnId`) and the job settles `cancelled` while the thread survives — still
    in `thread/loaded/list`, `thread/resume` → idle with its last turn recorded
    `interrupted`, and `thread/read` still returning the history. Both turn-id
    sources are exercised: the banked one from `turn/started` and the
    restarted-bridge fallback that reads the running turn off `thread/read`.
  - **2026-09-02 cask-upgrade incident and regression boundary** — an orphaned
    0.151.0 broker survived a Homebrew upgrade, the affected local 0.152.0
    payload lacked the helper, and job `codex-mtjptuj4-89gw` was incorrectly
    promoted to `completed` after every command failed before execution. These
    three bridge defects are covered respectively by stale/idle broker tests,
    `lib/codex-install.test.mjs` plus doctor diagnostics, and the server's
    persistence/status/wait/notification regression. On the subsequently
    installed 0.152.1 cask, the packaged helper was present and a complete
    quarantined cask pair passed the runtime smoke; quarantine remains visible
    as an advisory. The precise TCC responsible-process mechanism, Gatekeeper
    inheritance mechanism, and reason the historical local 0.152.0 payload
    differed from the currently published archive remain unproven; see
    `docs/ARCHITECTURE.md` “Codex Upgrade Incident Evidence”.

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

Strength routing, companion profiles and per-profile models shipped 2026-06-23
with committed regressions (`bridge-server/routing.test.mjs`,
`lib/profile-registry.test.mjs`, `test/profile-registry-guard.test.mjs`); the
codex app-server transport shipped 2026-08-11 with the probe evidence recorded
above. The OpenCode `acp` stdio adapter is the one item this page still defers —
claim it once that path has code and tests.
