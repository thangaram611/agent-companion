import { resolveClaudePermission } from '../../lib/target-registry.mjs';
import { usageFromClaudeResult } from '../../lib/usage.mjs';

export function claudeArgs({ historyId, resume, model, effort, env }) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--replay-user-messages', '--include-partial-messages', '--permission-mode', resolveClaudePermission(env),
    '--permission-prompts', 'none', '--disallowedTools', 'mcp__plugin_agent-companion_agent-bridge__*',
    'mcp__agent-bridge__*', 'Agent(agent-companion)', resume ? '--resume' : '--session-id', historyId,
    ...(model === undefined ? [] : ['--model', model]), ...(effort === undefined ? [] : ['--effort', effort])];
}

export function claudeEnv(env, cwd) {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(key) || key.startsWith('CLAUDE_CODE_')) delete child[key];
  }
  return { ...child, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', PWD: cwd };
}

export function parseClaudeFrame(line) {
  try {
    const frame = JSON.parse(line);
    return frame && typeof frame.type === 'string' ? frame : null;
  } catch { return null; }
}

export function claudeTerminal(result, { interruptRequested = false, partialText = '', effectiveModel, includeCost = false } = {}) {
  let outcome, text, detail;
  if (interruptRequested && ['aborted_streaming', 'aborted_tools'].includes(result.terminal_reason)) {
    outcome = 'interrupted'; text = partialText;
  } else if (result.is_error === true || result.subtype !== 'success') {
    outcome = 'failed'; detail = result.terminal_reason || result.subtype;
    text = typeof result.result === 'string' && result.result ? result.result : partialText;
  } else {
    outcome = 'completed'; text = result.result;
  }
  return { outcome, text, ...(detail ? { detail } : {}),
    usage: usageFromClaudeResult(result, { includeCost, model: effectiveModel }),
    nativeRefs: { historyId: result.session_id }, effectiveModel };
}
