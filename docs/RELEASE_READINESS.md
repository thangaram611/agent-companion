# Release Readiness

Last updated: 2026-11-05

Release metadata is `0.1.0` in both plugin manifests and the private bridge
package. Readiness requires the gates below on the reviewed candidate commit;
installed versions and a matching wire fixture do not establish live transport
qualification. Product vocabulary and supported capabilities belong in
[ARCHITECTURE.md](ARCHITECTURE.md).

The current direction is the conversational, per-execution ownership design.
In-flight bridge survival is retired; cold history resume, verified cleanup and
native owner attribution are the acceptance contract. The
[Claude report](../probes/host-qualification/claude/REPORT-2026-11-05.md) (2.1.318)
and [Codex report](../probes/host-qualification/codex/REPORT-2026-11-05.md) (0.166.0)
are measured host inputs, not installed-form cleanup qualification. Codex desktop,
operator-only TUI rows and Copilot cold load remain open release gates.

## Source-Backed Compatibility Notes

Historical installed-version snapshot from 2026-10-26, without model turns
(not current qualification; the newer host versions are cited above):

| Component | Version | Evidence |
| --- | --- | --- |
| Claude Code | 2.1.310 | `claude --version` |
| Codex CLI | 0.164.0 | `/opt/homebrew/bin/codex --version` |
| OpenCode | 2.1.4 | `opencode --version` |
| GitHub Copilot CLI | 1.0.103 | `copilot --version` |
| Antigravity ACP server | 1.1.1 | Installed `current` symlink; version lookup in `scripts/install-antigravity-acp.mjs` |

Claude Code plugins:

- The installation materializes a standalone agent through
  `hooks/install-agent.sh`. Its session-scoped plugin MCP boundary is documented in
  [ARCHITECTURE.md](ARCHITECTURE.md#mcp-registration-boundary).

Codex plugins:

- This package uses `.codex-plugin/plugin.json` with `interface` metadata
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
  Permissions follow server configuration. Cold follow-up loads a saved session;
  steer is unsupported. The current wire tests are
  `bridge-server/adapters/opencode*.test.mjs`.
- Native provider connections establish local configuration, not provider
  availability or quota. Model validation can remain `unknown` until a real
  run; onboarding smoke requires a completed assistant `ready` reply.

GitHub Copilot CLI companion:

- `lib/target-registry.mjs` prefers native ACP prompt usage and falls back to
  OTEL. Its `usage_update` event is context occupancy, not per-turn tokens.
  Qualify usage on the installed CLI rather than assuming the wire shape from
  its version number.
- Cold follow-up is refused until account access and cross-process session
  loading are qualified. No critic footer or answer classification is added.
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

Antigravity companion:

- The installer selects the live registry version, so a new install can differ
  from the installed version above. The adapter applies a pinned model after
  both session creation and loading and answers permission requests under the
  descriptor's policy. Usage is absent. Qualify those assumptions on the selected binary. Access and terms boundaries are [tracker item 8](MVP_TRACKER.md).

## Release Gates

CI runs on Ubuntu with Node 22. Install dependencies first, as
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

1. Claude Code source checkout install with `bash setup.sh --host claude --target none`.
2. Codex CLI source checkout install with `bash setup.sh --host codex --target none`.
3. OpenCode default-target onboarding and one real delegated send.
4. Copilot default-target onboarding and one real delegated send.
5. Codex marketplace build/install: the release-only Codex validator above is
   this gate.
6. Claude marketplace install or `claude --plugin-dir` smoke.
7. Codex CLI companion (downstream target) default-target onboarding and one
   real delegated send, including a network-using step (e.g. a trivial
   `npm install`/fetch inside the sandbox) to prove the
   `AGENT_COMPANION_CODEX_NETWORK` override actually reaches the sandbox — not
   just that a send completes.
8. Codex controller smokes: `node probes/smoke/smoke.mjs` verifies native work,
   history/turn ids, usage, digest and runtime exit; `node probes/smoke/orphan.mjs`
   verifies EOF-triggered watcher cleanup and immutable recovery. The latter is
   not uncatchable SIGKILL coverage. Run doctor before/after an upgrade and record
   the selected executable/helper pair and `contractStatus`.
9. `node probes/smoke/acp-antigravity.mjs <available-model-id>` verifies cold
   history reuse in a new process, unsupported-steer refusal, cancellation,
   acknowledged model selection and bridge-loss cleanup. Requires login and
   spends five turns. Also qualify a real Copilot first send and usage, then
   explicitly test `FOLLOWUP_UNSUPPORTED`; enable cold load only after its own gate.
10. OpenCode 2.x: verify new pid plus same native history on follow-up, canonical
    cwd/worktree and symlink cases, model changes and inherited/resolved model,
    transcript boundaries, cancellation and no surviving descendants. Two
    same-provider children must have independent processes and remain isolated
    when one stops. In-flight steer must refuse explicitly.
11. Across Claude Code, Codex CLI and Codex desktop, qualify two parents, siblings,
    repeated status observers, startup/active-turn/bridge-replacement races,
    every stop/loss trigger, and suspend/wake. Record instruction/result accounting,
    lease detection delay separately from cleanup time, and process absence.
    Operator-only TUI actions and desktop cannot be inferred from headless CLI rows.
12. Migrate quiescent legacy state, preserve history/results and refuse ambiguous
    mappings. Verify installed artifacts and hooks, including Claude's plugin
    namespace and both hosts' stop markers. No live legacy job may be adopted.

For source installs, also verify that prerequisite failures precede installation,
separate host defaults and legacy migration inputs survive reruns, and a partial install reports
completed stages and recovers on rerun. `scripts/setup-codex-install.test.mjs`
and `scripts/onboard.test.mjs` cover these with fake CLIs. Setup itself spends
no quota; its readiness report does not qualify a live companion response.

Require the green Node 22 baseline, the full root-discovered regression suite
on supported local runtimes (including Node 24), required compatibility/CI checks,
qualified cold providers and installed-form smoke. No release/completion claim
while a required capability remains unqualified.

Record the candidate commit, binary versions and results with the release.
Use isolated state/runtime directories for smokes, stop probe-owned processes,
and verify fresh CI on that exact commit before publication.
