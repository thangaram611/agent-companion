#!/usr/bin/env node
// Regenerate lib/codex-app-server-contract.json from the installed codex.
//
// Runs `codex app-server generate-json-schema` into a throwaway directory,
// distils the ~4 MB dump down to the routing table, the request/notification
// inventories, the shapes of both wire directions and the approval vocabularies
// the adapter answers with, and rewrites the committed fixture. `lib/codex-app-server-contract.test.mjs`
// re-runs the same distillation and fails on any difference, so this script is
// the only sanctioned way the fixture changes.
//
// Bumping codex is therefore a deliberate two-step: run this, then read the
// diff. A moved thread id shows up as a `routing` change on the notification
// that moved it — which is the whole point, because at runtime it would show up
// as one job's events arriving at another job's bridge.
//
// Usage:
//   node scripts/gen-codex-app-server-contract.mjs [--codex-bin <path>]

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CONTRACT_PATH,
  SCHEMA_GENERATOR_ARGS,
  compareContracts,
  distillAppServerSchema,
  parseCodexVersion,
  serializeContract,
} from '../lib/codex-app-server-contract.mjs';
import { probeCommand } from '../lib/target-diagnostics.mjs';

const args = process.argv.slice(2);

function readOption(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(2);
}

// The shared probe, so this inherits the same bounded-and-SIGKILLed posture as
// every other synchronous shell-out in the plugin (see test/exec-timeout-guard).
function runCodex(bin, codexArgs) {
  const result = probeCommand(bin, codexArgs);
  if (!result.ok) fail(`${bin} ${codexArgs.join(' ')} failed: ${result.output || 'no output'}`);
  return result.output;
}

const codexBin = readOption('--codex-bin') || process.env.CODEX_BIN || 'codex';

const codexVersion = parseCodexVersion(runCodex(codexBin, ['--version']));
if (!codexVersion) fail(`could not read a version from \`${codexBin} --version\``);

const schemaDir = mkdtempSync(path.join(tmpdir(), 'codex-app-server-schema-'));
let contract;
try {
  runCodex(codexBin, [...SCHEMA_GENERATOR_ARGS, schemaDir]);
  contract = distillAppServerSchema(schemaDir, codexVersion);
} finally {
  rmSync(schemaDir, { recursive: true, force: true });
}

const serialized = serializeContract(contract);
const current = (() => {
  try { return readFileSync(CONTRACT_PATH, 'utf8'); } catch { return null; }
})();
const previous = (() => {
  try { return current === null ? null : JSON.parse(current); } catch { return null; }
})();

writeFileSync(CONTRACT_PATH, serialized);

const n = contract.serverNotifications;
console.log(`Wrote ${CONTRACT_PATH} from codex-cli ${codexVersion}${current === serialized ? ' (unchanged)' : ''}`);

// Read the diff FOR the operator, classified the way the broker and the drift
// test classify it: routing moves first, because at runtime those are one
// job's events arriving at another job's bridge. A version-only bump says so
// in one line instead of leaving a two-line git diff to be interpreted.
if (previous && current !== serialized) {
  const diff = compareContracts(previous, contract);
  const from = previous.codexVersion || 'unknown';
  if (diff.identical) {
    console.log(`  wire contract unchanged since codex-cli ${from}; only the recorded provenance moved`);
  } else {
    console.log(`  wire contract changed since codex-cli ${from}:`);
    const section = (title, items, note) => {
      if (!items.length) return;
      console.log(`    ${title} (${items.length})${note ? ` — ${note}` : ''}`);
      for (const item of items) console.log(`      ${item}`);
    };
    section('ROUTING MOVED', diff.routing, 'READ EVERY LINE: a moved thread id is a live misrouting bug');
    section('removed', diff.removed, 'the adapter may still send or expect these');
    section('added', diff.added);
    section('shape changed', diff.changed);
  }
}
const c = contract.clientRequests;
console.log(`  ${c.length} client requests: `
  + `${c.filter((e) => e.required.length).length} with required params, `
  + `${c.filter((e) => !e.paramsRequired).length} that may be sent with no params at all`);
console.log(`  ${n.length} server notifications: `
  + `${n.filter((e) => e.routing === 'threadId').length} threadId, `
  + `${n.filter((e) => e.routing === 'nested').length} nested, `
  + `${n.filter((e) => e.routing === 'global').length} global`);
console.log(`  ${n.filter((e) => e.optional).length} of those declare the thread id optional`);
console.log(`  ${n.reduce((sum, e) => sum + Object.keys(e.params || {}).length, 0)} notification params fields, `
  + `${Object.keys(contract.threadItems).length} ThreadItem variants carrying `
  + `${Object.values(contract.threadItems).reduce((sum, f) => sum + Object.keys(f).length, 0)} fields`);
console.log(`  ${contract.serverRequests.length} server requests, `
  + `${contract.serverRequests.filter((r) => r.threadScoped).length} thread-scoped`);
console.log(`  ${Object.keys(contract.approvalDecisions).length} decision vocabularies`);
