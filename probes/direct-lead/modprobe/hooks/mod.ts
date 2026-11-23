// Probe mod: `mcp__modprobe__job_start` answers at once, and the mod submits a
// prompt carrying the fake report when the timer ends. MODPROBE_LOG names the log.
async function log($: any, event: string, data: Record<string, unknown> = {}) {
  const file = await $.env.get('MODPROBE_LOG').catch(() => undefined)
  if (typeof file !== 'string' || !file) return
  const old = await $.fs.read(file).catch(() => '')
  await $.fs.write(file, (typeof old === 'string' ? old : old?.text ?? '') + JSON.stringify({ t: Date.now(), event, ...data }) + '\n').catch(() => {})
}
function report(kb: number) {
  const lines: string[] = []
  let size = 0
  for (let i = 1; size < kb * 1024; i++) {
    const line = `Line ${String(i).padStart(5, '0')}: the companion found item ${i * 7919 % 10007} in module ${i % 37} and cites file src/part${i % 91}.ts:${i % 400 + 1}.`
    lines.push(line); size += line.length + 1
  }
  return `${lines.join('\n')}\nEND lines=${lines.length} bytes=${size - 1}`
}
async function finish($: any, kb: number) {
  const text = `MOD-WAKE-MARKER companion job job-1 finished (status completed). Its report follows verbatim.\n${report(kb)}`
  const sent = await $.prompt.submit({ text }).then((r: any) => ({ ok: true, chars: r?.text?.length ?? null, keys: Object.keys(r ?? {}) }), (err: any) => ({ ok: false, error: String(err) }))
  await log($, 'submitted', { chars: text.length, sent })
}
export const register = (on: any) => {
  on('session.start', async ($: any, e: any, next: any) => {
    const out = await next(e)
    const registered = await $.tool.register({ name: 'job_start', isDeferred: false,
      description: 'Start a fake job. Answers at once with a job_id; a later message carries the report when the job ends.',
      inputSchema: { type: 'object', properties: { seconds: { type: 'number' }, kb: { type: 'number' } }, required: ['seconds', 'kb'] } }).catch((err: any) => ({ error: String(err) }))
    await log($, 'registered', { registered })
    return out
  })
  on('tool.run', { tool: 'mcp__modprobe__job_start' }, async ($: any, e: any) => {
    await log($, 'tool.run', { keys: Object.keys(e), agentId: e.agentId ?? null, seconds: e.seconds, kb: e.kb })
    $.clock.after(Number(e.seconds) * 1000, () => finish($, Number(e.kb)))
    return { result: JSON.stringify({ ok: true, status: 'still_running', job_id: 'job-1' }) }
  })
}
