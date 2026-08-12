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
  resolveCodexTurnId,
  resolveSteerConfirmMs,
  openCodexTurnWatcher,
  LEASE_STALE_MS,
  _setForTest,
  _resetForTest,
} from './codex-app-server-runtime.mjs';
import { resolveCodexTimeoutMs } from './codex-runtime.mjs';
import { CODEX_PINNED_VERSION } from '../lib/codex-app-server-contract.mjs';
import { note, threadItem, driftNote } from '../test/codex-wire-frames.mjs';
import { fakeCodexBin } from '../test/fake-codex-app-server.mjs';
import { fakeBrokerSocket, FAKE_BROKER_PID } from '../test/fake-codex-broker-socket.mjs';

// Every artifact this suite provokes goes into its own sandbox, and neither pin
// is ever unset: clearing a redirect is exactly what re-points a straggler at
// the real path.
//
//   AGENT_COMPANION_HOME → lib/log.mjs's daemon.log. Measured 861 bytes of
//     fabricated broker events per run appended to the operator's live
//     ~/.claude/agent-companion/daemon.log — `codex_appserver_dispose_pid_mismatch`
//     for pid 777777, a disposal claim by pid 23107, none of which existed.
//   AGENT_RUNTIME_DIR → everything lib/runtime-paths.mjs resolves, so the
//     registry and socket pins in beforeEach have a sandboxed FLOOR rather than
//     being the only thing between this suite and the real runtime dir.
//
// Short dir names on purpose: a unix socket path over SUN_LEN (~104 bytes on
// darwin) binds a silently truncated name (lib/runtime-paths.mjs).
const HOME_SANDBOX = mkdtempSync(join(tmpdir(), 'cx-home-'));
process.env.AGENT_COMPANION_HOME = HOME_SANDBOX;
const RUNTIME_SANDBOX = mkdtempSync(join(tmpdir(), 'cx-rt-'));
process.env.AGENT_RUNTIME_DIR = RUNTIME_SANDBOX;
test.after(() => {
  rmSync(HOME_SANDBOX, { recursive: true, force: true });
  rmSync(RUNTIME_SANDBOX, { recursive: true, force: true });
});

const TID = 'T1';
const BROKER_PID = FAKE_BROKER_PID;

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

// The broker's end of the socket lives in test/fake-codex-broker-socket.mjs,
// shared with bridge-server/server.test.mjs so the bridge's wiring tests and
// this suite cannot disagree about what a broker does.

async function connectFake(opts = {}, { env = {} } = {}) {
  const sock = fakeBrokerSocket(opts);
  _setForTest({ connect: async () => sock });
  const conn = await connectCodexBroker({ socketPath: '/fake.sock', env });
  return { conn, sock };
}

// `note` and `threadItem` come from test/codex-wire-frames.mjs, which BUILDS
// every frame from the pinned contract: a field codex-cli 0.147.0 does not send
// cannot be written down here, and the required ones a test does not care about
// are filled in for it. The hand-rolled `{jsonrpc, method, params}` literal this
// file used to carry is what let five wrong field names ship with green tests.

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
});

test('every sandbox mode maps to an EXPLICIT sandboxPolicy, network included', () => {
  // The mode enum is all `thread/start` accepts; the network decision rides
  // `turn/start`'s `sandboxPolicy`, whose every variant defaults `networkAccess`
  // to its RESTRICTIVE value (`false` for the booleans, `'restricted'` for
  // `externalSandbox`'s enum). So silence here is the restrictive direction — the
  // opposite of the exec transport, where omitting the `-c` key defers to
  // config.toml and fails OPEN. Both adapters are explicit, for opposite reasons,
  // and this is the table that keeps them agreeing.
  const policyFor = (env) => codexAppServerSandbox(env).policy;

  // Default and explicit workspace-write: network ON, because a delegated job
  // that cannot `npm install` fails confusingly (codex's own exec default is
  // OFF; the bridge turns it on deliberately).
  assert.deepEqual(policyFor({}), { type: 'workspaceWrite', networkAccess: true });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'workspace-write' }),
    { type: 'workspaceWrite', networkAccess: true });
  // An unrecognised mode behaves like unset — same policy, never an escalation.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'yolo' }),
    { type: 'workspaceWrite', networkAccess: true });

  // The off switch is an EXPLICIT false, not an omitted field. It happens to
  // coincide with the union's default here, which is exactly why it has to be
  // asserted: a future variant whose default flipped would take the bridge's
  // "off" with it.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_NETWORK: 'off' }),
    { type: 'workspaceWrite', networkAccess: false });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_NETWORK: 'OFF' }),
    { type: 'workspaceWrite', networkAccess: false });
  // Only `off` turns it off — no other value is a secret second spelling.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_NETWORK: 'no' }),
    { type: 'workspaceWrite', networkAccess: true });

  // read-only carries the field the variant has, at the value the mode means.
  // The exec resolver reports `network: null` here (its toggle is the
  // workspace-write-scoped config key), so the bridge has no opinion and the
  // network env var must not acquire one.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' }),
    { type: 'readOnly', networkAccess: false });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only', AGENT_COMPANION_CODEX_NETWORK: 'off' }),
    { type: 'readOnly', networkAccess: false });

  // dangerFullAccess has NO networkAccess field — the sandbox is gone, so
  // nothing is restricted. Asserting the exact object is what catches a future
  // edit that "helpfully" adds one.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'danger-full-access' }),
    { type: 'dangerFullAccess' });
  // bypass collapses onto it, exactly as the mode mapping does. Deliberately
  // NOT `externalSandbox`: that variant's network vocabulary is
  // `restricted|enabled` rather than a boolean and its semantics were never
  // measured.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' }),
    { type: 'dangerFullAccess' });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass', AGENT_COMPANION_CODEX_NETWORK: 'off' }),
    { type: 'dangerFullAccess' });

  // And the report is true now that the policy is sent. It read `false` for as
  // long as the param name was unmeasured, which was honest then.
  assert.equal(codexAppServerSandbox({}).network_applied, true);
  assert.equal(codexAppServerSandbox({}).network, true);
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_NETWORK: 'off' }).network, false);
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' }).network, null);
});

test('the policy tag is one the real server parses — camelCase, never the mode spelling', () => {
  // The one thing the fakes cannot catch. The pinned contract validates top-level
  // field PRESENCE only (deliberately — lib/codex-app-server-contract.mjs records
  // why), so `{type:'workspace-write'}` would sail through every fake in this
  // repo and be refused by codex. And it is an easy slip to make: this union's
  // tags are camelCase while `thread/start`'s `SandboxMode` enum, which the SAME
  // job sends on the SAME transport, is kebab-case.
  //
  // The vocabulary is the server's own words, recited back by 0.147.0 when it
  // refused `{type:'workspace-write'}`:
  //   -32600 "Invalid request: unknown variant `workspace-write`, expected one of
  //           `dangerFullAccess`, `readOnly`, `externalSandbox`, `workspaceWrite`"
  // Measured for zero tokens by aiming each call at the all-zero thread id: the
  // three tags the adapter can emit all got as far as `thread not found`, i.e.
  // the shapes were accepted, while the kebab-case one died at deserialization.
  const PARSED_BY_0_147_0 = new Set(['dangerFullAccess', 'readOnly', 'externalSandbox', 'workspaceWrite']);
  const envs = [
    {},
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'workspace-write' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'danger-full-access' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'yolo' },
    { AGENT_COMPANION_CODEX_NETWORK: 'off' },
  ];
  for (const env of envs) {
    const { policy, mode } = codexAppServerSandbox(env);
    assert.ok(PARSED_BY_0_147_0.has(policy.type), `${JSON.stringify(env)} → unparseable tag ${policy.type}`);
    // And the two halves of one decision never disagree: the kebab-case mode goes
    // on `thread/start`, the camelCase tag on `turn/start`, both from one resolver.
    assert.equal(policy.type, { 'workspace-write': 'workspaceWrite', 'read-only': 'readOnly', 'danger-full-access': 'dangerFullAccess' }[mode]);
  }
});

test('promptId keeps the codex prefix and encodes reply generation', () => {
  assert.equal(codexAppServerPromptId('j1'), 'codex-j1');
  assert.equal(codexAppServerPromptId('j1', 2), 'codex-j1-r2');
});

// --- the pure accumulator ----------------------------------------------------

test('the accumulator streams deltas, folds a command, and completes on turn/completed', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('turn/started', { threadId: TID, turn: { id: 'TURN1' } }));
  acc.push(note('item/started', { threadId: TID, item: threadItem('commandExecution', { id: 'i1', command: 'npm test' }) }));
  // `delta`, not `chunk`: the schema declares one payload field on every delta
  // notification and the builder refuses the other three spellings this used to
  // be written with.
  acc.push(note('item/commandExecution/outputDelta', { threadId: TID, itemId: 'i1', delta: 'ok\n' }));
  acc.push(note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'Hello ' }));
  acc.push(note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', delta: 'world' }));

  // Mid-turn the snapshot is already useful — this is the sub-turn progress the
  // exec transport structurally cannot give (F7).
  assert.equal(acc.terminal, null);
  assert.equal(acc.snapshot().message, 'Hello world');
  assert.equal(acc.snapshot().toolCalls[0].status, 'in_progress');
  assert.equal(acc.snapshot().toolCalls[0].aggregated_output, 'ok\n');

  acc.push(note('item/completed', {
    threadId: TID,
    item: threadItem('commandExecution', { id: 'i1', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok\n1 passing\n' }),
  }));
  acc.push(note('item/completed', { threadId: TID, item: threadItem('agentMessage', { id: 'm1', text: 'Hello world', phase: 'final_answer' }) }));
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

test('a delta spelt any way but the schema\'s cannot be written down', () => {
  // The guard, asserted directly: these four were live reads in the accumulator,
  // each with a green test feeding the same invention back to it. The builder is
  // what makes rewriting one of them a red test rather than a silent no-op.
  for (const invented of ['chunk', 'output', 'text']) {
    assert.throws(
      () => note('item/commandExecution/outputDelta', { threadId: TID, itemId: 'i1', [invented]: 'ok' }),
      new RegExp(`carries \\\`${invented}\\\``),
      `${invented} is not a field of item/commandExecution/outputDelta`,
    );
  }
  assert.throws(() => note('item/agentMessage/delta', { threadId: TID, itemId: 'm1', text: 'hi' }), /carries `text`/);
});

test('the accumulator prefers the final answer over the commentary preamble', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/completed', { threadId: TID, item: threadItem('agentMessage', { id: 'm1', text: 'Let me look at that.', phase: 'commentary' }) }));
  acc.push(note('item/completed', { threadId: TID, item: threadItem('agentMessage', { id: 'm2', text: 'THE ANSWER', phase: 'final_answer' }) }));
  acc.push(note('item/completed', { threadId: TID, item: threadItem('agentMessage', { id: 'm3', text: 'Anything else?', phase: 'commentary' }) }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.equal(acc.snapshot().message, 'THE ANSWER');
});

test('a SECOND turn on the same thread replaces the tracked turn id', () => {
  // The live source of the id `turn/interrupt` and `turn/steer` require. Keeping
  // the first turn's id after a second one starts is the stale-`expectedTurnId`
  // failure — `no active turn to steer` on a thread that has one.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('turn/started', { threadId: TID, turn: { id: 'TURN1' } }));
  assert.equal(acc.turnId, 'TURN1');
  acc.push(note('turn/completed', { threadId: TID, turn: { id: 'TURN1', status: 'completed', items: [] } }));
  acc.push(note('turn/started', { threadId: TID, turn: { id: 'TURN2' } }));
  assert.equal(acc.turnId, 'TURN2');
  // Another thread's turn is not this thread's turn, however loud it is.
  acc.push(note('turn/started', { threadId: 'T-OTHER', turn: { id: 'TURN_ELSEWHERE' } }));
  assert.equal(acc.turnId, 'TURN2');
});

test('the watcher hands the live turn id to its observer, beside the snapshot', async () => {
  // Beside, not inside: the snapshot is digest content, and the turn id is
  // transport bookkeeping the JOB needs. The bridge persists it from here, which
  // is what gives a cancel or a reply an id to send.
  const { conn, sock } = await connectFake();
  const seen = [];
  const watcher = await openCodexTurnWatcher({
    conn, threadId: TID, timeoutMs: 5_000,
    onEvent: (snapshot, meta) => seen.push([meta?.turnId, 'turnId' in snapshot]),
  });
  sock.notify('turn/started', { turn: { id: 'TURN1' } });
  sock.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'working' });
  sock.notify('turn/completed', { turn: { id: 'TURN1', status: 'completed', items: [] } });
  await watcher.done;
  conn.close();
  assert.deepEqual(seen, [['TURN1', false], ['TURN1', false], ['TURN1', false]]);
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

test('a failed turn reports the message from Turn.error, which is an object', () => {
  // `Turn.error` is a `TurnError` — "only populated when status is failed" — so
  // the message is one level down. The two alternatives this used to read
  // (`turn.error` itself, `turn.failure`) would have put `[object Object]` and
  // `undefined` respectively in front of an operator.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('turn/completed', { threadId: TID, turn: { id: 'TURN1', status: 'failed', error: { message: 'context window exceeded' } } }));
  assert.equal(acc.terminal.status, 'failed');
  assert.equal(acc.terminal.reason, 'failed');
  assert.equal(acc.terminal.error, 'context window exceeded');
  assert.throws(() => note('turn/completed', { threadId: TID, turn: { status: 'failed', failure: 'nope' } }), /carries `failure`/);
});

test('a failed command does not render like a successful one', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/started', { threadId: TID, item: threadItem('commandExecution', { id: 'i1', command: 'make build' }) }));
  acc.push(note('item/completed', {
    threadId: TID,
    item: threadItem('commandExecution', { id: 'i1', command: 'make build', status: 'failed', exitCode: 2, aggregatedOutput: 'ld: symbol not found' }),
  }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  const call = acc.snapshot().toolCalls[0];
  assert.equal(call.status, 'failed');
  assert.equal(call.exit_code, 2);
  assert.match(call.aggregated_output, /symbol not found/);
  // The outcome lives on the ENTRY, never inside `input` — `input` stays the
  // invocation, which is what formatTerminalContent reads for "Files touched".
  assert.deepEqual(call.input, { command: 'make build' });
  // And the snake_case twins are the exec stream's, not this transport's.
  assert.throws(() => threadItem('commandExecution', { id: 'i1', command: 'x', exit_code: 2 }), /carries `exit_code`/);
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

test('reasoning deltas keep the array boundary their index fields announce', () => {
  // `contentIndex` and `summaryIndex` are REQUIRED on the two reasoning delta
  // methods precisely because `content` and `summary` are arrays, and the
  // completed item joins their entries with a newline. An interrupted turn is
  // the case where no completed item ever arrives to replace the deltas, so
  // what streamed IS what the operator reads — it must not read as
  // `Checking the config.Then the tests.Read config`.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/reasoning/textDelta', { threadId: TID, itemId: 'r1', contentIndex: 0, delta: 'Checking ' }));
  acc.push(note('item/reasoning/textDelta', { threadId: TID, itemId: 'r1', contentIndex: 0, delta: 'the config.' }));
  acc.push(note('item/reasoning/textDelta', { threadId: TID, itemId: 'r1', contentIndex: 1, delta: 'Then the tests.' }));
  acc.push(note('item/reasoning/summaryTextDelta', { threadId: TID, itemId: 'r1', summaryIndex: 0, delta: 'Read config' }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'interrupted' } }));
  assert.equal(acc.snapshot().thoughts, 'Checking the config.\nThen the tests.\nRead config');
  // Same index, same entry: a chunk boundary inside one array entry is not a
  // line break, or every token would land on its own line.
  assert.equal(acc.snapshot().thoughts.split('\n')[0], 'Checking the config.');
});

test('a completed reasoning item replaces the deltas that streamed it, from content and summary', () => {
  // A reasoning item is `{content: string[], summary: string[]}` — there is no
  // `text`, which is what this branch used to read, so it never fired at all and
  // the replay harvested no reasoning. Both arrays are joined: they are the raw
  // chain and the model's own précis of it, streamed through two different delta
  // methods into this one bucket.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/reasoning/textDelta', { threadId: TID, itemId: 'r1', delta: 'half' }));
  acc.push(note('item/completed', {
    threadId: TID,
    item: threadItem('reasoning', { id: 'r1', content: ['half a thought, whole'], summary: ['decided to look'] }),
  }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.equal(acc.snapshot().thoughts, 'half a thought, whole\ndecided to look');
  assert.throws(() => threadItem('reasoning', { id: 'r1', text: 'half a thought, whole' }), /carries `text`/);
});

test('a fileChange item yields one entry per file, with the patch kind as a word', () => {
  // `{changes: FileUpdateChange[]}`, each `{diff, kind, path}` — NOT the
  // `{files:[…]}`/`{path,kind}` shape the exec collector guesses at, which is
  // what this branch used to be handed. Every app-server job that edited a file
  // produced zero toolCalls and an empty "Files touched" as a result.
  //
  // `kind` is a tagged OBJECT (`{type:'update', move_path?}`), so it is unwrapped
  // to its tag: `input.kind` holds a string on the exec side and server.mjs
  // renders these entries beside exec ones.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/completed', {
    threadId: TID,
    item: threadItem('fileChange', {
      id: 'f1',
      status: 'completed',
      changes: [
        { path: 'src/a.mjs', kind: { type: 'update' }, diff: '@@ -1 +1 @@' },
        { path: 'src/new.mjs', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@' },
      ],
    }),
  }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.deepEqual(acc.snapshot().toolCalls, [
    { name: 'file_change', input: { path: 'src/a.mjs', kind: 'update' } },
    { name: 'file_change', input: { path: 'src/new.mjs', kind: 'add' } },
  ]);
  assert.throws(() => threadItem('fileChange', { id: 'f1', files: [{ path: 'src/a.mjs' }] }), /carries `files`/);
});

test('an mcpToolCall records the arguments it was called with', () => {
  // `arguments`, not `input`/`args` — neither of which is a property of the item,
  // so every MCP call recorded `{}` and no test in the repo touched the branch.
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/completed', {
    threadId: TID,
    item: threadItem('mcpToolCall', { id: 'x1', server: 'filesystem', tool: 'read_file', status: 'completed', arguments: { path: '/w/a.mjs' } }),
  }));
  acc.push(note('item/completed', { threadId: TID, item: threadItem('webSearch', { id: 'w1', query: 'codex app-server' }) }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.deepEqual(acc.snapshot().toolCalls, [
    { name: 'read_file', input: { path: '/w/a.mjs' } },
    { name: 'webSearch', input: { query: 'codex app-server' } },
  ]);
  assert.throws(() => threadItem('mcpToolCall', { id: 'x1', server: 's', tool: 't', input: {} }), /carries `input`/);
});

test('turn/completed replays its items without duplicating what already streamed', () => {
  // The salvage path for a bridge that attached mid-turn: the replay must add
  // what it missed and double nothing it saw.
  const acc = createCodexTurnAccumulator(TID);
  const ls = threadItem('commandExecution', { id: 'i1', command: 'ls', status: 'completed', exitCode: 0 });
  const edit = threadItem('fileChange', { id: 'f1', status: 'completed', changes: [{ path: 'src/a.mjs', kind: { type: 'update' }, diff: '@@' }] });
  acc.push(note('item/completed', { threadId: TID, item: ls }));
  acc.push(note('item/completed', { threadId: TID, item: edit }));
  acc.push(note('turn/completed', {
    threadId: TID,
    turn: {
      status: 'completed',
      items: [ls, edit, threadItem('agentMessage', { id: 'm9', text: 'ONLY IN THE REPLAY', phase: 'final_answer' })],
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
  // The error notification is `{error: TurnError, threadId, turnId, willRetry}`,
  // all four required — the message is one level down, and the flat
  // `params.message` this used to read first is the EXEC stream's shape.
  const failed = createCodexTurnAccumulator(TID);
  failed.push(note('error', { threadId: TID, turnId: 'TURN1', willRetry: false, error: { message: 'model overloaded' } }));
  assert.equal(failed.terminal.status, 'failed');
  assert.equal(failed.terminal.error, 'model overloaded');
  assert.throws(() => note('error', { threadId: TID, message: 'model overloaded' }), /carries `message`/);

  // `broker/appServerDied` is the broker's own frame, not an app-server method —
  // hence driftNote, which is the only way to write a frame this pin has never
  // seen and says so at the call site.
  const died = createCodexTurnAccumulator(TID);
  died.push(driftNote('broker/appServerDied', { code: 7, signal: null }));
  assert.equal(died.terminal.status, 'unreachable');
  assert.match(died.terminal.error, /in-flight turn was lost/);
});

test('there is no `error` ThreadItem variant to record', () => {
  // This branch existed and had a test; the item type it handled does not exist.
  // The 18 variants carry no `error`, so a turn's errors arrive as the `error`
  // NOTIFICATION (fatal) or as a `failed` status on the item that raised one.
  assert.throws(
    () => threadItem('error', { id: 'e1', message: 'tool blew up' }),
    /is not one of codex-cli .* 18 ThreadItem variants/,
  );
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('item/completed', {
    threadId: TID,
    item: threadItem('commandExecution', { id: 'i1', command: 'make', status: 'failed', exitCode: 1 }),
  }));
  assert.equal(acc.terminal, null, 'a failed item does not end the turn — only turn/completed and `error` do');
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.equal(acc.terminal.status, 'completed');
  assert.equal(acc.snapshot().toolCalls[0].status, 'failed');
});

test('a plan-only turn carries its plan so it does not read as empty', () => {
  const acc = createCodexTurnAccumulator(TID);
  acc.push(note('turn/plan/updated', { threadId: TID, plan: [{ step: 'read the file', status: 'pending' }] }));
  acc.push(note('turn/completed', { threadId: TID, turn: { status: 'completed' } }));
  assert.deepEqual(acc.snapshot().plan, [{ step: 'read the file', status: 'pending' }]);
  // `steps` was the other spelling this read; `turn/plan/updated` declares
  // `plan`, required.
  assert.throws(() => note('turn/plan/updated', { threadId: TID, steps: [] }), /carries `steps`/);
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

test('every turn/start carries the sandboxPolicy — the only call that can', async () => {
  // The parity fix: the mode on `thread/start` says nothing about the network,
  // so a turn started without a `sandboxPolicy` ran with `networkAccess` at the
  // union's `false` default while the SAME job on the exec adapter ran with it
  // on. Measured on this machine before the fix: every rollout from
  // `originator: agent-companion-broker` recorded
  // `"network_access": false` while `codex_exec`'s recorded `true`.
  const env = { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'workspace-write' };
  const { conn, sock } = await connectFake({}, { env });
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env });
  await startCodexTurn({ conn, threadId, prompt: 'go', env });
  conn.close();

  assert.deepEqual(sock.wire(), ['thread/start', 'turn/start']);
  assert.deepEqual(sock.paramsFor('turn/start')[0].sandboxPolicy, {
    type: 'workspaceWrite', networkAccess: true,
  });
  // The mode still rides thread/start; the two halves come from one resolver.
  assert.equal(sock.paramsFor('thread/start')[0].sandbox, 'workspace-write');
});

test('AGENT_COMPANION_CODEX_NETWORK=off reaches the wire as an explicit false', async () => {
  // On exec, omission defers to config.toml and fails OPEN, so the off switch
  // has to be explicit. On this transport omission falls CLOSED — a different
  // hazard with the same answer: say it.
  const env = { AGENT_COMPANION_CODEX_NETWORK: 'off' };
  const { conn, sock } = await connectFake({}, { env });
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env });
  await startCodexTurn({ conn, threadId, prompt: 'go', env });
  conn.close();
  const policy = sock.paramsFor('turn/start')[0].sandboxPolicy;
  assert.equal(policy.networkAccess, false);
  assert.equal('networkAccess' in policy, true, 'off is a field, never an omission');
});

test('a turn attached to a running one sends no policy, because it sends no turn/start', async () => {
  // `turn/start` on a busy thread SUCCEEDS and double-dispatches, so the adapter
  // attaches instead — and the turn it attaches to already carries the policy
  // the `turn/start` beneath it set. `turn/steer` has no sandbox parameter at
  // all, which is why the policy has to be right on the way in.
  const { conn, sock } = await connectFake({
    statuses: { BUSY: 'active' },
    turns: { BUSY: [{ id: 'TURN_RUNNING', status: 'inProgress' }] },
  });
  await startCodexTurn({ conn, threadId: 'BUSY', prompt: 'do the thing', env: {} });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume']);
  assert.deepEqual(sock.paramsFor('turn/start'), []);
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
  await interruptCodexTurn({ conn, threadId: 'FOREIGN', turnId: 'TURN9' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/interrupt']);
  assert.equal(sock.paramsFor('thread/resume')[0].threadId, 'FOREIGN');
  assert.equal(sock.paramsFor('thread/resume')[0].approvalPolicy, 'never');
});

test('steering a foreign thread resumes once, and only once', async () => {
  const { conn, sock } = await connectFake();
  await steerCodexTurn({ conn, threadId: 'FOREIGN', prompt: 'change of plan', expectedTurnId: 'TURN9' });
  await steerCodexTurn({ conn, threadId: 'FOREIGN', prompt: 'again', expectedTurnId: 'TURN9' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/steer', 'turn/steer']);
});

test('a thread this connection started needs no resume before acting on it', async () => {
  const { conn, sock } = await connectFake();
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env: {} });
  await interruptCodexTurn({ conn, threadId, turnId: 'TURN9' });
  await steerCodexTurn({ conn, threadId, prompt: 'more', expectedTurnId: 'TURN9' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/start', 'turn/interrupt', 'turn/steer']);
});

test('the resume guard cannot be bypassed by calling the connection directly', async () => {
  const { conn, sock } = await connectFake();
  await conn.call('turn/interrupt', { threadId: 'FOREIGN', turnId: 'TURN9' });
  conn.close();
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/interrupt']);
});

// --- the required turn ids ---------------------------------------------------

test('turn/interrupt and turn/steer put their REQUIRED ids on the wire', async () => {
  // The defect this suite missed for three rounds: both fields are `required`
  // in the pinned contract, the adapter dropped them when null, and both fakes
  // answered anyway. Measured against the real 0.147.0 server, the omission is
  // an unconditional `-32600 Invalid request: missing field \`x\``, so
  // agent_cancel and agent_reply failed on EVERY app-server job. The fakes
  // enforce the contract now, so this test cannot pass without the ids.
  const { conn, sock } = await connectFake();
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env: {} });
  const interrupted = await interruptCodexTurn({ conn, threadId, turnId: 'TURN7' });
  const steered = await steerCodexTurn({ conn, threadId, prompt: 'use ripgrep', expectedTurnId: 'TURN7' });
  conn.close();
  assert.deepEqual(sock.paramsFor('turn/interrupt')[0], { threadId, turnId: 'TURN7' });
  assert.deepEqual(sock.paramsFor('turn/steer')[0], {
    threadId, expectedTurnId: 'TURN7', input: [{ type: 'text', text: 'use ripgrep' }],
  });
  assert.equal(interrupted.turnId, 'TURN7');
  assert.equal(steered.turnId, 'TURN7');
  assert.equal(steered.accepted, true);
});

test('the fake refuses a method it does not implement, instead of echoing success', async () => {
  // The other half of the same blind spot. The fake used to answer ANY method
  // `{echo: method}` with a success result, so a misspelt call and a real method
  // it had never modelled both went green — while the real server answers the
  // first `-32600 unknown variant` (measured on 0.147.0 with `turn/interupt`)
  // and the second for real. Neither is a passing test.
  const { conn } = await connectFake();
  // A typo — one letter, the shape of a bad refactor.
  await assert.rejects(
    () => conn.call('turn/interupt', { threadId: 'T1', turnId: 'TURN1' }),
    /unknown variant `turn\/interupt`/,
  );
  // And a REAL method (the contract carries it) that this fake does not model:
  // an adapter that grew a `thread/fork` call must not pass against a fixture
  // that has never seen one.
  await assert.rejects(
    () => conn.call('thread/fork', { threadId: 'T1' }),
    /unknown variant `thread\/fork`/,
  );
  conn.close();
});

test('a turn id nobody can supply is a LOUD failure, never an omitted field', async () => {
  // The alternative — send it without the field — is a -32600 from a server the
  // operator never sees, on a call they were told succeeded. Neither is a
  // placeholder id acceptable: the server would answer `no active turn`, which
  // reads as "the turn is over" rather than "the bridge lost track of it".
  const { conn, sock } = await connectFake({ turns: { LOST: [{ id: 'TURN1', status: 'completed' }] } });
  await assert.rejects(
    () => interruptCodexTurn({ conn, threadId: 'LOST' }),
    /turn\/interrupt needs the running turn's id on thread LOST .*last turn TURN1 as completed/s,
  );
  await assert.rejects(
    () => steerCodexTurn({ conn, threadId: 'NOTURNS', prompt: 'x' }),
    /turn\/steer needs the running turn's id on thread NOTURNS .*no turns at all/s,
  );
  conn.close();
  // Nothing reached the wire beyond the two lookups — no interrupt, no steer.
  assert.deepEqual(sock.wire(), ['thread/read', 'thread/read']);
});

test('a bridge that never saw turn/started reads the running turn off thread/read', async () => {
  // The restart case, measured: the turn began before this bridge existed, so
  // `turn/started` is gone for good. `thread/read{includeTurns:true}` reports
  // the thread's last turn as `{id, status}` and the running one reads
  // `inProgress` with the id `turn/start` returned.
  const { conn, sock } = await connectFake({
    turns: { RESUMED: [{ id: 'TURN_OLD', status: 'completed' }, { id: 'TURN_LIVE', status: 'inProgress' }] },
  });
  const interrupted = await interruptCodexTurn({ conn, threadId: 'RESUMED' });
  conn.close();
  assert.equal(interrupted.turnId, 'TURN_LIVE');
  assert.deepEqual(sock.wire(), ['thread/read', 'thread/resume', 'turn/interrupt']);
  assert.equal(sock.paramsFor('thread/read')[0].includeTurns, true);
  assert.equal(sock.paramsFor('turn/interrupt')[0].turnId, 'TURN_LIVE');
});

test('a live id is used as given — the transport is only asked when there is none', async () => {
  const { conn, sock } = await connectFake({
    turns: { LIVE: [{ id: 'TURN_FROM_READ', status: 'inProgress' }] },
  });
  const interrupted = await interruptCodexTurn({ conn, threadId: 'LIVE', turnId: 'TURN_FROM_STARTED' });
  conn.close();
  assert.equal(interrupted.turnId, 'TURN_FROM_STARTED');
  assert.deepEqual(sock.wire(), ['thread/resume', 'turn/interrupt'], 'no thread/read when the id is known');
});

test('attaching to a turn already in flight reports THAT turn\'s id, not the previous one', async () => {
  // `turn/start` on a busy thread SUCCEEDS and returns a second turn id, so the
  // adapter attaches instead — and the caller records the id it reports. Before
  // this, `attached` reported null and the job kept whatever id it had from the
  // turn BEFORE, which is the stale-`expectedTurnId` failure mode.
  const { conn } = await connectFake({
    statuses: { BUSY: 'active' },
    turns: { BUSY: [{ id: 'TURN_RUNNING', status: 'inProgress' }] },
  });
  const started = await startCodexTurn({ conn, threadId: 'BUSY', prompt: 'do the thing' });
  conn.close();
  assert.deepEqual(started, { threadId: 'BUSY', turnId: 'TURN_RUNNING', attached: true, status: 'active' });
});

// --- the steer landed, or it did not ------------------------------------------

test('a steer is confirmed by the injected message coming back, not by the RPC returning', async () => {
  // Measured: the injection arrives as an `item/completed` whose item type is
  // `userMessage`. The turn's OPENING prompt produces one too, so counting
  // would confirm a steer that never landed — the injected one is identified by
  // the text this bridge chose.
  const { conn, sock } = await connectFake();
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env: {} });
  const steer = await steerCodexTurn({ conn, threadId, prompt: 'switch to ripgrep', expectedTurnId: 'TURN1' });
  conn.close();
  assert.equal(steer.accepted, true);
  assert.equal(steer.confirmed, true);
  assert.match(steer.confirmation, /item\/completed userMessage/);
  assert.equal(sock.paramsFor('turn/steer')[0].input[0].text, 'switch to ripgrep');
});

test('the steer confirmation window is a bounded, env-overridable number', () => {
  // A probe steering a turn that is sitting inside a 20 s shell command wants to
  // wait past it; `agent_reply` blocks for this, so it is also capped.
  assert.equal(resolveSteerConfirmMs({}), 5_000);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '25000' }), 25_000);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '0' }), 0);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '999999' }), 120_000);
  // Garbage is the default, not a zero window that reports every steer as
  // unconfirmed.
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: 'soon' }), 5_000);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '-1' }), 5_000);
  assert.equal(codexAppServerRuntimeInfo({}).steer_confirm_ms, 5_000);
});

test('an unconfirmed steer says so — it is not reported as delivered, nor as failed', async () => {
  // Codex applies a steer at the NEXT MODEL BOUNDARY: measured 0.14 s against
  // an in-flight apply_patch and 130 s against a model mid-reasoning. So a short
  // window that sees nothing is the normal case, and the honest answer is
  // "accepted, not yet confirmed".
  const { conn } = await connectFake({
    handlers: { 'turn/steer': (p) => ({ turnId: p.expectedTurnId }) },  // no injection ever announced
  });
  const steer = await steerCodexTurn({
    conn, threadId: 'T9', prompt: 'switch to ripgrep', expectedTurnId: 'TURN1', confirmMs: 20,
  });
  conn.close();
  assert.equal(steer.accepted, true);
  assert.equal(steer.confirmed, false);
  assert.match(steer.confirmation, /next model boundary/);
});

test('the turn\'s own opening message never counts as a steer confirmation', async () => {
  const { conn, sock } = await connectFake({
    handlers: {
      'turn/steer': (p) => {
        // The opening prompt's userMessage, replayed while the steer is in
        // flight. Same item type, different text — and it must not confirm.
        setTimeout(() => sock.deliver(note('item/completed', {
          threadId: 'T9',
          item: threadItem('userMessage', { id: 'item_0', content: [{ type: 'text', text: 'the original task' }] }),
        })), 0);
        // `TurnSteerResponse` is `{turnId}`, the shape the fakes were corrected
        // to — a handler that overrides one must not reintroduce the wrong one.
        return { turnId: p.expectedTurnId };
      },
    },
  });
  const steer = await steerCodexTurn({
    conn, threadId: 'T9', prompt: 'switch to ripgrep', expectedTurnId: 'TURN1', confirmMs: 40,
  });
  conn.close();
  assert.equal(steer.confirmed, false);
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

test('the guarded methods cannot slip out through notify() either', async () => {
  // A notification carries no id, and the broker forwards "any other {method}
  // with no id" upstream verbatim — so this is the one door that never touches
  // `call()`'s guards. A fire-and-forget `turn/start` would reach the app-server
  // with no status check at all.
  const { conn, sock } = await connectFake();
  assert.throws(() => conn.notify('turn/start', { threadId: TID, input: [] }), /cannot be sent as a notification/);
  assert.throws(() => conn.notify('turn/interrupt', { threadId: 'FOREIGN' }), /cannot be sent as a notification/);
  assert.throws(() => conn.notify('turn/steer', { threadId: 'FOREIGN' }), /cannot be sent as a notification/);
  // Everything else still goes: this is a refusal of two families, not a lock.
  assert.equal(conn.notify('initialized'), true);
  conn.close();
  assert.deepEqual(sock.wire(), ['initialized']);
});

test('a turn/start whose answer never lands still forces the retry through the status check', async () => {
  // The response frame is the only thing the retry has, and it can be lost while
  // the turn is very much RUNNING: this call's timeout, or a frame past the
  // LineReader's 8 MB cap. Clearing `fresh` when turn/start is SENT rather than
  // when it settles is what keeps the retry on the asking path — asking is
  // recoverable, a second turn is two bills and two sets of edits.
  let starts = 0;
  const { conn, sock } = await connectFake({
    handlers: {
      'turn/start': () => {
        starts += 1;
        return starts === 1 ? new Promise(() => {}) : { turn: { id: 'TURN2' } };
      },
    },
  });
  const { threadId } = await startCodexThread({ conn, cwd: '/w', env: {} });
  await assert.rejects(() => startCodexTurn({ conn, threadId, prompt: 'go', timeoutMs: 20 }), /timed out/);

  const retry = await startCodexTurn({ conn, threadId, prompt: 'go' });
  conn.close();
  assert.equal(retry.turnId, 'TURN2');
  assert.deepEqual(sock.wire(), ['thread/start', 'turn/start', 'thread/resume', 'turn/start'],
    'the retry must ASK before it starts a second turn');
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

test('the level check carries a pinned model into the resume it performs', async () => {
  // The level check's status read IS a thread/resume, exactly like the one
  // startCodexTurn forwards the pin to. Two status reads that disagree about
  // whether the pin travels is how a restart-resume silently hands the rest of a
  // pinned job to whatever ~/.codex/config.toml says.
  const { conn, sock } = await connectFake({ statuses: { [TID]: 'active' } });
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, initialLevelCheck: true, model: 'gpt-5.6-codex', timeoutMs: 20 });
  await watcher.done;
  conn.close();
  assert.equal(sock.paramsFor('thread/resume')[0].model, 'gpt-5.6-codex');
  assert.equal(sock.paramsFor('thread/resume')[0].approvalPolicy, 'never');
});

test('the level check keeps watching an active thread', async () => {
  const { conn, sock } = await connectFake({ statuses: { [TID]: 'active' } });
  const watcher = await openCodexTurnWatcher({ conn, threadId: TID, initialLevelCheck: true, timeoutMs: 5_000 });
  sock.deliver(note('turn/completed', {
    threadId: TID,
    turn: { status: 'completed', items: [threadItem('agentMessage', { id: 'm1', text: 'live tail', phase: 'final_answer' })] },
  }));
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
  // Recording the adoption refreshes lastUsedAt, and THAT is the protection:
  // the claimer re-reads it immediately before it signals (see the reaper test
  // "a broker adopted mid-dispose is never signalled").
  assert.ok(Date.now() - readReg().lastUsedAt < 60_000);
});

test('concurrent callers IN ONE PROCESS share ONE spawn', async () => {
  // Without the mutex two parallel dispatches each spawn a broker and race on
  // the socket file. This covers the in-process half only — the mutex cannot
  // span processes, and the cross-process half is the test after next.
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

test('a broker that dies during boot with nothing replacing it says so', async () => {
  // Our child died AND the socket stayed unreachable for the whole grace: a
  // missing codex binary, not a lost start race. The exit is reported as the
  // cause rather than a bare boot timeout.
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

test('losing the CROSS-PROCESS spawn race adopts the winner instead of failing the dispatch', async () => {
  // The spawn mutex is per PROCESS while the bridge is spawned per subagent, so
  // two bridges cold-starting together is the ordinary case, not the exotic one.
  // B1's start lock resolves that race by making the loser exit
  // BROKER_START_CONTENDED within milliseconds and delegating recovery to the
  // caller ("refuse and let the caller re-probe"). Our child's exit is therefore
  // not a verdict on the socket — the winner is still inside its critical
  // section and has not bound yet.
  let winnerUp = false;
  let spawns = 0;
  _setForTest({
    connect: async () => {
      if (!winnerUp) { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; }
      return fakeBrokerSocket({ brokerPid: 5150 });
    },
    spawnBroker: () => {
      spawns += 1;
      const child = new EventEmitter();
      setTimeout(() => child.emit('exit', 1, null), 10);   // we lost the lock
      setTimeout(() => { winnerUp = true; }, 120);         // the winner finished its handshake
      return child;
    },
  });

  const broker = await ensureCodexBroker({ env: {} });
  assert.equal(broker.pid, 5150, 'the winner is adopted, not reported as a dispatch failure');
  assert.equal(spawns, 1, 'and no rival is spawned onto the winner\'s socket');
  assert.equal(codexBrokerSnapshot().pid, 5150);
});

test('a connect that times out is never read as "nobody is home"', async () => {
  // A unix-socket connect that neither succeeds nor is refused is a listener
  // whose backlog is wedged — the loudest possible "a broker owns this path".
  // The broker's own probeSocket has no timeout, so a rival spawned on that
  // evidence would block inside start() rather than fail.
  let spawns = 0;
  const err = new Error('timed out connecting to the codex broker');
  err.code = 'ETIMEDOUT';
  _setForTest({ connect: async () => { throw err; }, spawnBroker: () => { spawns += 1; return new EventEmitter(); } });
  await assert.rejects(() => ensureCodexBroker({ env: {} }), /could not reach the codex broker/);
  assert.equal(spawns, 0);
});

test('a broker under a live disposal claim is adopted AT ONCE, not waited out', async () => {
  // This used to sleep 250 ms and re-probe, because the disposer never looked at
  // the registry again after publishing its claim — so an adopter's `lastUsedAt`
  // bump had nothing left to save it and the only safe move was to wait the
  // dispose out. The disposer confirms immediately before it signals now, so the
  // adoption IS the protection: waiting would only hand the claimer more time in
  // which to act, and cost a redundant spawn whenever it did.
  const other = foreignLivePid();
  const claimedAt = Date.now();
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: BROKER_PID,
    lastUsedAt: claimedAt - 60 * 60_000,
    disposing: { pid: other, at: claimedAt },
  });

  let spawns = 0;
  let connects = 0;
  _setForTest({
    connect: async () => { connects += 1; return fakeBrokerSocket({ brokerPid: BROKER_PID }); },
    spawnBroker: () => { spawns += 1; return new EventEmitter(); },
    delay: async () => { throw new Error('ensureCodexBroker must not sleep on a disposal claim'); },
  });

  const broker = await ensureCodexBroker({ env: {} });
  assert.equal(broker.pid, BROKER_PID, 'the claimed broker is handed over, not replaced');
  assert.equal(broker.reused, true);
  assert.equal(broker.disposalClaimed, true, 'and the claim is reported rather than hidden');
  assert.equal(spawns, 0);
  // Two probes, and neither is a pass of the old loop: one to find the broker,
  // one AFTER the bump to check the claimer had not already acted. No sleep
  // between them — `delay` throws.
  assert.equal(connects, 2);
  // The bump is the whole protection — it is what the claimer re-reads.
  assert.ok(Date.now() - readReg().lastUsedAt < 60_000);
});

test('an unclaimed broker is adopted on ONE probe — the second look is the claimed path only', async () => {
  // The re-probe is the price of losing a race that can only happen when a
  // disposer is already mid-dispose. Charging it to every dispatch would be a
  // round trip per turn for a race nobody is running.
  seedRegistry({ socketPath: brokerSocketPath(), pid: BROKER_PID, lastUsedAt: Date.now() });
  let connects = 0;
  _setForTest({ connect: async () => { connects += 1; return fakeBrokerSocket({ brokerPid: BROKER_PID }); } });

  const broker = await ensureCodexBroker({ env: {} });
  assert.equal(broker.disposalClaimed, false);
  assert.equal(connects, 1);
});

test('a claimer that signalled before our bump landed costs a redundant spawn, not a corpse', async () => {
  // The residual window the bump cannot cover: the claimer's `confirmDisposal`
  // read the file in the gap between our probe answering and our `record`
  // completing, so it saw the OLD `lastUsedAt` and signalled anyway. Handing
  // that back would fail the caller's very first call with ECONNREFUSED. The
  // look AFTER the bump catches it and turns it into the one redundant spawn
  // this protocol promises as its worst case everywhere else.
  const other = foreignLivePid();
  const claimedAt = Date.now();
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: BROKER_PID,
    lastUsedAt: claimedAt - 60 * 60_000,
    disposing: { pid: other, at: claimedAt },
  });

  let spawns = 0;
  let connects = 0;
  const logs = [];
  _setForTest({
    logEvent: (level, event) => logs.push(event),
    spawnBroker: () => { spawns += 1; return new EventEmitter(); },
    connect: async () => {
      connects += 1;
      // Probe 1 finds it alive; the SIGTERM lands while we record our adoption,
      // so probe 2 finds nothing listening. The spawned replacement answers.
      if (connects === 2) { const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; }
      return fakeBrokerSocket({ brokerPid: connects === 1 ? BROKER_PID : 6060 });
    },
  });

  const broker = await ensureCodexBroker({ env: {} });
  assert.equal(spawns, 1, 'the adopted broker was already dead, so a replacement is spawned');
  assert.equal(broker.pid, 6060, 'and the caller gets the replacement, not the corpse');
  assert.equal(broker.reused, false);
  assert.equal(broker.disposalClaimed, false, 'the replacement inherits nothing from the disposed entry');
  assert.ok(logs.includes('codex_appserver_adopted_broker_gone'));
  assert.equal(readReg().pid, 6060, 'and the registry describes the live broker');
  assert.equal(readReg().disposing, undefined, 'not the dead one, nor its claim');
});

test('a re-probe that could not TELL keeps the adoption rather than racing a live broker', async () => {
  // Same discipline as the first probe: EACCES/EMFILE is a failure to ask, not
  // evidence of death, and the broker we reached one moment ago is far better
  // evidence. Spawning here would race a broker that is very much alive.
  const other = foreignLivePid();
  const claimedAt = Date.now();
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: BROKER_PID,
    lastUsedAt: claimedAt - 60 * 60_000,
    disposing: { pid: other, at: claimedAt },
  });

  let spawns = 0;
  let connects = 0;
  _setForTest({
    spawnBroker: () => { spawns += 1; return new EventEmitter(); },
    connect: async () => {
      connects += 1;
      if (connects === 2) { const err = new Error('too many open files'); err.code = 'EMFILE'; throw err; }
      return fakeBrokerSocket({ brokerPid: BROKER_PID });
    },
  });

  const broker = await ensureCodexBroker({ env: {} });
  assert.equal(spawns, 0);
  assert.equal(broker.pid, BROKER_PID);
  assert.equal(broker.reused, true);
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
// The kill is the one destructive action in the module, so every reaper test
// that reaches it routes it through the seam and asserts on the signal actually
// sent. Exactly one test below lets the real `process.kill` through, against a
// process it spawned itself to receive it.
function captureKills() {
  const kills = [];
  _setForTest({ kill: (pid, signal) => kills.push({ pid, signal }) });
  return kills;
}
// A pid that is unquestionably alive, so the dispose path reaches its kill at
// all. Every test using it stubs the kill first (captureKills), so nothing is
// ever signalled — and picking THIS process rather than a bystander means a
// stub that ever stopped working would fail loudly here instead of quietly
// somewhere else on the machine.
const LIVE_BROKER_PID = process.pid;

test('the idle reaper stops a broker with nothing loaded and nobody holding it', async () => {
  _setForTest({ connect: async () => fakeBrokerSocket({ brokerPid: LIVE_BROKER_PID, handlers: { 'thread/loaded/list': () => ({ data: [] }) } }) });
  const kills = captureKills();
  seedRegistry({ socketPath: brokerSocketPath(), pid: LIVE_BROKER_PID, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true);
  assert.equal(readReg(), undefined);
  // "Reaped" has to mean a signal was sent, or the reaper could stop reaping and
  // keep reporting true.
  assert.deepEqual(kills, [{ pid: LIVE_BROKER_PID, signal: 'SIGTERM' }]);
});

test('the reaper really does SIGTERM the broker process', async (t) => {
  // The only test that lets the real kill through — and it supplies its own
  // victim, so a recycled pid can never make this signal a bystander.
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { victim.kill('SIGKILL'); } catch { /* already gone */ } });
  const exited = new Promise((resolve) => victim.on('exit', (code, signal) => resolve({ code, signal })));

  // The live broker claims the victim's pid as its own, which is the ONLY
  // evidence that authorises the signal.
  _setForTest({ connect: async () => fakeBrokerSocket({ brokerPid: victim.pid, handlers: { 'thread/loaded/list': () => ({ data: [] }) } }) });
  seedRegistry({ socketPath: brokerSocketPath(), pid: victim.pid, lastUsedAt: Date.now() - 60 * 60_000 });

  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGTERM' });
});

test('the reaper refuses to signal a pid the live broker does not claim', async () => {
  // The registry entry is a RECORD and a record outlives its process: pid 4242
  // may be an editor by now. `thread/loaded/list` proves the SOCKET is a broker,
  // never that the recorded pid still is — only the broker's own brokerPid does.
  const stale = await deadPid();
  _setForTest({ connect: async () => fakeBrokerSocket({ brokerPid: 777777, handlers: { 'thread/loaded/list': () => ({ data: [] }) } }) });
  const kills = captureKills();
  seedRegistry({ socketPath: brokerSocketPath(), pid: stale, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), false, 'a mismatch is a refusal, not a reap');
  assert.deepEqual(kills, []);
});

test('the reaper signals nothing when the socket says nobody is listening', async () => {
  // No broker is there to stop, and the recorded pid is exactly the pid-reuse
  // hazard: nothing on this path says it is still a broker.
  const gone = await deadPid();
  const err = new Error('connect ECONNREFUSED');
  err.code = 'ECONNREFUSED';
  _setForTest({ connect: async () => { throw err; } });
  const kills = captureKills();
  seedRegistry({ socketPath: brokerSocketPath(), pid: gone, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true, 'the entry is still cleaned up');
  assert.deepEqual(kills, [], 'but nothing is signalled');
  assert.equal(readReg(), undefined);
});

test('a broker adopted mid-dispose is never signalled: the disposer re-confirms first', async () => {
  // The failure this transport exists to prevent, driven end to end in one
  // process. The reaper has published AND confirmed its claim and is inside its
  // interrogation — a connect, an initialize handshake, a `thread/loaded/list`,
  // seconds of RPC in the real thing — when another bridge adopts the same
  // broker and is about to start a turn on it.
  //
  // Neither of the reaper's wire questions can see that bridge: it has loaded no
  // thread yet, and it holds no lease because a lease needs a job and adoption
  // comes first. All it has done is bump `lastUsedAt` in the registry, and
  // re-reading that immediately before the signal is the only thing standing
  // between the adopter and a SIGTERM through its first turn.
  const kills = captureKills();
  seedRegistry({ socketPath: brokerSocketPath(), pid: LIVE_BROKER_PID, lastUsedAt: Date.now() - 60 * 60_000 });

  const logs = [];
  let adopted = null;
  _setForTest({
    logEvent: (level, event) => logs.push(event),
    connect: async () => fakeBrokerSocket({
      brokerPid: LIVE_BROKER_PID,
      handlers: {
        // The other bridge gets in while the reaper is still asking. Its own
        // probe opens a separate fake socket and never reaches this handler.
        'thread/loaded/list': async () => {
          adopted ??= await ensureCodexBroker({ env: {} });
          return { data: [] };
        },
      },
    }),
  });

  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), false, 'standing down is not a reap');
  assert.deepEqual(kills, [], 'the adopted broker must not be signalled');
  assert.ok(logs.includes('codex_appserver_dispose_stood_down'));
  assert.equal(adopted.pid, LIVE_BROKER_PID, 'the adopter got the live broker, not a corpse');
  assert.ok(readReg(), 'and its entry survives — forgetting it would strand the broker unowned');
  assert.equal(readReg().disposing, undefined, 'the withdrawn claim must not block the next adopter');
});

test('the idle reaper refuses a broker that still has a thread loaded', async () => {
  // The case no lease can cover: the bridge that started the turn DIED, so its
  // lease is long gone — and the turn it started is exactly the work this whole
  // transport exists to protect. `thread/loaded/list` is the authoritative
  // answer, immune to the PID reuse a pid probe would suffer.
  //
  // The recorded pid is the one the live broker claims, deliberately: seeded
  // with any other pid the reaper refuses on the identity mismatch instead, and
  // the loaded thread stops being the thing under test — deleting the guard
  // entirely still passed. Here it is the only refusal available.
  _setForTest({
    connect: async () => fakeBrokerSocket({
      brokerPid: LIVE_BROKER_PID,
      handlers: { 'thread/loaded/list': () => ({ data: ['T-live'] }) },
    }),
  });
  const kills = captureKills();
  seedRegistry({ socketPath: brokerSocketPath(), pid: LIVE_BROKER_PID, lastUsedAt: Date.now() - 60 * 60_000 });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), false);
  assert.deepEqual(kills, [], 'a broker holding a thread must not be signalled');
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
  _setForTest({ connect: async () => fakeBrokerSocket({ brokerPid: LIVE_BROKER_PID }) });
  const kills = captureKills();
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: LIVE_BROKER_PID,
    lastUsedAt: Date.now() - 60 * 60_000,
    leases: { [`${gone}:codex-job-a`]: { pid: gone, jobId: 'codex-job-a', renewedAt: Date.now() } },
  });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true);
  assert.deepEqual(kills, [{ pid: LIVE_BROKER_PID, signal: 'SIGTERM' }]);
});

test('a lease that stopped being renewed is reclaimed', async () => {
  const other = foreignLivePid();
  _setForTest({ connect: async () => fakeBrokerSocket({ brokerPid: LIVE_BROKER_PID }) });
  const kills = captureKills();
  seedRegistry({
    socketPath: brokerSocketPath(),
    pid: LIVE_BROKER_PID,
    lastUsedAt: Date.now() - 60 * 60_000,
    leases: { [`${other}:codex-job-a`]: { pid: other, jobId: 'codex-job-a', renewedAt: Date.now() - (LEASE_STALE_MS + 60_000) } },
  });
  assert.equal(await reapIdleCodexBroker({ idleMs: 30 * 60_000 }), true);
  assert.deepEqual(kills, [{ pid: LIVE_BROKER_PID, signal: 'SIGTERM' }]);
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
  // this connection -> the accumulator. Nothing is injected locally — which is
  // why these frames are BUILT from the pinned contract like every other frame
  // in this suite rather than written out here. They were the last hand-written
  // ones left, so the single test proving the accumulator works through a real
  // broker was also the only one that could still disagree with the schema.
  // `fake/emit` refuses an off-contract frame now too, so it cannot come back.
  await conn.call('fake/emit', {
    frames: [
      note('turn/started', { threadId, turn: { id: 'TURN1' } }),
      note('item/started', { threadId, item: threadItem('commandExecution', { id: 'i1', command: 'rg TODO' }) }),
      note('item/reasoning/textDelta', { threadId, itemId: 'r1', delta: 'scanning' }),
      note('item/completed', { threadId, item: threadItem('commandExecution', {
        id: 'i1', command: 'rg TODO', status: 'failed', exitCode: 1, aggregatedOutput: 'no matches',
      }) }),
      note('item/agentMessage/delta', { threadId, itemId: 'm1', delta: 'No TODOs ' }),
      note('item/agentMessage/delta', { threadId, itemId: 'm1', delta: 'anywhere.' }),
      // Another job's event, on the same broker: it must never land here.
      note('item/agentMessage/delta', { threadId: 'T-OTHER', itemId: 'x', delta: 'SOMEONE ELSE' }),
      note('item/completed', { threadId, item: threadItem('agentMessage', {
        id: 'm1', text: 'No TODOs anywhere.', phase: 'final_answer',
      }) }),
      note('turn/completed', { threadId, turn: { id: 'TURN1', status: 'completed', items: [] } }),
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

  // A LATER bridge — a fresh connection that did not start this thread, i.e. the
  // restart case — must resume before it may interrupt, and it has no `turnId`
  // of its own because it never saw `turn/started`. Both are asserted on the
  // app-server's own trace: it reads the running turn off `thread/read` and
  // sends it, because the field is REQUIRED and the real server refuses the
  // call without it.
  await conn.call('fake/setTurns', { threadId, turns: [
    { id: 'TURN0', status: 'completed', items: [] },
    { id: 'TURN1', status: 'inProgress', items: [] },
  ] });
  const later = await connectCodexBroker({ socketPath, env });
  const interrupted = await interruptCodexTurn({ conn: later, threadId });
  later.close();
  assert.equal(interrupted.turnId, 'TURN1');
  const trace = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tail = trace.map((m) => m.method)
    .filter((m) => m === 'thread/read' || m === 'thread/resume' || m === 'turn/interrupt');
  assert.deepEqual(tail, ['thread/read', 'thread/resume', 'turn/interrupt']);
  assert.deepEqual(trace.find((m) => m.method === 'turn/interrupt').params, { threadId, turnId: 'TURN1' });
});
