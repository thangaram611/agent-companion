import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCompanionById } from '../../lib/companion-registry.mjs';
import { fakeAcpDescriptor } from '../../test/fake-acp-agent.mjs';
import { ACP_PROTOCOL_VERSION } from './acp-protocol.mjs';
const FAKE = fakeAcpDescriptor();
const COPILOT = getCompanionById('copilot');
const ANTIGRAVITY = getCompanionById('antigravity');
test('the Copilot spawn argv carries its permission flags and model selection uses the session', () => {
  assert.deepEqual(COPILOT.acp.args({ model: 'claude-sonnet-4.6', env: {} }), [
    '--acp',
    '--no-ask-user',
    '--allow-all-tools',
    '--allow-all-paths',
    '--allow-all-urls',
  ]);
  assert.equal(COPILOT.acp.args({}).includes('--model'), false);
  assert.deepEqual(COPILOT.acp.setModel({ sessionId: 's1', model: 'local-model' }),
    ['session/set_config_option', { sessionId: 's1', configId: 'model', value: 'local-model' }]);
  assert.equal(COPILOT.acp.args({}).includes('--reasoning-effort'), false);
  assert.equal(COPILOT.capabilities.effortLevels, null);
  for (const effort of ['low', 'none', 'new-provider-level']) {
    const argv = COPILOT.acp.args({ effort });
    assert.equal(argv.includes('--reasoning-effort'), false);
  }
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
  assert.equal(FAKE.acp.permission({}), 'all');
  assert.equal(FAKE.acp.permission({ FAKE_ACP_POLICY: 'edit' }), 'edit');
  assert.equal(ACP_PROTOCOL_VERSION, 1);
});

test('Antigravity launches agy acp with native permission bypass only for resolved all', () => {
  assert.equal(ANTIGRAVITY.binaryEnv, 'ANTIGRAVITY_BIN');
  assert.deepEqual(ANTIGRAVITY.binaryNames, ['agy']);
  for (const [raw, policy] of [[undefined, 'all'], ['ALL', 'all'], [' edit ', 'edit'], ['NONE', 'none'], ['invalid', 'all']]) {
    const env = { AGENT_COMPANION_ANTIGRAVITY_PERMISSION: raw };
    assert.equal(ANTIGRAVITY.acp.permission(env), policy);
    assert.deepEqual(ANTIGRAVITY.acp.args({ model: 'gemini-3.8-flash', env }),
      policy === 'all' ? ['acp', '--dangerously-skip-permissions'] : ['acp']);
  }
});

test('Antigravity declares the measured update kinds for turns and load replay', () => {
  assert.deepEqual(new Set(ANTIGRAVITY.acp.updates), new Set(['agent_thought_chunk', 'agent_message_chunk',
    'tool_call', 'tool_call_update', 'available_commands_update', 'user_message_chunk',
    'usage_update', 'session_info_update', 'config_option_update']));
});
