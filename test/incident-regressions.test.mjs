import '../test/sandbox-home.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// All paths are pinned BEFORE importing any source module. The source tree and
// dependency link are read-only inputs. No real provider or socket is used.
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..');
const sandbox = mkdtempSync(join(tmpdir(), 'incident-'));
const runtimeDir = join(sandbox, 'runtime');
const workDir = join(sandbox, 'work');
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
const pins = {
  AGENT_COMPANION_HOME: join(sandbox, 'state'), AGENT_RUNTIME_DIR: runtimeDir,
  AGENT_QUEUE_PATH: join(runtimeDir, 'queue.jsonl'), AGENT_BRIDGE_LOG_FILE: join(runtimeDir, 'bridge.log'),
  AGENT_CODEX_BROKER_REGISTRY: join(runtimeDir, 'broker.json'), CODEX_BROKER_SOCKET_PATH: join(runtimeDir, 'b.sock'),
  CODEX_BROKER_LOG_FILE: join(runtimeDir, 'broker.log'), AGENT_ACP_DAEMON_REGISTRY: join(runtimeDir, 'acp.json'),
  AGENT_OPENCODE_SERVER_REGISTRY: join(runtimeDir, 'opencode.json'),
  AGENT_HEARTBEAT_DIR: join(runtimeDir, 'heartbeats'), AGENT_PROMPT_JSONL_DIR: join(runtimeDir, 'prompts'),
  AGENT_DIGEST_DIR: join(runtimeDir, 'digests'), COPILOT_OTEL_TRACES_PATH: join(runtimeDir, 'otel.jsonl'),
  COPILOT_SOCKET_PATH: join(runtimeDir, 'copilot.sock'), ANTIGRAVITY_SOCKET_PATH: join(runtimeDir, 'antigravity.sock'),
  COPILOT_DAEMON_LOG_FILE: join(runtimeDir, 'copilot.log'), ANTIGRAVITY_DAEMON_LOG_FILE: join(runtimeDir, 'antigravity.log'),
  CODEX_BIN: join(sandbox, 'forbidden-real-provider'), CODEX_BROKER_PATH: join(sandbox, 'forbidden-real-broker'),
  CODEX_RUNTIME_ADAPTER: 'appserver', AGENT_COMPANION_DEFAULT_TARGET: 'codex',
  CLAUDE_CODE_SESSION_ID: 'isolated-incident-regressions',
};
Object.assign(process.env, pins);
for (const p of ['heartbeats', 'prompts', 'digests']) mkdirSync(join(runtimeDir, p), { recursive: true });
const load = (p) => import(pathToFileURL(join(source, p)).href);
const cx = await load('bridge-server/codex-app-server-runtime.mjs');
const { fakeBrokerSocket } = await load('test/fake-codex-broker-socket.mjs');
const { note } = await load('test/codex-wire-frames.mjs');
const state = await load('lib/state.mjs');
const mod = await load('bridge-server/server.mjs');
const { digestPath } = await load('lib/prompt-digest.mjs');

let attemptedSpawns = 0;
const sockets = [];
let statuses = {};
let turns = {};
let currentTurn = 'TURN1';
let nativeStarts = 0;
let handlers = {};
cx._setForTest({
  connect: async (path) => {
    assert.equal(path, pins.CODEX_BROKER_SOCKET_PATH, 'every broker connection is sandbox-addressed');
    const sock = fakeBrokerSocket({ statuses, turns, handlers });
    sockets.push(sock);
    return sock;
  },
  spawnBroker: () => { attemptedSpawns++; throw new Error('forbidden real broker spawn'); },
  inspectCodexInstall: () => ({ ready: true, selected: {
    version: '0.147.0', path: '/fake/codex', realPath: '/fake/codex',
    helperPath: '/fake/codex-code-mode-host', source: 'installed',
    identity: 'fake-codex-0.147.0', quarantined: false,
  } }),
  pathExists: () => true,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, label, budget = 3000) {
  const end = Date.now() + budget;
  while (Date.now() < end) { if (predicate()) return; await sleep(5); }
  assert.ok(predicate(), `fixture did not reach ${label}`);
}
const parse = (response) => JSON.parse(response.content.find((c) => c.type === 'text').text);
const frames = (list = sockets) => list.flatMap((s) => s.calls);
const methodCount = (method, list = sockets) => frames(list).filter((m) => m.method === method).length;
const queueRows = () => existsSync(pins.AGENT_QUEUE_PATH)
  ? readFileSync(pins.AGENT_QUEUE_PATH, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const terminalRows = (id) => queueRows().filter((r) => r.kind === 'terminal' && r.jobId === id);
const send = (bridge, task, thread) => bridge.dispatch({
  action: 'send', target: 'codex', task, mode: 'EXECUTE', template: 'general',
  cwd: workDir, thread, parallel: 'never', max_wait_sec: 1,
}).then(parse);
const wait = (bridge, id) => bridge.dispatch({ action: 'wait', job_id: id, max_wait_sec: 1 }).then(parse);
const snapshot = (x) => JSON.parse(JSON.stringify(x));
function complete(sock, text, turnId = currentTurn) {
  sock.notify('item/completed', { item: { id: `m-${turnId}`, type: 'agentMessage', text, phase: 'final_answer' } });
  sock.notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
}
function beginFixture(turnId) {
  mod.jobs.clear(); mod._resetForTest();
  for (const job of state.listJobsForSession(pins.CLAUDE_CODE_SESSION_ID)) state.deleteJob(job.jobId);
  statuses = {}; turns = {}; currentTurn = turnId; nativeStarts = 0;
  handlers = {
    'turn/start': ({ threadId }) => {
      nativeStarts++;
      statuses[threadId] = 'active';
      turns[threadId] = [{ id: currentTurn, status: 'inProgress', items: [] }];
      return { turn: { id: currentTurn } };
    },
    'turn/interrupt': ({ threadId }) => {
      statuses[threadId] = 'idle';
      turns[threadId] = [{ id: currentTurn, status: 'interrupted', items: [] }];
      return {};
    },
  };
}

const observations = {};
function check(name, kind, body) {
  // Phase 0 retains the ten incident defects for later phases; controls still
  // fail normally. TODO executes every contract assertion without hiding it.
  test(`${kind}: ${name}`, { todo: kind === 'CONTRACT' }, body);
}

// Probe A is one continuous real bridge-worker path, not fabricated timeout
// output: start -> watcher timeout -> retained ledger -> follow-up send.
beginFixture('TURN-OLD');
process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS = '120';
const first = await send(mod, 'OLD_INSTRUCTION', 'incident-timeout-followup');
await until(() => mod.jobs.get(first.job_id)?.turnId === 'TURN-OLD', 'first native turn');
const firstSocket = sockets.findLast((s) => s.paramsFor('turn/start').length);
firstSocket.notify('item/agentMessage/delta', { itemId: 'old-message', delta: 'OLD_PARTIAL' });
await until(() => mod.jobs.get(first.job_id)?.terminalAt, 'actual watcher expiry');
const firstTerminal = await wait(mod, first.job_id);
const afterExpiry = snapshot({
  job: mod.jobs.get(first.job_id), response: firstTerminal,
  nativeStatus: statuses.T1, interruptCalls: methodCount('turn/interrupt'),
  starts: nativeStarts, ledger: state.readJob(first.job_id),
});
process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS = '1000';
const socketBoundary = sockets.length;
const second = await send(mod, 'NEW_DECISION_MUST_REACH_PROVIDER', 'incident-timeout-followup');
await until(() => mod.jobs.get(second.job_id)?.turnId === 'TURN-OLD', 'follow-up attaching to active old turn');
const followupSockets = sockets.slice(socketBoundary);
const followingSocket = followupSockets.findLast((s) => s.paramsFor('broker/subscribe').length);
const beforeOldCompletion = snapshot({
  send: second, job: mod.jobs.get(second.job_id),
  transmittedTexts: frames().flatMap((m) => m.params?.input || []).map((i) => i.text).filter(Boolean),
  followupMethods: followupSockets.flatMap((s) => s.methods()), starts: nativeStarts,
});
statuses.T1 = 'idle';
complete(followingSocket, 'OLD_TURN_FINISHED_WITHOUT_NEW_DECISION', 'TURN-OLD');
await until(() => mod.jobs.get(second.job_id)?.terminalAt, 'old completion returned under new job');
const secondTerminal = await wait(mod, second.job_id);
observations.timeoutThenSend = { afterExpiry, beforeOldCompletion, followupTerminal: secondTerminal };
check('timeout fixture actually started one native turn and expired with preserved partial output', 'CONTROL', () => {
  assert.equal(afterExpiry.starts, 1); assert.equal(afterExpiry.job.status, 'timeout');
  assert.equal(afterExpiry.ledger.status, 'timeout'); assert.match(afterExpiry.job.summary.message, /OLD_PARTIAL/);
});
check('timeout fixture leaves native active and new send receives old completion', 'CONTROL', () => {
  assert.equal(afterExpiry.nativeStatus, 'active'); assert.equal(afterExpiry.interruptCalls, 0);
  assert.equal(beforeOldCompletion.starts, 1); assert.equal(secondTerminal.status, 'completed');
  assert.match(secondTerminal.content, /OLD_TURN_FINISHED_WITHOUT_NEW_DECISION/);
});
check('timeout must stop work or avoid claiming process termination', 'CONTRACT', () => {
  assert.ok(afterExpiry.nativeStatus !== 'active' || !/bridge terminated the target process/i.test(afterExpiry.response.content),
    'native turn is active, no interrupt was sent, yet the terminal response claims process termination');
});
check('new instructions must be delivered or explicitly rejected while native turn is active', 'CONTRACT', () => {
  const delivered = beforeOldCompletion.transmittedTexts.some((text) => text.includes('NEW_DECISION_MUST_REACH_PROVIDER'));
  const rejected = beforeOldCompletion.send.ok === false;
  assert.ok(delivered || rejected, 'new send returned ok:true and no turn/start or turn/steer carried its text');
});
check('old native answer must not be labeled the successful result of an undelivered new task', 'CONTRACT', () => {
  assert.notEqual(secondTerminal.status, 'completed', 'old turn completion was reported as success for NEW_DECISION_MUST_REACH_PROVIDER');
});

// Probe B injects a schema-validated retry error followed by genuine native
// progress/completion. It does not infer retry status from arbitrary strings.
beginFixture('TURN-RETRY');
process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS = '1000';
const retry = await send(mod, 'RETRY_STREAM_TASK', 'incident-retry');
await until(() => mod.jobs.get(retry.job_id)?.turnId === 'TURN-RETRY', 'retry turn start');
const retrySocket = sockets.findLast((s) => s.paramsFor('turn/start').length);
const retryFrame = note('error', {
  threadId: 'T1', turnId: 'TURN-RETRY', willRetry: true,
  error: { message: 'Reconnecting... 2/5; proxy tunnel refused', codexErrorInfo: 'internalServerError', additionalDetails: null },
});
retrySocket.deliver(retryFrame);
await sleep(25);
const afterRetry = snapshot(mod.jobs.get(retry.job_id));
const retryTerminal = await wait(mod, retry.job_id);
statuses.T1 = 'idle';
complete(retrySocket, 'RECOVERED_AND_FINISHED', 'TURN-RETRY');
await sleep(15);
observations.retry = { frame: retryFrame, afterRetry, response: retryTerminal, afterNativeCompletion: snapshot(mod.jobs.get(retry.job_id)), socketDestroyed: retrySocket.destroyed };
check('retry fixture passes pinned wire-schema validation and real worker receives error', 'CONTROL', () => {
  assert.equal(retryFrame.params.willRetry, true); assert.equal(afterRetry.status, 'failed');
  assert.match(afterRetry.error, /Reconnecting/); assert.equal(afterRetry.detail, 'codex_server_failed');
});
check('willRetry:true must not settle the bridge job before native terminal', 'CONTRACT', () => {
  assert.equal(afterRetry.terminalAt, undefined, 'retryable transport error prematurely terminalized the job');
});
check('a recovered native answer must remain observable after a retryable error', 'CONTRACT', () => {
  assert.equal(observations.retry.afterNativeCompletion.status, 'completed');
  assert.match(observations.retry.afterNativeCompletion.summary.message, /RECOVERED_AND_FINISHED/);
});

// Probe C models two simultaneously alive bridge module instances sharing a
// ledger and fake native runtime. Import query separates only the server's
// module-local job map, exactly the state split between real bridge processes.
// Fault injection: observer B misses A's completion frame, then its own watch
// timer expires. This exposes stale writer fencing independently of host MCP
// lifetime behavior, which this in-process fixture cannot prove.
beginFixture('TURN-OBSERVERS');
process.env.AGENT_COMPANION_CODEX_TIMEOUT_MS = '350';
const owned = await send(mod, 'OWNED_LIVE_TASK', 'incident-observers');
await until(() => mod.jobs.get(owned.job_id)?.turnId === 'TURN-OBSERVERS', 'owner turn start');
const ownerSocket = sockets.findLast((s) => s.paramsFor('turn/start').length);
const observer = await import(pathToFileURL(join(source, 'bridge-server/server.mjs')).href + '?incident-observer=second');
const observerBoundary = sockets.length;
const stateBeforeHydration = snapshot(state.readJob(owned.job_id));
observer.hydrateJobsFromLedger();
await until(() => sockets.slice(observerBoundary).some((s) => s.paramsFor('thread/resume').length), 'observer hydration native resume');
const observerSockets = sockets.slice(observerBoundary);
const observerSocket = observerSockets.findLast((s) => s.paramsFor('broker/subscribe').length);
assert.ok(observerSocket, 'observer must subscribe');
const digestBeforeStatus = readFileSync(digestPath(owned.job_id), 'utf8');
await sleep(10);
const observerStatus = parse(await observer.dispatch({ action: 'status', job_id: owned.job_id }));
const digestAfterStatus = readFileSync(digestPath(owned.job_id), 'utf8');
const hydrateObserved = snapshot({
  ownerStillNonterminal: !mod.jobs.get(owned.job_id).terminalAt,
  observerLoaded: observer.jobs.has(owned.job_id),
  mapsDistinct: mod.jobs !== observer.jobs,
  observerMethods: observerSockets.flatMap((s) => s.methods()),
  observerSubscriptions: methodCount('broker/subscribe', observerSockets),
  observerNativeResumes: methodCount('thread/resume', observerSockets),
  stateBeforeHydration, status: observerStatus,
  digestChangedByStatus: digestAfterStatus !== digestBeforeStatus,
});
// Status activity is recent, but API reports total job age, not event age.
const ownerJob = mod.jobs.get(owned.job_id);
ownerJob.startedAt = Date.now() - 600_000;
ownerSocket.notify('item/agentMessage/delta', { itemId: 'live-progress', delta: 'FRESH_EVENT_MARKER' });
await until(() => mod.jobs.get(owned.job_id)?.adapterResult?.stdout?.includes('FRESH_EVENT_MARKER'), 'fresh progress event');
const freshProgress = parse(await mod.dispatch({ action: 'status', job_id: owned.job_id }));
statuses.T1 = 'idle';
complete(ownerSocket, 'OWNER_COMPLETED', 'TURN-OBSERVERS');
await until(() => mod.jobs.get(owned.job_id)?.terminalAt, 'owner completion');
const ownerLedger = snapshot(state.readJob(owned.job_id));
await until(() => observer.jobs.get(owned.job_id)?.terminalAt, 'stale observer timeout');
const finalLedger = snapshot(state.readJob(owned.job_id));
const rows = terminalRows(owned.job_id);
observations.observers = {
  hydration: hydrateObserved, freshProgress,
  ownerLedger, finalLedger,
  ownerMemoryStatus: mod.jobs.get(owned.job_id).status,
  observerMemoryStatus: observer.jobs.get(owned.job_id).status,
  terminalRows: rows.map((r) => ({ jobId: r.jobId, kind: r.kind, meta: r.meta })),
  faultInjection: 'completion frame deliberately delivered only to owner A; observer B timer expires while runtime is idle',
};
check('second bridge fixture has independent job map and attaches while owner remains alive', 'CONTROL', () => {
  assert.equal(hydrateObserved.mapsDistinct, true); assert.equal(hydrateObserved.ownerStillNonterminal, true);
  assert.equal(hydrateObserved.observerLoaded, true); assert.equal(hydrateObserved.observerSubscriptions, 1);
  assert.ok(hydrateObserved.observerNativeResumes >= 1);
});
check('fault injection reaches two different terminal observations for one job', 'CONTROL', () => {
  assert.equal(ownerLedger.status, 'completed'); assert.equal(finalLedger.status, 'timeout');
  assert.equal(observations.observers.ownerMemoryStatus, 'completed');
  assert.equal(observations.observers.observerMemoryStatus, 'timeout'); assert.equal(rows.length, 2);
});
check('a status-only second bridge must not recover a live owner job', 'CONTRACT', () => {
  assert.equal(hydrateObserved.observerSubscriptions, 0, 'startup hydration creates another live watcher before status is answered');
});
check('an older observer must not overwrite an already persisted terminal result', 'CONTRACT', () => {
  assert.equal(finalLedger.status, ownerLedger.status, 'stale observer timeout replaced a persisted completed result');
});
check('one native job must publish at most one terminal event across observers', 'CONTRACT', () => {
  assert.equal(rows.length, 1, 'two unfenced bridge writers published competing terminal events');
});
check('status inactivity must reflect the just-received provider event', 'CONTRACT', () => {
  assert.ok(freshProgress.ms_since_last_event < 1000,
    `fresh event was received, but ms_since_last_event reports ${freshProgress.ms_since_last_event}`);
});
check('the job-specific status handler must be read-only', 'CONTRACT', () => {
  assert.equal(hydrateObserved.digestChangedByStatus, false, 'status rewrites digest contents');
});
check('all probes use fake broker transport and make no spawn attempt', 'CONTROL', () => {
  assert.equal(attemptedSpawns, 0); assert.equal(state.BASE_DIR, pins.AGENT_COMPANION_HOME);
  assert.ok(sockets.length > 0); assert.ok(sockets.every((s) => s.destroyed));
});

after(() => {
  for (const sock of sockets) sock.destroy();
  mod.jobs.clear(); observer.jobs.clear(); cx._resetForTest();
  rmSync(sandbox, { recursive: true, force: true });
});
