#!/usr/bin/env node
// Sets or removes Codex's `thread_unload_delay_secs` in the user's config.toml: how long Codex keeps a
// conversation loaded, with its MCP servers and so the agent bridge, after its last window leaves (Codex's
// default is 60 s). Codex's own config writer (`codex app-server`, config/value/write) makes the edit, so the
// file's comments and layout stay. Usage: install-codex-unload-delay.mjs <seconds|default>; default removes it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveCodexExecutable } from '../lib/codex-install.mjs';

const [arg] = process.argv.slice(2);
if (!/^(\d+|default)$/.test(arg ?? '')) {
  console.error('usage: install-codex-unload-delay.mjs <seconds|default>');
  process.exit(2);
}
const { executable, path: bin } = resolveCodexExecutable(process.env);
if (!executable) {
  console.error(`Codex executable not found: ${bin}`);
  process.exit(1);
}

const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], signal: AbortSignal.timeout(20_000), killSignal: 'SIGKILL' });
child.stdin.on('error', () => {});
const closed = once(child, 'close').then(() => { throw new Error('codex app-server exited before answering'); });
closed.catch(() => {});
const replies = new Map();
let buffer = '';
child.stdout.on('data', chunk => {
  for (buffer += chunk; buffer.includes('\n'); buffer = buffer.slice(buffer.indexOf('\n') + 1)) {
    try { const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); replies.get(message.id)?.(message); } catch {}
  }
});
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const call = (id, method, params) => Promise.race([new Promise(resolve => { replies.set(id, resolve); send({ id, method, params }); }), closed]);

try {
  await call(1, 'initialize', { clientInfo: { name: 'agent-companion', version: '1' } });
  send({ method: 'initialized', params: {} });
  const value = arg === 'default' ? null : Number(arg);
  const reply = await call(2, 'config/value/write', { keyPath: 'thread_unload_delay_secs', value, mergeStrategy: 'replace' });
  if (reply.error) throw new Error(reply.error.message);
  console.log(value === null ? `Removed thread_unload_delay_secs from ${reply.result.filePath}`
    : `Set thread_unload_delay_secs = ${value} in ${reply.result.filePath}`);
} catch (err) {
  console.error(`could not write Codex config: ${err.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
