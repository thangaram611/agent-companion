import { readDefaultTarget } from '../lib/state.mjs';

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
    },
    notes: [
      'MVP adapter uses `opencode run --format json --dir <cwd>`.',
      'Permission auto-approval is opt-in via `AGENT_COMPANION_OPENCODE_PERMISSION_MODE=skip`.',
      'Timeout defaults to 40 minutes and can be overridden with `AGENT_COMPANION_OPENCODE_TIMEOUT_MS`.',
      'Reply/resume will require OpenCode server or ACP mode.',
    ],
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
    },
    notes: [
      'Compatibility adapter preserving the existing ACP daemon path.',
      'Legacy `copilot_*` tools are aliases forced to this target.',
    ],
  },
};

export function defaultTargetInfo(env = process.env) {
  return readDefaultTarget(env);
}

export function defaultTargetId(env = process.env) {
  const { target } = defaultTargetInfo(env);
  return normalizeTargetId(target);
}

export function normalizeTargetId(value, env = process.env) {
  const raw = String(value || '').trim().toLowerCase();
  const id = raw || readDefaultTarget(env).target;
  return String(id || '').trim().toLowerCase();
}

export function isTargetAllowed(id) {
  return TARGET_IDS.has(normalizeTargetId(id));
}

export function getTarget(id) {
  return TARGETS[normalizeTargetId(id)] || null;
}

export function listTargets(env = process.env) {
  const selected = defaultTargetId(env);
  return Object.values(TARGETS).map((target) => ({
    ...target,
    default: target.id === selected,
  }));
}
