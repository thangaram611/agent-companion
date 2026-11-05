// Run2 topology: session-scoped stdio server, referenced by name from native agents.
// Passive by design. Cancel, stop, EOF and signals NEVER clean up provider processes.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, log, rows, readJSON, writeJSON, recordPID, sleep, phaseAt } from './common.mjs';

const [dir, channel = 'fixture'] = process.argv.slice(2);
const config = readJSON(dir + '/scenario.json');
const emit = (event, extra = {}) => log(dir, 'events.jsonl', event, { channel, ...extra });
const transmit = frame => {
  const message = { jsonrpc: '2.0', ...frame };
  emit('frame', { direction: 'out', frame: message });
  process.stdout.write(JSON.stringify(message) + '\n');
};
const tool = (name, description, properties = {}, required = [], readOnly = false) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
});
const string = { type: 'string' };
const owner = { thread: { type: 'string', description: 'Set by the native PreToolUse hook; do not invent it.' } };
const context = { cwd: string, childCwd: string, parentCwd: string };
const nativeTools = [
  tool('catalog', 'Instant read-only fake-provider catalog and cwd observation. Never attaches or renews execution.',
    { ...owner, ...context, marker: string }, [], true),
  tool('send', 'Start one detached fake provider with leaf and separate-group grandchild; return immediately.',
    { ...owner, ...context, label: string }, ['cwd']),
  tool('wait', 'Bounded wait for fake execution. Return running or finished; a running return requires another wait.',
    { ...owner, ...context, executionId: string, seconds: { type: 'number', minimum: 0, maximum: 2100 }, marker: string },
    ['executionId', 'seconds', 'cwd']),
  tool('stop', 'Record a stop request only. Passive fixture: this does NOT terminate anything.',
    { ...owner, executionId: string, marker: string }, ['executionId']),
];
const observerTools = [tool('observe', 'Read fixture phase after an optional bounded delay. Never owns work.', {
  phase: string, channel: string, delaySec: { type: 'number', minimum: 0, maximum: 60 },
  requireGate: { type: 'boolean' },
  afterSpawnSec: { type: 'number', minimum: 0, maximum: 120 },
  timeoutSec: { type: 'number', minimum: 0, maximum: 2400 },
}, [], true)];
const pending = new Map();
recordPID(dir, process.pid, 'server', { channel });
emit('server_start', { cwd: process.cwd(), ppid: process.ppid,
  identityEnv: Object.fromEntries(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_CODE_AGENT_ID']
    .filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
  generation: process.env.HOST_QUALIFICATION_GENERATION ?? '0' });
const canonical = cwd => {
  if (!cwd || !path.isAbsolute(cwd)) throw Error('CWD_MUST_BE_EXPLICIT_AND_ABSOLUTE');
  if (!fs.statSync(cwd).isDirectory()) throw Error('CWD_NOT_DIRECTORY');
  return fs.realpathSync(cwd);
};
const execution = (id, thread, cwd) => {
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw Error('INVALID_EXECUTION_ID');
  const state = readJSON(path.join(dir, 'executions', id + '.json'));
  if (!state) throw Error('EXECUTION_NOT_FOUND');
  if (state.owner !== thread || state.channel !== channel) throw Error('OWNER_MISMATCH');
  if (cwd !== undefined && canonical(cwd) !== state.cwd) throw Error('WORKSPACE_MISMATCH');
  return state;
};
const phase = (name, state, requestId) => emit('phase', { phase: name, owner: state.owner,
  executionId: state.executionId, requestId });
async function call(q) {
  const { name, arguments: args = {}, _meta: meta = null } = q.params;
  emit('tool_start', { requestId: q.id, name, args, meta, serverCwd: process.cwd() });
  let result;
  if (channel === 'observer') {
    if (name !== 'observe') throw Error('UNKNOWN_OBSERVER_TOOL');
    const until = Date.now() + Math.min(2400, args.timeoutSec ?? 45) * 1000;
    let seen;
    let gateSeen = false;
    do {
      const hooks = rows(dir, 'hooks.jsonl');
      seen = phaseAt(rows(dir, 'events.jsonl'), hooks, Date.now(), null, args.channel ?? 'fixture');
      gateSeen = hooks.some(h => h.event === 'gate_start' && h.owner === seen.owner && h.t >= seen.since);
      if ((!args.phase || seen.phase === args.phase) && (!args.requireGate || gateSeen)) break;
      await sleep(100);
    } while (Date.now() < until);
    if (args.afterSpawnSec !== undefined) {
      const start = rows(dir, 'hooks.jsonl').find(x => x.payload?.hook_event_name === 'SubagentStart');
      if (start) await sleep(Math.max(0, start.t + args.afterSpawnSec * 1000 - Date.now()));
    } else await sleep(Math.min(60, args.delaySec ?? 0) * 1000);
    const actual = phaseAt(rows(dir, 'events.jsonl'), rows(dir, 'hooks.jsonl'), Date.now(), null, args.channel ?? 'fixture');
    result = { ...actual, requestedPhase: args.phase ?? null, gateSeen,
      reached: (!args.phase || seen.phase === args.phase) && (!args.requireGate || gateSeen) };
  } else if (name === 'catalog') {
    result = { providers: ['local-fake-only'], serverPid: process.pid, serverCwd: process.cwd(), received: args,
      attachment: false, leaseRenewal: false };
  } else {
    if (typeof args.thread !== 'string' || !args.thread) throw Error('NATIVE_OWNER_REQUIRED');
    if (name === 'send') {
      const cwd = canonical(args.cwd);
      const existing = fs.readdirSync(dir + '/executions').filter(f => /^[0-9a-f-]{36}\.json$/.test(f))
        .map(f => readJSON(dir + '/executions/' + f)).find(s => s.owner === args.thread && s.channel === channel);
      if (existing) throw Error('ALREADY_DISPATCHED_USE_WAIT');
      const executionId = randomUUID();
      const state = { executionId, owner: args.thread, channel, cwd, receivedCwd: args.cwd,
        childCwd: args.childCwd ?? null, parentCwd: args.parentCwd ?? null, serverCwd: process.cwd(),
        historyId: `fake-history-${executionId}`, created: Date.now(), finishAt: Date.now() + config.workSec * 1000 };
      writeJSON(path.join(dir, 'executions', executionId + '.json'), state);
      const child = spawn(process.execPath, [path.join(ROOT, 'worker.mjs'), dir, executionId],
        { detached: true, stdio: 'ignore', cwd });
      recordPID(dir, child.pid, 'worker', { executionId, channel, owner: args.thread });
      child.unref();
      child.on('error', error => emit('spawn_error', { executionId, error: error.message }));
      emit('dispatch', { ...state, workerPid: child.pid, requestId: q.id });
      phase('dispatch-to-first-wait', state, q.id);
      result = { executionId, status: 'running', historyId: state.historyId, workerPid: child.pid, cwd };
    } else if (name === 'wait') {
      if (!Number.isFinite(args.seconds) || args.seconds < 0 || args.seconds > 2100) throw Error('INVALID_WAIT');
      const state = execution(args.executionId, args.thread, args.cwd);
      pending.set(q.id, state);
      phase('pending-wait', state, q.id);
      const deadline = Date.now() + args.seconds * 1000;
      let nextProgress = Date.now() + config.progressSec * 1000;
      while (Date.now() < deadline && !fs.existsSync(dir + '/executions/' + state.executionId + '.result.json')) {
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
        if (config.progress && Date.now() >= nextProgress) {
          nextProgress = Date.now() + config.progressSec * 1000;
          if (meta?.progressToken !== undefined) transmit({ method: 'notifications/progress', params: {
            progressToken: meta.progressToken, progress: Math.max(0, args.seconds - (deadline - Date.now()) / 1000),
            total: args.seconds, message: 'Fake work remains pending',
          } });
          else emit('progress_unavailable', { requestId: q.id, reason: 'no progressToken' });
        }
      }
      pending.delete(q.id);
      const finished = fs.existsSync(dir + '/executions/' + state.executionId + '.result.json');
      result = { executionId: state.executionId, status: finished ? 'finished' : 'running',
        historyId: state.historyId, passive: true };
      phase(finished ? 'finished' : 'between-waits', state, q.id);
    } else if (name === 'stop') {
      const state = execution(args.executionId, args.thread);
      emit('stop_requested', { executionId: state.executionId, owner: state.owner });
      result = { executionId: state.executionId,
        status: fs.existsSync(dir + '/executions/' + state.executionId + '.result.json') ? 'finished' : 'running',
        cleanupImplemented: false };
    } else throw Error('UNKNOWN_TOOL');
  }
  emit('tool_return', { requestId: q.id, name, result });
  transmit({ id: q.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let q;
  try { q = JSON.parse(line); } catch { emit('invalid_frame', { line }); return; }
  emit('frame', { direction: 'in', frame: q });
  if (q.method === 'initialize') transmit({ id: q.id, result: { protocolVersion: q.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: `host-qualification-${channel}`, version: '1.0.0' } } });
  else if (q.method === 'ping') transmit({ id: q.id, result: {} });
  else if (q.method === 'tools/list') transmit({ id: q.id, result: { tools: channel === 'observer' ? observerTools : nativeTools } });
  else if (q.method === 'notifications/cancelled') {
    emit('cancelled', { params: q.params, owner: pending.get(q.params?.requestId)?.owner ?? null });
  } else if (q.method === 'tools/call') call(q).catch(error => {
    emit('tool_error', { requestId: q.id, error: error.message });
    transmit({ id: q.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } });
  });
  else if (q.id !== undefined) transmit({ id: q.id, error: { code: -32601, message: 'Method not found' } });
});
process.stdin.on('end', () => { emit('stdin_eof'); process.exit(0); });
process.stdout.on('error', error => { emit('stdout_error', { code: error.code }); process.exit(0); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  emit('server_signal', { signal }); process.exit(0);
});
process.on('exit', code => emit('server_exit', { code }));
