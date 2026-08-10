// The `codex app-server` protocol contract, distilled and pinned.
//
// The app-server wire carries no protocol version field: its schemas drift with
// the CLI, and breakage surfaces only as a shape mismatch at runtime. That is
// tolerable for most fields and not tolerable for one — the broker delivers each
// server notification to exactly one bridge by the thread id inside `params`, so
// a codex upgrade that moves that id would route one job's events into another
// job's bridge, silently and per-job.
//
// So the routing table is generated from `codex app-server generate-json-schema`
// rather than hand-written, committed as `codex-app-server-contract.json`, and
// re-derived by the sibling test on every run against a pinned codex version.
// A schema change then fails CI instead of misrouting.
//
// Regenerate with:  node scripts/gen-codex-app-server-contract.mjs
//
// Measured on codex-cli 0.147.0: 70 server notifications (51 flat `threadId`,
// `thread/started` nested at `params.thread.id`, 18 genuinely global), 10
// server→client requests (8 thread-scoped), 95 client methods.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CONTRACT_PATH = path.join(HERE, 'codex-app-server-contract.json');
export const REGENERATE_COMMAND = 'node scripts/gen-codex-app-server-contract.mjs';

// `--out` is required; without it `codex app-server generate-json-schema` exits 2.
export const SCHEMA_GENERATOR_ARGS = ['app-server', 'generate-json-schema', '--out'];

export function loadContract(file = CONTRACT_PATH) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // The fixture is committed, so this is either a bad checkout or a hand-edit.
    // Say which file and how to rebuild it — the alternative is an ENOENT from
    // deep inside whatever imported the adapter.
    throw new Error(`codex app-server contract is missing or unreadable: ${file} (${err.message}). Restore it from git or run: ${REGENERATE_COMMAND}`);
  }
}

export const CODEX_APP_SERVER_CONTRACT = loadContract();

// The codex the contract was generated from. The adapter warns at runtime when
// the installed codex differs; CI fails outright.
export const CODEX_PINNED_VERSION = CODEX_APP_SERVER_CONTRACT.codexVersion;

// `codex --version` prints `codex-cli <semver>`. A binary that prints anything
// else is one we do not recognise, and guessing its version is worse than
// saying so — the whole point of the pin is that unknown shapes are unsafe.
export function parseCodexVersion(output) {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(String(output || ''));
  return match ? match[1] : null;
}

export function codexVersionMismatchMessage(installed) {
  const seen = installed ? `codex-cli ${installed}` : 'an unrecognised codex version';
  return `codex app-server contract is pinned to codex-cli ${CODEX_PINNED_VERSION} but this machine has ${seen}. `
    + 'The protocol carries no version field, so a schema change surfaces only as a runtime shape mismatch. '
    + `Re-check the adapter against the new CLI, then regenerate the fixture: ${REGENERATE_COMMAND}`;
}

const ROUTING_BY_METHOD = new Map(
  CODEX_APP_SERVER_CONTRACT.serverNotifications.map((entry) => [entry.method, entry]),
);

// Resolve which thread a server notification belongs to.
//
// `routing` is reported alongside the id so the caller can tell the three cases
// apart rather than reading a bare null three different ways: `global` means the
// contract says this notification has no owning thread (fan out or drop it),
// while `unknown` means the installed codex emitted a method this pinned
// contract has never seen — that is drift, and the caller must say so rather
// than quietly treating it as global.
export function routeNotification(method, params) {
  const entry = ROUTING_BY_METHOD.get(method);
  if (!entry) return { routing: 'unknown', threadId: null };
  if (!entry.key) return { routing: entry.routing, threadId: null };
  // `key` is a dotted path rooted at the notification envelope:
  // `params.threadId` for the flat cases, `params.thread.id` for thread/started.
  let cursor = { params };
  for (const segment of entry.key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return { routing: entry.routing, threadId: null };
    cursor = cursor[segment];
  }
  return { routing: entry.routing, threadId: typeof cursor === 'string' && cursor ? cursor : null };
}

// --------------------------------------------------------------- distillation
//
// `codex app-server generate-json-schema --out DIR` writes 2.9 MB across 285
// files on 0.147.0 — 37 per-type schemas at the top level (the aggregate
// `codex_app_server_protocol.schemas.json` is 606 KB of that by itself) plus
// v1/ and v2/ subdirectories. Committing that raw would make the drift diff
// unreadable, so this distils the six things the broker and the adapter depend
// on. Every entry is derived from the schema — there is no hand-written method
// list anywhere below — because a hand-written table is exactly the artefact
// that goes stale without anyone noticing.
//
// The distiller lives beside the consumers rather than inside the generator
// script so the shape has one owner: the module that produces the fixture is the
// module that reads it.

// Each per-type file inlines every type it references, so a `$ref` never leaves
// its own file.
function refName(schema) {
  const ref = schema?.$ref;
  return typeof ref === 'string' ? ref.split('/').pop() : null;
}

function definitionsOf(schema) {
  return schema?.definitions || schema?.$defs || {};
}

function deref(schema, defs, depth = 0) {
  const name = refName(schema);
  if (!name) return schema || null;
  if (depth > 8) throw new Error(`codex app-server schema: $ref cycle at ${name}`);
  const target = defs[name];
  if (!target) throw new Error(`codex app-server schema: unresolved $ref ${name}`);
  return deref(target, defs, depth + 1);
}

function readSchema(dir, name) {
  const file = path.join(dir, `${name}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`codex app-server schema is missing or unreadable: ${file} (${err.message})`);
  }
}

// A tagged-union variant discriminated by a single-valued `method`. 0.147.0
// spells that as a one-element `enum`; `const` is the other legal JSON Schema
// spelling for the same thing, so accept both rather than break on a rewrite
// that changes nothing semantically.
function methodOf(variant, label) {
  const method = variant?.properties?.method;
  if (typeof method?.const === 'string') return method.const;
  if (Array.isArray(method?.enum) && method.enum.length === 1) return String(method.enum[0]);
  throw new Error(`codex app-server schema: ${label} variant has no single-valued method`);
}

// A params property carries the owning thread id when it is named `threadId` or
// when its declared type is the schema's own `ThreadId`. The second clause is
// what makes the two legacy approval requests thread-scoped: they still spell it
// `conversationId`, but the schema types that field as `ThreadId`, i.e. it is
// the same id under the pre-rename name.
function classifyRouting(params, defs) {
  const props = params?.properties || {};
  // Sorted so a reordering of the generator's key order cannot change which
  // property wins when a params object ever carries two thread-typed fields.
  const names = Object.keys(props).sort();

  for (const name of names) {
    if (name === 'threadId' || refName(props[name]) === 'ThreadId') {
      return { routing: 'threadId', key: `params.${name}` };
    }
  }

  // `thread/started` is the 52nd thread-routable notification and the only one
  // that nests the id: it carries the whole `Thread` object, id at
  // `params.thread.id`. Detected by type, not by method name, so a second
  // notification shaped the same way is classified without a code change.
  for (const name of names) {
    if (refName(props[name]) !== 'Thread') continue;
    const thread = deref(props[name], defs);
    if (thread?.properties?.id) return { routing: 'nested', key: `params.${name}.id` };
  }

  return { routing: 'global', key: null };
}

// One reader for all three method unions (ClientRequest, ServerRequest,
// ServerNotification) — they are the same tagged shape, and each caller projects
// the fields it needs out of the result rather than the file growing three
// near-identical walkers.
function distillMethodUnion(dir, file) {
  const schema = readSchema(dir, file);
  const defs = definitionsOf(schema);
  const variants = schema.oneOf || [];
  if (!variants.length) throw new Error(`codex app-server schema: ${file}.json has no oneOf variants`);
  return variants.map((variant) => ({
    method: methodOf(variant, file),
    ...classifyRouting(deref(variant.properties?.params, defs), defs),
    paramsType: refName(variant.properties?.params),
  }));
}

// A decision variant is either a bare string literal (`accept`) or a single-key
// object carrying a payload (`acceptWithExecpolicyAmendment`). Both are answered
// by that name, so both are vocabulary.
function stringVariantsOf(schema) {
  if (!schema) return [];
  if (schema.type === 'string' && Array.isArray(schema.enum)) return schema.enum.map(String);
  if (!Array.isArray(schema.oneOf)) return [];
  const out = [];
  for (const variant of schema.oneOf) {
    if (Array.isArray(variant.enum)) out.push(...variant.enum.map(String));
    else if (variant.properties) out.push(...Object.keys(variant.properties));
    else return [];
  }
  return out;
}

// The vocabulary a server→client request must be answered with, or null when it
// answers with data instead of a choice.
//
// Gated on `required`: an optional property that happens to be an enum (0.147.0
// has one — `scope` on the permissions response) is a modifier, not the answer.
// The field NAME is part of the contract and is recorded with the words:
// `item/*/requestApproval` answers `{decision}` while `mcpServer/elicitation/request`
// answers `{action}`, and a reply the server cannot parse reads as a denial
// exactly like the wrong word does.
function closedVocabularyOf(response) {
  const defs = definitionsOf(response);
  const found = [];
  for (const field of [...(response.required || [])].sort()) {
    const decisions = stringVariantsOf(deref(response.properties?.[field], defs));
    if (decisions.length) found.push({ field, decisions: [...new Set(decisions)].sort() });
  }
  if (found.length > 1) {
    throw new Error(
      `codex app-server schema: ${response.title || 'response'} declares ${found.length} closed vocabularies `
      + `(${found.map((f) => f.field).join(', ')}) — the adapter cannot pick one blindly`,
    );
  }
  return found[0] || null;
}

function sortByMethod(entries) {
  return [...entries].sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
}

function sortedObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

// The tagged-union type names of `ThreadStatus` and the flags its `active`
// variant carries. Shared types are inlined into every file that references
// them; `ServerNotification.json` is the one this reads, and an absent
// definition is an error rather than an empty list.
function distillThreadStatus(dir) {
  const defs = definitionsOf(readSchema(dir, 'ServerNotification'));
  const status = defs.ThreadStatus;
  const flags = defs.ThreadActiveFlag;
  if (!status?.oneOf || !Array.isArray(flags?.enum)) {
    throw new Error('codex app-server schema: ThreadStatus/ThreadActiveFlag not found in ServerNotification.json');
  }
  return {
    threadStatusTypes: status.oneOf.map((variant) => {
      const type = variant?.properties?.type;
      const name = typeof type?.const === 'string' ? type.const : type?.enum?.[0];
      if (!name) throw new Error('codex app-server schema: ThreadStatus variant has no `type` literal');
      return String(name);
    }).sort(),
    threadActiveFlags: flags.enum.map(String).sort(),
  };
}

// Distil an already-generated schema directory into the committed contract.
// Deterministic by construction: every list is sorted, keys are written in a
// fixed order, and nothing records a path, a timestamp or a hostname — so the
// drift diff shows the protocol change and nothing else.
export function distillAppServerSchema(schemaDir, codexVersion) {
  if (!codexVersion) throw new Error('distillAppServerSchema requires the generating codex version');

  const notifications = distillMethodUnion(schemaDir, 'ServerNotification');
  const requests = distillMethodUnion(schemaDir, 'ServerRequest');

  const approvalDecisions = {};
  for (const request of requests) {
    // The response type is named for the request's params type
    // (`FooParams` → `FooResponse.json`), which is how the pairs are matched
    // without a hand-written table.
    if (!request.paramsType?.endsWith('Params')) continue;
    const vocabulary = closedVocabularyOf(
      readSchema(schemaDir, `${request.paramsType.slice(0, -'Params'.length)}Response`),
    );
    if (vocabulary) approvalDecisions[request.method] = vocabulary;
  }

  const { threadStatusTypes, threadActiveFlags } = distillThreadStatus(schemaDir);

  return {
    codexVersion,
    clientMethods: distillMethodUnion(schemaDir, 'ClientRequest').map((e) => e.method).sort(),
    serverNotifications: sortByMethod(notifications).map(({ method, routing, key }) => ({ method, routing, key })),
    serverRequests: sortByMethod(requests).map(({ method, routing }) => ({
      method,
      threadScoped: routing !== 'global',
    })),
    threadStatusTypes,
    threadActiveFlags,
    approvalDecisions: sortedObject(approvalDecisions),
  };
}

export function serializeContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
