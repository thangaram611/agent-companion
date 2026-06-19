// scripts/copilot-acp-daemon.test.mjs
// Unit tests for the per-session prompt mutex in SessionManager.startPromptBg
// and the hardened drain in SessionManager.replyPrompt. These tests pin the
// bug-fix invariant: a non-terminal prompt (running OR cancelling) must block
// any second prompt-bg on the same Copilot sessionId, and replyPrompt must
// refuse to restart when the prior turn never drains.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AcpConnection,
  IpcServer,
  SessionManager,
  TERMINAL_STATUSES,
  REPLY_DRAIN_TIMEOUT_MS,
} from './copilot-acp-daemon.mjs';

const RUNTIME_SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-daemon-runtime-'));
process.env.AGENT_RUNTIME_DIR = RUNTIME_SANDBOX;
test.after(() => {
  rmSync(RUNTIME_SANDBOX, { recursive: true, force: true });
  delete process.env.AGENT_RUNTIME_DIR;
});

// Stub AcpConnection: pretends to be alive; sendPrompt returns a controllable
// promise (call resolveSendPrompt / rejectSendPrompt to settle it) so the
// test can pin the prompt's lifecycle state. cancelSession is a no-op.
function makeFakeConnection() {
  let resolveSend = null;
  let rejectSend = null;
  const cancelCalls = [];
  return {
    child: { exitCode: null, pid: 1, kill() {} },
    initialized: true,
    dead: false,
    model: 'gpt-5.5',
    isAlive() { return true; },
    sendPrompt(_sid, _text, _writeEvent) {
      return new Promise((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
    },
    cancelSession(sessionId) { cancelCalls.push(sessionId); return true; },
    kill() {},
    resolveSend(value)  { if (resolveSend) resolveSend(value); },
    rejectSend(err)     { if (rejectSend) rejectSend(err); },
    cancelCalls,
  };
}

// Spin up a SessionManager with a fake connection + one pre-registered
// session, plus tidy teardown so node:test doesn't leak unref'd timers.
function makeManager(sessionId = 'sid-A', cwd = '/tmp') {
  const manager = new SessionManager();
  const conn = makeFakeConnection();
  manager.connection = conn;
  manager.sessions.set(sessionId, { cwd, model: 'gpt-5.5', promptCount: 0, createdAt: Date.now() });
  const teardown = async () => {
    // Settle any dangling sendPrompt first so the daemon's `.then` handler
    // runs (it calls _resetInactivityTimer and writeEvent). We then drain
    // microtasks before clearing timers, otherwise the post-resolve handler
    // would re-arm inactivityTimer after we cleared it and keep Node alive
    // for the full 15-min INACTIVITY_TIMEOUT_MS.
    conn.resolveSend({ stopReason: 'end_turn' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    if (manager.inactivityTimer) clearTimeout(manager.inactivityTimer);
    if (manager.superviseTimer) clearInterval(manager.superviseTimer);
    if (manager._livenessTimer) clearInterval(manager._livenessTimer);
    manager.inactivityTimer = null;
    manager.superviseTimer = null;
    manager._livenessTimer = null;
    manager.inFlightPrompts.clear();
  };
  return { manager, conn, teardown };
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function patchAcpConnection(t) {
  const original = {
    spawn: AcpConnection.prototype.spawn,
    initialize: AcpConnection.prototype.initialize,
    createSession: AcpConnection.prototype.createSession,
  };
  const spawns = [];
  const kills = [];
  let seq = 0;

  AcpConnection.prototype.spawn = async function spawnForTest(cwd) {
    this.cwd = cwd;
    this.cwdReal = realpathSync(cwd);
    this.model = 'gpt-5.5';
    this.dead = false;
    this.child = {
      exitCode: null,
      pid: ++seq,
      kill() {
        kills.push(cwd);
        this.exitCode = 0;
      },
    };
    spawns.push(cwd);
  };
  AcpConnection.prototype.initialize = async function initializeForTest() {
    this.initialized = true;
  };
  AcpConnection.prototype.createSession = async function createSessionForTest() {
    return `sid-generated-${++seq}`;
  };

  t.after(() => {
    AcpConnection.prototype.spawn = original.spawn;
    AcpConnection.prototype.initialize = original.initialize;
    AcpConnection.prototype.createSession = original.createSession;
  });

  return { spawns, kills };
}

test('startSession respawns for cwd changes but refuses cwd switches while a prompt is active', async (t) => {
  const dirA = makeTempDir('copilot-cwd-a-');
  const dirB = makeTempDir('copilot-cwd-b-');
  const dirC = makeTempDir('copilot-cwd-busy-c-');
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  });

  const { spawns, kills } = patchAcpConnection(t);
  const manager = new SessionManager();
  t.after(() => manager.shutdown());

  const sidA = await manager.startSession(dirA);
  assert.equal(manager.sessions.get(sidA).cwd, dirA);
  assert.deepEqual(spawns, [dirA]);

  const sidB = await manager.startSession(dirB);
  assert.equal(manager.sessions.has(sidA), false, 'old session ids must be invalidated with the old process');
  assert.equal(manager.sessions.get(sidB).cwd, dirB);
  assert.deepEqual(spawns, [dirA, dirB], 'different cwd must get a fresh Copilot process');
  assert.deepEqual(kills, [dirA], 'the old cwd-rooted process must be terminated');

  manager.inFlightPrompts.set('prompt-busy', {
    promptId: 'prompt-busy',
    sessionId: sidB,
    cwd: dirB,
    status: 'running',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    eventsFile: '/tmp/copilot-acp-prompt-busy.jsonl',
    _terminalWaiters: [],
    _interimWaiters: [],
  });

  await assert.rejects(
    () => manager.startSession(dirC),
    (err) => {
      assert.equal(err.code, 'CWD_BUSY');
      assert.equal(err.existingPromptId, 'prompt-busy');
      return true;
    },
  );
  assert.deepEqual(spawns, [dirA, dirB], 'blocked switch must not spawn a third process');
});

test('prompt-bg treats explicit cwd mismatch on a remembered session as a fresh session', async (t) => {
  const dirA = makeTempDir('copilot-session-cwd-a-');
  const dirB = makeTempDir('copilot-session-cwd-b-');
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  const manager = new SessionManager();
  t.after(() => manager.shutdown());
  manager.connection = makeFakeConnection();
  manager.sessions.set('sid-old', { cwd: dirA, promptCount: 0, createdAt: Date.now() });

  let startSessionCwd = null;
  let promptSessionId = null;
  manager._startSessionUnlocked = async (cwd, model = 'gpt-5.5') => {
    startSessionCwd = cwd;
    manager.sessions.set('sid-new', { cwd, model, promptCount: 0, createdAt: Date.now() });
    return 'sid-new';
  };
  manager.startPromptBg = async (sessionId) => {
    promptSessionId = sessionId;
    return { promptId: 'prompt-new', sessionId };
  };

  const server = new IpcServer(manager);
  const response = await server._dispatch({
    command: 'prompt-bg',
    sessionId: 'sid-old',
    cwd: dirB,
    text: 'use the new repo',
  });

  assert.equal(response.ok, true);
  assert.equal(startSessionCwd, dirB, 'explicit cwd must be used for the replacement session');
  assert.equal(promptSessionId, 'sid-new');
  assert.equal(response.data.sessionId, 'sid-new');
  assert.equal(response.data.sessionReborn, true);
  assert.equal(manager.sessions.has('sid-old'), false, 'wrong-cwd sid must not be reused');
});

test('prompt-bg refuses missing cwd instead of defaulting to the daemon cwd', async (t) => {
  const manager = new SessionManager();
  t.after(() => manager.shutdown());
  const server = new IpcServer(manager);

  const response = await server._dispatch({
    command: 'prompt-bg',
    text: 'this should not run in process.cwd',
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'CWD_REQUIRED');
  assert.match(response.error, /prompt-bg cwd is required/);
});

test('startPromptBg mutex blocks running/cancelling prompts and cancelled rejection releases the session', async (t) => {
  const { manager, conn, teardown } = makeManager('sid-A');
  t.after(teardown);

  const first = await manager.startPromptBg('sid-A', 'hello');
  const firstState = manager.inFlightPrompts.get(first.promptId);
  assert.equal(firstState.status, 'running', 'first prompt should be running');

  await assert.rejects(
    () => manager.startPromptBg('sid-A', 'world'),
    (err) => {
      assert.equal(err.code, 'SESSION_BUSY', 'mutex must surface SESSION_BUSY code');
      assert.equal(err.existingPromptId, first.promptId, 'must report the in-flight promptId');
      assert.equal(err.sessionId, 'sid-A', 'must report the contested sessionId');
      return true;
    },
  );

  // Sanity: the original prompt is untouched.
  assert.equal(manager.inFlightPrompts.size, 1);
  assert.equal(manager.inFlightPrompts.get(first.promptId).status, 'running');

  // Simulate the post-cancel window where the prior collector is still
  // mapped in AcpConnection.sessionCollectors[sessionId]. cancelPrompt flips
  // state to 'cancelling' but the JSON-RPC promise has not yet resolved.
  manager.cancelPrompt(first.promptId);
  const state = manager.inFlightPrompts.get(first.promptId);
  assert.equal(state.status, 'cancelling');
  assert.ok(!TERMINAL_STATUSES.has(state.status), 'cancelling must remain non-terminal');

  await assert.rejects(
    () => manager.startPromptBg('sid-A', 'turn2'),
    (err) => err.code === 'SESSION_BUSY' && err.existingPromptId === first.promptId,
    'mutex must still trip for cancelling prompts — this is the no-exemption invariant',
  );

  conn.rejectSend(new Error('connection closed after cancel'));
  await new Promise((r) => setImmediate(r));

  assert.equal(state.status, 'cancelled');
  assert.equal(manager.activePrompts(), 0, 'cancelled prompt must not keep the session busy forever');
  assert.ok(TERMINAL_STATUSES.has(state.status));
});

test('prompt timeout and empty completion retire the ACP session before reuse', async (t) => {
  {
    const { manager, conn, teardown } = makeManager('sid-timeout');
    t.after(teardown);

    const first = await manager.startPromptBg('sid-timeout', 'long turn');
    conn.rejectSend(new Error('prompt timeout'));
    await new Promise((r) => setImmediate(r));

    const state = manager.inFlightPrompts.get(first.promptId);
    assert.equal(state.status, 'failed');
    assert.equal(state.error, 'prompt timeout');
    assert.equal(state.sessionRetired, true);
    assert.equal(manager.sessions.has('sid-timeout'), false);
    assert.deepEqual(conn.cancelCalls, ['sid-timeout']);
    manager.shutdown();
  }

  {
    const { manager, conn, teardown } = makeManager('sid-empty');
    t.after(teardown);

    const first = await manager.startPromptBg('sid-empty', 'poisoned turn');
    conn.resolveSend({
      sessionId: 'sid-empty',
      thoughts: '',
      message: '',
      toolCalls: [],
      plan: null,
      stopReason: 'end_turn',
    });
    await new Promise((r) => setImmediate(r));

    const state = manager.inFlightPrompts.get(first.promptId);
    assert.equal(state.status, 'failed');
    assert.equal(state.error, 'empty completed response');
    assert.equal(state.stuckDetail, 'empty_completed');
    assert.equal(state.sessionRetired, true);
    assert.equal(manager.sessions.has('sid-empty'), false);
    assert.deepEqual(conn.cancelCalls, ['sid-empty']);
    manager.shutdown();
  }
});

test('concurrent first prompt-bg calls from different cwd do not kill the first session startup', async (t) => {
  const dirA = makeTempDir('copilot-race-a-');
  const dirB = makeTempDir('copilot-race-b-');
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  patchAcpConnection(t);
  const manager = new SessionManager();
  t.after(() => manager.shutdown());
  manager.startPromptBg = async (sessionId) => {
    const promptId = `prompt-${sessionId}`;
    manager.inFlightPrompts.set(promptId, {
      promptId,
      sessionId,
      cwd: manager.sessions.get(sessionId)?.cwd || null,
      status: 'running',
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      eventsFile: `/tmp/copilot-acp-${promptId}.jsonl`,
      _terminalWaiters: [],
      _interimWaiters: [],
    });
    return { promptId, sessionId };
  };

  const server = new IpcServer(manager);
  const [a, b] = await Promise.all([
    server._dispatch({ command: 'prompt-bg', cwd: dirA, text: 'A' }),
    server._dispatch({ command: 'prompt-bg', cwd: dirB, text: 'B' }),
  ]);

  const oks = [a, b].filter((r) => r.ok);
  const blocked = [a, b].filter((r) => !r.ok);
  assert.equal(oks.length, 1, 'one prompt starts');
  assert.equal(blocked.length, 1, 'the competing cwd is rejected cleanly');
  assert.equal(blocked[0].code, 'CWD_BUSY');
  assert.ok(blocked[0].data?.existingPromptId, 'blocked response carries the active prompt id');
});

test('replyPrompt returns drain-timeout error and does NOT call startPromptBg when the prior turn never drains', async (t) => {
  const { manager, conn, teardown } = makeManager('sid-C');
  t.after(teardown);

  const first = await manager.startPromptBg('sid-C', 'turn1');

  // Spy: capture any startPromptBg invocation that happens after the drain
  // cap fires. The hardened replyPrompt must NOT call it on timeout.
  let startCalledAfterTimeout = false;
  const originalStart = manager.startPromptBg.bind(manager);
  manager.startPromptBg = (...args) => {
    startCalledAfterTimeout = true;
    return originalStart(...args);
  };

  // Fast-forward the drain cap via fake timers. cancelSession is a no-op in
  // the fake, so state.status stays at 'cancelling' until the cap expires.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const replyP = manager.replyPrompt(first.promptId, 'follow-up');
  // Advance past the drain cap.
  t.mock.timers.tick(REPLY_DRAIN_TIMEOUT_MS + 50);
  const result = await replyP;
  t.mock.timers.reset();

  assert.equal(result.ok, false, 'replyPrompt must report failure on drain timeout');
  assert.match(result.reason, /reply timeout: prior turn did not drain/);
  assert.equal(startCalledAfterTimeout, false, 'startPromptBg must not be called on drain timeout');

  // The first prompt is left in 'cancelling' so the mutex would still block
  // anyone else from racing in on this session.
  const state = manager.inFlightPrompts.get(first.promptId);
  assert.equal(state.status, 'cancelling');
});
