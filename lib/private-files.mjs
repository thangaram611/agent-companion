import { chmodSync, writeFileSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

export const PRIVATE_FILE_MODE = 0o600;

export function chmodPrivate(path) {
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch {}
}

export function writePrivateFile(path, content, flag = 'w') {
  writeFileSync(path, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag });
  chmodPrivate(path);
}

// Atomic replace, for files that one process rewrites while others read them.
// `writePrivateFile` truncates and then writes, so a concurrent reader can
// observe a half-written file; rename(2) is atomic within a filesystem, so a
// reader sees either the whole old file or the whole new one.
//
// The temp file goes in the target's own directory to keep the rename
// intra-filesystem — via os.tmpdir() it can land on another volume, where node
// degrades to copy+unlink and reopens the very window this closes.
export function writePrivateFileAtomic(path, content, { replace = true } = {}) {
  const dir = dirname(path);
  const tmp = join(dir, `.agent-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    try { chmodSync(tmp, PRIVATE_FILE_MODE); } catch {}
    if (replace) renameSync(tmp, path);
    else {
      // Publish the complete file only if another writer has not beaten us.
      linkSync(tmp, path);
      unlinkSync(tmp);
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  chmodPrivate(path);
}
