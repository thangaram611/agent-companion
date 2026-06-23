# First-Class Onboarding Handoff

Last updated: 2026-06-19

> **Status: IMPLEMENTED.** This handoff has been delivered. See `lib/target-registry.mjs`,
> `lib/target-diagnostics.mjs`, `lib/doctor.mjs`, `scripts/onboard.mjs`, the
> `setup.sh` `--target` flow, and `hooks/prewarm-target.sh`. Two deliberate
> deviations from the plan below: (1) the silent `opencode` bootstrap fallback
> was **removed** entirely — an unconfigured target now errors with onboarding
> guidance rather than defaulting; (2) the full `agent-*` rename landed in the
> same pass (no `copilot_*` aliases, no legacy env, server `agent-bridge`,
> digest `agent-digest://`, state dir `~/.{claude,codex}/agent-companion/`).
> The sections below are retained as the design record.

> **Public terminology update (2026-06-23):** current product copy uses
> **harness** for the parent surface (`--host claude|codex`) and **companion**
> for the delegated runtime (`target=opencode|copilot`). The implementation
> still uses `host` and `target` as stable MVP flags/schema names. Future
> routing should support multiple companion profiles and expose strengths such
> as `reviewer` or `web_researcher` to harnesses instead of requiring each send
> to name a concrete runtime.

## Objective

Make onboarding companion-aware and harness-aware:

- Users attach their companion.
- The MVP supports two companion targets: `opencode` and `copilot`.
- Setup must not require Copilot for OpenCode-only users.
- Doctor/status must clearly say which harnesses and companion targets are
  ready, missing, or partially configured.
- Companion selection must be explicit or configured; the implemented bridge has
  no bootstrap fallback.

This is a handoff document for the next implementation pass. It is intentionally prescriptive so the work can be picked up without re-reading the whole repo.

## Historical Repo Baseline

This was the pre-implementation baseline used by the handoff. It is retained as
design context, not current repo truth.

Already implemented at the time:

- Generic MCP tools: `agent_send`, `agent_wait`, `agent_status`, `agent_reply`, `agent_cancel`.
- Legacy aliases: `copilot_*`, with `copilot_send` pinned to `target: "copilot"`.
- Target registry in `bridge-server/target-registry.mjs`.
- Default target state in `lib/state.mjs`:
  - `AGENT_COMPANION_DEFAULT_TARGET`
  - legacy `COPILOT_COMPANION_DEFAULT_TARGET`
  - `~/.{claude,codex}/agent-companion/default-target`
  - then-current bootstrap fallback: `opencode`
- OpenCode CLI adapter in `bridge-server/opencode-runtime.mjs`.
- Copilot ACP adapter kept intact.
- `agent_status({ diagnostics: true })` surfaces `lib/doctor.mjs`.

Main gaps at the time:

- `setup.sh` still hard-fails when `copilot` is missing, even for an OpenCode-only install.
- `lib/doctor.mjs` still treats `copilot.found` as required for overall `ok`.
- `hooks/prewarm-daemon.sh` runs on every session start and attempts to prewarm the Copilot daemon even when the configured target is OpenCode.
- There is no onboarding command to select/write `default-target`.
- There is no target-specific readiness model: binary found, authenticated, configured, permission-safe, smoke-tested.
- OpenCode permission mode is env-only and easy to miss.
- README and tracker document companion support, but there is no operational onboarding checklist or automated remediation path.

## Research Inputs

OpenCode:

- Official site positions OpenCode as open-source and supports connecting existing models/providers; install script is shown on the homepage: [opencode.ai](https://opencode.ai/).
- OpenCode providers are configured by adding provider credentials and configuration. Credentials added through `/connect` are stored under `~/.local/share/opencode/auth.json`: [OpenCode providers](https://opencode.ai/docs/providers/).
- `opencode models [provider]` lists configured provider models and uses `provider/model` names: [OpenCode CLI](https://opencode.ai/docs/cli/).
- `opencode run` is the non-interactive path. Relevant flags include `--format json`, `--dir`, `--model`, `--agent`, `--attach`, and `--dangerously-skip-permissions`: [OpenCode CLI run](https://opencode.ai/docs/cli/).
- Permissions are controlled by the `permission` config; actions can be `allow`, `ask`, or `deny`: [OpenCode permissions](https://opencode.ai/docs/permissions/).
- OpenCode logs and app data live under `~/.local/share/opencode/` on macOS/Linux: [OpenCode troubleshooting](https://opencode.ai/docs/troubleshooting/).
- OpenCode has a JS/TS SDK that can start/connect to a server; this is useful later for a server adapter but not required for first-class onboarding: [OpenCode SDK](https://opencode.ai/docs/sdk/).

GitHub Copilot CLI:

- Copilot CLI requires an active Copilot plan, and organization/enterprise policy can disable CLI access: [Install Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli).
- Installation supports npm, Homebrew, WinGet, install script, or direct download. npm requires Node.js 22 or later: [Install Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli).
- `copilot login` authenticates with OAuth; token environment variables are also supported for headless cases: [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
- First use asks the user to trust a workspace; tool approvals are part of normal Copilot CLI operation: [Use Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview).
- Copilot CLI settings live under `~/.copilot` unless `COPILOT_HOME` is set: [Use Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview).

## Product Posture

Do not say "OpenCode is the default product companion." Say:

- "Bring your harness and attach your companion."
- "Supported harnesses now: Claude Code and Codex CLI."
- "Supported companions now: OpenCode and Copilot."
- "Choose companion per send, or configure a bridge default."
- "Future routing will expose strengths backed by configured companion
  profiles."

The implemented bridge deliberately removed the old bootstrap fallback to
`opencode`: setup/onboarding must not hide companion selection. Interactive
onboarding should ask. Non-interactive onboarding should require `--target`
unless an existing configured target is present.

## Recommended Architecture

### 1. Add Shared Target Onboarding Metadata

Extend or replace `bridge-server/target-registry.mjs` with shared metadata usable by both the MCP server and CLI scripts. Prefer moving shared target metadata into `lib/target-registry.mjs`, then let `bridge-server/target-registry.mjs` re-export it if needed.

Each target descriptor should include:

```js
{
  id: 'opencode',
  displayName: 'OpenCode',
  binaryEnv: 'OPENCODE_BIN',
  binaryNames: ['opencode'],
  install: {
    docs: 'https://opencode.ai/',
    commands: [
      'curl -fsSL https://opencode.ai/install | bash'
    ]
  },
  auth: {
    docs: 'https://opencode.ai/docs/providers/',
    checkCommands: [
      ['opencode', ['models']]
    ],
    nextSteps: [
      'Run opencode, then /connect and choose a provider.',
      'Run opencode models to verify configured models.'
    ]
  },
  permission: {
    docs: 'https://opencode.ai/docs/permissions/',
    safeDefault: 'ask',
    bridgeEnv: 'AGENT_COMPANION_OPENCODE_PERMISSION_MODE',
    dangerousMode: 'skip'
  },
  smoke: {
    safeByDefault: false,
    reason: 'Consumes provider quota and may require permission approval.'
  }
}
```

Copilot descriptor should include:

```js
{
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  binaryEnv: 'COPILOT_BIN',
  binaryNames: ['copilot', '/opt/homebrew/bin/copilot'],
  install: {
    docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
    commands: [
      'npm install -g @github/copilot',
      'brew install copilot-cli'
    ]
  },
  auth: {
    docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
    nextSteps: [
      'Run copilot login, or start copilot and follow /login.',
      'Confirm organization policy allows Copilot CLI.'
    ]
  },
  permission: {
    docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview',
    note: 'Workspace trust and tool approvals are handled by Copilot CLI.'
  }
}
```

Keep runtime capabilities separate from onboarding metadata. Capabilities answer "what can this target do?" Onboarding answers "is this user's machine ready?"

### 2. Add Target Diagnostics

Create `lib/target-diagnostics.mjs`.

Export:

```js
inspectTarget(id, { run, env })
inspectTargets({ run, env })
selectConfiguredTarget({ env })
targetReadinessSummary(report)
```

Suggested readiness shape:

```js
{
  id: 'opencode',
  displayName: 'OpenCode',
  configuredDefault: true,
  installed: true,
  binary: '/opt/homebrew/bin/opencode',
  version: 'opencode 1.x',
  authenticated: 'unknown' | true | false,
  permission: {
    mode: 'default' | 'skip',
    readyForNonInteractive: true | false | 'unknown',
    risk: 'normal' | 'dangerous'
  },
  smoke: {
    supported: true,
    run: false,
    passed: null
  },
  ready: true | false,
  blockers: [
    { code: 'missing_binary', message: '...' }
  ],
  warnings: [
    { code: 'dangerous_permissions', message: '...' }
  ],
  nextSteps: [
    '...'
  ]
}
```

Readiness should be explicit:

- `installed`: binary can be found and version command succeeds.
- `authenticated`: can be proven without spending quota or running a task.
- `permission.readyForNonInteractive`: whether our bridge can run without hanging on prompts.
- `ready`: usable by `agent_send` without known blockers.

Avoid false-green results. If auth cannot be proven cheaply, return `unknown` with a clear next step rather than `true`.

### 3. Make Doctor Target-Aware

Update `lib/doctor.mjs`:

- Add `targets` section using `inspectTargets`.
- Add `defaultTarget` from `readDefaultTarget`.
- Change `report.ok`.

New `ok` logic:

- Common requirements must pass:
  - Node >= 22
  - npm
  - jq
  - at least one selected host CLI (`claude` or `codex`) depending on scope
- Target requirements:
  - If a target is configured, that target must have no hard blockers.
  - If no target is configured, at least one supported target must be installed enough to be selected, and the report should warn that target selection is not persisted.
  - Copilot is not required for an OpenCode-only report.

Keep `scripts/doctor.mjs --json` stable but extend fields. Do not remove existing keys yet.

Example report:

```json
{
  "ok": false,
  "defaultTarget": { "target": "opencode", "source": "config" },
  "targets": {
    "opencode": {
      "installed": true,
      "authenticated": "unknown",
      "ready": false,
      "blockers": [
        { "code": "auth_unknown", "message": "Run opencode models or /connect." }
      ]
    },
    "copilot": {
      "installed": false,
      "ready": false,
      "blockers": [
        { "code": "missing_binary", "message": "Install GitHub Copilot CLI." }
      ]
    }
  }
}
```

### 4. Add `scripts/onboard.mjs`

This should be the first-class onboarding entry point. `setup.sh` can call it, but it should also stand alone.

Proposed CLI:

```bash
node scripts/onboard.mjs --host claude|codex|both --target opencode|copilot|auto --set-default
node scripts/onboard.mjs --host codex --target opencode --yes
node scripts/onboard.mjs --list-targets
node scripts/onboard.mjs --doctor --json
node scripts/onboard.mjs --target opencode --smoke
```

Behavior:

- Interactive mode:
  - Detect installed targets.
  - Ask user to select a target if none was passed.
  - Explain missing target setup with official docs links.
  - Ask before writing `default-target`.
  - Ask before enabling dangerous OpenCode permission mode.
- Non-interactive mode:
  - `--yes` never guesses target unless `--target` is provided or a config already exists.
  - Fails with actionable output if target is missing.
  - Writes machine-readable JSON with `--json`.
- Secrets:
  - Never prompt for API keys.
  - Never write provider credentials.
  - Delegate auth to vendor tools (`opencode` `/connect`, `opencode auth login`, `copilot login`).
- Smoke tests:
  - Opt-in only via `--smoke`.
  - Should use a temporary directory.
  - Must clearly warn that it may consume quota.

### 5. Update `setup.sh`

Add:

```bash
--target opencode|copilot|auto|none
--no-target-check
--skip-tests
```

Recommended behavior:

- Common setup should install bridge deps and materialize host files.
- Target setup should be delegated to `scripts/onboard.mjs`.
- Remove the hard `copilot` binary requirement from common prerequisites.
- Run Copilot reviewer-agent setup only when `target=copilot` or when Copilot is installed and user chooses it.
- Keep syntax/tests by default for local source checkout, but allow `--skip-tests` for published plugin install if the install path needs to be lightweight later.

Target handling:

- `--target opencode`: require OpenCode readiness, do not require Copilot.
- `--target copilot`: require Copilot readiness, do not require OpenCode.
- `--target auto`: choose only if exactly one supported target is ready; if both are ready in interactive mode, ask; if both are ready in `--yes`, fail and ask for explicit `--target`.
- `--target none`: install host/plugin surface only, skip target validation, do not write `default-target`.

### 6. Make Hooks Target-Aware

`hooks/prewarm-daemon.sh` should not prewarm Copilot for OpenCode-only users.

Options:

1. Read `default-target`; only prewarm when it resolves to `copilot`.
2. Rename to `prewarm-target.sh` and dispatch by target.
3. Remove prewarm from SessionStart and let Copilot lazy-start on first send.

Recommended MVP: option 1. It is the smallest change and preserves Copilot cold-start behavior.

Rules:

- If `AGENT_COMPANION_DEFAULT_TARGET=copilot`, prewarm.
- If `default-target` file says `copilot`, prewarm.
- If no target is configured, do not prewarm; onboarding should configure target explicitly.
- OpenCode has no daemon to prewarm in the current CLI adapter.

### 7. Persist Target Choice Safely

Add a small script or make `onboard.mjs` write target state through `lib/state.mjs`.

Do not tell users to manually edit files as the primary path. Manual file edit can remain documented as an escape hatch.

State writes:

- `writeDefaultTarget('opencode')`
- `writeDefaultTarget('copilot')`

Validation:

- Reject unknown target ids.
- Preserve legacy env override behavior.
- Surface when env overrides file config so users do not debug the wrong value.

### 8. Improve Runtime Error Messages

Bridge runtime errors should point back to onboarding:

- Missing OpenCode binary:
  - "Run `node scripts/onboard.mjs --target opencode`."
- OpenCode permission prompt/noninteractive failure:
  - "Configure OpenCode permission rules or set `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip` only if you accept the risk."
- Missing Copilot binary:
  - "Run `node scripts/onboard.mjs --target copilot`."
- Copilot daemon unreachable:
  - Keep current daemon log guidance.

Do not suggest installing Copilot when the selected target is OpenCode.

## Target-Specific Onboarding

### OpenCode

Readiness checks:

- Resolve binary from `OPENCODE_BIN` or `command -v opencode`.
- Version check: `opencode --version`.
- Provider/model check:
  - `opencode models` is useful because official docs say it lists configured provider models in `provider/model` form.
  - Treat failure/no models as `needs_provider`, not as a setup crash.
- Permission check:
  - Read bridge env mode using `openCodeRuntimeInfo`.
  - If mode is `skip`, warn that it passes OpenCode's dangerous auto-approval flag.
  - If mode is default, warn that noninteractive runs may stop on permission prompts unless OpenCode permissions are configured.

Recommended onboarding copy:

```text
OpenCode target selected.

1. Install OpenCode if missing:
   curl -fsSL https://opencode.ai/install | bash

2. Configure a provider:
   opencode
   /connect
   /models

3. Verify models:
   opencode models

4. For unattended bridge runs, configure OpenCode permissions in opencode.json.
   Use AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip only when you accept
   dangerous auto-approval behavior.
```

Future improvement:

- Create or document an OpenCode agent profile for companion runs.
- Expose `opencode agent` selection through `agent_send` only after the adapter supports it end to end.
- Consider OpenCode server/SDK adapter for reply/resume and stronger readiness checks.

### Copilot

Readiness checks:

- Resolve binary from `COPILOT_BIN`, `command -v copilot`, then `/opt/homebrew/bin/copilot`.
- Version check: `copilot --version` or `copilot version`.
- Auth check:
  - Prefer a cheap command that does not start an agent task if available.
  - If not reliable, return `unknown` and instruct `copilot login` or first interactive launch.
- Plan/policy:
  - Warn that Copilot CLI requires a Copilot plan and can be disabled by org/enterprise policy.
- Workspace trust:
  - Warn that first use in a repo can require trust approval.

Recommended onboarding copy:

```text
Copilot target selected.

1. Install GitHub Copilot CLI:
   npm install -g @github/copilot
   # or: brew install copilot-cli

2. Authenticate:
   copilot login

3. Start once in the target repo and trust the workspace when prompted:
   cd /path/to/repo
   copilot

4. Re-run:
   node scripts/doctor.mjs --json
```

## User Flows

### Flow A: New Codex User With OpenCode

```bash
bash setup.sh --host codex --target opencode
```

Expected:

- Installs bridge dependencies.
- Materializes Codex subagent and hooks.
- Detects OpenCode.
- Writes `default-target=opencode` after confirmation.
- Does not require or prewarm Copilot.
- Prints OpenCode provider/permission next steps if not fully ready.

### Flow B: New Claude User With Copilot

```bash
bash setup.sh --host claude --target copilot
```

Expected:

- Installs bridge dependencies.
- Materializes Claude subagent.
- Writes Claude allow-list permissions for MCP tools.
- Detects Copilot.
- Writes `default-target=copilot` after confirmation.
- Prewarms Copilot daemon on future SessionStart.

### Flow C: User Has Both Targets

```bash
node scripts/onboard.mjs --host both --target auto
```

Interactive:

- Show both targets with readiness.
- Ask which one should be default.

Non-interactive:

- Fail if both are ready and no target was specified.
- Message: "Multiple targets detected; pass --target opencode or --target copilot."

### Flow D: User Wants Host Setup Only

```bash
bash setup.sh --host codex --target none
```

Expected:

- Host/plugin surface installed.
- No target binary required.
- Doctor reports no configured target.
- First send without explicit target may still use runtime fallback, but onboarding output must say target is not configured.

## Implementation Checklist

1. Target metadata:
   - Add `lib/target-registry.mjs` or move current registry from `bridge-server/`.
   - Keep `bridge-server/target-registry.mjs` as a compatibility re-export if moving.
   - Include install/auth/permission metadata.

2. Target diagnostics:
   - Add `lib/target-diagnostics.mjs`.
   - Add tests for OpenCode-only, Copilot-only, both, none, env binary overrides, env default target override.

3. Doctor:
   - Extend `lib/doctor.mjs`.
   - Update `lib/doctor.test.mjs`.
   - Ensure `report.ok` does not require Copilot when target is OpenCode.

4. Onboarding CLI:
   - Add `scripts/onboard.mjs`.
   - Add `scripts/onboard.test.mjs`.
   - Support `--host`, `--target`, `--set-default`, `--yes`, `--json`, `--smoke`.
   - Keep secrets out of process args and files.

5. Setup:
   - Add `--target` parsing to `setup.sh`.
   - Remove common Copilot hard requirement.
   - Delegate target checks/default write to `scripts/onboard.mjs`.
   - Gate Copilot reviewer-agent setup by selected target.
   - Add setup tests if/when shell behavior is covered; otherwise add a documented manual validation matrix.

6. Hooks:
   - Make `hooks/prewarm-daemon.sh` target-aware.
   - Add test seam if practical; otherwise add a shell-level smoke in validation docs.

7. Docs:
   - Update README install sections with companion-aware setup commands.
   - Link this handoff from `docs/MVP_TRACKER.md`.
   - Keep the "attach your companion" language consistent.

8. Validation:
   - `node --check bridge-server/server.mjs`
   - `node --check lib/target-diagnostics.mjs`
   - `node --check scripts/onboard.mjs`
   - `node --test $(find bridge-server lib scripts hooks templates -name '*.test.mjs')`
   - Manual OpenCode-only setup on a machine without `copilot`.
   - Manual Copilot-only setup on a machine without `opencode`.

## Acceptance Criteria

- A user can run OpenCode-only setup without installing Copilot.
- A user can run Copilot-only setup without installing OpenCode.
- Setup output clearly states which target is configured.
- `doctor --json` includes target readiness and actionable next steps.
- `agent_status({ diagnostics: true })` includes the same target readiness.
- SessionStart does not start Copilot daemon when default target is OpenCode.
- Existing Copilot users keep working.
- Existing `copilot_*` aliases keep working.
- No onboarding path asks for or stores provider secrets.
- No smoke test runs by default if it would consume AI quota.

## Open Questions

- Should setup write `default-target` automatically when `--target` is passed, or require `--set-default`? Recommendation: write automatically for `setup.sh --target`, require `--set-default` for standalone diagnostic-only `onboard.mjs`.
- Should OpenCode permissions be configured by generating a companion agent profile? Recommendation: not in the first onboarding pass; document permission config and keep dangerous auto-approval opt-in.
- Should the bootstrap fallback remain `opencode` after target onboarding exists? Resolved: no. The implemented bridge removed the fallback and returns `TARGET_UNCONFIGURED` with onboarding guidance.
- Should `setup.sh --target auto --yes` choose OpenCode if both are installed? Recommendation: no. Fail and ask for explicit target to preserve the "attach your companion" posture.
