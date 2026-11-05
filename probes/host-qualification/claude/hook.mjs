import { log, rows, readJSON, sleep, recordPID } from './common.mjs';

const [dir] = process.argv.slice(2);
let text = '';
for await (const chunk of process.stdin) text += chunk;
const payload = JSON.parse(text);
recordPID(dir, process.pid, 'hook', { hookEvent: payload.hook_event_name, tool: payload.tool_name });
log(dir, 'hooks.jsonl', 'hook', { payload });
const config = readJSON(dir + '/scenario.json');
const { hook_event_name: event, tool_name: tool, agent_id: id, tool_input: input = {} } = payload;
let gateSec = 0;
if (event === 'PreToolUse' && tool === 'mcp__fixture__send' && id) gateSec = config.startupGateSec;
if (event === 'PreToolUse' && tool === 'mcp__fixture__wait' && id) {
  const ordinal = rows(dir, 'hooks.jsonl').filter(x => x.event === 'hook' &&
    x.payload.hook_event_name === 'PreToolUse' && x.payload.tool_name === tool && x.payload.agent_id === id).length;
  if (ordinal === config.gateWaitOrdinal) gateSec = config.gapGateSec;
}
if (gateSec) {
  log(dir, 'hooks.jsonl', 'gate_start', { owner: id, tool, gateSec });
  await sleep(gateSec * 1000);
  log(dir, 'hooks.jsonl', 'gate_end', { owner: id, tool });
}
if (event === 'PreToolUse' && /^mcp__fixture(?:_control)?__(catalog|send|wait|stop)$/.test(tool)) {
  // Same in-band mechanism as hooks/name-thread.sh: overwrite the model's thread.
  // Unlike the production hook, clear a fabricated thread on ownerless parent calls.
  const updatedInput = { ...input, thread: id || '' };
  log(dir, 'hooks.jsonl', 'updated_input', { tool_use_id: payload.tool_use_id, owner: id ?? null, updatedInput });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }));
}
