import { existsSync, linkSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HOSTS } from '../lib/hosts/index.mjs';
import { firstLine } from './controller/records.mjs';
import { runtimeDir, writePrivateFile } from '../lib/runtime-paths.mjs';

export function jobStatus(result) {
  return ({ completed: 'completed', failed: 'failed', interrupted: 'cancelled', stopped: 'cancelled', delivery_unknown: 'failed' })[result.outcome];
}

function marker(session) {
  const literal = session !== '.' && session !== '..' && !session.startsWith('~')
    && !/[\x00/]/.test(session) && Buffer.byteLength(session) <= 255;
  const name = literal ? session : '~' + createHash('sha256').update(session).digest('hex');
  return join(runtimeDir(), 'news', name);
}

function mark(session) {
  mkdirSync(join(runtimeDir(), 'news'), { recursive: true, mode: 0o700 });
  writePrivateFile(marker(session), '', 'a');
}

const receipt = (records, id) => records.path('results', id) + '.delivery';

export function needsStartupWake(records, job) {
  return !existsSync(receipt(records, job.jobId))
    && job.generation > (records.read('reads', job.thread)?.generation ?? 0);
}

export function publish(records, job, result) {
  const lead = records.readThread(job.thread)?.lead;
  const path = receipt(records, result.jobId);
  if (lead && !existsSync(path)) {
    mark(lead.session);
    // A tool may have claimed and cleared news between the check and mark.
    if (existsSync(path)) unread(records, lead);
  }
  return lead;
}

// Install the complete receipt exclusively. A racing tool can identify the
// winner immediately, even when another process is paused inside its write.
function claim(records, id, by) {
  const path = receipt(records, id);
  const tmp = path + '.' + randomUUID();
  try {
    writePrivateFile(tmp, by + '\n', 'wx');
    linkSync(tmp, path);
    return { by, won: true };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Older releases used an empty file for hook and "owner" for tool.
    const saved = readFileSync(path, 'utf8').trim();
    return { by: saved === 'tool' || saved === 'owner' ? 'tool' : 'hook', won: false };
  } finally { rmSync(tmp, { force: true }); }
}

function pending(records, lead) {
  const threads = new Map(records.listThreads().filter(c =>
    c.lead?.session === lead.session && c.lead.host === lead.host).map(c => [c.thread, c]));
  if (!threads.size) return [];
  const jobs = records.listJobs().filter(e => threads.has(e.thread)).sort((a, b) => a.generation - b.generation);
  const previous = new Map(), rows = [];
  for (const job of jobs) {
    const after = previous.get(job.thread) ?? '';
    previous.set(job.thread, job.jobId);
    if (existsSync(receipt(records, job.jobId))) continue;
    const result = records.readResult(job.jobId);
    if (result) rows.push({ job, result, after, threadRecord: threads.get(job.thread) });
  }
  return rows;
}

export function unread(records, lead) {
  let rows = pending(records, lead);
  if (!rows.length && existsSync(marker(lead.session))) {
    rmSync(marker(lead.session), { force: true });
    // A publisher may have created the marker between our scan and unlink.
    rows = pending(records, lead);
    if (rows.length) mark(lead.session);
  }
  return rows.filter(({ threadRecord }) => threadRecord.lead.agent === lead.agent);
}

export function toolName(host, action) {
  const descriptor = HOSTS[host];
  const prefix = descriptor.visibleToolPrefix ?? descriptor.toolPrefix;
  return prefix + 'companion_' + action;
}

export function readCall(host, thread, after, offset) {
  const args = [`thread: ${JSON.stringify(thread)}`];
  if (after !== undefined) args.push(`after: ${JSON.stringify(after)}`);
  if (offset) args.push(`offset: ${offset}`);
  return `${toolName(host, 'read')}({ ${args.join(', ')} })`;
}

export function threadPosts(records, thread) {
  return records.listJobs().filter(e => e.thread === thread).sort((a, b) => a.generation - b.generation);
}

export function postHeader(job, result, title) {
  const status = result ? jobStatus(result) : job.state;
  const time = new Date(result?.finishedAt ?? job.startedAt).toISOString();
  const cancel = result?.cause === 'user_cancel' ? `\nYou cancelled this job · ${firstLine(title)}` : '';
  return `## ${job.jobId} · ${status} · ${job.companion} · ${time}\nTask: ${job.text.split(/\r?\n/, 1)[0]}${cancel}`;
}

function readTarget(records, result) {
  const threadRecord = records.readThread(result.thread);
  const posts = threadPosts(records, result.thread);
  const index = posts.findIndex(job => job.jobId === result.jobId);
  return { job: posts[index], result, threadRecord, after: posts[index - 1]?.jobId ?? '' };
}

function reference({ job, result, threadRecord, after }, answerOffset = 0) {
  const offset = answerOffset && Array.from(postHeader(job, result, threadRecord.title)).length + 1 + answerOffset;
  return readCall(threadRecord.lead.host, result.thread, after, offset);
}

export function wakeNotice(records, job, result) {
  const target = readTarget(records, result);
  const title = firstLine(target.threadRecord.title);
  const state = result.cause === 'user_cancel' ? 'You cancelled this job' : jobStatus(result);
  return `agent-companion: ${job.companion} finished thread ${result.thread} · ${title} (${state}), job ${result.jobId}. ${reference(target)} reads it.`;
}

function excerpt(result, limit, target) {
  const answer = result.text ?? '';
  if (answer.length <= limit) return answer;
  const chars = Array.from(answer);
  if (chars.length <= limit) return answer;
  return `${chars.slice(0, limit).join('')}\n[… ${chars.length - limit} more characters. ${reference(target(), limit)} reads on.]`;
}

export function toolAnswer(records, result, signal) {
  if (!signal?.aborted) {
    const winner = claim(records, result.jobId, 'tool');
    const lead = records.readThread(result.thread)?.lead;
    if (lead) unread(records, lead);
    if (winner.by === 'hook') return { text: `Already delivered to this conversation by the completion hook. ${reference(readTarget(records, result))} reads it again.`, delivered_by: 'hook' };
  }
  return { text: excerpt(result, 8000, () => readTarget(records, result)) };
}

export function hookAnswer(records, lead) {
  const notices = unread(records, lead).map(target => {
    const { result, threadRecord } = target;
    const state = result.cause === 'user_cancel' ? 'You cancelled this job' : jobStatus(result);
    const heading = `## ${result.jobId} · ${state} · ${threadRecord.companion} · ${firstLine(threadRecord.title)} · ${reference(target)}`;
    return { target, heading };
  });
  // Reserve a reference per result before spending the remaining space on
  // excerpts. If even the references do not fit, leave the rest for next time.
  let reserved = notices.reduce((n, row) => n + row.heading.length + 2, -2);
  const lines = [];
  let length = 0;
  for (const { target, heading } of notices) {
    const { result } = target;
    reserved -= heading.length + 2;
    const separator = lines.length ? 2 : 0;
    const available = 8999 - length - separator;
    if (heading.length > available) break;
    const full = heading + '\n' + excerpt(result, 4000, () => target);
    const fits = Array.from(full).length + Math.max(0, reserved + 2) <= available;
    const notice = fits ? full : heading;
    if (!claim(records, result.jobId, 'hook').won) continue;
    lines.push(notice);
    length += separator + Array.from(notice).length;
  }
  if (lines.length) unread(records, lead);
  return lines.join('\n\n');
}
