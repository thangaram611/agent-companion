// Read-only view of one execution. Native history remains the only transcript.
import { existsSync } from 'node:fs';
import { locateTranscript, readTranscript } from './transcripts.mjs';
import { selectTurnItems, summarizeWork } from './work-summary.mjs';
import { formatUsage } from './usage.mjs';

const show = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
function block(value, truncated = false) {
  const bytes = Buffer.from(show(value) ?? '');
  let end = Math.min(bytes.length, 2048);
  if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--;
  const text = bytes.subarray(0, end).toString();
  // Indentation keeps native Markdown/fences literal without hiding headings.
  return text.split('\n').map(line => `    ${line}`).join('\n') +
    (end < bytes.length || truncated ? '\n\n[truncated — see native transcript for the rest]' : '');
}
const commandLine = command => Array.isArray(command) ? command.join(' ') : command;
// OpenCode reports models as { providerID, id, variant }; others as strings.
const modelName = model => model && typeof model === 'object'
  ? [model.providerID, model.id].filter(Boolean).join('/') + (model.variant && model.variant !== 'default' ? `#${model.variant}` : '') || JSON.stringify(model)
  : model;
// The heading carries the command and exit code, so a command shows its cwd and output.
function body(item, fields) {
  if (['user', 'assistant', 'reasoning'].includes(item.kind)) return block(item.text, item.truncated);
  if (item.kind === 'command') return [item.cwd ? `cwd: ${item.cwd}` : null, item.denied ? `refused: ${item.denied}` : null, block(item.output ?? '', item.truncated)].filter(Boolean).join('\n\n');
  if (item.kind === 'edit') return (item.paths ?? []).map(path => `- ${path.change} ${path.path}`).join('\n');
  return block(fields, item.truncated);
}
function workSummary(summary) {
  const lines = [`Commands: ${summary.commands.length + (summary.commandsOmitted ?? 0)}`];
  for (const cmd of summary.commands) lines.push(`- ${commandLine(cmd.command)} — exit ${cmd.exitCode ?? 'unknown'}${cmd.status ? ` (${cmd.status})` : ''}${cmd.denied ? ` — refused: ${cmd.denied}` : ''}`);
  for (const edit of summary.edits) lines.push(`- Edit: ${edit.change} ${edit.path}`);
  for (const error of summary.errors) lines.push(`- Native error (${error.type}): ${error.message}`);
  for (const kind of ['commands', 'edits', 'errors']) if (summary[`${kind}Omitted`]) lines.push(`${summary[`${kind}Omitted`]} more ${kind} omitted.`);
  const tree = summary.worktree;
  lines.push('', 'Worktree diff-stat (including any writer):', tree.note);
  if (!tree.available) lines.push(`Unavailable: ${tree.reason}`);
  else for (const file of tree.files) lines.push(`- ${file.path}: ${file.binary ? 'binary' : `+${file.added} -${file.deleted}`}`);
  if (tree.filesOmitted) lines.push(`${tree.filesOmitted} more files omitted.`);
  if (summary.transcript.available === false) lines.push(`Transcript unavailable: ${summary.transcript.reason}`);
  else if (!summary.transcript.recognized) lines.push(`Transcript has unrecognized records: ${summary.transcript.unrecognized}.`);
  return lines.join('\n');
}

export function renderDigest(execution, result, env = process.env) {
  let locator = execution.transcript, transcript, unavailable;
  try {
    locator ??= locateTranscript({ companion: execution.provider, historyId: execution.historyId,
      nativeRefs: { ...execution.nativeRefs, ...result?.nativeRefs }, env });
    if (!locator || !existsSync(locator.path)) unavailable = 'transcript_not_found';
    else transcript = readTranscript(locator);
  } catch { unavailable = 'transcript_read_failed'; }
  const items = selectTurnItems(transcript?.items ?? [], { companion: execution.provider,
    nativeTurnId: execution.nativeTurnId, startedAt: execution.startedAt });
  const summary = result?.workSummary ?? summarizeWork({ locator, transcript, items });
  const progress = execution.progress ?? {};
  const answer = (result?.text ?? progress.partialText) || items.findLast(item => item.kind === 'assistant')?.text || '(no answer yet)';
  const lines = [`# ${execution.provider} job ${execution.executionId}`, '',
    `Companion: ${execution.provider}`,
    `Models: selected ${modelName(result?.selectedModel ?? execution.modelOverride) ?? 'inherited'}; effective ${modelName(result?.effectiveModel ?? progress.effectiveModel ?? execution.effectiveModel) ?? 'unknown'}`,
    `Effort: selected ${result?.selectedEffort ?? execution.effortOverride ?? 'inherited'}; effective ${result?.effectiveEffort ?? progress.effectiveEffort ?? execution.effectiveEffort ?? 'unknown'}`,
    `Status: ${result?.outcome ?? execution.state}`,
    `Started: ${new Date(execution.startedAt).toISOString()}`,
    `Finished: ${result?.finishedAt != null ? new Date(result.finishedAt).toISOString() : 'in progress'}`,
    `Session: ${execution.historyId ?? 'unknown'}; turn: ${execution.nativeTurnId ?? 'unknown'}`];
  if (result?.usage) lines.push(`Usage: ${formatUsage(result.usage)}`);
  lines.push('', '## Task', '', execution.text, '', result ? '## Final answer' : '## Partial answer', '', answer,
    '', '## Work summary', '', workSummary(summary), '', '## Transcript', '');
  if (locator) lines.push(`Native transcript: ${locator.path} (full output remains here).`, '');
  if (unavailable) lines.push(`Transcript unavailable: ${unavailable}.`);
  else if (!transcript.format.recognized) lines.push(`Transcript format unrecognized for ${execution.provider} ${transcript.format.version ?? 'unknown version'}: ${transcript.format.detail}.`, '');
  // Session-wide instructions have no turn id; include only their count along
  // with this turn's preamble, never another turn's messages or instructions.
  const preamble = (transcript?.items ?? []).filter(item => item.kind === 'preamble' && (item.turnId == null || items.includes(item)));
  if (preamble.length) lines.push(`Preamble: ${preamble.length} items collapsed.`, '');
  for (const item of items) {
    if (item.kind === 'preamble') continue;
    const { id, turnId, at, kind, nativeType, truncated, ...fields } = item;
    const title = kind === 'command' ? `${commandLine(item.command)} — exit ${item.exitCode ?? 'unknown'}` : item.name;
    lines.push(`### ${kind}${title ? `: ${title}` : ''}${at != null ? ` (${at})` : ''}`, '', body(item, fields), '');
  }
  if (!result) lines.push(`In flight: ${progress.activity ?? (progress.activeCommand ? `running ${progress.activeCommand}` : progress.partialText ? 'responding' : execution.state)}`);
  return lines.join('\n') + '\n';
}
