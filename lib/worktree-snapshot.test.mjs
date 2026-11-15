import '../test/sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshotWorktree, diffWorktrees } from './worktree-snapshot.mjs';
const exec = promisify(execFile);
// Full-suite subprocess contention must not turn content assertions into deadline tests.
// The separate hanging-git test exercises the bounded failure path.
const contentCheck = { timeoutMs: 30_000 };
const git = async (cwd, ...args) => (await exec('git', args, { cwd, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'worktree-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('snapshots include all worktree changes and preserve index bytes and status, even from a subdirectory', async t => {
  const dir = await temp(t);
  await git(dir, 'init');
  for (const [path, content] of Object.entries({ '.gitignore': 'ignored\n', modified: 'before\n', deleted: 'bye\n', staged: 'original\n' })) await writeFile(join(dir, path), content);
  await git(dir, 'add', '-A');
  await writeFile(join(dir, 'staged'), 'staged\n');
  await git(dir, 'add', 'staged');
  await writeFile(join(dir, 'staged'), 'unstaged\n');
  await mkdir(join(dir, 'sub'));
  const index = await readFile(join(dir, '.git/index'));
  const status = await git(dir, 'status', '--porcelain');
  const start = await snapshotWorktree(join(dir, 'sub'), contentCheck);
  assert.equal(start.available, true, start.reason);
  assert.deepEqual(await readFile(join(dir, '.git/index')), index);
  assert.equal(await git(dir, 'status', '--porcelain'), status);
  await writeFile(join(dir, 'modified'), 'after\nmore\n');
  await rm(join(dir, 'deleted'));
  await writeFile(join(dir, 'added\tfile\n'), 'new\n');
  await writeFile(join(dir, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(join(dir, 'ignored'), 'hidden\n');
  const changedStatus = await git(dir, 'status', '--porcelain');
  const end = await snapshotWorktree(dir, contentCheck);
  const diff = await diffWorktrees(dir, start, end, contentCheck);
  assert.equal(diff.available, true, diff.reason);
  assert.deepEqual(diff.files, [
    { path: 'added\tfile\n', status: 'A', added: 1, deleted: 0 },
    { path: 'binary', status: 'A', added: null, deleted: null, binary: true },
    { path: 'deleted', status: 'D', added: 0, deleted: 1 },
    { path: 'modified', status: 'M', added: 2, deleted: 1 },
  ]);
  assert.deepEqual(await readFile(join(dir, '.git/index')), index);
  assert.equal(await git(dir, 'status', '--porcelain'), changedStatus);
});
test('non-git, missing git and timeout snapshots are unavailable', async t => {
  const dir = await temp(t);
  assert.equal((await snapshotWorktree(dir)).available, false);
  assert.equal((await snapshotWorktree(dir, { env: { ...process.env, PATH: dir } })).reason, 'git_missing');
  const bin = join(dir, 'git');
  await writeFile(bin, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const start = performance.now();
  assert.equal((await snapshotWorktree(dir, { env: { ...process.env, PATH: dir }, timeoutMs: 100 })).reason, 'timeout');
  assert.ok(performance.now() - start < 2000);
});
test('snapshot uses a linked worktree index and handles an unborn index', async t => {
  const dir = await temp(t);
  await git(dir, 'init');
  await writeFile(join(dir, 'initial'), 'one\n');
  const unborn = await snapshotWorktree(dir, contentCheck);
  assert.equal(unborn.available, true, unborn.reason);
  await assert.rejects(readFile(join(dir, '.git/index')), { code: 'ENOENT' });
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial');
  const linked = join(await temp(t), 'linked ');
  await git(dir, 'worktree', 'add', '-b', 'fixture', linked);
  const mainIndex = await readFile(join(dir, '.git/index'));
  const indexPath = (await git(linked, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trim();
  const linkedIndex = await readFile(indexPath);
  const head = await git(linked, 'rev-parse', 'HEAD');
  const start = await snapshotWorktree(linked, contentCheck);
  await writeFile(join(linked, 'initial'), 'two\n');
  const end = await snapshotWorktree(linked, contentCheck);
  assert.deepEqual((await diffWorktrees(linked, start, end, contentCheck)).files, [{ path: 'initial', status: 'M', added: 1, deleted: 1 }]);
  assert.deepEqual(await readFile(indexPath), linkedIndex);
  assert.deepEqual(await readFile(join(dir, '.git/index')), mainIndex);
  assert.equal(await git(linked, 'rev-parse', 'HEAD'), head);
});
