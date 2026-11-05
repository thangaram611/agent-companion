// Config-level command hook. Empty stdout is intentional: no injected context or policy.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log, readJSON, register, rows, sleep } from './common.mjs';

const dir = process.argv[2];
let input = '';
for await (const chunk of process.stdin) input += chunk;
let payload;
try { payload = JSON.parse(input); } catch { payload = { malformed_input: input }; }
log(dir, 'hooks.jsonl', 'hook', { payload, process_cwd: process.cwd(), ppid: process.ppid });
register(dir, process.pid, 'hook', { ppid: process.ppid });
const config = readJSON(path.join(dir, 'scenario.json'));
let args = payload.tool_input;
if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
args ??= {};
const tool = payload.tool_name ?? '';
let gate;
if (payload.hook_event_name === 'PreToolUse') {
  if (config.gate === 'startup' && /(?:__|\b)send$/.test(tool) && args.label === 'owned') gate = 'startup';
  if (/(?:__|\b)wait$/.test(tool) && /^exec-[\w-]+$/.test(args.execution_id ?? '')) {
    const e = readJSON(path.join(dir, `${args.execution_id}.json`));
    const calls = rows(dir, 'mcp.jsonl').filter(r => r.type === 'phase' && r.phase === 'pending_wait' && r.execution_id === args.execution_id).length;
    if (e?.label === 'owned' && ((config.gate === 'dispatch_gap' && calls === 0) || (config.gate === 'between_waits' && calls === 1))) gate = config.gate;
  }
}
if (gate) {
  // One gate per phase/execution; resuming the same child does not gate it again.
  const claim = path.join(dir, `gate-${gate}-${args.execution_id ?? 'startup'}`);
  let claimed = false;
  try { fs.mkdirSync(claim); claimed = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (claimed) {
    const gate_id = randomUUID();
    log(dir, 'hooks.jsonl', 'gate_start', { gate_id, phase: gate, execution_id: args.execution_id ?? null,
      session_id: payload.session_id ?? null, agent_id: payload.agent_id ?? null, tool_call_id: payload.tool_use_id ?? null });
    let closed = false;
    const end = reason => {
      if (!closed) log(dir, 'hooks.jsonl', 'gate_end', { gate_id, phase: gate, reason });
      closed = true;
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { end(signal); process.exit(0); });
    const deadline = performance.now() + config.gate_sec * 1000;
    while (performance.now() < deadline && !fs.existsSync(path.join(dir, 'release-gates'))) await sleep(100);
    end('released_or_elapsed');
  }
}
