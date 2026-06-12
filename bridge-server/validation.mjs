// Pure-function helpers for the copilot-bridge MCP server (v6.1).
//
// Internal action validator for the split MCP tools:
// copilot_send | copilot_wait | copilot_status | copilot_reply | copilot_cancel.
// The server injects the action before validation. Error
// messages are prefixed with `copilot:` so MCP clients can surface them as
// synchronous tool-call rejections.
//
// Nothing in here opens sockets, spawns processes, or reads state files —
// it's safe to import from tests without side effects other than appending
// a line to the private runtime bridge log on the `log()` helper.

import {
  readdirSync,
  statSync,
  realpathSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  chmodSync,
} from 'node:fs';
import { isAbsolute, join, sep as pathSep } from 'node:path';

import { plansDir, detectHost } from '../lib/host.mjs';
import { bridgeLogFile } from '../lib/runtime-paths.mjs';

// --- Logger -----------------------------------------------------------------

export const BRIDGE_LOG_MAX_BYTES = 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;

export function getBridgeLogFile() {
  return bridgeLogFile();
}

function chmodPrivate(path) {
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch {}
}

export function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${ts} [${level}] ${msg}\n`;
  const logFile = getBridgeLogFile();
  try {
    if (existsSync(logFile) && statSync(logFile).size > BRIDGE_LOG_MAX_BYTES) {
      // v6.1 C4: keep the previous log in .bak instead of truncating in
      // place. Truncate-on-rotate dropped the most recent diagnostic data
      // exactly when something went wrong enough to fill the log.
      try {
        renameSync(logFile, logFile + '.bak');
        chmodPrivate(logFile + '.bak');
      }
      catch { writeFileSync(logFile, '', { mode: PRIVATE_FILE_MODE }); chmodPrivate(logFile); }
    }
    appendFileSync(logFile, line, { mode: PRIVATE_FILE_MODE });
    chmodPrivate(logFile);
  } catch { /* best-effort */ }
  if (level === 'WARN' || level === 'ERROR' || level === 'FATAL') {
    try { process.stderr.write(line); } catch {}
  }
}

// --- Constants --------------------------------------------------------------

export const VALID_ACTIONS   = new Set(['send', 'wait', 'status', 'reply', 'cancel']);
export const VALID_MODES     = new Set(['PLAN', 'ANALYZE', 'EXECUTE']);
export const VALID_TEMPLATES = new Set(['general', 'research', 'plan_review']);
export const VALID_PARALLEL_STRATEGIES = new Set(['auto', 'always', 'never']);
export const DEFAULT_MODE    = 'EXECUTE';
export const DEFAULT_PARALLEL = 'auto';

// Field surface per action. Anything outside these is an "unknown key" error.
//
// Session-id input fields (either accepted, normalized to internal `host_session_id`):
//   - claude_session_id: legacy Claude-host alias. The Claude subagent reads
//     $CLAUDE_CODE_SESSION_ID via Bash at activation and forwards it on every
//     call (Claude Code does NOT expand ${VAR} in MCP env: blocks).
//   - host_session_id: host-neutral alias for any caller (Codex if MCP _meta
//     adoption fails; future hosts; tests). Functionally identical to the
//     above on input.
// On Codex, the bridge also reads request.params._meta["x-codex-turn-metadata"]
// .session_id directly in server.mjs's MCP handler — that path bypasses
// the per-arg field entirely (host-injected, can't be spoofed by the agent).
const ALLOWED_FIELDS = {
  send:   new Set(['action', 'task', 'mode', 'template', 'template_args', 'cwd', 'thread', 'max_wait_sec', 'parallel', 'claude_session_id', 'host_session_id']),
  wait:   new Set(['action', 'job_id', 'max_wait_sec', 'claude_session_id', 'host_session_id']),
  status: new Set(['action', 'job_id', 'verbose', 'claude_session_id', 'host_session_id']),
  reply:  new Set(['action', 'job_id', 'message', 'claude_session_id', 'host_session_id']),
  cancel: new Set(['action', 'job_id', 'claude_session_id', 'host_session_id']),
};

// Per-template allowed keys. Plan_review and general have disjoint key sets;
// research currently has none. Validating per template (instead of one global
// set) prevents `scope_hint` from being silently accepted on plan_review and
// vice-versa.
const VALID_TEMPLATE_ARGS_KEYS_BY_TEMPLATE = {
  general:     new Set(['scope_hint']),
  research:    new Set(),
  plan_review: new Set(['plan_path', 'focus_directive']),
};
const SCOPE_HINT_MAX_CHARS = 500;

// --- Prompt templates -------------------------------------------------------

export function shouldUseFleet({ parallel = DEFAULT_PARALLEL, template = 'general', mode = DEFAULT_MODE, task = '' } = {}) {
  if (parallel === 'always') return true;
  if (parallel === 'never') return false;
  if (parallel !== 'auto') return false;
  if (template === 'plan_review') return true;
  const text = String(task || '');
  if (template === 'research') {
    return text.length > 80 || /\b(compare|survey|latest|recent|sources|research|across|multiple)\b/i.test(text);
  }
  if (mode === 'ANALYZE') {
    return text.length > 120 || /\b(review|audit|investigate|across|multiple|multi[- ]?file|large|exhaustive)\b/i.test(text);
  }
  return text.length > 180 ||
    /\b(refactor|migration|feature|implement|across|multiple|multi[- ]?file|review|audit|exhaustive|parallel)\b/i.test(text);
}

export function formatGeneralTemplate({ task, mode, scope_hint, parallel }) {
  const analyzeLine =
    'Do not modify any files — no `edit`, `write`, or file-mutating `shell` commands. Read-only tools (`view`, `grep`, `glob`, `web_search`, `web_fetch`, and the `task` tool for read-only sub-agents) are fine. ' +
    'For files >200 LOC, scope your analysis: pick one section (imports/types, functions, error paths, etc.) per turn rather than reading the whole file at once. ' +
    'If the task names a specific concern, focus there first; defer comprehensive review to a follow-up. ' +
    'If `template_args.scope_hint` is provided, treat it as the binding scope for this turn.';
  const modeLine =
    mode === 'EXECUTE'
      ? 'You may use `edit`, `write`, `shell`, and the `task` tool. Be precise about file paths and the exact changes you intend.'
      : mode === 'PLAN'
        ? 'Do not modify any files — produce a plan only. Read-only tools (`view`, `grep`, `glob`, `web_search`, `web_fetch`, and read-only sub-agents) are fine. End the answer with a concrete, numbered implementation plan.'
        : analyzeLine;
  const label = mode === 'EXECUTE' ? 'EXECUTE' : mode === 'PLAN' ? 'PLAN' : 'ANALYZE';
  // /fleet is a prompt-body slash command and MUST sit at the very start of
  // the prompt body to be recognised by Copilot's parser. When parallel is
  // true we drop the literal `TASK:` prefix so the slash command is the
  // first non-whitespace token — fleet expects the objective immediately
  // after `/fleet `.
  const useFleet = shouldUseFleet({ parallel, template: 'general', mode, task });
  const taskLine = useFleet ? `/fleet ${task}` : `TASK: ${task}`;
  const lines = [
    taskLine,
    '',
    `Mode: ${label}`,
    modeLine,
  ];
  if (scope_hint) lines.push(`Scope: ${scope_hint}`);
  lines.push('', 'Return: a concise answer plus the list of files you inspected or changed.');
  return lines.join('\n');
}

export function formatResearchTemplate({ task, parallel }) {
  const body = [
    'You are a research assistant. The user wants a focused, evidence-backed answer to:',
    '',
    `  ${task}`,
    '',
    'Use `web_search` and `web_fetch` as needed. Read at least 2-3 reputable sources before answering.',
    'Use only `web_search` and `web_fetch` — no shell, no file edits.',
    '',
    'Anti-hallucination rules (strict):',
    "- Only claim a fact, URL, file path, function, constant, or command exists if you JUST verified it in THIS turn via a tool call. Do not cross-reference prior conversation context or things you vaguely remember from training.",
    "- If the question asks about the user's own repo/files and you have not directly read them in this turn with a tool call, say so explicitly instead of inferring. Never describe the user's files from search-result bleed-through.",
    "- When quoting a source, prefer verbatim text inside backticks over paraphrase. If you can't quote, label the claim \"(inferred)\" so the reader knows.",
    '- If search results disagree or are thin, surface that disagreement — do not collapse it into a single confident answer.',
    '',
    'Return a structured response:',
    '1. Direct answer (1-3 sentences)',
    '2. Key findings (bullet points with concrete details)',
    '3. Caveats / dissenting views (if any)',
    '4. Sources (URLs you actually fetched, with one-line descriptions)',
    '',
    'Be concise. Skip filler.',
  ].join('\n');
  return maybeFleetPrefix(body, shouldUseFleet({ parallel, template: 'research', task }));
}

export function formatPlanReviewTemplate({ template_args, parallel }) {
  const planPath = template_args?.plan_path;
  const focus = template_args?.focus_directive;
  if (!planPath) throw new Error('internal: plan_review reached formatter without plan_path');
  const body = [
    'You are a senior software architect reviewing an implementation plan produced by another AI coding',
    'assistant. The plan lives at:',
    '',
    `  ${planPath}`,
    '',
    'Read it with the `view` tool. Then use `view`, `grep`, and `glob` on the project codebase to verify',
    "that files, functions, APIs, and patterns referenced in the plan actually exist and match the plan's",
    'description.',
    '',
    'Review priorities (in order):',
    '1. Correctness — Will the changes solve the stated problem? Wrong assumptions or misunderstood APIs?',
    '2. Completeness — Missing steps, unhandled edge cases, files that need changes but are not listed?',
    '3. Safety — Could the changes break existing functionality or cause regressions?',
    '4. Consistency — Do the changes follow codebase patterns? Internal contradictions?',
    '5. Verification — Are there adequate type-check, lint, and test steps?',
    '',
    focus ? `[FOCUS DIRECTIVE: ${focus}]` : '',
    '',
    'DO NOT flag: style preferences, equivalent alternatives, theoretical concerns without evidence,',
    "or pre-existing issues outside the plan's scope.",
    '',
    'DO NOT modify any files. Report findings — do not attempt to fix the plan or the code yourself.',
    '',
    'Respond with:',
    '- VERDICT: "approve" or "revise"',
    '- A numbered list of concrete findings, each with file path and specific issue',
    '- A brief overall assessment (2-3 sentences)',
  ].filter(Boolean).join('\n');
  return maybeFleetPrefix(body, shouldUseFleet({ parallel, template: 'plan_review' }));
}

export function formatPrompt({ template, task, mode, template_args, parallel }) {
  switch (template || 'general') {
    case 'general':     return formatGeneralTemplate({ task, mode, scope_hint: template_args?.scope_hint, parallel });
    case 'research':    return formatResearchTemplate({ task, parallel });
    case 'plan_review': return formatPlanReviewTemplate({ template_args, parallel });
    default: throw new Error(`unknown template: ${template}`);
  }
}

// Helper: prepend `/fleet ` to a multi-line template body so the slash
// command sits at the very first non-whitespace token of the prompt
// (Copilot's parser requirement). The rest of the body — role
// description, rules, return format — becomes the orchestrator's
// objective verbatim and is propagated to dispatched sub-agents.
function maybeFleetPrefix(body, useFleet) {
  return useFleet ? `/fleet ${body}` : body;
}

// Rubber-duck cross-examination wrapper — always appended unconditionally.
// This is how rubber-duck is "always on": the server injects it for every
// send. It is NOT exposed as a tool parameter. There is no way to disable it
// through the public API.
export function appendRubberDuckReview(formatted) {
  return [
    formatted,
    '',
    '---',
    '',
    'CROSS-EXAMINATION STEP (mandatory before returning):',
    '',
    'After you have produced your initial answer, invoke the `rubber-duck` sub-agent via your `task` tool to critique your own response. Pass your draft answer as the sub-agent input along with a short copy of the original task. Ask the sub-agent to look for:',
    '  1. Claims not backed by a tool call you made in this turn (hallucinated files, functions, flags, URLs).',
    '  2. Cross-context conflation (mixing web-search results with details about the user files you did not read).',
    '  3. Overlooked edge cases or assumptions worth flagging.',
    '  4. Internal inconsistencies in the draft.',
    '',
    "Incorporate the rubber-duck's findings into your final answer. If the critique surfaces a Confirmed hallucination, REMOVE the offending claim. Prefix your final message with one of:",
    '  `RUBBER-DUCK: clean.`   (if the critique approved)',
    '  `RUBBER-DUCK: revised — <1-line summary of what you changed>.`',
    '',
    'Do NOT skip this step. It is a server-enforced, always-on quality gate.',
  ].join('\n');
}

// --- Plan path resolution ---------------------------------------------------

// PLANS_DIR can be overridden via COPILOT_PLANS_DIR for testing; otherwise
// it routes through lib/host.mjs (so Codex resolves to ~/.codex/plans/
// instead of Claude's directory). Resolved per call so tests can set the
// env var without re-importing the module.
export function getPlansDir() {
  return process.env.COPILOT_PLANS_DIR || plansDir(detectHost());
}
export const PLANS_DIR = getPlansDir();

export function resolveLatestPlanPath() {
  const plansDir = getPlansDir();
  let entries;
  try { entries = readdirSync(plansDir); }
  catch (err) { throw new Error(`copilot: plans directory not readable (${plansDir}): ${err.message}`); }
  const candidates = entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => { const full = join(plansDir, f); return { full, mtimeMs: statSync(full).mtimeMs }; })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`copilot: plan_path="latest" but no .md files found in ${plansDir}`);
  }
  return candidates[0].full;
}

// --- Action boundary validation ---------------------------------------------

function assertKnownFields(action, args) {
  const allowed = ALLOWED_FIELDS[action];
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new Error(`copilot: unknown field "${key}" for action="${action}" (allowed: ${[...allowed].join(', ')})`);
    }
  }
}

function assertString(name, value, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return;
    throw new Error(`copilot: ${name} is required`);
  }
  if (typeof value !== 'string') throw new Error(`copilot: ${name} must be a string`);
}

function assertBoolean(name, value) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`copilot: ${name} must be a boolean`);
}

function assertThreadName(value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new Error('copilot: thread must be a string');
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`copilot: thread must match [a-zA-Z0-9._-]+ (got "${value}")`);
  }
}

function assertCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') {
    throw new Error(
      'copilot: cwd is required for action="send" ' +
      '(pass the absolute target repo/worktree path; refusing to default to the bridge process cwd)',
    );
  }
  if (typeof cwd !== 'string') throw new Error('copilot: cwd must be a string');
  if (!isAbsolute(cwd)) throw new Error(`copilot: cwd must be an absolute path, got "${cwd}"`);
  let st;
  try { st = statSync(cwd); }
  catch { throw new Error(`copilot: cwd does not exist: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`copilot: cwd is not a directory: ${cwd}`);
}

// The per-action validators mutate their input where it's useful (e.g.
// plan_path "latest" → resolved absolute path) and return a normalised
// argument object. The returned shape is what the server hands off to the
// handlers; it always includes the resolved defaults.

export function validateCopilotArgs(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {};
  const action = args.action;
  if (!action) throw new Error('copilot: action is required (one of: send, wait, status, reply, cancel)');
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`copilot: action must be one of send|wait|status|reply|cancel, got "${action}"`);
  }
  assertKnownFields(action, args);
  switch (action) {
    case 'send':   return validateSend(args);
    case 'wait':   return validateWait(args);
    case 'status': return validateStatus(args);
    case 'reply':  return validateReply(args);
    case 'cancel': return validateCancel(args);
    default:       throw new Error(`copilot: unhandled action "${action}"`);
  }
}

// Accept either input alias and normalize to a single internal value.
// host_session_id is the host-neutral name introduced for the dual-host
// rollout; claude_session_id remains accepted unchanged so existing Claude
// callers (the Markdown subagent in templates/copilot-companion.md) need
// no code changes. If both are present they must agree — disagreement is
// almost certainly a caller bug worth surfacing rather than silently
// preferring one.
function normalizeHostSid(args) {
  const claudeRaw = args.claude_session_id;
  const hostRaw = args.host_session_id;
  if (claudeRaw == null && hostRaw == null) return null;
  for (const [name, raw] of [['claude_session_id', claudeRaw], ['host_session_id', hostRaw]]) {
    if (raw == null) continue;
    if (typeof raw !== 'string' || !raw) {
      throw new Error(`copilot: ${name} must be a non-empty string when provided`);
    }
  }
  if (claudeRaw != null && hostRaw != null && claudeRaw !== hostRaw) {
    throw new Error('copilot: claude_session_id and host_session_id provided with different values; pass only one');
  }
  return claudeRaw ?? hostRaw;
}

function validateReply(args) {
  // v6.1 D4: peer-steering. Both fields strictly required — there is no
  // sensible default for either.
  assertString('job_id', args.job_id);
  assertString('message', args.message);
  if (args.message.length > 8000) {
    throw new Error(`copilot: reply.message too long (${args.message.length} > 8000 chars)`);
  }
  return { action: 'reply', job_id: args.job_id, message: args.message, host_session_id: normalizeHostSid(args) };
}

function validateCancel(args) {
  assertString('job_id', args.job_id);
  return { action: 'cancel', job_id: args.job_id, host_session_id: normalizeHostSid(args) };
}

function validateWait(args) {
  assertString('job_id', args.job_id);
  if (args.max_wait_sec !== undefined && typeof args.max_wait_sec !== 'number') {
    throw new Error('copilot: max_wait_sec must be a number');
  }
  return { action: 'wait', job_id: args.job_id, max_wait_sec: args.max_wait_sec, host_session_id: normalizeHostSid(args) };
}

function validateStatus(args) {
  assertString('job_id', args.job_id, { optional: true });
  assertBoolean('verbose', args.verbose);
  return { action: 'status', job_id: args.job_id || null, verbose: !!args.verbose, host_session_id: normalizeHostSid(args) };
}

function validateSend(args) {
  const template = args.template || 'general';
  if (!VALID_TEMPLATES.has(template)) {
    throw new Error(`copilot: template must be one of ${[...VALID_TEMPLATES].join('|')}, got "${template}"`);
  }

  const mode = args.mode || DEFAULT_MODE;
  if (!VALID_MODES.has(mode)) {
    throw new Error(`copilot: mode must be one of ${[...VALID_MODES].join('|')}, got "${mode}"`);
  }

  // `task` is required for general/research; plan_review drives its prompt
  // from plan_path and ignores task.
  const needsTask = template === 'general' || template === 'research';
  if (needsTask) assertString('task', args.task);
  if (!needsTask && args.task) {
    log('WARN', 'copilot: task ignored for template="plan_review"');
  }

  const ta = args.template_args ?? {};
  if (typeof ta !== 'object' || Array.isArray(ta)) {
    throw new Error('copilot: template_args must be a plain object');
  }
  const allowedTaKeys = VALID_TEMPLATE_ARGS_KEYS_BY_TEMPLATE[template] ?? new Set();
  for (const key of Object.keys(ta)) {
    if (!allowedTaKeys.has(key)) {
      const allowedDesc = allowedTaKeys.size > 0 ? [...allowedTaKeys].join(', ') : '(none)';
      throw new Error(`copilot: unknown template_args key "${key}" for template="${template}" (allowed: ${allowedDesc})`);
    }
  }
  if (template === 'general' && ta.scope_hint !== undefined) {
    if (typeof ta.scope_hint !== 'string') {
      throw new Error('copilot: template_args.scope_hint must be a string');
    }
    if (ta.scope_hint.length > SCOPE_HINT_MAX_CHARS) {
      throw new Error(`copilot: template_args.scope_hint too long (${ta.scope_hint.length} > ${SCOPE_HINT_MAX_CHARS} chars)`);
    }
  }

  if (template === 'plan_review') {
    if (!ta.plan_path || typeof ta.plan_path !== 'string') {
      throw new Error(
        'copilot: template="plan_review" requires template_args.plan_path ' +
        '(absolute path to the plan .md file, or "latest")',
      );
    }
    if (ta.plan_path === 'latest') {
      ta.plan_path = resolveLatestPlanPath();
      log('INFO', 'copilot:', `plan_path=latest resolved to ${ta.plan_path}`);
    }
    if (ta.plan_path.includes('<') || ta.plan_path.includes('>')) {
      throw new Error(`copilot: template_args.plan_path looks like an un-substituted placeholder: "${ta.plan_path}"`);
    }
    if (!isAbsolute(ta.plan_path)) {
      throw new Error(`copilot: template_args.plan_path must be absolute, got "${ta.plan_path}"`);
    }
    let st;
    try { st = statSync(ta.plan_path); }
    catch { throw new Error(`copilot: template_args.plan_path does not exist: ${ta.plan_path}`); }
    if (!st.isFile()) throw new Error(`copilot: template_args.plan_path is not a file: ${ta.plan_path}`);
    // v6.1 A8: resolve symlinks and verify the real path is inside PLANS_DIR.
    // Without this, a symlink at ~/.claude/plans/foo.md → /etc/passwd would
    // be passed verbatim to the prompt template and read by Copilot.
    let realPath;
    try { realPath = realpathSync(ta.plan_path); }
    catch { throw new Error(`copilot: template_args.plan_path could not be resolved: ${ta.plan_path}`); }
    const realPlansDir = (() => { try { return realpathSync(getPlansDir()); } catch { return getPlansDir(); } })();
    const inside = realPath === realPlansDir || realPath.startsWith(realPlansDir + pathSep);
    if (!inside) {
      throw new Error(`copilot: template_args.plan_path resolves outside ${getPlansDir()}: ${realPath}`);
    }
    ta.plan_path = realPath;
    if (ta.focus_directive !== undefined && typeof ta.focus_directive !== 'string') {
      throw new Error('copilot: template_args.focus_directive must be a string');
    }
  }
  // Note: pre-§D this branch had an `else if (template_args nonempty) → WARN
  // "template ignores template_args"`. After §D introduced per-template
  // template_args validation (`VALID_TEMPLATE_ARGS_KEYS_BY_TEMPLATE`), any
  // key present is either accepted by the formatter (general's scope_hint)
  // or already rejected upstream as an unknown key. The "ignores" warning is
  // false now and was misleading users about scope_hint being dropped.

  assertCwd(args.cwd);
  assertThreadName(args.thread);

  if (args.max_wait_sec !== undefined && typeof args.max_wait_sec !== 'number') {
    throw new Error('copilot: max_wait_sec must be a number');
  }

  // Fleet (parallel) handling. `auto` is the default: the bridge prepends
  // /fleet only when the task looks broad enough to benefit. `always` and
  // `never` are explicit overrides.
  if (args.parallel !== undefined && !VALID_PARALLEL_STRATEGIES.has(args.parallel)) {
    throw new Error('copilot: parallel must be one of auto|always|never');
  }
  const parallel = args.parallel || DEFAULT_PARALLEL;

  return {
    action: 'send',
    task: needsTask ? args.task : null,
    mode,
    template,
    template_args: ta,
    cwd: args.cwd,
    thread: args.thread || null,
    max_wait_sec: args.max_wait_sec,
    parallel,
    host_session_id: normalizeHostSid(args),
  };
}
