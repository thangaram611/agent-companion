const clip = (value, limit) => typeof value === 'string' && value.length > limit ? value.slice(0, limit - 1) + '…' : value;
const note = 'Includes changes by any writer between turn start and end; excludes ignored files.';

export function selectTurnItems(items, { companion, nativeTurnId, nativeTurnIds, interventions = [], startedAt }) {
  if (companion === 'copilot') return items;
  if (companion === 'antigravity') return items.filter(item => item.at != null &&
    (typeof item.at === 'number' ? item.at : Date.parse(item.at)) >= startedAt);
  const ids = new Set(nativeTurnIds?.length ? nativeTurnIds : nativeTurnId == null ? [] : [nativeTurnId]);
  // Claude's transcript switches UUID at a joined user message even when its
  // result answers both messages in one native turn.
  if (companion === 'claude') for (const input of interventions) ids.add(input.id);
  return items.filter(item => ids.has(item.turnId));
}

// Pure projection. The controller supplies the read result, selected turn and
// diff of the two snapshots; this module never reads a transcript or runs git.
// `ended`: the execution is over, so a native running/streaming status (Antigravity
// leaves a cancelled command at running) is reported as unfinished.
export function summarizeWork({ locator, transcript, items = [], worktree = { available: false, reason: 'snapshot_unavailable' }, ended = false }) {
  const commands = [], edits = new Map(), errors = [];
  for (const item of items) {
    if (item.kind === 'command') commands.push({ command: Array.isArray(item.command)
      ? item.command.slice(0, 20).map(part => clip(part, 2000)) : clip(item.command, 2000), exitCode: item.exitCode ?? null,
      status: ended && ['running', 'streaming'].includes(item.status) ? 'unfinished' : item.status ?? null,
      ...(item.denied ? { denied: clip(item.denied, 500) } : {}) });
    if (item.kind === 'edit') for (const entry of item.paths ?? []) {
      const previous = edits.get(entry.path);
      edits.set(entry.path, { path: entry.path, change: previous?.change === 'add' && entry.change === 'update' ? 'add' : entry.change });
    }
    if (item.kind === 'error') errors.push({ type: clip(item.error?.type ?? 'provider_error', 200), message: clip(item.error?.message ?? '', 500) });
  }
  const files = worktree.files ?? [];
  return {
    transcript: locator && transcript?.format?.version != null ? { companion: locator.companion, path: locator.path,
      version: transcript.format.version, recognized: transcript.format.recognized, unrecognized: transcript.counts.unrecognized }
      : { available: false, reason: transcript?.format?.detail ?? 'transcript_not_found' },
    commands: commands.slice(0, 20), commandsOmitted: Math.max(0, commands.length - 20),
    edits: [...edits.values()].slice(0, 50), editsOmitted: Math.max(0, edits.size - 50),
    errors: errors.slice(0, 20), errorsOmitted: Math.max(0, errors.length - 20),
    worktree: { ...worktree, files: files.slice(0, 50), filesOmitted: Math.max(0, files.length - 50), note },
  };
}
