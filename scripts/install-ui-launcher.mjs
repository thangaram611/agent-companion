#!/usr/bin/env node
// Install ~/.local/bin/agent-companion, a two-line launcher that runs this
// checkout's hooks/launch-ui.sh. setup.sh runs it on every apply; it says what
// it changed (installed, updated or unchanged), never replaces a file it did
// not write, and never edits shell startup files: when the directory is not on
// PATH it prints the line to add.
//
// Usage: node scripts/install-ui-launcher.mjs [--bin-dir <dir>] [--dry-run]
// Exit codes: 0 done, unchanged or preserved; 2 bad arguments.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SENTINEL = '# AUTO-INSTALLED by agent-companion (scripts/install-ui-launcher.mjs); setup.sh rewrites it';
const args = process.argv.slice(2);
const at = args.indexOf('--bin-dir');
if (at >= 0 && !args[at + 1]) { console.error('[FAIL] --bin-dir requires a value'); process.exit(2); }
const binDir = path.resolve(at >= 0 ? args[at + 1] : path.join(homedir(), '.local', 'bin'));
const dryRun = args.includes('--dry-run');
const launcher = path.join(binDir, 'agent-companion');
const quoted = `'${path.join(ROOT, 'hooks', 'launch-ui.sh').replaceAll("'", `'\\''`)}'`;
const body = `#!/bin/bash\n${SENTINEL}\nexec /bin/bash ${quoted} "$@"\n`;

const current = existsSync(launcher) ? readFileSync(launcher, 'utf8') : null;
if (current !== null && !current.includes(SENTINEL)) {
  console.log(`[WARN] ${launcher} exists and was not written by agent-companion; left unchanged. Run the UI with: bash ${quoted} ui`);
} else if (current === body) {
  console.log(`[OK]   UI launcher unchanged: ${launcher}`);
} else if (dryRun) {
  console.log(`[OK]   UI launcher would be ${current === null ? 'installed' : 'updated'}: ${launcher}`);
} else {
  mkdirSync(binDir, { recursive: true });
  const tmp = `${launcher}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, launcher);
  console.log(`[OK]   UI launcher ${current === null ? 'installed' : 'updated'}: ${launcher} (runs ${path.join(ROOT, 'hooks', 'launch-ui.sh')})`);
}
const onPath = (process.env.PATH ?? '').split(path.delimiter).some(dir => dir && path.resolve(dir) === binDir);
if (!onPath) {
  const home = binDir === path.join(homedir(), '.local', 'bin') ? '$HOME/.local/bin' : binDir;
  console.log(`[WARN] ${binDir} is not on PATH. Add it in your shell profile (for zsh, ~/.zprofile): export PATH="${home}:$PATH"`);
  console.log(`       Until then run: ${launcher} ui`);
}
