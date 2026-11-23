// The `codex app-server` protocol contract, distilled and pinned.
//
// The app-server wire carries no protocol version field: its schemas drift with
// the CLI, and breakage surfaces only as a shape mismatch at runtime. That is
// tolerable for most fields and not tolerable for thread identity. The adapter
// filters notifications to its execution's native thread. Historical broker
// multiplexing made a moved id a cross-child routing risk; private per-answer
// connections now isolate that risk, but schema drift still breaks observation.
//
// So the routing table is generated from `codex app-server generate-json-schema`
// rather than hand-written, committed as `codex-app-server-contract.json`, and
// re-derived by the sibling test on every run against the installed codex.
// A schema change then fails the test instead of misrouting. The version the
// fixture was generated from is recorded as PROVENANCE, not as the guard: a
// codex whose version differs but whose distilled schema is identical passes
// (see `compareContracts` below) — only the schema can say whether an upgrade
// changed the wire.
//
// Regenerate with:  node scripts/gen-codex-app-server-contract.mjs
//
// Measured on codex-cli 0.152.1: 81 server notifications (60 flat `threadId`,
// `thread/started` nested at `params.thread.id`, 5 connection-scoped by an
// owner key and dropped by the then-current broker, 15 genuinely global), 10
// server→client requests (8 thread-scoped, two of them via the pre-rename
// `params.conversationId`), 98 client requests. Three of the 60 declare their
// `threadId` optional and nullable, so they carry no thread when the event is
// not about one; that is recorded as `optional` rather than flattened away.
// (The first census, on 0.147.0, was 70/51/1/18; the 0.150.1 delta was purely
// additive. The 0.150.1→0.152.1 delta also moved no routing: two required
// thread-scoped notifications, three client requests, and one item variant.)
//
// The client side records each request's REQUIRED PARAMS, because the second
// way this protocol breaks silently is a call that omits one. The real server
// answers `-32600 "Invalid request: missing field \`x\`"` before it looks at
// anything else, while a hand-written fake answers whatever it is asked — which
// is how `turn/steer` shipped without `expectedTurnId` and `turn/interrupt`
// without `turnId` through three rounds of review, green the whole way. The
// fakes validate against this table now (`contractViolation`), so a call the
// real server would reject fails in `node --test` instead of in the field.
//
// The SERVER side records the same thing about the other direction — the params
// of all 81 notifications and the fields of all 19 `ThreadItem` variants —
// because that direction breaks silently in a third way: a client that reads a
// field the server does not send gets `undefined`, and a hand-written fixture
// that spells the field the same wrong way makes the read look proven. Five of
// those shipped at once on 0.147.0 (`chunk` for `delta`, `files[]` for
// `changes[]`, `input` for `arguments`, `reasoning.text` for `content`/`summary`,
// a top-level `message` for `error.message`), each with a green unit test. The
// test-side frame builders construct every frame through this table now, so a
// fixture that claims a field the schema does not declare fails to build.

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

// The codex the contract was generated from — provenance, not a gate. A
// differing installed version is the cue to compare the live schema (the adapter
// does it once per bridge at startup of a provider, the sibling test on every run); it is never a failure by
// itself. Null only when the fixture itself is unreadable, which
// `codexAppServerContract()` reports properly.
export const CODEX_PINNED_VERSION = LOADED.contract?.codexVersion ?? null;

// `codex --version` prints `codex-cli <semver>`. A binary that prints anything
// else is one we do not recognise, and guessing its version is worse than
// saying so — an unknown binary's schema still gets compared, but it is
// reported as unknown rather than as something it might not be.
export function parseCodexVersion(output) {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(String(output || ''));
  return match ? match[1] : null;
}

// --- Contract comparison ----------------------------------------------------
//
// Why the version is not the guard. Measured 2026-08-28: codex-cli 0.147.0 →
// 0.150.1 added 9 notifications, widened a dozen enums and one approval
// vocabulary, and added one required `Thread` field — and moved nothing. A pin
// on the version string had turned that into a red build with nothing to
// review, and would do the same for a pure bug-fix release. The protocol
// carries no version field, so the only thing that can say whether an upgrade
// changed the wire is the wire's own schema; that is what gets compared, and
// what moved gets CLASSIFIED, because the classes differ by an order of
// magnitude in severity:
//
//   routing — an existing notification or request whose thread-id routing
//             changed. At runtime that is one job's events arriving at another
//             job's bridge, silently. Listed first, always.
//   removed — a method or type the pin knows and the live codex no longer
//             declares; the adapter may still send or expect it.
//   added   — new methods or types. The adapter routes what it knows and the
//             accumulator ignores what it does not, so these are the benign
//             class — but they still change the fixture.
//   changed — a shape that moved without its routing moving (a new required
//             field, a widened enum).
//
// `identical` means the two contracts agree on everything except provenance.

const ROUTING_FIELDS = ['routing', 'key', 'optional', 'threadScoped'];
const METHOD_KEYED_SECTIONS = new Set(['clientRequests', 'serverNotifications', 'serverRequests']);

// Compared canonically (keys sorted at every depth): the distiller already
// sorts, so two distilled contracts agree on order by construction — but a
// hand-edited fixture does not, and its content being right in a different
// order is the byte-layout test's finding, not a schema drift.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}
const sameShape = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fmt = (value) => (value === undefined ? '(absent)' : JSON.stringify(value));

function comparableSections(contract) {
  const out = {};
  for (const [section, value] of Object.entries(contract || {})) {
    if (section === 'codexVersion') continue;
    if (METHOD_KEYED_SECTIONS.has(section)) {
      out[section] = Object.fromEntries((value || []).map((entry) => [entry.method, entry]));
    } else {
      out[section] = value;
    }
  }
  return out;
}

export function compareContracts(pinned, live) {
  const diff = { identical: true, routing: [], removed: [], added: [], changed: [] };
  // Keying by method collapses duplicates, and a duplicate whose last copy
  // matches the pin would otherwise read as identical. The generator has never
  // emitted one; if it does, that is a change.
  for (const section of METHOD_KEYED_SECTIONS) {
    for (const [side, contract] of [['pinned', pinned], ['live', live]]) {
      const list = contract?.[section] || [];
      if (list.length !== new Set(list.map((entry) => entry?.method)).size) {
        diff.changed.push(`${section}: duplicate method entries in the ${side} contract`);
      }
    }
  }
  const a = comparableSections(pinned);
  const b = comparableSections(live);
  for (const section of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const sa = a[section];
    const sb = b[section];
    const keyed = sa && sb && typeof sa === 'object' && typeof sb === 'object' && !Array.isArray(sa) && !Array.isArray(sb);
    if (!keyed) {
      if (!sameShape(sa, sb)) diff.changed.push(section);
      continue;
    }
    for (const name of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const label = `${section}.${name}`;
      const ea = sa[name];
      const eb = sb[name];
      if (ea === undefined) { diff.added.push(label); continue; }
      if (eb === undefined) { diff.removed.push(label); continue; }
      if (sameShape(ea, eb)) continue;
      if (METHOD_KEYED_SECTIONS.has(section)) {
        const moved = ROUTING_FIELDS.filter((field) => !sameShape(ea[field], eb[field]));
        if (moved.length) {
          diff.routing.push(`${label}: ${moved.map((field) => `${field} ${fmt(ea[field])} → ${fmt(eb[field])}`).join(', ')}`);
          continue;
        }
      }
      diff.changed.push(label);
    }
  }
  diff.identical = !(diff.routing.length || diff.removed.length || diff.added.length || diff.changed.length);
  return diff;
}

let notificationsByMethod;

// `key` is a dotted path rooted at the envelope: `params.threadId` for the flat
// cases, `params.thread.id` for thread/started, `params.conversationId` for the
// two legacy approval requests. Reading it anywhere but here re-hand-writes the
// table the fixture exists to generate.
export function readKey(entry, params) {
  if (!entry.key) return null;
  let cursor = { params };
  for (const segment of entry.key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return null;
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' && cursor ? cursor : null;
}

// Resolve which thread owns a server notification.
//
// - `threadId`/`nested` with an id — attribute to that native thread.
// - `global` — the contract says this message has no owning thread; fan it out
//   or drop it.
// - `connection` (notifications only) — no thread, but an `owner` (the
//   subscription / process / watch id) naming the connection that asked for
//   it. The retired broker could not attribute it. The current adapter
//   still drops these unused methods; `connectionScopedNotificationMethods()`
//   also lets it decline them at `initialize` (`capabilities.optOutNotificationMethods`).
// - `unknown` — the installed codex emitted a method this pinned contract has
//   never seen. That is drift, and the caller must say so rather than quietly
//   treating it as global.
// - thread-routable but `threadId === null` — read `optional`: true means the
//   schema declares the id legally absent (three notifications on 0.147.0, e.g.
//   a `warning` that applies to no thread), so handle it like a global one;
//   false means the id moved and the caller is looking at drift.
export function routeNotification(method, params) {
  notificationsByMethod ??= new Map(codexAppServerContract().serverNotifications.map(entry => [entry.method, entry]));
  const entry = notificationsByMethod.get(method);
  if (!entry) return { routing: 'unknown', threadId: null, owner: null, optional: false };
  const id = readKey(entry, params);
  if (entry.routing === 'connection') return { routing: 'connection', threadId: null, owner: id, optional: entry.optional };
  return { routing: entry.routing, threadId: id, owner: null, optional: entry.optional };
}

// The notifications the adapter declines at the handshake: codex honours
// `capabilities.optOutNotificationMethods` per connection (transport.rs at
// rust-v0.150.1), so a message the adapter would only ever drop is never sent.
// Read from the contract, so a regeneration that classifies a new owner-keyed
// notification declines it the same day.
export function connectionScopedNotificationMethods() {
  return codexAppServerContract().serverNotifications
    .filter((entry) => entry.routing === 'connection')
    .map((entry) => entry.method);
}

// A field tag reads `<type>` or `<type>?`, the `?` meaning the schema does not
// list the field in `required`. Types are the JSON scalars (`string`, `integer`,
// `number`, `boolean`), `X[]` for arrays, `enum:a|b|c` for a closed choice, the
// schema's own name for a structured type (`ThreadItem`, `Turn`), or `any` where
// the schema accepts anything.
//
// Exported because the test-side frame builders SYNTHESISE from these tags as
// well as check against them — a builder that had to re-parse the vocabulary
// would be a second reading of the same string, which is the drift this module
// exists to stop.
export function parseFieldTag(tag) {
  const optional = tag.endsWith('?');
  const type = optional ? tag.slice(0, -1) : tag;
  const array = type.endsWith('[]');
  const element = array ? type.slice(0, -2) : type;
  return {
    type,
    optional,
    array,
    element,
    // A closed vocabulary, or null. `enum:` cannot collide with a type name:
    // the schema's own names are capitalised and the scalars are single words.
    vocabulary: element.startsWith('enum:') ? element.slice('enum:'.length).split('|') : null,
    // The schema's own name for a structured type, or null. Capitalisation is
    // the discriminator, and it is the schema's, not ours: every JSON scalar and
    // both wildcards (`any`, `object`) are lower-case.
    named: /^[A-Z]/.test(element) ? element : null,
  };
}

// --------------------------------------------------------------- distillation
//
// `codex app-server generate-json-schema --out DIR` writes 2.9 MB across 285
// files on 0.147.0 — 37 per-type schemas at the top level (the aggregate
// `codex_app_server_protocol.schemas.json` is 606 KB of that by itself) plus
// v1/ and v2/ subdirectories. Committing that raw would make the drift diff
// unreadable, so this distils the six things the protocol adapter and tests depend
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

// A closed string vocabulary, however the schema spells it: a bare `enum`, or a
// `oneOf` of single-valued string enums — which is what a Rust enum whose
// variants carry doc comments generates. `MessagePhase` is the one that matters:
// its two words are `commentary` and `final_answer`, and `final_answer` is what
// decides which message becomes the digest's answer.
//
// Deliberately stricter than `stringVariantsOf` below, which also accepts
// payload-carrying variants: those are words to ANSWER with, while a variant
// carrying a payload is an object, not a string, and must not be tagged as one
// (`PatchChangeKind` is exactly that shape).
function closedStringEnum(schema) {
  if (schema.type === 'string' && Array.isArray(schema.enum)) return schema.enum.map(String);
  if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) return null;
  const words = [];
  for (const variant of schema.oneOf) {
    if (!variant || variant.type !== 'string' || !Array.isArray(variant.enum)) return null;
    words.push(...variant.enum.map(String));
  }
  return words;
}

// The one-line type tag the fixture records for a property. Named types keep
// their name (`ThreadItem`, `Turn`) because that is the only handle a reader has
// on a shape this contract does not otherwise record, while a named wrapper over
// a plain scalar (`LegacyAppPathString` -> string) is recorded as the scalar: the
// name buys nothing there. Closed string enums keep their words, because a fake
// picking a status the server cannot send is the same class of fiction as a
// field name it cannot send.
function typeTag(schema, defs, depth = 0) {
  if (schema === true) return 'any';                       // serde_json::Value
  if (!schema || typeof schema !== 'object') return 'any';
  if (depth > 8) throw new Error('codex app-server schema: type cycle');

  const name = refName(schema);
  if (name) {
    const inner = typeTag(deref(schema, defs), defs, depth + 1);
    return inner === 'object' ? name : inner;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) return typeTag(schema.allOf[0], defs, depth + 1);
  if (Array.isArray(schema.anyOf)) {
    // `T | null` is how the schema spells "nullable"; the nullability is already
    // carried by the `?` suffix, so the tag is the non-null half.
    const nonNull = schema.anyOf.filter((variant) => !(variant && variant.type === 'null'));
    if (nonNull.length === 1) return typeTag(nonNull[0], defs, depth + 1);
  }

  const words = closedStringEnum(schema);
  if (words) return `enum:${words.join('|')}`;

  let type = schema.type;
  if (Array.isArray(type)) {
    const named = type.filter((t) => t !== 'null');
    type = named.length === 1 ? named[0] : null;
  }
  if (type === 'array') return `${typeTag(schema.items, defs, depth + 1)}[]`;
  if (type) return type;
  return schema.properties || schema.oneOf ? 'object' : 'any';
}

// name -> tag for every property the container declares, sorted, with `?` on the
// ones `required` omits. This is the whole shape: a property absent from here is
// one the server does not send.
function fieldMap(container, defs) {
  const props = container?.properties || {};
  const required = new Set(container?.required || []);
  const out = {};
  for (const name of Object.keys(props).sort()) {
    out[name] = `${typeTag(props[name], defs)}${required.has(name) ? '' : '?'}`;
  }
  return out;
}

// A params property carries the owning thread id when it is named `threadId` or
// when its declared type is the schema's own `ThreadId`. The second clause is
// what makes the two legacy approval requests thread-scoped: they still spell it
// `conversationId`, but the schema types that field as `ThreadId`, i.e. it is
// the same id under the pre-rename name.
function classifyRouting(params, defs, { connectionScoped = false } = {}) {
  const props = params?.properties || {};
  // Sorted so a reordering of the generator's key order cannot change which
  // property wins when a params object ever carries two thread-typed fields.
  const names = Object.keys(props).sort();

  for (const name of names) {
    if (name === 'threadId' || refName(props[name]) === 'ThreadId') {
      return { routing: 'threadId', key: `params.${name}`, optional: isOptionalProperty(params, name) };
    }
  }

  // `thread/started` is the 59th thread-routable notification and the only one
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

  // Connection-scoped: no thread, but an owner key naming the REQUEST — and so
  // the connection — that created it. Codex sends these with
  // `send_server_notification_to_connection` to that one connection, never as
  // a broadcast (codex-rs/app-server/src/request_processors/mcp_event_stream.rs,
  // command_exec.rs, process_exec_processor.rs, fs_watch.rs at rust-v0.150.1).
  // Historically, through a shared broker owning ONE connection there is nobody to
  // attribute them to, so "global" — fan out to every bridge — would hand one
  // job's process output or hosted-app events to every other job. The key
  // set is a table, not a shape rule: `sessionId`, `loginId` and `importId`
  // look identical and are genuinely broadcast by codex. Notifications only:
  // a server→client REQUEST is answered, not delivered, and its serializer
  // would collapse this class into `threadScoped: true` with an owner id read
  // as a thread id.
  if (connectionScoped) {
    for (const name of names) {
      if (CONNECTION_OWNER_KEYS.has(name)) {
        return { routing: 'connection', key: `params.${name}`, optional: isOptionalProperty(params, name) };
      }
    }
  }

  return { routing: 'global', key: null, optional: false };
}

const CONNECTION_OWNER_KEYS = new Set(['subscriptionId', 'processId', 'processHandle', 'watchId']);

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
      ...classifyRouting(params, defs, { connectionScoped: file === 'ServerNotification' }),
      paramsType: refName(variant.properties?.params),
      // Whether the ENVELOPE must carry a params object, and which of its fields
      // must be there. Both come from `required` arrays the schema already
      // publishes, and both are enforced by the server before any thread lookup.
      paramsRequired: (variant.required || []).includes('params'),
      required: [...(params?.required || [])].map(String).sort(),
      // The SHAPE of those params, for the server->client direction: every
      // property the schema declares, with its type. `null` for a method that
      // carries no params object at all.
      fields: params ? fieldMap(params, defs) : null,
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

// The `ThreadItem` union: the payload every `item/started`, `item/completed` and
// `turn/completed` replay carries, and the one shape the accumulator reads most
// and validated least. 18 variants on 0.147.0, keyed by their `type` literal —
// which is why the discriminator is also recorded inside each map: an entry that
// is a complete description of the frame is one a reader never has to guess at.
//
// Inlined into `ServerNotification.json` like `ThreadStatus`, so it is read from
// the same file rather than from a per-type schema that could drift from it.
function distillThreadItems(dir) {
  const schema = readSchema(dir, 'ServerNotification');
  const defs = definitionsOf(schema);
  const union = defs.ThreadItem;
  if (!Array.isArray(union?.oneOf) || !union.oneOf.length) {
    throw new Error('codex app-server schema: ThreadItem not found in ServerNotification.json');
  }
  const out = {};
  for (const variant of union.oneOf) {
    const type = variant?.properties?.type;
    const name = typeof type?.const === 'string' ? type.const : type?.enum?.[0];
    if (!name) throw new Error('codex app-server schema: ThreadItem variant has no `type` literal');
    out[String(name)] = fieldMap(variant, defs);
  }
  return sortedObject(out);
}

// A named type as one entry: a field map for a plain object, an array of
// alternatives for a union. A union alternative is either a field map or a bare
// tag, because 0.147.0 has both in one union — `SessionSource` is
// `"cli"|"vscode"|… | {custom} | {subAgent}` — and a representation that could
// only express the object half would have to drop the words.
function shapeOfDefinition(def, defs) {
  if (!Array.isArray(def.oneOf)) return fieldMap(def, defs);
  return def.oneOf.map((variant) => {
    const resolved = deref(variant, defs);
    const words = closedStringEnum(resolved);
    return words ? `enum:${words.join('|')}` : fieldMap(resolved, defs);
  });
}

// The named types a recorded shape says a frame MUST carry. Optional fields are
// deliberately not followed: a builder can omit one, so its shape is never
// needed to construct a legal frame — and following them pulls in most of the
// 114 object types in the dump for no gain (measured: 27 types vs 66).
function requiredTypeNames(shape, out = []) {
  if (Array.isArray(shape)) {
    for (const alternative of shape) if (typeof alternative !== 'string') requiredTypeNames(alternative, out);
    return out;
  }
  for (const tag of Object.values(shape)) {
    const { optional, named } = parseFieldTag(tag);
    if (!optional && named) out.push(named);
  }
  return out;
}

// The nested shapes, so a frame is checkable and buildable all the way down
// rather than only at its top level. Seeded from the two things a bridge's
// accumulator is fed — the params of the THREAD-ROUTED notifications and the
// `ThreadItem` variants — and closed over required fields only.
//
// The global notifications are not seeds: no current turn accumulator reads
// their payload, so recording the shapes under
// `account/*`, `app/*` and friends would grow the diff a human is supposed to
// read without making any frame checkable that was not already.
//
// Measured on 0.147.0: 26 types, which is what makes `turn/completed`'s
// `{turn:{status,error,items}}` and `fileChange`'s `changes[].kind.type` real
// rather than opaque — the two nested reads the accumulator got wrong.
// `ThreadItem` is skipped because it has its own top-level map above.
function distillStructuredTypes(dir, seedShapes) {
  const defs = definitionsOf(readSchema(dir, 'ServerNotification'));
  const out = {};
  const queue = seedShapes.flatMap((shape) => requiredTypeNames(shape));
  while (queue.length) {
    const name = queue.pop();
    if (name === 'ThreadItem' || out[name]) continue;
    const def = defs[name];
    if (!def) throw new Error(`codex app-server schema: ${name} is referenced but not defined in ServerNotification.json`);
    const shape = shapeOfDefinition(def, defs);
    out[name] = shape;
    queue.push(...requiredTypeNames(shape));
  }
  return sortedObject(out);
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
  const threadItems = distillThreadItems(schemaDir);
  // Seeded from the THREAD-routed notifications only: those are the frames the
  // fakes build. Connection-scoped ones are dropped by the adapter, so their
  // sub-shapes would widen the closure for frames nothing constructs.
  const structuredTypes = distillStructuredTypes(schemaDir, [
    ...notifications.filter((entry) => (entry.routing === 'threadId' || entry.routing === 'nested') && entry.fields).map((entry) => entry.fields),
    ...Object.values(threadItems),
  ]);

  return {
    codexVersion,
    // Not a bare method list any more: the required params travel with the
    // method, because "which fields must be on the wire" is exactly the half of
    // the contract a fake cannot be trusted to remember. `paramsRequired` is
    // per-method too — 8 of the 95 accept a bare envelope with no params at all.
    clientRequests: sortByMethod(distillMethodUnion(schemaDir, 'ClientRequest'))
      .map(({ method, paramsRequired, required }) => ({ method, paramsRequired, required })),
    // `params` is the server->client half of the same bargain the client side
    // struck above: what must be on the wire, and — because the property list is
    // exhaustive — what must NOT be. `optional` above is the thread ID's, not
    // the params'; each field carries its own `?`.
    serverNotifications: sortByMethod(notifications).map(({ method, routing, key, optional, fields }) => ({
      method,
      routing,
      key,
      optional,
      params: fields,
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
    threadItems,
    structuredTypes,
    threadStatusTypes,
    threadActiveFlags,
    approvalDecisions: sortedObject(approvalDecisions),
  };
}

export function serializeContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
