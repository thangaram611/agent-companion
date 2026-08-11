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
// server→client requests (8 thread-scoped, two of them via the pre-rename
// `params.conversationId`), 95 client requests. Three of the 51 declare their
// `threadId` optional and nullable, so they carry no thread when the event is
// not about one; that is recorded as `optional` rather than flattened away.
//
// The client side records each request's REQUIRED PARAMS, because the second
// way this protocol breaks silently is a call that omits one. The real server
// answers `-32600 "Invalid request: missing field \`x\`"` before it looks at
// anything else, while a hand-written fake answers whatever it is asked — which
// is how `turn/steer` shipped without `expectedTurnId` and `turn/interrupt`
// without `turnId` through three rounds of review, green the whole way. The
// fakes validate against this table now (`contractViolation`), so a call the
// real server would reject fails in `node --test` instead of in the field.

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

// Read once, but do not throw at import time: the generator imports this module
// for the distiller, and a missing or conflict-marked fixture is precisely the
// state you run the generator from. Only the readers of the fixture fail — and
// their message's "or run the generator" advice is then actually followable.
const LOADED = (() => {
  try {
    return { contract: loadContract(), error: null };
  } catch (error) {
    return { contract: null, error };
  }
})();

export function codexAppServerContract() {
  if (LOADED.error) throw LOADED.error;
  return LOADED.contract;
}

// The codex the contract was generated from. The adapter warns at runtime when
// the installed codex differs; CI fails outright. Null only when the fixture
// itself is unreadable, which `codexAppServerContract()` reports properly.
export const CODEX_PINNED_VERSION = LOADED.contract?.codexVersion ?? null;

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

let indexed = null;
function methodIndex() {
  if (!indexed) {
    const contract = codexAppServerContract();
    indexed = {
      notifications: new Map(contract.serverNotifications.map((entry) => [entry.method, entry])),
      requests: new Map(contract.serverRequests.map((entry) => [entry.method, entry])),
      clientRequests: new Map(contract.clientRequests.map((entry) => [entry.method, entry])),
    };
  }
  return indexed;
}

// `key` is a dotted path rooted at the envelope: `params.threadId` for the flat
// cases, `params.thread.id` for thread/started, `params.conversationId` for the
// two legacy approval requests. Reading it anywhere but here re-hand-writes the
// table the fixture exists to generate.
function readKey(entry, params) {
  if (!entry.key) return null;
  let cursor = { params };
  for (const segment of entry.key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return null;
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' && cursor ? cursor : null;
}

function routingOfKey(key) {
  if (!key) return 'global';
  return key.split('.').length > 2 ? 'nested' : 'threadId';
}

// Resolve which thread a server notification or server→client request belongs
// to. Both return `{routing, threadId, optional}`:
//
// - `threadId`/`nested` with an id — deliver to that thread's bridge.
// - `global` — the contract says this message has no owning thread; fan it out
//   or drop it.
// - `unknown` — the installed codex emitted a method this pinned contract has
//   never seen. That is drift, and the caller must say so rather than quietly
//   treating it as global.
// - thread-routable but `threadId === null` — read `optional`: true means the
//   schema declares the id legally absent (three notifications on 0.147.0, e.g.
//   a `warning` that applies to no thread), so handle it like a global one;
//   false means the id moved and the caller is looking at drift.
export function routeNotification(method, params) {
  const entry = methodIndex().notifications.get(method);
  if (!entry) return { routing: 'unknown', threadId: null, optional: false };
  return { routing: entry.routing, threadId: readKey(entry, params), optional: entry.optional };
}

export function routeRequest(method, params) {
  const entry = methodIndex().requests.get(method);
  if (!entry) return { routing: 'unknown', threadId: null, optional: false };
  return { routing: routingOfKey(entry.key), threadId: readKey(entry, params), optional: entry.optional };
}

// ------------------------------------------------------- client-side validation
//
// What the app-server demands of a call BEFORE it looks at the thread, the turn
// or anything else. Deserialization is the first thing that happens to a frame,
// so this is also the only error class that fires for an id that exists nowhere:
// measured on the real 0.147.0 server, `turn/steer {threadId: <all-zero>}` with
// no `expectedTurnId` answers `-32600 missing field \`expectedTurnId\``, not
// `thread not found`.

// The one error code this protocol has. Every app-server error is -32600; only
// the message distinguishes them (docs/RELIABILITY_REMEDIATION.md §2).
export const JSONRPC_INVALID_REQUEST = -32600;

// The measured wording, reproduced exactly so a fake's rejection is
// indistinguishable from the server's — a test that asserts on a paraphrase
// proves nothing about the wire.
export function missingFieldError(field) {
  return { code: JSONRPC_INVALID_REQUEST, message: `Invalid request: missing field \`${field}\`` };
}

// `null` when this contract has never seen the method — a broker-local method
// (`broker/status`), a test fixture's own (`fake/emit`), or genuine drift. The
// caller must not treat that as "no requirements": it is "not a client request
// of the pinned protocol at all".
export function clientRequestContract(method) {
  return methodIndex().clientRequests.get(method) || null;
}

// The refusal a fake owes a method it cannot answer faithfully — the other half
// of the same blind spot. A missing required field was one way a fake turned a
// protocol violation into a green test; answering `{echo: method}` to a method
// it never implemented is the other, and it covers a typo (`turn/interupt`), a
// codex rename, and an adapter call the fixture never modelled.
//
// Measured on 0.147.0, both `turn/interupt` and `totally/made/up`:
//   -32600 "Invalid request: unknown variant `turn/interupt`, expected one of
//           `initialize`, `thread/start`, …"  (136 variants, 3.2 KB)
// and the error frame DOES carry the request id, so the caller's pending call
// rejects rather than hangs. An unknown NOTIFICATION is answered with nothing.
//
// THE VARIANT LIST IS DELIBERATELY NOT REPRODUCED, and that is a measurement
// rather than a shortcut: the running binary accepts 136 methods while its own
// `generate-json-schema` publishes 95 of them. `thread/turns/list`,
// `thread/items/list`, `getAuthStatus`, `process/spawn` and 37 more are real
// methods this contract has never heard of — so "absent from the fixture" does
// NOT mean "the server would reject it", and a fake reciting `expected one of
// <the 95>` would be claiming an inventory it does not have (and would refuse
// `thread/turns/list`, which the next author has every reason to call).
//
// What is true of everything that reaches here — the fiction the server refuses
// and the real method the fake never implemented — is that the fake has no
// faithful answer and a success would prove nothing. Same code, same "the call
// did not run", a sentence that overstates neither.
export function unhandledMethodError(method) {
  return {
    code: JSONRPC_INVALID_REQUEST,
    message: `Invalid request: unknown variant \`${method}\` — this fake has no faithful answer for it. `
      + 'The real codex app-server either refuses it as an unknown variant or answers it for real; '
      + 'either way a success invented here would prove nothing.',
  };
}

// The error the real server answers a params object that omits a required
// field, or null when the call satisfies the contract.
//
// Two measured rules, both derived from the schema rather than assumed:
//   - 87 of the 95 client requests list `params` itself as required, so a frame
//     with no params object at all is `missing field \`params\`` — measured on
//     `thread/loaded/list` and `thread/start`, whose own params carry no
//     required field yet still cannot be omitted. The other 8 may be sent bare.
//   - a required field that is present but `null` is rejected too, with a
//     different message (`invalid type: null, expected a string`). Both are
//     -32600 refusals of the same call, so this reports the missing-field one
//     rather than inventing a second vocabulary; the point is that the call
//     does not reach the server, not which sentence it dies by.
//
// FIELD ORDER IS NOT CONTRACT. serde names the first missing field in the Rust
// struct's declaration order, which the JSON schema does not preserve (its
// properties are alphabetised) — measured: `turn/steer {}` says `threadId`
// while the schema's `required` starts at `expectedTurnId`. So the SET is
// contract and the choice among several missing fields is not; this reports the
// first in the contract's own sorted order.
//
// TOP-LEVEL PRESENCE ONLY — the limit, named rather than left to be discovered.
// Six refusals measured on 0.147.0 that this does NOT reproduce, all the same
// -32600 deserialization refusal as the ones it does:
//   `turn/start {threadId, input:[{}]}`            → missing field `type`
//   `turn/start {threadId, input:[{type:'text'}]}` → missing field `text`
//   `turn/interrupt {threadId, turnId: 5}`         → invalid type: integer `5`,
//                                                    expected a string
//   `turn/start {…, sandboxPolicy:{type:'workspace-write'}}`
//                                                  → unknown variant
//                                                    `workspace-write`, expected
//                                                    one of `dangerFullAccess`,
//                                                    `readOnly`,
//                                                    `externalSandbox`,
//                                                    `workspaceWrite`
//   `turn/start {…, sandboxPolicy:{type:'workspaceWrite', networkAccess:'enabled'}}`
//                                                  → invalid type: string
//   `turn/start {…, sandboxPolicy:{networkAccess:true}}` → missing field `type`
// Closing them means recording the discriminators of nested tagged unions
// (`UserInput`, `SandboxPolicy`) and per-field scalar types, none of which the
// fixture keeps. Latent as of this contract, and the reason is the same for all
// six: every call site builds these from the adapter's own literals —
// `{type:'text', text}` for input, `sandboxPolicyFor()`'s four-way switch for the
// policy — and every id it sends is already a string. None is assembled from
// caller-supplied structure.
//
// The `SandboxPolicy` entries are the ones to watch, because that union's tags
// are camelCase while `thread/start`'s `SandboxMode` enum is kebab-case, the same
// job sends both, and a fake that validated presence only would answer the
// kebab-case spelling with a success the server refuses. That one is closed where
// it is actually built — codex-app-server-runtime.test.mjs asserts the emitted tag
// against the measured variant list — rather than by teaching this checker to
// guess at nested shapes.
//
// A checker that guessed at those shapes would be the hand-written table this
// module exists to avoid, so the gaps are recorded here instead of half-closed —
// and a change that builds params from caller-supplied structure is the signal
// to generate the nested requirements properly.
export function contractViolation(method, params) {
  const entry = clientRequestContract(method);
  if (!entry) return null;
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return entry.paramsRequired ? missingFieldError('params') : null;
  }
  for (const field of entry.required) {
    if (params[field] === undefined || params[field] === null) return missingFieldError(field);
  }
  return null;
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

// Whether a property may legally be absent from an instance: not listed in
// `required`, or typed nullable. Both spellings mean the same thing to a reader
// of the wire — the field can arrive with no value — and both are recorded,
// because a thread-routable message whose id is legally absent is a normal
// event, while one whose id is *supposed* to be there and is not is drift.
function isOptionalProperty(container, name) {
  const prop = container?.properties?.[name];
  const type = prop && typeof prop === 'object' ? prop.type : null;
  const nullable = Array.isArray(type) ? type.includes('null') : type === 'null';
  return nullable || !(container?.required || []).includes(name);
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
      return { routing: 'threadId', key: `params.${name}`, optional: isOptionalProperty(params, name) };
    }
  }

  // `thread/started` is the 52nd thread-routable notification and the only one
  // that nests the id: it carries the whole `Thread` object, id at
  // `params.thread.id`. Detected by type, not by method name, so a second
  // notification shaped the same way is classified without a code change.
  for (const name of names) {
    if (refName(props[name]) !== 'Thread') continue;
    const thread = deref(props[name], defs);
    if (!thread?.properties?.id) continue;
    return {
      routing: 'nested',
      key: `params.${name}.id`,
      // Optional at either hop means the id can be absent.
      optional: isOptionalProperty(params, name) || isOptionalProperty(thread, 'id'),
    };
  }

  return { routing: 'global', key: null, optional: false };
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
  return variants.map((variant) => {
    const params = deref(variant.properties?.params, defs);
    return {
      method: methodOf(variant, file),
      ...classifyRouting(params, defs),
      paramsType: refName(variant.properties?.params),
      // Whether the ENVELOPE must carry a params object, and which of its fields
      // must be there. Both come from `required` arrays the schema already
      // publishes, and both are enforced by the server before any thread lookup.
      paramsRequired: (variant.required || []).includes('params'),
      required: [...(params?.required || [])].map(String).sort(),
    };
  });
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
    // Not a bare method list any more: the required params travel with the
    // method, because "which fields must be on the wire" is exactly the half of
    // the contract a fake cannot be trusted to remember. `paramsRequired` is
    // per-method too — 8 of the 95 accept a bare envelope with no params at all.
    clientRequests: sortByMethod(distillMethodUnion(schemaDir, 'ClientRequest'))
      .map(({ method, paramsRequired, required }) => ({ method, paramsRequired, required })),
    serverNotifications: sortByMethod(notifications).map(({ method, routing, key, optional }) => ({
      method,
      routing,
      key,
      optional,
    })),
    // `key` is recorded for requests too, not just notifications: the two legacy
    // approval requests are thread-scoped via `params.conversationId`, and a
    // consumer that assumes `params.threadId` because the contract said
    // `threadScoped: true` would fail to match the approval to its job — the
    // request then goes unanswered and the turn blocks forever. The drift guard
    // cannot catch a field the fixture never recorded.
    serverRequests: sortByMethod(requests).map(({ method, routing, key, optional }) => ({
      method,
      threadScoped: routing !== 'global',
      key,
      optional,
    })),
    threadStatusTypes,
    threadActiveFlags,
    approvalDecisions: sortedObject(approvalDecisions),
  };
}

export function serializeContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
