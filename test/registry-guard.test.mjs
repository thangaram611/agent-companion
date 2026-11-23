import test from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { HOSTS } from '../lib/hosts/index.mjs';
import { TARGET_IDS } from '../lib/target-registry.mjs';

const root = new URL('../', import.meta.url);
const later = 'removed or rewritten in a later step';
// File, permitted source, reason. Keep temporary exceptions local to their callers.
const exceptions = [
  ['hooks/stop-owner.sh', /.*/, later],
  ['hooks/drain-completions.sh', /.*/, later],
  ['hooks/mod.ts', /.*/, later],
  ['bridge-server/ui/jobs.mjs', /locate\('(?:claude|codex)'|job\.host === 'codex'/, later],
  ['bridge-server/ui/rows.mjs', /export const COMPANION_NAMES = \{[^}]+\}/, "Claude's mod loads these names without Node imports"],
  ['hooks/host-paths.sh', /"codex"\)/, 'shell copy of the host path rules, checked against the registry'],
  ['setup.sh', /"\$TARGET" = "copilot"/, 'installs the Copilot-specific reviewer'],
  ['setup.sh', /transport.env.AGENT_COMPANION_HOST == "codex"/, 'verifies the installed Codex MCP registration'],
];

test('production companion and host literals belong to their registries', () => {
  const ids = [...new Set([...TARGET_IDS, ...Object.keys(HOSTS)])].map(RegExp.escape);
  const literal = new RegExp('(["\'\x60])(' + ids.join('|') + ')\\1', 'g');
  const files = globSync(['{bridge-server,lib,scripts}/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,sh}', 'hooks/*.{sh,mjs}', 'hooks/mod.ts', 'setup.sh'], {
    cwd: root, exclude: ['**/node_modules/**', '**/*.test.*', '**/{test,tests,fixtures,probes,docs}/**'],
  });
  const offenders = [];
  for (const file of files) {
    if (file === 'lib/target-registry.mjs' || file.startsWith('lib/hosts/')) continue;
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
