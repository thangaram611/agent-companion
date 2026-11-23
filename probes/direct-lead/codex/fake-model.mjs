// Scripted stand-in for a Responses API model, for Codex host and companion probes. No real model, no tokens.
// Usage: node fake-model.mjs RUN_DIR   (prints the port on stdout; logs every request under RUN_DIR/model-requests)
// Script, in the latest user message:
//   `PROBE-CALL <tool-suffix> <json-args>`  calls that tool; after each tool output the next directive runs.
//   `PROBE-PAGES <tool-suffix> <json-args>` calls it again with each output footer's `offset: N` until a footer
//                                           without one.
//   In args, $THREAD and $JOB take the thread and job_id the latest tool output named.
//   `PROBE-ANSWER <chars>` (no calls) answers with exactly that many characters of numbered lines;
//   `PROBE-DELAY <seconds>` beside it holds that answer back, streaming keep-alive events meanwhile.
// When the directives are done it answers PROBE-DONE; any other input gets PROBE-WOKEN.
import fs from 'node:fs';
import http from 'node:http';

const run = process.argv[2];
if (import.meta.main) fs.mkdirSync(run + '/model-requests', { recursive: true });
let serial = 0;
const textOf = item => typeof item?.content === 'string' ? item.content
  : (item?.content ?? []).map(part => part.text ?? '').join('\n');
const outputText = item => typeof item?.output === 'string' ? item.output
  : Array.isArray(item?.output) ? item.output.map(part => part.text ?? '').join('\n') : JSON.stringify(item?.output ?? '');
const flatTools = tools => (tools ?? []).flatMap(tool => tool.type === 'namespace' || Array.isArray(tool.tools)
  ? tool.tools.map(inner => ({ ...inner, namespace: tool.name })) : [tool]);

// Deterministic text of exactly `chars` characters: numbered 64-character lines.
export function probeAnswer(chars) {
  let text = '';
  for (let n = 1; text.length < chars; n++) text += `line ${String(n).padStart(6, '0')} ${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2).slice(0, 51)}\n`;
  return text.slice(0, chars);
}

function reply(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  let last = -1;
  for (let i = 0; i < input.length; i++) if (input[i].type === 'message' && input[i].role === 'user' && /PROBE-(CALL|PAGES) /.test(textOf(input[i]))) last = i;
  const tail = input.slice(last + 1);
  const outputs = tail.filter(item => /_output$/.test(item.type ?? '')).map(outputText);
  const laterUser = tail.filter(item => item.type === 'message' && item.role === 'user');
  if (last >= 0 && !laterUser.length) {
    const directives = textOf(input[last]).split('\n').filter(line => /^PROBE-(CALL|PAGES) /.test(line)).map(line => {
      const [kind, suffix, ...json] = line.split(' ');
      return { pages: kind === 'PROBE-PAGES', suffix, args: json.join(' ') || '{}' };
    });
    // Walk the outputs: a paging directive stays while its last output names a next offset.
    let index = 0, offset = null;
    for (const output of outputs) {
      const next = directives[index]?.pages && /next: [^\]]*offset: (\d+)[^\]]*\]\s*$/.exec(output);
      if (next) offset = Number(next[1]); else { index++; offset = null; }
    }
    const next = directives[index];
    if (next) {
      const tool = flatTools(body.tools).find(t => (t.name ?? '').endsWith(next.suffix));
      if (!tool) return { message: `PROBE-NO-TOOL ${next.suffix}; tools: ${flatTools(body.tools).map(t => (t.namespace ? t.namespace + '/' : '') + t.name).join(', ')}` };
      const named = key => [...outputs].reverse().map(text => new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text)?.[1]).find(Boolean) ?? '';
      let args = next.args.replaceAll('$THREAD', named('thread')).replaceAll('$JOB', named('job_id'));
      if (offset !== null) args = JSON.stringify({ ...JSON.parse(args), offset });
      return { call: { name: tool.name, namespace: tool.namespace, arguments: args } };
    }
    return { message: `PROBE-DONE outputs=${outputs.length}` };
  }
  const lastItem = input.at(-1);
  const answer = /PROBE-ANSWER (\d+)/.exec(textOf(lastItem));
  const delay = Number(/PROBE-DELAY (\d+)/.exec(textOf(lastItem))?.[1] ?? 0);
  if (answer) return { message: probeAnswer(Number(answer[1])), delay };
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
    const sse = ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!out.delay) return res.end(events.map(sse).join(''));
    // Hold the answer: the opening events now, a keep-alive every 20 s, the rest when the delay is up.
    res.write(sse(events[0]) + sse(events[1]));
    const keepAlive = setInterval(() => res.write(sse(events[1])), 20_000);
    setTimeout(() => { clearInterval(keepAlive); res.end(events.slice(2).map(sse).join('')); }, out.delay * 1000);
  });
});
if (import.meta.main) server.listen(0, '127.0.0.1', () => { fs.writeFileSync(run + '/model-port.txt', String(server.address().port)); console.log(server.address().port); });
if (import.meta.main) for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
