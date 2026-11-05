// The CLI dialect shared by dispatch, onboarding and readiness diagnostics.

export function openCodeCliMajor(version) {
  return Number(String(version || '').match(/\bv?(\d+)\.\d+(?:\.\d+)?/)?.[1] || 0);
}

export function probeOpenCodeAuth({ run, install }) {
  if (openCodeCliMajor(install.version) < 2) {
    const result = run(install.binary, ['models']);
    return { authenticated: Boolean(result.ok && result.output), detail: 'model listing' };
  }
  // V2 did not list this machine's working pinned model. Check native
  // connection metadata instead, without exposing provider secrets.
  const result = run(install.binary, ['auth', 'list', '--standalone', '--format', 'json']);
  if (!result.ok) return { authenticated: 'unknown', detail: 'native credential check failed' };
  let integrations;
  try { integrations = JSON.parse(result.output); }
  catch { return { authenticated: 'unknown', detail: 'native credential metadata was unreadable' }; }
  if (!Array.isArray(integrations)) return { authenticated: 'unknown', detail: 'native credential metadata was not a list' };
  return { authenticated: integrations.some(i => Array.isArray(i.connections) && i.connections.length > 0), detail: 'native provider connections' };
}
