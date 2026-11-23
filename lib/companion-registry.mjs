// Each descriptor defines one companion runtime.
// This remains the single source of truth for what a companion can do at
// runtime and what it takes to get a user's machine ready to use it.
//
// Two concerns live side by side per descriptor but stay conceptually
// separate:
//
//   capabilities — "what can this companion do?" (send/wait/interventions/cancel…)
//                  consumed by the adapters, companion_catalog and companion_status.
//   onboarding   — "is this user's machine ready?" (install/auth/permission)
//                  consumed by lib/companion-diagnostics.mjs + scripts/onboard.mjs.
//
// This module is host- and side-effect-free apart from reading the saved
// default companion from settings.json (a cheap file read), so it is safe to
// import from both the MCP server and standalone CLI scripts.

import { readDefaultCompanion } from './settings.mjs';
import { usageFromAcp, usageFromCopilotOtel } from './usage.mjs';
import { probeOpenCodeAuth } from './opencode-cli.mjs';
import * as opencodeReader from './transcripts/opencode.mjs';
import * as copilotReader from './transcripts/copilot.mjs';
import * as codexReader from './transcripts/codex.mjs';
import * as claudeReader from './transcripts/claude.mjs';
import * as antigravityReader from './transcripts/antigravity.mjs';

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
export function resolveClaudePermission(env = process.env) {
  const raw = String(env.AGENT_COMPANION_CLAUDE_PERMISSION || '').trim().toLowerCase();
  return CLAUDE_PERMISSION_MODES.find((mode) => mode.toLowerCase() === raw) || 'bypassPermissions';
}

// Read only the authentication verdict and method/provider labels, never identity fields.
export function probeClaudeAuth({ env = process.env, run, install }) {
  const binary = install?.binary || String(env.CLAUDE_BIN || '').trim() || 'claude';
  const result = run(binary, ['auth', 'status']);
  if (result.ok && !result.timedOut) {
    try {
      const auth = JSON.parse(result.output);
      if (auth?.loggedIn === true) return { authenticated: true, detail: `${auth.authMethod} (${auth.apiProvider})` };
      if (auth?.loggedIn === false) return { authenticated: false, detail: 'not logged in — run claude and sign in' };
    } catch {}
  }
  return { authenticated: 'unknown', detail: 'claude auth status gave no parsable loggedIn' };
}

const ANTIGRAVITY_PERMISSION_POLICIES = ['all', 'edit', 'none'];
export function resolveAntigravityPermission(env = process.env) {
  const raw = String(env.AGENT_COMPANION_ANTIGRAVITY_PERMISSION || '').trim().toLowerCase();
  return ANTIGRAVITY_PERMISSION_POLICIES.includes(raw) ? raw : 'all';
}

// agy 1.5.13, 2026-11-22. Without -w, security checks presence without reading the token.
export function probeAntigravityAuth({ run, platform = process.platform }) {
  if (platform !== 'darwin') return { authenticated: 'unknown', detail: `The Antigravity token store is unverified on ${platform}.` };
  const result = run('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity']);
  if (result.ok) return { authenticated: true, detail: 'Antigravity keychain item present' };
  if (result.status === 44) return { authenticated: false, detail: 'Antigravity keychain item absent' };
  return { authenticated: 'unknown', detail: 'The macOS keychain lookup could not verify sign-in.' };
}

export const COMPANIONS = {
  opencode: {
    id: 'opencode',
    runtime: {
      adapterKind: 'http', reader: opencodeReader, legacyModelOrder: 2,
      modelEnv: 'AGENT_COMPANION_OPENCODE_MODEL', modelPattern: /^[^/]+\/.+$/,
      modelHint: 'Use a provider/model id.', modelEnumeration: 'not cached',
      effortDefaultPrefix: 'the effort of ',
      nativeDefault: "OpenCode's configured default model",
      missingAuth: { code: 'needs_provider', label: 'provider/model' },
    },
    displayName: 'OpenCode',
    shortName: 'OpenCode',
    costKind: 'free-or-byo-provider',
    authKind: 'opencode-provider',
    implemented: true,
    capabilities: {
      send: true,
      wait: true,
      status: true,
      cancel: true,
      interventions: Object.freeze({ default: 'steer', steer: true, queue: 'bridge', interrupt: true }),
      resume: true,
      jsonEvents: true,
      acp: false,
      serverMode: true,
      // `opencode run --model` / server prompt `model` both accept a
      // provider/model pin, so model selection is supported at the adapter
      // level. A future companion that cannot pin a model sets this false and
      // the capability gate rejects a pinned model.
      modelSelection: true,
      effortSelection: true, effortLevels: null,
    },
    notes: [
      'Effort overrides any model-string variant and is validated before the session model write, treating it as persistent. Only an effort override queries variants; effective effort comes from the reported variant and its reasoningEffort setting, or stays null when inheriting.',
      'The adapter owns one authenticated OpenCode 2 HTTP server per job, with matching cwd and PWD.',
      'For new threads, routing uses the requested model, then AGENT_COMPANION_OPENCODE_MODEL, then the saved default. An omitted selection inherits OpenCode configuration.',
      'Usage: reads native step events and the paginated current turn, including tool steps. Tokens, USD cost and model are carried only when reported. Verified on 2.0.25 (2026-10-12) and 2.2.5 (2026-11-06) with ollama-cloud/gpt-oss:120b; vendor-reported total is preserved.',
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
      probe: probeOpenCodeAuth,
      nextSteps: [
        'Run `opencode`, then `/connect` and choose a provider.',
        'Verify provider connections with `opencode auth list --standalone --format json` on v2, or configured models with `opencode models` on v1.',
      ],
    },
    permission: {
      docs: 'https://opencode.ai/docs/permissions/',
      safeDefault: 'ask',
    },
    smoke: {
      safeByDefault: false,
      reason: 'Consumes provider quota and may require permission approval.',
    },
  },
  copilot: {
    id: 'copilot',
    runtime: {
      adapterKind: 'acp', reader: copilotReader, legacyModelOrder: 0, turnSelection: 'session',
      nativeDefault: "the account's default",
    },
    displayName: 'GitHub Copilot CLI',
    shortName: 'Copilot',
    costKind: 'subscription-or-limited-free',
    authKind: 'github-copilot',
    implemented: true,
    capabilities: {
      send: true,
      wait: true,
      status: true,
      cancel: true,
      interventions: Object.freeze({ default: null, steer: false, queue: false, interrupt: false }),
      resume: false,
      jsonEvents: true,
      acp: true,
      serverMode: false,
      // The session validates and confirms explicit model overrides.
      modelSelection: true,
      effortSelection: true, effortLevels: null,
    },
    notes: [
      "Copilot CLI 1.0.113 accepts --model bogus-model and then advertises it. Without the flag, session/new lists the model option's values and session/set_config_option (configId: model) refuses other ids with -32602: Invalid modelId '…': not one of this session's models.",
      'Effort uses the session model\'s advertised thought_level option, validated before a config write and confirmed by currentValue. Omission reports inherited effort. BYOK is testable; GitHub-hosted qualification remains blocked by session/new 403 on this account.',
      'Historical Copilot sessions were measured process-local (github/copilot-cli#1767). Cold follow-up now returns FOLLOWUP_UNSUPPORTED until account access and cross-process loading are qualified; it never silently starts fresh.',
      'Usage: Copilot CLI 1.0.94 reports token, cache and thought counters directly on session/prompt (measured 2026-10-09); the adapter prefers them, with no invented model or cost. Older versions fall back to the prompt\'s invoke_agent OTEL span, which also reports model and premium-request cost. The stream\'s usage_update is context occupancy, not turn tokens. Copilot 1.0.112 also reported counters on a cancelled prompt; 1.0.113 does not, even cancelled mid-turn after a usage_update, so a cancelled job reports no usage (recorded 2026-11-18, test/fixtures/acp/copilot/cancel.jsonl).',
    ],
    // Everything the ACP adapter needs to run this companion, so the adapter
    // itself carries no companion-id branch. The argv is the yolo mode the
    // Copilot adapter always ran with: the constituent flags rather than the
    // `--allow-all` alias (github/copilot-cli#1652 — the alias still paused for
    // confirmation in some versions).
    acp: {
      // Historical wire client name retained; no persistent process is implied.
      clientName: 'copilot-acp-daemon',
      args: () => [
        '--acp',
        '--no-ask-user',
        '--allow-all-tools',
        '--allow-all-paths',
        '--allow-all-urls',
      ],
      // Older CLIs need the OTEL exporter; newer prompt responses carry usage.
      env: ({ paths }) => ({
        COPILOT_OTEL_ENABLED: 'true',
        COPILOT_OTEL_FILE_EXPORTER_PATH: paths.otelTraces,
      }),
      // The adapter uses this declaration to allocate job-private OTEL output.
      rotate: ['otelTraces'],
      setModel: ({ sessionId, model }) => ['session/set_config_option', { sessionId, configId: 'model', value: model }],
      loadSession: false,
      // `--allow-all-*` means Copilot never asks; if it ever did, the answer
      // is the same one the flags give.
      permission: () => 'all',
      usage: ({ result, sessionId, sinceMs, paths, readFile }) => usageFromAcp(result, 'copilot-acp') || usageFromCopilotOtel(
        readFile(paths.otelTraces),
        { conversationId: sessionId, sinceMs },
      ),
      // Measured on 1.0.77 (the first five) and 1.0.83 (2026-09-11: the last
      // four, which the historical daemon's drift log surfaced on the first live job
      // after the refactor). None of the four carries the turn's tokens.
      updates: [
        'agent_thought_chunk', 'agent_message_chunk', 'plan', 'tool_call', 'tool_call_update',
        'available_commands_update', 'session_info_update', 'config_option_update', 'usage_update',
      ],
    },
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
    runtime: {
      adapterKind: 'app-server', reader: codexReader, legacyModelOrder: 1,
      modelEnv: 'AGENT_COMPANION_CODEX_MODEL',
      nativeDefault: "the setting in ~/.codex/config.toml or a trusted project's .codex/config.toml",
    },
    displayName: 'Codex CLI',
    shortName: 'Codex',
    costKind: 'subscription-or-api',
    authKind: 'chatgpt-or-api-key',
    implemented: true,
    capabilities: {
      send: true,
      wait: true,
      status: true,
      cancel: true,
      interventions: Object.freeze({ default: 'steer', steer: true, queue: 'bridge', interrupt: true }),
      resume: true,
      jsonEvents: true,
      acp: false,
      serverMode: true,
      // The app-server validates model ids at thread start or resume.
      modelSelection: true,
      effortSelection: true,
      effortLevels: null,
    },
    notes: [
      'Effort overrides use config.model_reasoning_effort on thread/start and thread/resume. Listed models use catalog validation; levels are unverified for models outside Codex\'s catalog. Reported reasoningEffort must match before delivery.',
      'The adapter owns a Codex app-server process for each job and resumes native threads on follow-up.',
      'Under the app-server adapter approvalPolicy is pinned to `never` and is not configurable: a client that accepts one approval escalates past the sandbox (measured), so the sandbox stays the hard boundary.',
      "Sandbox defaults to workspace-write with network ON by default (codex's own exec default is network OFF); opt out per bridge process with AGENT_COMPANION_CODEX_NETWORK=off. Override the sandbox mode with AGENT_COMPANION_CODEX_SANDBOX_MODE.",
      '.git/.codex/.agents stay read-only inside the workspace even under workspace-write (the carve-out wins over --add-dir; approval is forced to never, so there is no escalation prompt) — jobs that must write git internals need danger-full-access or bypass.',
      'Every delegated job persists a full-transcript rollout file under $CODEX_HOME/sessions (default ~/.codex/sessions) with no auto-cleanup in v1 — a new owned app-server cold-loads that history with `thread/resume` on follow-up.',
      "Inherits the user's own codex config by default (no --ignore-user-config): every enabled MCP server boots concurrently on each spawn and can stall the first turn up to its configured startup_timeout_sec; shell env is inherited into the child (shell_environment_policy.inherit=all by default) minus *KEY*/*SECRET*/*TOKEN* names.",
      'macOS Seatbelt sandboxes do not nest: running the bridge itself under sandbox-exec makes a sandboxed Codex command fail on its first sandboxed command — set AGENT_COMPANION_CODEX_SANDBOX_MODE=bypass inside the outer sandbox.',
      'Optional model pin: AGENT_COMPANION_CODEX_MODEL=<model id>; unset lets codex use its own configured default.',
      'Usage: the app-server reads `thread/tokenUsage/updated`, baselined at the turn\'s first model call so a resumed thread reports this turn, not the thread — flagged `partial` when a watch attached mid-turn.',
    ],
    binaryEnv: 'CODEX_BIN',
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
      // The closed set the knob accepts; anything else falls back to the safe
      // default and diagnostics say so (`source: fallback`).
      modes: ['read-only', 'workspace-write', 'danger-full-access', 'bypass'],
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
  claude: {
    id: 'claude',
    runtime: {
      adapterKind: 'stream-json', reader: claudeReader, legacyModelOrder: 4, turnSelection: 'joined-inputs',
      modelEnv: 'AGENT_COMPANION_CLAUDE_MODEL', nativeDefault: 'the Claude Code account default',
      modelNote: ' Claude Code validates the model id or alias.',
      dangerousPermission: 'Claude Code is set to run with all permission checks skipped (bypassPermissions); prompts are disabled.',
    },
    displayName: 'Claude Code',
    shortName: 'Claude Code',
    costKind: 'subscription-or-api',
    authKind: 'claude-plan-or-api-key',
    implemented: true,
    capabilities: {
      send: true, wait: true, status: true, cancel: true, resume: true,
      interventions: Object.freeze({ default: 'queue', steer: false, queue: 'native', interrupt: true }),
      jsonEvents: true, acp: false, serverMode: false, modelSelection: true,
      effortSelection: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    notes: [
      "Measured 2026-11-09 on Claude Code 2.1.319: runs the user's installed unmodified binary via -p stream-json, one cold process per job, with pinned --session-id and cold --resume; transcripts stay in Claude's native ~/.claude/projects.",
      'In-flight messages default to native queue; Claude decides whether they join the same or next turn. Interrupt uses send_now; steer is unsupported.',
      'AGENT_COMPANION_CLAUDE_PERMISSION selects a listed mode, defaulting to bypassPermissions; prompts are disabled (--permission-prompts none), and the default is reported as dangerous.',
      'Measured interruption uses a stdin control request and yields aborted_streaming or aborted_tools.',
      'The child denies both bridge MCP namespaces.',
      'Background tasks are disabled in the child.',
      "An omitted model inherits the user's Claude configuration; AGENT_COMPANION_CLAUDE_MODEL or a saved default overrides it.",
      'Usage is per-turn tokens from the native result; cost is reported only for fresh history because the native total is cumulative on resume.',
      'User/project settings, hooks, plugins and CLAUDE.md remain loaded.',
      'The bridge never reads or passes credentials.',
    ],
    binaryEnv: 'CLAUDE_BIN',
    binaryNames: ['claude'],
    versionArgs: ['--version'],
    install: {
      docs: 'https://code.claude.com/docs/en/setup',
      commands: ['npm install -g @anthropic-ai/claude-code', 'brew install --cask claude-code'],
    },
    auth: {
      docs: 'https://code.claude.com/docs/en/authentication',
      probe: probeClaudeAuth,
      nextSteps: ['Run `claude` once and sign in with your own Claude account (or set ANTHROPIC_API_KEY); the bridge never handles credentials.'],
    },
    permission: {
      docs: 'https://code.claude.com/docs/en/permission-modes',
      safeDefault: 'bypassPermissions',
      bridgeEnv: 'AGENT_COMPANION_CLAUDE_PERMISSION',
      modes: CLAUDE_PERMISSION_MODES,
      dangerousModes: ['bypassPermissions'],
    },
    smoke: {
      safeByDefault: false,
      reason: "Starts a real Claude Code turn and consumes the signed-in plan's limits or API credit.",
    },
  },
  antigravity: {
    id: 'antigravity',
    runtime: {
      adapterKind: 'acp', reader: antigravityReader, legacyModelOrder: 3, turnSelection: 'time-window',
      nativeDefault: "the account's default",
    },
    displayName: 'Google Antigravity',
    shortName: 'Antigravity',
    costKind: 'subscription-or-limited-free',
    authKind: 'google',
    implemented: true,
    capabilities: {
      send: true,
      wait: true,
      status: true,
      cancel: true,
      // Queue after a terminal response and interrupt via session/cancel, measured on agy 1.5.13 (2026-11-22).
      interventions: Object.freeze({ default: 'steer', steer: true, queue: 'bridge', interrupt: true }),
      resume: true,
      jsonEvents: true,
      acp: true,
      serverMode: false,
      // A model is a per-session config option on this server (see `acp.setModel`).
      modelSelection: true,
      effortSelection: true, effortLevels: null,
    },
    notes: [
      'Measured on macOS with agy 1.5.13 on 2026-11-22. agy acp answers protocol v1 when asked for v1 or v2. Cold session/load replays known history before its response. An unknown id also succeeds, with zero replayed updates.',
      'Model and effort use the model and thought_level session config options. The bridge confirms currentValue and reapplies overrides after load, which resets thought_level to high.',
      'The default all policy passes --dangerously-skip-permissions for parent and child tools. Under edit or none, the bridge answers allow or deny for parent tools. A subagent tool can wait indefinitely for approval because its permission request never reaches the ACP client.',
      'Turn usage sums the counters in prompt responses, including on cancellation. usage_update reports context occupancy. A turn ending on an upstream error can omit usage.',
      'On agy 1.5.13 (2026-11-22), end_turn can leave a command running past WaitMsBeforeAsync or a subagent yet to report. IsDaemon commands and pending ask_question calls can outlast the job. A child can stay ALIVE after its report appears in the parent messages with the child as sender. The bridge also treats KILLED as terminal.',
      'On agy 1.5.13 (2026-11-22), a second session/prompt steered running work. The first prompt answered end_turn within 10 ms with its own usage. Its command continued and the agent carried out the steer. The steer also answered end_turn with its own usage before the command finished. The final reply streamed with no prompt outstanding.',
      'The follow-on answer streams with its own paragraph breaks and no prompt response. A model call’s usage_update can precede a new tool call by milliseconds. An upstream error can omit the update. Extended turns report partial prompt usage. After end_turn, session/cancel stopped the background command without another reply.',
      'Session setup updates can cross the prompt write. Capacity retries delayed first output by 70 seconds. An extension request immediately after the prompt received -32601 while the prompt ran, acknowledging that the CLI had read past it.',
      'The CLI keeps its profile under ~/.gemini/antigravity-cli/. The measured macOS sign-in leaves a keychain item for service gemini, account antigravity.',
      "The free tier's interactions may be reviewed by Google staff unless the account opts out in Antigravity's own settings; agy acp exposes no such switch.",
      "Terms: the bridge is a stdio client of Google's CLI. The CLI holds the OAuth token and contacts Google. The bridge never holds that token. The operator bears the account risk (docs/MVP_TRACKER.md item 8).",
    ],
    acp: {
      clientName: 'agent-companion',
      args: ({ env }) => resolveAntigravityPermission(env) === 'all' ? ['acp', '--dangerously-skip-permissions'] : ['acp'],
      env: () => ({}),
      rotate: [],
      loadSession: true,
      loadRequiresReplay: true,
      receiptMethod: '_agent_companion/received',
      verbatimMessages: true,
      hasOpenWork: ({ toolCalls, sessionId, env }) => toolCalls.some(call => call.kind === 'execute'
        && call.input?.IsDaemon !== true && !['completed', 'failed', 'cancelled'].includes(call.status))
        || antigravityReader.hasUnreportedSubagent(sessionId, env),
      permission: resolveAntigravityPermission,
      // On agy 1.5.13 (2026-11-22) inputTokens excludes cachedReadTokens.
      usage: ({ result }) => usageFromAcp(result, 'antigravity-acp', { cachedOutsideInput: true }),
      updates: [
        'agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update',
        'available_commands_update', 'session_info_update', 'config_option_update', 'usage_update', 'user_message_chunk',
      ],
      setModel: ({ sessionId, model }) => ['session/set_config_option', { sessionId, configId: 'model', value: model }],
    },
    binaryEnv: 'ANTIGRAVITY_BIN',
    binaryNames: ['agy'],
    versionArgs: ['--version'],
    install: {
      docs: 'https://antigravity.google/docs/ide/extensions/acp/',
      commands: ['brew install --cask antigravity-cli'],
    },
    auth: {
      docs: 'https://antigravity.google/docs/ide/extensions/acp/',
      probe: probeAntigravityAuth,
      nextSteps: ['Run `agy acp --login` in a terminal and sign in with your Google account.'],
    },
    permission: {
      docs: 'https://antigravity.google/docs/ide/extensions/acp/',
      safeDefault: 'all',
      bridgeEnv: 'AGENT_COMPANION_ANTIGRAVITY_PERMISSION',
      modes: ANTIGRAVITY_PERMISSION_POLICIES,
      dangerousModes: [],
      // A subagent's approval request never reaches an ACP client (measured on agy 1.5.13).
      attendedModes: ['edit', 'none'],
    },
    smoke: {
      safeByDefault: false,
      reason: 'Starts a real Antigravity turn and consumes the account\'s daily request quota.',
    },
  },
};

export const COMPANION_IDS = new Set(Object.keys(COMPANIONS));
// Preserve the order in which the original migration reported conflicts.
export const legacyModelIds = listCompanionIds().sort((a, b) => COMPANIONS[a].runtime.legacyModelOrder - COMPANIONS[b].runtime.legacyModelOrder);
// The original model API and unsuffixed legacy default-model file used Copilot.
export const LEGACY_MODEL_COMPANION = COMPANIONS.copilot.id;

export function modelHint(id) {
  return getCompanionById(id)?.runtime.modelHint ?? 'Model ids must contain no whitespace.';
}

export function defaultCompanionInfo(env = process.env) {
  return readDefaultCompanion(env);
}

// The configured default companion id, or null when nothing is configured.
// There is no silent fallback — callers that need a companion must handle null
// (the bridge turns it into an explicit onboarding error).
export function defaultCompanionId(env = process.env) {
  const { companion } = defaultCompanionInfo(env);
  return companion ? String(companion).trim().toLowerCase() : null;
}

// Normalize an explicit value; falls back to the configured default only when
// the value is empty. Returns '' when nothing resolves (never guesses).
export function normalizeCompanionId(value, env = process.env) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw) return raw;
  return defaultCompanionId(env) || '';
}

export function getCompanion(id, env = process.env) {
  return COMPANIONS[normalizeCompanionId(id, env)] || null;
}

// Raw descriptor by exact id, no default resolution — for onboarding/CLI use
// where "no companion configured" must not silently pick one.
export function getCompanionById(id, env = process.env) {
  const key = String(id || '').trim().toLowerCase();
  return Object.hasOwn(COMPANIONS, key) ? COMPANIONS[key] : null;
}

export function listCompanionIds() {
  return Object.keys(COMPANIONS);
}

export function listCompanions(env = process.env, selected = defaultCompanionId(env)) {
  return Object.values(COMPANIONS).map(({ runtime, ...companion }) => ({
    ...companion,
    default: selected != null && companion.id === selected,
  }));
}
