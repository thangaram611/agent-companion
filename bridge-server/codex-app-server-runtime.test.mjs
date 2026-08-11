// bridge-server/codex-app-server-runtime.test.mjs
//
// Zero real codex, zero tokens. Three levels, deliberately:
//   - the accumulator is fed plain notification objects and touches nothing;
//   - the guards (approvalPolicy, absent model, resume-before-act, the single
//     turn/start path) run against a REAL connection over a stubbed socket, so
//     the framing and the guards under test are the shipped ones;
//   - one end-to-end drives the adapter through the REAL broker over a REAL unix
//     socket against the shared fake app-server. That last one is the test that
//     proves the two Wave B modules actually agree.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveCodexAdapter,
  codexAppServerActive,
  codexAppServerRuntimeInfo,
  codexAppServerSandbox,
  codexAppServerPromptId,
  createCodexTurnAccumulator,
  connectCodexBroker,
  ensureCodexBroker,
  probeCodexBrokerHealth,
  codexBrokerSnapshot,
  syncCodexBrokerLeases,
  reapIdleCodexBroker,
  codexBrokerIdleTtlMs,
  startCodexThread,
  resumeCodexThread,
  readCodexThread,
  startCodexTurn,
  steerCodexTurn,
  interruptCodexTurn,
  listLoadedCodexThreads,
  getCodexThreadStatus,
  openCodexTurnWatcher,
  LEASE_STALE_MS,
  _setForTest,
  _resetForTest,
} from './codex-app-server-runtime.mjs';
import { resolveCodexTimeoutMs } from './codex-runtime.mjs';
import { CODEX_PINNED_VERSION } from '../lib/codex-app-server-contract.mjs';
import { fakeCodexBin } from '../test/fake-codex-app-server.mjs';

const TID = 'T1';

let regDir;
beforeEach(() => {
  regDir = mkdtempSync(join(tmpdir(), 'cx-reg-'));
  process.env.AGENT_CODEX_BROKER_REGISTRY = join(regDir, 'broker.json');
  // Pinned so no test reaches into the real runtime dir (which `runtimeDir()`
  // would create) and so the registry's path+pid identity has a stable path.
  process.env.CODEX_BROKER_SOCKET_PATH = join(regDir, 'b.sock');
  _resetForTest();
});
afterEach(() => {
  _resetForTest();
  delete process.env.AGENT_CODEX_BROKER_REGISTRY;
  delete process.env.CODEX_BROKER_SOCKET_PATH;
  rmSync(regDir, { recursive: true, force: true });
});

function brokerSocketPath() { return process.env.CODEX_BROKER_SOCKET_PATH; }

// --- fixtures ----------------------------------------------------------------

// A stand-in for the broker's end of the socket: it speaks the same
// newline-delimited JSON, records every frame the adapter sent, and lets a test
// push notifications back. `_impl.connect` hands this to the real
// createConnection, so the framing, the id map, the ownership tracking and the
// guards are all the shipped code.
function fakeBrokerSocket({ handlers = {}, statuses = {} } = {}) {
  const sock = new EventEmitter();
  sock.frames = [];  // everything the adapter wrote
  sock.calls = [];   // …of which the method-carrying ones
  sock.setEncoding = () => {};
  sock.off = sock.removeListener.bind(sock);
  sock.destroyed = false;
  sock.end = () => { sock.ended = true; };
  sock.destroy = () => { sock.destroyed = true; };
  sock.methods = () => sock.calls.map((c) => c.method);
  // Everything after the local `initialize` handshake, which every test would
  // otherwise have to skip past.
  sock.wire = () => sock.methods().filter((m) => m !== 'initialize');
  sock.paramsFor = (method) => sock.calls.filter((c) => c.method === method).map((c) => c.params);
  sock.deliver = (frame) => sock.emit('data', `${JSON.stringify(frame)}\n`);

  const defaults = {
    initialize: () => ({
      brokered: true,
      protocol: 1,
      brokerPid: 4242,
      appServerPid: 4243,
      appServerInitialized: true,
      codexVersion: '0.147.0',
      codexVersionProbed: true,
    }),
    'broker/status': () => ({ ok: true, protocol: 1, brokerPid: 4242, appServerPid: 4243, uptimeMs: 1, clients: 1, subscriptions: 0 }),
    'broker/subscribe': (p) => ({ ok: true, threadId: p.threadId, flushed: 0 }),
    'broker/unsubscribe': (p) => ({ ok: true, threadId: p.threadId }),
    'thread/start': () => ({ thread: { id: TID, path: `/fake/rollout-${TID}.jsonl` } }),
    'thread/resume': (p) => ({ thread: { id: p.threadId, status: { type: statuses[p.threadId] || 'idle' } } }),
    'thread/read': (p) => ({ thread: { id: p.threadId }, turns: [{ items: [] }] }),
    'thread/loaded/list': () => ({ data: [] }),
    'turn/start': () => ({ turn: { id: 'TURN1' } }),
    'turn/steer': () => ({}),
    'turn/interrupt': () => ({}),
  };

  sock.write = (text) => {
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      sock.frames.push(msg);
      if (typeof msg.method === 'string') sock.calls.push(msg);
      if (msg.id === undefined || typeof msg.method !== 'string') continue;
      const handler = handlers[msg.method] || defaults[msg.method] || (() => ({ echo: msg.method }));
      queueMicrotask(async () => {
        let result;
        // Awaited, so a handler can model a broker that simply never answers.
        try { result = await handler(msg.params || {}, msg); }
        catch (err) { sock.deliver({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: err.message } }); return; }
        if (result && result.__error) { sock.deliver({ jsonrpc: '2.0', id: msg.id, error: result.__error }); return; }
        sock.deliver({ jsonrpc: '2.0', id: msg.id, result });
      });
    }
    return true;
  };
  return sock;
}

async function connectFake(opts = {}, { env = {} } = {}) {
  const sock = fakeBrokerSocket(opts);
  _setForTest({ connect: async () => sock });
  const conn = await connectCodexBroker({ socketPath: '/fake.sock', env });
  return { conn, sock };
}

const note = (method, params) => ({ jsonrpc: '2.0', method, params });

// --- adapter selection -------------------------------------------------------

test('the adapter defaults to exec and only `appserver` switches it', () => {
  assert.equal(resolveCodexAdapter({}), 'exec');
  assert.equal(codexAppServerActive({}), false);
  assert.equal(resolveCodexAdapter({ CODEX_RUNTIME_ADAPTER: 'appserver' }), 'appserver');
  assert.equal(codexAppServerActive({ CODEX_RUNTIME_ADAPTER: 'APPSERVER' }), true);
  // Anything unrecognised falls back to the shipped default rather than to a
  // half-configured transport.
  assert.equal(resolveCodexAdapter({ CODEX_RUNTIME_ADAPTER: 'nonsense' }), 'exec');
  assert.equal(resolveCodexAdapter({ CODEX_RUNTIME_ADAPTER: 'server' }), 'exec');
});

test('runtime info reports the pinned contract, the socket and a never-approval policy', () => {
  const info = codexAppServerRuntimeInfo({ CODEX_RUNTIME_ADAPTER: 'appserver' });
  assert.equal(info.adapter, 'appserver');
  assert.equal(info.approvalPolicy, 'never');
  assert.equal(info.pinned_version, CODEX_PINNED_VERSION);
  assert.ok(info.socket.endsWith('.sock'));
  assert.ok(info.broker.endsWith('codex-app-server-broker.mjs'));
  assert.equal(info.timeout_ms, resolveCodexTimeoutMs({}));
  // No broker has spoken yet, so there is no installed version to report — an
  // absent key beats a guess.
  assert.equal('installed_version' in info, false);
});

test('the sandbox comes from the exec adapter\'s one resolver, with bypass collapsed', () => {
  assert.equal(codexAppServerSandbox({}).mode, 'workspace-write');
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' }).mode, 'read-only');
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'danger-full-access' }).mode, 'danger-full-access');
  // `bypass` is the exec spelling of "no sandbox AND no approvals"; the
  // app-server splits those, and the approvals half is pinned to `never` here.
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' }).mode, 'danger-full-access');
  // An unrecognised value never reaches the wire verbatim and never escalates.
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'yolo' }).mode, 'workspace-write');
  // The network toggle is reported but not sent — said out loud, not implied.
  assert.equal(codexAppServerSandbox({}).network_applied, false);
});

test('promptId keeps the codex prefix and encodes reply generation', () => {
  assert.equal(codexAppServerPromptId('j1'), 'codex-j1');
  assert.equal(codexAppServerPromptId('j1', 2), 'codex-j1-r2');
});

// --- the pure accumulator ----------------------------------------------------

test('the accumulator streams deltas, folds a command, and completes on turn/completed', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('turn/started', { threadId: TID, turn: { id: 'TURN1' } }));
  acc.push(note('item/started', { threadId: TID, item: { id: 'i1', type: 'commandExecution', command: 'npm test' } }));
  acc.push(note('item/commandExecution/outputDelta', { threadId: TID, itemId: 'i1', chunk: 'ok\n' }));
  acc.push(note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'Hello ' }));
  acc.push(note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'world' }));

  // Mid-turn the snapshot is already useful — this is the sub-turn progress the
  // exec transport structurally cannot give (F7).
  assert.equal(acc.terminal, null);
  assert.equal(acc.snapshot().message, 'Hello world');
  assert.equal(acc.snapshot().toolCalls[0].status, 'in_progress');
  assert.equal(acc.snapshot().toolCalls[0].aggregated_output, 'ok\n');

  acc.push(note('item/completed', { threadId: TID, item: { id: 'i1', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok\n1 passing\n' } }));
  acc.push(note('item/completed', { threadId: TID, item: { id: 'm1', type: 'agentMessage', text: 'Hello world', phase: 'final_answer' } }));
  acc.push(note('turn/completed', { threadId: TID, turn: { id: 'TURN1', status: 'completed', items: [] } }));

  assert.deepEqual(acc.terminal, { status: 'completed', reason: 'turn/completed', error: null });
  const snap = acc.snapshot();
  assert.equal(snap.message, 'Hello world');
  assert.equal(acc.turnId, 'TURN1');
  assert.equal(snap.toolCalls.length, 1, 'item/started and item/completed are ONE tool call, not two');
  assert.deepEqual(snap.toolCalls[0], {
    name: 'shell',
    input: { command: 'npm test' },
    status: 'completed',
    exit_code: 0,
    aggregated_output: 'ok\n1 passing\n',
  });
});

test('the accumulator prefers the final answer over the commentary preamble', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/completed', { threadId: TID, item: { id: 'm1', type: 'agentMessage', text: 'Let me look at that.', phase: 'commentary' } }));
  acc.push(note('item/completed', { threadId: TID, item: { id: 'm2', type: 'agentMessage', text: 'THE ANSWER', phase: 'final_answer' } }));
  acc.push(note('item/completed', { threadId: TID, item: { id: 'm3', type: 'agentMessage', text: 'Anything else?', phase: 'commentary' } }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.equal(acc.snapshot().message, 'THE ANSWER');
});

test('an interrupted turn settles cancelled, with no answer', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'partial thought' }));
  acc.push(note('turn/completed', { threadId: TID, turn: { id: 'TURN1', status: 'interrupted', items: [] } }));
  assert.equal(acc.terminal.status, 'cancelled');
  assert.equal(acc.terminal.reason, 'interrupted');
  // Whatever streamed before the interrupt is kept — it is the only salvage
  // there is for a cancelled turn.
  assert.equal(acc.snapshot().message, 'partial thought');
});

test('a failed command does not render like a successful one', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/started', { threadId: TID, item: { id: 'i1', type: 'commandExecution', command: 'make build' } }));
  acc.push(note('item/completed', {
    threadId: TID,
    item: { id: 'i1', type: 'commandExecution', command: 'make build', status: 'failed', exitCode: 2, aggregatedOutput: 'ld: symbol not found' },
  }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  const call = acc.snapshot().toolCalls[0];
  assert.equal(call.status, 'failed');
  assert.equal(call.exit_code, 2);
  assert.match(call.aggregated_output, /symbol not found/);
  // The outcome lives on the ENTRY, never inside `input` — `input` stays the
  // invocation, which is what formatTerminalContent reads for "Files touched".
  assert.deepEqual(call.input, { command: 'make build' });
});

test('a reasoning-only turn still produces content', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/reasoning/textDelta', { threadId: TID, itemId: 'r1', delta: 'weighing ' }));
  acc.push(note('item/reasoning/textDelta', { threadId: TID, itemId: 'r1', delta: 'options' }));
  acc.push(note('item/reasoning/summaryTextDelta', { threadId: TID, itemId: 'r2', delta: 'decided' }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  const snap = acc.snapshot();
  assert.equal(snap.message, '');
  assert.equal(snap.thoughts, 'weighing options\ndecided');
  // isEmptyCompletedSummary treats blank message + blank thoughts + no tools as
  // "completed but returned nothing"; thoughts are what keep this off that path.
  assert.notEqual(snap.thoughts.trim(), '');
});

test('a completed reasoning item replaces the deltas that streamed it', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/reasoning/textDelta', { threadId: TID, itemId: 'r1', delta: 'half' }));
  acc.push(note('item/completed', { threadId: TID, item: { id: 'r1', type: 'reasoning', text: 'half a thought, whole' } }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.equal(acc.snapshot().thoughts, 'half a thought, whole');
});

test('turn/completed replays its items without duplicating what already streamed', () => {
  // The salvage path for a bridge that attached mid-turn: the replay must add
  // what it missed and double nothing it saw.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/completed', { threadId: TID, item: { id: 'i1', type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0 } }));
  acc.push(note('item/completed', { threadId: TID, item: { id: 'f1', type: 'fileChange', path: 'src/a.mjs', kind: 'modified' } }));
  acc.push(note('turn/completed', {
    threadId: TID,
    turn: {
      status: 'completed',
      items: [
        { id: 'i1', type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0 },
        { id: 'f1', type: 'fileChange', path: 'src/a.mjs', kind: 'modified' },
        { id: 'm9', type: 'agentMessage', text: 'ONLY IN THE REPLAY', phase: 'final_answer' },
      ],
    },
  }));
  const snap = acc.snapshot();
  assert.equal(snap.message, 'ONLY IN THE REPLAY');
  assert.equal(snap.toolCalls.length, 2, `expected no duplicates, got ${JSON.stringify(snap.toolCalls)}`);
  assert.deepEqual(snap.toolCalls.map((t) => t.input.path ?? t.input.command), ['ls', 'src/a.mjs']);
});

test('another job\'s notifications never reach this thread\'s accumulator', () => {
  // The leak the broker's subscription filter closes — asserted from the client
  // side too, because a broker bug and an accumulator bug look identical in a
  // digest.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/agentMessage/delta', { threadId: 'OTHER', itemId: 'm1', delta: 'someone else\'s answer' }));
  acc.push(note('turn/completed', { threadId: 'OTHER', turn: { status: 'completed' } }));
  assert.equal(acc.sawEvent, false);
  assert.equal(acc.terminal, null);
  assert.equal(acc.snapshot().message, '');

  // `thread/started` is the one notification that nests the id; the contract
  // resolves it without a special case here.
  acc.push(note('thread/started', { thread: { id: TID } }));
  assert.equal(acc.sawEvent, true);
});

test('a thread-scoped error and an app-server death are both terminal, and differently', () => {
  const failed = createCodexTurnAccumulator(TID);
  failed.push(note('error', { threadId: TID, message: 'model overloaded' }));
  assert.equal(failed.terminal.status, 'failed');
  assert.equal(failed.terminal.error, 'model overloaded');

  const died = createCodexTurnAccumulator(TID);
  died.push(note('broker/appServerDied', { code: 7, signal: null }));
  assert.equal(died.terminal.status, 'unreachable');
  assert.match(died.terminal.error, /in-flight turn was lost/);
});

test('an item-level error is recorded but does not end the turn', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/completed', { threadId: TID, item: { id: 'e1', type: 'error', message: 'tool blew up' } }));
  assert.equal(acc.terminal, null);
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.equal(acc.terminal.status, 'completed');
  assert.equal(acc.snapshot().error, 'tool blew up');
});

test('a plan-only turn carries its plan so it does not read as empty', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('turn/plan/updated', { threadId: TID, plan: [{ step: 'read the file', status: 'pending' }] }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.deepEqual(acc.snapshot().plan, [{ step: 'read the file', status: 'pending' }]);
});

// --- approvalPolicy and the absent model -------------------------------------

test('every thread/start and thread/resume carries approvalPolicy never and the sandbox', async () => {
  const { conn, sock } = await connectFake({}, { env: { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' } });
  const env = { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' };
  await startCodexThread({ conn, cwd: '/w', env });
  await resumeCodexThread({ conn, threadId: TID, env });
  conn.close();

  const payloads = [...sock.paramsFor('thread/start'), ...sock.paramsFor('thread/resume')];
  assert.equal(payloads.length, 2);
  for (const params of payloads) {
    assert.equal(params.approvalPolicy, 'never');
    // Resume re-derives its context from config when `sandbox` is omitted, which
    // is the measured silent-de-escalation trap. It is sent on BOTH.
    assert.equal(params.sandbox, 'read-only');
  }
});

test('no env var can relax the approval policy', async () => {
  // Auto-accepting one approval on a measured read-only thread WROTE A FILE, so
  // `never` is the only setting under which the sandbox is the hard boundary.
  // There is deliberately no knob; this asserts nobody added one.
  const hostile = {
    AGENT_COMPANION_CODEX_APPROVAL_POLICY: 'on-request',
    CODEX_APPROVAL_POLICY: 'on-request',
    AGENT_COMPANION_CODEX_APPROVALS: 'auto',
    APPROVAL_POLICY: 'on-request',
    AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only',
  };
  const { conn, sock } = await connectFake({}, { env: hostile });
  await startCodexThread({ conn, cwd: '/w', env: hostile });
  await resumeCodexThread({ conn, threadId: TID, env: hostile });
  conn.close();
  for (const params of [...sock.paramsFor('thread/start'), ...sock.paramsFor('thread/resume')]) {
    assert.equal(params.approvalPolicy, 'never');
  }
});

test('the model key is ABSENT by default, present and logged only on an explicit pin', async () => {
  const logs = [];
  _setForTest({ logEvent: (level, event, fields) => logs.push({ level, event, fields }) });

  const { conn, sock } = await connectFake();
  await startCodexThread({ conn, cwd: '/w', env: {} });
  await resumeCodexThread({ conn, threadId: TID, env: {} });
  // `model: null` is NOT the same as omitting the key — codex would read an
  // explicit null differently from inheritance, and ~/.codex/config.toml is the
  // single source of truth (gpt-5.6-sol / xhigh, measured to inherit).
  for (const params of [...sock.paramsFor('thread/start'), ...sock.paramsFor('thread/resume')]) {
    assert.equal('model' in params, false, `model must be absent, got ${JSON.stringify(params)}`);
  }
  assert.deepEqual(logs, []);

  await startCodexThread({ conn, cwd: '/w', env: {}, model: 'gpt-5.6-codex' });
  conn.close();
  assert.equal(sock.paramsFor('thread/start').at(-1).model, 'gpt-5.6-codex');
  assert.equal(logs.length, 1, 'an override is logged; a default is not');
  assert.equal(logs[0].event, 'codex_appserver_model_pinned');
  assert.equal(logs[0].fields.model, 'gpt-5.6-codex');
});

test('a pinned model survives the resume that reads thread status', async () => {
  // The status read IS a thread/resume, and resume re-derives context from
  // config for the fields it is not given — the measured trap that silently
  // de-escalated a sandbox on the exec transport. A pin that evaporated on the
  // second turn would be the same bug wearing a different hat, and invisible.
  const { conn, sock } = await connectFake({ statuses: { PINNED: 'idle' } });
  await startCodexTurn({ conn, threadId: 'PINNED', prompt: 'go', env: {}, model: 'gpt-5.6-codex' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/start']);
  assert.equal(sock.paramsFor('thread/resume')[0].model, 'gpt-5.6-codex');
  assert.equal(sock.paramsFor('thread/resume')[0].approvalPolicy, 'never');
});

// --- resume before interrupt / steer -----------------------------------------

test('interrupting a thread this connection did not start resumes it first', async () => {
  // `thread not found` from turn/interrupt means "not loaded into THIS
  // app-server", never "gone" — probes/codex-app-server/unloaded.mjs measured
  // the same thread resuming fine straight afterwards. The guard is structural,
  // so the order is what is asserted.
  const { conn, sock } = await connectFake();
  await interruptCodexTurn({ conn, threadId: 'FOREIGN' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/interrupt']);
  assert.equal(sock.paramsFor('thread/resume')[0].threadId, 'FOREIGN');
  assert.equal(sock.paramsFor('thread/resume')[0].approvalPolicy, 'never');
});

test('steering a foreign thread resumes once, and only once', async () => {
  const { conn, sock } = await connectFake();
  await steerCodexTurn({ conn, threadId: 'FOREIGN', prompt: 'change of plan' });
  await steerCodexTurn({ conn, threadId: 'FOREIGN', prompt: 'again' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/steer', 'turn/steer']);
});

test('a thread this connection started needs no resume before acting on it', async () => {
  const { conn, sock } = await connectFake();
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env: {} });
  await interruptCodexTurn({ conn, threadId });
  await steerCodexTurn({ conn, threadId, prompt: 'more' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/start', 'turn/interrupt', 'turn/steer']);
});

test('the resume guard cannot be bypassed by calling the connection directly', async () => {
  const { conn, sock } = await connectFake();
  await conn.call('turn/interrupt', { threadId: 'FOREIGN' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/interrupt']);
});

// --- the single turn/start path ----------------------------------------------

test('turn/start on an active thread attaches instead of double-dispatching', async () => {
  // `turn/start` on a thread with a running turn SUCCEEDS and returns a NEW turn
  // id rather than rejecting, so a missing status check silently runs the job
  // twice.
  const { conn, sock } = await connectFake({ statuses: { BUSY: 'active' } });
  const result = await startCodexTurn({ conn, threadId: 'BUSY', prompt: 'do the thing' });
  conn.close();
  assert.deepEqual(result, { threadId: 'BUSY', turnId: null, attached: true, status: 'active' });
  assert.deepEqual(sock.wire(), ['thread/resume'], 'no second turn may reach the wire');
});

test('turn/start on an idle thread checks status first, then starts exactly one turn', async () => {
  const { conn, sock } = await connectFake({ statuses: { IDLE: 'idle' } });
  const result = await startCodexTurn({ conn, threadId: 'IDLE', prompt: 'go' });
  conn.close();
  assert.equal(result.turnId, 'TURN1');
  assert.equal(result.attached, false);
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/start']);
  assert.deepEqual(sock.paramsFor('turn/start')[0].input, [{ type: 'text', text: 'go' }]);
});

test('a thread just started here skips the status RPC, but its NEXT turn does not', async () => {
  // A thread with no turns has no rollout on disk, so resuming it to ask a
  // question whose answer is already known ("idle, we just made it") is both
  // wasted and the one shape `thread/resume` has no rollout to read.
  const { conn, sock } = await connectFake();
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env: {} });
  await startCodexTurn({ conn, threadId, prompt: 'first' });
  assert.deepEqual(sock.wire(), ['thread/start', 'turn/start']);

  await startCodexTurn({ conn, threadId, prompt: 'second' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/start', 'turn/start', 'thread/resume', 'turn/start']);
});

test('no call site can send a raw turn/start', async () => {
  const { conn, sock } = await connectFake();
  await assert.rejects(
    () => conn.call('turn/start', { threadId: TID, input: [] }),
    /must go through startCodexTurn/,
  );
  conn.close();
  assert.deepEqual(sock.wire(), []);
});

// --- the connection ----------------------------------------------------------

test('a protocol mismatch is an explicit failure, not a degraded connection', async () => {
  const sock = fakeBrokerSocket({ handlers: { initialize: () => ({ brokered: true, protocol: 99 }) } });
  _setForTest({ connect: async () => sock });
  await assert.rejects(() => connectCodexBroker({ socketPath: '/fake.sock' }), /protocol 99/);
  assert.equal(sock.destroyed, true, 'a refused handshake must not leak the socket');
});

test('a handshake that never answers takes its socket down with it', async () => {
  // probeCodexBrokerHealth runs on every ensure and every reaper tick, and it
  // can legitimately hit a wedged listener. One leaked fd per probe is how a
  // long-lived bridge walks into EMFILE — which is also the verdict that makes
  // the socket hardening refuse to do anything at all.
  const sock = fakeBrokerSocket({ handlers: { initialize: () => new Promise(() => {}) } });
  _setForTest({ connect: async () => sock });
  await assert.rejects(() => connectCodexBroker({ socketPath: '/fake.sock', timeoutMs: 20 }), /timed out/);
  assert.equal(sock.destroyed, true);
});

test('an unanswerable server request is refused rather than left to block the turn', async () => {
  // Under `approvalPolicy: never` no approval is ever sent, so anything arriving
  // here is outside what this bridge implements — and silence would wedge the
  // app-server's turn forever.
  const { conn, sock } = await connectFake();
  const seen = [];
  conn.on((msg) => seen.push(msg));
  sock.deliver({ jsonrpc: '2.0', id: 9001, method: 'item/tool/requestUserInput', params: { threadId: TID } });
  await new Promise((r) => setImmediate(r));
  conn.close();

  const answer = sock.frames.find((f) => f.id === 9001 && f.method === undefined);
  assert.ok(answer, 'the app-server must get an answer, not silence');
  assert.equal(answer.error.code, -32601);
  assert.equal(seen.length, 1, 'and the request is still surfaced to observers');
});

test('a closed connection rejects in-flight calls instead of hanging to their timeout', async () => {
  const sock = fakeBrokerSocket({ handlers: { 'thread/loaded/list': () => new Promise(() => {}) } });
  _setForTest({ connect: async () => sock });
  const conn = await connectCodexBroker({ socketPath: '/fake.sock' });
  const inFlight = listLoadedCodexThreads({ conn });
  sock.emit('close');
  await assert.rejects(() => inFlight, /connection closed before thread\/loaded\/list/);
  assert.equal(conn.closed, true);
});

// --- thread/read salvage -----------------------------------------------------

test('thread/read salvages the final answer and says it has no tool record', async () => {
  const { conn } = await connectFake({
    handlers: {
      'thread/read': (p) => ({
        thread: { id: p.threadId },
        turns: [{ items: [
          { type: 'agentMessage', text: 'preamble', phase: 'commentary' },
          { type: 'agentMessage', text: 'THE SALVAGED ANSWER', phase: 'final_answer' },
        ] }],
      }),
    },
  });
  const read = await readCodexThread({ conn, threadId: TID });
  conn.close();
  assert.equal(read.found, true);
  assert.equal(read.summary.message, 'THE SALVAGED ANSWER');
  // Measured: thread/read returns MESSAGES ONLY, even though the rollout for the
  // same thread has commandExecution and reasoning. A complete answer salvage,
  // not a tool-activity record.
  assert.deepEqual(read.summary.toolCalls, []);
});

// --- the turn watcher --------------------------------------------------------

test('the watcher subscribes before it returns, then settles on turn/completed', async () => {
  const { conn, sock } = await connectFake();
  const progress = [];
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, onEvent: (s) => progress.push(s.message), timeoutMs: 5_000 });
  // Subscribing first is what makes "open the watcher, then start the turn"
  // safe: the broker flushes its pre-subscription ring into this client.
  assert.deepEqual(sock.wire(), ['broker/subscribe']);

  sock.deliver(note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'streaming' }));
  sock.deliver(note('turn/completed', { threadId: TID, turn: { id: 'TURN1', status: 'completed' } }));
  const result = await watcher.done;
  conn.close();

  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'streaming');
  assert.equal(result.summary.stopReason, 'turn/completed');
  assert.equal(result.error, null);
  assert.deepEqual(progress, ['streaming', 'streaming']);
});

test('the watcher times out with whatever streamed so far', async () => {
  const { conn, sock } = await connectFake();
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, timeoutMs: 20 });
  sock.deliver(note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'half an answer' }));
  const result = await watcher.done;
  conn.close();
  assert.equal(result.status, 'timeout');
  assert.equal(result.summary.message, 'half an answer');
  assert.match(result.error, /timed out/);
});

test('losing the socket while the broker lives reports a running turn, not a lost one', async () => {
  // The detachable-observer property, surfaced: the bridge stopped watching, the
  // turn did not stop running. Reporting it as lost work would be the exact
  // false verdict this transport was chosen to eliminate.
  const { conn, sock } = await connectFake();
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, timeoutMs: 5_000 });
  // The health re-probe opens a NEW connection; give it a live broker.
  _setForTest({ connect: async () => fakeBrokerSocket() });
  sock.emit('close');
  const result = await watcher.done;
  assert.equal(result.status, 'unreachable');
  assert.match(result.error, /still running on thread T1/);
  assert.match(result.error, /thread\/resume/);
});

test('losing the broker itself reports the turn lost and the thread resumable', async () => {
  const { conn, sock } = await connectFake();
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, timeoutMs: 5_000 });
  const gone = new Error('connect ECONNREFUSED');
  gone.code = 'ECONNREFUSED';
  _setForTest({ connect: async () => { throw gone; } });
  sock.emit('close');
  const result = await watcher.done;
  assert.equal(result.status, 'unreachable');
  assert.match(result.error, /in-flight turn was lost/);
  assert.match(result.error, /still resumable/);
});

test('the level check settles a turn that finished while this bridge was down', async () => {
  const { conn } = await connectFake({
    statuses: { [TID]: 'idle' },
    handlers: {
      'thread/read': (p) => ({ thread: { id: p.threadId }, turns: [{ items: [{ type: 'agentMessage', text: 'finished without us', phase: 'final_answer' }] }] }),
    },
  });
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, initialLevelCheck: true, timeoutMs: 5_000 });
  const result = await watcher.done;
  conn.close();
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'finished without us');
});

test('the level check keeps watching an active thread', async () => {
  const { conn, sock } = await connectFake({ statuses: { [TID]: 'active' } });
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, initialLevelCheck: true, timeoutMs: 5_000 });
  sock.deliver(note('turn/completed', { threadId: TID, turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'live tail', phase: 'final_answer' }] } }));
  const result = await watcher.done;
  conn.close();
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'live tail');
});

// --- ensure / health ---------------------------------------------------------

test('a live broker is reused and never respawned', async () => {
  let spawns = 0;
  _setForTest({ connect: async () => fakeBrokerSocket(), spawnBroker: () => { spawns += 1; return new EventEmitter(); } });
  const first = await ensureCodexBroker({ env: {} });
  const second = await ensureCodexBroker({ env: {} });
  assert.equal(spawns, 0);
  assert.equal(first.reused, true);
  assert.equal(second.reused, true);
  assert.equal(first.pid, 4242);
  // Adoption records the broker so the lease machinery has something to hold.
  assert.equal(codexBrokerSnapshot().pid, 4242);
  // And the version the broker reported is now the runtime-info answer.
  assert.equal(codexAppServerRuntimeInfo({}).installed_version, '0.147.0');
});

test('adopting a REPLACEMENT broker inherits neither the dead one\'s claim nor its leases', async () => {
  // The socket path is fixed, so the entry left by a crashed broker sits at
  // exactly the key its replacement writes to. Merging into it would attach a
  // stale disposal claim to a live broker and credit it with leases whose work
  // died with the process that held them.
  const other = foreignLivePid();
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: 999999,
    lastUsedAt: Date.now() - 60 * 60_000,
    disposing: { pid: other, at: Date.now() },
    leases: { [`${other}:codex-old`]: { pid: other, jobId: 'codex-old', renewedAt: Date.now() } },
  });
  _setForTest({ connect: async () => fakeBrokerSocket() });

  const adopted = await ensureCodexBroker({ env: {} });
  assert.equal(adopted.pid, 4242);
  assert.equal(adopted.disposalClaimed, false);
  const entry = readReg();
  assert.equal(entry.pid, 4242);
  assert.equal(entry.disposing, undefined, 'a dead broker\'s disposal claim must not follow its replacement');
  assert.equal(entry.leases, undefined, 'nor its leases — their owners re-stamp the real ones next tick');
});

test('adopting the SAME broker over a live disposal claim keeps its leases and says so', async () => {
  const other = foreignLivePid();
  const claimedAt = Date.now();
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: 4242,
    lastUsedAt: claimedAt - 60 * 60_000,
    disposing: { pid: other, at: claimedAt },
    leases: { [`${other}:codex-live`]: { pid: other, jobId: 'codex-live', renewedAt: claimedAt } },
  });
  const logs = [];
  _setForTest({ connect: async () => fakeBrokerSocket(), logEvent: (level, event) => logs.push(event) });

  const adopted = await ensureCodexBroker({ env: {} });
  assert.equal(adopted.disposalClaimed, true);
  assert.ok(logs.includes('codex_appserver_adopted_over_disposal_claim'));
  assert.ok(readReg().leases[`${other}:codex-live`], 'the same broker keeps the leases held on it');
  // Recording the adoption refreshes lastUsedAt, which is what makes the
  // claiming reaper stand down at its own confirm step.
  assert.ok(Date.now() - readReg().lastUsedAt < 60_000);
});

test('concurrent callers share ONE spawn', async () => {
  // Without the mutex two parallel dispatches each spawn a broker and race on
  // the socket file; the loser's start-lock refusal is a dispatch failure for
  // no reason at all.
  let spawns = 0;
  let up = false;
  _setForTest({
    connect: async () => {
      if (!up) { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; }
      return fakeBrokerSocket();
    },
    spawnBroker: () => {
      spawns += 1;
      const child = new EventEmitter();
      setTimeout(() => { up = true; }, 30);
      return child;
    },
  });
  const [a, b] = await Promise.all([ensureCodexBroker({ env: {} }), ensureCodexBroker({ env: {} })]);
  assert.equal(spawns, 1, 'two concurrent callers must produce one spawn');
  assert.equal(a.reused, false);
  assert.equal(b.reused, false);
  assert.equal(a.pid, b.pid);
});

test('a broker that dies during boot fails fast and says so', async () => {
  const err = new Error('connect ECONNREFUSED');
  err.code = 'ECONNREFUSED';
  _setForTest({
    connect: async () => { throw err; },
    spawnBroker: () => {
      const child = new EventEmitter();
      setTimeout(() => child.emit('exit', 1, null), 10);
      return child;
    },
  });
  await assert.rejects(() => ensureCodexBroker({ env: {} }), /exited before it was ready \(code=1/);
});

test('a probe that could not tell is never read as "nobody is home"', async () => {
  // EACCES on the runtime dir, EMFILE under a wide subagent fan-out: those are
  // failures to ASK. Spawning on them races a broker that is very much alive.
  let spawns = 0;
  const err = new Error('permission denied');
  err.code = 'EACCES';
  _setForTest({ connect: async () => { throw err; }, spawnBroker: () => { spawns += 1; return new EventEmitter(); } });
  await assert.rejects(() => ensureCodexBroker({ env: {} }), /could not reach the codex broker/);
  assert.equal(spawns, 0);
});

test('a stale socket file does not read as a live broker', async (t) => {
  // SIGKILL skips the unlink handler, so the socket file outlives its broker.
  // Reproduce it rather than faking it with a plain file: presence is not
  // liveness, and only a connect probe can tell.
  const dir = mkdtempSync(join(tmpdir(), 'cxa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'b.sock');

  const holder = spawn(process.execPath, [
    '-e',
    `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  assert.equal(existsSync(socketPath), true, 'the stale socket file should survive SIGKILL');

  const health = await probeCodexBrokerHealth(socketPath);
  assert.equal(health.alive, false);
  assert.equal(health.code, 'ECONNREFUSED', 'and ECONNREFUSED is the connect-class code that authorises a respawn');
});

test('a socket that accepts but never speaks the protocol is not a live broker either', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cxa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'b.sock');
  const { createServer } = await import('node:net');
  const silent = createServer(() => {});
  await new Promise((resolve) => silent.listen(socketPath, resolve));
  t.after(() => { try { silent.close(); } catch {} });

  const health = await probeCodexBrokerHealth(socketPath);
  assert.equal(health.alive, false);
  assert.match(health.error, /timed out/);
  // NOT connect-class: an accepting-but-mute socket is indeterminate, so the
  // adapter refuses rather than spawning a second broker onto the same path.
  assert.equal(health.code, null);
});

// --- leases and the reaper, through the shared registry ----------------------

function regPath() { return process.env.AGENT_CODEX_BROKER_REGISTRY; }
function seedRegistry(entry) { writeFileSync(regPath(), JSON.stringify({ shared: entry })); }
function readReg() { return JSON.parse(readFileSync(regPath(), 'utf8')).shared; }
function foreignLivePid() { return process.ppid; }
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((r) => child.on('close', r));
  return pid;
}

test('the idle reaper stops a broker with nothing loaded and nobody holding it', async () => {
  const gone = await deadPid();
  _setForTest({ connect: async () => fakeBrokerSocket({ handlers: { 'thread/loaded/list': () => ({ data: [] }) } }) });
  seedRegistry({ socketPath: brokerSocketPath(), pid: gone, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true);
  assert.equal(readReg(), undefined);
});

test('the idle reaper refuses a broker that still has a thread loaded', async () => {
  // The case no lease can cover: the bridge that started the turn DIED, so its
  // lease is long gone — and the turn it started is exactly the work this whole
  // transport exists to protect. `thread/loaded/list` is the authoritative
  // answer, immune to the PID reuse a pid probe would suffer.
  const gone = await deadPid();
  _setForTest({ connect: async () => fakeBrokerSocket({ handlers: { 'thread/loaded/list': () => ({ data: ['T-live'] }) } }) });
  seedRegistry({ socketPath: brokerSocketPath(), pid: gone, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), false);
});

test('the idle reaper refuses when it could not interrogate the broker at all', async () => {
  const gone = await deadPid();
  const err = new Error('too many open files');
  err.code = 'EMFILE';
  _setForTest({ connect: async () => { throw err; } });
  seedRegistry({ socketPath: brokerSocketPath(), pid: gone, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), false);
});

test('the idle reaper leaves a broker another live bridge holds a lease on', async () => {
  const other = foreignLivePid();
  _setForTest({ connect: async () => fakeBrokerSocket() });
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: 1234,
    lastUsedAt: Date.now() - 60 * 60_000,
    leases: { [`${other}:codex-job-a`]: { pid: other, jobId: 'codex-job-a', renewedAt: Date.now() } },
  });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000, hasLiveJobs: false }), false);
  assert.ok(readReg().leases[`${other}:codex-job-a`], 'a live lease must survive the prune');
});

test('a lease whose owning bridge died stops pinning the broker', async () => {
  const gone = await deadPid();
  _setForTest({ connect: async () => fakeBrokerSocket() });
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: gone,
    lastUsedAt: Date.now() - 60 * 60_000,
    leases: { [`${gone}:codex-job-a`]: { pid: gone, jobId: 'codex-job-a', renewedAt: Date.now() } },
  });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true);
});

test('a lease that stopped being renewed is reclaimed', async () => {
  const other = foreignLivePid();
  const gone = await deadPid();
  _setForTest({ connect: async () => fakeBrokerSocket() });
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: gone,
    lastUsedAt: Date.now() - 60 * 60_000,
    leases: { [`${other}:codex-job-a`]: { pid: other, jobId: 'codex-job-a', renewedAt: Date.now() - (LEASE_STALE_MS + 60_000) } },
  });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true);
});

test('lease sync drops our finished jobs, keeps another bridge\'s, and refreshes lastUsedAt', async () => {
  const other = foreignLivePid();
  const otherKey = `${other}:codex-theirs`;
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: 1234,
    lastUsedAt: Date.now() - 35 * 60_000,
    leases: { [otherKey]: { pid: other, jobId: 'codex-theirs', renewedAt: Date.now() } },
  });

  syncCodexBrokerLeases(['codex-mine-1', 'codex-mine-2']);
  let leases = readReg().leases;
  assert.ok(leases[`${process.pid}:codex-mine-1`]);
  assert.ok(leases[otherKey], 'another bridge\'s lease must be left alone');
  // Renewal refreshes lastUsedAt, which is what makes a job longer than the idle
  // TTL safe.
  assert.ok(Date.now() - readReg().lastUsedAt < 60_000);

  syncCodexBrokerLeases(['codex-mine-2']);
  leases = readReg().leases;
  assert.equal(leases[`${process.pid}:codex-mine-1`], undefined);
  assert.ok(leases[`${process.pid}:codex-mine-2`]);

  syncCodexBrokerLeases([]);
  assert.deepEqual(Object.keys(readReg().leases), [otherKey]);
});

test('a broker entry missing its pid identifies as nothing and is left alone', async () => {
  // Identity is path + pid, because the socket PATH IS FIXED: a path-only
  // identity would make a broker and the broker that replaced it "the same
  // runtime", and a claim taken against the dead one would authorise SIGTERMing
  // the live one.
  let connects = 0;
  _setForTest({ connect: async () => { connects += 1; return fakeBrokerSocket(); } });
  seedRegistry({ socketPath: brokerSocketPath(), pid: null, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), false);
  assert.equal(connects, 0, 'an unidentifiable entry is not even probed');
  assert.ok(readReg(), 'and it is not erased either');
});

test('the idle TTL is derived from the codex job timeout, never below it', () => {
  assert.ok(
    codexBrokerIdleTtlMs({}) > resolveCodexTimeoutMs({}),
    'the TTL must clear the longest a single job can occupy the broker',
  );
  const long = { AGENT_COMPANION_CODEX_TIMEOUT_MS: String(90 * 60_000) };
  assert.ok(codexBrokerIdleTtlMs(long) > resolveCodexTimeoutMs(long));
  assert.ok(codexBrokerIdleTtlMs(long) > codexBrokerIdleTtlMs({}));
});

// --- end to end: adapter -> real broker -> fake app-server -------------------

test('end to end: a turn streams through the real broker to a terminal summary', async (t) => {
  // Socket paths are truncated at SUN_LEN (~104 bytes), so the temp root stays
  // short.
  const dir = mkdtempSync(join(tmpdir(), 'cxe-'));
  const socketPath = join(dir, 'b.sock');
  const tracePath = join(dir, 'trace.jsonl');
  const prevSocket = process.env.CODEX_BROKER_SOCKET_PATH;
  const prevRuntime = process.env.AGENT_RUNTIME_DIR;
  const prevHb = process.env.AGENT_HEARTBEAT_DIR;
  process.env.CODEX_BROKER_SOCKET_PATH = socketPath;
  process.env.AGENT_RUNTIME_DIR = dir;
  process.env.AGENT_HEARTBEAT_DIR = join(dir, 'hb');
  mkdirSync(process.env.AGENT_HEARTBEAT_DIR, { recursive: true });

  const env = {
    ...process.env,
    CODEX_BIN: fakeCodexBin(dir),
    CODEX_FAKE_TRACE: tracePath,
    CODEX_BROKER_LOG_LEVEL: 'ERROR',
  };

  const broker = await ensureCodexBroker({ env });
  t.after(() => {
    try { process.kill(broker.pid, 'SIGKILL'); } catch { /* already gone */ }
    if (prevSocket === undefined) delete process.env.CODEX_BROKER_SOCKET_PATH; else process.env.CODEX_BROKER_SOCKET_PATH = prevSocket;
    if (prevRuntime === undefined) delete process.env.AGENT_RUNTIME_DIR; else process.env.AGENT_RUNTIME_DIR = prevRuntime;
    if (prevHb === undefined) delete process.env.AGENT_HEARTBEAT_DIR; else process.env.AGENT_HEARTBEAT_DIR = prevHb;
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(broker.reused, false);
  assert.equal(broker.socketPath, socketPath);
  assert.ok(broker.pid > 0);

  // A second ensure adopts rather than spawning a rival.
  assert.equal((await ensureCodexBroker({ env })).reused, true);

  const conn = await connectCodexBroker({ socketPath, env });
  t.after(() => conn.close());
  assert.equal(conn.broker.appServerInitialized, true);
  assert.equal(conn.broker.codexVersionProbed, true);

  const { threadId, rolloutPath } = await startCodexThread({ conn, cwd: dir, env });
  assert.equal(threadId, 'T1');
  assert.match(rolloutPath, /rollout-T1/);

  const watcher = await openCodexTurnWatcher({ conn, threadId, timeoutMs: 20_000, env });
  const turn = await startCodexTurn({ conn, threadId, prompt: 'summarise the repo', env });
  assert.equal(turn.turnId, 'TURN1');
  assert.equal(turn.attached, false);

  // Everything below travels app-server stdout -> broker -> threadId routing ->
  // this connection -> the accumulator. Nothing is injected locally.
  await conn.call('fake/emit', {
    frames: [
      { jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: 'TURN1' } } },
      { jsonrpc: '2.0', method: 'item/started', params: { threadId, item: { id: 'i1', type: 'commandExecution', command: 'rg TODO' } } },
      { jsonrpc: '2.0', method: 'item/reasoning/textDelta', params: { threadId, itemId: 'r1', delta: 'scanning' } },
      { jsonrpc: '2.0', method: 'item/completed', params: { threadId, item: { id: 'i1', type: 'commandExecution', command: 'rg TODO', status: 'failed', exitCode: 1, aggregatedOutput: 'no matches' } } },
      { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, itemId: 'm1', delta: 'No TODOs ' } },
      { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, itemId: 'm1', delta: 'anywhere.' } },
      // Another job's event, on the same broker: it must never land here.
      { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'T-OTHER', itemId: 'x', delta: 'SOMEONE ELSE' } },
      { jsonrpc: '2.0', method: 'item/completed', params: { threadId, item: { id: 'm1', type: 'agentMessage', text: 'No TODOs anywhere.', phase: 'final_answer' } } },
      { jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: 'TURN1', status: 'completed', items: [] } } },
    ],
  });

  const result = await watcher.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.message, 'No TODOs anywhere.');
  assert.equal(result.summary.thoughts, 'scanning');
  assert.equal(result.turnId, 'TURN1');
  assert.equal(result.summary.toolCalls.length, 1);
  assert.equal(result.summary.toolCalls[0].status, 'failed');
  assert.equal(result.summary.toolCalls[0].exit_code, 1);
  assert.ok(!result.summary.message.includes('SOMEONE ELSE'), 'another job\'s stream must not leak in');

  // What the BROKER actually forwarded upstream — the two modules agreeing on
  // the payload, not just on the transport.
  const upstream = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(upstream.filter((m) => m.method === 'initialize').length, 1,
    'the broker handshakes upstream exactly once, on every bridge\'s behalf');
  const start = upstream.find((m) => m.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.sandbox, 'workspace-write');
  assert.equal(start.params.ephemeral, false);
  assert.equal('model' in start.params, false, 'config.toml stays the single source of truth');

  // A LATER bridge — a fresh connection that did not start this thread — must
  // resume before it may interrupt. Asserted on the app-server's own trace.
  const later = await connectCodexBroker({ socketPath, env });
  await interruptCodexTurn({ conn: later, threadId });
  later.close();
  const tail = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .map((m) => m.method).filter((m) => m === 'thread/resume' || m === 'turn/interrupt');
  assert.deepEqual(tail, ['thread/resume', 'turn/interrupt']);
});
