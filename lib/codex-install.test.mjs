import '../test/sandbox-home.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { inspectCodexAppServerInstallation } from './codex-install.mjs';

function sandbox() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'agent-codex-install-'));
  return {
    root,
    home: join(root, 'home'),
    pathDir: join(root, 'path'),
    caskBin: join(root, 'Caskroom', 'codex', '0.152.1', 'bin'),
  };
}

function executable(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

function extractedPaths(home) {
  const dir = join(home, '.codex', 'plugins', '.plugin-appserver');
  return {
    codex: join(dir, 'codex'),
    helper: join(dir, 'codex-code-mode-host'),
  };
}

function fakeRun({ versions = new Map(), quarantines = new Map(), xattrResults = new Map() } = {}) {
  const calls = [];
  const run = (cmd, args = []) => {
    calls.push([cmd, args]);
    if (cmd === 'xattr') {
      const path = args.at(-1);
      if (xattrResults.has(path)) return xattrResults.get(path);
      if (quarantines.has(path)) return { ok: true, output: quarantines.get(path) };
      return { ok: false, code: 'ENOATTR', output: 'No such xattr' };
    }
    if (args.length === 1 && args[0] === '--version' && versions.has(cmd)) {
      return { ok: true, output: `codex-cli ${versions.get(cmd)}` };
    }
    return { ok: false, output: 'not found' };
  };
  run.calls = calls;
  return run;
}

function makePathCask(layout, { helper = true, invokedHelper = false } = {}) {
  const realCodex = executable(join(layout.caskBin, 'codex'));
  if (helper) executable(join(layout.caskBin, 'codex-code-mode-host'));
  mkdirSync(layout.pathDir, { recursive: true });
  const invokedCodex = join(layout.pathDir, 'codex');
  symlinkSync(realCodex, invokedCodex);
  if (invokedHelper) executable(join(layout.pathDir, 'codex-code-mode-host'));
  return { realCodex, invokedCodex };
}

function makeExtracted(home) {
  const paths = extractedPaths(home);
  executable(paths.codex);
  executable(paths.helper);
  return paths;
}

test('complete cask pair retains invoked and real paths and is selected', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { realCodex, invokedCodex } = makePathCask(layout);
  const run = fakeRun({ versions: new Map([[invokedCodex, '0.152.1']]) });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir },
    run,
    platform: 'linux',
    homeDir: layout.home,
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.configured, { command: 'codex', explicit: false, source: 'path' });
  assert.equal(report.installed.path, invokedCodex);
  assert.equal(report.installed.realPath, realCodex);
  assert.equal(report.installed.version, '0.152.1');
  assert.equal(report.installed.helperPath, join(layout.caskBin, 'codex-code-mode-host'));
  assert.equal(report.installed.helperSource, 'bin-sibling');
  assert.equal(report.installed.complete, true);
  assert.match(report.installed.identity, /"dev":/);
  assert.deepEqual(report.selected, {
    path: invokedCodex,
    realPath: realCodex,
    version: '0.152.1',
    helperPath: join(layout.caskBin, 'codex-code-mode-host'),
    source: 'configured',
    identity: report.installed.identity,
    quarantined: false,
    quarantineStatus: 'not_applicable',
  });
  assert.equal(report.blocker, null);
  assert.deepEqual(report.warnings, []);
});

test('codex-resources helper takes priority over the bin sibling', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { invokedCodex } = makePathCask(layout);
  const resourceHelper = executable(join(dirname(layout.caskBin), 'codex-resources', 'codex-code-mode-host'));
  const run = fakeRun({ versions: new Map([[invokedCodex, '0.152.1']]) });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'linux', homeDir: layout.home,
  });

  assert.equal(report.installed.helperPath, resourceHelper);
  assert.equal(report.installed.helperSource, 'codex-resources');
});

test('incomplete cask selects a same-version unquarantined extracted pair', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { invokedCodex } = makePathCask(layout, { helper: false });
  const extracted = makeExtracted(layout.home);
  const run = fakeRun({ versions: new Map([
    [invokedCodex, '0.152.1'],
    [extracted.codex, '0.152.1'],
  ]) });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'darwin', homeDir: layout.home,
  });

  assert.equal(report.installed.complete, false);
  assert.equal(report.fallback.complete, true);
  assert.equal(report.ready, true);
  assert.equal(report.selected.source, 'plugin-appserver');
  assert.equal(report.selected.path, extracted.codex);
  assert.equal(report.selected.helperPath, extracted.helper);
  assert.match(report.warnings[0], /configured Codex has no executable codex-code-mode-host/);
});

test('explicit CODEX_BIN anchors the desired version and rejects a mismatched fallback', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const configuredCodex = executable(join(layout.root, 'explicit', 'codex'));
  const extracted = makeExtracted(layout.home);
  // A usable PATH binary must not replace an explicit, incomplete CODEX_BIN.
  makePathCask(layout);
  const run = fakeRun({ versions: new Map([
    [configuredCodex, '0.152.1'],
    [extracted.codex, '0.152.0'],
  ]) });

  const report = inspectCodexAppServerInstallation({
    env: { CODEX_BIN: configuredCodex, PATH: layout.pathDir },
    run,
    platform: 'linux',
    homeDir: layout.home,
  });

  assert.equal(report.configured.explicit, true);
  assert.equal(report.installed.path, configuredCodex);
  assert.equal(report.ready, false);
  assert.equal(report.selected, null);
  assert.equal(report.blocker.code, 'fallback_version_mismatch');
  assert.match(report.blocker.message, /0\.152\.1.*0\.152\.0/);
});

test('both configured Codex and extracted pair unavailable reports codex_missing', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  mkdirSync(layout.pathDir, { recursive: true });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir },
    run: fakeRun(),
    platform: 'linux',
    homeDir: layout.home,
  });

  assert.equal(report.ready, false);
  assert.equal(report.installed.path, null);
  assert.equal(report.fallback.complete, false);
  assert.equal(report.selected, null);
  assert.equal(report.blocker.code, 'codex_missing');
  assert.match(report.blocker.message, /install Codex or set CODEX_BIN/);
});

test('installed Codex with neither local nor extracted helper reports code_mode_host_missing', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { invokedCodex } = makePathCask(layout, { helper: false });
  const run = fakeRun({ versions: new Map([[invokedCodex, '0.152.1']]) });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'linux', homeDir: layout.home,
  });

  assert.equal(report.ready, false);
  assert.equal(report.installed.version, '0.152.1');
  assert.equal(report.installed.helperPath, null);
  assert.equal(report.blocker.code, 'code_mode_host_missing');
  assert.match(report.blocker.message, /no executable regular codex-code-mode-host/);
});

test('quarantined configured pair yields to a matching unquarantined extracted pair', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { realCodex, invokedCodex } = makePathCask(layout);
  const extracted = makeExtracted(layout.home);
  const quarantine = '0381;6a97d0e5;;E873F702-EEFE-4187-8CA5-5ED78058963B';
  const run = fakeRun({
    versions: new Map([[invokedCodex, '0.152.1'], [extracted.codex, '0.152.1']]),
    quarantines: new Map([[realCodex, quarantine]]),
  });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'darwin', homeDir: layout.home,
  });

  assert.equal(report.installed.quarantine, quarantine);
  assert.equal(report.installed.quarantineStatus, 'present');
  assert.equal(report.installed.quarantineError, null);
  assert.equal(report.installed.quarantined, true);
  assert.equal(report.selected.source, 'plugin-appserver');
  assert.equal(report.selected.quarantined, false);
  assert.equal(report.selected.quarantineStatus, 'absent');
  assert.match(report.warnings[0], /configured Codex parent is quarantined/);
});

test('a missing quarantine attribute is definitely absent and keeps the configured pair preferred', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { invokedCodex } = makePathCask(layout);
  const run = fakeRun({ versions: new Map([[invokedCodex, '0.152.1']]) });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'darwin', homeDir: layout.home,
  });

  assert.equal(report.installed.quarantine, null);
  assert.equal(report.installed.quarantineStatus, 'absent');
  assert.equal(report.installed.quarantineError, null);
  assert.equal(report.installed.quarantined, false);
  assert.equal(report.selected.source, 'configured');
  assert.equal(report.selected.quarantineStatus, 'absent');
  assert.deepEqual(report.warnings, []);
});

test('indeterminate configured quarantine probes yield to a definitely-unquarantined extracted pair', () => {
  const failures = [
    { label: 'timeout', result: { ok: false, timedOut: true, output: 'xattr did not respond' } },
    { label: 'permission denial', result: { ok: false, code: 'EACCES', output: 'Operation not permitted' } },
    { label: 'missing xattr executable', result: { ok: false, code: 'ENOENT', output: 'spawnSync xattr ENOENT' } },
  ];

  for (const { label, result } of failures) {
    const layout = sandbox();
    try {
      const { realCodex, invokedCodex } = makePathCask(layout);
      const extracted = makeExtracted(layout.home);
      const run = fakeRun({
        versions: new Map([[invokedCodex, '0.152.1'], [extracted.codex, '0.152.1']]),
        xattrResults: new Map([[realCodex, result]]),
      });

      const report = inspectCodexAppServerInstallation({
        env: { PATH: layout.pathDir }, run, platform: 'darwin', homeDir: layout.home,
      });

      assert.equal(report.installed.quarantineStatus, 'indeterminate', label);
      assert.match(report.installed.quarantineError, /xattr|permitted|ENOENT/i, label);
      assert.equal(report.installed.quarantined, false, label);
      assert.equal(report.selected.source, 'plugin-appserver', label);
      assert.equal(report.selected.path, extracted.codex, label);
      assert.equal(report.selected.quarantineStatus, 'absent', label);
      assert.ok(report.warnings.some((warning) => /quarantine state is indeterminate/.test(warning)), label);
    } finally {
      rmSync(layout.root, { recursive: true, force: true });
    }
  }
});

test('a complete configured pair with indeterminate quarantine remains ready only as an advisory', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { realCodex, invokedCodex } = makePathCask(layout);
  const run = fakeRun({
    versions: new Map([[invokedCodex, '0.152.1']]),
    xattrResults: new Map([[realCodex, { ok: false, code: 'EACCES', output: 'Operation not permitted' }]]),
  });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'darwin', homeDir: layout.home,
  });

  assert.equal(report.ready, true);
  assert.equal(report.selected.source, 'configured');
  assert.equal(report.selected.quarantineStatus, 'indeterminate');
  assert.equal(report.blocker, null);
  assert.ok(report.warnings.some((warning) => /Could not determine.*com\.apple\.quarantine/.test(warning)));
});

test('an indeterminate extracted quarantine probe is not treated as an unquarantined fallback', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { invokedCodex } = makePathCask(layout, { helper: false });
  const extracted = makeExtracted(layout.home);
  const run = fakeRun({
    versions: new Map([[invokedCodex, '0.152.1'], [extracted.codex, '0.152.1']]),
    xattrResults: new Map([[extracted.codex, { ok: false, timedOut: true, output: 'xattr did not respond' }]]),
  });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'darwin', homeDir: layout.home,
  });

  assert.equal(report.fallback.quarantineStatus, 'indeterminate');
  assert.equal(report.ready, false);
  assert.equal(report.selected, null);
  assert.equal(report.blocker.code, 'no_complete_pair');
  assert.match(report.blocker.message, /quarantine state could not be determined/);
});

test('complete quarantined cask remains ready as an advisory without a fallback', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { realCodex, invokedCodex } = makePathCask(layout);
  const quarantine = '0381;test-quarantine';
  const run = fakeRun({
    versions: new Map([[invokedCodex, '0.152.1']]),
    quarantines: new Map([[realCodex, quarantine]]),
  });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'darwin', homeDir: layout.home,
  });

  assert.equal(report.ready, true);
  assert.equal(report.selected.source, 'configured');
  assert.equal(report.selected.quarantined, true);
  assert.equal(report.blocker, null);
  assert.ok(report.warnings.some((warning) => /com\.apple\.quarantine/.test(warning)));
});

test('PATH symlink falls back to a real helper beside the invoked path', (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  const { realCodex, invokedCodex } = makePathCask(layout, { helper: false, invokedHelper: true });
  const invokedHelper = join(layout.pathDir, 'codex-code-mode-host');
  const run = fakeRun({ versions: new Map([[invokedCodex, '0.152.1']]) });

  const report = inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir }, run, platform: 'linux', homeDir: layout.home,
  });

  assert.equal(report.installed.path, invokedCodex);
  assert.equal(report.installed.realPath, realCodex);
  assert.equal(report.installed.helperPath, invokedHelper);
  assert.equal(report.installed.helperSource, 'invoked-sibling');
  assert.equal(report.selected.source, 'configured');
});

test('module import and inspection are safe when codex is missing', async (t) => {
  const layout = sandbox();
  t.after(() => rmSync(layout.root, { recursive: true, force: true }));
  mkdirSync(layout.pathDir, { recursive: true });

  const imported = await import(`./codex-install.mjs?missing=${Date.now()}`);
  assert.equal(typeof imported.inspectCodexAppServerInstallation, 'function');
  assert.doesNotThrow(() => imported.inspectCodexAppServerInstallation({
    env: { PATH: layout.pathDir },
    run: fakeRun(),
    platform: 'linux',
    homeDir: layout.home,
  }));
});
