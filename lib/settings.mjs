import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { refuseRealHomeUnderTest } from './hosts/index.mjs';

export function settingsPath(env = process.env) {
  const dir = env.AGENT_COMPANION_HOME || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'agent-companion');
  return refuseRealHomeUnderTest(resolve(dir, 'settings.json'), 'settings file');
}

export function loadSettings(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const isObject = entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    const optionalString = entry => entry === undefined || (typeof entry === 'string' && entry.trim().length > 0);
    if (!isObject(value) || !optionalString(value.companion)) throw new Error('invalid settings structure');
    if (value.companions !== undefined) {
      if (!isObject(value.companions)) throw new Error('invalid companions object');
      for (const entry of Object.values(value.companions)) {
        if (!isObject(entry) || !optionalString(entry.model) || !optionalString(entry.effort)) {
          throw new Error('invalid companion settings');
        }
      }
    }
    return value;
  } catch (err) {
    if (err.code === 'ENOENT' && !lstatSync(path, { throwIfNoEntry: false })) return undefined;
    throw new Error(`Cannot read ${path}: ${err.code || (err instanceof SyntaxError ? 'invalid JSON' : err.message)}`, { cause: err });
  }
}

export function readSettings(path, log = console.warn) {
  try { return loadSettings(path); }
  catch (err) {
    log('WARN', `${err.message}. Treating settings as empty.`);
    return {};
  }
}

export function readDefaultCompanion(env = process.env, log = console.warn, settings) {
  const override = String(env.AGENT_COMPANION_DEFAULT_COMPANION || '').trim();
  if (override) return { companion: override.toLowerCase(), source: 'env' };
  const saved = settings ?? readSettings(settingsPath(env), log);
  const companion = saved?.companion?.trim().toLowerCase();
  return companion ? { companion, source: 'config' } : { companion: null, source: 'unset' };
}
