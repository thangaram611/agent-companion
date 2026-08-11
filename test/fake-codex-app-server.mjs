// The fake `codex app-server`, shared by both halves of the codex app-server
// work: scripts/codex-app-server-broker.test.mjs (the server side of the wire
// protocol) and bridge-server/codex-app-server-runtime.test.mjs (the client
// side). It is a fixture, not a test — `node --test` only collects `*.test.mjs`.
//
// It lives here rather than in either suite because the two suites must agree on
// what the app-server does, and that is exactly the agreement a second copy
// would quietly break: the end-to-end test whose whole purpose is "the adapter
// and the broker really do talk to each other" would be running against an
// app-server the broker's own tests never saw.
//
// Driven through `CODEX_BIN`, the idiom already in bridge-server/codex-runtime.test.mjs.
// It never runs a model and never spends a token; a test orders it around with
// three `fake/*` methods that the broker forwards like any other unknown method.
//
// IT VALIDATES EVERY CLIENT REQUEST AGAINST THE PINNED CONTRACT first, exactly
// as the real app-server does — deserialization refuses a call that omits a
// required field before any thread lookup happens. Answering anyway is how the
// missing `expectedTurnId` / `turnId` survived three reviews: this fake and its
// sibling were the only things standing between the adapter and a -32600 no
// operator would ever see, and they answered whatever they were asked.
//
// `contractViolation` is IMPORTED, not reimplemented: the fake is materialised
// into a temp dir, so `fakeCodexBin` bakes in a file:// import of the real
// module. A second copy of the rule could disagree with the fixture, which is
// the failure mode the fixture exists to prevent.

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACT_MODULE_URL = pathToFileURL(
  join(fileURLToPath(new URL('../lib/', import.meta.url)), 'codex-app-server-contract.mjs'),
).href;

export const FAKE_APP_SERVER = `
import { appendFileSync } from 'node:fs';
import { contractViolation } from ${JSON.stringify(CONTRACT_MODULE_URL)};

const TRACE = process.env.CODEX_FAKE_TRACE || '';
const VERSION = process.env.CODEX_FAKE_VERSION || '0.147.0';
const INIT_DELAY_MS = Number(process.env.CODEX_FAKE_INIT_DELAY_MS || 0);

if (process.argv[2] === '--version') {
  // CODEX_FAKE_VERSION_FAIL reproduces the wrapper/timeout case: the probe
  // finishes, but no version is ever learned.
  if (process.env.CODEX_FAKE_VERSION_FAIL) {
    process.stderr.write('codex: not today\\n');
    process.exit(3);
  }
  process.stdout.write('codex-cli ' + VERSION + '\\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('fake codex: unsupported argv\\n');
  process.exit(2);
}

let loaded = [];
let threadSeq = 0;
let turnSeq = 0;
const statuses = new Map();     // threadId -> ThreadStatus, set by fake/setStatus
const transcripts = new Map();  // threadId -> items[], set by fake/setTranscript
const turns = new Map();        // threadId -> Turn[], set by fake/setTurns
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const trace = (obj) => { if (TRACE) { try { appendFileSync(TRACE, JSON.stringify(obj) + '\\n'); } catch {} } };

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

function handle(msg) {
  trace(msg);
  if (typeof msg.method !== 'string') return; // a client answering a server request
  const reply = (result) => { if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, result }); };
  // Deserialization first, like the real server: a missing required field is
  // answered -32600 before the method's own logic runs. \`fake/*\` and anything
  // else outside the client-request union carries no contract and passes.
  const violation = contractViolation(msg.method, msg.params);
  if (violation) { if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: violation }); return; }
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      if (INIT_DELAY_MS > 0) setTimeout(() => reply({ userAgent: 'fake-app-server' }), INIT_DELAY_MS);
      else reply({ userAgent: 'fake-app-server' });
      return;
    case 'initialized': return;
    case 'fake/emit': {
      const frames = p.frames || [];
      for (const frame of frames) out(frame);
      reply({ ok: true, emitted: frames.length });
      return;
    }
    case 'fake/setLoaded': loaded = p.ids || []; reply({ ok: true }); return;
    case 'fake/setStatus': statuses.set(p.threadId, p.status); reply({ ok: true }); return;
    case 'fake/setTranscript': transcripts.set(p.threadId, p.items || []); reply({ ok: true }); return;
    case 'fake/setTurns': turns.set(p.threadId, p.turns || []); reply({ ok: true }); return;
    case 'fake/die': process.exit(p.code || 7); return;
    case 'thread/loaded/list': reply({ data: loaded }); return;
    case 'thread/start': {
      const id = p.threadId || 'T' + (++threadSeq);
      loaded.push(id);
      reply({ thread: { id, path: '/fake/rollout-' + id + '.jsonl', turns: [] } });
      return;
    }
    case 'thread/resume': {
      const id = p.threadId;
      if (!loaded.includes(id)) loaded.push(id);
      reply({ thread: { id, status: statuses.get(id) || { type: 'idle' }, turns: turns.get(id) || [] } });
      return;
    }
    // \`turns\` lives on the THREAD, as the real ThreadReadResponse declares.
    // A test that sets no turns still gets its transcript, in one turn.
    case 'thread/read':
      reply({ thread: {
        id: p.threadId,
        turns: turns.get(p.threadId) || [{ id: 'TURN' + turnSeq, status: 'completed', items: transcripts.get(p.threadId) || [] }],
      } });
      return;
    case 'turn/start':
      reply({ turn: { id: 'TURN' + (++turnSeq) } });
      return;
    // Echoes the steered turn, and stops there: unlike the socket fake, this
    // one's event stream is script-driven through \`fake/emit\`, so announcing
    // the injected userMessage here would fight the scripts. A test that wants
    // to exercise steer CONFIRMATION emits the \`item/completed\` itself.
    case 'turn/steer': reply({ turn: { id: p.expectedTurnId } }); return;
    case 'turn/interrupt': reply({}); return;
    default: reply({ echo: msg.method }); return;
  }
}
`;

// Materialise the fake as an executable `codex` stand-in. The shebang is what
// lets it be spawned by path, exactly as a real binary would be.
export function fakeCodexBin(dir, name = 'codex-fake.mjs') {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env node\n${FAKE_APP_SERVER}`, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return bin;
}
