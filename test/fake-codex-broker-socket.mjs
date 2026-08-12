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
//
// EVERY INBOUND CALL IS VALIDATED AGAINST THE PINNED CONTRACT before a handler
// sees it. A fake that answers what the real server rejects is worse than no
// fake — it converts a protocol violation into a green test, which is exactly
// how `turn/steer` without `expectedTurnId` and `turn/interrupt` without
// `turnId` passed three rounds of review and failed on every real job. A
// handler override cannot opt out: the check runs first, and a test that wants
// to model an error answers with `__error` instead.
//
// AND NOTHING UNIMPLEMENTED IS ANSWERED WITH A SUCCESS. A method with no
// override and no default is refused (`unhandledMethodError`), because the
// blanket `{echo: method}` this used to fall back on made every typo, every
// codex rename and every unmodelled adapter call return `ok` from a fake while
// the real server refused or handled it — the same green-test trade, one field
// over.

import { EventEmitter } from 'node:events';

import { contractViolation, unhandledMethodError } from '../lib/codex-app-server-contract.mjs';
import { note, threadItem } from './codex-wire-frames.mjs';

// The pid the fake broker claims as its own. `disposeBroker` only signals a pid
// the LIVE broker claims, so a registry entry that expects to be disposed has
// to carry this one.
export const FAKE_BROKER_PID = 4242;
export const FAKE_APP_SERVER_PID = 4243;

export function fakeBrokerSocket({
  handlers = {},
  statuses = {},
  // threadId -> the turns `thread/resume` and `thread/read` report, newest
  // last. The real `Thread` carries them on BOTH responses (the schema: "Only
  // populated on `thread/resume`, `thread/rollback`, `thread/fork`, and
  // `thread/read` (when `includeTurns` is true)"), and the running turn reads
  // `{id, status:'inProgress'}` — which is where a bridge that never saw
  // `turn/started` gets the id `turn/interrupt` and `turn/steer` require.
  turns = {},
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
  // one after routing it. BUILT from the pinned contract (test/codex-wire-frames)
  // rather than assembled here: this one line was how `{chunk}` for `{delta}` and
  // `error {message}` got onto the wire in three suites at once, each with a
  // green assertion on the read that matched the invention.
  sock.notify = (method, params = {}) => sock.deliver(note(method, { threadId, ...params }));

  let steerSeq = 0;
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
    // No `broker/unsubscribe` default: the adapter has no wrapper for it and no
    // bridge puts it on the wire, so a default here would answer a call this
    // fake's client cannot make. The broker's own handler still exists and is
    // exercised by the broker's suite against the real Broker.
    'thread/start': () => ({ thread: { id: threadId, path: `/fake/rollout-${threadId}.jsonl`, turns: [] } }),
    'thread/resume': (p) => ({
      thread: { id: p.threadId, status: { type: statuses[p.threadId] || 'idle' }, turns: turns[p.threadId] || [] },
    }),
    // `turns` hangs off the THREAD, not off the response — the shape the real
    // ThreadReadResponse declares (`{thread: {…, turns: […]}}`).
    'thread/read': (p) => ({ thread: { id: p.threadId, turns: turns[p.threadId] || [] } }),
    'thread/loaded/list': () => ({ data: [] }),
    'turn/start': () => ({ turn: { id: 'TURN1' } }),
    // `TurnSteerResponse` is `{turnId}` — measured from the schema, and NOT the
    // `{turn:{id}}` this used to return, which is `turn/start`'s shape. The
    // comment that used to sit here said a `{}` answer "would let a caller that
    // reads the echo pass against a fake and read undefined against codex", and
    // that is exactly what the wrong echo did, one field over.
    //
    // And it ANNOUNCES the injection: the steered input arrives in the turn as
    // an `item/completed` whose item is a `userMessage` (measured 0.14 s after
    // the RPC against an in-flight apply_patch). A fake that only answered the
    // call would let "the RPC returned" stand in for "the model got it" — the
    // conflation the confirmation exists to break. `setTimeout(0)`, not a
    // microtask, so it lands AFTER the response, which is the order the broker
    // writes them in. A test that wants the other measured case — a model
    // mid-reasoning, injection minutes away — overrides this handler.
    'turn/steer': (p) => {
      setTimeout(() => sock.deliver(note('item/completed', {
        threadId: p.threadId,
        item: threadItem('userMessage', { id: `steer-${++steerSeq}`, content: p.input || [] }),
      })), 0);
      return { turnId: p.expectedTurnId };
    },
    'turn/interrupt': () => ({}),
  };

  sock.write = (text) => {
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      sock.frames.push(msg);
      if (typeof msg.method === 'string') sock.calls.push(msg);
      if (msg.id === undefined || typeof msg.method !== 'string') continue;
      // The contract check runs BEFORE the handler, and ahead of any override,
      // because that is the order the real server applies it: deserialization
      // refuses a call that omits a required field before it looks at the
      // thread, the turn or anything else. `broker/*` methods are the broker's
      // own and carry no client-request contract, so they pass through.
      const violation = contractViolation(msg.method, msg.params);
      if (violation) { sock.deliver({ jsonrpc: '2.0', id: msg.id, error: violation }); continue; }
      // A method with neither an override nor a default is REFUSED, not echoed
      // back as a success. The old `{echo: msg.method}` fallback answered
      // anything — a typo, a method renamed by a codex bump, an adapter call
      // this fake never modelled — which is the same "green test, red server"
      // trade the contract check above exists to end. A test that means to model
      // one passes it in `handlers`.
      const handler = handlers[msg.method] || defaults[msg.method];
      if (!handler) { sock.deliver({ jsonrpc: '2.0', id: msg.id, error: unhandledMethodError(msg.method) }); continue; }
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
