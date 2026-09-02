# GLM-5.3 audit fix brief (2026-09-02)

You are fixing findings from a GLM-5.3 adversarial audit of this codebase, all independently
verified against current `main` before this brief was written (line numbers below are accurate
as of `d204d83`, tag 1.0.2). Follow the project's own established pattern (see README's
"Field notes" section) — this repo has been through several rounds of audit → fix → adversarial
re-check; match that rigor. Read `README.md` fully first, especially the "Lock hardening"
and "cli-continues cherry-pick" sections, to understand what's already been tried and why two
races were deliberately left unfixed.

## Must fix — HIGH confidence, real bugs

**1. Reset-then-recreate mid-run corrupts the session map across backends.**
`src/commands/reset.mjs` (`cmdReset`) deletes a thread from the map unconditionally, with no
check for `session.status === 'running'`. If thread A is mid-run (e.g. `codex t fresh`,
minutes-long) and someone runs `cli-relay reset t` then `agy t fresh` (which completes first),
A's critical-section-2 in `cli-relay.mjs` (~line 358-399) then finds B's session in the map and
unconditionally overwrites its `native_session_id` with A's id (line ~372-376) while
`session.backend` stays B's backend — cross-wiring a codex session id onto an agy-backend
thread record, or vice versa. Same-backend variant silently discards B's newer id for A's
older one. Fix: CS2 (and the fresh-failure branch above it) must verify the session it's about
to update is still the *same* session instance CS1 captured before mutating it — compare
`backend` and the pre-run `native_session_id`/`run_started_iso` snapshot, not just presence.
On mismatch, warn and refuse to record the outcome (same pattern already used for the
thread-deleted case).

**2. Lock release (`src/core/lock.mjs`, `withLock`'s `finally` block) is an unconditional
`rmSync(LOCK_PATH, ...)` — it never verifies it still owns the lock.** If a holder is
suspended past `LOCK_STALE_MS` (laptop sleep, VM pause) or a clock adjustment makes its
timestamp look stale, a waiter can legitimately reclaim; when the original holder wakes and
finishes, it deletes its successor's lock directory instead of its own, letting a third
entrant in concurrently. Fix: mirror `reclaim()`'s own pattern — rename-to-a-private-path,
verify the captured `holder.json` content is still your own write (pid + your `ts`), then
`rm`; if it isn't yours, put it back for the rightful holder rather than destroying it.

**3. The `mkdir` → `writeFileSync(holder.json)` gap in `withLock` isn't safely closed.**
The current code's assumption ("back-to-back synchronous, resolving in microseconds") breaks
under a suspension longer than `LOCK_TIMEOUT_MS` between the two calls: a waiter can reclaim
the still-empty directory and become holder; the original holder then resumes and its plain
`writeFileSync` overwrites the successor's `holder.json`, producing two holders. Fix: write
`holder.json` with the `'wx'` flag (exclusive create) instead of the default, so a collision
throws loudly instead of clobbering. Note the existing `catch` block conflates the `mkdirSync`
EEXIST case with what would now be a `writeFileSync` EEXIST case — split them so the error
paths stay distinct and correct.

## Should fix — real, lower severity/likelihood

**4. Resume circuit breaker counts user-interrupted (Ctrl-C'd) resumes as failures.**
`cli-relay.mjs` computes and persists `cancelled` (from `runChild`) but never consults it
before incrementing `consecutive_resume_failures` in critical section 2. Three Ctrl-C'd
resumes on a perfectly healthy thread auto-unconfirm it. Fix: don't count a `cancelled` run
toward the failure threshold either way (neither success nor failure — just don't touch the
counter).

**5. `holder.json` is technically checked by `isPidAlive`, which has real false-positive
paths** (PID reuse by an unrelated process, PID reuse by the *next* `cli-relay` invocation
itself, zombie/unreaped holders). Combined with fix #2/#3 above using content-verification
instead of trusting liveness alone, this mostly self-resolves — but confirm after your fix
that a PID-reuse false-positive can no longer cause the *next* invocation to see itself as
holder and stall/fail spuriously. Fix only if your change to #2/#3 doesn't already cover it;
don't over-engineer a separate fix if it does.

## Cheap fixes — do these too, low effort

**6. `tests/smoke.sh` cleanup uses `rm -f "$MAP.lock"` in three places** (it's a directory,
per `lock.mjs`'s `mkdirSync`) — `rm -f` silently no-ops on a directory, so a leftover lock can
survive `restore_map`. Change to `rm -rf` at all three call sites.

**7. `doctor` always exits 0** even when every backend is missing, so it can't be used as a
script/CI gate. Change to exit non-zero (e.g. 1) when at least one required backend is
unavailable — check README's exit-code table (top of `cli-relay.mjs`) and extend it
consistently rather than inventing an undocumented code.

## Your call — flag in your final report, don't silently skip or silently fix

- **`--dry-run`/`--print-command` token stripping**: any single argv token equal to those
  literal flags is both treated as the flag AND deleted from the prompt text, even when a
  prompt is *discussing* the flag as a string rather than invoking it. This is already
  documented in README (line ~382) as an accepted limitation for the target audience
  (agent-driven, not free-text discussion of flags). Leave as-is unless you see an
  unreasonably cheap fix; note your reasoning either way.
- **Pin text can forge the pinned-facts block structure**: `src/core/pins.mjs`'s
  `validatePinText` blocks newlines and length but not the literal string `[END PINNED FACTS]`
  or a lone `\r`. This is a prompt-injection-adjacent issue in a single-user tool with no
  external/untrusted pin sources today — low priority, but a one-line substring check
  (reject pins containing `[END PINNED FACTS]` or `\r`) is cheap enough to just do.
- **`.js` user adapters load as CommonJS** when `~/.cli-relay` has no `package.json` — an ESM
  `.js` adapter fails with only a console warning, not a clear error. Either drop `.js` from
  `SUPPORTED_EXTENSIONS` in `src/adapter-loader.mjs` (keep `.mjs`/`.cjs` only) or update the
  README to say `.js` adapters must be CommonJS. Pick whichever is less disruptive and say
  which you picked.
- Windows `process.kill(-pgid, ...)` no-ops (POSIX-only) — `package.json` has no `os`
  restriction, implying Windows was in scope, but this repo's test/dev/publish history is
  entirely macOS/Linux. Flag this as a known gap in the README's existing gaps list rather
  than attempting a fix — a real Windows fix needs `taskkill /T /F` and can't be verified
  without a Windows box. Do not guess-fix without being able to test it.

## Do NOT touch

Everything in the audit's "Verified sound" list (rename-atomicity in `reclaim()`, dir-mtime
eligibility for the missing-holder case, the NDJSON backward scan, atomic map writes, env
allowlist scrubbing, CS1's in-flight guard, housekeeping-before-adapters dispatch, broken
custom-adapter isolation, exit codes) — these were checked and are correct as-is.

## Acceptance criteria

1. `tests/smoke.sh` passes in full (it currently passes 32/32 on `main` — do not regress it;
   add new smoke assertions for #1/#2/#3/#4/#6 if you can do so without a live backend
   dependency — mock/fake holder files and map states the way the existing suite already
   does for lock tests).
2. No behavior change to any adapter's `fresh`/`resume`/`parse` argv shape — backends
   (codex/agy/claude-code/command-code) must keep working exactly as invoked today.
3. Update README's version-history "Field notes"/hardening-log style section with a new
   dated entry describing what GLM-5.3 found and what was fixed, in the same voice/format as
   the existing 2026-08-31 and 2026-09-01 entries — this project keeps that log as its own
   audit trail.
4. Do not bump `package.json` version or touch anything npm-publish related — that happens
   after this branch is reviewed and merged, separately.
5. Commit with a clear message referencing the GLM-5.3 audit; one commit is fine, or split
   logically (e.g. lock fixes together, reset/CS2 fix separate, cheap fixes together) — your
   judgment.

Work only inside this worktree/branch (`glm53-fixes`). When done, give a final summary: what
you changed, what you deliberately left (with reasoning), and the smoke test result.
