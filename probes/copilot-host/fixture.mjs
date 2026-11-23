// Synthetic stdio MCP server. Never log prompts, results, or the full environment.
import fs from 'node:fs';
import readline from 'node:readline';
const dir = fs.readFileSync(new URL('./run-dir', import.meta.url), 'utf8');
const session = process.env.COPILOT_AGENT_SESSION_ID;
const log = (event, extra = {}) => fs.appendFileSync(dir + '/events', JSON.stringify({
  t: Date.now(), pid: process.pid, session, event, ...extra,
}) + '\n');
log('start', { marked: Boolean(process.env.AGENT_COMPANION_JOB),
  homeMatches: process.env.HOME === dir + '/home',
  copilotHomeMatches: process.env.COPILOT_HOME === dir + '/copilot_home',
  pluginRoot: Boolean(process.env.PLUGIN_ROOT), pluginData: Boolean(process.env.PLUGIN_DATA),
  hostKeys: Object.keys(process.env).filter(k => k.startsWith('COPILOT_')).sort(),
});
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id == null) { log(method); return; }
  if (method === 'initialize') return reply(id, {
    protocolVersion: params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'host-fixture', version: '1' }, instructions: 'The MCP instruction canary is CITRON-482.',
  });
  if (method === 'tools/list') return reply(id, { tools: [{ name: 'companion_probe',
    description: 'Return the synthetic measurement token. Call exactly once when asked.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }] });
  if (method === 'tools/call') {
    log('call', { name: params.name, meta: params._meta ?? null, stamped: params.arguments?.lead === 'host-hook' });
    const seconds = fs.existsSync(dir + '/delay') ? Number(fs.readFileSync(dir + '/delay', 'utf8')) : 0;
    setTimeout(() => { log('reply'); reply(id, { content: [{ type: 'text', text: 'MARBLE-918' }] }); }, seconds * 1000);
    return;
  }
  reply(id, {});
}).on('close', () => { log('eof'); process.exit(0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log(sig); process.exit(0); });
