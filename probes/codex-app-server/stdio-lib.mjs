// Shared helper: speak app-server JSON-RPC over stdio to a spawned child.
import { spawn } from 'node:child_process';

export function makeStdioServer({ tag = 'srv', onNotify = () => {}, onServerRequest = null } = {}) {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(c.toString()));
  let id = 1;
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const l of lines) {
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (p) (m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result));
      } else if (m.method && m.id !== undefined) {
        // server->client request
        const reply = onServerRequest ? onServerRequest(m) : { decision: 'decline' };
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: reply }) + '\n');
      } else if (m.method) onNotify(m);
    }
  });
  const call = (method, params) => new Promise((res, rej) => {
    const i = id++; pending.set(i, { res, rej });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return {
    child, call, notify, stderr,
    pid: child.pid,
    async init(name = tag) {
      const r = await call('initialize', { clientInfo: { name, version: '1.0.0' } });
      notify('initialized', {});
      return r;
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
