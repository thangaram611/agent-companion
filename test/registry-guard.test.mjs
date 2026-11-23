import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { HOSTS } from '../lib/hosts/index.mjs';
import { COMPANION_IDS } from '../lib/companion-registry.mjs';

const root = new URL('../', import.meta.url);
// File, permitted source, reason. Keep temporary exceptions local to their callers.
const exceptions = [
  ['hooks/host-paths.sh', /"codex"\)/, 'shell copy of the host path rules, checked against the registry'],
  ['setup.sh', /"\$COMPANION" = "copilot"/, 'installs the Copilot-specific reviewer'],
  ['setup.sh', /transport.env.AGENT_COMPANION_HOST == "codex"/, 'verifies the installed Codex MCP registration'],
];

test('production companion and host literals belong to their registries', () => {
  const ids = [...new Set([...COMPANION_IDS, ...Object.keys(HOSTS)])].map(RegExp.escape);
  const literal = new RegExp('(["\'\x60])(' + ids.join('|') + ')\\1', 'g');
  const files = globSync(['{bridge-server,lib,scripts}/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,sh}', 'hooks/*.{sh,mjs}', 'hooks/mod.ts', 'setup.sh'], {
    cwd: root, exclude: ['**/node_modules/**', '**/*.test.*', '**/{test,tests,fixtures,probes,docs}/**'],
  });
  const offenders = [];
  for (const file of files) {
    if (file === 'lib/companion-registry.mjs' || file.startsWith('lib/hosts/')) continue;
    const lines = readFileSync(new URL(file, root), 'utf8').split('\n');
    const allowed = exceptions.filter(([path]) => path === file);
    for (const [index, source] of lines.entries()) {
      if (file.endsWith('.sh') ? /^\s*#/.test(source) : /^\s*(?:\/\/|\* )/.test(source)) continue;
      const line = allowed.reduce((text, [, pattern]) => text.replace(pattern, ''), source);
      for (const [, , id] of line.matchAll(literal)) {
        if (file.startsWith(`bridge-server/adapters/${id}`) || file === `lib/transcripts/${id}.mjs`) continue;
        if (id === HOSTS.codex.id && /^(lib\/codex-|scripts\/(?:build-|validate-|gen-|install-)codex-)/.test(file)) continue;
        offenders.push(`${file}:${index + 1}: ${id}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
