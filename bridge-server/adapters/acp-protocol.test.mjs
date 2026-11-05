import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTargetById } from '../../lib/target-registry.mjs';
import { fakeAcpDescriptor } from '../../test/fake-acp-agent.mjs';
import { AcpConnection, ACP_PROTOCOL_VERSION } from './acp-protocol.mjs';
const FAKE = fakeAcpDescriptor();
const COPILOT = getTargetById('copilot');
const ANTIGRAVITY = getTargetById('antigravity');
test('the descriptors drive the argv: Copilot permission flags and optional model, the fake as a bare `--acp`', () => {
  assert.deepEqual(COPILOT.acp.args({ model: 'claude-sonnet-4.6', env: {} }), [
    '--acp',
    '--model', 'claude-sonnet-4.6',
    '--reasoning-effort', 'xhigh',
    '--no-ask-user',
    '--allow-all-tools',
    '--allow-all-paths',
    '--allow-all-urls',
  ]);
  assert.equal(COPILOT.acp.args({}).includes('--model'), false);
  assert.equal(COPILOT.acp.clientName, 'copilot-acp-daemon');
  assert.deepEqual(COPILOT.acp.env({ env: {}, paths: { otelTraces: '/x/traces.jsonl' } }), {
    COPILOT_OTEL_ENABLED: 'true',
    COPILOT_OTEL_FILE_EXPORTER_PATH: '/x/traces.jsonl',
  });
  assert.deepEqual(COPILOT.acp.rotate, ['otelTraces']);
  assert.equal(COPILOT.acp.loadSession, false, 'Copilot sessions are process-local (github/copilot-cli#1767)');
  assert.equal(COPILOT.acp.permission({}), 'all');

  assert.deepEqual(FAKE.acp.args({ model: null, env: {} }), ['--acp']);
  assert.deepEqual(FAKE.acp.args({ model: 'm1', env: {} }), ['--acp', '--model', 'm1']);
  assert.equal(FAKE.acp.defaultModel({}), null, 'no model pin means the agent\'s own default');
  assert.equal(FAKE.acp.permission({}), 'all');
  assert.equal(FAKE.acp.permission({ FAKE_ACP_POLICY: 'edit' }), 'edit');
  assert.equal(ACP_PROTOCOL_VERSION, 1);
});

test('antigravity: the descriptor — bare spawn, no usage reader, load honoured, the permission knob, and the model as a session config option', () => {
  assert.deepEqual(ANTIGRAVITY.acp.args({ model: 'gemini-pro-agent', env: {} }), process.platform === 'linux' ? ['--uid='] : [],
    'the registry entry\'s own args: nothing on macOS, `--uid=` on linux — the model is not a flag');
  assert.deepEqual(ANTIGRAVITY.acp.env({ env: {}, paths: {} }), {});
  assert.deepEqual(ANTIGRAVITY.acp.rotate, []);
  assert.equal(ANTIGRAVITY.acp.clientName, 'agent-companion');
  assert.equal(ANTIGRAVITY.acp.loadSession, true, 'a session survives the server process and session/load remembers (measured)');
  assert.equal(ANTIGRAVITY.acp.defaultModel({}), null, 'unset leaves the account\'s default model');
  assert.equal(ANTIGRAVITY.acp.permission({}), 'all');
  assert.equal(ANTIGRAVITY.acp.permission({ AGENT_COMPANION_ANTIGRAVITY_PERMISSION: 'edit' }), 'edit');
  assert.equal(ANTIGRAVITY.acp.permission({ AGENT_COMPANION_ANTIGRAVITY_PERMISSION: 'NONE' }), 'none');
  assert.equal(ANTIGRAVITY.acp.permission({ AGENT_COMPANION_ANTIGRAVITY_PERMISSION: 'yolo' }), 'all', 'an unrecognised policy is the default, never a guess');
  assert.equal(ANTIGRAVITY.acp.usage({ result: { stopReason: 'end_turn', _meta: { quota: { token_count: { input_tokens: 1, output_tokens: 1 } } } } }), null,
    'nothing on the ACP surface carries usage (measured): even a shape another agent uses is not read');
  assert.deepEqual(ANTIGRAVITY.acp.updates, ['agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'available_commands_update', 'user_message_chunk']);
  assert.deepEqual(ANTIGRAVITY.acp.setModel({ sessionId: 's1', model: 'gemini-pro-agent' }),
    ['session/set_config_option', { sessionId: 's1', configId: 'model', value: 'gemini-pro-agent' }]);
  assert.equal(COPILOT.acp.setModel, undefined, 'Copilot takes its model as a spawn flag, and nothing changes for it');
  assert.equal(FAKE.acp.setModel, undefined);
  assert.equal(ANTIGRAVITY.binaryEnv, 'ANTIGRAVITY_ACP_BIN');
  assert.match(ANTIGRAVITY.binaryNames[0], /agent-companion\/antigravity-acp\/current\/agy_acp_server\.par$/, 'the registry binary, never agy');
  assert.equal(ANTIGRAVITY.capabilities.modelSelection, true);
});

