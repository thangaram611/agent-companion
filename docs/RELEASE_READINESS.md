# Release Readiness

Last updated: 2026-10-26

Release metadata is `0.1.0` in both plugin manifests and the private bridge
package. Readiness requires the gates below on the reviewed candidate commit;
installed versions and a matching wire fixture do not establish live transport
qualification. Product vocabulary and supported capabilities belong in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Source-Backed Compatibility Notes

Installed versions checked on 2026-10-26 without model turns:

| Component | Version | Evidence |
| --- | --- | --- |
| Claude Code | 2.1.310 | `claude --version` |
| Codex CLI | 0.164.0 | `/opt/homebrew/bin/codex --version` |
| OpenCode | 2.1.4 | `opencode --version` |
| GitHub Copilot CLI | 1.0.103 | `copilot --version` |
| Antigravity ACP server | 1.1.1 | Installed `current` symlink; version lookup in `scripts/install-antigravity-acp.mjs` |

Claude Code plugins:

- The installation materializes a standalone agent through
  `hooks/install-agent.sh`. Its agent-local MCP boundary is documented in
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

- The 2.x CLI adapter uses a private `--standalone` server and sets both OS cwd
  and `PWD` to the requested directory. `lib/opencode-cli.mjs` selects the
  arguments shared by dispatch and onboarding; `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip`
  opts into `--auto`. Server-mode permissions follow OpenCode's own config.
- The HTTP adapter implements the authenticated `/api` contract, global
  session-filtered events and paginated current-turn recovery. Captured wire
  regressions live in `bridge-server/opencode-server-runtime.test.mjs`;
  gate 10 checks the installed server.
- Native provider connections establish local configuration, not provider
  availability or quota. Model validation can remain `unknown` until a real
  run; onboarding smoke requires a completed assistant `ready` reply.

GitHub Copilot CLI companion:

- `lib/target-registry.mjs` prefers native ACP prompt usage and falls back to
  OTEL. Its `usage_update` event is context occupancy, not per-turn tokens.
  Qualify usage on the installed CLI rather than assuming the wire shape from
  its version number.
- A successful rubber-duck footer requires a recorded completed native critic
  call. The footer verifies invocation, not critique quality or the critic's
  model; `bridge-server/server.test.mjs` covers unavailable and unrecorded calls.
  Supported model ids belong in `lib/state.mjs`, not a second catalog here.

Codex CLI companion:

- **Wire contract generated from codex-cli 0.164.0**:
  `lib/codex-app-server-contract.json` records provenance. The sibling test
  compares the installed CLI's schema; a version-only change passes, a schema
  change fails. The broker reports `contractStatus: match|drift|unverified`
  and keeps serving. Regenerate only with
  `scripts/gen-codex-app-server-contract.mjs` and inspect the classified diff,
  especially routing changes.
- Both adapters share the sandbox resolver. The bridge defaults to
  `workspace-write` with network enabled; app-server pins `approvalPolicy`
  to `never`. Gate 7 must verify the applied network policy, and gate 8 must
  verify the running binary/helper pair after an upgrade. Transport and
  sandbox rationale belong in [Negative Results](ARCHITECTURE.md#negative-results).

Antigravity companion:

- The installer selects the live registry version, so a new install can differ
  from the installed version above. The daemon applies a pinned model after
  both session creation and loading and answers permission requests under the
  descriptor's policy. Usage is absent. Qualify those assumptions with gate 9 on the selected
  binary. Access and terms boundaries are [tracker item 8](MVP_TRACKER.md).

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
It checks README asset presence, not rendering correctness; re-render changed
SVGs with `bash scripts/render-readme-assets.sh` and inspect the PNGs.

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
   `meta.usage` (with the implemented OTEL fallback) and the
   `acp_daemons.copilot` registry entry on `agent_status`.
10. OpenCode HTTP server (`OPENCODE_RUNTIME_ADAPTER=server`): verify two
    working directories on one server, send, reply, confirmed cancellation,
    streaming, per-turn usage, bridge-restart and completed-transcript recovery,
    and idle disposal. Require a native running tool before interrupting a
    turn; model prose alone does not establish that the control path was tested.

For source installs, also verify that prerequisite failures precede installation,
separate host defaults and profiles survive reruns, and a partial install reports
completed stages and recovers on rerun. `scripts/setup-codex-install.test.mjs`
and `scripts/onboard.test.mjs` cover these with fake CLIs. Setup itself spends
no quota; its readiness report does not qualify a live companion response.

Record the candidate commit, binary versions and results with the release.
Use isolated state/runtime directories for smokes, stop probe-owned processes,
and verify fresh CI on that exact commit before publication.
