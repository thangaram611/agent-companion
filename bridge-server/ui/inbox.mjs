// The live view's job writes (docs/LIVE_VIEW_PLAN.md, Step 3 inbox contract);
// its defaults panel saves settings through defaults.mjs:
// one request file per message or cancel at
// `<host state dir>/inbox/<jobId>/<requestId>.json`, written atomically
// with mode 0600, and the deletion of the `<requestId>.outcome.json` it has read.
// The owning bridge's controller applies requests on its tick and removes the
// job's inbox directory when the job closes.
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFileAtomic } from '../../lib/runtime-paths.mjs';

const inboxDir = (dir, jobId) => join(dir, 'inbox', jobId);

// request: { requestId, jobId, mode, text?, at }; cancel carries no text.
export function writeRequest(dir, request) {
  const path = inboxDir(dir, request.jobId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(join(path, `${request.requestId}.json`), JSON.stringify(request));
}

// The outcome once the controller has written it, else null. It is deleted
// after a successful read, so each outcome is shown once.
export function takeOutcome(dir, jobId, requestId) {
  const path = join(inboxDir(dir, jobId), `${requestId}.outcome.json`);
  let outcome;
  try { outcome = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  try { unlinkSync(path); } catch { /* the controller removed the directory on close */ }
  return outcome;
}

const MODES = new Set(['steer', 'queue', 'interrupt', 'cancel']);
const ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;

// One request and its outcome, for Claude Code's Companions pane, which has no
// Node: write the request, then wait for the owning bridge's outcome (it reads
// the inbox on its tick, once a second) and take it. Resolves
// { requestId, outcome }, the outcome null when none came within `waitMs`.
export async function send({ dir, jobId, mode, text, waitMs = 10_000, now = Date.now }) {
  let job;
  try { job = JSON.parse(readFileSync(join(dir, 'jobs', jobId + '.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const refused = reason => ({ requestId: null, outcome: { ok: false, status: 'not_submitted', reason } });
  if (!job) return refused('Unknown job. Check the job ID in agent-companion ui.');
  const closed = () => existsSync(join(dir, 'results', jobId + '.json'));
  if (closed() || !['starting', 'delivering', 'running'].includes(job.state) || job.writer === 'watcher') {
    return refused('This job no longer takes requests. Check it in agent-companion ui.');
  }
  const request = { requestId: randomUUID(), jobId, mode, ...(mode === 'cancel' ? {} : { text }), at: now() };
  writeRequest(dir, request);
  // Close can race the preflight and remove the inbox before our write.
  if (closed()) {
    const path = inboxDir(dir, jobId);
    try { unlinkSync(join(path, request.requestId + '.json')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    try { rmdirSync(path); } catch (err) { if (!['ENOENT', 'ENOTEMPTY'].includes(err.code)) throw err; }
  }
  for (const end = now() + waitMs; ; await new Promise(resolve => setTimeout(resolve, 200))) {
    const outcome = takeOutcome(dir, jobId, request.requestId);
    if (outcome) return { requestId: request.requestId, outcome };
    if (closed() || now() >= end) return { requestId: request.requestId, outcome: null, status: 'pending',
      hint: 'Inspect the job and this request’s outcome before retrying.' };
  }
}

// `launch-ui.sh send <state dir> <jobId> <mode> [text]` prints one JSON line.
if (import.meta.main) {
  const [dir, jobId, mode, text, ...rest] = process.argv.slice(2);
  const valid = dir && isAbsolute(dir) && ID.test(jobId ?? '') && MODES.has(mode) && !rest.length
    && (mode === 'cancel' ? text === undefined : typeof text === 'string' && text.trim().length > 0);
  if (!valid) {
    process.stderr.write('usage: agent-companion send <absolute state dir> <jobId> <steer|queue|interrupt|cancel> [text]\n');
    process.exitCode = 2;
  } else {
    const sent = await send({ dir, jobId, mode, text });
    process.stdout.write(JSON.stringify(sent) + '\n');
    if (sent.outcome?.ok === false) process.exitCode = 1;
  }
}
