// Imported without opening a listener. The runner owns this server's lifetime.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const paths = new Set(['/v1/responses', '/v1/messages', '/v1/chat/completions']);
export function wireFields(path, body) {
  const pathname = new URL(path, 'http://localhost').pathname;
  const row = { path: paths.has(pathname) ? pathname : '/other' };
  if (!body || typeof body !== 'object') return row;
  for (const key of ['model', 'reasoning_effort', 'effort']) if (typeof body[key] === 'string') row[key] = body[key];
  if (typeof body.think === 'boolean' || typeof body.think === 'string') row.think = body.think;
  for (const [key, fields] of [['reasoning', ['effort']], ['thinking', ['type', 'budget_tokens']], ['output_config', ['effort']]]) {
    for (const field of fields) {
      const value = body[key]?.[field];
      if (typeof value === 'string' || typeof value === 'number') (row[key] ??= {})[field] = value;
    }
  }
  return row;
}

export async function startProxy({ logFile, upstream = 'http://127.0.0.1:11434' }) {
  const origin = new URL(upstream);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('The free-backend proxy requires local Ollama on 127.0.0.1');
  const requests = new Set();
  const server = http.createServer(async (req, res) => {
    let up;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let parsed; try { parsed = JSON.parse(body.toString()); } catch {}
      appendFileSync(logFile, JSON.stringify(wireFields(req.url, parsed)) + '\n', { mode: 0o600 });
      const path = new URL(req.url, origin);
      up = http.request(origin, { path: path.pathname + path.search, method: req.method, headers: { ...req.headers, host: origin.host } }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
        response.on('error', () => res.destroy());
      });
      requests.add(up); up.once('close', () => requests.delete(up));
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Ollama upstream unavailable'); });
      res.on('close', () => up.destroy());
      up.end(body);
    } catch {
      up?.destroy(); if (!res.headersSent) res.writeHead(502); res.end('Proxy request failed');
    }
  });
  const stop = () => new Promise((resolve, reject) => {
    for (const request of requests) request.destroy();
    server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    server.closeAllConnections();
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}`, stop };
  } catch (err) { await stop(); throw err; }
}
