// Single-producer guard. `loadProfiles` (lib/profile-registry.mjs) must be the
// ONLY reader of profiles.json: the raw read primitives `readProfilesRaw` and
// the `PROFILES_FILE` path may be referenced only inside lib/state.mjs (where
// they are defined) and lib/profile-registry.mjs (the sole producer). Any other
// source file referencing them re-opens the file behind the producer's back —
// exactly the drift the daemon already demonstrates for a sibling model-state
// file (it reads default-model at four independent sites). This test fails on
// any planted extra reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['lib', 'bridge-server', 'scripts', 'hooks'];
const ALLOWED = new Set(['lib/state.mjs', 'lib/profile-registry.mjs']);
const RESTRICTED = ['readProfilesRaw', 'PROFILES_FILE'];

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (ent.name.endsWith('.mjs') && !ent.name.endsWith('.test.mjs')) {
      out.push(full);
    }
  }
  return out;
}

test('only lib/state.mjs and lib/profile-registry.mjs reference profiles.json read primitives', () => {
  const offenders = [];
  for (const d of SCAN_DIRS) {
    const base = join(REPO_ROOT, d);
    try { statSync(base); } catch { continue; }
    for (const file of walk(base)) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      for (const token of RESTRICTED) {
        if (src.includes(token)) offenders.push(`${rel} references "${token}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `profiles.json must be read only via loadProfiles; extra readers found:\n${offenders.join('\n')}`,
  );
});
