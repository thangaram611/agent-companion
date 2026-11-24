import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const unavailable = error => ({ available: false, reason: error.killed || error.code === 'TIMEOUT' ? 'timeout'
  : error.code === 'ENOENT' ? 'git_missing' : error.code === 'NOT_WORKTREE' ? 'not_git_worktree' : 'git_failed' });
function commands(cwd, { env = process.env, timeoutMs = 5000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  delete gitEnv.GIT_INDEX_FILE;
  return async (args, extraEnv = {}) => {
    const timeout = Math.ceil(deadline - performance.now());
    if (timeout <= 0) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    return (await exec('git', ['-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { ...gitEnv, ...extraEnv }, timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    })).stdout;
  };
}

// Only the throwaway index is staged. Loose tree/blob objects are left for git gc;
// the real index, HEAD, refs and worktree files are never written.
export async function snapshotWorktree(cwd, options) {
  let dir;
  try {
    const git = commands(cwd, options);
    let root;
    try {
      root = (await git(['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
    } catch (error) {
      if (typeof error.code === 'number' && !error.killed) error.code = 'NOT_WORKTREE';
      throw error;
    }
    const index = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).replace(/\n$/, '');
    dir = await mkdtemp(join(tmpdir(), 'companion-index-'));
    const copy = join(dir, 'index');
    try {
      // Git rechecks content at or after the index mtime. Round down so
      // filesystem or JS timestamp precision cannot move that boundary later.
      const { mtimeNs } = await stat(index, { bigint: true });
      await copyFile(index, copy);
      const stamp = Number(mtimeNs / 1_000_000_000n);
      await utimes(copy, stamp, stamp);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const env = { GIT_INDEX_FILE: copy };
    await git(['-C', root, 'add', '-A', '--', '.'], env);
    const tree = (await git(['write-tree'], env)).trim();
    return { available: true, tree };
  } catch (error) { return unavailable(error); }
  finally { if (dir) await rm(dir, { recursive: true, force: true }); }
}

export async function diffWorktrees(cwd, start, end, options) {
  if (!start?.available || !end?.available) return { available: false, reason: start?.reason ?? end?.reason ?? 'snapshot_unavailable' };
  try {
    const git = commands(cwd, options);
    const args = ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', start.tree, end.tree];
    const [names, stats] = await Promise.all([git([...args, '--name-status']), git([...args, '--numstat'])]);
    const entries = names.split('\0');
    const statuses = new Map();
    for (let i = 0; i < entries.length - 1; i += 2) statuses.set(entries[i + 1], entries[i]);
    const files = stats.split('\0').filter(Boolean).map(row => {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(row);
      if (!match) throw new Error('invalid git numstat');
      const [, added, deleted, path] = match;
      return { path, status: statuses.get(path), added: added === '-' ? null : Number(added),
        deleted: deleted === '-' ? null : Number(deleted), ...(added === '-' ? { binary: true } : {}) };
    });
    return { available: true, files };
  } catch (error) { return unavailable(error); }
}
