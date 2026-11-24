// The defaults command and its API for the live view. Only Codex and OpenCode
// have zero-turn native reads. Neither probe opens a history or sends input.
import { aborted } from 'node:util';
import { listCompanionIds, COMPANION_IDS, getCompanionById } from '../../lib/companion-registry.mjs';
import {
  settingsPath, readSettings, isModelAllowedFor,
  readDefaultModel, readDefaultEffort, readDefaultCompanion, writeCompanionDefaults, writeDefaultCompanion, clearDefaultCompanion,
} from '../../lib/state.mjs';
import { CodexAdapter, validateCodexEffort } from '../adapters/codex.mjs';
import { opencodeProvider, openCodeEffortVariant } from '../adapters/opencode.mjs';
import { ProcessSupervisor } from '../controller/process-supervisor.mjs';
import { bounded, systemClock } from '../controller/clock.mjs';
import { lastRuns } from '../last-runs.mjs';
import { age, one } from './rows.mjs';

const usesServer = id => getCompanionById(id).capabilities.serverMode;
const usesAppServer = id => getCompanionById(id).runtime.adapterKind === 'app-server';
const unavailable = reason => ({ model: null, effort: null, reason });
const reason = err => one([err.message, err.cause?.message].filter(Boolean).join(': ')).slice(0, 300);

async function readNative(adapter, codex, needModels) {
  let native, configError, models, catalogError;
  try { native = codex ? await adapter.readConfig() : await adapter.defaultModel(); }
  catch (err) { configError = reason(err); }
  if (needModels || (codex && native && (!native.model || !native.model_reasoning_effort))) {
    try {
      const list = await adapter.listModels();
      if (!Array.isArray(list) || !list.every(m => codex ? m?.model : m?.providerID && m.id)) throw new Error('invalid model list');
      models = list;
    } catch (err) { catalogError = reason(err); }
  }
  let inherit;
  if (configError) inherit = unavailable(configError);
  else if (codex && native) {
    const model = native.model ?? models?.find(m => m.isDefault)?.model;
    const effort = native.model_reasoning_effort ?? models?.find(m => m.model === model)?.defaultReasoningEffort ?? null;
    inherit = model ? { model, effort, source: native.model ? 'config/read' : 'model/list' }
      : unavailable(catalogError || 'no default model in model/list');
  } else if (!codex && native?.providerID && native.id) {
    inherit = { model: native.providerID + '/' + native.id, effort: native.variant ?? null, source: '/model/default' };
  } else inherit = unavailable(codex ? 'config/read returned no config' : '/model/default returned no model');
  return { inherit, models, catalogError };
}

async function probe(id, needModels, { cwd, env, createSupervisor, timeoutMs, signal }) {
  const codex = usesAppServer(id);
  const adapter = codex ? new CodexAdapter({ env }) : opencodeProvider({ env }).create();
  const supervisor = createSupervisor();
  const read = async () => {
    await adapter.start({ cwd, env, supervisor, checkContract: false });
    return readNative(adapter, codex, needModels);
  };
  try {
    const operation = () => signal
      ? Promise.race([read(), aborted(signal, adapter).then(() => signal.throwIfAborted())])
      : read();
    return await bounded(systemClock, operation, timeoutMs, id + ' defaults read timed out');
  } finally {
    // Census and terminate before closing stdin so we can still identify
    // children through the root, including when a read or startup timed out.
    let cleanup;
    try { cleanup = await supervisor.terminate({ graceMs: 150 }); }
    finally { await bounded(systemClock, () => adapter.close(), 1000, id + ' close timed out'); }
    if (!cleanup.gone) throw new Error(cleanup.error || id + ' process tree still running');
  }
}

function validateQuery(query) {
  const { companion, model, defaultCompanion, effort } = query;
  for (const [key, value] of Object.entries(query)) {
    if (!['companion', 'model', 'defaultCompanion', 'effort'].includes(key)) throw new Error('unknown setting ' + key);
    if (typeof value !== 'string' || !value.trim()) throw new Error('empty ' + (key === 'defaultCompanion' ? 'companion' : key));
  }
  if (companion !== undefined && !COMPANION_IDS.has(companion)) throw new Error('unknown companion ' + companion);
  if (defaultCompanion !== undefined) {
    if (Object.keys(query).length !== 1) throw new Error('set the default companion on its own');
    if (defaultCompanion !== 'inherit' && !COMPANION_IDS.has(defaultCompanion)) throw new Error('unknown companion ' + defaultCompanion);
  }
  if ((model !== undefined || effort !== undefined) && !companion) throw new Error('name a companion before model or effort');
  if (model !== undefined && model !== 'inherit' && !isModelAllowedFor(companion, model)) {
    throw new Error('invalid model for ' + companion + ': ' + model);
  }
}

function validateSelection(id, changes, saved, native) {
  const model = Object.hasOwn(changes, 'model') ? changes.model : saved?.model;
  const effort = Object.hasOwn(changes, 'effort') ? changes.effort : saved?.effort;
  const levels = getCompanionById(id).capabilities.effortLevels;
  if (levels && effort && !levels.includes(effort)) throw new Error('invalid ' + id + ' effort. Use one of: ' + levels.join(', '));
  if (!usesServer(id)) return;
  if (native.catalogError) throw new Error(id + ' model list unavailable: ' + native.catalogError);
  const selected = model ?? native.inherit.model;
  if (!selected) throw new Error(id + ' inherited model unavailable: ' + native.inherit.reason);
  if (usesAppServer(id)) {
    if (effort) validateCodexEffort(native.models, selected, effort);
  } else {
    const [name, variant, extra] = selected.split('#');
    if (variant === '' || extra !== undefined) throw new Error('invalid OpenCode model variant in ' + selected);
    const entry = native.models.find(m => m.providerID + '/' + m.id === name);
    if (!entry) throw new Error('unknown OpenCode model ' + name);
    if (effort) openCodeEffortVariant(entry, name, effort, variant);
    else if (variant && !entry.variants?.some(v => v.id === variant)) throw new Error('unknown OpenCode variant ' + variant + ' for ' + name);
  }
}

function field(saved, resolved, key) {
  return { saved: saved ?? null, value: resolved[key], source: resolved.source };
}

function companionRow(id, settings, env, native) {
  const saved = settings.companions?.[id] ?? {};
  const { inherit, models } = native;
  const row = {
    model: field(saved.model, readDefaultModel(id, env, undefined, settings), 'model'),
    effort: field(saved.effort, readDefaultEffort(id, env, undefined, settings), 'effort'),
    inherit,
  };
  if (getCompanionById(id).capabilities.acp && (saved.model || saved.effort)) {
    row.validation = 'unverified until a session runs';
  }
  const selected = saved.model ?? (saved.effort ? inherit.model : null);
  if (usesAppServer(id) && selected && models && !models.some(m => m.model === selected)) {
    row.validation = "unverified: not in Codex's model list";
  }
  return row;
}

// A query is {}, {companion}, {companion, model?, effort?}, or {defaultCompanion}.
// The return value also supplies the JSON representation. Only "inherit"
// clears a setting. Reads of a single companion never probe another one.
export async function defaults(query = {}, {
  env = process.env, cwd = process.cwd(), createSupervisor = () => new ProcessSupervisor(),
  timeoutMs = 15_000, signal,
} = {}) {
  validateQuery(query);
  signal?.throwIfAborted();
  const { companion, defaultCompanion } = query;
  const changes = {};
  for (const key of ['model', 'effort']) {
    if (Object.hasOwn(query, key)) {
      const value = query[key].trim();
      changes[key] = value === 'inherit' ? null : value;
    }
  }
  const editing = defaultCompanion !== undefined || Object.keys(changes).length > 0;
  // Removing overrides works even if the native server is offline.
  const validating = Object.values(changes).some(value => value !== null);
  const warnings = [];
  const log = (_level, message) => warnings.push(message);
  const file = settingsPath(env);
  const read = () => readSettings(file, log) ?? {};
  let settings = editing ? null : read();
  const ids = companion ? [companion] : defaultCompanion ? [] : listCompanionIds();
  const last = ids.some(id => !usesServer(id)) ? lastRuns(env, warnings) : null;
  const natives = new Map(await Promise.all(ids.map(async id => {
    if (!usesServer(id)) return [id, { inherit: last.get(id)?.run ?? unavailable('no reported run') }];
    try {
      const saved = settings?.companions?.[id];
      const needModels = validating || (usesAppServer(id) && (editing || saved?.model || saved?.effort));
      return [id, await probe(id, needModels, { env, cwd, createSupervisor, timeoutMs, signal })];
    } catch (err) {
      return [id, { inherit: unavailable(reason(err)), catalogError: reason(err) }];
    }
  })));
  signal?.throwIfAborted();
  if (editing) {
    if (validating) validateSelection(companion, changes, read().companions?.[companion], natives.get(companion));
    if (defaultCompanion === 'inherit') clearDefaultCompanion(env);
    else if (defaultCompanion) writeDefaultCompanion(defaultCompanion, env);
    else writeCompanionDefaults(companion, changes, env);
    settings = read();
  }

  const result = { settingsFile: file };
  if (!companion) result.companion = { ...field(settings.companion, readDefaultCompanion(env, log, settings), 'companion'),
    inherit: readDefaultCompanion(env, log, {}).companion };
  for (const [id, native] of natives) {
    result.companions ??= {};
    result.companions[id] = companionRow(id, settings, env, native);
    if (native.catalogError && native.catalogError !== native.inherit.reason) warnings.push(id + ' model list: ' + native.catalogError);
  }
  if (warnings.length) result.warnings = [...new Set(warnings)];
  return result;
}

function parseArgs(args) {
  const words = args.filter(arg => arg !== '--json');
  const query = {};
  if (words.length && !words[0].includes('=')) query.companion = words.shift();
  for (const word of words) {
    const match = /^(companion|model|effort)=([\s\S]*)$/.exec(word);
    if (!match) throw new Error('expected companion=<id>, model=<id>, or effort=<level>');
    const [, setting, value] = match;
    const key = setting === 'companion' ? 'defaultCompanion' : setting;
    if (Object.hasOwn(query, key)) throw new Error('duplicate ' + setting);
    query[key] = value;
  }
  return query;
}

function describe(field) {
  const value = field.saved ?? 'inherit';
  return field.source === 'env' ? value + ' (environment selects ' + field.value + ')'
    : value + ' (' + field.source + ')';
}

export function formatDefaults(result) {
  const lines = ['Settings: ' + result.settingsFile];
  if (result.companion) lines.push('companion: ' + describe(result.companion) + '  inherit: ' + (result.companion.inherit ?? 'no default companion'));
  for (const [id, row] of Object.entries(result.companions ?? {})) {
    lines.push(id + '  model: ' + describe(row.model) + '  effort: ' + describe(row.effort));
    const { model, effort, reason, source, ageMs, host } = row.inherit;
    const evidence = host ? host + ' last run, ' + age(ageMs) + ' ago' : source;
    lines.push('  inherit: ' + (reason ?? ('model=' + (model ?? 'not reported') + '  effort=' + (effort ?? 'not reported') + ' (' + evidence + ')')));
    if (row.validation) lines.push('  ' + row.validation);
  }
  for (const warning of result.warnings ?? []) lines.push('Warning: ' + warning);
  return lines.map(one).join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => controller.abort(new Error(sig)));
  try {
    const result = await defaults(parseArgs(args), { signal: controller.signal });
    console.log(json ? JSON.stringify(result) : formatDefaults(result));
  } catch (err) {
    console.error(json ? JSON.stringify({ error: reason(err) }) : reason(err));
    process.exitCode = 1;
  }
}
