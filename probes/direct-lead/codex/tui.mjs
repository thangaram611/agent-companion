// Start the Codex TUI in a prepared run under the scripted PTY host. Usage: node codex/tui.mjs RUN "prompt" [wallSec]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [run, prompt, wall = '300'] = process.argv.slice(2);
const env = JSON.parse(fs.readFileSync(run + '/env.json', 'utf8'));
fs.writeFileSync(run + '/command.json', JSON.stringify({ executable: 'codex', args: ['-C', run + '/workspace', prompt], cwd: run + '/workspace', env, wallSec: Number(wall) }, null, 2));
const out = fs.openSync(run + '/driver.log', 'a');
spawn('python3', [path.join(here, '..', 'tui.py'), run], { detached: true, stdio: ['ignore', out, out] }).unref();
