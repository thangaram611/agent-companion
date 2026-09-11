// Resolve the Codex app-server executable as an installation *pair*: the
// `codex` parent and the local `codex-code-mode-host` it will spawn. A version
// probe alone is not readiness — Codex can start successfully and then finish
// every delegated job without executing a command when the helper is absent.
//
// This module is synchronous because broker selection happens before spawn.
// Every default child probe is bounded and killed if it hangs;
// `run` is injectable so diagnostics and tests never have to execute a real
// Codex binary.

import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';

import { parseCodexVersion } from './codex-app-server-contract.mjs';
import { probeCommand } from './command-probe.mjs';

const CODEX_NAME = 'codex';
const HELPER_NAME = 'codex-code-mode-host';
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

function safeRun(run, cmd, args) {
  try {
    const result = run(cmd, args);
    if (!result || typeof result !== 'object') {
      return { ok: false, output: '', error: 'probe returned no result' };
    }
    return {
      ...result,
      ok: result.ok === true,
      output: String(result.output || '').trim(),
    };
  } catch (err) {
    return {
      ok: false,
      output: '',
      error: String(err?.message || err),
      code: err?.code || null,
      timedOut: err?.code === 'ETIMEDOUT',
    };
  }
}

// `stat` intentionally follows the configured Codex symlink: Homebrew exposes
// the cask that way. Helpers are stricter (`lstat().isFile()` below) so an old
// `/opt/homebrew/bin/codex-code-mode-host` symlink hack is not mistaken for a
// healthy packaged pair.
function isExecutableFile(path) {
  if (!path) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableRegularFile(path) {
  if (!path) return false;
  try {
    if (!lstatSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(command, platform, env) {
  if (platform !== 'win32' || extname(command)) return [command];
  const pathExt = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  return [command, ...pathExt.map((suffix) => `${command}${suffix}`)];
}

function containsPathSeparator(command) {
  return command.includes('/') || command.includes('\\');
}

// Mirror execvp-style PATH lookup without invoking a shell. The returned path
// is the invoked path (often Homebrew's symlink), while inspectPair separately
// retains the canonical path that identifies the cask payload.
function resolveCommand(command, env, platform) {
  if (containsPathSeparator(command) || isAbsolute(command)) {
    const invokedPath = isAbsolute(command) ? resolve(command) : resolve(process.cwd(), command);
    return { path: invokedPath, executable: isExecutableFile(invokedPath) };
  }

  const separator = platform === 'win32' ? ';' : ':';
  const pathEntries = String(env.PATH || '').split(separator);
  for (const entry of pathEntries) {
    const base = resolve(entry || '.');
    for (const name of executableNames(command, platform, env)) {
      const candidate = join(base, name);
      if (isExecutableFile(candidate)) return { path: candidate, executable: true };
    }
  }
  return { path: null, executable: false };
}

function fileIdentity(realPath) {
  if (!realPath) return null;
  try {
    const stat = statSync(realPath);
    // A string is deliberately used as the comparison token written into
    // broker metadata. Including both path and inode metadata detects an
    // in-place cask replacement as well as a version-directory change.
    return JSON.stringify({
      realPath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  } catch {
    // A real path without readable metadata is still more useful than no
    // identity at all, and preserves upgrade detection by versioned path.
    return realPath;
  }
}

function inspectQuarantine(path, platform, run) {
  if (platform !== 'darwin') {
    return { status: 'not_applicable', value: null, error: null };
  }
  if (!path) {
    return { status: 'not_checked', value: null, error: null };
  }
  const result = safeRun(run, 'xattr', ['-p', 'com.apple.quarantine', path]);
  if (result.ok) {
    // Exit status, not a truthy value, proves the attribute exists. Keep an
    // empty value distinguishable from an absent attribute.
    return { status: 'present', value: result.output, error: null };
  }

  const code = String(result.code || '').toUpperCase();
  const detail = String(result.error || result.output || '').trim();
  const definitelyAbsent = code === 'ENOATTR'
    || code === 'ENODATA'
    || /\bno such (?:xattr|extended attribute)\b/i.test(detail);
  if (definitelyAbsent) {
    return { status: 'absent', value: null, error: null };
  }

  return {
    status: 'indeterminate',
    value: null,
    error: detail || (result.timedOut ? 'xattr probe timed out' : 'xattr probe failed'),
  };
}

function definitelyUnquarantined(pair) {
  return pair?.quarantineStatus === 'absent'
    || pair?.quarantineStatus === 'not_applicable';
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter(({ path }) => {
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function helperCandidates(invokedPath, realPath, { extracted = false } = {}) {
  const canonicalDir = realPath ? dirname(realPath) : null;
  const invokedDir = invokedPath ? dirname(invokedPath) : null;

  if (extracted) {
    return canonicalDir
      ? [{ path: join(canonicalDir, HELPER_NAME), source: 'bin-sibling' }]
      : [];
  }

  return uniquePaths([
    // Package archives put resources next to `bin/`, and Codex checks this
    // location before the binary sibling.
    canonicalDir && {
      path: join(dirname(canonicalDir), 'codex-resources', HELPER_NAME),
      source: 'codex-resources',
    },
    canonicalDir && {
      path: join(canonicalDir, HELPER_NAME),
      source: 'bin-sibling',
    },
    // Codex's last fallback uses the noncanonical current_exe parent. This is
    // why an incomplete Homebrew cask reported /opt/homebrew/bin/<helper>.
    invokedDir && {
      path: join(invokedDir, HELPER_NAME),
      source: 'invoked-sibling',
    },
  ].filter(Boolean));
}

function unavailablePair(path, error) {
  return {
    path,
    realPath: null,
    version: null,
    helperPath: null,
    helperSource: null,
    quarantine: null,
    quarantineStatus: 'not_checked',
    quarantineError: null,
    quarantined: false,
    complete: false,
    identity: null,
    error,
  };
}

function inspectPair(path, { executable = isExecutableFile(path), extracted = false, platform, run }) {
  if (!path || !executable) return unavailablePair(path || null, 'codex executable not found');

  let realPath;
  try {
    realPath = realpathSync(path);
  } catch (err) {
    return unavailablePair(path, `could not resolve codex executable: ${err?.message || err}`);
  }

  const versionResult = safeRun(run, path, ['--version']);
  const version = versionResult.ok ? parseCodexVersion(versionResult.output) : null;
  let helperPath = null;
  let helperSource = null;
  for (const candidate of helperCandidates(path, realPath, { extracted })) {
    if (!isExecutableRegularFile(candidate.path)) continue;
    helperPath = candidate.path;
    helperSource = candidate.source;
    break;
  }

  const quarantineProbe = inspectQuarantine(realPath, platform, run);
  let error = null;
  if (!version) error = versionResult.error || versionResult.output || 'codex version unavailable';
  else if (!helperPath) error = `executable ${HELPER_NAME} not found beside codex`;

  return {
    path,
    realPath,
    version,
    helperPath,
    helperSource,
    quarantine: quarantineProbe.value,
    quarantineStatus: quarantineProbe.status,
    quarantineError: quarantineProbe.error,
    quarantined: quarantineProbe.status === 'present',
    complete: Boolean(version && helperPath),
    identity: fileIdentity(realPath),
    error,
  };
}

function selectedPair(pair, source) {
  if (!pair) return null;
  return {
    path: pair.path,
    realPath: pair.realPath,
    version: pair.version,
    helperPath: pair.helperPath,
    source,
    identity: pair.identity,
    quarantined: pair.quarantined,
    quarantineStatus: pair.quarantineStatus,
  };
}

function blockerFor(installed, fallback, configured) {
  if (!installed.path || !installed.realPath) {
    return {
      code: 'codex_missing',
      message: `Configured Codex ${JSON.stringify(configured.command)} could not be resolved to an executable file; install Codex or set CODEX_BIN to its executable path.`,
    };
  }
  if (!installed.version) {
    return {
      code: 'no_complete_pair',
      message: `Could not read a Codex semantic version from ${installed.path}; verify CODEX_BIN and \`${installed.path} --version\`.`,
    };
  }
  if (fallback.complete && fallback.version !== installed.version) {
    return {
      code: 'fallback_version_mismatch',
      message: `Configured Codex is ${installed.version}, but the extracted app-server pair is ${fallback.version}; update ChatGPT/Codex so the versions match or restore the configured ${HELPER_NAME}.`,
    };
  }
  if (!installed.helperPath && !fallback.complete) {
    return {
      code: 'code_mode_host_missing',
      message: `Codex ${installed.version} at ${installed.path} has no executable regular ${HELPER_NAME}, and no complete extracted app-server pair is available.`,
    };
  }
  if (
    !installed.helperPath
    && fallback.complete
    && fallback.version === installed.version
    && fallback.quarantineStatus === 'indeterminate'
  ) {
    return {
      code: 'no_complete_pair',
      message: `The extracted Codex app-server pair matches ${installed.version}, but its com.apple.quarantine state could not be determined (${fallback.quarantineError || 'xattr probe failed'}); restore the configured ${HELPER_NAME} or make the read-only xattr probe available.`,
    };
  }
  if (
    !installed.helperPath
    && fallback.complete
    && fallback.version === installed.version
    && fallback.quarantined
  ) {
    return {
      code: 'no_complete_pair',
      message: `The only complete Codex app-server pair for ${installed.version} is the quarantined extracted pair at ${fallback.realPath}; restore the configured ${HELPER_NAME} or install an unquarantined matching pair.`,
    };
  }
  return {
    code: 'no_complete_pair',
    message: 'No complete, version-matched Codex app-server pair is available.',
  };
}

/**
 * Inspect and select the local Codex app-server installation synchronously.
 *
 * `run(cmd, args)` returns `{ ok, output }`; the default is bounded and kills
 * an unresponsive probe with SIGKILL.
 */
export function inspectCodexAppServerInstallation({
  env = process.env,
  run,
  platform = process.platform,
  homeDir,
} = {}) {
  const probe = typeof run === 'function'
    ? run
    : (cmd, args) => probeCommand(cmd, args, { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
  const override = String(env.CODEX_BIN || '').trim();
  const command = override || CODEX_NAME;
  const configured = {
    command,
    explicit: Boolean(override),
    source: override ? 'env' : 'path',
  };

  const resolved = resolveCommand(command, env, platform);
  const installed = inspectPair(resolved.path, {
    executable: resolved.executable,
    platform,
    run: probe,
  });

  const effectiveHome = String(homeDir || env.HOME || env.USERPROFILE || homedir()).trim();
  const configuredCodexHome = String(env.CODEX_HOME || '').trim();
  const codexHome = configuredCodexHome
    ? (isAbsolute(configuredCodexHome) ? configuredCodexHome : resolve(configuredCodexHome))
    : join(effectiveHome, '.codex');
  const fallbackPath = join(codexHome, 'plugins', '.plugin-appserver', CODEX_NAME);
  const fallback = inspectPair(fallbackPath, {
    platform,
    run: probe,
    extracted: true,
  });

  const warnings = [];
  let selected = null;

  if (installed.complete && definitelyUnquarantined(installed)) {
    selected = selectedPair(installed, 'configured');
  } else if (
    installed.version &&
    fallback.complete &&
    fallback.version === installed.version &&
    definitelyUnquarantined(fallback)
  ) {
    selected = selectedPair(fallback, 'plugin-appserver');
    const reasons = [];
    if (!installed.helperPath) reasons.push(`the configured Codex has no executable ${HELPER_NAME}`);
    if (installed.quarantined) reasons.push('the configured Codex parent is quarantined');
    if (installed.quarantineStatus === 'indeterminate') {
      reasons.push(`the configured Codex quarantine state is indeterminate (${installed.quarantineError || 'xattr probe failed'})`);
    }
    warnings.push(`Using the extracted Codex app-server pair at ${fallback.path} because ${reasons.join(' and ') || 'it is the only definitely unquarantined matching pair'}.`);
  } else if (installed.complete) {
    // Quarantine is surfaced, but remains advisory: a current 0.152.1 smoke
    // proved a complete signed cask pair can execute successfully while the
    // attribute is present. Blocking it would turn a warning into an outage.
    selected = selectedPair(installed, 'configured');
    if (installed.quarantined) {
      // The remedy is the operator's, not the bridge's (see ARCHITECTURE
      // Negative Results): Homebrew removed its `--no-quarantine` switch
      // (Homebrew/brew#20755, closed 2025-11-05), so nothing at install time
      // can pre-empt the attribute and it returns with every cask upgrade.
      warnings.push(`Configured Codex at ${installed.realPath} carries com.apple.quarantine (${installed.quarantine}); no usable same-version unquarantined extracted pair was found. Agent Companion never removes the attribute; if a detached app-server launch hits a Gatekeeper dialog, strip it yourself with \`xattr -d com.apple.quarantine ${installed.realPath}${installed.helperPath ? ` ${installed.helperPath}` : ''}\` and again after each cask upgrade — Homebrew dropped --no-quarantine (brew#20755), so no install-time switch exists.`);
    } else if (installed.quarantineStatus === 'indeterminate') {
      warnings.push(`Could not determine whether configured Codex at ${installed.realPath} carries com.apple.quarantine (${installed.quarantineError || 'xattr probe failed'}); no definitely-unquarantined same-version extracted pair was found, so the complete configured pair remains selected as an advisory.`);
    }
    if (fallback.complete && fallback.version !== installed.version) {
      warnings.push(`Extracted app-server Codex ${fallback.version} does not match configured Codex ${installed.version}; keeping the complete configured pair.`);
    } else if (fallback.quarantined) {
      warnings.push(`Extracted app-server Codex at ${fallback.realPath} is also quarantined.`);
    } else if (fallback.complete && fallback.quarantineStatus === 'indeterminate') {
      warnings.push(`Could not determine whether extracted app-server Codex at ${fallback.realPath} carries com.apple.quarantine (${fallback.quarantineError || 'xattr probe failed'}).`);
    }
  }

  const ready = Boolean(selected);
  return {
    configured,
    installed,
    fallback,
    selected,
    ready,
    blocker: ready ? null : blockerFor(installed, fallback, configured),
    warnings,
  };
}
