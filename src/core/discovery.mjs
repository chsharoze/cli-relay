import { spawn } from 'node:child_process';
import { ENV_BASE } from './adapter-env.mjs';
import { scrubEnv } from './env.mjs';
import { killProcessTree } from './process-tree.mjs';

// Discovery spawns read a backend's own listing or help text; they never dispatch. A
// backend that hangs must not hang cli-relay, so every discovery spawn is bounded. The
// bound is overridable through the environment so tests can exercise it quickly.
export const DISCOVERY_TIMEOUT_MS = 15_000;

export function discoveryTimeoutMs() {
  const override = Number(process.env.CLI_RELAY_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DISCOVERY_TIMEOUT_MS;
}

// Bounded discovery children run in their own process group, so a terminal Ctrl-C does
// not reach them. The router's signal handler terminates them through this registry.
const activeDiscoveryPids = new Set();

// Kills every running discovery child with its process group. Returns null when the kills
// were synchronous (POSIX, or nothing to kill) and a promise on Windows, where taskkill is
// asynchronous and callers must await it before exiting.
export function terminateDiscoveryChildren() {
  const pending = [];
  for (const pid of activeDiscoveryPids) {
    const result = killProcessTree(pid, 'SIGKILL');
    if (result) pending.push(result);
  }
  activeDiscoveryPids.clear();
  return pending.length > 0 ? Promise.all(pending) : null;
}

export function activeDiscoveryCount() {
  return activeDiscoveryPids.size;
}

// Spawns a backend's listing or help command with the scrubbed base env. With a timeout,
// a child still running at the deadline is killed with its process group and the result
// is `{ error }` with `timedOut: true`; its pipes are released so a lingering grandchild
// cannot keep this process alive.
export function runListing(binary, args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: scrubEnv(ENV_BASE),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: timeoutMs != null && process.platform !== 'win32',
    });
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const tracked = timeoutMs != null && child.pid;
    if (tracked) activeDiscoveryPids.add(child.pid);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (tracked) activeDiscoveryPids.delete(child.pid);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => settle({ error }));
    child.on('close', (code) => settle({ code, out, err }));
    if (timeoutMs != null) {
      timer = setTimeout(() => {
        if (child.pid) killProcessTree(child.pid, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle({
          error: new Error(`timed out after ${timeoutMs / 1000}s`),
          timedOut: true,
        });
      }, timeoutMs);
    }
  });
}

// One bounded discovery read. Resolves to `{ text }` with the command's stdout (plus stderr
// when asked, for help text some CLIs print there), or to `{ text: null, reason }` after
// printing exactly one `warning:` line when it fails to spawn, times out, or exits
// non-zero. Never throws.
export async function discover(binary, args, { includeStderr = false } = {}) {
  const label = [binary, ...args].join(' ');
  let result;
  try {
    result = await runListing(binary, args, { timeoutMs: discoveryTimeoutMs() });
  } catch (error) {
    result = { error };
  }
  let reason = null;
  if (result.error) reason = result.error.message;
  else if (result.code !== 0) reason = `exited ${result.code}`;
  if (reason) {
    console.error(`warning: discovery "${label}" failed (${reason}); continuing without it`);
    return { text: null, reason };
  }
  return { text: includeStderr && result.err ? `${result.out}\n${result.err}` : result.out };
}

export async function discoverText(binary, args, options) {
  return (await discover(binary, args, options)).text;
}
