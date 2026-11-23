import { joinSession } from '@microsoft/copilot-sdk/extension';
import fs from 'node:fs';
const root = fs.readFileSync(new URL('./run-dir', import.meta.url), 'utf8');
const session = await joinSession({ tools: [], hooks: {} });
const log = (event, extra = {}) => fs.appendFileSync(root + '/events', JSON.stringify({
  t: Date.now(), pid: process.pid, session: session.sessionId, event, ...extra,
}) + '\n');
log('joined', { marked: Boolean(process.env.AGENT_COMPANION_JOB) });
const file = root + '/send-' + session.sessionId;
setInterval(async () => {
  if (!fs.existsSync(file)) return;
  const message = fs.readFileSync(file, 'utf8');
  fs.unlinkSync(file);
  log('sending');
  try { await session.send(message); log('sent'); }
  catch (err) { log('send failed', { name: err.name }); }
}, 100);
// Independent control for the host's MCP timeout. This SDK call does not ask a model.
const callFile = root + '/call-' + session.sessionId;
setInterval(async () => {
  if (!fs.existsSync(callFile)) return;
  fs.unlinkSync(callFile);
  log('rpc.begin');
  try {
    const result = await session.rpc.mcp.callTool({ serverName: 'agent-bridge', toolName: 'companion_probe', arguments: {} });
    log('rpc.end', { error: !!result?.isError, token: JSON.stringify(result).includes('MARBLE-918'),
      timedOut: /timed? ?out/i.test(JSON.stringify(result)) });
  } catch (err) { log('rpc.error', { message: String(err.message).slice(0, 240) }); }
}, 100);
// Exercise the ordinary tool pipeline, including the real task/subagent tool.
const executeFile = root + '/execute-' + session.sessionId;
setInterval(async () => {
  if (!fs.existsSync(executeFile)) return;
  const action = fs.readFileSync(executeFile, 'utf8').trim();
  fs.unlinkSync(executeFile);
  const subagent = action === 'subagent';
  const request = subagent ? { name: 'task', arguments: { name: 'fixture-reader', agent_type: 'host-fixture:fixture-reader',
    description: 'Read fixture token', prompt: 'Call the companion_probe tool once and return its token.' } }
    : { name: 'agent-bridge-companion_probe', arguments: {} };
  log('execute.begin', { subagent });
  try {
    const result = JSON.stringify(await session.rpc.tools.execute(request));
    log('execute.end', { token: result.includes('MARBLE-918'),
      postContext: result.includes('PLUM-551'), timedOut: /request timed out/i.test(result) });
  } catch (err) { log('execute.error', { message: String(err.message).slice(0, 240) }); }
}, 100);
