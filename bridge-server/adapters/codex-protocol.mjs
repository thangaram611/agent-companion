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

// Historical exec comparisons below describe the transport retired in Phase 3;
// the resolver and measured app-server policy remain in use.
// Where the network decision actually lives on this transport — measured
// 2026-08-11 against codex-cli 0.147.0's own schema, after shipping with it
// unmeasured and `network_applied: false`.
//
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
// EVERY VARIANT'S `networkAccess` DEFAULTS TO ITS RESTRICTIVE VALUE — `false` for
// the two booleans, `'restricted'` for `externalSandbox`'s enum (the schema
// declares both defaults). So silence here is the RESTRICTIVE direction, the
// exact opposite of the exec transport, where omitting
// `-c sandbox_workspace_write.network_access=` defers to the user's config.toml
// and fails OPEN. Both adapters must therefore be explicit, for opposite
// reasons, and this builds an explicit variant for every mode:
//
//   workspace-write     → `networkAccess` = the exec resolver's answer, i.e. ON
//                         by default (so a delegated job can `npm install`) and
//                         OFF only on AGENT_COMPANION_CODEX_NETWORK=off. Silence
//                         would fall OFF and quietly diverge from exec.
//   read-only           → `networkAccess: false`. The exec resolver reports
//                         `network: null` here — its toggle is the
//                         workspace-write-scoped config key, so the bridge has
//                         no opinion in this mode — and false is both the
//                         union's own default and what `--sandbox read-only`
//                         gives on exec. Stated rather than left to silence, so
//                         the two transports agree by construction.
//   danger-full-access  → no `networkAccess` field exists on the variant: the
//                         sandbox is gone, so nothing is restricted. Falls open,
//                         which is what the mode asks for on both transports.
//   bypass              → collapses onto `dangerFullAccess`, exactly as the mode
//                         mapping above already does. NOT `externalSandbox`,
//                         even though "the bridge is already sandboxed" is
//                         literally what bypass means here: that variant's
//                         network vocabulary is a different one
//                         (`restricted|enabled`, not a boolean), its semantics
//                         were never measured, and the exec flag it translates
//                         (`--dangerously-bypass-approvals-and-sandbox`) has one
//                         sandbox effect — removing it. A second, unmeasured
//                         spelling of the same intent could only disagree with
//                         the mode already sent on `thread/start`.
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
// top-level field PRESENCE only, by design (lib/codex-app-server-contract.mjs) —
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
    // sandbox an operator reads in `agent_status` should be the object that
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

