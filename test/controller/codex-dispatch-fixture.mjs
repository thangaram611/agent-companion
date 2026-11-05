import '../sandbox-home.mjs';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { fakeCodexBin } from '../fake-codex-app-server.mjs';
import { note, threadItem } from '../codex-wire-frames.mjs';
import { ManualClock, until } from './helpers.mjs';
import { fixtureSupervisor } from './fixture-table.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';
import { systemClock } from '../../bridge-server/controller/clock.mjs';
import { writeTargetChecks } from '../../lib/state.mjs';
import { queuePath } from '../../lib/runtime-paths.mjs';
import { createBridgeController, dispatch } from '../../bridge-server/server.mjs';

// Real local processes and production codexProvider. Only the OS census is
// replaced: sandboxed ps is unavailable, so the fake reports its identity over
// IPC. ProcessSupervisor still sends real signals and verifies process exit.
export function codexDispatchFixture(t) {
  const dir = mkdtempSync(join(SANDBOX_HOME, 'dispatch-'));
  const bin = fakeCodexBin(dir);
  writeFileSync(join(dir, 'codex-code-mode-host'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  appendFileSync(bin, `
if (process.argv[2] === 'app-server') {
  process.send({ rows: [{ pid: process.pid, ppid: process.ppid, pgid: process.pid, birthTime: process.pid + ':' + performance.timeOrigin }] });
  process.stdin.on('end', () => { if (process.connected) process.disconnect(); });
}
`);
  const trace = join(dir, 'trace.jsonl');
  const env = { ...process.env, CODEX_BIN: bin, CODEX_FAKE_TRACE: trace, AGENT_COMPANION_OWNER_GRACE_MS: '3000' };
  writeTargetChecks({ codex: { ready: true } });
  const records = new Records({ dir: join(dir, 'records'), log: () => {} });
  const clock = new ManualClock();
  const spawns = [];
  const active = createBridgeController({ records, env, clock, createSupervisor: (options) => {
    const supervisor = fixtureSupervisor({ ...options, clock: systemClock });
    const spawn = supervisor.spawn.bind(supervisor);
    supervisor.spawn = (argv, opts) => {
      spawns.push(argv);
      if (argv[0] !== bin) throw new Error('real provider spawn forbidden');
      return spawn(argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    };
    return supervisor;
  } });
  // Keep protocol deadlines real while making native event timestamps exact.
  const create = active.providers.codex.create;
  active.providers.codex.create = () => {
    const adapter = create();
    adapter.clock = { ...systemClock, now: clock.now };
    return adapter;
  };
  const call = async (args, request = {}, controller = active) =>
    (await dispatch(args, { controller, ...request })).structuredContent;
  const send = (task = 'original', thread = 'child') => call({ action: 'send', target: 'codex', cwd: dir, task, thread });
  const adapter = (id) => active.live.get(id).adapter;
  const emit = (id, frames) => adapter(id)._call('fake/emit', { frames });
  const complete = async (id, text = 'native answer') => {
    const a = adapter(id);
    await emit(id, [note('turn/completed', { threadId: a.threadId, turn: { id: a.nativeTurnId, status: 'completed',
      items: [threadItem('agentMessage', { id: 'answer', text, phase: 'final_answer' })] } })]);
    await until(() => records.readResult(id), 'persisted completion');
  };
  const frames = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    for (const a of [...active.live.values()]) await active.cancel({ owner: a.record.owner, executionId: a.record.executionId });
  });
  return { dir, bin, env, records, clock, active, call, send, adapter, emit, complete, frames, spawns };
}

export function diskSnapshot(dir = SANDBOX_HOME) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).sort().filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => [f, statSync(join(dir, f)).mtimeMs, readFileSync(join(dir, f), 'base64')]);
}
export function terminalRows(id) {
  return existsSync(queuePath()) ? readFileSync(queuePath(), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    .filter((row) => row.kind === 'terminal' && row.jobId === id) : [];
}
