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

export const TARGET_IDS = new Set(['opencode', 'copilot']);

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
};

// OpenCode capabilities depend on the selected runtime adapter. The static
// descriptor above is the CLI-mode baseline; server mode
// (`OPENCODE_RUNTIME_ADAPTER=server`) unlocks reply/resume/serverMode. This
// reports "what the adapter supports"; whether a SPECIFIC job can reply/resume
// right now is a per-job decision the bridge reports on the job response.
export function openCodeServerAdapterSelected(env = process.env) {
  return String(env.OPENCODE_RUNTIME_ADAPTER || 'cli').trim().toLowerCase() === 'server';
}

function applyAdapterCapabilities(target, env = process.env) {
  if (!target || target.id !== 'opencode') return target;
  if (!openCodeServerAdapterSelected(env)) return target;
  return {
    ...target,
    capabilities: { ...target.capabilities, reply: true, resume: true, serverMode: true },
    adapter: 'server',
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
