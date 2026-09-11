// scripts/acp-daemon.test.mjs
// The generic ACP daemon against a real agent process: test/fake-acp-agent.mjs
// spawned over stdio through a descriptor's `binaryEnv`, the way a companion
// binary is. The fake's own descriptor (`fakeAcpDescriptor`) is the second
// ACP companion here, so every generic behaviour is exercised on something
// that is not Copilot; scripts/copilot-acp-daemon.test.mjs keeps pinning the
// Copilot binding with a fake in-process connection. This suite pins what
// that one cannot see — the handshake, the protocol pin, agent-to-client
// requests, the usage hook, `session/load`, and the descriptor-driven argv.

import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeAcpAgentBin, fakeAcpDescriptor } from '../test/fake-acp-agent.mjs';
import { getTargetById } from '../lib/target-registry.mjs';
import { daemonLogFile } from '../lib/runtime-paths.mjs';
import {
  SessionManager,
  IpcServer,
  TERMINAL_STATUSES,
  ACP_PROTOCOL_VERSION,
} from './acp-daemon.mjs';

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'acp-daemon-fake-'));
const FAKE_BIN = fakeAcpAgentBin(FIXTURE_DIR);
test.after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

const FAKE = fakeAcpDescriptor();
const COPILOT = getTargetById('copilot');

function tempCwd(prefix = 'acp-daemon-cwd-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

// The fake is scripted from its environment, and the daemon spawns it with a
// copy of process.env — so a scenario sets what it needs here and restores it.
async function withEnv(overrides, fn) {
  const prior = {};
  for (const [k, v] of Object.entries(overrides)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function until(predicate, { budgetMs = 8000, stepMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

function readTrace(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readEvents(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A manager whose real AcpConnection spawns the fake. `t.after` kills the
// child and every timer, so a scenario that fails mid-way leaks nothing.
function managerFor(t, descriptor) {
  const manager = new SessionManager(descriptor);
  t.after(() => manager.shutdown());
  return manager;
}

async function runPrompt(manager, sessionId, text) {
  const { promptId } = await manager.startPromptBg(sessionId, text);
  const state = manager.inFlightPrompts.get(promptId);
  assert.ok(await until(() => TERMINAL_STATUSES.has(state.status)), `prompt ${promptId} reached a terminal status (last: ${state.status})`);
  return state;
}

test('the descriptors drive the argv: Copilot byte-identical to the flags it always had, the fake as a bare `--acp`', () => {
  assert.deepEqual(COPILOT.acp.args({ model: 'claude-sonnet-4.6', env: {} }), [
    '--acp',
    '--model', 'claude-sonnet-4.6',
    '--reasoning-effort', 'xhigh',
    '--no-ask-user',
    '--allow-all-tools',
    '--allow-all-paths',
    '--allow-all-urls',
    '--experimental',
  ]);
  assert.equal(COPILOT.acp.clientName, 'copilot-acp-daemon');
  assert.deepEqual(COPILOT.acp.env({ env: {}, paths: { otelTraces: '/x/traces.jsonl' } }), {
    COPILOT_OTEL_ENABLED: 'true',
    COPILOT_OTEL_FILE_EXPORTER_PATH: '/x/traces.jsonl',
  });
  assert.deepEqual(COPILOT.acp.rotate, ['otelTraces']);
  assert.equal(COPILOT.acp.loadSession, false, 'Copilot sessions are process-local (github/copilot-cli#1767)');
  assert.equal(COPILOT.acp.permission({}), 'all');
  assert.equal(COPILOT.acp.rubberDuck, true);

  assert.deepEqual(FAKE.acp.args({ model: null, env: {} }), ['--acp']);
  assert.deepEqual(FAKE.acp.args({ model: 'm1', env: {} }), ['--acp', '--model', 'm1']);
  assert.equal(FAKE.acp.defaultModel({}), null, 'no model pin means the agent\'s own default');
  assert.equal(FAKE.acp.permission({}), 'all');
  assert.equal(FAKE.acp.permission({ FAKE_ACP_POLICY: 'edit' }), 'edit');
  assert.equal(ACP_PROTOCOL_VERSION, 1);
});

test('a prompt completes over a real stdio handshake, with the tool calls, the message and the usage the descriptor reads off the prompt response', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const trace = join(cwd, 'trace.jsonl');
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_TRACE: trace, ACP_FAKE_USAGE: 'quota' }, async () => {
    const manager = managerFor(t, FAKE);
    const sessionId = await manager.startSession(cwd);
    assert.match(sessionId, /^fake-sess-/);
    const status = manager.getStatus();
    assert.equal(status.companion, 'fake-acp');
    assert.deepEqual(status.protocol, { pinned: 1, answered: 1, status: 'match' });
    assert.equal(status.agentInfo?.name, 'fake-acp-agent');
    assert.equal(status.agentCapabilities?.loadSession, false);
    assert.equal(status.configuredModel, null);

    const state = await runPrompt(manager, sessionId, 'what is the magic word?');
    assert.equal(state.status, 'completed');
    assert.equal(state.summary.message, 'ready');
    assert.equal(state.summary.thoughts, 'thinking');
    assert.equal(state.summary.stopReason, 'end_turn');
    assert.equal('raw' in state.summary, false, 'the agent\'s raw response feeds the usage reader and travels no further');
    assert.deepEqual(state.summary.toolCalls.map((tc) => [tc.name, tc.kind, tc.status]), [['read README.md', 'read', 'completed']]);
    assert.deepEqual(state.summary.usage, {
      source: 'fake-acp',
      input_tokens: 1234, output_tokens: 56, cached_input_tokens: null,
      cache_write_input_tokens: null, reasoning_output_tokens: null, total_tokens: 1290,
      model: 'gemini-2.5-pro',
    });

    const events = readEvents(state.eventsFile);
    assert.deepEqual(events.map((e) => e.type), ['start', 'thought', 'tool_call', 'tool_call_update', 'message', 'done']);

    // The handshake: v1 pinned, the client's own name and no fs/terminal
    // capability — and no MCP `notifications/initialized`, which ACP does not
    // have (Gemini CLI 0.59.0 logged a -32601 for it, measured 2026-09-11).
    const frames = readTrace(trace);
    const init = frames.find((f) => f.method === 'initialize');
    assert.equal(init.params.protocolVersion, 1);
    assert.equal(init.params.clientInfo.name, 'agent-companion');
    assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    assert.equal(frames.some((f) => f.method === 'notifications/initialized'), false);
    assert.deepEqual(frames.find((f) => f.method === 'session/new').params, { cwd, mcpServers: [] });
    assert.deepEqual(frames[0].argv, ['--acp']);
  });
});

test('the descriptor\'s usage reader sees the standard `usage` field too, and nothing is invented when neither is there', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_USAGE: 'standard' }, async () => {
    const manager = managerFor(t, FAKE);
    const sessionId = await manager.startSession(cwd);
    const state = await runPrompt(manager, sessionId, 'hello');
    assert.deepEqual(state.summary.usage, {
      source: 'fake-acp',
      input_tokens: 1234, output_tokens: 56, cached_input_tokens: 100,
      cache_write_input_tokens: null, reasoning_output_tokens: 10, total_tokens: 1300,
    });
  });
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_USAGE: 'none' }, async () => {
    const manager = managerFor(t, FAKE);
    const sessionId = await manager.startSession(cwd);
    const state = await runPrompt(manager, sessionId, 'hello');
    assert.equal(state.status, 'completed');
    assert.equal('usage' in state.summary, false, 'absent, never zeroed');
  });
});

test('an agent answering another protocol version is refused, not adapted: the child dies and the session fails ACP_PROTOCOL_MISMATCH', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_PROTOCOL_VERSION: '2' }, async () => {
    const manager = managerFor(t, FAKE);
    await assert.rejects(
      () => manager.startSession(cwd),
      (err) => {
        assert.equal(err.code, 'ACP_PROTOCOL_MISMATCH');
        assert.match(err.message, /answered protocolVersion 2/);
        assert.match(err.message, /pins 1/);
        return true;
      },
    );
    assert.equal(manager.connection, null, 'no connection is kept from a refused handshake');
    const status = manager.getStatus();
    assert.deepEqual(status.protocol, { pinned: 1, answered: 2, status: 'mismatch' });
    assert.equal(status.connected, false);
    // The prompt-bg IPC path reports the same code so the bridge can name it.
    const server = new IpcServer(manager);
    const response = await server._dispatch({ command: 'prompt-bg', cwd, text: 'hello' });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'ACP_PROTOCOL_MISMATCH');
    assert.deepEqual(response.data.protocol, { pinned: 1, answered: 2, status: 'mismatch' });
  });
});

test('session/request_permission is answered by the daemon per descriptor policy, and recorded in the prompt stream', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scenario = async ({ policy, kind, expectOption, expectDecision }) => {
    const trace = join(cwd, `trace-${policy}-${kind}.jsonl`);
    await withEnv({
      FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_TRACE: trace, ACP_FAKE_ASK_PERMISSION: '1', ACP_FAKE_PERMISSION_KIND: kind,
      FAKE_ACP_POLICY: policy,
    }, async () => {
      const manager = managerFor(t, FAKE);
      const sessionId = await manager.startSession(cwd);
      const state = await runPrompt(manager, sessionId, 'list the files');
      assert.equal(state.status, 'completed', `${policy}/${kind}: the prompt still completes`);
      const answer = readTrace(trace).find((f) => f.permissionAnswer)?.permissionAnswer;
      assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: expectOption } }, `${policy}/${kind}: the answer`);
      const permission = readEvents(state.eventsFile).find((e) => e.type === 'permission');
      assert.equal(permission?.decision, expectDecision, `${policy}/${kind}: recorded decision`);
      assert.equal(permission?.toolCallId, 'call-perm-1');
      assert.equal(permission?.kind, kind);
      assert.equal(permission?.policy, policy);
      assert.equal(permission?.optionId, expectOption);
      // The tool outcome the agent reported after the answer rides the same stream.
      const outcome = readEvents(state.eventsFile).find((e) => e.type === 'tool_call_update' && e.toolCallId === 'call-perm-1');
      assert.equal(outcome.status, expectDecision === 'allow' ? 'completed' : 'failed');
    });
  };
  // all (the default): everything is allowed with the one-shot option, never
  // the persistent one — the daemon does not write agent policy.
  await scenario({ policy: 'all', kind: 'execute', expectOption: 'proceed_once', expectDecision: 'allow' });
  // edit: edits yes, everything else no.
  await scenario({ policy: 'edit', kind: 'edit', expectOption: 'proceed_once', expectDecision: 'allow' });
  await scenario({ policy: 'edit', kind: 'execute', expectOption: 'cancel', expectDecision: 'reject' });
  // none: nothing that asks is allowed.
  await scenario({ policy: 'none', kind: 'edit', expectOption: 'cancel', expectDecision: 'reject' });
});

test('an agent request for a capability the daemon did not declare is refused with -32601, never left hanging', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const trace = join(cwd, 'trace.jsonl');
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_TRACE: trace, ACP_FAKE_ASK_FS: '1' }, async () => {
    const manager = managerFor(t, FAKE);
    const sessionId = await manager.startSession(cwd);
    const state = await runPrompt(manager, sessionId, 'read the readme');
    assert.equal(state.status, 'completed');
    const answer = readTrace(trace).find((f) => f.fsAnswer)?.fsAnswer;
    assert.equal(answer?.code, -32601);
    assert.match(answer?.message || '', /fs\/read_text_file/);
  });
});

test('session/load: a session id the daemon no longer holds is loaded when both the descriptor and the agent allow it — and minted fresh otherwise', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // Descriptor and agent both allow it: a fresh daemon (new manager, new
  // agent process) is handed the old id and loads it — no rebirth.
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_LOAD_SESSION: '1' }, async () => {
    const first = managerFor(t, FAKE);
    const sessionId = await first.startSession(cwd);
    await runPrompt(first, sessionId, 'round one');
    first.shutdown();

    const trace = join(cwd, 'trace-load.jsonl');
    await withEnv({ ACP_FAKE_TRACE: trace }, async () => {
      const second = managerFor(t, FAKE);
      const server = new IpcServer(second);
      const response = await server._dispatch({ command: 'prompt-bg', sessionId, cwd, text: 'round two' });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.data.sessionId, sessionId, 'the same session continues');
      assert.equal(response.data.sessionReborn, false);
      assert.equal(response.data.sessionLoaded, true);
      const load = readTrace(trace).find((f) => f.method === 'session/load');
      assert.deepEqual(load.params, { sessionId, cwd, mcpServers: [] });
      const state = second.inFlightPrompts.get(response.data.promptId);
      assert.ok(await until(() => TERMINAL_STATUSES.has(state.status)));
      assert.equal(state.status, 'completed');
      // The replayed history is not this prompt's output.
      assert.equal(state.summary.message, 'ready');
      assert.equal(second.getStatus().sessions.find((s) => s.sessionId === sessionId)?.loaded, true);
    });
  });

  // The agent refuses the id: fresh session, rebirth reported — the existing
  // Copilot semantics, not a silent continuation of nothing.
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_LOAD_SESSION: '1', ACP_FAKE_LOAD_FAIL: '1' }, async () => {
    const manager = managerFor(t, FAKE);
    const server = new IpcServer(manager);
    const response = await server._dispatch({ command: 'prompt-bg', sessionId: 'fake-sess-gone', cwd, text: 'again' });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.notEqual(response.data.sessionId, 'fake-sess-gone');
    assert.equal(response.data.sessionReborn, true);
    assert.equal(response.data.sessionLoaded, false);
  });

  // The agent advertises loadSession but the descriptor says no — Copilot's
  // case (1.0.83 advertises it and its sessions are process-local, measured):
  // the daemon never sends session/load for it.
  const trace = join(cwd, 'trace-declined.jsonl');
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_LOAD_SESSION: '1', ACP_FAKE_TRACE: trace }, async () => {
    const manager = managerFor(t, fakeAcpDescriptor({ loadSession: false }));
    const server = new IpcServer(manager);
    const response = await server._dispatch({ command: 'prompt-bg', sessionId: 'fake-sess-old', cwd, text: 'again' });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.data.sessionReborn, true);
    assert.equal(readTrace(trace).some((f) => f.method === 'session/load'), false);
  });

  // And the Copilot binding itself, against the fake through COPILOT_BIN: its
  // descriptor's argv and client name go out, and no session/load ever does.
  const copilotTrace = join(cwd, 'trace-copilot.jsonl');
  await withEnv({ COPILOT_BIN: FAKE_BIN, ACP_FAKE_LOAD_SESSION: '1', ACP_FAKE_TRACE: copilotTrace }, async () => {
    const manager = managerFor(t, COPILOT);
    const server = new IpcServer(manager);
    const response = await server._dispatch({ command: 'prompt-bg', sessionId: 'fake-sess-old', cwd, text: 'again' });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.data.sessionReborn, true);
    const frames = readTrace(copilotTrace);
    assert.equal(frames.some((f) => f.method === 'session/load'), false);
    assert.equal(frames.find((f) => f.method === 'initialize').params.clientInfo.name, 'copilot-acp-daemon');
    assert.equal(frames[0].argv[0], '--acp');
    assert.ok(frames[0].argv.includes('--allow-all-tools'));
  });
});

test('a session/update kind the descriptor does not declare is logged once as drift and still parsed', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_UNKNOWN_UPDATE: '1' }, async () => {
    const manager = managerFor(t, FAKE);
    const sessionId = await manager.startSession(cwd);
    const state = await runPrompt(manager, sessionId, 'one');
    assert.equal(state.status, 'completed');
    await runPrompt(manager, sessionId, 'two');
    const logText = readFileSync(daemonLogFile('fake-acp'), 'utf8');
    const drift = logText.split('\n').filter((l) => /update kind .* not declared/.test(l));
    assert.equal(drift.filter((l) => l.includes('usage_update')).length, 1, 'once per kind, not per event');
    assert.equal(drift.filter((l) => l.includes("'notice'")).length, 1);
  });
});

test('session/cancel mid-turn settles the prompt cancelled', async (t) => {
  const cwd = tempCwd();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await withEnv({ FAKE_ACP_BIN: FAKE_BIN, ACP_FAKE_TURN_MS: '20000' }, async () => {
    const manager = managerFor(t, FAKE);
    const sessionId = await manager.startSession(cwd);
    const { promptId } = await manager.startPromptBg(sessionId, 'take your time');
    const state = manager.inFlightPrompts.get(promptId);
    await until(() => state.lastEventAt > state.startedAt || existsSync(state.eventsFile), { budgetMs: 2000 });
    const cancelled = manager.cancelPrompt(promptId);
    assert.equal(cancelled.cancelled, true);
    assert.ok(await until(() => state.status === 'cancelled', { budgetMs: 5000 }), `cancelled within budget (status ${state.status})`);
    assert.equal(readEvents(state.eventsFile).at(-1).type, 'cancelled');
  });
});
