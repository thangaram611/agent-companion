// Target registry — the implementation-level companion registry. Today a
// `target` id is the concrete companion runtime selected by agent_send; future
// strength routing should layer profiles/strengths on top of these descriptors.
// This remains the single source of truth for what a companion can do at
// runtime and what it takes to get a user's machine ready to use it.
//
// Two concerns live side by side per descriptor but stay conceptually
// separate:
//
//   capabilities — "what can this target do?" (send/wait/reply/parallel…)
//                  consumed by the bridge runtime + agent_status.
//   onboarding   — "is this user's machine ready?" (install/auth/permission)
//                  consumed by lib/target-diagnostics.mjs + scripts/onboard.mjs.
//
// This module is host- and side-effect-free apart from reading the
// default-target state (which is itself a cheap file read), so it is safe to
// import from both the MCP server and standalone CLI scripts.

import { readDefaultTarget } from './state.mjs';

export const TARGET_IDS = new Set(['opencode', 'copilot', 'codex']);

const TARGETS = {
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    costKind: 'free-or-byo-provider',
    authKind: 'opencode-provider',
    implemented: true,
    capabilities: {
      send: true,
      wait: true,
      status: true,
      cancel: true,
      reply: false,
      resume: false,
      jsonEvents: true,
      acp: false,
      serverMode: false,
      parallel: 'planned',
      // `opencode run --model` / server prompt `model` both accept a
      // provider/model pin, so model selection is supported at the adapter
      // level. A future companion that cannot pin a model sets this false and
      // the profile capability gate (server STEP C) rejects a pinned model.
      modelSelection: true,
    },
    notes: [
      'CLI adapter (default) uses `opencode run --format json --dir <cwd>`.',
      'Server adapter (`OPENCODE_RUNTIME_ADAPTER=server`) drives `opencode serve` over HTTP and adds reply/resume + streamed digests.',
      'CLI permission auto-approval is opt-in via `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip`; server mode relies on OpenCode\'s own permission config.',
      'Timeout defaults to 40 minutes and can be overridden with `AGENT_COMPANION_OPENCODE_TIMEOUT_MS`.',
      'Optional server-mode model: `AGENT_COMPANION_OPENCODE_MODEL=provider/model`.',
    ],
    binaryEnv: 'OPENCODE_BIN',
    timeoutEnv: 'AGENT_COMPANION_OPENCODE_TIMEOUT_MS',
    binaryNames: ['opencode'],
    versionArgs: ['--version'],
    install: {
      docs: 'https://opencode.ai/',
      commands: [
        'curl -fsSL https://opencode.ai/install | bash',
      ],
    },
    auth: {
      docs: 'https://opencode.ai/docs/providers/',
      // `opencode models` lists configured provider models in provider/model
      // form. Empty/failed output means "needs a provider", not a crash.
      checkCommands: [
        ['opencode', ['models']],
      ],
      nextSteps: [
        'Run `opencode`, then `/connect` and choose a provider.',
        'Run `opencode models` to verify configured models.',
      ],
    },
    permission: {
      docs: 'https://opencode.ai/docs/permissions/',
      safeDefault: 'ask',
      bridgeEnv: 'AGENT_COMPANION_OPENCODE_PERMISSION_MODE',
      dangerousMode: 'skip',
    },
    smoke: {
      safeByDefault: false,
      reason: 'Consumes provider quota and may require permission approval.',
    },
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    costKind: 'subscription-or-limited-free',
    authKind: 'github-copilot',
    implemented: true,
    capabilities: {
      send: true,
      wait: true,
      status: true,
      cancel: true,
      reply: true,
      resume: true,
      jsonEvents: true,
      acp: true,
      serverMode: false,
      parallel: 'fleet',
      // Copilot CLI accepts `--model`; the daemon serves all model-profiles.
      modelSelection: true,
    },
    notes: [
      'Adapter drives the Copilot ACP daemon.',
      'Reply/resume and `/fleet` parallel orchestration are Copilot-only.',
    ],
    binaryEnv: 'COPILOT_BIN',
    binaryNames: ['copilot', '/opt/homebrew/bin/copilot'],
    versionArgs: ['--version'],
    install: {
      docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
      commands: [
        'npm install -g @github/copilot',
        'brew install copilot-cli',
      ],
    },
    auth: {
      docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
      // No cheap auth probe that avoids starting an agent turn; treat as
      // unknown and instruct the user instead of spending quota to find out.
      checkCommands: [],
      nextSteps: [
        'Run `copilot login`, or start `copilot` and follow `/login`.',
        'Confirm your organization policy allows Copilot CLI.',
      ],
    },
    permission: {
      docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview',
      note: 'Workspace trust and tool approvals are handled by Copilot CLI.',
    },
    smoke: {
      safeByDefault: false,
      reason: 'Starts a real Copilot turn and may consume plan quota.',
    },
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    costKind: 'subscription-or-api',
    authKind: 'chatgpt-or-api-key',
    implemented: true,
    capabilities: {
      send: true,
      wait: true,
      status: true,
      cancel: true,
      // TRANSPORT-forced false, not architecture-forced — the earlier wording
      // here was measured wrong. `codex exec` is a one-shot non-interactive
      // subprocess with no control channel and nothing to reattach to, so on
      // THAT transport reply and resume are impossible. Codex itself has both:
      // `codex app-server`'s `turn/steer` is real mid-flight injection and
      // `thread/resume` rejoins a RUNNING thread after a bridge restart
      // (docs/RELIABILITY_REMEDIATION.md §2, verified 2026-08-10). Selecting
      // CODEX_RUNTIME_ADAPTER=appserver flips both to true below.
      reply: false,
      resume: false,
      jsonEvents: true,
      acp: false,
      serverMode: false,
      parallel: 'planned',
      // `codex exec -m/--model` accepts arbitrary ids (bare, or provider/id
      // under --oss); codex validates the id itself at spawn.
      modelSelection: true,
    },
    notes: [
      'CLI adapter (default) invokes `codex exec --json` as a one-shot non-interactive subprocess: send-only, because that pipe has no control channel and nothing to reattach to.',
      'App-server adapter (`CODEX_RUNTIME_ADAPTER=appserver`) talks JSON-RPC to a shared broker owning one `codex app-server`, and adds reply (`turn/steer`, mid-flight, no restart), restart resume (`thread/resume` rejoins a running thread) and streamed digests.',
      'Under the app-server adapter approvalPolicy is pinned to `never` and is not configurable: a client that accepts one approval escalates past the sandbox (measured), so the sandbox stays the hard boundary.',
      "Sandbox defaults to workspace-write with network ON by default (codex's own exec default is network OFF); opt out per job with AGENT_COMPANION_CODEX_NETWORK=off. Override the sandbox mode with AGENT_COMPANION_CODEX_SANDBOX_MODE.",
      '.git/.codex/.agents stay read-only inside the workspace even under workspace-write (the carve-out wins over --add-dir; approval is forced to never, so there is no escalation prompt) — jobs that must write git internals need danger-full-access or bypass.',
      'Every delegated job persists a full-transcript rollout file under $CODEX_HOME/sessions (default ~/.codex/sessions) with no auto-cleanup in v1 — that rollout is what `appserver` recovery reads back (`thread/resume` re-loads a thread from it even after the broker dies). The `codex exec resume <thread_id>` lever this once anticipated was dropped, not deferred.',
      "Inherits the user's own codex config by default (no --ignore-user-config): every enabled MCP server boots concurrently on each spawn and can stall the first turn up to its configured startup_timeout_sec; shell env is inherited into the child (shell_environment_policy.inherit=all by default) minus *KEY*/*SECRET*/*TOKEN* names.",
      'macOS Seatbelt sandboxes do not nest: running the bridge itself under sandbox-exec makes a sandboxed `codex exec` spawn fail on its first sandboxed command — set AGENT_COMPANION_CODEX_SANDBOX_MODE=bypass inside the outer sandbox.',
      'Timeout defaults to 40 minutes and can be overridden with AGENT_COMPANION_CODEX_TIMEOUT_MS.',
      'Optional model pin: AGENT_COMPANION_CODEX_MODEL=<model id>; unset lets codex use its own configured default.',
    ],
    binaryEnv: 'CODEX_BIN',
    timeoutEnv: 'AGENT_COMPANION_CODEX_TIMEOUT_MS',
    binaryNames: ['codex'],
    versionArgs: ['--version'],
    install: {
      docs: 'https://learn.chatgpt.com/docs/codex',
      commands: [
        'npm install -g @openai/codex',
        'brew install --cask codex',
      ],
    },
    auth: {
      docs: 'https://learn.chatgpt.com/docs/codex',
      // `codex login status` is a cheap, safe probe: no agent turn, no
      // billing. Verified live: exits 0 (stderr "Logged in using ChatGPT")
      // when authenticated, exits non-zero (stderr "Not logged in", empty
      // stdout in both cases) when logged out — see checkByExitCode below.
      checkCommands: [
        ['codex', ['login', 'status']],
      ],
      // The stock stdout-based probeAuth would false-red this: 0.145.0
      // prints its verdict to STDERR with empty stdout in both the
      // logged-in and logged-out cases. Gate on exit code instead.
      checkByExitCode: true,
      nextSteps: [
        'Run `codex login` (ChatGPT plan, browser OAuth) or `codex login --device-auth` for headless/no-GUI login.',
        'Or authenticate with an API key: `printenv OPENAI_API_KEY | codex login --with-api-key`.',
      ],
    },
    permission: {
      docs: 'https://learn.chatgpt.com/docs/sandboxing',
      // Codex's true "safe" floor (read-only) cannot write files, which is
      // useless for the delegated edit work this bridge exists to run — so
      // safeDefault is the minimum viable edit-capable mode, not the most
      // restrictive one (unlike opencode's safeDefault:'ask').
      safeDefault: 'workspace-write',
      bridgeEnv: 'AGENT_COMPANION_CODEX_SANDBOX_MODE',
      // Two independently-dangerous modes (unlike opencode's single
      // dangerousMode): danger-full-access keeps the OS sandbox wrapper but
      // removes fs/network limits, bypass removes the sandbox entirely.
      // Both must surface as dangerous.
      dangerousModes: ['danger-full-access', 'bypass'],
    },
    smoke: {
      safeByDefault: false,
      reason: 'Starts a real Codex turn and consumes ChatGPT plan quota or API credit.',
    },
  },
};

// OpenCode and codex capabilities both depend on the selected runtime adapter.
// The static descriptors above are the single-shot CLI baselines; the daemon
// adapters (`OPENCODE_RUNTIME_ADAPTER=server`, `CODEX_RUNTIME_ADAPTER=appserver`)
// unlock reply/resume/serverMode. This reports "what the adapter supports";
// whether a SPECIFIC job can reply/resume right now is a per-job decision the
// bridge reports on the job response, keyed on the adapter that job started
// under.
export function openCodeServerAdapterSelected(env = process.env) {
  return String(env.OPENCODE_RUNTIME_ADAPTER || 'cli').trim().toLowerCase() === 'server';
}

// Deliberately a local parse rather than an import of the adapter's own
// `resolveCodexAdapter`, for the same reason the opencode predicate above is:
// this module is documented side-effect-free and is imported by standalone CLI
// scripts, while the adapter module pulls in child_process, net, the broker
// script and the shared registry. The two must agree on the spelling — a test
// asserts they do.
export function codexAppServerAdapterSelected(env = process.env) {
  return String(env.CODEX_RUNTIME_ADAPTER || 'exec').trim().toLowerCase() === 'appserver';
}

// One shape, two targets: the daemon adapter is what turns reply/resume on, and
// nothing else in the descriptor changes.
const ADAPTER_UPGRADES = {
  opencode: { selected: openCodeServerAdapterSelected, adapter: 'server' },
  codex: { selected: codexAppServerAdapterSelected, adapter: 'appserver' },
};

// The adapter value that unlocks reply/resume for a companion, or null when the
// companion has no daemon transport at all (copilot). The single reader of the
// table above outside this module's own resolution — a caller that re-spelled
// 'server'/'appserver' beside it would be writing the check that goes stale when
// a third companion grows a daemon.
export function daemonAdapterFor(companionId) {
  return ADAPTER_UPGRADES[String(companionId || '').trim().toLowerCase()]?.adapter || null;
}

function applyAdapterCapabilities(target, env = process.env) {
  const upgrade = target ? ADAPTER_UPGRADES[target.id] : null;
  if (!upgrade || !upgrade.selected(env)) return target;
  return {
    ...target,
    capabilities: { ...target.capabilities, reply: true, resume: true, serverMode: true },
    adapter: upgrade.adapter,
  };
}

export function defaultTargetInfo(env = process.env) {
  return readDefaultTarget(env);
}

// The configured default target id, or null when nothing is configured.
// There is no silent fallback — callers that need a target must handle null
// (the bridge turns it into an explicit onboarding error).
export function defaultTargetId(env = process.env) {
  const { target } = defaultTargetInfo(env);
  return target ? String(target).trim().toLowerCase() : null;
}

// Normalize an explicit value; falls back to the configured default only when
// the value is empty. Returns '' when nothing resolves (never guesses).
export function normalizeTargetId(value, env = process.env) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw) return raw;
  return defaultTargetId(env) || '';
}

export function isTargetAllowed(id) {
  return TARGET_IDS.has(normalizeTargetId(id));
}

export function getTarget(id, env = process.env) {
  return applyAdapterCapabilities(TARGETS[normalizeTargetId(id, env)] || null, env);
}

// Raw descriptor by exact id, no default resolution — for onboarding/CLI use
// where "no target configured" must not silently pick one.
export function getTargetById(id, env = process.env) {
  return applyAdapterCapabilities(TARGETS[String(id || '').trim().toLowerCase()] || null, env);
}

export function listTargetIds() {
  return Object.keys(TARGETS);
}

export function listTargets(env = process.env) {
  const selected = defaultTargetId(env);
  return Object.values(TARGETS).map((target) => ({
    ...applyAdapterCapabilities(target, env),
    default: selected != null && target.id === selected,
  }));
}
