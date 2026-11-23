import {
  CODEX_PINNED_VERSION, REGENERATE_COMMAND, SCHEMA_GENERATOR_ARGS,
  codexAppServerContract, parseFieldTag, readKey,
} from '../lib/codex-app-server-contract.mjs';

const DRIFT_LINES_PER_CLASS = 12;
const describeInstalled = (installed) => (installed ? `codex-cli ${installed}` : 'an unrecognised codex version');

export function codexVersionMismatchMessage(installed) {
  return `codex app-server contract was generated from codex-cli ${CODEX_PINNED_VERSION}; this machine has ${describeInstalled(installed)}. `
    + 'The protocol carries no version field, so the version alone proves nothing either way — the live schema is what gets compared.';
}

export function contractMatchMessage(installed) {
  const record = installed
    ? `Run ${REGENERATE_COMMAND} to record the new provenance; nothing else changes.`
    : 'Provenance cannot be recorded until `codex --version` prints a version the generator can read; nothing else changes.';
  return `${describeInstalled(installed)}: the live app-server schema matches the pinned contract (generated from codex-cli ${CODEX_PINNED_VERSION}). ${record}`;
}

export function contractUnverifiedMessage(installed, reason) {
  return `could not verify the app-server wire contract against ${describeInstalled(installed)}: ${reason || 'no detail'}. `
    + `The pinned contract (codex-cli ${CODEX_PINNED_VERSION}) is being used unverified; a schema change would surface only as a runtime shape mismatch. `
    + `Check \`codex ${SCHEMA_GENERATOR_ARGS.join(' ')} <dir>\` by hand, then: ${REGENERATE_COMMAND}`;
}

export function contractDriftMessage(installed, diff) {
  const lines = [
    `${describeInstalled(installed)} no longer matches the pinned app-server contract (generated from codex-cli ${CODEX_PINNED_VERSION}).`,
  ];
  const section = (title, items, note) => {
    if (!items.length) return;
    lines.push(`  ${title} (${items.length})${note ? ` — ${note}` : ''}:`);
    for (const item of items.slice(0, DRIFT_LINES_PER_CLASS)) lines.push(`    ${item}`);
    if (items.length > DRIFT_LINES_PER_CLASS) lines.push(`    … and ${items.length - DRIFT_LINES_PER_CLASS} more`);
  };
  section('ROUTING MOVED', diff.routing, 'a live misrouting bug: one thread\'s events would reach another job\'s bridge');
  section('removed', diff.removed, 'the adapter may still send or expect these');
  section('added', diff.added);
  section('shape changed', diff.changed);
  lines.push(`Review these against the adapter's routing and frames, then regenerate the fixture: ${REGENERATE_COMMAND}`);
  return lines.join('\n');
}

function routingOfKey(key) {
  if (!key) return 'global';
  return key.split('.').length > 2 ? 'nested' : 'threadId';
}

export function routeRequest(method, params) {
  const entry = codexAppServerContract().serverRequests.find(entry => entry.method === method);
  if (!entry) return { routing: 'unknown', threadId: null, optional: false };
  return { routing: routingOfKey(entry.key), threadId: readKey(entry, params), optional: entry.optional };
}

// Only these request results confer ownership of the returned thread.
export const THREAD_OWNERSHIP_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);

export const JSONRPC_INVALID_REQUEST = -32600;

function missingFieldError(field) {
  return { code: JSONRPC_INVALID_REQUEST, message: `Invalid request: missing field \`${field}\`` };
}

export function clientRequestContract(method) {
  return codexAppServerContract().clientRequests.find(entry => entry.method === method) || null;
}

export function unhandledMethodError(method) {
  return {
    code: JSONRPC_INVALID_REQUEST,
    message: `Invalid request: unknown variant \`${method}\` — this fake has no faithful answer for it. `
      + 'The real codex app-server either refuses it as an unknown variant or answers it for real; '
      + 'either way a success invented here would prove nothing.',
  };
}

// Match top-level required params. The schema does not preserve serde field order.
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

// Bound recursion through named types in the schema.
const MAX_SHAPE_DEPTH = 6;

function fieldsViolation(label, fields, value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${label} must be an object`;
  for (const [name, tag] of Object.entries(fields)) {
    const { type, optional } = parseFieldTag(tag);
    if (value[name] === undefined || value[name] === null) {
      if (optional) continue;
      return `${label} is missing required field \`${name}\` (${type})`;
    }
    const nested = valueViolation(`${label}.${name}`, tag, value[name], depth);
    if (nested) return nested;
  }
  for (const name of Object.keys(value)) {
    // `Object.hasOwn`, not `name in fields`: the shapes are JSON.parse output,
    // so they inherit Object.prototype and `in` answers true for `constructor`,
    // `toString` and ten more — the twelve field names that would have walked
    // straight through the rule this loop IS. No 0.147.0 field is spelt any of
    // them, so nothing is measured here; the guarantee is just meant to hold
    // without depending on that.
    if (Object.hasOwn(fields, name)) continue;
    const known = Object.keys(fields).join(', ') || 'no fields at all';
    return `${label} carries \`${name}\`, which codex-cli ${CODEX_PINNED_VERSION} does not send (it sends ${known})`;
  }
  return null;
}

function valueViolation(label, tag, value, depth = 0) {
  const { array, element, vocabulary, named } = parseFieldTag(tag);
  if (array) {
    if (!Array.isArray(value)) return `${label} must be an array of ${element}`;
    for (let i = 0; i < value.length; i++) {
      const bad = valueViolation(`${label}[${i}]`, element, value[i], depth);
      if (bad) return bad;
    }
    return null;
  }
  if (vocabulary) {
    return vocabulary.includes(String(value)) ? null
      : `${label} is \`${value}\`, which is not one of ${vocabulary.join(', ')}`;
  }
  if (element === 'any') return null;                       // serde_json::Value
  if (named) return shapeViolation(label, named, value, depth);
  if (element === 'object') {
    return value && typeof value === 'object' && !Array.isArray(value) ? null : `${label} must be an object`;
  }
  if (element === 'integer' || element === 'number') {
    return typeof value === 'number' ? null : `${label} must be a ${element}, not a ${typeof value}`;
  }
  return typeof value === element ? null : `${label} must be a ${element}, not a ${typeof value}`;
}

function shapeViolation(label, named, value, depth) {
  const shape = named === 'ThreadItem' ? null : structuredTypeContract(named);
  if (Array.isArray(shape)) {
    if (depth >= MAX_SHAPE_DEPTH) return null;
    // Satisfying ONE alternative is the whole requirement, so the alternatives'
    // individual complaints are noise. Report the union instead.
    for (const alternative of shape) {
      const bad = typeof alternative === 'string'
        ? valueViolation(label, alternative, value, depth + 1)
        : fieldsViolation(label, alternative, value, depth + 1);
      if (!bad) return null;
    }
    return `${label} matches none of ${named}'s ${shape.length} variants (${describeUnion(shape)})`;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${label} must be an object`;
  if (depth >= MAX_SHAPE_DEPTH) return null;
  if (named === 'ThreadItem') {
    const nested = threadItemViolation(value, depth + 1);
    return nested ? `${label}: ${nested}` : null;
  }
  return shape ? fieldsViolation(label, shape, value, depth + 1) : null;
}

function describeUnion(shape) {
  return shape
    .map((alternative) => (typeof alternative === 'string' ? alternative : `{${Object.keys(alternative).join(', ')}}`))
    .join(' | ');
}

export function serverNotificationContract(method) {
  return codexAppServerContract().serverNotifications.find(entry => entry.method === method) || null;
}

export function threadItemContract(type) {
  return codexAppServerContract().threadItems[type] || null;
}

export function structuredTypeContract(name) {
  return codexAppServerContract().structuredTypes[name] || null;
}

export function serverFrameViolation(method, params) {
  const entry = serverNotificationContract(method);
  if (!entry) return null;
  if (!entry.params) {
    return params === undefined || params === null ? null : `${method} carries no params on this protocol`;
  }
  return fieldsViolation(`${method} params`, entry.params, params);
}

export function threadItemViolation(item, depth = 0) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'a ThreadItem must be an object';
  const type = String(item.type || '');
  const fields = threadItemContract(type);
  if (!fields) {
    const known = Object.keys(codexAppServerContract().threadItems);
    return `\`${type || '(no type)'}\` is not one of codex-cli ${CODEX_PINNED_VERSION}'s ${known.length} `
      + `ThreadItem variants (${known.join(', ')})`;
  }
  return fieldsViolation(`${type} item`, fields, item, depth);
}
