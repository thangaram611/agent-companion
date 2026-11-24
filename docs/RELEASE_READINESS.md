# Release Readiness

Last updated: 2026-11-23

Release metadata is `1.0.0` in both plugin manifests and the private bridge
package. Readiness requires the gates below on the reviewed candidate commit;
installed versions and a matching wire fixture do not establish live transport
qualification. Product vocabulary and supported capabilities belong in
[ARCHITECTURE.md](ARCHITECTURE.md).

Since 1.0.0 the lead calls the bridge itself: it owns threads, and results
reach it by hook, `companion_wait` or a host wake ([THREAD_PLAN.md](THREAD_PLAN.md)).
There is no subagent role. In-flight bridge survival stays retired; cold history
resume, verified cleanup and host-identified leads are the acceptance contract. The
[Claude report](../probes/host-qualification/claude/REPORT-2026-11-05.md) (2.1.318)
and [Codex report](../probes/host-qualification/codex/REPORT-2026-11-05.md) (0.166.0)
are measured host inputs, not installed-form cleanup qualification. Codex desktop,
operator-only TUI rows and Claude companion smoke on both
hosts remain open release gates. Those older reports establish Claude as a host,
not Claude as a companion.

## Source-Backed Compatibility Notes

Installed versions on 2026-11-24, macOS, Node 26.13.1. These version checks do
not establish release qualification.

| Component | Version | Evidence |
| --- | --- | --- |
| Claude Code | 2.1.331 | `claude --version` |
| Codex CLI | 0.172.0 | `codex --version` |
| OpenCode | 2.4.0 | `opencode --version` |
| GitHub Copilot CLI | 1.0.114 | `copilot --version` |
| Antigravity CLI | 1.5.15 | `agy --version` |

Claude Code plugins:

- The plugin registers the bridge at plugin scope and its hooks identify the
  lead; there is no agent file since 1.0.0, and session start removes an old
  sentinel-marked one. The MCP boundary is documented in
  [ARCHITECTURE.md](ARCHITECTURE.md#mcp-registration-boundary).

Codex plugins:

- This package uses `.codex-plugin/plugin.json` with `interface` metadata
  for install-surface copy:
  <https://developers.openai.com/codex/plugins/build>.
- Codex plugins can bundle lifecycle hooks through the manifest or the default
  `hooks/hooks.json` path, and plugin-bundled hooks still go through trust
  review:
  <https://developers.openai.com/codex/hooks>.
- Agent Companion declares its bridge in the Codex-only plugin manifest, so the
  root conversation and any child inherit it, and marks it `required` (1.0.0)
  so a first turn never starts without its tools; measured in
  [Negative Results](ARCHITECTURE.md#negative-results). Codex agent roles
  cannot add MCP authority:
  <https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/agent/role.rs#L33-L44>,
  <https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/agent/role_tests.rs#L497-L526>.
- Codex 0.164.0 supports the inline native `mcpServers` object and resolves a
  relative `cwd` against the installed plugin root. This preserves the 1320s
  tool timeout and avoids a root `.mcp.json` that Claude might also discover:
  <https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core-plugins/src/manifest.rs#L413-L438>,
  <https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-mcp/src/plugin_config.rs#L301-L309>.

OpenCode companion:

- Only OpenCode 2.x is supported. Each execution starts a private authenticated
  loopback HTTP server, sets OS cwd and `PWD`, and validates the native pid/version.
  Permissions follow server configuration. Cold follow-up loads a saved session.
  Steer sends a prompt during the turn. The current wire tests are
  `bridge-server/adapters/opencode*.test.mjs`.
- Native provider connections establish local configuration, not provider
  availability or quota. Model validation can remain `unknown` until a real
  run; onboarding smoke requires a completed assistant `ready` reply.

GitHub Copilot CLI companion:

- The ACP adapter prefers native prompt usage and falls back to
  OTEL. Its `usage_update` event is context occupancy, not per-turn tokens.
  Qualify usage on the installed CLI rather than assuming the wire shape from
  its version number.
- Copilot CLI 1.0.114 replayed saved history on local Ollama (2026-11-23).
  The bridge requires replay on cold load and reapplies the model override.
  GitHub-hosted models still get 403 on `session/new` on this account. No critic footer or answer classification is added.
  Supported model ids belong in `lib/state.mjs`.

Codex CLI companion:

- **Wire contract generated from codex-cli 0.164.0**:
  `lib/codex-app-server-contract.json` records provenance. The sibling test
  compares the installed CLI's schema; a version-only change passes, a schema
  change fails. The adapter reports `contractStatus: match|drift|unverified`
  and keeps serving. Regenerate only with
  `scripts/gen-codex-app-server-contract.mjs` and inspect the classified diff,
  especially routing changes.
- The app-server adapter uses the shared sandbox resolver. The bridge defaults to
  `workspace-write` with network enabled; app-server pins `approvalPolicy`
  to `never`. Live acceptance must verify applied network policy and the selected
  executable/helper pair after an upgrade. Transport and
  sandbox rationale belong in [Negative Results](ARCHITECTURE.md#negative-results).

Claude Code companion:

- Agent Companion runs the user's installed, unmodified Claude Code binary.
  The binary handles the end user's own authentication; the bridge does not
  implement login, extract credentials or proxy Anthropic requests. This uses
  the CLI, not the Agent SDK. The [vendor terms](https://code.claude.com/docs/en/legal-and-compliance)
  require an unmodified binary and end-user authentication/billing under the
  applicable terms. This records the integration boundary, not individualized
  vendor approval.
- The [support article updated 2026-10-07](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  says signed-in `claude -p` use draws subscription limits; a linked Console
  API key can use included API credits. Billing follows native configuration;
  a reported result cost does not establish a dollar charge.
- Operator-run measurements on 2026-11-09 cover Claude Code 2.1.319. Older
  versions are **UNVERIFIED**; `--permission-prompts` requires at least 2.1.259.
  Cold resume, init-after-input delivery, interruption, recursion denial and
  per-turn tokens are implemented and tested with fake processes. Installed
  smoke, including Claude-host nesting with user hooks/plugins loaded, is
  still required. See [Negative Results](ARCHITECTURE.md#negative-results).

Antigravity companion:

- Install with `brew install --cask antigravity-cli` and sign in with
  `agy acp --login`. Record `agy --version` on the candidate. Check history
  replay, model and effort after load, prompt usage and the selected permission
  policy. Access and terms boundaries are in [tracker item 8](MVP_TRACKER.md).

## Release Gates

Claude companion implementation and qualification are tracked separately:

| Gate | Status | Evidence / next check |
| --- | --- | --- |
| Hermetic adapter and integration suite | Done | 503 tests green at `c8612ae` on Node 22 and 26, including the supervisor pid guard and the normalized-model default fix. |
| Documentation | Done 2026-11-23 | The role templates are gone in 1.0.0. Both manifests and the README name all five companions and describe threads; `docs/THREAD_FEATURES.md` walks every shipped behaviour to its pinning test or the plan's by-design table. |
| Thread design on both hosts (1.0.0) | Done 2026-11-23 | `probes/direct-lead/live.mjs` scenarios on Claude Code 2.1.330 and Codex 0.171 (daemon mode), both idle hours, and installed-form runs on the operator's hosts; see the 1.0.0 record below. |
| Live Claude companion smoke from Codex CLI | Done 2026-11-09 | [Report](../probes/host-qualification/claude-companion/REPORT-2026-11-09.md): installed branch plugin on codex-cli 0.167.0; send, relayed follow-up on the same history, refusal, interrupt verified gone. Codex does not forward the shell environment to the bridge, so model env knobs are inert there. |
| Live Claude companion smoke from Claude Code | Done 2026-11-09 | Same report: nested Claude parent → Claude child, configured default model applied, follow-up relayed, TaskStop interrupt verified gone. |
| Older Claude Code versions | UNVERIFIED | 2.1.319 measured; the 2.1.259 flag minimum is not full compatibility proof. |

CI runs on Ubuntu with Node 26. Install dependencies first, as
`.github/workflows/ci.yml` does:

```bash
(cd bridge-server && npm ci --silent --no-audit --no-fund)
```

Automated CI gates:

```bash
bash -n setup.sh hooks/*.sh
find . -name '*.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 -n1 node --check
find . -name '*.test.mjs' -not -path './bridge-server/node_modules/*' -print0 | xargs -0 node --test --experimental-test-coverage
(cd bridge-server && npm audit --omit=dev --audit-level=moderate)
```

Discover tests from the repo root so `test/` guard suites are included.
The contract drift test skips when Codex is absent; a green CI run without
Codex does not qualify the installed app-server wire contract.

Release-only packaging gates:

```bash
node scripts/validate-codex-release.mjs
claude plugin validate .
```

The Codex validator builds and installs into an isolated `CODEX_HOME`, checks
package contents and the effective MCP registration, and starts no model turn.
It checks README asset presence, not content; regenerate images from
`assets/readme/PROMPTS.md` and inspect every label.

Manual smoke gates before a public tag (real delegations spend model tokens):

1. Claude Code source checkout install with `bash setup.sh --host claude --companion none`.
2. Codex CLI source checkout install with `bash setup.sh --host codex --companion none`.
3. OpenCode default companion onboarding and one real delegated send.
4. Copilot default companion onboarding and one real delegated send.
5. Codex marketplace build/install: the release-only Codex validator above is
   this gate.
6. Claude marketplace install or `claude --plugin-dir` smoke.
7. Codex CLI default companion onboarding and one
   real delegated send, including a network-using step (e.g. a trivial
   `npm install`/fetch inside the sandbox) to prove the
   `AGENT_COMPANION_CODEX_NETWORK` override actually reaches the sandbox — not
   just that a send completes.
8. Codex controller smokes: `node probes/smoke/smoke.mjs` verifies native work,
   history/turn ids, usage, digest and runtime exit; `node probes/smoke/orphan.mjs`
   verifies EOF-triggered watcher cleanup and immutable recovery. The latter is
   not uncatchable SIGKILL coverage. Before and after an upgrade, inspect the executable/helper pair with
   `node --input-type=module -e "import {inspectCodexAppServerInstallation as inspect} from './lib/codex-install.mjs'; console.log(inspect())"`.
   Record `contractStatus` from the Codex companion catalog or status diagnostics.
9. `node probes/smoke/acp-antigravity.mjs <available-model-id>` starts seven
   jobs on a signed-in CLI. Check completion with usage and digest, cold history
   reuse in a new process, default steer, cancel, a background command's file
   and final reply, model selection and bridge-loss cleanup. The probe logs
   whether the model waited in the prompt or the bridge kept the turn open.
   For Copilot, qualify first-send usage on the installed CLI and verify cold
   follow-up by recalling a value from the first job.
10. OpenCode 2.x: verify new pid plus same native history on follow-up, canonical
    cwd/worktree and symlink cases, model changes and inherited/resolved model,
    transcript boundaries, cancellation and no surviving descendants. Two
    same-provider children must have independent processes and remain isolated
    when one stops. Verify that an in-flight steer reaches the running session.
11. Across Claude Code, Codex CLI and Codex desktop, qualify two parents, siblings,
    repeated status observers, startup/active-turn/bridge-replacement races,
    every stop/loss trigger, and suspend/wake. Record instruction/result accounting,
    stop detection separately from cleanup time, and process absence.
    Operator-only TUI actions and desktop cannot be inferred from headless CLI rows.
12. Legacy history is not read since 1.0.0 (plan decision 22). Verify installed
    artifacts and hooks, including Claude's plugin namespace and the removal of
    the old agent files. No live legacy job may be adopted.

For source installs, also verify that prerequisite failures precede installation,
separate host defaults and legacy migration inputs survive reruns, and a partial install reports
completed stages and recovers on rerun. `scripts/setup-codex-install.test.mjs`
and `scripts/onboard.test.mjs` cover these with fake CLIs. Setup itself spends
no quota; its readiness report does not qualify a live companion response.

Require the green Node 26 baseline, the full root-discovered regression suite
on supported local runtimes (Node 26 or newer), required compatibility/CI checks,
qualified cold providers and installed-form smoke. No release/completion claim
while a required capability remains unqualified.

Record the candidate commit, binary versions and results with the release.
Use isolated state/runtime directories for smokes, stop probe-owned processes,
and verify fresh CI on that exact commit before publication.

## 1.0.0 record (2026-11-23)

- Candidate: the merge of `feat/threads` into main plus the 1.0.0 version
  commit; CI on that exact commit is required before publication.
- Hermetic suite: 898/898 at `ecc9038` (402 s, Node 26.13.0); the required
  Codex bridge change added suites run green (31/31). Release validator and
  `claude plugin validate .` OK.
- Installed form, operator hosts: Claude Code 2.1.330 lead sent to OpenCode's
  free model, was woken through its inbox socket and got the result once by
  hook. Codex 0.171 through its daemon: lead identity, `codex queue` wake, hook
  delivery 0.6 s after the job ended, and `/quit` with
  `thread_unload_delay_secs = 0` ending a running job in bridge loss after
  3.5 s.
- Live bridge check, 2026-11-23 (isolated homes, local Ollama `gpt-oss:20b`, 32k context): Copilot CLI 1.0.114 recalled the code word on the same thread and refused steer with `intervention_unavailable` (reason `capability`). Claude Code 2.1.330 steer joined two messages in one turn. On both companions, queue ran a second turn. Interrupt ended the first turn as `interrupted` and answered in the second.
- Codex desktop and older Claude Code versions remain open. Gates 3, 4 and
  7 to 11 were not rerun in full for this release.

### Copilot CLI host

On 1.0.114 in a disposable profile, two setup runs produced one enabled local
marketplace plugin and one bridge. A plain TUI joined its notice extension.
The installed launcher advertised six tools and refused both direct status
calls (missing and forged lead) with `LEAD_REQUIRED`. Two open roots had
separate registrations. A forged read of the other root's actual thread
returned `THREAD_NOT_YOURS`; the owner listed it. Clearing one replaced its
registration while the other root survived. A marked ACP session started the
unrelated control MCP with no additional bridge startup or notice registration. The independent
post-tool hook's canary accompanied a successful native status result. Doctor
pinged three live registrations; with extension loading disabled in a fresh
TUI, doctor reported zero. Disable, enable, update and uninstall were exercised
in a separate isolated profile.

The installed bridge delivered a failed job's completion to the idle owning
root. The shared jobs view displayed that failed job. The process census
returned EPERM in this sandbox. In a separate model-driven send the local
model supplied an invalid `mode: "sync"` and invented a thread ID; the bridge
refused the call. The send description now specifies the first-send fields
and exposes the supported modes in its schema. A controlled wake
was acknowledged 759 ms into a separate 12 s native tool call that then
completed successfully. Acknowledgement measures acceptance by the session.
GPU qualification remains open for successful supervised send, wait/read,
follow-up and cancellation across reachable companions; model receipt after a
queued busy/background wake; concurrent completions and wait races; sibling
and nested subagent ownership and wait; disabled or late extension fallback;
one-hour idle retention, the full 1,200 s wait, cancelled wait and job survival;
clear, crash and exit during work; and recursion on a real start and resume.
Private Ollama stopped after this run. Port 11435 refused connections.
[Installed-product checks](../probes/copilot-host/README.md#installed-product)
