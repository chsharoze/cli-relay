#!/usr/bin/env node
/**
 * cli-relay.mjs — persistent CLI router: resume-by-reference across pluggable backends.
 *
 * Usage:
 *   cli-relay [--dry-run|--print-command] [--tier <1-4|name>] [--confirm]
 *     <backend> <thread> <fresh|resume> <prompt...>
 *   cli-relay list
 *   cli-relay doctor
 *   cli-relay audit verify
 *   cli-relay reset <thread>
 *   cli-relay pin <thread> "<fact>"
 *   cli-relay unpin <thread> <index>
 *   cli-relay pins <thread>
 *
 * Dispatch flags must precede the mode argument. They may be interspersed among
 * backend/thread/mode; every token after mode is literal prompt text.
 *
 * Exit codes:
 *   0  success
 *   1  general error or backend spawn failure (also `doctor`, when no backend at
 *      all is usable — a partial install is the normal setup and still exits 0)
 *   2  usage error
 *   3  backend produced an id/exit-0-shaped result but no usable answer
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { cmdAuditVerify } from './src/commands/audit.mjs';
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
import { appendLedgerEntry } from './src/governance/ledger.mjs';

let activeChildPgid = null;
let terminateActiveChild = null;
let childHasFinished = false;
let userInterrupted = false;
let interruptSignal = null;

function interruptExitCode() {
  return 128 + (interruptSignal === 'SIGTERM' ? 15 : 2);
}

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function collectOutput(limitBytes, tailLength) {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  let overflow = false;
  const append = (chunk) => {
    text += chunk;
    if (overflow) {
      text = text.slice(-tailLength);
      // A retained tail must not start halfway through a decoded surrogate pair.
      if (text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) text = text.slice(1);
    }
  };
  return {
    write(data) {
      bytes += data.length;
      if (bytes > limitBytes) overflow = true;
      append(decoder.write(data));
    },
    end() { append(decoder.end()); },
    text: () => text,
    overflowed: () => overflow,
  };
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
    // Keep complete stdout only while it is safe to parse. After the limit, drain
    // both streams but retain diagnostic tails and reject the truncated response.
    const out = collectOutput(MAX_STDOUT_BYTES, 4000);
    const err = collectOutput(0, 16000);
    let timedOut = false;
    let cancelled = false;
    child.stdout.on('data', (data) => out.write(data));
    child.stderr.on('data', (data) => err.write(data));
    child.stdout.on('end', () => out.end());
    child.stderr.on('end', () => err.end());

    const killGroup = (signal) => {
      if (pgid) {
        try { process.kill(-pgid, signal); } catch {}
      }
    };
    let killTimer = null;
    let completion = null;
    let finished = false;
    const finish = () => {
      if (!completion || finished) return;
      // The leader may close its pipes and exit on SIGTERM while a descendant
      // remains in its process group. Keep that group tracked until escalation.
      if (killTimer && pgid) {
        try { process.kill(-pgid, 0); return; } catch {}
      }
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      activeChildPgid = null;
      terminateActiveChild = null;
      childHasFinished = true;
      resolve({
        ...completion,
        out: out.text(),
        err: completion.error ? `${err.text()}\nspawn error: ${completion.error.message}` : err.text(),
        outputOverflow: out.overflowed(),
        timedOut,
        cancelled: cancelled || userInterrupted,
      });
    };
    terminateActiveChild = () => {
      cancelled = true;
      if (killTimer) return;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killTimer = null;
        killGroup('SIGKILL');
        finish();
      }, SPAWN_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateActiveChild();
    }, SPAWN_TIMEOUT_MS);

    child.on('error', (error) => {
      completion = { code: null, signal: null, error };
      clearTimeout(timer);
      finish();
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      completion ??= { code, signal };
      clearTimeout(timer);
      finish();
    });
  });
}

async function runHousekeeping(cliArgs) {
  if (cliArgs[0] === 'audit') {
    if (cliArgs.length !== 2 || cliArgs[1] !== 'verify') {
      console.error('usage: cli-relay audit verify');
      process.exitCode = 2;
      return true;
    }
    const report = cmdAuditVerify();
    process.exitCode = report.intact ? 0 : 1;
    return true;
  }
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
    'usage: cli-relay [--dry-run|--print-command] [--tier <1-4|name>] [--confirm] ' +
    '<backend> <thread> <fresh|resume> <prompt...>',
  );
  console.error('       cli-relay list');
  console.error('       cli-relay doctor');
  console.error('       cli-relay audit verify');
  console.error('       cli-relay reset <thread>');
  console.error('       cli-relay pin <thread> "<fact>"');
  console.error('       cli-relay unpin <thread> <index>');
  console.error('       cli-relay pins <thread>');
  console.error('dispatch flags must precede <fresh|resume>; all following tokens are prompt text');
  console.error(`backends: ${Object.keys(backends).join(', ')}`);
}

// Governance/routing flags (--dry-run, --print-command, --tier, --confirm) are only
// recognized before the third positional routing argument (mode: fresh/resume) is
// collected. Once mode is filled in, every remaining word is prompt text by definition
// and must never be reinterpreted as a flag -- a prompt that happens to contain the
// literal word "--confirm" (or "--tier", "--dry-run") as one of its tokens must not be
// able to grant a tier-3/4 dispatch or otherwise alter routing. This was a real,
// live-reproduced bypass: `cli-relay agy t fresh --tier=irreversible please --confirm x`
// used to pass tier 4 with gate_allowed:true, because the old scan checked every
// argument regardless of position. Under this contract that entire suffix is prompt
// text at the default tier 1; a tier-4 request must declare its tier before mode.
function parseDispatchFlags(cliArgs) {
  let dryRun = false;
  let confirm = false;
  let tierValue;
  let tierSeen = false;
  const routingArgs = [];

  for (let index = 0; index < cliArgs.length; index += 1) {
    const argument = cliArgs[index];
    const routingComplete = routingArgs.length >= 3;
    if (routingComplete) {
      routingArgs.push(argument);
      continue; // No flag handler, current or future, may inspect prompt tokens.
    }
    if (argument === '--dry-run' || argument === '--print-command') {
      dryRun = true;
      continue;
    }
    if (argument === '--confirm') {
      confirm = true;
      continue;
    }
    if (argument === '--tier' || argument.startsWith('--tier=')) {
      if (tierSeen) {
        throw new RelayError(
          'INVALID_TIER',
          '--tier may be provided only once',
          { exitCode: 2 },
        );
      }
      tierSeen = true;
      if (argument === '--tier') {
        tierValue = cliArgs[index + 1];
        if (tierValue == null || tierValue.startsWith('--')) {
          throw new RelayError(
            'INVALID_TIER',
            '--tier requires one of: 1, 2, 3, 4, read-only, local, ' +
            'reversible-remote, irreversible',
            { exitCode: 2 },
          );
        }
        index += 1;
      } else {
        tierValue = argument.slice('--tier='.length);
      }
      continue;
    }
    routingArgs.push(argument);
  }
  return { dryRun, confirm, tierValue, routingArgs };
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

// CS1 snapshots the exact session instance it marks running. CS2 (and the fresh-failure
// branch below) must verify the map entry is still that same instance before recording
// an outcome: a `reset` mid-run followed by a recreate on the same thread name leaves a
// *different* session under that name, and recording onto it would cross-wire a native
// session id across backends (a codex id on an agy-backend thread, or vice versa) or
// silently discard the replacement's newer id (found in the GLM-5.3 audit). Backend plus
// the pre-run native id plus CS1's own run-start timestamp identify the instance; on
// mismatch, warn and refuse to record — the same pattern the thread-deleted case uses.
function isSameSessionInstance(session, record) {
  return session.backend === record.backend &&
    session.native_session_id === record.native_session_id &&
    session.run_started_iso === record.run_started_iso;
}

async function main() {
  const cliArgs = process.argv.slice(2);

  // Adapter loading is intentionally below housekeeping dispatch. A malformed optional user
  // adapter must not prevent map-only recovery commands from listing, fixing, or resetting state.
  if (await runHousekeeping(cliArgs)) return;

  const { loadAdapters } = await import('./src/adapter-loader.mjs');
  const adapters = await loadAdapters();
  if (cliArgs[0] === 'doctor') {
    const anyBackendUsable = await cmdDoctor(adapters);
    process.exitCode = anyBackendUsable ? 0 : 1;
    return;
  }

  const {
    dryRun, confirm, tierValue, routingArgs,
  } = parseDispatchFlags(cliArgs);
  const [backend, thread, mode, ...rest] = routingArgs;
  const prompt = rest.join(' ');

  if (!backend || !thread || !mode || !prompt) {
    printUsage(adapters);
    process.exitCode = 2;
    return;
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

  // Tier policy is loaded only for dispatches. Its optional config loader owns
  // its own failures, so it cannot take down housekeeping, adapter diagnostics,
  // or the corruption-recovery path in `audit verify`.
  const { loadTierGate, parseTier } = await import('./src/governance/tier-gate.mjs');
  const tier = parseTier(tierValue);
  if (!tier) {
    throw new RelayError(
      'INVALID_TIER',
      `invalid tier "${tierValue}" — choose 1, 2, 3, 4, read-only, local, ` +
      'reversible-remote, or irreversible',
      { exitCode: 2 },
    );
  }
  const gate = loadTierGate().evaluate(tier, confirm);
  if (!gate.allowed) {
    // A dry run is a preview, not a backend dispatch, so it enforces the same
    // refusal without writing an event. Real refused attempts are auditable.
    if (!dryRun) {
      await appendLedgerEntry({
        backend,
        thread,
        mode,
        outcome: 'failed',
        exit_code: 1,
        tier: tier.level,
        tier_name: tier.name,
        gate_allowed: false,
      });
    }
    throw new RelayError('TIER_CONFIRMATION_REQUIRED', gate.reason);
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

  const ledgerEntry = {
    backend,
    thread,
    mode,
    outcome: 'failed',
    exit_code: 1,
    tier: tier.level,
    tier_name: tier.name,
    gate_allowed: true,
  };

  try {

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
  const { code, signal, out, err, timedOut, cancelled, outputOverflow } = await runChild(argv, env);
  if (outputOverflow) {
    console.error(`"${backend}" stdout exceeded the ${MAX_STDOUT_BYTES}-byte limit; refusing to parse truncated output.`);
  }
  const result = outputOverflow ? { id: null, answer: null } : adapter.parse(out);
  // Native ids become argv values on resume. Reject malformed ids before they can
  // be confirmed and saved, while still completing the normal outcome bookkeeping.
  const validId = typeof result.id === 'string' && result.id.trim().length > 0 &&
    !result.id.includes('\0');
  const parsed = { ...result, id: validId ? result.id : null };
  if (result.id != null && !validId) {
    console.error(`"${backend}" returned an invalid session id: expected a non-empty string without null bytes.`);
  }
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
      if (!isSameSessionInstance(session, record)) {
        // Reset-then-recreate mid-run: the map entry is now a different session
        // instance (possibly on a different backend). Don't cross-wire this run's
        // outcome onto it.
        console.error(
          `warning: thread "${thread}" in ${MAP_PATH} is no longer the session this run ` +
          `started from (it was reset or replaced while this run was in flight) — ` +
          'outcome not recorded.',
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
    const finalExitCode = userInterrupted ? interruptExitCode() : (parsed.id ? 3 : 1);
    ledgerEntry.outcome = cancelled || userInterrupted ? 'cancelled' : 'failed';
    ledgerEntry.exit_code = finalExitCode;
    process.exitCode = finalExitCode;
    return;
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
    if (!isSameSessionInstance(session, record)) {
      // Reset-then-recreate mid-run: the map entry is now a different session
      // instance (possibly on a different backend). Don't cross-wire this run's
      // native id onto it or discard its newer id in favor of this run's.
      console.error(
        `warning: thread "${thread}" in ${MAP_PATH} is no longer the session this run ` +
        `started from (it was reset or replaced while this run was in flight) — outcome` +
        `${newId ? ` (including native id ${newId})` : ''} not recorded.`,
      );
      return;
    }
    if (newId) {
      session.native_session_id = newId;
      session.confirmed = true;
      session.consecutive_resume_failures = 0;
    }
    if (mode === 'resume') {
      if (!cancelled) {
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
      }
      // A run the wrapper cancelled (Ctrl-C, SIGTERM, or the spawn timeout) says
      // nothing about the backend's resume health — neither success nor failure.
      // The failure counter is deliberately left untouched: three interrupted
      // resumes on a perfectly healthy thread must not auto-unconfirm it (found
      // in the GLM-5.3 audit).
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

  const finalExitCode = mode === 'resume' && !parsed.answer
    ? (userInterrupted ? interruptExitCode() : (code === 0 ? 3 : (code ?? 1)))
    : (userInterrupted ? interruptExitCode() : (code === null ? 1 : code));
  ledgerEntry.outcome = cancelled || userInterrupted
    ? 'cancelled'
    : (finalExitCode === 0 && parsed.answer && (mode === 'resume' || newId)
      ? 'confirmed'
      : 'failed');
  ledgerEntry.exit_code = finalExitCode;

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
    process.exitCode = finalExitCode;
    return;
  }
  // Let Node drain stdout/stderr before exiting, including large JSON answers piped
  // to a slow reader. process.exit() can discard writes still queued by console.log.
  process.exitCode = finalExitCode;
  } catch (error) {
    if (userInterrupted) {
      ledgerEntry.outcome = 'cancelled';
      ledgerEntry.exit_code = interruptExitCode();
    } else {
      ledgerEntry.outcome = 'failed';
      ledgerEntry.exit_code = error instanceof RelayError ? error.exitCode : 1;
    }
    throw error;
  } finally {
    // withLock is deliberately not nested: both map critical sections are over
    // before the ledger takes the same hardened process lock.
    await appendLedgerEntry(ledgerEntry);
  }
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
    terminateActiveChild();
  } else if (childHasFinished) {
    process.exitCode = interruptExitCode();
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
    process.exitCode = error.exitCode;
    return;
  }
  console.error(`cli-relay error: ${error.message}`);
  process.exitCode = 1;
});
