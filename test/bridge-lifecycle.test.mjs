import './sandbox-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
for (const trigger of ['SIGINT', 'SIGTERM', 'EOF']) {
  test(`bridge loss: ${trigger} invokes the registered async hook once and waits before exit`, { timeout: 15_000 }, async (t) => {
    const server = new URL('../bridge-server/server.mjs', import.meta.url);
    const preload = `
      import { registerBridgeLossHandler } from ${JSON.stringify(server.href)};
      registerBridgeLossHandler(async () => {
        process.send('loss-start');
        await new Promise(resolve => process.once('message', resolve));
        process.send('loss-finished');
      });
      process.send('ready');
    `;
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(server)], { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const messages = [];
    child.on('message', (msg) => messages.push(msg));
    let stderr = '';
    child.stderr.on('data', (part) => { stderr += part; });
    const exited = once(child, 'exit');
    const nextMessage = () => Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code, signal]) => { throw new Error(`bridge exited early (${code ?? signal}): ${stderr}`); }),
    ]);
    assert.equal(await nextMessage(), 'ready');
    const started = nextMessage();
    if (trigger === 'EOF') child.stdin.end();
    else child.kill(trigger);
    assert.equal(await started, 'loss-start');
    // Exercise duplicates and the signal/EOF race while cleanup is awaiting.
    child.kill('SIGINT');
    child.kill('SIGTERM');
    child.stdin.end();
    assert.equal(child.exitCode, null);
    child.send('finish');
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, { SIGINT: 130, SIGTERM: 143, EOF: 0 }[trigger]);
    assert.deepEqual(messages, ['ready', 'loss-start', 'loss-finished']);
  });
}
