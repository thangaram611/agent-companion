// Prepare an isolated Codex host run. Usage: node prepare.mjs NAME  → prints the run directory.
// Creates RUN/{home,codex-home,workspace}, starts the fake model (detached) and writes config.toml pointing at it
// and at the fake job server. Nothing reads or writes ~/.codex.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
const run = path.join(here, '..', 'runs', `${name}-${new Date().toISOString().replaceAll(':', '-')}`);
for (const sub of ['home', 'codex-home', 'workspace', 'tmp']) fs.mkdirSync(path.join(run, sub), { recursive: true, mode: 0o700 });
const log = fs.openSync(run + '/fake-model.log', 'a');
const model = spawn(process.execPath, [here + '/fake-model.mjs', run], { detached: true, stdio: ['ignore', log, log] });
model.unref();
fs.writeFileSync(run + '/fake-model.pid', String(model.pid));
const deadline = Date.now() + 5000;
while (!fs.existsSync(run + '/model-port.txt') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
const port = fs.readFileSync(run + '/model-port.txt', 'utf8');
fs.writeFileSync(run + '/codex-home/config.toml', `model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.probe]
name = "Probe"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"

[mcp_servers.fixture]
command = "${process.execPath}"
args = ["${path.join(here, '..', 'fixture.mjs')}", "${run}"]
tool_timeout_sec = 1320
default_tools_approval_mode = "approve"

[projects."${run}/workspace"]
trust_level = "trusted"
`, { mode: 0o600 });
const stop = process.argv[3];
if (stop) fs.writeFileSync(run + '/codex-home/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', timeout: 900,
  command: `'${process.execPath}' '${path.join(here, '..', 'stop-inject.mjs')}' '${run}' ${stop} ${process.argv[4] ?? 0}` }] }] } }, null, 2));
const env = { PATH: process.env.PATH, HOME: run + '/home', CODEX_HOME: run + '/codex-home', TMPDIR: run + '/tmp', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
fs.writeFileSync(run + '/env.json', JSON.stringify(env, null, 2));
console.log(run);
