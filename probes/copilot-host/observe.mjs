// Forward unchanged requests to the private Ollama. Record only fixed canaries and tool names.
import http from 'node:http';
import fs from 'node:fs';
import { Readable } from 'node:stream';
const root = process.argv[2];
if (fs.readFileSync(root + '/package/run-dir', 'utf8') !== root) throw new Error('use a prepared home');
const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (body.length) {
      const data = JSON.parse(body);
      const messages = JSON.stringify(data.messages ?? data.input ?? []);
      fs.appendFileSync(root + '/wire', JSON.stringify({ t: Date.now(), model: data.model,
        tools: (data.tools ?? []).map(item => item.function?.name ?? item.name),
        canaries: ['CITRON-482','LIME-131','PEAR-747','PLUM-551','MIDTURN-643','BRAVO-507']
          .filter(marker => messages.includes(marker)),
      }) + '\n');
    }
    const answer = await fetch('http://127.0.0.1:11435' + req.url, {
      method: req.method, headers: { 'content-type': 'application/json' }, body: body.length ? body : undefined,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]),
    });
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') });
    Readable.fromWeb(answer.body).on('error', () => res.destroy()).pipe(res);
  } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(root + '/observer-port', String(server.address().port)));
