// Hand-run offline checks. Never launches Codex, reads auth, or imports production code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare, selection, supervise } from './runner.mjs';
import { scenarios } from './scenarios.mjs';
import { analyze } from './analyze.mjs';
import { cleanup, identity, log, owned, readJSON, register, rows, signalOwned, sleep, snapshot, writeJSON } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const metadata = { 'x-codex-turn-metadata': { thread_id: 'synthetic-child', session_id: 'synthetic-root',
  thread_source: 'subagent', model: 'offline-model', reasoning_effort: 'low' }, progressToken: 7 };
function client(dir) {
  const child = spawn(process.execPath, [path.join(here, 'server.mjs'), dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', data => fs.appendFileSync(path.join(dir, 'fixture-stderr.log'), data));
  const pending = new Map(); const notifications = []; let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id !== undefined) { const entry = pending.get(m.id); entry?.resolve(m.result); pending.delete(m.id); }
    else notifications.push(m);
  });
  const send = m => child.stdin.write(JSON.stringify(m) + '\n');
  return { child, notifications, send,
    request(method, params) {
      const id = ++n;
      const promise = new Promise(resolve => pending.set(id, { resolve }));
      send({ jsonrpc: '2.0', id, method, params });
      return { id, promise };
    },
    call(name, args = {}, meta = metadata) { return this.request('tools/call', { name, arguments: args, _meta: meta }); },
  };
}
const value = result => JSON.parse(result.content[0].text);
async function until(check, label, ms = 4000) {
  const deadline = performance.now() + ms;
  while (!check()) { if (performance.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(30); }
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RPC timeout')), 5000); })]); }
  finally { clearTimeout(timer); }
}
const settings = { model: 'offline-model', effort: 'low', source: 'synthetic self-check' };
if (process.argv[2] === '--fake-host') {
  const dir = process.argv[3];
  const rpc = client(dir);
  const e = value(await rpc.call('send', { label: 'owned', cwd: dir }).promise);
  await rpc.call('wait', { execution_id: e.execution_id, seconds: 90 }).promise;
  rpc.child.stdin.end();
} else {
  fs.mkdirSync(path.join(here, '.runs'), { recursive: true });
  const base = fs.mkdtempSync(path.join(here, '.runs', 'offline-'));
  const stubPS = process.argv.includes('--stub-ps');
  if (stubPS) {
    // Explicit sandbox-only substitute. It does NOT test OS birth identity or PGID.
    const bin = path.join(base, 'offline-bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ps'), `#!${process.execPath}\nconst pid=Number(process.argv[3]);try{process.kill(pid,0)}catch{process.exit(1)}process.stdout.write('offline-'+pid+' '+pid+' S\\n');\n`, { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    console.log('Explicit --stub-ps: OS birth identity and process-group verification are UNVERIFIED.');
  }
  const configFile = path.join(base, 'source.toml');
  fs.writeFileSync(configFile, 'model = "kept-model"\nmodel_reasoning_effort = "max"\n[features]\nhooks = false\n');
  assert.deepEqual(selection(configFile).model, 'kept-model');
  assert.deepEqual(selection(configFile).effort, 'max');
  fs.writeFileSync(configFile, 'profile = "custom"\nmodel = "wrong"\n');
  assert.throws(() => selection(configFile), /profile/);
  for (const name of Object.keys(scenarios)) {
    const dir = prepare(name, { out: path.join(base, `prepared-${name}`), selection: settings,
      workspace: process.cwd(), childCwd: base });
    assert.ok(fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8').includes('fork_turns="none"'));
    assert.equal(fs.existsSync(path.join(dir, 'codex-home', 'auth.json')), false);
    assert.ok(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8').includes('default_tools_approval_mode = "approve"'));
  }
  const dir = prepare('interrupt-wait', { out: path.join(base, 'fixture'), selection: settings,
    overrides: { progress: true, progress_interval_ms: 100, provider_sec: 120 } });
  const rpc = client(dir);
  const observer = client(dir);
  try {
    const init = await bounded(rpc.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'offline' } }).promise);
    assert.equal(init.serverInfo.name, 'codex-host-qualification');
    const list = await bounded(rpc.request('tools/list', {}).promise);
    assert.deepEqual(list.tools.map(t => t.name), ['catalog', 'send', 'wait', 'stop']);
    assert.equal((await bounded(rpc.call('send', { label: 'bad', cwd: '.' }).promise)).isError, true);
    const e = value(await bounded(rpc.call('send', { label: 'owned', cwd: dir, message: 'initial', claimed_owner: 'invented' }).promise));
    await until(() => snapshot(dir).filter(p => p.execution_id === e.execution_id && p.heartbeat).length === 3, 'tree ready');
    const tree = owned(dir).filter(p => p.execution_id === e.execution_id);
    if (!stubPS) {
      assert.equal(tree.find(p => p.role === 'command').pgid, tree.find(p => p.role === 'worker').pgid);
      assert.notEqual(tree.find(p => p.role === 'grandchild').pgid, tree.find(p => p.role === 'worker').pgid);
    }
    assert.equal(readJSON(path.join(dir, `${e.execution_id}.json`)).owner.thread_id, 'synthetic-child');
    const wait = rpc.call('wait', { execution_id: e.execution_id, seconds: 60 });
    await until(() => rpc.notifications.length > 0, 'progress');
    assert.equal(rpc.notifications[0].params.progressToken, 7);
    const start = performance.now();
    assert.equal(value(await bounded(observer.call('catalog', { label: 'status-sibling' }, { ...metadata,
      'x-codex-turn-metadata': { ...metadata['x-codex-turn-metadata'], thread_id: 'synthetic-sibling' } }).promise)).executions.length, 1);
    assert.ok(performance.now() - start < 1000, 'catalog must not wait for the owner call');
    log(dir, 'supervisor.jsonl', 'host_event', { action: 'synthetic_interrupt', execution_id: e.execution_id });
    rpc.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: wait.id, reason: 'offline-cancel' } });
    await until(() => rows(dir, 'mcp.jsonl').some(r => r.type === 'request_cancelled'), 'cancel log');
    assert.equal(snapshot(dir).filter(p => p.execution_id === e.execution_id && p.alive).length, 3);
    rpc.child.stdin.end();
    await until(() => rows(dir, 'mcp.jsonl').some(r => r.type === 'stdin_eof'), 'EOF');
    assert.equal(snapshot(dir).filter(p => p.execution_id === e.execution_id && p.alive).length, 3);
    const waiting = value(await bounded(observer.call('wait', { execution_id: e.execution_id, seconds: 0 }).promise));
    assert.equal(waiting.status, 'running');
    const mismatch = await bounded(observer.call('wait', { execution_id: e.execution_id, seconds: 0, cwd: base }).promise);
    assert.equal(value(mismatch).error, 'workspace_mismatch');
    assert.equal(signalOwned(dir, { ...tree[0], birth: 'not-the-same-process' }, 'SIGKILL', 'stale-pid-check'), 'identity_mismatch');
    await bounded(observer.call('stop', { execution_id: e.execution_id }).promise);
    await until(() => snapshot(dir).filter(p => p.execution_id === e.execution_id).every(p => !p.alive), 'explicit stop');
    assert.equal(value(await bounded(observer.call('wait', { execution_id: e.execution_id, seconds: 0 }).promise)).status, 'finished');
    // A gate is observable before a wait reaches MCP; it never changes provider state.
    const cfg = readJSON(path.join(dir, 'scenario.json')); cfg.gate = 'startup'; cfg.gate_sec = 0.2;
    writeJSON(path.join(dir, 'scenario.json'), cfg);
    const hook = spawn(process.execPath, [path.join(here, 'hooks.mjs'), dir], { stdio: ['pipe', 'ignore', 'inherit'] });
    hook.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__fixture__send', tool_input: { label: 'owned' }, cwd: dir }));
    await until(() => rows(dir, 'hooks.jsonl').some(h => h.type === 'gate_start'), 'startup gate');
    await new Promise(resolve => hook.on('exit', resolve));
    assert.ok(rows(dir, 'hooks.jsonl').some(h => h.type === 'gate_end'));
    observer.child.stdin.end();
    log(dir, 'supervisor.jsonl', 'observation_end', { processes: snapshot(dir), saved_results: [] });
  } finally { assert.equal((await cleanup(dir)).all_absent, true); }
  const report = analyze(dir);
  assert.equal(report.received_signals.find(s => s.signal === 'cancelled').reason, 'offline-cancel');
  assert.equal(report.owner_identity_per_call.find(c => c.tool === 'send').full_meta.progressToken, 7);
  assert.ok(report.host_events.every(e => e.at_plus_5s === null), 'missing +5s must remain unknown');
  const supervised = prepare('owner-sigkill', { out: path.join(base, 'supervised'), selection: settings,
    overrides: { wall_sec: 15, after_phase_sec: 0.3 } });
  const row = await supervise(supervised, [process.execPath, fileURLToPath(import.meta.url), '--fake-host', supervised]);
  assert.equal(row.cleanup.all_absent, true);
  const death = row.host_events.find(e => e.action === 'owner_SIGKILL');
  assert.ok(death, 'supervisor injected owner death');
  assert.ok(death.signals.some(s => s.signal === 'EOF'), 'host crash produced transport EOF');
  assert.equal(death.at_plus_5s.processes.filter(p => ['worker', 'command', 'grandchild'].includes(p.role) && p.alive && p.advancing_recently).length, 3);
  assert.ok(row.saved_state.fixture_history_rows > 0);
  // Kill-zero/ps absence and mismatched birth are distinct, never process-name matching.
  assert.equal(identity(owned(supervised).find(p => p.role === 'host').owned_pid), null);
  const boundedRun = prepare('interrupt-wait', { out: path.join(base, 'wall-bound'), selection: settings, overrides: { wall_sec: 1.5 } });
  fs.writeFileSync(path.join(boundedRun, 'codex-home', 'auth.json'), 'synthetic, not a credential');
  const deadlineRow = await supervise(boundedRun, [process.execPath, fileURLToPath(import.meta.url), '--fake-host', boundedRun]);
  assert.ok(deadlineRow.warnings.some(w => w.includes('Harness wall deadline')));
  assert.equal(deadlineRow.cleanup.all_absent, true);
  assert.equal(fs.existsSync(path.join(boundedRun, 'codex-home', 'auth.json')), false);
  const terminal = prepare('tui-new', { out: path.join(base, 'pty'), selection: settings });
  writeJSON(path.join(terminal, 'command.json'), { argv: [process.execPath, '-e',
    'process.stdin.once("data", data => { console.log("PTY-ECHO:" + data.toString().trim()); process.exit(0); });'] });
  const driver = spawn('python3', [path.join(here, 'pty-driver.py'), terminal], { stdio: ['pipe', 'pipe', 'inherit'] });
  register(terminal, driver.pid, 'pty-driver');
  let output = ''; driver.stdout.on('data', data => { output += data; });
  try {
    await until(() => fs.existsSync(path.join(terminal, 'pty-host.json')), 'PTY host PID');
    register(terminal, readJSON(path.join(terminal, 'pty-host.json')).pid, 'host');
    fs.writeFileSync(path.join(terminal, 'pty-host-registered'), 'go');
    driver.stdin.write('hello\n');
    await until(() => output.includes('PTY-ECHO:hello'), 'PTY transport');
    await until(() => rows(terminal, 'pty-events.jsonl').some(r => r.type === 'pty_host_exit'), 'PTY host exit');
  } finally { assert.equal((await cleanup(terminal)).all_absent, true); }
  console.log(`Offline checks passed${stubPS ? ' with process inspection stubbed' : ''}; no Codex host launched. Evidence: ${base}`);
}
