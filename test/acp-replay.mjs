import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Method/order replay, with separate id spaces in each JSON-RPC direction.
// No clocks, filesystem effects, model work, or argument-dependent branching.
export async function replayAcp(path) {
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  if (header.fixture !== 'acp-replay' || rows.some(row => !['client', 'agent'].includes(row.dir) || !row.frame)) {
    throw new Error('Invalid ACP replay fixture');
  }
  let cursor = 0, stopped = false, agentSeq = 0;
  const clientIds = new Map(), agentIds = new Map(), sessions = new Map();
  const out = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  const rewrite = (value, live) => {
    if (Array.isArray(value)) return value.map((item, i) => rewrite(item, live?.[i]));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== 'sessionId') return [key, rewrite(item, live?.[key])];
      if (!sessions.has(item)) sessions.set(item, live?.[key] ?? `replay-session-${sessions.size + 1}`);
      if (live?.[key] !== undefined && sessions.get(item) !== live[key]) throw new Error('session id mismatch');
      return [key, sessions.get(item)];
    }));
  };
  const method = frame => frame?.method ?? (frame ? '<response>' : '<end>');
  const input = createInterface({ input: process.stdin });
  return new Promise(resolve => {
    const finish = code => {
      if (stopped) return;
      stopped = true; input.close(); process.stdin.pause();
      process.stdout.write('', () => resolve(code));
    };
    const mismatch = (expected, received, live) => {
      const message = `ACP replay mismatch: expected ${expected}; received ${received}`;
      process.stderr.write(message + '\n');
      const ids = new Set([...clientIds.values()].map(entry => entry.id));
      if (live?.method && live.id !== undefined) ids.add(live.id);
      if (!ids.size) ids.add(null);
      for (const id of ids) out({ jsonrpc: '2.0', id, error: { code: -32603, message } });
      finish(1);
    };
    const emit = () => {
      while (rows[cursor]?.dir === 'agent') {
        const recorded = rows[cursor++].frame;
        const frame = rewrite(recorded);
        if (frame.id !== undefined) {
          if (frame.method) {
            const id = `replay-agent-${++agentSeq}`;
            agentIds.set(recorded.id, { id, method: frame.method }); frame.id = id;
          } else {
            const pending = clientIds.get(recorded.id);
            if (!pending) throw new Error('response without a matching client request');
            frame.id = pending.id; clientIds.delete(recorded.id);
          }
        }
        out(frame);
      }
      if (cursor === rows.length && (clientIds.size || agentIds.size)) throw new Error('fixture ended with unanswered requests');
    };
    input.on('line', line => {
      if (stopped) return;
      const expected = rows[cursor]?.frame;
      let live;
      try {
        live = JSON.parse(line);
        if (!expected || method(expected) !== method(live)
          || (expected.id === undefined) !== (live.id === undefined)) {
          mismatch(method(expected), method(live), live); return;
        }
        rewrite(expected, live);
        if (expected.id !== undefined) {
          if (expected.method) clientIds.set(expected.id, { id: live.id, method: expected.method });
          else {
            const request = agentIds.get(expected.id);
            if (!request || request.id !== live.id) throw new Error('agent request response id mismatch');
            agentIds.delete(expected.id);
          }
        }
        cursor++;
        emit();
      } catch (err) { mismatch(method(expected), `${method(live)} (${err.message})`, live); }
    });
    input.on('close', () => {
      if (!stopped && cursor !== rows.length) mismatch(method(rows[cursor]?.frame), '<EOF>');
      else finish(0);
    });
    try { emit(); } catch (err) { mismatch('<client request>', err.message); }
  });
}
