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
  let myHolderRaw = null;
  for (;;) {
    try {
      mkdirSync(LOCK_PATH);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Someone else's lock directory exists — evaluate it as a waiter below.
      await waitForLockSlot(deadline);
      continue;
    }

    // The directory is ours and empty. Write holder.json with an EXCLUSIVE create
    // ('wx'): if a waiter reclaimed this still-empty directory while we were
    // suspended between mkdir and this write (a suspension longer than
    // LOCK_TIMEOUT_MS — laptop sleep, VM pause), the successor's holder.json
    // already exists and a plain write would silently clobber it — two holders at
    // once (found in the GLM-5.3 audit). EEXIST throws loudly instead, and the
    // loser falls back to the waiter path below: the successor is the rightful
    // holder now.
    myHolderRaw = JSON.stringify({ pid: process.pid, ts: Date.now() });
    try {
      writeFileSync(join(LOCK_PATH, LOCK_HOLDER_FILE), myHolderRaw, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Our just-created directory was reclaimed mid-gap and now holds a
      // successor's holder.json — evaluate the lock as a waiter, same as the
      // mkdir-EEXIST case, but for a distinct reason (we briefly held the
      // directory; the EEXIST came from the write, not the mkdir).
      await waitForLockSlot(deadline);
      continue;
    }
    break;
  }

  try {
    return await fn();
  } finally {
    releaseLock(myHolderRaw);
  }
}

// The waiter half of acquisition, shared by both EEXIST paths above: the lock
// directory exists but isn't ours — either created by someone else, or created by
// us and then legitimately reclaimed out from under our suspended holder.json
// write. Judge the current holder, reclaim it if eligible, and otherwise sleep
// until the deadline.
async function waitForLockSlot(deadline) {
  const holderRaw = readHolderRaw();
  let eligible = false;
  if (holderRaw !== null) {
    try {
      const holder = JSON.parse(holderRaw);
      // A holder record bearing this process's own pid cannot be a lock we hold:
      // this path only runs before this call acquires, and an earlier withLock in
      // this process has always released first (cli-relay never overlaps them). It
      // is either an abandoned leftover of our own failed release or — the case
      // that matters — a dead holder whose pid was reused by this very invocation,
      // which would otherwise see *itself* as a live holder and fail spuriously
      // after LOCK_TIMEOUT_MS (found in the GLM-5.3 audit; the mirror-image
      // false-positive, pid reuse by an unrelated process, still self-heals via
      // the timestamp path above).
      eligible = Date.now() - holder.ts > LOCK_STALE_MS ||
        !isPidAlive(holder.pid) ||
        holder.pid === process.pid;
    } catch {
      eligible = true; // holder.json exists but isn't valid JSON — not a state any live holder writes
    }
  } else {
    // Missing holder.json while the lock dir exists: either mid-write (a real
    // holder's mkdir+writeFileSync are back-to-back synchronous, resolving in
    // microseconds, and the exclusive write now fails loudly rather than
    // clobbering) or the holder died in that exact window and never will. Use the
    // lock directory's own mtime — an objective fact any process can check on the
    // same physical directory — rather than this waiter's own elapsed wait time,
    // which can't tell "the original holder died" apart from "a brand-new
    // holder's mkdir just landed."
    try {
      eligible = Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_TIMEOUT_MS;
    } catch {
      eligible = false; // the directory itself vanished already — nothing here to reclaim
    }
  }
  if (eligible && reclaim(holderRaw)) return;
  if (Date.now() > deadline) {
    throw new Error(`another cli-relay invocation holds the lock (${LOCK_PATH}) — not waiting forever`);
  }
  await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
}

// Releasing by unconditionally rmSync-ing LOCK_PATH never verifies the releaser
// still owns the lock. If a holder is suspended past LOCK_STALE_MS (laptop sleep,
// VM pause, or a clock adjustment that makes its timestamp look stale), a waiter
// legitimately reclaims and becomes the new holder; when the original holder wakes
// and finishes, an unconditional delete destroys its successor's lock and admits a
// third entrant (found in the GLM-5.3 audit). Mirror reclaim()'s own pattern:
// rename to a private path first (atomic — at most one renamer of a given source
// path can win), verify the captured holder.json is still this process's own
// write, and only then rm; if it isn't ours, put it back for the rightful holder
// rather than destroying it.
function releaseLock(myHolderRaw) {
  const claim = `${LOCK_PATH}.release.${process.pid}.${Date.now()}`;
  try {
    renameSync(LOCK_PATH, claim);
  } catch {
    return; // nothing at LOCK_PATH (or a real error) — nothing to either verify or destroy
  }
  let capturedHolderRaw;
  try {
    capturedHolderRaw = readFileSync(join(claim, LOCK_HOLDER_FILE), 'utf8');
  } catch {
    capturedHolderRaw = null;
  }
  if (capturedHolderRaw === myHolderRaw) {
    rmSync(claim, { recursive: true, force: true });
  } else {
    // Not our write anymore — a waiter reclaimed while we were suspended and this
    // is its lock. Restore it; if LOCK_PATH was recreated in the meantime by yet
    // another party there is nowhere safe to put it back — drop it rather than
    // loop forever, the same compounding-race reasoning as reclaim().
    try {
      renameSync(claim, LOCK_PATH);
    } catch {
      rmSync(claim, { recursive: true, force: true });
    }
  }
}
