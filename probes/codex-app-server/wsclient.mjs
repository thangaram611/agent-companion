// app-server JSON-RPC client over the ws:// transport.
//   node wsclient.mjs A <url> <cwd>       -> thread/start + turn/start, stream until killed
//   node wsclient.mjs B <url> <threadId>  -> thread/resume on a RUNNING thread, stream
//   node wsclient.mjs S <url> <threadId> <turnId> -> turn/steer into the running turn
//   node wsclient.mjs I <url> <threadId> <turnId> -> turn/interrupt
//   node wsclient.mjs R <url> <threadId>  -> thread/read (transcript salvage)
import { appendFileSync, writeFileSync } from 'node:fs';

const [, , role, url, arg3, arg4] = process.argv;
const logFile = `${process.cwd()}/${role}.log`;
writeFileSync(logFile, '');
const t0 = Date.now();
const log = (ev, obj = {}) => {
  const line = JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(2), role, pid: process.pid, ev, ...obj });
  appendFileSync(logFile, line + '\n');
  console.log(line);
};

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();
const send = (o) => ws.send(JSON.stringify(o));
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
    log('-->', { method, id, params: JSON.stringify(params || {}).slice(0, 200) });
  });
}

ws.addEventListener('error', (e) => log('ws_error', { err: String(e.message || e.type) }));
ws.addEventListener('close', (e) => log('ws_close', { code: e.code }));
ws.addEventListener('message', (ev) => {
  for (const line of String(ev.data).split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { log('unparsed', { line: line.slice(0, 200) }); continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); pending.delete(m.id);
      log('<==resp', { id: m.id, result: m.result === undefined ? null : JSON.stringify(m.result).slice(0, 500), error: m.error || null });
      if (p) (m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result));
    } else if (m.method) {
      log('<==note', { method: m.method, params: JSON.stringify(m.params || {}).slice(0, 400) });
      if (m.id !== undefined) { send({ jsonrpc: '2.0', id: m.id, result: { decision: 'approved' } }); log('-->auto_approve', { id: m.id }); }
    }
  }
});

const PROMPT_A = 'Run these shell commands one at a time, in order, waiting for each to finish: ' +
  '`sleep 12 && echo STEP1`, then `sleep 12 && echo STEP2`, then `sleep 12 && echo STEP3`. ' +
  'After all three have completed, reply with exactly the word FINISHED and nothing else.';

ws.addEventListener('open', () => { log('connected', { url }); main().catch((e) => log('FATAL', { err: e.message })); });

async function main() {
  const init = await call('initialize', { clientInfo: { name: `probe-${role}`, version: '1.0.0' } });
  log('init_ok', { init: JSON.stringify(init).slice(0, 300) });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  if (role === 'A') {
    const th = await call('thread/start', { cwd: arg3, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false });
    const threadId = th.threadId || th.thread?.id || th.id;
    log('THREAD', { threadId, raw: JSON.stringify(th).slice(0, 400) });
    console.error(`THREADID=${threadId}`);
    const turn = await call('turn/start', { threadId, input: [{ type: 'text', text: PROMPT_A }] });
    log('TURN_STARTED', { turn: JSON.stringify(turn).slice(0, 300) });
  } else if (role === 'B') {
    const r = await call('thread/resume', { threadId: arg3 });
    log('RESUMED', { result: JSON.stringify(r).slice(0, 800) });
  } else if (role === 'S') {
    const r = await call('turn/steer', { threadId: arg3, expectedTurnId: arg4, input: [{ type: 'text', text: 'CHANGE OF PLAN: stop the sleeps immediately and reply with exactly the word PINEAPPLE.' }] });
    log('STEERED', { result: JSON.stringify(r).slice(0, 400) });
  } else if (role === 'I') {
    const r = await call('turn/interrupt', { threadId: arg3, turnId: arg4 });
    log('INTERRUPTED', { result: JSON.stringify(r).slice(0, 400) });
  } else if (role === 'W') {
    // workspace-write + mid-flight steer during file mutation
    const th = await call('thread/start', { cwd: arg3, sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: false });
    const threadId = th.threadId || th.thread?.id;
    log('THREAD', { threadId, sandboxEcho: JSON.stringify(th.thread?.status) });
    const turn = await call('turn/start', {
      threadId,
      input: [{ type: 'text', text:
        'Do this exactly: create five files f1.txt f2.txt f3.txt f4.txt f5.txt in the current directory. ' +
        'Each must contain 300 identical lines reading "LINE". Create them ONE AT A TIME, and run `sleep 6` ' +
        'between each one. When all five exist, reply with exactly the word ALLDONE.' }],
    });
    const turnId = turn.turn?.id;
    log('TURN_STARTED', { turnId });
    setTimeout(async () => {
      try {
        const r = await call('turn/steer', { threadId, expectedTurnId: turnId,
          input: [{ type: 'text', text: 'CHANGE OF PLAN: stop creating files immediately. Do not create any more. Reply with exactly the word PINEAPPLE.' }] });
        log('STEERED_OK', { result: JSON.stringify(r).slice(0, 300) });
      } catch (e) { log('STEER_FAILED', { err: e.message }); }
    }, Number(arg4 || 25) * 1000);
  } else if (role === 'L') {
    const r = await call('thread/loaded/list', {});
    log('LOADED', { result: JSON.stringify(r).slice(0, 800) });
  } else if (role === 'R') {
    const r = await call('thread/read', { threadId: arg3, includeTurns: true });
    log('THREAD_READ', { bytes: JSON.stringify(r).length });
    writeFileSync(`${process.cwd()}/thread-read.json`, JSON.stringify(r, null, 1));
  }
}

setTimeout(() => { log('client_timeout_exit'); process.exit(0); }, 240000);
