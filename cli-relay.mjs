#!/usr/bin/env node
/**
 * cli-relay.mjs — persistent CLI router: resume-by-reference across pluggable backends.
 *
 * Usage:
 *   cli-relay [--dry-run|--print-command] <backend> <thread> <fresh|resume> <prompt...>
 *   cli-relay list
 *   cli-relay doctor
 *   cli-relay reset <thread>
 *   cli-relay pin <thread> "<fact>"
 *   cli-relay unpin <thread> <index>
 *   cli-relay pins <thread>
 *
 * Exit codes:
 *   0  success
 *   1  general error or backend spawn failure
 *   2  usage error
 *   3  backend produced an id/exit-0-shaped result but no usable answer
 */

import { spawn } from 'node:child_process';
import { cmdDoctor } from './src/commands/doctor.mjs';
import { cmdList } from './src/commands/list.mjs';
import { cmdPin } from './src/commands/pin.mjs';
import { cmdPins } from './src/commands/pins.mjs';
import { cmdReset } from './src/commands/reset.mjs';
import { cmdUnpin } from './src/commands/unpin.mjs';
import {
  LOCK_STALE_MS,
  MAP_PATH,
  RESUME_FAILURE_THRESHOLD,
  RESUME_WARNING_THRESHOLD,
  SPAWN_KILL_GRACE_MS,
  SPAWN_TIMEOUT_MS,
} from './src/config.mjs';
import { scrubEnv } from './src/core/env.mjs';
import { RelayError } from './src/core/errors.mjs';
import { withLock } from './src/core/lock.mjs';
import { loadMap, saveMap } from './src/core/map-store.mjs';
import { buildPinnedBlock } from './src/core/pins.mjs';
import { withThreadSuggestions } from './src/core/thread-lookup.mjs';

let activeChildPgid = null;
let childHasFinished = false;
let userInterrupted = false;
let interruptSignal = null;

function interruptExitCode() {
  return 128 + (interruptSignal === 'SIGTERM' ? 15 : 2);
}

function runChild(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const pgid = child.pid;
    activeChildPgid = pgid;
    let out = '';
    let err = '';
    let timedOut = false;
    let cancelled = false;
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err += data; });

    const killGroup = (signal) => {
      try { process.kill(-pgid, signal); } catch {}
    };
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      cancelled = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), SPAWN_KILL_GRACE_MS);
    }, SPAWN_TIMEOUT_MS);

    const clearAllTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.on('error', (error) => {
      clearAllTimers();
      activeChildPgid = null;
      childHasFinished = true;
      resolve({
        code: null,
        signal: null,
        out,
        err: `${err}\nspawn error: ${error.message}`,
        timedOut: false,
        cancelled: userInterrupted,
      });
    });
    child.on('exit', (code, signal) => {
      clearAllTimers();
      activeChildPgid = null;
      childHasFinished = true;
      resolve({
        code,
        signal,
        out,
        err,
        timedOut,
        cancelled: cancelled || userInterrupted,
      });
    });
  });
}

async function runHousekeeping(cliArgs) {
  if (cliArgs[0] === 'list') {
    cmdList();
    return true;
  }
  if (cliArgs[0] === 'reset') {
    await cmdReset(cliArgs[1]);
    return true;
  }
  if (cliArgs[0] === 'pin') {
    await cmdPin(cliArgs[1], cliArgs.slice(2).join(' '));
    return true;
  }
  if (cliArgs[0] === 'unpin') {
    await cmdUnpin(cliArgs[1], cliArgs[2]);
    return true;
  }
  if (cliArgs[0] === 'pins') {
    cmdPins(cliArgs[1]);
    return true;
  }
  return false;
}

function printUsage(backends) {
  console.error(
    'usage: cli-relay [--dry-run|--print-command] ' +
    '<backend> <thread> <fresh|resume> <prompt...>',
  );
  console.error('       cli-relay list');
  console.error('       cli-relay doctor');
  console.error('       cli-relay reset <thread>');
  console.error('       cli-relay pin <thread> "<fact>"');
  console.error('       cli-relay unpin <thread> <index>');
  console.error('       cli-relay pins <thread>');
  console.error(`backends: ${Object.keys(backends).join(', ')}`);
}

function sessionForInvocation(map, backend, thread, mode, adapter) {
  const existing = map.sessions[thread];
  const session = existing ?? {
    backend,
    native_session_id: null,
    confirmed: false,
  };
  if (session.backend !== backend) {
    throw new RelayError(
      'THREAD_OWNERSHIP_MISMATCH',
      `thread "${thread}" belongs to backend "${session.backend}", not "${backend}" — ` +
      'pick a new thread name',
    );
  }
  if (mode === 'resume') {
    if (!adapter.resume) {
      throw new RelayError(
        'RESUME_UNSUPPORTED',
        `"${backend}" has no supported resume command in this router — must run fresh`,
      );
    }
    if (!session.confirmed || !session.native_session_id) {
      const message = `no confirmed session for thread "${thread}" — ` +
        'run fresh first; refusing to guess';
      throw new RelayError(
        'NO_CONFIRMED_SESSION',
        existing ? message : withThreadSuggestions(message, map.sessions, thread),
      );
    }
  }
  return session;
}

// Shared by --dry-run and critical section 1 — a dry-run preview must refuse the exact
// same cases a real run would refuse (found in review: dry-run intentionally skips the
// lock, but that means it also silently skipped this check, printing a preview for a
// command that would actually be refused).
function assertNotInFlight(session, thread) {
  if (session.status !== 'running') return;
  const ageMs = Date.now() - Date.parse(session.run_started_iso || 0);
  if (Number.isFinite(ageMs) && ageMs < LOCK_STALE_MS) {
    throw new RelayError(
      'RUN_IN_FLIGHT',
      `thread "${thread}" has a run already in flight (started ` +
      `${session.run_started_iso}) — refusing a concurrent turn on the same native session`,
    );
  }
  console.error(
    `warning: thread "${thread}" was left mid-run (started ${session.run_started_iso}, ` +
    `stale) — the previous invocation likely crashed. Proceeding from its last confirmed id.`,
  );
}

async function main() {
  const cliArgs = process.argv.slice(2);

  // Adapter loading is intentionally below housekeeping dispatch. A malformed optional user
  // adapter must not prevent map-only recovery commands from listing, fixing, or resetting state.
  if (await runHousekeeping(cliArgs)) process.exit(0);

  const { loadAdapters } = await import('./src/adapter-loader.mjs');
  const adapters = await loadAdapters();
  if (cliArgs[0] === 'doctor') {
    await cmdDoctor(adapters);
    process.exit(0);
  }

  const dryRun = cliArgs.includes('--dry-run') || cliArgs.includes('--print-command');
  const routingArgs = cliArgs.filter(
    (argument) => argument !== '--dry-run' && argument !== '--print-command',
  );
  const [backend, thread, mode, ...rest] = routingArgs;
  const prompt = rest.join(' ');

  if (!backend || !thread || !mode || !prompt) {
    printUsage(adapters);
    process.exit(2);
  }
  const adapter = adapters[backend];
  if (!adapter) {
    throw new RelayError(
      'BACKEND_NOT_FOUND',
      `unknown backend "${backend}" — choose one of: ${Object.keys(adapters).join(', ')}`,
      { exitCode: 2 },
    );
  }
  if (mode !== 'fresh' && mode !== 'resume') {
    throw new RelayError(
      'INVALID_MODE',
      `mode must be "fresh" or "resume", got "${mode}"`,
      { exitCode: 2 },
    );
  }

  if (dryRun) {
    const map = loadMap();
    const session = sessionForInvocation(map, backend, thread, mode, adapter);
    assertNotInFlight(session, thread);
    const augmentedPrompt = buildPinnedBlock(session.pinned_facts) + prompt;
    const argv = mode === 'resume'
      ? adapter.resume(session.native_session_id, augmentedPrompt)
      : adapter.fresh(augmentedPrompt);
    console.log(JSON.stringify(argv));
    return;
  }

  // Critical section 1: validate and mark running before spawn.
  const record = await withLock(() => {
    const map = loadMap();
    const session = sessionForInvocation(map, backend, thread, mode, adapter);
    if (mode === 'fresh' && session.confirmed && session.native_session_id) {
      console.error(
        `warning: thread "${thread}" already had a confirmed session ` +
        `(${session.native_session_id}) — starting fresh replaces the pointer; the old session ` +
        `is no longer reachable from this thread name. Pinned facts (if any) are NOT cleared — ` +
        'they carry forward into the new session.',
      );
    }
    assertNotInFlight(session, thread);
    if (mode === 'fresh') {
      session.turn_count = 1;
      session.created_iso = new Date().toISOString();
      delete session.compaction_detected;
    } else {
      session.turn_count = (session.turn_count ?? 1) + 1;
      if (session.turn_count >= RESUME_WARNING_THRESHOLD) {
        console.error(
          `warning: thread "${thread}" is on turn ${session.turn_count} (advisory threshold ` +
          `${RESUME_WARNING_THRESHOLD}) — long-running threads risk silent context compaction ` +
          `inside the backend itself, where an earlier stale fact can outweigh a later ` +
          `correction. Not blocking; pin anything load-bearing now (cli-relay pin "${thread}" ` +
          `"...") if you haven't, then a fresh restart carries it forward automatically.`,
        );
      }
    }

    session.status = 'running';
    session.run_started_iso = new Date().toISOString();
    map.sessions[thread] = session;
    saveMap(map);
    return { ...session };
  });

  const augmentedPrompt = buildPinnedBlock(record.pinned_facts) + prompt;
  const argv = mode === 'resume'
    ? adapter.resume(record.native_session_id, augmentedPrompt)
    : adapter.fresh(augmentedPrompt);
  const env = scrubEnv(adapter.env);
  const { code, signal, out, err, timedOut, cancelled } = await runChild(argv, env);
  const parsed = adapter.parse(out);
  let newId = null;

  const touchedId = parsed.id ?? record.native_session_id;
  let compactionDetected = null;
  try {
    const detected = await adapter.checkCompaction(touchedId, out);
    compactionDetected = detected === true ? true : detected === false ? false : null;
  } catch {
    // Detection is advisory and must never turn a completed backend call into a router failure.
  }
  if (compactionDetected === true) {
    console.error(
      `warning: "${backend}" appears to have compacted its context on thread "${thread}" — ` +
      `earlier facts may have been summarized or reordered. If a recent correction matters, ` +
      `re-state it explicitly rather than trusting it's still accurately in view; consider a ` +
      `fresh restart with a curated recap for anything load-bearing.`,
    );
  }

  if (mode === 'fresh' && (!parsed.id || !parsed.answer)) {
    await withLock(() => {
      const map = loadMap();
      const session = map.sessions[thread];
      if (!session) {
        // A concurrent `cli-relay reset <thread>` deleted this thread while the backend
        // call was in flight (the lock is intentionally released during the spawn — see
        // runChild). Don't resurrect a thread the user just told the router to forget;
        // the outcome has nowhere left to attach to.
        console.error(
          `warning: thread "${thread}" no longer exists in ${MAP_PATH} (reset while this ` +
          `run was in flight) — outcome not recorded.`,
        );
        return;
      }
      session.status = 'ready';
      session.last_run_iso = new Date().toISOString();
      session.last_exit_code = code;
      session.last_signal = signal;
      session.last_timed_out = timedOut;
      session.last_cancelled_by_wrapper = cancelled;
      if (compactionDetected === true) session.compaction_detected = true;
      map.sessions[thread] = session;
      saveMap(map);
    });
    const reason = !parsed.id
      ? 'no parseable session id'
      : 'a session id but no usable answer (possibly an error response — check stdout_tail)';
    console.error(
      `"${backend}" gave ${reason} on a fresh run — NOT marking confirmed.\n` +
      `stderr tail:\n${err.slice(-2000)}\nstdout tail:\n${out.slice(-1000)}`,
    );
    process.exit(userInterrupted ? interruptExitCode() : (parsed.id ? 3 : 1));
  }
  if (mode === 'fresh') newId = parsed.id;

  // Critical section 2: record outcome facts and enforce the resume circuit breaker.
  let autoUnconfirmed = false;
  let resumeFailureCount = 0;
  await withLock(() => {
    const map = loadMap();
    const session = map.sessions[thread];
    if (!session) {
      // Same race as the fresh-failure branch above: a concurrent `reset` deleted this
      // thread mid-run. Warn instead of resurrecting it — this is the case that matters
      // most, since `newId` may hold a genuinely successful fresh run's session id that
      // would otherwise be silently lost with no trace it ever existed.
      console.error(
        `warning: thread "${thread}" no longer exists in ${MAP_PATH} (reset while this run ` +
        `was in flight) — outcome${newId ? ` (including native id ${newId})` : ''} not recorded.`,
      );
      return;
    }
    if (newId) {
      session.native_session_id = newId;
      session.confirmed = true;
      session.consecutive_resume_failures = 0;
    }
    if (mode === 'resume') {
      if (parsed.answer) {
        session.consecutive_resume_failures = 0;
      } else {
        session.consecutive_resume_failures = (session.consecutive_resume_failures ?? 0) + 1;
        if (session.confirmed &&
            session.consecutive_resume_failures >= RESUME_FAILURE_THRESHOLD) {
          session.confirmed = false;
          autoUnconfirmed = true;
        }
      }
      resumeFailureCount = session.consecutive_resume_failures;
    }
    session.status = 'ready';
    session.last_run_iso = new Date().toISOString();
    session.last_exit_code = code;
    session.last_signal = signal;
    session.last_timed_out = timedOut;
    session.last_cancelled_by_wrapper = cancelled;
    if (compactionDetected === true) session.compaction_detected = true;
    map.sessions[thread] = session;
    saveMap(map);
  });

  if (autoUnconfirmed) {
    console.error(
      `"${backend}" thread "${thread}": ${resumeFailureCount} consecutive resume failures ` +
      `(threshold ${RESUME_FAILURE_THRESHOLD}) — auto-un-confirmed. The id is still recorded ` +
      `(see "cli-relay list") but resume is now refused; run fresh to continue this thread.`,
    );
  }

  const payload = {
    backend,
    thread,
    native_session_id: newId ?? record.native_session_id,
    exit_code: code,
    signal: signal ?? null,
    timed_out: timedOut,
    cancelled_by_wrapper: cancelled,
    answer_parsed: parsed.answer != null,
    answer: parsed.answer,
    resume_failure_count: mode === 'resume' ? resumeFailureCount : undefined,
    auto_unconfirmed: autoUnconfirmed,
    turn_count: record.turn_count,
    pins_injected: record.pinned_facts?.length ?? 0,
    compaction_detected: compactionDetected,
    stdout_tail: out.slice(-4000),
  };
  console.log(JSON.stringify(payload, null, 2));

  if (mode === 'resume' && !parsed.answer) {
    console.error(
      `"${backend}" resume produced no parseable answer (child exit ${code}) — ` +
      'see stdout_tail above',
    );
    process.exit(userInterrupted ? interruptExitCode() : (code === 0 ? 3 : (code ?? 1)));
  }
  if (userInterrupted) process.exit(interruptExitCode());
  process.exit(code === null ? 1 : code);
}

function onSignal(signal) {
  if (userInterrupted) {
    if (activeChildPgid) {
      try { process.kill(-activeChildPgid, 'SIGKILL'); } catch {}
    }
    process.exit(interruptExitCode());
  }
  userInterrupted = true;
  interruptSignal = signal;
  if (activeChildPgid) {
    console.error(
      `\ncli-relay: ${signal} received — terminating child and recording outcome ` +
      '(Ctrl-C again to force)...',
    );
    try { process.kill(-activeChildPgid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      if (activeChildPgid) {
        try { process.kill(-activeChildPgid, 'SIGKILL'); } catch {}
      }
    }, SPAWN_KILL_GRACE_MS);
  } else if (childHasFinished) {
    console.error(
      `\ncli-relay: ${signal} received — finishing in-flight bookkeeping before exit ` +
      '(Ctrl-C again to force)...',
    );
  } else {
    console.error(`\ncli-relay: ${signal} received, nothing spawned yet — exiting.`);
    process.exit(interruptExitCode());
  }
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

main().catch((error) => {
  if (error instanceof RelayError) {
    const prefix = error.exitCode === 2 ? '' : 'cli-relay error: ';
    console.error(`${prefix}${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(`cli-relay error: ${error.message}`);
  process.exit(1);
});
