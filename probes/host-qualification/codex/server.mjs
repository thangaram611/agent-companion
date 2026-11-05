// Plain JSONL stdio MCP, derived from host-codex/server.cjs (4 Nov).
// Host cancellation, EOF and signals NEVER terminate provider descendants here.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, readJSON, rows, register, snapshot, writeJSON } from './common.mjs';

const dir = path.resolve(process.argv[2]);
const config = readJSON(path.join(dir, 'scenario.json'));
const pending = new Map();
register(dir, process.pid, 'server', { ppid: process.ppid });
const record = (type, data = {}) => log(dir, 'mcp.jsonl', type, { server_pid: process.pid, ...data });
record('server_started', { cwd: process.cwd(), env_pwd: process.env.PWD ?? null, ppid: process.ppid,
  restart_generation: process.env.HOST_QUAL_RESTART_GENERATION ?? null });
function emit(message) {
  record('rpc', { direction: 'out', message });
  process.stdout.write(JSON.stringify(message) + '\n');
}
const result = (id, value) => emit({ jsonrpc: '2.0', id, result: value });
const out = (id, value, isError = false) => result(id,
  { content: [{ type: 'text', text: JSON.stringify(value) }], isError });
function executions() {
  return fs.readdirSync(dir).filter(n => /^exec-[\w-]+\.json$/.test(n)).map(n => readJSON(path.join(dir, n)));
}
function state(id) {
  if (!/^exec-[\w-]+$/.test(id ?? '')) throw new Error('unknown execution_id');
  const value = readJSON(path.join(dir, `${id}.json`));
  if (!value) throw new Error('unknown execution_id');
  return value;
}
function phase(id, name, data = {}) {
  const event = record('phase', { execution_id: id, phase: name, ...data });
  writeJSON(path.join(dir, `${id}.phase.json`), event);
}
function status(id) {
  const processRows = snapshot(dir).filter(p => p.execution_id === id);
  return processRows.length >= 3 && processRows.every(p => !p.alive) ? 'finished' : 'running';
}
function catalog() {
  const gates = rows(dir, 'hooks.jsonl').filter(h => h.type === 'gate_start').map(h => ({ ...h,
    active: !rows(dir, 'hooks.jsonl').some(e => e.type === 'gate_end' && e.gate_id === h.gate_id) }));
  return { time: Date.now(), server_pid: process.pid, server_cwd: process.cwd(), gates,
    spawn_hooks: rows(dir, 'hooks.jsonl').filter(h => h.type === 'hook' && h.payload?.hook_event_name === 'SubagentStart'),
    executions: executions().map(e => ({ ...e, status: status(e.execution_id),
      phase: readJSON(path.join(dir, `${e.execution_id}.phase.json`)) })), processes: snapshot(dir) };
}
const string = { type: 'string' };
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const tools = [
  { name: 'catalog', description: 'Instant read-only fixture status. label is only an observation tag in the raw RPC log. Never attaches or renews execution ownership.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: schema({ label: string, cwd: string }) },
  { name: 'send', description: 'Immediately start one fake worker, command child and separate-group grandchild. cwd must be absolute and existing. No real provider. Do not repeat after acknowledgement.',
    inputSchema: schema({ label: string, cwd: string, message: string, claimed_owner: string }) },
  { name: 'wait', description: 'Wait at most seconds for a fake execution. Returns running or finished. No ownership cleanup on timeout/cancellation. Optional cwd checks conversation workspace identity.',
    inputSchema: { ...schema({ execution_id: string, seconds: { type: 'number', minimum: 0, maximum: 2100 }, cwd: string }), required: ['execution_id', 'seconds'] } },
  { name: 'stop', description: 'Explicitly ask all three fake processes of this execution to exit. This is not host-native cancellation. Do not use in loss scenarios.',
    inputSchema: { ...schema({ execution_id: string }), required: ['execution_id'] } },
];
function cancel(id) {
  const p = pending.get(id);
  if (!p) return;
  clearInterval(p.timer); pending.delete(id);
  phase(p.execution_id, 'wait_cancelled', { request_id: id });
}
function handle(m) {
  if (m.method === 'initialize') return result(m.id, { protocolVersion: m.params?.protocolVersion || '2024-11-05',
    capabilities: { tools: {} }, serverInfo: { name: 'codex-host-qualification', version: '1' } });
  if (m.method === 'ping') return result(m.id, {});
  if (m.method === 'tools/list') return result(m.id, { tools });
  if (m.method === 'notifications/cancelled') {
    record('request_cancelled', { request_id: m.params?.requestId, reason: m.params?.reason ?? null });
    cancel(m.params?.requestId); return;
  }
  if (m.method !== 'tools/call') {
    if (m.id !== undefined) emit({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unknown method' } });
    return;
  }
  const a = m.params.arguments || {};
  const owner = m.params._meta?.['x-codex-turn-metadata'] ?? null;
  if (m.params.name === 'catalog') return out(m.id, catalog());
  if (m.params.name === 'send') {
    if (!a.cwd || !path.isAbsolute(a.cwd) || !fs.statSync(a.cwd, { throwIfNoEntry: false })?.isDirectory())
      return out(m.id, { error: 'cwd_must_be_absolute_existing_directory', received_cwd: a.cwd ?? null }, true);
    const execution_id = `exec-${randomUUID()}`;
    const e = { execution_id, owner, label: a.label ?? 'owned', server_pid: process.pid,
      cwd: a.cwd, canonical_cwd: fs.realpathSync(a.cwd), server_cwd: process.cwd(),
      started_at: Date.now(), finish_at: Date.now() + config.provider_sec * 1000, message: a.message ?? null };
    writeJSON(path.join(dir, `${execution_id}.json`), e);
    log(dir, 'history.jsonl', 'dispatch', { ...e, full_meta: m.params._meta ?? null });
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), dir, execution_id],
      { detached: true, stdio: 'ignore', cwd: e.canonical_cwd });
    register(dir, worker.pid, 'worker', { execution_id, ppid: process.pid }); worker.unref();
    worker.on('error', error => record('spawn_error', { execution_id, error: error.message }));
    phase(execution_id, 'dispatch_gap', { request_id: m.id });
    return out(m.id, { execution_id, status: 'running', worker_pid: worker.pid, canonical_cwd: e.canonical_cwd });
  }
  const e = state(a.execution_id);
  if (m.params.name === 'stop') {
    fs.writeFileSync(path.join(dir, `${e.execution_id}.stop`), 'explicit MCP stop\n', { mode: 0o600 });
    record('explicit_stop', { execution_id: e.execution_id });
    return out(m.id, { execution_id: e.execution_id, status: status(e.execution_id), stop_requested: true });
  }
  if (m.params.name !== 'wait') throw new Error('Unknown tool');
  if (a.cwd !== undefined && (!path.isAbsolute(a.cwd) || !fs.existsSync(a.cwd) || fs.realpathSync(a.cwd) !== e.canonical_cwd))
    return out(m.id, { error: 'workspace_mismatch' }, true);
  if (typeof a.seconds !== 'number' || !Number.isFinite(a.seconds) || a.seconds < 0 || a.seconds > 2100)
    throw new Error('seconds must be between 0 and 2100');
  const started = performance.now();
  let lastProgress = started;
  phase(e.execution_id, 'pending_wait', { request_id: m.id, full_meta: m.params._meta ?? null });
  if (config.progress && m.params._meta?.progressToken === undefined) record('progress_unavailable', { request_id: m.id });
  const tick = () => {
    const elapsed = performance.now() - started;
    const current = status(e.execution_id);
    if (current === 'finished' || elapsed >= a.seconds * 1000) {
      clearInterval(pending.get(m.id)?.timer); pending.delete(m.id);
      phase(e.execution_id, 'between_waits', { request_id: m.id });
      return out(m.id, { execution_id: e.execution_id, status: current, elapsed_ms: elapsed });
    }
    if (config.progress && m.params._meta?.progressToken !== undefined && performance.now() - lastProgress >= config.progress_interval_ms) {
      lastProgress = performance.now();
      emit({ jsonrpc: '2.0', method: 'notifications/progress', params: {
        progressToken: m.params._meta.progressToken, progress: elapsed / 1000, total: a.seconds,
        message: 'fake provider heartbeat; no ownership renewal' } });
    }
  };
  pending.set(m.id, { execution_id: e.execution_id, timer: setInterval(tick, 250) }); tick();
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m;
  try { m = JSON.parse(line); } catch { record('invalid_frame', { raw: line }); return; }
  record('rpc', { direction: 'in', message: m });
  try { handle(m); } catch (e) { record('handler_error', { error: e.message }); if (m.id !== undefined) out(m.id, { error: e.message }, true); }
});
process.stdout.on('error', error => { record('stdout_error', { error: error.code }); process.exit(0); });
process.stdin.on('end', () => { record('stdin_eof'); process.exit(0); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { record('server_signal', { signal }); process.exit(0); });
process.on('exit', code => record('server_exit', { code }));
