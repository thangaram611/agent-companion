// The fake BROKER end of the codex app-server socket, shared by the two suites
// that need one: bridge-server/codex-app-server-runtime.test.mjs (which proves
// the adapter's own guards) and bridge-server/server.test.mjs (which proves the
// bridge is wired to those guards).
//
// It lives here for the same reason test/fake-codex-app-server.mjs does: the
// two suites must agree on what the broker does, and that agreement is exactly
// what a second copy would quietly break — a bridge test could then pass
// against a broker the adapter's own tests never saw.
//
// This is the wire, not the app-server: it speaks the same newline-delimited
// JSON the real broker speaks, records every frame the adapter wrote, and lets
// a test push notifications back. Handed to the real `createConnection` through
// the adapter's `_impl.connect` seam, so the framing, the id map, the ownership
// tracking and the guards under test are all shipped code.
//
// It never spawns anything and never spends a token. Tests that want the REAL
// broker process use test/fake-codex-app-server.mjs through `CODEX_BIN` instead.

import { EventEmitter } from 'node:events';

// The pid the fake broker claims as its own. `disposeBroker` only signals a pid
// the LIVE broker claims, so a registry entry that expects to be disposed has
// to carry this one.
export const FAKE_BROKER_PID = 4242;
export const FAKE_APP_SERVER_PID = 4243;

export function fakeBrokerSocket({
  handlers = {},
  statuses = {},
  brokerPid = FAKE_BROKER_PID,
  threadId = 'T1',
} = {}) {
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
  // Push a thread-scoped app-server notification, the way the broker forwards
  // one after routing it. Sugar over `deliver` because bridge tests write many.
  sock.notify = (method, params = {}) => sock.deliver({ jsonrpc: '2.0', method, params: { threadId, ...params } });

  const defaults = {
    initialize: () => ({
      brokered: true,
      protocol: 1,
      brokerPid,
      appServerPid: FAKE_APP_SERVER_PID,
      appServerInitialized: true,
      codexVersion: '0.147.0',
      codexVersionProbed: true,
    }),
    'broker/status': () => ({ ok: true, protocol: 1, brokerPid, appServerPid: FAKE_APP_SERVER_PID, uptimeMs: 1, clients: 1, subscriptions: 0 }),
    'broker/subscribe': (p) => ({ ok: true, threadId: p.threadId, flushed: 0 }),
    'broker/unsubscribe': (p) => ({ ok: true, threadId: p.threadId }),
    'thread/start': () => ({ thread: { id: threadId, path: `/fake/rollout-${threadId}.jsonl` } }),
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
