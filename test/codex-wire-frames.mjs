// The server→client half of the fixture problem, closed the way the client half
// already was: every notification and every `ThreadItem` a test pushes at the
// bridge is BUILT from the pinned contract instead of written out by hand.
//
// The hand-written half is what this replaces, and it is worth naming what it
// cost. Five reads in the app-server accumulator named fields codex-cli 0.147.0
// does not send — `chunk` for `delta`, `files[]` for `changes[]`, `input` for
// `arguments`, `reasoning.text` for `content`/`summary`, a top-level `message`
// for `error.message` — and every one of them had a green unit test, because the
// same author wrote the reader and the fixture and they agreed with each other
// rather than with the wire. `contractViolation` had closed exactly this class in
// the client→server direction; this is the same guard pointed the other way.
//
// Two rules do the work:
//   - a field the schema does not declare is REFUSED. That is the one that makes
//     a guess unwritable: a missing `delta` would be caught by the reader failing
//     anyway, while an invented `chunk` sitting beside a filled `delta` sails
//     through any presence-only check and keeps the wrong read green.
//   - every required field the caller omits is FILLED from its recorded type, so
//     a frame is complete without a test having to spell out `turnId`,
//     `completedAtMs`, `commandActions` and the rest. A test writes the fields it
//     asserts on; the builder writes the ones the protocol demands.
//
// It is a fixture, not a test — `node --test` only collects `*.test.mjs` — and it
// lives beside the two fakes for the same reason they live here: the suites that
// push frames at the bridge must agree about what a frame is.
//
// It never spawns anything and never spends a token.

import {
  CODEX_PINNED_VERSION,
  parseFieldTag,
  serverFrameViolation,
  serverNotificationContract,
  structuredTypeContract,
  threadItemContract,
  threadItemViolation,
} from '../lib/codex-app-server-contract.mjs';

// A synthesised string says so. A test that ends up asserting on one is reading a
// field it never set, which is worth seeing in the failure message rather than
// puzzling over `''` or `'x'`.
const placeholder = (name) => `<${name}>`;

// One value for one tag, invented only where the contract says a value must be
// there. Unions take their first alternative: the schema lists them in the Rust
// declaration order, so the choice is stable across regenerations, and a test
// that cares which variant it gets passes one.
function synthesize(name, tag, depth = 0) {
  const { array, element, vocabulary, named } = parseFieldTag(tag);
  if (array) return [];
  if (vocabulary) return vocabulary[0];
  if (element === 'any' || element === 'object') return {};
  if (element === 'integer' || element === 'number') return 0;
  if (element === 'boolean') return false;
  if (!named) return placeholder(name);
  // `ThreadItem` is a union with no single sensible default — a frame that needs
  // one needs a specific item — so it is the one named type a caller must pass.
  if (named === 'ThreadItem') {
    throw new Error(`codex wire frames: \`${name}\` is a ThreadItem; pass one built with threadItem()`);
  }
  const shape = structuredTypeContract(named);
  if (!shape) throw new Error(`codex wire frames: no recorded shape for \`${named}\` — pass \`${name}\` explicitly`);
  if (depth > 6) throw new Error(`codex wire frames: \`${named}\` nests deeper than any 0.147.0 frame does`);
  if (!Array.isArray(shape)) return fill(shape, {}, depth + 1);
  const [first] = shape;
  return typeof first === 'string' ? synthesize(name, first, depth + 1) : fill(first, {}, depth + 1);
}

// Which union alternative a supplied value means, by its `type` discriminator.
// Null when the union is not type-tagged (`SessionSource` mixes bare words with
// objects) or the value names no variant — both cases are left to the validator,
// which has a better sentence for them than a filler does.
function matchingAlternative(shape, value) {
  if (!value || typeof value !== 'object') return null;
  for (const alternative of shape) {
    if (typeof alternative === 'string') continue;
    const tag = alternative.type;
    if (!tag) continue;
    const { vocabulary } = parseFieldTag(tag);
    if (vocabulary && vocabulary.includes(String(value.type))) return alternative;
  }
  return null;
}

// Recurse into a supplied value so a half-written sub-object is completed too:
// `{turn: {status: 'completed'}}` is how a test says "a completed turn", and the
// `id` and `items` the schema requires are the builder's business, not the
// test's.
function fillValue(name, tag, value, depth) {
  const { array, element, named } = parseFieldTag(tag);
  if (array) {
    return Array.isArray(value) ? value.map((entry, i) => fillValue(`${name}[${i}]`, element, entry, depth)) : value;
  }
  if (!named || named === 'ThreadItem') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const shape = structuredTypeContract(named);
  if (!shape) return value;
  if (!Array.isArray(shape)) return fill(shape, value, depth + 1);
  const alternative = matchingAlternative(shape, value);
  return alternative ? fill(alternative, value, depth + 1) : value;
}

// Supplied fields first, in the schema's own key order, then the required ones
// the caller left out. Unknown keys are carried through rather than dropped —
// the validator's complaint about them is the whole point, and a filler that
// swallowed them would hide it.
function fill(shape, supplied, depth = 0) {
  const out = {};
  for (const [name, tag] of Object.entries(shape)) {
    if (supplied[name] !== undefined) out[name] = fillValue(name, tag, supplied[name], depth);
    else if (!parseFieldTag(tag).optional) out[name] = synthesize(name, tag, depth);
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (!(name in shape)) out[name] = value;
  }
  return out;
}

function refuse(what, violation) {
  throw new Error(`codex wire frames: ${what} does not match codex-cli ${CODEX_PINNED_VERSION}'s schema — ${violation}`);
}

// A `ThreadItem`, filled and checked. `type` is separate from the fields because
// it is the discriminator: passing it inside the object would let a caller build
// one variant's fields under another's name.
export function threadItem(type, fields = {}) {
  const shape = threadItemContract(type);
  if (!shape) refuse(`a \`${type}\` item`, threadItemViolation({ type }));
  const item = fill(shape, { ...fields, type });
  const violation = threadItemViolation(item);
  if (violation) refuse(`a \`${type}\` item`, violation);
  return item;
}

// One server→client notification frame, ready to hand to `accumulator.push()` or
// to write down the socket.
//
// A method this contract has never seen is REFUSED rather than passed through:
// `serverFrameViolation` returns null for one (it cannot check what it has never
// heard of), so a builder that trusted that answer would let every typo and
// every stale method name through silently. A test that means to model drift
// says so with `driftNote`.
export function note(method, params = {}) {
  const entry = serverNotificationContract(method);
  if (!entry) {
    throw new Error(
      `codex wire frames: \`${method}\` is not a server notification of codex-cli ${CODEX_PINNED_VERSION}. `
      + 'Use driftNote() if the test means to model a method this pin has never seen.',
    );
  }
  const filled = entry.params ? fill(entry.params, params) : undefined;
  const violation = serverFrameViolation(method, filled);
  if (violation) refuse(method, violation);
  return filled === undefined
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', method, params: filled };
}

// The deliberate exception: a frame whose whole point is that this pin does not
// know the method — a codex that grew a notification, or the broker's own
// `broker/*` frames, which are not app-server methods at all. Unchecked by
// construction, and named so that a reader can tell it apart from a builder call
// that happens to have been written wrong.
export function driftNote(method, params = {}) {
  if (serverNotificationContract(method)) {
    throw new Error(`codex wire frames: \`${method}\` IS in the pinned contract — build it with note()`);
  }
  return { jsonrpc: '2.0', method, params };
}
