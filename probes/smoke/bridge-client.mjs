// Shared MCP client for hand-run, token-spending Phase 3 probes. Metadata here
// simulates a native child; these probes do not qualify host hook attribution.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_DIR } from '../../lib/state.mjs';

const repo = process.env.AGENT_COMPANION_REPO || fileURLToPath(new URL('../..', import.meta.url));
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function record(kind, id) {
  try { return JSON.parse(readFileSync(join(BASE_DIR, kind, `${id}.json`), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
export async function eventually(read, label, ms = 15_000) {
  const end = Date.now() + ms;
  do { const result = await read(); if (result) return result; await pause(100); } while (Date.now() < end);
  throw new Error(`Did not observe ${label}`);
}
export async function startBridge(session) {
  const child = spawn(process.execPath, [join(repo, 'bridge-server/server.mjs')], {
    cwd: repo, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
  });
  const closed = once(child, 'close');
  const pending = new Map();
  let serial = 0, buffer = '';
  const fail = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', fail);
  child.on('close', () => fail(new Error('bridge closed')));
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line), p = pending.get(message.id);
      if (!p) continue;
      pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'phase3-smoke', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  return { rpc, tool, async stop() { child.stdin.end(); await closed; },
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
