import '../../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeArgs, claudeEnv, parseClaudeFrame, claudeTerminal } from './claude-protocol.mjs';
import { CLAUDE_PERMISSION_MODES, resolveClaudePermission } from '../../lib/target-registry.mjs';

test('Claude argv preserves literal denies, uses one history flag and omits inherited model', () => {
  const args = claudeArgs({ historyId: 'fresh', resume: false, env: {} });
  assert.deepEqual(args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--replay-user-messages', '--include-partial-messages', '--permission-mode', 'bypassPermissions',
    '--permission-prompts', 'none', '--disallowedTools', 'mcp__plugin_agent-companion_agent-bridge__*',
    'mcp__agent-bridge__*', 'Agent(agent-companion)', '--session-id', 'fresh']);
  const resume = claudeArgs({ historyId: 'saved', resume: true, model: 'haiku', env: { AGENT_COMPANION_CLAUDE_PERMISSION: 'ACCEPTEDITS' } });
  assert.deepEqual(resume.slice(-4), ['--resume', 'saved', '--model', 'haiku']);
  assert.equal(resume.includes('--session-id'), false);
  assert.equal(resume[resume.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(args.includes('--bare'), false);
});

test('Claude child env is copied, nesting keys removed, background setting deliberately restored', () => {
  const env = { HOME: '/fake/home', CLAUDE_CONFIG_DIR: '/fake/config', PATH: '/bin', PWD: '/old',
    CLAUDECODE: '1', CLAUDE_PID: '2', CLAUDE_EFFORT: 'high', CLAUDE_CODE_SESSION_ID: 'parent',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', CLAUDE_CODE_FUTURE: 'inherited' };
  const before = { ...env };
  assert.deepEqual(claudeEnv(env, '/work'), { HOME: '/fake/home', CLAUDE_CONFIG_DIR: '/fake/config',
    PATH: '/bin', PWD: '/work', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  assert.deepEqual(env, before);
});

test('Claude permissions match case-insensitively and retain canonical spellings', () => {
  assert.deepEqual(CLAUDE_PERMISSION_MODES, ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
  for (const mode of CLAUDE_PERMISSION_MODES) assert.equal(resolveClaudePermission({ AGENT_COMPANION_CLAUDE_PERMISSION: ` ${mode.toUpperCase()} ` }), mode);
  for (const value of [undefined, '', 'invalid']) assert.equal(resolveClaudePermission({ AGENT_COMPANION_CLAUDE_PERMISSION: value }), 'bypassPermissions');
});

test('frame parser ignores malformed/non-object JSON and keeps unknown native frames', () => {
  for (const line of ['broken', 'null', '[]', '1', '"text"', '{}']) assert.equal(parseClaudeFrame(line), null);
  const frame = { type: 'command_lifecycle', session_id: 's' };
  assert.deepEqual(parseClaudeFrame(JSON.stringify(frame)), frame);
});

test('result mapping prioritizes requested interruption, then errors, then success', () => {
  const success = { type: 'result', session_id: 's', subtype: 'success', is_error: false, result: 'answer' };
  const options = { partialText: 'partial', effectiveModel: 'resolved', includeCost: true };
  assert.deepEqual(claudeTerminal(success, options), { outcome: 'completed', text: 'answer', usage: null,
    nativeRefs: { historyId: 's' }, effectiveModel: 'resolved' });
  const auth = claudeTerminal({ ...success, is_error: true, terminal_reason: 'api_error', result: 'Not logged in' }, options);
  assert.equal(auth.outcome, 'failed'); assert.equal(auth.detail, 'api_error'); assert.equal(auth.text, 'partial\n\nNot logged in');
  assert.equal(claudeTerminal({ ...success, is_error: true, result: 'Not logged in' }).text, 'Not logged in');
  assert.equal(claudeTerminal({ ...success, is_error: true, result: 'Not logged in' }, { partialText: 'Not logged in' }).text, 'Not logged in');
  for (const reason of ['aborted_streaming', 'aborted_tools']) {
    const frame = { ...success, subtype: 'error_during_execution', is_error: true, terminal_reason: reason, result: '' };
    assert.equal(claudeTerminal(frame, options).outcome, 'failed');
    assert.equal(claudeTerminal(frame, options).text, 'partial');
    const interrupted = claudeTerminal(frame, { ...options, interruptRequested: true });
    assert.equal(interrupted.outcome, 'interrupted'); assert.equal(interrupted.text, 'partial');
  }
  assert.equal(claudeTerminal({ ...success, subtype: 'error_during_execution', result: '' }, options).detail, 'error_during_execution');
});

test('Claude argv includes only an explicitly selected effort for fresh and resumed history', () => {
  for (const resume of [false, true]) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.deepEqual(claudeArgs({ historyId: 'id', resume, effort, env: {} }).slice(-2), ['--effort', effort]);
    }
    assert.equal(claudeArgs({ historyId: 'id', resume, env: {} }).includes('--effort'), false);
  }
});
