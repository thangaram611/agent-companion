// Shared MCP client for hand-run, token-spending Phase 3 probes. Metadata here
// simulates a native child; these probes do not qualify host hook attribution.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { companionHomeDir, refuseRealHomeUnderTest } from '../../lib/host.mjs';

const repo = process.env.AGENT_COMPANION_REPO || fileURLToPath(new URL('../..', import.meta.url));
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function record(kind, id, dir = process.env.AGENT_COMPANION_HOME || companionHomeDir()) {
  try { return JSON.parse(readFileSync(join(refuseRealHomeUnderTest(dir, 'probe state'), kind, `${id}.json`), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
export async function eventually(read, label, ms = 15_000) {
  const end = Date.now() + ms;
  do { const result = await read(); if (result) return result; await pause(100); } while (Date.now() < end);
  throw new Error(`Did not observe ${label}`);
}
export async function startBridge(session, { env = process.env, repo: root = repo, signal, spawnProcess = spawn, stopGraceMs = 15_000 } = {}) {
  signal?.throwIfAborted();
  const child = spawnProcess(process.execPath, [join(root, 'bridge-server/server.mjs')], {
    cwd: root, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...env, CLAUDE_CODE_SESSION_ID: session },
  });
  let exited = false, stopping;
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  const pending = new Map();
  let serial = 0, buffer = '';
  const fail = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', fail);
  child.on('close', () => fail(new Error('bridge closed')));
  child.stdin.on('error', fail);
  const waitClosed = ms => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    closed.then(() => { clearTimeout(timer); resolve(true); });
  });
  const stop = () => stopping ??= (async () => {
    fail(new Error('bridge stopping'));
    child.stdin.end();
    if (!await waitClosed(stopGraceMs)) {
      child.kill('SIGTERM');
      if (!await waitClosed(2000)) { child.kill('SIGKILL'); if (!await waitClosed(2000)) throw new Error('bridge exit unverified'); }
    }
  })().finally(() => { signal?.removeEventListener('abort', abort); process.removeListener('exit', emergencyStop); });
  const abort = () => { void stop().catch(() => {}); };
  const emergencyStop = () => { if (!exited) child.kill('SIGTERM'); };
  process.once('exit', emergencyStop);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('invalid bridge JSON')); abort(); return; }
      const p = pending.get(message.id);
      if (!p) continue;
      pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (stopping || exited || signal?.aborted) { reject(new Error('bridge stopped')); return; }
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 90_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args, owner) => {
    const response = await rpc('tools/call', { name, arguments: args,
      ...(owner ? { _meta: { 'x-codex-turn-metadata': { thread_id: owner, thread_source: 'subagent', session_id: session } } } : {}) });
    return response.structuredContent ?? JSON.parse(response.content.find((c) => c.type === 'text').text);
  };
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'phase3-smoke', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  } catch (err) { await stop(); throw err; }
  return { rpc, tool, stop,
    async wait(job_id, owner) {
      for (let i = 0; i < 12; i++) {
        const result = await tool('agent_wait', { job_id, max_wait_sec: 60 }, owner);
        if (!result.ok) throw new Error(JSON.stringify(result));
        if (result.status !== 'still_running') return result;
      }
      throw new Error(`execution ${job_id} exceeded probe wait budget`);
    },
  };
}
