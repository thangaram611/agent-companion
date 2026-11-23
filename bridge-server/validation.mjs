import {
  statSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';

import { bridgeLogFile, PRIVATE_FILE_MODE, chmodPrivate } from '../lib/runtime-paths.mjs';

// --- Logger -----------------------------------------------------------------

export const BRIDGE_LOG_MAX_BYTES = 1024 * 1024;

export function getBridgeLogFile() {
  return bridgeLogFile();
}

export function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${ts} [${level}] ${msg}\n`;
  const logFile = getBridgeLogFile();
  try {
    if (existsSync(logFile) && statSync(logFile).size > BRIDGE_LOG_MAX_BYTES) {
      // Keep the previous log in .bak for diagnostics.
      try {
        renameSync(logFile, logFile + '.bak');
        chmodPrivate(logFile + '.bak');
      }
      catch { writeFileSync(logFile, '', { mode: PRIVATE_FILE_MODE }); chmodPrivate(logFile); }
    }
    appendFileSync(logFile, line, { mode: PRIVATE_FILE_MODE });
    chmodPrivate(logFile);
  } catch { /* best-effort */ }
  if (level === 'WARN' || level === 'ERROR' || level === 'FATAL') {
    try { process.stderr.write(line); } catch {}
  }
}

export function invalid(message) {
  throw Object.assign(new Error('agent: ' + message), { code: 'INVALID_ARGUMENTS' });
}

export function string(value, key) {
  if (typeof value !== 'string' || !value.length) invalid(key + ' must be a nonempty string');
  return value;
}

export function optionalString(value, key) {
  if (value == null) return undefined;
  if (typeof value !== 'string') invalid(key + ' must be a string');
  return value.trim() || undefined;
}

export function recordId(value, key) {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(string(value, key))) invalid('invalid ' + key);
  return value;
}
export function number(value, key) {
  if (!Number.isFinite(value)) invalid(key + ' must be a number');
  return value;
}
export function boolean(value, key) {
  if (typeof value !== 'boolean') invalid(key + ' must be a boolean');
  return value;
}

export function assertCwd(value) {
  if (typeof value === 'string' && isAbsolute(value)) {
    try { if (statSync(value).isDirectory()) return value; } catch {}
  }
  throw Object.assign(new Error('cwd must be an absolute path to an existing directory'), { code: 'INVALID_CWD' });
}

export function validateFields(args, { fields, inputSchema }) {
  const values = {};
  const required = inputSchema.required ?? [];
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(fields, key)) invalid('unknown field "' + key + '"');
    // Smaller lead models fill every optional field, with "" or null for "none" (measured: gpt-oss:20b in
    // OpenCode sent thread "" and mode "" on a new send). An empty optional value means omitted, unless the
    // field gives "" its own meaning.
    if ((value === null || value === '') && !required.includes(key) && !fields[key].keepEmpty) continue;
    values[key] = fields[key].check(value, key);
  }
  for (const key of required) {
    if (values[key] === undefined) invalid(key + ' is required');
  }
  return values;
}
