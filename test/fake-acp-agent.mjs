// The fake ACP agent, shared by both halves of the generic ACP transport:
// scripts/acp-daemon.test.mjs (the daemon side — spawn, handshake, prompt,
// permission, load, cancel) and bridge-server/server.test.mjs (the bridge side,
// through a real detached daemon). It is a fixture, not a test — `node --test`
// only collects `*.test.mjs`.
//
// It lives here for the reason test/fake-codex-app-server.mjs does: the two
// suites must agree on what an ACP agent does, and a second copy is how they
// would quietly stop agreeing.
//
// Driven through a companion's `binaryEnv` (`FAKE_ACP_BIN` for its own
// descriptor, `COPILOT_BIN` for Copilot's, `ANTIGRAVITY_ACP_BIN` for
// Antigravity's), the
// idiom bridge-server/codex-runtime.test.mjs uses for its fake codex. It never
// runs a model and never spends a token. Everything it does is scripted from
// its environment, so a test orders it around before the spawn:
//
//   ACP_FAKE_PROTOCOL_VERSION  the protocolVersion it answers on `initialize` (1)
//   ACP_FAKE_LOAD_SESSION      '1' → advertises and implements `session/load`
//   ACP_FAKE_LOAD_FAIL         '1' → `session/load` answers -32602 (unknown id)
//   ACP_FAKE_ASK_PERMISSION    '1' → each prompt first asks
//                              `session/request_permission` and records the answer
//   ACP_FAKE_PERMISSION_KIND   the tool kind it asks about (`execute`)
//   ACP_FAKE_ASK_FS            '1' → each prompt first asks `fs/read_text_file`,
//                              a capability the daemon does not declare
//   ACP_FAKE_UNKNOWN_UPDATE    '1' → also emits `usage_update` and `notice`, two
//                              v1 kinds no descriptor here declares
//   ACP_FAKE_USAGE             `quota` (Gemini's `_meta.quota`, the default),
//                              `standard` (the unstable `usage` field) or `none`
//   ACP_FAKE_TEXT              the reply text (`ready`)
//   ACP_FAKE_TURN_MS           how long the turn runs before answering (0); a
//                              prompt containing `sleep:<ms>` overrides it
//   ACP_FAKE_TRACE             a file every inbound frame and every answered
//                              permission is appended to, as JSON lines
//
// Shapes follow the ACP v1 schema (agentclientprotocol/agent-client-protocol,
// `agent-client-protocol-schema/src/v1`) and what two agents were measured to
// send on 2026-09-11 — Gemini CLI 0.59.0 (`_meta.quota.token_count` on the
// prompt response, `-32601 "Method not found"` for an unknown notification on
// stderr, a `cancelled` stop reason when `session/cancel` lands mid-turn) and
// Google's agy_acp_server 1.1.1 (`session/set_config_option` for the model,
// `-32602` naming the available ids for an unknown one, and a loaded session
// that comes back on the default model).
//
// `fakeAcpDescriptor` below is the fake's own companion descriptor, the
// neutral descriptor the suites drive the generic daemon with; Antigravity's
// real descriptor is driven through the same fake via `ANTIGRAVITY_ACP_BIN`.
// It carries an `acp` block exactly as a real descriptor in
// lib/target-registry.mjs does, so a suite that passes against it is a suite
// the next real companion inherits.

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeUsage } from '../lib/usage.mjs';

const FAKE_UPDATES = ['agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'user_message_chunk'];

// The prompt response's tokens, as a descriptor would read them: the protocol's
// own (unstable) `usage` field first, else the `_meta.quota.token_count` shape
// Gemini CLI 0.59.0 answers, naming the model when one served the turn.
function fakeAcpUsage({ result }) {
  const std = result?.usage;
  if (std && (std.input_tokens != null || std.output_tokens != null)) {
    return makeUsage({ source: 'fake-acp', input: std.input_tokens, output: std.output_tokens, cached: std.cached_read_tokens, cacheWrite: std.cached_write_tokens, reasoning: std.thought_tokens, total: std.total_tokens });
  }
  const quota = result?._meta?.quota;
  const tokens = quota?.token_count;
  if (!tokens) return null;
  const models = new Set((quota.model_usage || []).map((m) => m?.model).filter(Boolean));
  return makeUsage({ source: 'fake-acp', input: tokens.input_tokens, output: tokens.output_tokens, model: models.size === 1 ? [...models][0] : null });
}

export function fakeAcpDescriptor({ id = 'fake-acp', loadSession = true, updates = FAKE_UPDATES } = {}) {
  return {
    id,
    displayName: 'Fake ACP agent',
    implemented: true,
    capabilities: { send: true, wait: true, status: true, cancel: true, reply: true, resume: true, jsonEvents: true, acp: true, serverMode: false, parallel: 'planned', modelSelection: true },
    binaryEnv: 'FAKE_ACP_BIN',
    binaryNames: ['fake-acp-agent'],
    versionArgs: ['--version'],
    acp: {
      clientName: 'agent-companion',
      args: ({ model }) => ['--acp', ...(model ? ['--model', model] : [])],
      env: () => ({}),
      rotate: [],
      defaultModel: () => null,
      loadSession,
      // `FAKE_ACP_POLICY` = all | edit | none, read at answer time like a real
      // descriptor reads its own knob.
      permission: (env) => env.FAKE_ACP_POLICY || 'all',
      usage: fakeAcpUsage,
      updates,
      rubberDuck: false,
    },
  };
}

export const FAKE_ACP_AGENT = `
import { appendFileSync } from 'node:fs';

const env = process.env;
const TRACE = env.ACP_FAKE_TRACE || '';
const trace = (obj) => { if (TRACE) { try { appendFileSync(TRACE, JSON.stringify(obj) + '\\n'); } catch {} } };

if (process.argv.includes('--version')) {
  process.stdout.write('fake-acp-agent 1.0.0\\n');
  process.exit(0);
}
// Copilot and Gemini are launched with --acp; Antigravity's server is launched
// bare (--uid= on linux, as the registry entry says). Any other argv is a
// wrong spawn and exits loudly. (No backticks here: this is inside a template.)
const spawnFlags = process.argv.slice(2);
if (spawnFlags.length && !spawnFlags.includes('--acp') && !spawnFlags.every((f) => f.startsWith('--uid='))) {
  process.stderr.write('fake acp agent: unexpected argv ' + JSON.stringify(spawnFlags) + '\\n');
  process.exit(2);
}
trace({ argv: process.argv.slice(2) });

const PROTOCOL_VERSION = Number(env.ACP_FAKE_PROTOCOL_VERSION || 1);
const LOAD_SESSION = env.ACP_FAKE_LOAD_SESSION === '1';

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const text = (t) => ({ type: 'text', text: t });
const update = (sessionId, u) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const modes = () => ({ availableModes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'YOLO' }], currentModeId: env.ACP_FAKE_MODE || 'default' });

let sessionSeq = 0;
const sessions = new Map();   // sessionId -> { cwd, prompts, loaded }
let outSeq = 0;
const pendingClient = new Map(); // agent -> client request id -> resolve
const ask = (method, params) => new Promise((resolve) => {
  const id = 'fake-' + (++outSeq);
  pendingClient.set(id, resolve);
  out({ jsonrpc: '2.0', id, method, params });
});
const running = new Map();    // sessionId -> { cancel }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(msg) {
  trace(msg);
  // The client answering one of OUR requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pendingClient.get(msg.id);
    if (resolve) { pendingClient.delete(msg.id); resolve(msg); }
    return;
  }
  const reply = (result) => { if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, result }); };
  const fail = (code, message) => {
    if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    else process.stderr.write('Error handling notification ' + msg.method + ' { code: ' + code + ", message: '" + message + "' }\\n");
  };
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake-acp-agent', title: 'Fake ACP agent', version: '1.0.0' },
        agentCapabilities: { loadSession: LOAD_SESSION, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      });
      return;
    case 'session/new': {
      const sessionId = 'fake-sess-' + (++sessionSeq);
      sessions.set(sessionId, { cwd: p.cwd, prompts: 0, loaded: false });
      reply({ sessionId, modes: modes() });
      return;
    }
    case 'session/load': {
      if (!LOAD_SESSION) { fail(-32601, '"Method not found": session/load'); return; }
      if (env.ACP_FAKE_LOAD_FAIL === '1' || !p.sessionId) { fail(-32602, 'Session not found: ' + p.sessionId); return; }
      // A loaded session comes back on the default model (Antigravity, measured).
      sessions.set(p.sessionId, { cwd: p.cwd, prompts: 0, loaded: true, model: null });
      // History replay, as the spec requires BEFORE the response: the client
      // must not mistake it for a live turn.
      out(update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: text('earlier question') }));
      out(update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('earlier answer') }));
      reply({ modes: modes() });
      return;
    }
    case 'session/prompt':
      runPrompt(msg);
      return;
    case 'session/cancel': {
      const turn = running.get(p.sessionId);
      if (turn) turn.cancel();
      else process.stderr.write('Error handling notification session/cancel Not currently generating\\n');
      return;
    }
    case 'session/set_mode':
      reply({});
      return;
    // The model as a session config option (Antigravity's shape): the answer
    // echoes the option with its new current value; an id the agent does not
    // have is -32602 naming the ones it does.
    case 'session/set_config_option': {
      if (p.configId !== 'model') { fail(-32602, 'Unknown config option: ' + p.configId); return; }
      const session = sessions.get(p.sessionId);
      if (!session) { fail(-32602, 'Session not found: ' + p.sessionId); return; }
      if (String(p.value).startsWith('not-a-model')) {
        out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: "Model '" + p.value + "' is not available for the current authentication method.", data: { modelId: p.value, availableModels: ['fake-model-a', 'fake-model-b'] } } });
        return;
      }
      session.model = p.value;
      reply({ configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: p.value, options: [{ value: p.value, name: p.value }] }] });
      return;
    }
    default:
      fail(-32601, '"Method not found": ' + msg.method);
  }
}

async function runPrompt(msg) {
  const p = msg.params || {};
  const sessionId = p.sessionId;
  const session = sessions.get(sessionId);
  const done = (result) => { running.delete(sessionId); out({ jsonrpc: '2.0', id: msg.id, result }); };
  if (!session) { out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Session not found: ' + sessionId } }); return; }
  if (running.has(sessionId)) { out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'a prompt is already running on ' + sessionId } }); return; }
  const promptText = (p.prompt || []).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('');
  let cancelled = false;
  let wake = null;
  running.set(sessionId, { cancel: () => { cancelled = true; if (wake) wake(); } });
  const waitMs = async (ms) => {
    if (ms <= 0) return;
    await new Promise((r) => { wake = r; setTimeout(r, ms); });
    wake = null;
  };
  session.prompts += 1;

  out(update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: text('thinking') }));
  if (env.ACP_FAKE_UNKNOWN_UPDATE === '1') {
    out(update(sessionId, { sessionUpdate: 'usage_update', used: 10, size: 1000 }));
    out(update(sessionId, { sessionUpdate: 'notice', text: 'fyi' }));
  }
  if (env.ACP_FAKE_ASK_FS === '1') {
    const answer = await ask('fs/read_text_file', { sessionId, path: session.cwd + '/README.md' });
    trace({ fsAnswer: answer.result ?? answer.error });
  }
  if (env.ACP_FAKE_ASK_PERMISSION === '1') {
    const kind = env.ACP_FAKE_PERMISSION_KIND || 'execute';
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-perm-1', title: 'run \`ls\`', kind, status: 'pending', rawInput: { command: 'ls' } },
      options: [
        { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    });
    trace({ permissionAnswer: answer.result ?? answer.error });
    const outcome = answer.result?.outcome;
    const allowed = outcome?.outcome === 'selected' && String(outcome.optionId).startsWith('proceed');
    out(update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-perm-1', title: 'run \`ls\`', kind, status: 'in_progress', rawInput: { command: 'ls' } }));
    out(update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 'call-perm-1',
      status: allowed ? 'completed' : 'failed',
      rawOutput: allowed ? 'README.md' : { message: 'Tool "ls" was canceled by the user.' },
    }));
  }
  out(update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read README.md', kind: 'read', status: 'in_progress', locations: [{ path: session.cwd + '/README.md' }], rawInput: { path: 'README.md' } }));
  out(update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: 'The magic word is BANANA.' }));

  const delay = Number((/sleep:(\\d+)/.exec(promptText) || [])[1] || env.ACP_FAKE_TURN_MS || 0);
  await waitMs(delay);
  if (cancelled) { done({ stopReason: 'cancelled' }); return; }

  const reply = promptText.startsWith('CONTINUATION') ? 'continued' : (env.ACP_FAKE_TEXT || 'ready');
  out(update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text(reply) }));
  const result = { stopReason: 'end_turn' };
  const usageMode = env.ACP_FAKE_USAGE || 'quota';
  if (usageMode === 'quota') {
    result._meta = { quota: {
      token_count: { input_tokens: 1234, output_tokens: 56 },
      model_usage: [{ model: 'gemini-2.5-pro', token_count: { input_tokens: 1234, output_tokens: 56 } }],
    } };
  } else if (usageMode === 'standard') {
    result.usage = { total_tokens: 1300, input_tokens: 1234, output_tokens: 56, thought_tokens: 10, cached_read_tokens: 100 };
  }
  done(result);
}
`;

// Materialise the fake as an executable stand-in for a companion binary. The
// interpreter is this very node, by absolute path, so a suite that narrows
// PATH still spawns it.
export function fakeAcpAgentBin(dir, name = 'acp-agent-fake.mjs') {
  const bin = join(dir, name);
  writeFileSync(bin, `#!${process.execPath}\n${FAKE_ACP_AGENT}`, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return bin;
}
