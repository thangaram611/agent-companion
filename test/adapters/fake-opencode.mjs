#!/usr/bin/env node
// HTTP shapes follow bridge-server/adapters/opencode.test.mjs and the measured 2.2.5
// contract. Native history is a fixture file so a second process can resume it.
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const row = { pid: process.pid, ppid: process.ppid, pgid: process.pid, birthTime: `${process.pid}:${performance.timeOrigin}` };
if (process.argv[2] === 'tool') {
  process.send(row);
  process.on('message', () => {});
} else {
  const dir = process.env.FAKE_OPENCODE_DIR;
  const mode = process.env.FAKE_OPENCODE_MODE;
  const log = (event) => appendFileSync(join(dir, 'requests.jsonl'), JSON.stringify({ pid: process.pid, ...event }) + '\n');
  const rows = [row];
  const saveRows = () => {
    const path = join(dir, `${process.pid}.json`);
    writeFileSync(path + '.tmp', JSON.stringify(rows));
    renameSync(path + '.tmp', path);
  };
  saveRows();
  log({ argv: process.argv.slice(2), cwd: process.cwd(), pwd: process.env.PWD });
  if (process.argv[2] !== 'serve') process.exit(90); // readiness must not probe
  if (mode === 'crash') process.exit(1);
  const store = join(dir, 'history.json');
  let sessions = {};
  try { sessions = JSON.parse(readFileSync(store, 'utf8')); } catch {}
  const save = () => writeFileSync(store, JSON.stringify(sessions));
  const password = randomUUID();
  const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  const streams = new Set();
  const defaults = { providerID: 'fixture', id: process.env.FAKE_OPENCODE_DEFAULT || 'first', variant: 'default' };
  let active, tool, selectionWritten = false;
  const emit = (type, data) => {
    const frame = `data: ${JSON.stringify({ type, data })}\r\n\r\n`;
    for (const stream of streams) stream.write(frame);
  };
  const finish = (outcome) => {
    if (!active) return;
    const { session, assistant, user } = active;
    assistant.tokens = { input: 11, output: 3, cache: { read: 2, write: 0 }, reasoning: 0 };
    assistant.cost = 0.01;
    session.messages.push({ id: randomUUID(), type: 'idle', outcome });
    session.outcome = outcome;
    save();
    emit('session.step.ended', { sessionID: session.id, assistantMessageID: assistant.id, ...assistant, finish: 'stop' });
    emit(`session.execution.${outcome}`, { sessionID: session.id, inputID: user.id });
    active = null;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (req.headers.authorization !== auth) return reply(401, {});
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = url.pathname;
    log({ path, query: url.search, method: req.method, body });
    if (path === '/api/info') return reply(200, { version: '2.2.5', pid: process.pid });
    if (path === '/api/model' && (req.method !== 'GET' || url.searchParams.get('directory') !== process.cwd())) return reply(400, { error: 'model enumeration requires GET and directory' });
    if (path === '/api/model' && mode === 'models-unavailable') return reply(503, {});
    if (path === '/api/model') return reply(200, { data: JSON.parse(process.env.FAKE_OPENCODE_MODELS || 'null') ||
      ['first', 'second', 'chosen', 'bare'].map(id => ({ providerID: 'fixture', id, variants: id === 'bare' ? [] : [
        { id: id === 'chosen' ? 'fast' : 'soft', settings: { reasoningEffort: 'low' } },
        { id: 'default', settings: { reasoningEffort: 'medium' } },
        { id: 'high', settings: { reasoningEffort: 'high' } },
      ] })) });
    if (path === '/api/model/default') return reply(200, { data: defaults });
    if (path === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\r\n\r\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (path.startsWith('/api/shell/')) return reply(200, { data: { id: 'sh_fixture', pid: tool?.pid, command: 'fixture tool', status: 'running' } });
    if (path === '/api/session' && req.method === 'POST') {
      const session = { id: 'ses_' + randomUUID(), location: body.location, messages: [] };
      sessions[session.id] = session; save();
      return reply(200, { data: session });
    }
    const [, id, operation] = path.match(/^\/api\/session\/([^/]+)(?:\/(.+))?$/) || [];
    const session = sessions[id];
    if (!session) return reply(404, {});
    if (!operation && selectionWritten) {
      if (mode === 'model-read-lost') { req.socket.destroy(); return; }
      if (mode === 'session-lost-after-model') return reply(404, {});
    }
    if (!operation) return reply(200, { data: session });
    if (operation === 'model') {
      if (mode === 'model-write-lost') { req.socket.destroy(); return; }
      selectionWritten = true;
      if (mode === 'model-rejected') return reply(400, {});
      if (mode !== 'model-ignored') session.model = { ...body.model, variant: body.model.variant || 'default' };
      save(); return reply(mode === 'bad-model-ack' ? 200 : 204);
    }
    if (operation === 'message') {
      // Force paging; an older turn must not contaminate this turn's usage.
      const messages = session.messages.toReversed();
      const offset = Number(url.searchParams.get('cursor') || 0);
      return reply(200, { data: messages.slice(offset, offset + 2), cursor: { next: offset + 2 < messages.length ? String(offset + 2) : null } });
    }
    if (operation === 'interrupt') {
      if (tool && tool.exitCode === null) { tool.kill(); await once(tool, 'exit'); }
      const interrupted = Boolean(active);
      if (interrupted) finish('interrupted');
      return reply(200, { interrupted });
    }
    if (operation !== 'prompt') return reply(404, {});
    const user = { id: 'msg_' + randomUUID(), type: 'user', text: body.text };
    session.messages.push(user); save();
    const assistant = { id: 'msg_' + randomUUID(), type: 'assistant', model: { ...(session.model || defaults) }, content: [] };
    if (mode === 'execution-mismatch') assistant.model.id = 'different';
    session.messages.push(assistant);
    active = { session, assistant, user };
    if (mode === 'no-ack') { req.socket.destroy(); return; }
    if (mode === 'hang-ack') return;
    // Terminal events deliberately precede the HTTP acknowledgement.
    emit('session.execution.succeeded', { sessionID: 'foreign' });
    emit('session.text.delta', { sessionID: 'foreign', assistantMessageID: 'foreign', ordinal: 0, delta: 'WRONG' });
    emit('session.step.started', { sessionID: id, assistantMessageID: assistant.id, model: assistant.model });
    const answer = body.text === 'recall' ? session.messages.find(m => m.type === 'user').text : 'answer: ' + body.text;
    assistant.content.push({ type: 'text', text: answer });
    emit('session.text.delta', { sessionID: id, assistantMessageID: assistant.id, ordinal: 0, delta: answer });
    if (['tool', 'retry'].includes(mode)) {
      tool = fork(import.meta.filename, ['tool'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const [toolRow] = await once(tool, 'message');
      rows.push(toolRow); saveRows();
      emit('session.tool.progress', { sessionID: id, assistantMessageID: assistant.id, id: 'tool', metadata: { shellID: 'sh_fixture' } });
      if (mode === 'retry') emit('session.retry.scheduled', { sessionID: id, assistantMessageID: assistant.id, attempt: 2, at: Date.now(), error: { type: 'rate_limit', message: 'retrying' } });
    } else if (mode !== 'drop-stream' && mode !== 'die') {
      finish(mode === 'provider-error' ? 'failed' : 'succeeded');
    }
    reply(200, mode === 'bad-ack' ? {} : { data: { ...user, sessionID: id } });
    if (mode === 'drop-stream') for (const stream of streams) stream.end();
    if (mode === 'die') setTimeout(() => process.exit(2), 25);
  });
  server.listen(0, '127.0.0.1', () => {
    if (mode === 'no-boot') return;
    process.stdout.write(`server listening on http://127.0.0.1:${server.address().port}\nserver pass`);
    setImmediate(() => process.stdout.write(`word ${password.slice(0, 8)}`));
    setTimeout(() => process.stdout.write(password.slice(8) + '\n'), 5);
  });
}
