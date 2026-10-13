# Release Readiness

Last updated: 2026-10-13

This page is the public-readiness checklist for the harness + companion launch.
It records the source-backed compatibility assumptions behind the repo copy,
setup flow, and next backlog.

## v0.1.0 setup maintenance verification (2026-10-13)

The original v0.1.0 was published from merged PR #12. The maintainer requested
replacing that release with this maintenance correction, retaining version
0.1.0. The replacement must use the reviewed commit and regenerated archives;
the original publication remains in place until the maintenance PR is merged.

Success criteria: smoke requires a completed assistant `ready` reply; setup
discovers all 47 root test files; prerequisite failures precede installation;
existing configuration is preserved; partial installs report their completed
stages and recover on rerun. The fake-CLI regressions cover empty and failed
responses, missing authentication, ambiguous choices, profiles, preview-only
runs, late failures and separate host defaults.

Fresh live checks used private companion state/runtime directories and the
native clients' existing logins. No real host default or profile was changed.

| Check | Result |
| --- | --- |
| Focused setup, onboarding, profiles, diagnostics and Codex runtime tests | PASS — 118/118 |
| Root-discovered suite with coverage, Node 24.18.0 | PASS — 724/724, no skips or failures |
| Shell/JavaScript syntax, `git diff --check`, production dependency audit | PASS — zero vulnerabilities |
| Codex marketplace install and Claude plugin validation | PASS — version 0.1.0; existing Claude repository-context advisory only |
| Codex onboarding smoke, CLI 0.162.1 | PASS — completed assistant reply `ready`; temporary default persisted afterward |
| OpenCode onboarding smoke, CLI 2.0.25, `ollama-cloud/gpt-oss:120b` | PASS — completed reply `ready`; temporary default persisted afterward |
| Copilot ACP, CLI 1.0.95, `claude-sonnet-4.6` | PASS — completed reply `ready` |
| Antigravity ACP server 1.1.1, native default model | PASS — completed reply `ready.` |
| Real source install and recovery, both harnesses | PASS — controlled failure after Codex plugin installation retained Claude installation without writing defaults; rerun completed both hosts |
| Real rerun with existing configuration | PASS — separate host defaults and profiles preserved byte-for-byte; fresh-session and hook-approval instructions shown |

The real clean-install check exposed a missing prerequisite in the fake CLI:
Codex refuses an explicit `CODEX_HOME` that does not exist. The fixture now
reproduces that failure, and setup creates the selected directory only after
the installation preview is accepted. The real recovery check then passed.
Both probe-owned ACP daemons and their child processes exited after verification.

These small live turns establish access to the tested providers/models. They
do not requalify every model or the unchanged reply/recovery transports. Setup
continues to report live delegation as unverified because it spends no quota.
The earlier transport evidence below retains its original dates and versions.

## Original v0.1.0 candidate evidence

All ten manual gates passed before publication. The release was published from
[merged PR #12](https://github.com/thangaram611/agent-companion/pull/12).
Both plugin manifests use 0.1.0; the private bridge package already uses 0.1.0.
The previous public tag,
v0.0.1 (2026-06-23), precedes 84 implementation commits on main.

Changes since v0.0.1:

- Strength-routed companion profiles and per-profile models, with explicit
  refusal for unresolvable routing.
- OpenCode server mode and the detached Codex app-server broker: streamed
  progress, reply, cancellation and recovery after bridge replacement.
- The `review` template with a parsed verdict and Codex thread continuity on
  follow-up sends; per-job usage where the vendor transport reports it.
- One descriptor-driven ACP daemon for Copilot and Google Antigravity.
- Install, completion-routing and Codex-upgrade reliability fixes; quoted
  hook paths for both hosts so plugin directories containing spaces work.

The reviewer-profile experiment closed below its adoption threshold; see
MVP_TRACKER item 9. Its local profile was retired. All four companion adapters
remain supported. Further expansion requires a recurring unmet workflow.

### Fresh validation (2026-10-09; automated checks refreshed 2026-10-12)

| Check | Result |
| --- | --- |
| Root-discovered tests with coverage, Node 24.18.0 | PASS — 703/703, no skips |
| Same suite on CI's Node major, Node 22.23.3 | PASS — 703/703, no skips |
| Shell syntax, JavaScript syntax, `git diff --check` | PASS |
| Production dependency audit at moderate or higher | PASS — zero vulnerabilities |
| Claude plugin validation, Claude Code 2.1.296 | PASS — one advisory that root CLAUDE.md is repository context, not plugin context |
| Codex marketplace build/install validation, Codex CLI 0.162.1 | PASS — isolated install reports version 0.1.0 and the declared MCP transport |
| Doctor on both live host configurations | PASS — default target Codex, no authored reviewer profile or stale broker |
| GitHub CI for the final candidate head | Required before a tag — [release PR checks](https://github.com/thangaram611/agent-companion/pull/12/checks): install, syntax, tests with coverage and dependency audit on Ubuntu/Node 22 |

The initial suite reproduced three failures from a 0.154.0 wire pin against
Codex 0.162.0. Regeneration found no routing moves: one removed unused request
(`thread/rollback`), eleven additions and nine shape changes. The named global
notification assertion and agent-message phase assertion were reconciled;
tests now prove `partial_answer` does not replace a final answer in live or
salvaged output. The adapter's requests and turn-control ids are unchanged.

Both hook manifests initially failed from a plugin directory containing spaces
(exit 127). Quoting the script paths fixes all twelve commands; the regression
executes their real command strings against inert scripts on both hosts.

The audited lockfile packages are now SDK 1.32.1, fast-uri 3.1.8, hono 4.13.13,
ip-address 10.7.3 and proxy-addr 2.0.8. `bridge-server/package.json` is unchanged.

The live Copilot gate reproduced missing usage on CLI 1.0.94. Both the default
exporter configuration and an explicit `COPILOT_OTEL_EXPORTER_TYPE=file` run
produced no OTEL file. A direct native ACP turn instead returned token, cache
and thought counters on `session/prompt`; the old descriptor discarded them.
The reader now prefers that response (`source: copilot-acp`) and retains the
older OTEL fallback. It invents neither model nor cost. The captured response
failed the terminal-summary regression before the repair and passes afterward;
the older OTEL regressions remain green.

### Manual gates for this candidate

| Gate | Result |
| --- | --- |
| 1 — Claude source install | PASS — isolated home, `--target none --skip-tests`; full suite checked separately |
| 2 — Codex source install | PASS — isolated home, `--target none --skip-tests`; materialized role and accepted MCP transport |
| 3 — OpenCode delegated send | PASS — CLI 2.0.25 on 2026-10-12; isolated default-target onboarding, native smoke reply, a real README read and terminal digest, 4/4 |
| 4 — Copilot delegated send | PASS — CLI 1.0.95 on 2026-10-12; isolated default-target onboarding and a real README read |
| 5 — Codex marketplace install | PASS — isolated release validator |
| 6 — Claude marketplace install | PASS — isolated home, installed version 0.1.0 |
| 7 — Codex exec delegated send with network | PASS — CLI 0.162.0; default-target onboarding, exec smoke 13/13, real `curl https://example.com` wrote `200` to NETCHECK.txt |
| 8 — Codex app-server restart/control/review smokes | PASS — CLI 0.162.0; restart 17/17, control 18/18, review loop 16/16 |
| 9 — Antigravity smoke and Copilot shared-daemon send | PASS — Antigravity ACP server 1.1.1: 24/24 on 2026-10-09; Copilot CLI 1.0.95: 11/11 on 2026-10-12, including recorded native critic execution and native usage |
| 10 — OpenCode 2.x HTTP server | PASS — 2.0.25 with the existing Ollama Cloud pin: send 4/4, reply/cancel/recovery 9/9, live streaming/idle reaper 3/3 |

The user approved the real turns and the newly reproduced Copilot and OpenCode repairs.
Probe state and runtime sockets used separate private directories; native
clients retained their existing logins and normal vendor session histories.
Temporary copies of the existing probes changed only state/runtime lookup
paths. The exec probe's unconditional `|| true` digest assertion was removed
in its temporary copy, and the resulting strict assertion passed. The checked-in
probe is unchanged; hardening that assertion is a follow-up.

All probe-owned brokers and ACP daemons were stopped, their sockets removed,
and their pids verified exited. The live harness did not edit installed host
config, authored profiles, the real default target or quarantine attributes.

The 2026-10-09 Copilot 1.0.94 checks exposed a false success footer: the native
`rubber-duck` agent was unavailable, another reviewer ran, and the model still
emitted `RUBBER-DUCK: clean`. The captured response reproduced `clean` before
the repair; it now yields `unverified` in both wait content and queued
notification metadata/content. The user authorized this repair as the next
item. A success marker now requires a recorded completed call whose
`agent_type` is `rubber-duck`. An explicit `unavailable` marker takes
precedence over other verdicts, including concatenated fleet output. The
prompt forbids substituting another critic when the native one is unavailable.
The task answer remains intact and its completed status is preserved.

On 2026-10-12, Copilot 1.0.95 completed a real native critic call, and both the
footer and notification reported `clean`; native ACP usage remained present.
Tests also cover unavailable, failed and unrecorded critic calls, and ensure
relay-only companions never receive this footer. This verifies invocation,
not critique quality or the critic's chosen model. No account settings or
installed plugin files were changed by the repair.

OpenCode 2.0.25 initially failed before inference with `Unrecognized flag:
--dir`. The CLI command builder now preserves 1.x arguments and selects
`--standalone` for 2.x; permission auto-approval remains opt-in and maps to
`--auto` on 2.x. Onboarding reuses this runtime and requires an assistant
`ready` reply; tool-only output fails the smoke and returns exit 3. Readiness
checks v2's native provider connections instead of its empty model list, and
legacy profile pins stay unverified rather than falsely rejected.

The first repaired live run still read the bridge repository instead of the
requested cwd. Setting both the child's OS working directory and `PWD` fixed
the v2 legacy-provider tool runtime. The rerun read the isolated README's
unprompted `PAPAYA` with one native `read` call and emitted native step usage
(8,004 input, 69 output, 64 cached input, $0.001242896). The job's child exited;
the user's existing background service was untouched. The run used the
existing `ollama-cloud/gpt-oss:120b` pin only in its private test environment.
Regression tests cover the flags, both cwd values, readiness metadata and
smoke failure. These checks qualify the default CLI adapter.

The user included the 2.x HTTP migration in this candidate and approved its live
checks. The existing server adapter now supports both contracts. It captures the
native v2 bootstrap password, retains it in the 0600 lease registry for bridge
replacement and excludes it from status and job/digest data. V2 session creation
uses `location`, model selection uses native refs, prompts are durably admitted,
and cancellation uses `interrupt`, requiring its native `interrupted` confirmation.
Its global SSE stream is filtered by session;
the paginated current-turn transcript restores tool steps and usage missed by a
bridge outage and requires a native idle outcome. The v2 idle reaper checks the
authenticated native pid and reconfirms its disposal claim before SIGTERM.

Captured native wire regressions initially failed on authentication, request
shapes, events and transcript pages. The final live controls used distinct
threads and waited for a native running shell tool before reply, cancel or
SIGKILL. Private project instructions required the pause, and an explicit
permission rule allowed the test's `sleep` shell command. Early harness attempts reused an
implicit thread or relied on model prose for timing and do not qualify the
candidate. The corrected run proved two working directories on one server,
reply, cancellation, in-flight bridge recovery and completed transcript recovery
after server replacement. A separate native run published 14 partial snapshots,
preserved final usage and stopped its owned server through the idle reaper.
All probe-owned processes exited; the existing native background service and
account configuration were untouched.

One Node 24 suite stalled in the Codex broker tests while both Node suites ran
concurrently. That run was stopped; the broker recheck passed 46/46, and a
subsequent full Node 24 run passed 695/695. No broker code was changed. Both
final full-suite logs and the recheck are retained with the candidate evidence.

Historical smoke evidence below belongs to its dated binary versions and does
not certify this candidate. A public tag still requires all manual gates and
fresh CI on the candidate commit.

Candidate archives are prepared locally under `dist/release-0.1.0/`: a source
ZIP for the Claude/source install path and a Codex marketplace tarball. This
ignored directory also holds the test/install logs and SHA-256 checksums.

## Public Positioning

Slogan:

> Come with any harness and attach any companion of your choice to it.

Current vocabulary:

| Product term | Current implementation term | Supported now |
| --- | --- | --- |
| Harness | `host` | Claude Code, Codex CLI |
| Companion | `target` | OpenCode (`cli`/`server`), GitHub Copilot CLI, Codex CLI (`exec`/`appserver`), Google Antigravity |
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
  path. It retains `--dir` on 1.x and uses a private `--standalone` server on
  2.x, with both OS cwd and `PWD` set to the requested directory. The v2 CLI
  documents `--format`, `--model` and `--standalone`:
  <https://dev.opencode.ai/v2/docs/cli/commands/>.
- The `server` adapter (`OPENCODE_RUNTIME_ADAPTER=server`) drives `opencode serve`
  over HTTP for reply/resume/streamed digests. Verified against the live server
  API (opencode 1.17.9): `POST /session?directory=<cwd>` roots a session at a cwd,
  `POST /session/{id}/prompt_async` runs it, `POST /session/{id}/abort` cancels,
  the directory-scoped `GET /event?directory=<cwd>` SSE stream carries
  `message.part.updated` + a terminal `session.idle`, and `GET /session/status`
  reports per-session busy/idle. One detached server is shared and reused across
  restarts. The same adapter supports 2.x's authenticated `/api` contract:
  session `location`, native model refs, `prompt`/`interrupt`, the global
  session-filtered event stream, active-session status and projected message
  pages. Both the CLI and server paths passed real 2.0.25 qualification:
  <https://dev.opencode.ai/v2/docs/api>. These contracts intentionally differ:
  <https://dev.opencode.ai/v2/docs/migrate-v1/>.
- On 1.x, `opencode models` lists provider/model pins. On 2.0.25 this machine's
  catalog omitted a callable legacy pin, so readiness uses
  `opencode auth list --standalone --format json` and model validation remains
  `unknown` until a real run. Native provider connections establish local
  configuration, not provider availability or quota.
- OpenCode also documents `opencode acp` for ACP-compatible editors:
  <https://opencode.ai/docs/acp/>. The adapter set is `cli` and `server`, and
  the server adapter already covers reply/resume, so an ACP stdio adapter stays
  deferred — it is the one item on this page with no code behind it.
- OpenCode permissions are configured as `allow`, `ask`, or `deny`; the `cli`
  adapter exposes opt-in `--dangerously-skip-permissions` on 1.x or `--auto`
  on 2.x, while the `server`
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

On the audit gate: the advisories measured on 2026-08-28 came in through
`@modelcontextprotocol/sdk`'s HTTP-transport dependencies (`hono`, `express`,
`ajv`, `express-rate-limit`), which a stdio-only server never loads. Measured
2026-08-28 on five advisories: bumping the SDK cleared none of them, because
the patched versions already sat inside the ranges the SDK declares — only the
lockfile was stale. The fix for that class is `npm update <the transitives>`
in `bridge-server/` with `package.json` untouched, rather than an SDK bump or an
`overrides` block; upstream (modelcontextprotocol/typescript-sdk#2042) reached
the same conclusion. Gate re-verified clean that day. This rule is specific to
that transitive-dependency case: the 2026-10-09 audit also flags the SDK itself
([GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h), patched
in 1.31.0). The advisory explicitly excludes MCP servers and stdio clients;
this bridge imports the stdio server, not the affected OAuth client. Release
preparation still updates the SDK and affected transitives within existing
manifest ranges to satisfy the audit gate, with no new override or API change.

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
9. `node probes/smoke/acp-antigravity.mjs` — Google's Antigravity ACP server on
   the generic daemon: send, thread continuity on one ACP session, reply as
   cancel + re-prompt, cancel, restart survival across a bridge SIGKILL, and a
   model pin reaching the session; needs the server installed and signed in
   (`scripts/install-antigravity-acp.mjs --login`) and spends real turns. Plus
   one real Copilot send through the bridge after any change to
   `scripts/acp-daemon.mjs` (Copilot rides the same daemon), checking the
   spawn argv in `copilot-acp-daemon.log`, the rubber-duck footer, native ACP
   `meta.usage` on CLI 1.0.94 (OTEL on older CLIs) and the
   `acp_daemons.copilot` registry entry on `agent_status`.
   Recorded 2026-09-11 on Copilot CLI 1.0.83: job `copilot-mtwil1g9-e4si`
   completed in 33 s with the identical argv, `RUBBER-DUCK: clean`, usage
   `source: copilot-otel` (cost 3 premium requests), daemon pid recorded.

### Smoke evidence

Recorded 2026-06-23 (macOS, Node 24.15.0), extended 2026-07-24 for gate 7,
2026-08-11 for gate 8 and 2026-09-11 for gate 9 (Antigravity:
`acp-antigravity.mjs` 24/24 on agy_acp_server 1.1.1 plus Copilot job
`copilot-mtwm2l8q-uqhz` on Copilot CLI 1.0.83), and re-verified on the live
hosts 2026-09-03 with Claude Code 2.1.259 and codex-cli 0.152.1. All nine
gates passed on those dated versions; fresh v0.1.0 checks are tracked above.
The original
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
