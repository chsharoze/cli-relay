import {
  mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  LOCK_PATH, LOCK_RETRY_MS, LOCK_STALE_MS, LOCK_TIMEOUT_MS,
} from '../config.mjs';

const LOCK_HOLDER_FILE = 'holder.json';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHolderRaw() {
  try {
    return readFileSync(join(LOCK_PATH, LOCK_HOLDER_FILE), 'utf8');
  } catch {
    return null; // missing or unreadable — a real signal in its own right, not an error
  }
}

// Reclaiming a dead lock by inspecting it and then unconditionally `rmSync`-ing the path is
// a TOCTOU race: two waiters can both judge the SAME dead instance eligible, and whichever
// runs second deletes whatever is CURRENTLY at that path — which may by then be a brand-new,
// legitimate holder the first reclaimer already created, letting both waiters into fn() at
// once (found in review, twice — first via holder.json timing, then via this exact
// path-based-delete gap). `renameSync` is atomic at the OS level, so at most one caller's
// rename of a given source path can ever succeed; the loser gets ENOENT and safely backs
// off having touched nothing. But atomicity alone isn't enough either: the thing a winner
// captures might no longer be the dead instance it originally inspected (a legitimate new
// holder could have appeared in the gap between that inspection and this call) — so after
// winning the rename, re-check the captured content against what was judged dead before
// destroying anything. A mismatch means we accidentally captured a live replacement; put it
// back for its rightful owner instead.
// Returns true only if this call actually took an action (rename succeeded, whether the
// outcome was destroying a confirmed-dead instance or restoring a live replacement it
// accidentally captured). False means nothing changed — the caller must fall through to
// the normal deadline/retry wait rather than looping without pause, which would otherwise
// spin at full CPU on a persistent rename failure (e.g. a permissions problem) instead of
// respecting LOCK_TIMEOUT_MS.
function reclaim(expectedHolderRaw) {
  const claim = `${LOCK_PATH}.reclaim.${process.pid}.${Date.now()}`;
  try {
    renameSync(LOCK_PATH, claim);
  } catch {
    return false; // lost the race to someone else, or a real error (e.g. permissions) — either way, did nothing
  }
  let capturedHolderRaw;
  try {
    capturedHolderRaw = readFileSync(join(claim, LOCK_HOLDER_FILE), 'utf8');
  } catch {
    capturedHolderRaw = null;
  }
  if (capturedHolderRaw === expectedHolderRaw) {
    rmSync(claim, { recursive: true, force: true });
  } else {
    // Not the same instance we judged dead — a legitimate holder slipped in during our
    // check. Restore it. If even that races (LOCK_PATH got recreated in the meantime by
    // yet another party), there is nowhere safe to put it back; drop it rather than loop
    // forever — this compounds three independent low-probability races at once.
    try {
      renameSync(claim, LOCK_PATH);
    } catch {
      rmSync(claim, { recursive: true, force: true });
    }
  }
  return true;
}

export async function withLock(fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_PATH);
      writeFileSync(
        join(LOCK_PATH, LOCK_HOLDER_FILE),
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
      );
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holderRaw = readHolderRaw();
      let eligible = false;
      if (holderRaw !== null) {
        try {
          const holder = JSON.parse(holderRaw);
          eligible = Date.now() - holder.ts > LOCK_STALE_MS || !isPidAlive(holder.pid);
        } catch {
          eligible = true; // holder.json exists but isn't valid JSON — not a state any live holder writes
        }
      } else {
        // Missing holder.json while the lock dir exists: either mid-write (a real holder's
        // mkdir+writeFileSync are back-to-back synchronous, resolving in microseconds) or
        // the holder died in that exact window and never will. Use the lock directory's own
        // mtime — an objective fact any process can check on the same physical directory —
        // rather than this waiter's own elapsed wait time, which can't tell "the original
        // holder died" apart from "a brand-new holder's mkdir just landed."
        try {
          eligible = Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_TIMEOUT_MS;
        } catch {
          eligible = false; // the directory itself vanished already — nothing here to reclaim
        }
      }
      if (eligible && reclaim(holderRaw)) continue;
      if (Date.now() > deadline) {
        throw new Error(`another route invocation holds the lock (${LOCK_PATH}) — not waiting forever`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    try { rmSync(LOCK_PATH, { recursive: true, force: true }); } catch {}
  }
}
