// Explicit offline check. Never invokes Claude, real providers, plugins or account homes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, readJSON, writeJSON, rows, log, sleep, pidRecords, processInfo, snapshot,
  cleanup, signalPID } from './common.mjs';
import { scenarios } from './scenarios.mjs';
import { prepare, hostEnv } from './runner.mjs';
import { analyze } from './analyze.mjs';

function hook(dir, payload) {
  const output = execFileSync(process.execPath, [ROOT + '/hook.mjs', dir], {
    input: JSON.stringify({ session_id: 'offline-session', cwd: dir + '/workspace', ...payload }), encoding: 'utf8', timeout: 5000 });
  return output ? JSON.parse(output).hookSpecificOutput.updatedInput : payload.tool_input;
}
class Client {
  constructor(dir, channel = 'fixture') {
    this.dir = dir; this.channel = channel; this.id = 0; this.pending = new Map(); this.frames = [];
    this.child = spawn(process.execPath, [ROOT + '/fixture.mjs', dir, channel], { cwd: dir + '/workspace', stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', data => fs.appendFileSync(dir + '/offline-stderr.log', data));
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      const frame = JSON.parse(line); this.frames.push(frame);
      if (this.pending.has(frame.id)) { this.pending.get(frame.id)(frame); this.pending.delete(frame.id); }
    });
  }
  frame(frame) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'); }
  request(method, params) {
    const id = ++this.id;
    const promise = new Promise(resolve => this.pending.set(id, resolve));
    this.frame({ id, method, params });
    return { id, promise };
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-only', version: '1' } }).promise;
    this.frame({ method: 'notifications/initialized' });
    return this;
  }
  call(name, args = {}, owner = 'native-A') {
    const tool_use_id = `offline-${this.child.pid}-${this.id + 1}`;
    const updated = hook(this.dir, { hook_event_name: 'PreToolUse', agent_id: owner ?? undefined,
      agent_type: owner ? 'fixture-native' : undefined, tool_name: `mcp__${this.channel}__${name}`,
      tool_use_id, tool_input: args });
    return this.request('tools/call', { name, arguments: updated,
      _meta: { 'claudecode/toolUseId': tool_use_id, progressToken: 'offline-progress' } });
  }
}
const content = frame => JSON.parse(frame.result.content[0].text);
async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Offline condition timed out'); await sleep(50); }
}

async function fakeHost() {
  if (process.argv.includes('--version')) { console.log('offline-fixture'); return; }
  if (process.argv.includes('--help')) {
    console.log('--setting-sources --strict-mcp-config --agents --settings --tools --max-budget-usd --include-hook-events --forward-subagent-text --no-session-persistence'); return;
  }
  const dir = path.dirname(process.argv[process.argv.indexOf('--settings') + 1]);
  hook(dir, { hook_event_name: 'SessionStart' });
  hook(dir, { hook_event_name: 'SubagentStart', agent_id: 'native-A', agent_type: 'fixture-native' });
  const client = await new Client(dir).init();
  const state = content(await client.call('send', { cwd: dir + '/child-workspace' }).promise);
  await client.call('wait', { executionId: state.executionId, cwd: dir + '/child-workspace', seconds: 0.1 }).promise;
  hook(dir, { hook_event_name: 'SessionEnd' });
  console.log(JSON.stringify({ type: 'result', subtype: 'offline', total_cost_usd: 0 }));
  client.child.stdin.end();
  await sleep(100);
  process.exit(0); // Detached workers deliberately survive; the runner must observe and reap them.
}

async function verify() {
  const base = ROOT + '/runs/offline-' + Date.now();
  const active = [];
  const clients = [];
  const checks = [];
  const unverified = [];
  const canInspect = !!processInfo(process.pid).birth;
  const check = name => checks.push(name);
  try {
    const authDefault = prepare('smoke', { dir: base + '/auth-default' });
    assert.equal(Object.hasOwn(hostEnv(authDefault), 'CLAUDE_CONFIG_DIR'), false,
      'default authentication must not redirect the operator config directory');
    // Materialize every scenario, but execute only our own fake host below.
    for (const name of Object.keys(scenarios)) {
      const dir = prepare(name, { dir: base + '/definitions/' + name, isolatedConfig: true });
      const command = readJSON(dir + '/command.json');
      const agents = readJSON(dir + '/agents.json');
      assert.deepEqual(agents['fixture-native'].mcpServers, ['fixture']);
      assert.equal(command.envOverrides.CLAUDE_CONFIG_DIR, dir + '/host-home');
      assert(!JSON.stringify(command).includes('/.claude/'));
      assert.equal(command.args.includes('--max-budget-usd'), scenarios[name].mode === 'headless');
      assert(readJSON(dir + '/settings.json').hooks.PreCompact);
    }
    check(`${Object.keys(scenarios).length} scenario definitions and isolated configs`);
    const dir = prepare('smoke', { dir: base + '/protocol', overrides: { progress: true, progressSec: 0.05, workSec: 20 } });
    active.push(dir);
    hook(dir, { hook_event_name: 'SubagentStart', agent_id: 'native-A', agent_type: 'fixture-native' });
    hook(dir, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'spawn', tool_response: { agentId: 'native-A' } });
    const client = await new Client(dir).init();
    clients.push(client);
    const tools = await client.request('tools/list', {}).promise;
    assert.deepEqual(tools.result.tools.map(t => t.name), ['catalog', 'send', 'wait', 'stop']);
    await client.call('catalog', { thread: 'forged' }, null).promise;
    assert.equal(fs.readdirSync(dir + '/executions').length, 0);
    const refused = await client.call('send', { cwd: dir + '/child-workspace', thread: 'forged' }, null).promise;
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.content[0].text, 'NATIVE_OWNER_REQUIRED');
    check('catalog is observational; hook clears a fabricated parent owner');
    const started = content(await client.call('send', { cwd: dir + '/child-link', thread: 'forged' }).promise);
    assert.equal(started.status, 'running');
    assert.equal(started.cwd, fs.realpathSync(dir + '/child-link'));
    await until(() => pidRecords(dir).filter(p => ['worker', 'leaf', 'grandchild'].includes(p.role)).length === 3);
    const tree = pidRecords(dir).filter(p => ['worker', 'leaf', 'grandchild'].includes(p.role));
    if (canInspect) {
      assert.equal(tree.find(p => p.role === 'worker').pgid, tree.find(p => p.role === 'leaf').pgid);
      assert.notEqual(tree.find(p => p.role === 'worker').pgid, tree.find(p => p.role === 'grandchild').pgid);
      check('worker/leaf and separate grandchild process groups');
    } else unverified.push('Process groups: sandbox denies ps');
    check('worker, leaf and grandchild are recorded at spawn');
    const wrongOwner = await client.call('wait', { executionId: started.executionId, seconds: 0, cwd: dir + '/child-workspace' }, 'native-B').promise;
    assert.equal(wrongOwner.result.content[0].text, 'OWNER_MISMATCH');
    const wrongCwd = await client.call('wait', { executionId: started.executionId, seconds: 0, cwd: dir + '/workspace' }).promise;
    assert.equal(wrongCwd.result.content[0].text, 'WORKSPACE_MISMATCH');
    const relative = await client.call('send', { cwd: './child-workspace' }, 'native-B').promise;
    assert.equal(relative.result.content[0].text, 'CWD_MUST_BE_EXPLICIT_AND_ABSOLUTE');
    check('owner and canonical cwd enforcement');
    const wait = client.call('wait', { executionId: started.executionId, seconds: 0.4, cwd: dir + '/child-workspace' });
    await until(() => rows(dir, 'events.jsonl').some(x => x.event === 'phase' && x.phase === 'pending-wait'));
    hook(dir, { hook_event_name: 'PreToolUse', tool_name: 'TaskStop', tool_use_id: 'stop', tool_input: { task_id: 'native-A' } });
    client.frame({ method: 'notifications/cancelled', params: { requestId: wait.id, reason: 'offline cancellation' } });
    assert.equal(content(await wait.promise).status, 'running');
    assert(client.frames.some(x => x.method === 'notifications/progress'));
    assert.equal(content(await client.call('stop', { executionId: started.executionId }).promise).cleanupImplemented, false);
    check('bounded wait/progress/cancellation; stop remains passive');
    hook(dir, { hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_use_id: 'resume',
      tool_input: { to: 'native-A', message: 'catalog marker=resume-confirmed' } });
    hook(dir, { hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_use_id: 'resume', tool_response: { resumedAgentId: 'native-A' } });
    await client.call('catalog', { marker: 'resume-confirmed' }).promise;
    client.child.stdin.end();
    await until(() => rows(dir, 'events.jsonl').some(x => x.event === 'stdin_eof'));
    const replacement = await new Client(dir).init(); clients.push(replacement);
    const control = await new Client(dir, 'fixture_control').init(); clients.push(control);
    const independent = content(await control.call('send', { cwd: dir + '/child-workspace' }, 'native-B').promise);
    replacement.call('wait', { executionId: started.executionId, seconds: 10, cwd: dir + '/child-workspace' });
    await until(() => rows(dir, 'events.jsonl').some(x => x.event === 'phase' && x.pid === replacement.child.pid && x.phase === 'pending-wait'));
    log(dir, 'controller.jsonl', 'host_event', { name: 'fixture-sigkill', target: replacement.child.pid, owner: 'native-A' });
    // Retained ChildProcess handle from this test's own spawn; no process-name or unverified-PID lookup.
    replacement.child.kill('SIGKILL');
    assert.equal(content(await control.call('wait', { executionId: independent.executionId, seconds: 0.05,
      cwd: dir + '/child-workspace' }, 'native-B').promise).status, 'running');
    const restarted = await new Client(dir).init(); clients.push(restarted);
    assert.equal(content(await restarted.call('wait', { executionId: started.executionId, seconds: 0.05,
      cwd: dir + '/child-workspace' }).promise).executionId, started.executionId);
    restarted.child.stdin.end(); control.child.stdin.end();
    check('fixture SIGKILL leaves independent connection usable; a fresh fake server can read saved execution');
    // Positive survival evidence after EOF/cancellation, before any supervisor cleanup.
    for (let i = 0; i < 7; i++) { snapshot(dir, 'offline-observation'); await sleep(1000); }
    assert(tree.every(p => { try { process.kill(p.target, 0); return true; } catch { return false; } }));
    const result = analyze(dir);
    assert(result.nativeOwnerPerCall.some(c => c.identity === 'native-owner-matches'));
    assert(result.nativeOwnerPerCall.some(c => c.identity === 'ownerless' && c.error === 'NATIVE_OWNER_REQUIRED'));
    assert(result.hostEvents.find(e => e.name === 'TaskStop').survivalPlus5s.every(p => p.alive === true));
    assert.equal(result.sameChildResume[0].outcome, 'same-native-owner-call-observed');
    assert(result.allReceivedSignals.some(s => s.signal === 'EOF'));
    check('analyzer joins native identity, native stop mapping, resume and measured +5 s survival');
    const unsafe = signalPID(dir, { target: process.pid, role: 'foreign', birth: 'invalid' }, 'SIGTERM', 'offline-identity-check');
    assert.equal(unsafe.state, 'not-in-spawn-ledger');
    if (!canInspect) {
      await until(() => pidRecords(dir).every(p => processInfo(p.target).state === 'absent'), 24000);
      const finished = await new Client(dir).init(); clients.push(finished);
      assert.equal(content(await finished.call('wait', { executionId: started.executionId, seconds: 0,
        cwd: dir + '/child-workspace' }).promise).status, 'finished');
      assert.equal(content(await finished.call('stop', { executionId: started.executionId }).promise).status, 'finished');
      finished.child.stdin.end();
      await until(() => processInfo(finished.child.pid).state === 'absent');
      check('saved fake completion is returned as finished after server replacement');
    }
    snapshot(dir, 'measurement-end');
    assert.equal((await cleanup(dir)).allGone, true);
    const after = analyze(dir);
    assert(after.hostEvents.find(e => e.name === 'TaskStop').survivalPlus5s.every(p => p.alive === true));
    check('unrecorded PID refusal; post-run exit verification; cleanup cannot rewrite measured survival');
    if (!canInspect) unverified.push('Targeted termination and full runner execution: ps preflight correctly refuses in this sandbox; offline workers exited on their planned timer');

    const empty = base + '/definitions/cwd-missing';
    fs.writeFileSync(empty + '/events.jsonl', '{"event":"partial"');
    const missing = analyze(empty);
    assert.equal(missing.parseIssues.length, 1);
    assert.equal(missing.cleanup, null);
    assert.equal(missing.sameChildResume.length, 0);
    check('partial tail and missing evidence stay unresolved');

    const fakeBin = base + '/fake-host.sh';
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(fakeBin, `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(ROOT + '/verify.mjs')} --fake-host "$@"\n`, { mode: 0o700 });
    const run = prepare('smoke', { dir: base + '/runner', bin: fakeBin, version: 'offline-fixture' });
    active.push(run);
    const runnerCode = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [ROOT + '/runner.mjs', 'execute', run], {
        env: { ...process.env, ANTHROPIC_API_KEY: 'offline-placeholder', CLAUDE_CODE_OAUTH_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; p.stdout.on('data', x => { output += x; }); p.stderr.on('data', x => { output += x; });
      const timer = setTimeout(() => p.kill('SIGTERM'), 30000);
      p.on('exit', code => {
        clearTimeout(timer);
        if (!canInspect && code === 1 && output.includes('Process inspection (ps) is unavailable')) resolve(code);
        else code === 0 ? resolve(code) : reject(Error(`Fake runner exit ${code}: ${output}`));
      });
    });
    if (runnerCode === 0) {
      assert.equal(readJSON(run + '/cleanup.json').allGone, true);
      assert(readJSON(run + '/analysis.json').survivalAtMeasurementEnd.every(p => p.alive === true));
      check('full runner with fake executable, isolated env, persistence, observation and cleanup');
    } else { assert(!fs.existsSync(run + '/host.json')); check('runner refuses before host launch when PID inspection is unavailable'); }
    const tuiRun = prepare('clear', { dir: base + '/pty', bin: fakeBin, version: 'offline-fixture' });
    writeJSON(base + '/verification.json', { offlineOnly: true, checks, unverified, fakeTuiRun: tuiRun });
    console.log(JSON.stringify({ offlineOnly: true, checks, unverified, evidence: base + '/verification.json', fakeTuiRun: tuiRun }, null, 2));
  } finally {
    for (const client of clients) client.child.stdin.end();
    for (const dir of active) {
      if (!canInspect) await until(() => pidRecords(dir).every(p => processInfo(p.target).state === 'absent'), 16000);
      if (!readJSON(dir + '/cleanup.json')?.allGone) await cleanup(dir);
    }
  }
}
if (process.argv[2] === '--fake-host') await fakeHost();
else await verify();
