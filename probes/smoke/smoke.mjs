// Real Codex app-server work through the controller. Spends one Codex turn.
import { tools as registry } from '../../bridge-server/tools.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, record } from './bridge-client.mjs';

const session = `smoke-${Date.now().toString(36)}`, owner = `${session}-child`;
const work = mkdtempSync(join(tmpdir(), 'agentco-smoke-'));
writeFileSync(join(work, 'README.md'), '# smoke\nThe magic word is BANANA.\n');
const bridge = await startBridge(session);
try {
  const tools = await bridge.rpc('tools/list', {});
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), registry.map(t => t.name).sort());
  const refusal = await bridge.tool('agent_send', { target: 'codex', model: 'invalid model', task: 'noop', cwd: work }, `${owner}-refusal`);
  assert.equal(refusal.code, 'MODEL_NOT_ALLOWED');
  const sent = await bridge.tool('agent_send', { target: 'codex', cwd: work,
    task: 'Read README.md and reply with ONLY the magic word it names.' }, owner);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.status, 'still_running');
  // Send returns only after native acknowledgement; history is already saved.
  const execution = record('executions', sent.job_id);
  assert.ok(execution.historyId);
  assert.ok(execution.nativeTurnId);
  const status = await bridge.tool('agent_status', { job_id: sent.job_id }, owner);
  assert.equal(status.job_id, sent.job_id);
  assert.equal(status.native_refs.historyId, execution.historyId);
  const final = await bridge.wait(sent.job_id, owner);
  assert.equal(final.status, 'completed', JSON.stringify(final));
  assert.match(final.content, /BANANA/i);
  assert.equal(final.meta.stop_evidence.gone, true);
  assert.equal(final.meta.usage.source, 'codex-app-server');
  assert.ok(final.meta.usage.input_tokens > 0 && final.meta.usage.output_tokens > 0);
  const digest = await bridge.readResource(final.meta.digest_uri);
  assert.ok(digest.includes(execution.historyId));
  assert.match(digest, /BANANA/i);
  console.log('PASS: Codex dispatch, persisted native identity, usage, digest and verified exit');
} finally { await bridge.stop(); }
