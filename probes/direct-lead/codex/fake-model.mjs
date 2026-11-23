// Scripted stand-in for a Responses API model, for Codex host probes. No real model, no tokens.
// Usage: node fake-model.mjs RUN_DIR   (prints the port on stdout; logs every request under RUN_DIR/model-requests)
// Script: a user message line `PROBE-CALL <tool-suffix> <json-args>` makes the "model" call that tool; after each
// tool output it runs the next directive of the latest user message, then answers. Any other input gets PROBE-WOKEN.
import fs from 'node:fs';
import http from 'node:http';

const run = process.argv[2];
fs.mkdirSync(run + '/model-requests', { recursive: true });
let serial = 0;
const textOf = item => typeof item?.content === 'string' ? item.content
  : (item?.content ?? []).map(part => part.text ?? '').join('\n');
const flatTools = tools => (tools ?? []).flatMap(tool => tool.type === 'namespace' || Array.isArray(tool.tools)
  ? tool.tools.map(inner => ({ ...inner, namespace: tool.name })) : [tool]);

function reply(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  let last = -1;
  for (let i = 0; i < input.length; i++) if (input[i].type === 'message' && input[i].role === 'user' && /PROBE-CALL /.test(textOf(input[i]))) last = i;
  const tail = input.slice(last + 1);
  const outputs = tail.filter(item => /_output$/.test(item.type ?? ''));
  const laterUser = tail.filter(item => item.type === 'message' && item.role === 'user');
  if (last >= 0 && !laterUser.length) {
    const directives = textOf(input[last]).split('\n').filter(line => line.startsWith('PROBE-CALL ')).map(line => {
      const [, suffix, ...json] = line.split(' ');
      return { suffix, args: json.join(' ') || '{}' };
    });
    const next = directives[outputs.length];
    if (next) {
      const tool = flatTools(body.tools).find(t => (t.name ?? '').endsWith(next.suffix));
      if (!tool) return { message: `PROBE-NO-TOOL ${next.suffix}; tools: ${flatTools(body.tools).map(t => (t.namespace ? t.namespace + '/' : '') + t.name).join(', ')}` };
      return { call: { name: tool.name, namespace: tool.namespace, arguments: next.args } };
    }
    return { message: `PROBE-DONE outputs=${outputs.length}` };
  }
  const lastItem = input.at(-1);
  return { message: `PROBE-WOKEN last=${lastItem?.type}/${lastItem?.role ?? lastItem?.name ?? ''} text=${JSON.stringify((textOf(lastItem) || JSON.stringify(lastItem?.output ?? '')).slice(0, 160))}` };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const n = ++serial;
    let body = null; try { body = JSON.parse(raw); } catch {}
    fs.writeFileSync(`${run}/model-requests/${String(n).padStart(3, '0')}.json`, JSON.stringify({ t: Date.now(), method: req.method, url: req.url, body: body ?? raw.slice(0, 2000) }));
    if (req.method !== 'POST' || !/\/responses$/.test(req.url.split('?')[0]) || !body) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"probe: not found"}}'); }
    const id = `resp_${n}`;
    const out = reply(body);
    const item = out.call
      ? { type: 'function_call', call_id: `call_${n}`, name: out.call.name, ...(out.call.namespace ? { namespace: out.call.namespace } : {}), arguments: out.call.arguments }
      : { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: out.message }] };
    fs.appendFileSync(run + '/model-replies.jsonl', JSON.stringify({ t: Date.now(), n, item }) + '\n');
    // A fuller Responses stream: some clients build the answer from added/delta/done events and the final output list.
    const full = out.call ? { ...item, id: `fc_${n}`, status: 'completed' } : { ...item, status: 'completed', content: [{ type: 'output_text', text: out.message, annotations: [] }] };
    const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model ?? 'probe-model', status: 'in_progress', output: [] };
    const usage = { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
    const events = [{ type: 'response.created', response: base }, { type: 'response.in_progress', response: base },
      { type: 'response.output_item.added', output_index: 0, item: out.call ? { ...full, arguments: '', status: 'in_progress' } : { ...full, content: [], status: 'in_progress' } },
      ...(out.call ? [{ type: 'response.function_call_arguments.delta', item_id: full.id, output_index: 0, delta: full.arguments },
          { type: 'response.function_call_arguments.done', item_id: full.id, output_index: 0, arguments: full.arguments }]
        : [{ type: 'response.content_part.added', item_id: full.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: full.id, output_index: 0, content_index: 0, delta: out.message },
          { type: 'response.output_text.done', item_id: full.id, output_index: 0, content_index: 0, text: out.message },
          { type: 'response.content_part.done', item_id: full.id, output_index: 0, content_index: 0, part: full.content[0] }]),
      { type: 'response.output_item.done', output_index: 0, item: full },
      { type: 'response.completed', response: { ...base, status: 'completed', output: [full], usage } }].map((ev, i) => ({ ...ev, sequence_number: i }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map(ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''));
  });
});
server.listen(0, '127.0.0.1', () => { fs.writeFileSync(run + '/model-port.txt', String(server.address().port)); console.log(server.address().port); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
