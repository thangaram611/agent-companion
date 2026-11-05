// Preloaded by the adapter suite before the shared fake ACP agent. Faults
// alter its wire output; the session/permission implementation stays shared.
import { appendFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const env = process.env;
const rows = [{ pid: process.pid, ppid: process.ppid, pgid: process.pid, birthTime: `${process.pid}:${performance.timeOrigin}` }];
if (env.ACP_FIXTURE_TREE === '1') {
  const child = fork(new URL('../controller/process-tree.mjs', import.meta.url), ['leaf', 'ignore'], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  const [message] = await once(child, 'message');
  rows.push(...message.rows);
}
appendFileSync(env.ACP_FIXTURE_ROWS, JSON.stringify(rows) + '\n');

const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  let frame;
  try { frame = JSON.parse(String(chunk)); } catch { return write(chunk, ...args); }
  const update = frame.method === 'session/update';
  const terminal = frame.result?.stopReason;
  const fault = env.ACP_FIXTURE_FAULT;
  // Keep the fixture command active until cancel, independent of pipe chunking.
  if (update && env.ACP_FIXTURE_TREE === '1') {
    if (frame.params.update.sessionUpdate === 'tool_call_update') return true;
    if (frame.params.update.sessionUpdate === 'tool_call') Object.assign(frame.params.update, { kind: 'execute', rawInput: { command: 'fixture-command' } });
  }
  if (update && fault === 'die-before-ack') process.exit(9);
  if (update && fault === 'die-after-ack') {
    if (frame.params.update.sessionUpdate === 'agent_thought_chunk') write(JSON.stringify({ ...frame, params: { ...frame.params,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } } } }) + '\n');
    setImmediate(() => process.exit(9));
  }
  if ((update || terminal) && fault === 'silent') return true;
  if (update && ['terminal-only', 'prompt-error'].includes(fault)) return true;
  if (terminal && fault === 'prompt-error') frame = { jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'prompt refused' } };
  if (frame.result?.configOptions && fault === 'wrong-model') frame.result.configOptions[0].currentValue = 'wrong-model';
  if (frame.result?.configOptions && fault === 'missing-model') frame.result = {};
  if (terminal && env.ACP_FIXTURE_STOP) frame.result.stopReason = env.ACP_FIXTURE_STOP;
  if (terminal && env.ACP_FIXTURE_USAGE === 'copilot') frame.result.usage = { inputTokens: 1234, outputTokens: 56, cachedReadTokens: 100 };
  if (terminal && env.ACP_FIXTURE_USAGE === 'otel') {
    const now = Date.now();
    appendFileSync(env.COPILOT_OTEL_FILE_EXPORTER_PATH, JSON.stringify({ type: 'span', name: 'invoke_agent',
      startTime: [Math.floor(now / 1000), 0], endTime: [Math.floor(now / 1000) + 1, 0],
      attributes: { 'gen_ai.conversation.id': 'fake-sess-1', 'gen_ai.usage.input_tokens': 1234, 'gen_ai.usage.output_tokens': 56 },
    }) + '\n');
  }
  if (update && env.ACP_FIXTURE_RETRY === '1') frame.params.update.retry = { attempt: 2, cause: 'reconnect' };
  if (frame.result?.sessionId && env.ACP_FIXTURE_MODEL) frame.result.models = { currentModelId: env.ACP_FIXTURE_MODEL };
  return write(JSON.stringify(frame) + '\n', ...args);
};
