export function resolveCodexSandbox(env = process.env) {
  const raw = String(env.AGENT_COMPANION_CODEX_SANDBOX_MODE || '').trim().toLowerCase();

  if (raw === 'read-only') {
    return { mode: 'read-only', network: null, args: ['--sandbox', 'read-only'], source: 'env' };
  }
  if (raw === 'danger-full-access') {
    return { mode: 'danger-full-access', network: null, args: ['--sandbox', 'danger-full-access'], source: 'env' };
  }
  if (raw === 'bypass') {
    return { mode: 'bypass', network: null, args: ['--dangerously-bypass-approvals-and-sandbox'], source: 'env' };
  }

  const source = raw === 'workspace-write' ? 'env' : raw ? 'fallback' : 'default';
  const networkOff = String(env.AGENT_COMPANION_CODEX_NETWORK || '').trim().toLowerCase() === 'off';
  const network = !networkOff;
  return {
    mode: 'workspace-write',
    network,
    // ONE argv token per `-c key=value` pair — no shell quoting needed
    // (spawn, not shell).
    args: ['--sandbox', 'workspace-write', '-c', `sandbox_workspace_write.network_access=${network}`],
    source,
  };
}


const APP_SERVER_SANDBOX_BY_EXEC_MODE = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
  bypass: 'danger-full-access',
};

// `thread/start`/`thread/resume` carry `sandbox`, which is the bare `SandboxMode`
// enum (`read-only | workspace-write | danger-full-access`) and has NO network
// option at all; the start response echoes `networkAccess: false` whatever the
// mode. The network lives one level down, on `turn/start`'s `sandboxPolicy` — a
// tagged union whose variants are:
//   {type:'workspaceWrite',  networkAccess, writableRoots, excludeSlashTmp, excludeTmpdirEnvVar}
//   {type:'readOnly',        networkAccess}
//   {type:'dangerFullAccess'}
//   {type:'externalSandbox', networkAccess:'restricted'|'enabled'}
//
// The schema defaults network access to false on the two boolean variants.
// Set it explicitly from the workspace-write setting. Read-only disables it,
// and both unrestricted modes use dangerFullAccess, which has no network field.
// Bypass is not externalSandbox: that variant's network semantics were never measured.
//
// THE TAGS ARE camelCase WHILE `thread/start`'s MODE ENUM IS kebab-case, and the
// same job sends both on the same transport — so mis-spelling one as the other is
// the live hazard here, not a hypothetical. Measured against the real 0.147.0
// server for zero tokens (every call aimed at the all-zero thread id, so anything
// that survives deserialization dies on `thread not found` before a model runs):
//   {type:'workspaceWrite', networkAccess:true|false}  → thread not found
//   {type:'readOnly', networkAccess:false}             → thread not found
//   {type:'dangerFullAccess'}                          → thread not found
//     …i.e. all three literals below are ACCEPTED shapes, not merely plausible.
//   {type:'workspace-write', …}  → -32600 "unknown variant `workspace-write`,
//                                  expected one of `dangerFullAccess`, `readOnly`,
//                                  `externalSandbox`, `workspaceWrite`"
//   {type:'workspaceWrite', networkAccess:'enabled'} → invalid type: string
//   {networkAccess:true}                             → missing field `type`
// The fakes cannot catch that first refusal — the pinned contract validates
// top-level field PRESENCE only, by design (test/codex-contract-frames.mjs) —
// so the adapter's own test asserts the tag against that measured vocabulary.
//
// ⚠️ A sandboxPolicy REPLACES the policy, it does not patch it, and
// `writableRoots` defaults to `[]`. The job's own working root is NOT at risk —
// measured, the rollout records it under `turn_context.workspace_roots`, derived
// from the `cwd` this adapter sends, separately from `sandbox_policy`. What is
// at risk is an EXTRA `[sandbox_workspace_write] writable_roots` list in the
// user's config.toml: it reaches `thread/start`'s mode-derived policy and not
// the per-turn override. The bridge has no source for that list (it deliberately
// parses no config.toml), and the only alternative — omitting `sandboxPolicy` —
// reinstates the network divergence this exists to close. Recorded as the known
// cost of applying the network at all; unmeasured, since this machine configures
// no extra roots.
function sandboxPolicyFor(mode, network) {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', networkAccess: network === true };
}

export function codexAppServerSandbox(env = process.env) {
  const exec = resolveCodexSandbox(env);
  const mode = APP_SERVER_SANDBOX_BY_EXEC_MODE[exec.mode] || 'workspace-write';
  return {
    mode,
    network: exec.network,
    // The union that goes on `turn/start`. Reported here too, because the
    // sandbox an operator reads in `companion_status` should be the object that
    // reached the wire and not a paraphrase of it.
    policy: sandboxPolicyFor(mode, exec.network),
    // True since the param was measured: the policy above is sent on every
    // `turn/start`, and the rollout's `turn_context.sandbox_policy` records it
    // applied (`{"type":"workspace-write","network_access":true,…}`) rather than
    // merely accepted. It read `false` while the param name was unknown, which
    // was honest then and is a lie now.
    network_applied: true,
    source: exec.source,
  };
}

const STEER_CONFIRM_MS = 5_000;
const MAX_STEER_CONFIRM_MS = 120_000;

export function resolveSteerConfirmMs(env = process.env) {
  const raw = env.AGENT_COMPANION_CODEX_STEER_CONFIRM_MS;
  if (raw === undefined || raw === '') return STEER_CONFIRM_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return STEER_CONFIRM_MS;
  return Math.min(parsed, MAX_STEER_CONFIRM_MS);
}


const MAX_LINE_BYTES = 8 * 1024 * 1024;
export class LineReader {
  constructor({ maxLineBytes = MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.buf = '';
    // True while discarding the tail of an over-cap line: everything up to the
    // next newline belongs to a frame we already gave up on.
    this.overflow = false;
  }

  push(chunk) {
    const lines = [];
    let dropped = 0;
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.overflow) {
        this.overflow = false;
        dropped += 1;
        continue;
      }
      // A complete over-cap line has to be dropped here too. Capping only the
      // residual buffer below would let a frame that arrived whole inside one
      // chunk through at any size — the guard would hold only for lines that
      // happened to straddle a chunk boundary.
      if (line.length > this.maxLineBytes) {
        dropped += 1;
        continue;
      }
      if (line.trim()) lines.push(line);
    }
    if (this.buf.length > this.maxLineBytes) {
      this.buf = '';
      this.overflow = true;
    }
    return { lines, dropped };
  }
}

