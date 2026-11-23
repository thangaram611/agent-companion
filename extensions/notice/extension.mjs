if (process.env.AGENT_COMPANION_JOB === undefined) {
  const { joinSession } = await import('@microsoft/copilot-sdk/extension');
  const { serveNotices } = await import('../../lib/hosts/copilot-notice.mjs');
  const { runtimeRoot } = await import('../../lib/hosts/runtime.mjs');
  const { copilot } = await import('../../lib/hosts/copilot.mjs');
  const session = await joinSession({ tools: [], hooks: {} });
  const close = await serveNotices(runtimeRoot(copilot, process.env), session);
  process.once('exit', close);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
}
