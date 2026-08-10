// Versatile app-server probe client.
//   node probe.mjs <scenario> <url> [args...]
// Scenarios: approval | steerpatch | inherit | sandbox | errors | nolisten
import { appendFileSync, writeFileSync } from 'node:fs';

const [, , scenario, url, ...rest] = process.argv;
const logFile = `${process.cwd()}/probe-${scenario}.log`;
writeFileSync(logFile, '');
const t0 = Date.now();
const log = (ev, obj = {}) => {
  const line = JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(2), ev, ...obj });
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
    log('-->', { method, id, params: JSON.stringify(params || {}).slice(0, 260) });
  });
}

// Server->client REQUESTS land here. This is the approval surface.
const serverRequests = [];
let approvalMode = rest.includes('--deny') ? 'deny' : 'approve';

ws.addEventListener('error', (e) => log('ws_error', { err: String(e.message || e.type) }));
ws.addEventListener('close', (e) => log('ws_close', { code: e.code }));
ws.addEventListener('message', (ev) => {
  for (const line of String(ev.data).split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); pending.delete(m.id);
      log('<==resp', { id: m.id, result: m.result === undefined ? null : JSON.stringify(m.result).slice(0, 600), error: m.error || null });
      if (p) (m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result));
      continue;
    }
    if (m.method && m.id !== undefined) {
      // SERVER REQUEST — record the FULL shape verbatim; this is what the adapter must implement.
      serverRequests.push({ method: m.method, params: m.params });
      log('<==SERVER_REQUEST', { method: m.method, full: JSON.stringify(m.params) });
      // Decision vocabulary is PER-METHOD. The new item/* methods take
      // accept|acceptForSession|decline|cancel; the legacy execCommandApproval /
      // applyPatchApproval take the ReviewDecision vocabulary (approved|denied|abort).
      const legacy = m.method === 'execCommandApproval' || m.method === 'applyPatchApproval';
      const reply = legacy
        ? { decision: approvalMode === 'deny' ? 'denied' : 'approved' }
        : { decision: approvalMode === 'deny' ? 'decline' : 'accept' };
      send({ jsonrpc: '2.0', id: m.id, result: reply });
      log('-->approval_reply', { id: m.id, reply: JSON.stringify(reply) });
      continue;
    }
    if (m.method) {
      const skip = /Delta$|tokenUsage|rateLimits/.test(m.method);
      if (!skip) log('<==note', { method: m.method, params: JSON.stringify(m.params || {}).slice(0, 420) });
    }
  }
});

const done = (code) => { log('SERVER_REQUEST_COUNT', { n: serverRequests.length, methods: [...new Set(serverRequests.map((s) => s.method))] }); setTimeout(() => process.exit(code), 300); };

ws.addEventListener('open', () => { log('connected'); main().catch((e) => { log('FATAL', { err: e.message }); done(1); }); });

function waitFor(pred, ms = 200000) {
  return new Promise((res, rej) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(true); }
      else if (Date.now() - started > ms) { clearInterval(iv); rej(new Error('timeout waiting')); }
    }, 200);
  });
}
let turnDone = false, lastAnswer = null, lastTurnStatus = null;
const hook = (m) => {};
ws.addEventListener('message', (ev) => {
  for (const line of String(ev.data).split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'turn/completed') { turnDone = true; lastTurnStatus = m.params?.turn?.status;
      const items = m.params?.turn?.items || [];
      const fin = items.filter((i) => i.type === 'agentMessage').pop();
      lastAnswer = fin?.text ?? null; }
    if (m.method === 'turn/failed') { turnDone = true; lastTurnStatus = 'failed'; }
  }
});

async function main() {
  await call('initialize', { clientInfo: { name: 'probe', version: '1.0.0' } });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });

  if (scenario === 'approval') {
    const [cwd, policy, sandbox] = rest;
    const th = await call('thread/start', { cwd, sandbox, approvalPolicy: policy, ephemeral: false });
    const threadId = th.thread.id;
    log('THREAD', { threadId, policy, sandbox, cwd });
    await call('turn/start', { threadId, input: [{ type: 'text', text:
      'Create a file called approved.txt containing the single word OK in the current directory, then reply with exactly DONE.' }] });
    await waitFor(() => turnDone, 240000).catch(() => log('turn_timeout'));
    log('OUTCOME', { status: lastTurnStatus, answer: lastAnswer });
    done(0);
  } else if (scenario === 'inherit') {
    const [cwd] = rest;
    const th = await call('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false });
    log('THREAD_FULL', { thread: JSON.stringify(th.thread).slice(0, 1500) });
    await call('turn/start', { threadId: th.thread.id, input: [{ type: 'text', text: 'Reply with exactly OK.' }] });
    await waitFor(() => turnDone, 180000).catch(() => log('turn_timeout'));
    log('OUTCOME', { status: lastTurnStatus, answer: lastAnswer, rolloutPath: th.thread.path });
    done(0);
  } else if (scenario === 'sandbox') {
    const [cwd, sandbox] = rest;
    const th = await call('thread/start', { cwd, sandbox, approvalPolicy: 'never', ephemeral: false });
    log('THREAD', { threadId: th.thread.id, sandbox });
    await call('turn/start', { threadId: th.thread.id, input: [{ type: 'text', text:
      'Try to write the word X into a file named probe-write.txt in the current directory, and ALSO try to write into .git/probe-git.txt . ' +
      'Then reply with exactly two lines: "cwd=<ok|blocked>" and "git=<ok|blocked>".' }] });
    await waitFor(() => turnDone, 240000).catch(() => log('turn_timeout'));
    log('OUTCOME', { status: lastTurnStatus, answer: lastAnswer });
    done(0);
  } else if (scenario === 'steerpatch') {
    const [cwd] = rest;
    const th = await call('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: false });
    const threadId = th.thread.id;
    const turn = await call('turn/start', { threadId, input: [{ type: 'text', text:
      'Use your apply_patch tool (not shell redirection) to create TEN files p01.txt .. p10.txt, each containing 400 lines reading "PAD". ' +
      'Create them one apply_patch call at a time. When all ten exist reply ALLDONE.' }] });
    const turnId = turn.turn.id;
    log('TURN', { turnId });
    // Steer as soon as the FIRST patch item starts — that is mid-mutation.
    let steered = false;
    ws.addEventListener('message', async (ev) => {
      if (steered) return;
      for (const line of String(ev.data).split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        const it = m?.params?.item;
        if (m.method === 'item/started' && it && /patch|fileChange|file_change/i.test(it.type || '')) {
          steered = true;
          log('STEER_TRIGGER', { itemType: it.type, itemId: it.id });
          try { const r = await call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text:
            'STOP. Do not create any more files. Reply with exactly PINEAPPLE.' }] });
            log('STEER_OK', { r: JSON.stringify(r) }); } catch (e) { log('STEER_ERR', { err: e.message }); }
        }
      }
    });
    await waitFor(() => turnDone, 300000).catch(() => log('turn_timeout'));
    log('OUTCOME', { status: lastTurnStatus, answer: lastAnswer, steered });
    done(0);
  } else if (scenario === 'errors') {
    // Error semantics the adapter must handle.
    const [cwd] = rest;
    for (const [name, method, params] of [
      ['unknown thread read', 'thread/read', { threadId: '00000000-0000-0000-0000-000000000000', includeTurns: true }],
      ['unknown thread resume', 'thread/resume', { threadId: '00000000-0000-0000-0000-000000000000' }],
      ['interrupt unknown turn', 'turn/interrupt', { threadId: '00000000-0000-0000-0000-000000000000', turnId: '11111111-1111-1111-1111-111111111111' }],
      ['loaded list', 'thread/loaded/list', {}],
      ['model list', 'model/list', {}],
    ]) {
      try { const r = await call(method, params); log('OK', { name, result: JSON.stringify(r).slice(0, 400) }); }
      catch (e) { log('ERR', { name, err: e.message.slice(0, 400) }); }
    }
    // steer with a stale expectedTurnId on a real idle thread
    const th = await call('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never' });
    try { await call('turn/steer', { threadId: th.thread.id, expectedTurnId: 'deadbeef-0000-0000-0000-000000000000', input: [{ type: 'text', text: 'x' }] }); log('OK', { name: 'steer stale turnId' }); }
    catch (e) { log('ERR', { name: 'steer stale turnId', err: e.message.slice(0, 400) }); }
    // double turn/start on the same thread
    await call('turn/start', { threadId: th.thread.id, input: [{ type: 'text', text: 'Run `sleep 25` then reply A.' }] });
    await new Promise((r) => setTimeout(r, 3000));
    try { const r2 = await call('turn/start', { threadId: th.thread.id, input: [{ type: 'text', text: 'Reply B.' }] }); log('OK', { name: 'concurrent turn/start', result: JSON.stringify(r2).slice(0, 300) }); }
    catch (e) { log('ERR', { name: 'concurrent turn/start', err: e.message.slice(0, 400) }); }
    done(0);
  } else { log('unknown scenario'); done(1); }
}

setTimeout(() => { log('hard_timeout'); done(2); }, 330000);
