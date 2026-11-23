// Fake job server for the direct-main probe: newline JSON-RPC over stdio.
// Usage: node fixture.mjs RUN_DIR
import fs from 'node:fs';
import { report } from './fixture-report.mjs';
import readline from 'node:readline';
import net from 'node:net';

const run = process.argv[2];
const logFile = run + '/fixture.jsonl';
const log = (event, data = {}) => fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: process.pid, event, ...data }) + '\n');
const out = message => process.stdout.write(JSON.stringify(message) + '\n');
const pending = new Map();
const hostKeys = Object.keys(process.env).filter(k => /MESSAG|OPENCODE|COPILOT|AGY|ANTIGRAVITY|GEMINI|CODEX|CLAUDE|SESSION|SOCK|SERVER|THREAD|CONVERSATION/i.test(k)).sort();
// Names only, plus the values of address-like variables (never tokens or keys).
log('server-env', { messagingKeys: hostKeys.filter(k => /MESSAG/.test(k)), hostKeys, ppid: process.ppid,
  addresses: Object.fromEntries(hostKeys.filter(k => /SOCKET|SESSION_ID|SERVER|URL|PORT|THREAD|CONVERSATION|_PID$/i.test(k) && !/TOKEN|KEY|SECRET|PASSWORD/i.test(k)).map(k => [k, process.env[k]])) });
// Post-back probe: this server (a child process of the session) writes one line to the session's inbox socket.
function postBack(text) {
  let target = process.env.CLAUDE_CODE_MESSAGING_SOCKET ? { socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN } : null;
  if (!target) { try { target = JSON.parse(fs.readFileSync(run + '/messaging.json', 'utf8')); } catch (err) { return log('postback-skip', { error: err.message }); } }
  const conn = net.createConnection(target.socket);
  conn.on('connect', () => { if (process.env.FIXTURE_POSTBACK_PLAIN !== 'noauth') conn.write(JSON.stringify({ type: 'auth', token: target.token }) + '\n');
    const plain = process.env.FIXTURE_POSTBACK_PLAIN;
    conn.write((plain ? text : JSON.stringify({ type: 'user', message: { role: 'user', content: text } })) + '\n'); log('postback-sent', { chars: text.length, form: plain ? 'plain text line' : 'json user line' }); setTimeout(() => conn.end(), 1500); });
  conn.on('error', err => log('postback-error', { error: err.message }));
}

// On-demand post: each line written to RUN/post-now.txt is posted to the session's inbox socket by this server.
setInterval(() => { let text; try { text = fs.readFileSync(run + '/post-now.txt', 'utf8'); fs.unlinkSync(run + '/post-now.txt'); } catch { return; }
  for (const line of text.split('\n').filter(Boolean)) postBack(line); }, 300).unref?.();

const tools = [
  { name: 'job_send', description: 'Start a fake job. Returns a job_id at once.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'job_wait', description: 'Wait for the fake job and return its final report.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, seconds: { type: 'number' }, kb: { type: 'number' } }, required: ['job_id', 'seconds', 'kb'] } },
];

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { log('signal', { signal }); process.exit(0); });
process.stdin.on('end', () => { log('stdin-eof'); process.exit(0); });

readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (method === 'initialize') {
    log('initialize', { params });
    return out({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0' } } });
  }
  if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
  if (method === 'notifications/cancelled') {
    log('cancelled', { params });
    const timer = pending.get(params?.requestId);
    if (timer) { clearTimeout(timer); pending.delete(params.requestId); }
    return;
  }
  if (method === 'tools/call') {
    log('call', { id, name: params.name, arguments: params.arguments, meta: params._meta });
    if (params.name === 'job_send' && process.env.FIXTURE_POSTBACK) setTimeout(() => postBack('THREAD-NEWS thread t-1: companion job job-1 finished (status completed). Answer: PROBE-ANSWER-44. Posted by the job server itself.'), Number(process.env.FIXTURE_POSTBACK) * 1000);
    if (params.name === 'job_send') return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'still_running', job_id: 'job-1' }) }] } });
    if (params.name === 'job_wait') {
      const { seconds, kb } = params.arguments;
      pending.set(id, setTimeout(() => {
        pending.delete(id);
        const text = report(kb);
        log('answered', { id, chars: text.length, trailer: text.slice(text.lastIndexOf('\n') + 1) });
        out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      }, seconds * 1000));
      return;
    }
    return out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
  }
  if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});
