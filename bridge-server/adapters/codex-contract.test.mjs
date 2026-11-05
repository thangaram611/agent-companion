import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME } from '../../test/sandbox-home.mjs';
import { fakeCodexBin } from '../../test/fake-codex-app-server.mjs';
import { pinnedSchemaDump } from '../../test/codex-schema-dump.mjs';

for (const verdict of ['match', 'drift', 'unverified']) {
  test(`first adapter start caches advisory contract ${verdict} without refusing service`, async (t) => {
    const module = await import(`./codex.mjs${verdict === 'match' ? '' : '?contract=' + verdict}`);
    const dir = mkdtempSync(join(SANDBOX_HOME, 'schema-test-'));
    const bin = fakeCodexBin(dir);
    const count = join(dir, 'schema-count');
    const source = readFileSync(bin, 'utf8');
    const newline = source.indexOf('\n');
    writeFileSync(bin, source.slice(0, newline + 1) + `
if (process.argv.includes('generate-json-schema')) appendFileSync(${JSON.stringify(count)}, 'probe\\n');
` + source.slice(newline + 1));
    const schema = pinnedSchemaDump();
    if (verdict === 'drift') {
      const path = join(schema, 'ClientRequest.json');
      const json = JSON.parse(readFileSync(path));
      json.oneOf.find((entry) => entry.properties.method.enum[0] === 'turn/start').properties.params.required.push('newRequired');
      writeFileSync(path, JSON.stringify(json));
    }
    const env = { ...process.env, CODEX_FAKE_SCHEMA_DIR: verdict === 'unverified' ? '' : schema };
    const installation = { ready: true, selected: { path: bin, helperPath: bin, version: 'test-version' } };
    const children = [];
    const supervisor = { spawn: async (argv, options) => {
      const child = spawn(argv[0], argv.slice(1), options); children.push(child); return child;
    } };
    const adapters = [0, 1].map(() => new module.CodexAdapter({ env, inspectInstallation: () => installation }));
    t.after(async () => { for (const adapter of adapters) await adapter.close(); for (const child of children) child.kill('SIGKILL'); });
    assert.equal(module.getCodexContractStatus(), 'unverified');
    await Promise.all(adapters.map((adapter) => adapter.start({ cwd: dir, supervisor })));
    assert.equal(await module.checkCodexContract(installation, env), verdict);
    assert.equal(module.getCodexContractStatus(), verdict);
    assert.deepEqual(await adapters[0].openHistory({ historyId: null }), { historyId: 'T1', effectiveModel: undefined, effectiveEffort: undefined });
    assert.equal(await module.checkCodexContract({ selected: { path: '/missing' } }, {}), verdict);
    assert.equal(readFileSync(count, 'utf8'), 'probe\n');
    if (verdict === 'match') {
      const { dispatch } = await import('../server.mjs');
      assert.equal((await dispatch({ action: 'status' })).structuredContent.contractStatus, verdict);
      const catalog = (await dispatch({ action: 'catalog' })).structuredContent;
      assert.equal(catalog.targets.find((target) => target.id === 'codex').contractStatus, verdict);
    }
  });
}
