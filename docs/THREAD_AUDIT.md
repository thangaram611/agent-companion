# Code and test layout before the thread redesign

Written before the 1.0.0 vocabulary: tools `agent_*` are now `companion_*`, and `target` is `companion`; see docs/VOCABULARY_PLAN.md.

Audit taken 2026-11-22 from the tracked files on main, read-only, before any
redesign work. It is the evidence for the Structure and Tests sections of
[THREAD_PLAN.md](THREAD_PLAN.md). Line counts are `wc -l`. "Test-only" means no
importer outside tests and test fixtures. "Candidate" marks the auditor's
opinion; the plan says which candidates are taken.

## 1. Size map

| Area (by location) | Source lines / files | Test lines / files | Test ÷ source |
|---|---|---|---|
| bridge-server/ root files | 1132 / 4 | 1526 / 5 | 1.35 |
| bridge-server/adapters | 2189 / 8 | 3291 / 11 | 1.50 |
| bridge-server/controller | 1056 / 4 | 0 here; 1314 in test/controller | 1.24 counted with its tests |
| bridge-server/ui | 1761 / 8 | 1439 / 7 | 0.82 |
| lib/ root | 3913 / 19 (plus a 2370-line contract JSON) | 3254 / 15 | 0.83 |
| lib/transcripts | 406 / 7 | 0 here; 631 in test/transcripts.test.mjs | 1.05 (with lib/transcripts.mjs) |
| hooks/ | 1687 / 12 (9 shell scripts = 1097, mod.ts 568) | 2643 / 9 (876 of them .ts) | 1.57 |
| scripts/ | 1409 / 9 (no shell scripts) | 1795 / 8 | 1.27; 0.77 without the setup.sh test |
| templates/ | 459 lines of md/toml | 534 / 3 | 1.16 |
| test/ | 1687 lines of helpers / 16 files | 2655 / 12 | n/a |
| probes/ | 3301 / 29 (+1265 md) | 208, in test/ | 0.06 |
| setup.sh (the only root script) | 642 | 713 (scripts/setup-codex-install.test.mjs) | 1.11 |

- **Totals:** 14,195 lines of production source against 17,137 test lines in 70 files, a ratio of 1.21. With the test helpers it is 1.33.
- **Fixtures:** test/fixtures holds 475 KB.
- **Docs:** about 4,900 lines across README, CLAUDE.md and docs/.

**15 largest source files (lines):**
- `lib/codex-app-server-contract.mjs` 1114
- `bridge-server/server.mjs` 864
- `setup.sh` 642
- `bridge-server/controller/controller.mjs` 594
- `hooks/mod.ts` 568
- `bridge-server/ui/model.mjs` 533
- `lib/target-registry.mjs` 467
- `lib/state.mjs` 437
- `lib/codex-install.mjs` 431
- `bridge-server/ui/rows.mjs` 409
- `bridge-server/adapters/acp-protocol.mjs` 406
- `bridge-server/adapters/codex.mjs` 384
- `scripts/onboard.mjs` 361
- `bridge-server/adapters/acp.mjs` 354
- `hooks/install-deps.sh` 341

**15 largest test files (lines; top-level `test(` calls, with loop-generated or nested calls in brackets):**
- `bridge-server/server.test.mjs` 1124; 35 (+5)
- `bridge-server/adapters/acp.test.mjs` 955; 42 (+20)
- `lib/codex-app-server-contract.test.mjs` 926; 37
- `scripts/setup-codex-install.test.mjs` 713; 15
- `hooks/pane.test.ts` 704; 25
- `test/transcripts.test.mjs` 631; 25 (+8)
- `hooks/install-deps.test.mjs` 599; 19 (+1)
- `bridge-server/adapters/codex.test.mjs` 579; 23 (+5)
- `lib/target-diagnostics.test.mjs` 534; 35
- `bridge-server/ui/ui.test.mjs` 529; 28 (+1)
- `hooks/drain-completions.test.mjs` 528; 16
- `test/controller/controller.test.mjs` 505; 33 (+3)
- `bridge-server/adapters/opencode.test.mjs` 473; 15 (+11)
- `test/controller/interventions.test.mjs` 418; 21 (+6)
- `bridge-server/adapters/claude.test.mjs` 397; 18 (+6)

## 2. Test shape (12 largest files)

"Prose" counts tests that match sentences or file text with a multi-word pattern.

- **server.test.mjs** (36 test bodies):
  - Drives the exported `dispatch` and the MCP handlers with an in-file fake adapter (`wireFixture`, lines 233–266) and real Records.
  - Also runs the fake codex app-server (637), the fake Claude stream (891), the real `drain-completions.sh` (around 430–503) and a cleanup-watcher child built from a code string (675–677).
  - Imports appear mid-file at 228–232, 719 and 874, so the file is several suites concatenated.
  - Prose: 4.
- **acp.test.mjs** (54): Controller plus the real AcpAdapter against a spawned fake ACP agent with a frame trace (`setup`, lines 103–139). It also imports `dispatch` (16). Prose: 4.
- **codex-app-server-contract.test.mjs** (37):
  - Unit tests of the contract module and its JSON.
  - One drift test spawns the installed codex and is skipped if it is absent (883).
  - Prose: 5 tests check exact message wording (626 "word for word", 718, 744, 814, 836).
- **setup-codex-install.test.mjs** (15):
  - Copies the source tree and runs the real `setup.sh` 23 times against a fake toolchain written in the file (61–103).
  - Prose: 8 tests match stdout sentences.
  - Line 710 is `bash -n setup.sh`.
- **pane.test.ts** (25): uses the `claude-code/testing` kit with an in-file engine mock (36–73) and child mock (79–100). 11 tests compare the whole drawn pane as exact text. CI does not run it.
- **transcripts.test.mjs** (25): reader tests over checked-in native fixtures. One test (573) also drives `ui/follow.mjs`, `rows.mjs` and the digest. Prose: 3.
- **install-deps.test.mjs** (19):
  - Spawns the real script with a stub npm, real locks, signals and sleeps.
  - Line 80 reads the script's own text (`HOOK_TIMEOUT_SEC`) and compares it with both hook manifests.
  - Prose: 7.
- **codex.test.mjs** (26): Controller plus the real CodexAdapter against a fake app-server whose frames are checked against the pinned contract. Prose: 1.
- **target-diagnostics.test.mjs** (35): unit tests with an injected `run`, plus a real `probeCommand` against `sleep 30` and a process that ignores signals. Prose: 4.
- **ui.test.mjs** (28): Ink renders over `test/ui-fixture.mjs`. 3 tests use snapshots (a 253-line `.snapshot`, 9 entries) and 18 match the rendered frame text with regexes.
- **drain-completions.test.mjs** (16): 15 tests spawn the real hook on synthetic queue rows. Prose: 4. Its fixtures include `kind:'alert'` rows, which nothing in production writes.
- **controller.test.mjs** (34): Controller with an in-file fake adapter (11–50) and a manual clock. Pure behaviour, no prose.
- **For comparison, the template tests:**
  - `agent-companion.md.test.mjs`: prose in 10 of 10 tests.
  - `agent-companion.toml.test.mjs`: 12 of 12.
  - `host-parity.test.mjs`: 6 of 10.

**Shared helpers (number of importing files):**
- `test/sandbox-home.mjs` 48
- `test/controller/helpers.mjs` 16
- `fixture-table.mjs` 9
- `fake-codex-app-server.mjs` 6
- `codex-wire-frames.mjs` 5
- `ui-fixture.mjs` 4
- `fake-acp-agent.mjs` 3
- `fake-claude-stream.mjs` 2
- `adapters/fake-opencode.mjs` 2
- `codex-dispatch-fixture.mjs` 2

There are also six separate inline fake adapters: `server.test:240`, `controller.test:24`, `interventions.test:20`, `cleanup-watcher.test:27`, `lib/controller-work-summary.test:26`, `scripts/onboard-smoke.test:14`. Across 10 test files there are 19 `new Controller(` calls.

**Same behaviour pinned in more than one file:**
- A status-only second bridge: `test/incident-regressions.test.mjs:98` ↔ `test/controller/controller.test.mjs:171` (and `server.test.mjs:620` ↔ `controller.test.mjs:348`).
- A duplicate send reattaches: `incident-regressions:180` ↔ `controller.test:93` ↔ `server.test:373`.
- `willRetry` stays progress: `incident-regressions:75` ↔ `adapters/codex.test:229` ↔ `controller.test:257`.
- One immutable terminal result: `incident-regressions:135` ↔ `controller.test:224`.
- Owner and drain receipt race: `server.test:557` (spawns the drain) ↔ `hooks/drain-completions.test:132,147`.
- Template sentences: md.test ↔ toml.test, line by line (md 43–47 ↔ toml 48–52; md 59 ↔ toml 64; md 102 ↔ toml 85), and again in `host-parity:87,120,123`.
- The 1320 s MCP timeout: `md.test:94` ↔ `host-parity:75`; also asserted in `setup.sh:498` and `validate-codex-release.mjs:113,216`.
- Hook manifests: `install-deps.test:80` (timeouts) ↔ `hooks.test.mjs:16` (commands) ↔ `host-parity:99` (onFailure).
- The six tool names: `server.test:272` ↔ `host-parity:81` ↔ `md.test:63` ↔ `toml.test:132` ↔ `install-agent.test:130`.
- Claude permission resolver: `claude-protocol.test:30` ↔ `target-diagnostics.test:26,494,525`.
- Codex `CODEX_HOME` agent directory: `install-agent.test:141` ↔ `setup-codex-install.test:274`.
- Steps CI already runs: `setup-codex-install.test:710` (`bash -n`) ↔ the CI "Shell syntax" step; `:388` (test discovery) ↔ the CI test step.

**What CI runs** (`.github/workflows/ci.yml`; there are no package.json scripts):
- `npm ci`, then `bash -n setup.sh hooks/*.sh`.
- `node --check` on every `.mjs` file.
- Then `find . -name '*.test.mjs' … | xargs -0 node --test --experimental-test-coverage`.
- Then `npm audit`.
- `*.test.ts` is never run in CI. `setup.sh` repeats the syntax and test steps itself (566–622).

**Known slow or flaky tests:**
- `bridge-server/adapters/acp-replay.test.mjs`, "recorded Copilot wire: cancel", hangs to its 15 s timeout when run alone and timed out once in a full run (`docs/LIVE_VIEW_PLAN.md:498-500`; commit b7e8ef5).
- `bridge-server/ui/perf.test.mjs` has a 300 s timeout and runs to 10,000 items. Fixed millisecond budgets failed on GitHub runners (361acc8).
- The drain kill tests raced a fixed 1.2 s timer (fixed in 96fc839). They still sleep for real (`DEBUG_DRAIN_DELAY` 1.5 s, 5 s; `server.test:559` 1 s).
- `install-deps.test` waits on real locks for 1–3 s at lines 140, 211, 226, 240 and 244.
- Per-test timeouts: `server.test:637` 30 s, `:185` 15 s; three tests in `pane.test.ts` 30 s; `opencode.test:95` waits up to 100 s.
- The last full-suite timing on disk is old: 685 tests, 38 s, on 9 Oct (`dist/release-0.1.0/baseline-tests.log:711-718`, untracked).

## 3. Code that exists once per host

- **Role templates:** `templates/agent-companion.md` (222) vs `.toml` (237).
  - About 168 lines are identical; a diff shows 54 lines only in .md and 69 only in .toml.
  - What really differs: the frontmatter or `description`, the spawn and follow-up wording, tool spelling (`mcp__agent-bridge__` vs `mcp__agent_bridge__`), one paragraph on thread continuity and one on `functions.exec`.
- **Template tests:** `md.test` (178, 10 tests) and `toml.test` (185, 12 tests) mirror each other. `host-parity.test` (171) repeats parts of both.
- **Hook manifests:** `hooks/hooks.json` (84) vs `hooks-codex.json` (59).
  - The same four events and timeouts (5 s, 55 s).
  - Claude adds a PreToolUse group (`name-thread.sh`, TaskStop) and `modules`. Codex prefixes `AGENT_COMPANION_HOST=codex` and uses `${PLUGIN_ROOT}`.
  - A third copy of the hook list is built in `scripts/install-codex-hooks.mjs:145-172`.
- **Agent installers:** `hooks/install-agent.sh` (76) vs `install-agent-codex.sh` (74).
  - 39 and 37 lines differ, mostly comments. Each has about 30 lines of logic with the same skeleton.
  - The differences are the destination, where the sentinel goes (line 2 via awk vs line 1) and Claude's namespacing sed (`install-agent.sh:56-59`).
  - `setup.sh:511-525` repeats the Codex render to verify it.
- **Plugin manifests:** `.claude-plugin/plugin.json` (34) vs `.codex-plugin/plugin.json` (59).
  - About 24 metadata lines are shared.
  - Different: the `mcpServers` block (`timeout` 1320000 ms vs `tool_timeout_sec` 1320 plus `startup_timeout_sec` 120, `cwd`, approval mode), a hooks pointer, and a Codex-only `interface` block of 22 lines.
  - Both descriptions still list only four companions; Claude Code is missing.
- **setup.sh paths:** the Claude install block is 394–430 (37 lines) and the Codex block is 432–564 (133 lines). Surface checks are at 220–237.
  - The Codex MCP registration shape is asserted in four places: the manifest, `setup.sh:488-500` (jq), `scripts/validate-codex-release.mjs:110-115,208-217`, and `host-parity:75`.
- **State directory:** the rule lives in `lib/host.mjs:43-57` and is copied elsewhere.
  - `${CODEX_HOME:-$HOME/.codex}` is re-implemented at `drain-completions.sh:26-31`, `install-agent-codex.sh:39`, `setup.sh:301,443`, `install-codex-hooks.mjs:44-47`, `ui/jobs.mjs:121`, `lib/transcripts.mjs:35` and `lib/codex-install.mjs:368`.
  - Claude's state directory is hard-coded at `hooks/mod.ts:134-137`.
  - The Codex plugin-data path appears three times: `install-deps.sh:43`, `launch-agent-bridge.sh:17-18`, `launch-ui.sh:35`.
- **Session id:** on Codex it comes from `_meta` and is adopted at `server.mjs:768`. On Claude it is the `CLAUDE_CODE_SESSION_ID` environment variable (`server.mjs:99-101`).
- **Owner/thread:** Claude rewrites it through the `name-thread.sh` hook (30 lines). Codex reads `_meta.thread_id` (`server.mjs:752-755`).
- **Tool-name namespacing:** Claude's names are spelled out in four places: `install-agent.sh:58`, `hooks.json:6`, `install-permissions.mjs:36-43` and `mod.ts:52`. Codex's role uses normalized names, checked at `validate-codex-release.mjs:121-122`.
- **Default host:** `launch-agent-bridge.sh:15` defaults the host to `codex`, while `lib/host.mjs:24`, `drain-completions.sh:26` and `install-deps.sh:42` default to `claude`.
- **Host-only code:**
  - Claude only: `mod.ts` (568 lines plus 876 test lines), `name-thread.sh`, and `install-permissions.mjs` (its Codex branch at 62–68 is a no-op).
  - Codex only: `build-codex-marketplace.mjs` (148), `validate-codex-release.mjs` (239), `install-codex-hooks.mjs` (283), and `hooks/launch-agent-bridge.mjs` plus `resolve-codex-deps.mjs` (22).

**Every `if` on the host name:**
- `bridge-server/server.mjs:753`
- `bridge-server/ui/jobs.mjs:170`
- `lib/host.mjs:44,103`
- `scripts/install-permissions.mjs:51,65`
- `hooks/drain-completions.sh:28`
- `hooks/install-deps.sh:42,224,297`
- `hooks/launch-agent-bridge.sh:16,68`
- `setup.sh:101-103` (case), `134`, `138`, `182`, `191`, `220`, `228`, `267` (case), `300`, `314`, `315`, `396`, `440`, `636` (case)
- Host-keyed data without an `if`: `ui/model.mjs:18` (`HOSTS`), `ui/jobs.mjs:119-174` (caller titles per host).

## 4. Shell scripts with embedded logic

There are no shell scripts under `scripts/`.

- **`hooks/drain-completions.sh`** (320): delivers finished jobs into the session.
  - Inline jq at 132, 260–282 (sorting rows), 289, 297–306 (writing the injected markdown) and 313.
  - Lines 45–61 repeat `lib/host.mjs:79-90` in shell, and 26–31 repeat `companionHomeDir` and `runtimeDir`.
  - The Node side writes the same queue and receipts in `server.mjs:61-87,137-153,323-347`.
  - **The fork budget (63–74):** the hook fires after every tool call and the queue is empty in over 99% of fires. Each fork+exec cost about 12–17 ms with an endpoint-security extension, and the old empty-queue path cost about 113 ms (13 processes). The stated constraint: **the empty-queue path must spawn nothing**, and jq or any other binary is deferred until there is real work.
- **`hooks/install-deps.sh`** (341): npm install with an mkdir lock, a hash check, and the Claude link or Codex plugin-data location. No inline Node or jq. `setup.sh:333-352` installs dependencies again without the lock. The launcher calls this script up to twice.
- **`hooks/node-tools.sh`** (99): finds Node and npm. It has one inline `node -e` (line 12). `install-codex-hooks.mjs:93-121` and `drain-completions.sh:98-108` repeat the binary lookup.
- **`hooks/install-agent.sh`** (76) and **`install-agent-codex.sh`** (74): render the role template using awk and sed (56–59), no Node. `setup.sh:511-525` repeats the Codex render.
- **`hooks/launch-agent-bridge.sh`** (72): the MCP launcher, with per-host branches. No inline code. `launch-ui.sh:35-38` repeats its plugin-data path.
- **`hooks/launch-ui.sh`** (40): dispatches to the UI entry points. No inline code.
- **`hooks/name-thread.sh`** (30): inline Node at 26–30. Its counterpart is the Codex owner path in `server.mjs` `callArgs` (745–772).
- **`hooks/stop-owner.sh`** (45): writes stop markers with 30 lines of inline Node ESM (16–45) that import `lib/host.mjs`. `records.mjs:149-156` reads those files, and `lib/runtime-paths.mjs` `writePrivateFileAtomic` (35–48) already does the same atomic write.
- **`setup.sh`** (642): about 15 inline jq calls (263–298, 476–477, 488–500, 634–638), no inline Node. It overlaps with `onboard.mjs`, `validate-codex-release.mjs:208-217`, `install-deps.sh` and CI (566–622).

## 5. Module boundaries

- **`bridge-server/server.mjs`:**
  - 61–87 and 137–153: queue file move-aside and marking rows consumed
  - 89–135: host session id
  - 155–160: wait clamp
  - 161–211: routing and effort refusals
  - 212–275: digest resources
  - 277–296: envelopes
  - 298–358: terminal envelope, result publication, receipt claim
  - 360–380: provider table and recovery
  - 381–427: send, wait, cancel and reply handlers
  - 428–487: catalog (including a per-companion `nativeDefaults` map)
  - 489–520: status projection
  - 522–540: startup migrations
  - 541–570: MCP server and instructions
  - 572–723: tool schemas
  - 726–791: `callArgs` owner attribution
  - 793–821: dispatch and error mapping
  - 823–864: bridge-loss handoff
- **`controller/controller.mjs`:**
  - 44–92: owner requests and attachment
  - 93–137: send, with legacy history read at 115
  - 138–231: the native turn loop
  - 232–286: delivery and turn records
  - 287–322: stop markers and inbox tick
  - 323–358: close and abandon
  - 359–384: worktree snapshot and work summary
  - 385–424: finish (result builder #1)
  - 425–461: wait and user notices
  - 462–513: intervene and the `steer` alias
  - 514–523: cancel
  - 524–542: status
  - 543–565: recover (result builder #2)
  - 566–594: `bridgeLost`
- **`controller/records.mjs`:** 8–37 result projections; 43–56 readers; 57–118 inbox; 125–148 legacy history; 149–156 stop marker read; 157–183 locks and fencing; 184–236 writers; 237–244 handoff.
- **`lib/state.mjs`:** 1–52 `BASE_DIR` and file I/O; 53–198 `settings.json`; 199–248 migration of old per-host defaults; 250–259 per-companion model rules; 261–317 legacy threads; 319–397 phase-1 migration; 399–406 target checks; 408–437 legacy jobs.
- **`lib/host.mjs`:** 18–41 host detection; 43–63 directories and `stateDirs`; 65–90 sandbox guard; 92–105 `agentsDir` (test-only) and `settingsFile`.
- **`lib/target-registry.mjs`:** 23–58 permission and auth probes; 60–422 five descriptors (opencode 61, copilot 116, codex 210, claude 294, antigravity 342), which mix capabilities, onboarding, ACP permission answers, usage and antigravity end-of-turn logic; 424–467 lookups.
- **`ui/model.mjs`:** 33–110 state and polling; 111–149 the selected job's transcript; 150–190 layout and scroll; 191–249 keys; 250–315 message box; 316–438 frame drawing; 439–533 defaults panel.
- **`ui/rows.mjs`:** 1–54 cleaning text and widths; 55–112 wrapping; 113–199 transcript items; 200–266 cards and outcome; 267–308 live and pending lines; 309–354 `jobBlocks`; 361–404 Pane cache; 405–409 the `COMPANION_NAMES` and mode tables.
- **`hooks/mod.ts`:** 1–105 state; 106–133 sending via `launch-ui.sh send`; 134–145 reading records through `$.fs`; 146–227 clock and agent row; 228–275 view and pane open/close; 276–310 list rebuild; 311–359 follow child; 360–399 cards; 400–568 hook registrations (the Pane render alone is 455–554).

**Imports that cross layers in a surprising direction:**
- **Controller → scripts → controller:** `controller.mjs:9` imports `scripts/cleanup-watcher.mjs`, which imports back into `controller/{records,process-supervisor,clock}.mjs` (`cleanup-watcher.mjs:4-6`), so the two directories depend on each other.
- **UI → adapters and controller:** `ui/defaults.mjs:10-14` imports `adapters/codex.mjs`, `adapters/opencode.mjs`, `process-supervisor`, `clock` and `last-runs`. `ui/follow.mjs:8-9` and `ui/jobs.mjs:11-12` import `controller/records.mjs` and `pidAlive`.
- **Hooks → UI:** `hooks/mod.ts:3-5` imports `bridge-server/ui/rows.mjs` (CLAUDE.md documents this as deliberate). `hooks/stop-owner.sh:31` imports `lib/host.mjs`.
- **Scripts → controller and adapters:** `scripts/onboard.mjs:37-42`, which also repeats the provider table (`onboard.mjs:172-174` vs `server.mjs:363-364`).
- **Registry → transcript reader:** `lib/target-registry.mjs:21` imports `lib/transcripts/antigravity.mjs`.
- **lib/ tests that test bridge-server:** `lib/migration.test.mjs:8` and `lib/controller-work-summary.test.mjs:7-9`. Separately, `test/transcripts.test.mjs:574-576` imports `ui/follow` and `ui/rows`.
- No production file in `lib/` imports from `bridge-server/`.

## 6. Dead or legacy weight

**Exports with no importer at all:**
- `lib/text-utils.mjs:11-15` (`appendCapped`)
- `lib/target-registry.mjs:444-447` (`isTargetAllowed`)

**Test-only exports:**
- `lib/state.mjs` thread and job helpers (261–317, 408–437; about 87 lines).
- `lib/runtime-paths.mjs:79-102`: the heartbeat and prompt path helpers (about 19 lines), tested at `runtime-paths.test:26-34`.
- `lib/usage.mjs:158-172` (`usageFromCodexExecUsage`, for the retired exec transport).
- `lib/host.mjs:92-96` (`agentsDir`).
- `Controller.steer` (`controller.mjs:510-513`), tested at `interventions.test:286-295` ("legacy reply entry").
- `lib/log.mjs` (92 lines, plus an 80-line test) has exactly one production call (`server.mjs:861`). `validation.mjs:32-54` is the logger actually used.

**Test support living in `lib/`:** in `lib/codex-app-server-contract.mjs`, the frame validators (340–656, about 316 lines), the message builders (213–265) and `routeRequest` (320–337) are used only by tests and the test fakes.

**Parameters that are validated but unused:**
- `agent_status.verbose`: declared at `server.mjs:680` and checked at `validation.mjs:66,162,167`, but never read.
- `agent_send.max_wait_sec`: declared at `server.mjs:650` and checked at `validation.mjs:64,181-183`, but `handleSend` (381–396) ignores it. Both templates and three template tests still mention it.
- `onboard.mjs --host`: checked at line 218 and echoed at 297 and 342, otherwise unused.

**Fields declared but never produced:**
- The output schema's `prompt_id`, `session_id` and `debug` (`server.mjs:603-606`).
- `session_reborn: false` (`server.mjs:401`) is a constant.
- `meta.debug_digest_path` appears in both templates (md:178, toml:191) and is pinned by md.test:77 and toml.test:76, but the server never emits it.

**Code kept for retired designs:**
- Phase-1 migration: `state.mjs:319-397` (79 lines), called from `server.mjs:536`.
- Per-host defaults migration: `state.mjs:199-248` (50), plus `ui/defaults.mjs:149-182` (conflict handling).
- Legacy history: `records.mjs:125-148` (24), used at `controller.mjs:115`.
- Tests that exist for it: `lib/migration.test.mjs` (191 lines, 9 tests), `server.test:602-619`, `controller.test:302-315`, and 4 tests in `defaults.test`.
- `drain-completions.sh`:
  - A heartbeat that its own comment calls historical (140–149); it is tested at drain test 346.
  - An `alert` 5-minute expiry branch (250–253, 264–267) for a row kind no code writes.
  - The owner-side `markQueueConsumed` for rows written without a receipt (`server.mjs:65-87,137-153`, about 40 lines).
- `install-codex-hooks.mjs` install mode (83–172 and 234–268, about 125 lines) and its tests (77–171): setup only uses `--uninstall` (`setup.sh:538`).
- `validate-codex-release.mjs:125-132` lists retired files.

**Stale comments:**
- `controller.mjs:27` refers to `PHASE3-SPEC.md`, which exists nowhere in the repo or its history.
- `validation.mjs:1,39` and `lib/log.mjs:4` say "v6.1".
- `codex-protocol.mjs:35` and `acp.mjs:68-70` describe retired transports.

## 7. What adding things touches today

**(a) A sixth companion.** Companion lists or name checks exist in:
- `target-registry.mjs:23` (plus a descriptor)
- `server.mjs:363-364,428-434,466,205`
- `onboard.mjs:172-174` (plus help text at 11, 198, 203, 272)
- `state.mjs:54-60,251-257`
- `lib/transcripts.mjs:30-54` plus a new reader
- `lib/usage.mjs`
- `lib/work-summary.mjs:5-17`
- `target-diagnostics.mjs:162,205,224`
- `ui/rows.mjs:407`
- `ui/defaults.mjs:17,46,94,118,122,161`
- `validation.mjs:59`
- `setup.sh:40,44,69-70,272`
- both templates, both manifests, README, CLAUDE.md, ARCHITECTURE

Tests touched include `server.test` (251, 373), conversation, routing, validation, state, target-diagnostics, onboard, setup-codex-install, the three template tests, transcripts and fixtures, and usage.

Last example: the Claude companion (7fd2c9e, 949d938, 5d10fe2, 4028148) touched 40 unique files (12 source, 19 test, 9 docs or probes), +1686/−116.

**(b) A new field in the send acknowledgement.** The value travels: adapter → `controller.mjs:157-174` → `records.begin` (184) → `server.mjs:393-395`.
- If status and the final result should carry it too: `server.mjs:500-509` and `307-313`, plus all three result builders (`controller.mjs:401-412`, `controller.mjs:553-560`, `cleanup-watcher.mjs:20-30`).
- Then both templates and their tests.

Last example: 37ffcb2 touched 31 files (11 source, 15 test, 5 docs), +491/−111.

**(c) A new MCP tool.**
- `server.mjs`: `TOOL_ACTIONS` 612, `AGENT_TOOLS` 624, `OWNER_ACTIONS` 744, the dispatch switch 799, the instructions text 545–556.
- `validation.mjs:58,62-69,124-131`.
- `hooks.json:6`, `install-permissions.mjs:36-43`, the md frontmatter tools list, the toml body.
- Tests: `server.test:272`, validation, md, toml, host-parity, install-agent, install-permissions.

No tool has been added since 1167e4b (46 files, +2515/−4564, mixed into a rewrite). The closest example, 61ee448 (agent_reply modes), touched 35 files (10 source, 17 test, 8 docs), +748/−187.

**(d) A third host.**
- `lib/host.mjs:18,43-49,62,102-105` and `server.mjs:99-101,752-755`.
- New hook manifest, installer, plugin manifest, template and template test.
- `drain-completions.sh:26-31`, `install-deps.sh:42,224,297`, `launch-agent-bridge.sh:15-22,68`, `launch-ui.sh:35`.
- `install-permissions.mjs:51,65`, `onboard.mjs:43`, `ui/jobs.mjs:119-174`, `ui/model.mjs:18`.
- `setup.sh`: 79–103, 134–139, 182–200, 209–237, 300–304, 394–564.
- `host-parity.test` compares exactly two roles. `hooks.test:12-15`'s host table and the assertion of at least two manifests at `install-deps.test:89` would also change.

Last example: e93b750 (adding Codex as a host) touched 23 files (13 source, 8 test, 2 docs), +3093/−255.

## Candidates

1. Merge the md, toml and host-parity template tests into one table-driven test that checks only structure (headings, tool list, refusal codes): about 534 → 150 lines, 3 files → 1.
2. Render both role templates from one shared body, with per-host frontmatter and tool-name substitution: about 170 duplicated lines removed.
3. Delete the phase-1 and per-host defaults migrations, legacy threads, jobs and history, and `AMBIGUOUS_HISTORY` after one release on `settings.json`: about 240 source lines plus about 250 test lines.
4. Drop the install mode of `install-codex-hooks.mjs` (or fold `--uninstall` into setup): about 125 source plus about 95 test lines.
5. Remove the dead helpers: `lib/log.mjs` (route its single event through the existing logger), the runtime-paths heartbeat and prompt helpers, `usageFromCodexExecUsage`, `appendCapped`, `isTargetAllowed`, `agentsDir`, `Controller.steer`: about 150 source plus about 110 test lines, 2 files.
6. Remove the unused inputs and fields: `verbose`, send `max_wait_sec`, `prompt_id`/`session_id`/`debug`, `session_reborn`, `debug_digest_path`, and the drain heartbeat, alert branch and consumed-marking path: about 90 lines plus about 4 tests.
7. Move the contract's test-only validators and messages into `test/`: `lib/codex-app-server-contract.mjs` shrinks by about 420 lines, and `lib/` becomes production-only.
8. Build one provider table and derive `TARGET_IDS`, `VALID_TARGETS`, `MODEL_ENV`, `COMPANION_NAMES` and `nativeDefaults` from the registry: about 6 hard-coded lists removed, and a sixth companion touches about 8 fewer files.
9. Use one result builder in `records.mjs`, shared by `_finish`, `recover` and the cleanup watcher: about 25 duplicate lines, and one place to add a field.
10. Put a shared fake adapter and Controller setup in `test/controller/helpers.mjs`, replacing 6 inline fakes and about 10 setup functions: about 150 test lines.
11. Fold the 4 duplicated CONTRACT tests in `incident-regressions` into the controller tests, and drop setup's own syntax and test steps (566–622) plus `setup-codex-install`'s `bash -n` and discovery tests: about 160 lines.
12. Put the host path conventions (CODEX_HOME, plugin data, state directory) in one sourced `hooks/host-paths.sh`, and replace `stop-owner.sh`'s inline Node with a small module that shares the atomic writer: about 40 lines, about 11 duplicated expressions.
