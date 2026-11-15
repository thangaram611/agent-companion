// The live view's only writes (docs/LIVE_VIEW_PLAN.md, Step 3 inbox contract):
// one request file per message or cancel at
// `<host state dir>/inbox/<executionId>/<requestId>.json`, written atomically
// with mode 0600, and the deletion of the `<requestId>.outcome.json` it has read.
// The owning bridge's controller applies requests on its tick and removes the
// execution's inbox directory when the execution closes.
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '../../lib/runtime-paths.mjs';

const inboxDir = (dir, executionId) => join(dir, 'inbox', executionId);

// request: { requestId, executionId, mode, text?, at }; cancel carries no text.
export function writeRequest(dir, request) {
  const path = inboxDir(dir, request.executionId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(join(path, `${request.requestId}.json`), JSON.stringify(request));
}

// The outcome once the controller has written it, else null. It is deleted
// after a successful read, so each outcome is shown once.
export function takeOutcome(dir, executionId, requestId) {
  const path = join(inboxDir(dir, executionId), `${requestId}.outcome.json`);
  let outcome;
  try { outcome = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  try { unlinkSync(path); } catch { /* the controller removed the directory on close */ }
  return outcome;
}
