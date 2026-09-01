# cli-relay — persistent CLI router

Built by [RevOpsDev](https://revopsdev.com).

Resume-by-reference delegation across codex, agy, claude-code (command-code: fresh-only).
Built 2026-08-16/17, inspired by DeepSeek Harness's subagent architecture but deliberately
smaller — see design history below before re-deriving any of this from scratch.

## Installation

Requires Node.js 18.17 or newer.

```sh
npm install --global cli-relay
```

The package has no runtime dependencies. Installation exposes the `cli-relay` command.

## Usage

```
cli-relay [--dry-run|--print-command] <backend> <thread> <fresh|resume> <prompt...>
cli-relay list
cli-relay doctor
cli-relay reset <thread>
cli-relay pin <thread> "<fact>"
cli-relay unpin <thread> <index>
cli-relay pins <thread>
```

Backends: `codex`, `agy`, `claude-code`, `command-code` (command-code is fresh-only —
its resume showed a reproducible seed-turn bug live, see file header).

`cli-relay doctor` checks that every backend's binary is actually resolvable on PATH —
useful after a fresh machine setup or when a backend call fails and you're not sure whether
it's cli-relay or the backend itself. `--dry-run` / `--print-command` prints the exact argv
that would be spawned (prompt fully assembled, pins injected) without spawning anything or
touching the session map at all — it enforces the same refusals a real run would (e.g. won't
preview a `resume` on an unconfirmed thread, won't preview against a thread with a run
already in flight), so what it shows is genuinely what would happen, not a best-effort guess.

Not named `route` — that collides with the pre-existing BSD `/sbin/route` network tool,
found the hard way (see Known gaps history below).

Ctrl-C mid-run terminates the child cleanly and exits 130 — safe to interrupt, the map never
gets left in a stuck `status: "running"` state from a live interrupt (only from a hard crash,
which self-heals via the lock's own staleness check on the next call).

## Design

Never replays transcripts. Stores only `{backend, native_session_id, confirmed, status,
consecutive_resume_failures, ...}` per named thread in `~/.cli-relay/sessions.json`, and asks
each backend to resume *itself* via its own native flag (`codex exec resume`, `agy
--conversation`, `claude -r`). All four backends' id/answer extraction is via real
structured JSON (`--json` / `--output-format json`), live-verified against each real CLI —
no regex stdout-scraping.

Full rationale, the "persistence-by-reference not persistence-by-replay" framing, and why
Harness's own subagent adapters are one-shot by deliberate design (not oversight) — three
independent deep-dives (Codex, GLM-5.2 via Command Code, a design critique from Fable)
converged on this shape. Session content isn't preserved past this repo; the key
conclusions are captured in this file's own comments and the header.

### Configuration and adapters

Runtime settings come from built-in defaults merged with optional overrides in
`~/.cli-relay/config.json`. Keys may use the exported uppercase names or camelCase, for
example `SPAWN_TIMEOUT_MS` or `spawnTimeoutMs`. Available settings are defined in
`src/config.mjs`; derived values such as the lock path and stale-lock window always follow
their configured base values.

Built-in adapters live in `src/adapters/` and are discovered at runtime. Additional `.mjs`,
`.js`, or `.cjs` adapters can be placed in `~/.cli-relay/adapters/`; an adapter with the same
`name` as a built-in replaces it. Each adapter provides `fresh`, optional `resume`, `env`,
`parse`, optional `checkCompaction`, and optional `binaryCandidates` (an ordered list of
binary names `doctor` tries — most adapters only need one, but a backend that ships under
more than one binary name can list several). Housekeeping commands are dispatched before
adapter discovery, so they remain available if an adapter cannot be loaded. A malformed
adapter file no longer takes down the whole load either way: a broken file matching one of
the four required backend names (`codex`/`agy`/`claude-code`/`command-code`) is recorded and
reported by the startup completeness assertion (see below); a broken file under any other,
custom name is skipped with a `warning:` line to stderr, since it was never required in the
first place.

### Architecture

`cli-relay.mjs` itself is orchestration only (arg parsing, process spawn/lifecycle, signal
handling, the two critical sections that read-modify-write the session map). Everything else
lives under `src/`:

- `src/config.mjs` — settings (see above).
- `src/core/lock.mjs` — the POSIX `mkdir`-based lock. Load-bearing and deliberately
  conservative; see the Review history entry below before touching it — it took four rounds
  of adversarial review to get the reclaim logic actually race-free.
- `src/core/map-store.mjs` — atomic read/write of `~/.cli-relay/sessions.json`.
- `src/core/pins.mjs`, `src/core/thread-lookup.mjs` — pinned-facts validation/injection, and
  the "did you mean?" suggestion helper used by every command that looks up a thread by name
  (case-insensitive substring match, either direction, up to 3 candidates — not a fuzzy-
  distance algorithm, and it only fires when the thread doesn't exist at all, never when it
  exists but is merely unconfirmed).
- `src/core/errors.mjs` — `RelayError`, a minimal typed error (`code`, `exitCode`, `cause`)
  used at the hot-path throw sites, handled once in `main().catch()`. Preserves the exact
  original exit codes and message text for every pre-existing error path — including the
  asymmetry where a usage error (exit 2) prints with no `cli-relay error:` prefix while
  everything else (exit 1) does; that split existed before `RelayError` did and is
  intentional, not something to "fix" into consistency.
- `src/commands/` — `list`/`reset`/`pin`/`unpin`/`pins`/`doctor`, one file each.
- `src/adapter-loader.mjs` — discovery, validation, and the `assertAdapterRegistry`
  completeness check described above.
- `src/adapters/` — one file per backend.

Six of these pieces (the registry completeness assertion, `doctor`, the `RelayError` model,
`--dry-run`, did-you-mean, and an audit of thread-identity ambiguity that concluded no change
was needed) were adapted from patterns found in a much larger sibling project,
[cli-continues](https://github.com/yigitkonur/cli-continues) — full brief in
`docs/cli-continues-cherrypick-brief.md`. cli-relay deliberately did not adopt that project's
actual approach (parsing and replaying each backend's transcript format) — see Design above
for why.

## Testing

`tests/smoke.sh` — real end-to-end regression check against real backends (not mocks).
Backs up and restores your actual `~/.cli-relay/sessions.json` around the run, safe to run any
time. Covers: list/reset, fresh→resume context retention (agy), the circuit breaker's actual
3-strikes trip (live-fired against codex with a bad id, not just traced), SIGINT mid-run
cleanup, and SIGINT while genuinely pre-spawn (lock held elsewhere — must abort immediately
without spawning). 32/32 passing as of the last run. Does not exercise `claude-code` (real
billing per call) or `command-code` resume (disabled). Also does not yet cover `doctor` or
`--dry-run` — both are verified manually against the real backends whenever they change (see
the 2026-09-01 Review history entries below for what that's caught), not by an automated
case in this file yet.

```
bash tests/smoke.sh
```

## Review history

Built, then put through three Fable review passes plus a production-hardening pass:
- Pass 1: stale-lock-wedges-forever on crash, untracked SIGKILL timer, silent resume-failure
  looked like success (no fail-loud exit code), fresh-on-confirmed-thread silent clobber,
  concurrent-same-thread race, inconsistent JSON parse robustness across adapters.
- Pass 2 (post-fix verification): caught a regression in the pass-1 fix itself — the unified
  JSON parser stopped at the first *syntactically valid* JSON line rather than the first line
  with the actual expected fields, a new silent-wrong-answer path. Fixed.
- Pass 3: implemented `cli-relay list` / `cli-relay reset`, plus the 3-consecutive-failures
  circuit breaker (see Design). Verified end to end except the exact 3-strikes trip at the time (agy
  hung on a garbage id instead of failing fast — verified by code trace instead).
- Production-hardening pass: added SIGINT/SIGTERM handling (previously a Ctrl-C mid-run
  orphaned the child and left the map stuck), found and fixed two early-exit branches that
  bypassed the interrupt exit code in favor of their own failure code. Live-fired the circuit
  breaker's actual trip point against codex (fails fast on a bad id, unlike agy) instead of
  relying on the trace. Wrote `tests/smoke.sh`. Fixed a naming collision (`route` vs
  `/sbin/route`) and moved the repo out of `~/bin` (executables only) into
  `~/Projects/cli-relay` with a clean symlink.
- Final Fable pass on the signal-handling code itself: caught a real race — the "no active
  child" branch of the signal handler couldn't distinguish "nothing spawned yet" from "child
  just exited, main() is still committing the outcome," and force-exiting in the latter case
  could silently drop a just-earned successful result (e.g. a fresh run's `confirmed: true`
  never gets persisted). Fixed with a `childHasFinished` flag paired atomically with the
  existing `activeChildPgid` tracking, splitting the old two-way branch into three. Also
  threaded a signal-aware exit code (`128 + signal number`, SIGINT vs SIGTERM distinguishable)
  through all three of `main()`'s exit points, and fixed `runChild`'s error handler to fold
  `userInterrupted` into `cancelled` like its exit handler already did. One documented,
  accepted asymmetry remains: `reset`'s own critical section isn't covered by this tracking
  (low risk — `saveMap` is atomic regardless, see the comment at `cmdReset`).

**Modularization (2026-08-31).** The single 968-line `cli-relay.mjs` was split into
`src/{config,core,commands,adapters}/` (see Architecture above). Rather than pick one
implementation on trust, three independent models built the same refactor from the same
brief in isolated branches: Codex (gpt-5.6-sol), Command Code on `minimax-m3-free`, and
Command Code on GLM-5.2. All three independently found and fixed the same 4 real bugs in an
earlier attempt (a compaction-detection substring check that lost its JSON-quote delimiters
and risked false positives; a `LOCK_STALE_MS` that wasn't actually derived from
`SPAWN_TIMEOUT_MS`, so overriding one silently desynced the other; adapter loading that ran
before housekeeping-command dispatch, so one broken adapter could block `list`/`reset`/`pin`;
and hardcoded `~/.cli-relay/sessions.json` strings in user-facing messages despite the path being
configurable) — strong convergent signal those were genuine, not nitpicks. All three passed
the live smoke suite 32/32. Codex's was merged for being the leanest (395-line `cli-relay.mjs`,
946 lines total vs. the other two's 1,219/1,336) with materially identical behavior; the
other two are preserved on their own branches for the record, not deleted.

**Lock hardening (2026-08-31), same day.** A GLM-5.2 second-opinion audit of the merged
result found two real race conditions: a concurrent `reset` mid-run could crash critical
section 2 and silently drop a just-confirmed session id (fixed: CS2 now detects a
mid-run-deleted thread and warns instead of resurrecting it or crashing), and the lock could
wedge permanently if its holder died in the exact window between `mkdir` and writing
`holder.json` (fixed: the lock's own directory age, not any single waiter's elapsed wait
time, decides reclaim eligibility). The fix for the second bug took **four rounds** of
adversarial codex review before it actually closed — each earlier attempt introduced a
narrower TOCTOU race in the reclaim logic itself (using a waiter's own deadline instead of
the lock generation's actual age; a path-based `rmSync` that wasn't atomic against a
concurrent reclaimer). The final design: atomic `renameSync`-based reclaim, re-verified by
content after the rename, restoring what it captured if it turns out not to be the same dead
instance originally judged. Two narrower, more theoretical races remain deliberately
unfixed — both require a process crash *and* multiple genuinely concurrent invocations
racing inside a multi-microsecond filesystem operation; closing them fully would mean
replacing the whole hand-rolled `mkdir`/`rename` scheme with real OS-level advisory locking
(`flock`/`fcntl`), judged disproportionate for a single-user tool. Documented, not hidden, in
`src/core/lock.mjs`'s own comments.

**cli-continues cherry-pick + hardening (2026-09-01).** A much larger sibling project,
[cli-continues](https://github.com/yigitkonur/cli-continues) (41k lines, resumes sessions
across 16 tools by parsing and replaying each one's transcript format), was deep-dive
audited by two independent models for patterns worth adapting — not its actual
transcript-replay approach, which cli-relay deliberately avoids. Both converged on the same
six items (see Architecture above); prior art research (agy, cross-checked via independent
web search) found no existing tool combining native resume-by-id, a dynamic per-backend
adapter registry, and zero-dependency `mkdir` locking the way cli-relay does — the closest
relative solves the same problem by transcript replay instead. Codex and GLM-5.2 each
implemented all six from the same brief in isolated branches; GLM's had three real gaps
codex's didn't (a one-directional did-you-mean substring match that missed typos in one
direction; a `--dry-run` that fabricated a misleading preview instead of refusing on an
unconfirmed thread the way a real run would; `doctor`'s binary checks using `spawnSync`
inside an `async` wrapper, silently serializing what was supposed to be concurrent via
`Promise.allSettled`) — codex's branch was carried forward. A **fresh** GLM-5.2 session (no
context on how the branch was built) then adversarially audited it: found the same
`--dry-run`-bypasses-a-real-refusal class of bug in a different spot (skipped the
"run-already-in-flight" check, not just the confirmation check) and a broken *custom*-named
external adapter crashing the entire load — including `doctor`, the one command meant to
diagnose exactly that. Both fixed and verified live. The audit's one headline finding (a
claimed exit-code regression in the new `RelayError` paths) was checked directly against
`main`'s actual pre-refactor source and found to be a false positive — the audit had
correctly flagged its own uncertainty (its sandbox blocked `git` access) rather than
asserting it, which is why it was checked rather than trusted or dismissed outright. Full
brief in `docs/cli-continues-cherrypick-brief.md`.

## Field notes from real use

First real-world use (2026-08-17, an audit task run across all three model lanes in
parallel) surfaced two things design review and smoke tests couldn't have caught, plus
confirmed the core value prop actually landed:

**Worked as designed:** resumed a thread twice — once for a full re-audit, once for a
fix — without restating the brief; codex picked up full context both times, including
correctly remembering it was mid-audit after an unrelated manual `&`/`wait` mistake had
SIGTERM'd the first run at 120s. That SIGTERM'd run still left a `confirmed: true` thread
with its `native_session_id` intact — resumable, not lost — exactly the point of storing
native ids rather than transcripts. `cli-relay list` and the raw map gave enough visibility
(`last_signal: SIGTERM`, `cancelled_by_wrapper: true`) to diagnose exactly what had happened
without guessing. Running three model lanes in parallel (Command Code/GLM, codex, agy) was
cheap specifically because they share one invocation shape instead of three different CLI
syntaxes — worth doing again for anything where cross-model corroboration matters, each
lane found genuinely different things in that test.

**Bug found and fixed:** `codex exec resume` has no `--sandbox` flag at all — passing one is
a hard CLI error — so a resumed thread silently got LESS filesystem access than the fresh
call that created it, and couldn't apply a fix it had just identified. The `resume` adapter
now passes `--dangerously-bypass-approvals-and-sandbox` instead; reasonable given `fresh`
already grants codex write access to whatever cwd it's pointed at, so resume defaulting to
less access than fresh granted the same thread was an inconsistency, not a real safety
boundary. Verified live: a resumed thread can now create a file it couldn't before.

**Gap found, mitigated but not solved:** `agy` didn't respect an in-prompt instruction to
work in a scratch copy — it read from the canonical source-of-truth path instead (no harm
that time: read-only, and the canonical repo was verified to stay clean, but a real
instruction-following gap). Not strictly a `cli-relay` bug — it's `agy`'s own behavior — but
`cli-relay` wasn't doing anything to scope it either. Now passes `--add-dir <cwd>` (agy's own
explicit workspace-scoping flag) on every agy call as a stronger signal than prose. This is
defense in depth, not an enforced guarantee — don't rely on it for anything where a
canonical/production path must not be touched; verify after, the way this first real use did.

**Bug found and fixed (2026-08-20), while live-testing the compaction-detection work below:**
Command Code returned a genuine `sessionId` inside an *error* response body (`"insufficient
credits"`, an account billing issue, not a cli-relay bug) with `finalText: ""` — the old
fresh-mode check only required an id to mark a thread `confirmed: true`, so a real API error
was silently getting recorded as a clean successful thread. Fixed: fresh mode now requires
BOTH a real id and a non-empty answer, the same standard resume mode's exit-3 check already
held it to. Found by accident (an unrelated credits exhaustion), not by design — worth
remembering that live testing against real backends keeps finding real gaps neither review
nor synthetic tests reach, same pattern as every other bug in this file.

## Compaction risk (2026-08-20)

Long-running resumed threads carry a real risk: the *backend's own* internal context
compaction can silently reorder or lose fidelity on which fact is current — an early,
now-superseded statement can outweigh a later correction once summarized, with no signal to
either side that it happened. This is not a cli-relay bug, it's a property of every backend's
own memory management, but resume-by-reference actively increases exposure to it (that's the
whole point of resuming — restating context, which forces the backend to re-derive/re-compact
its own history, less often).

**Detected, not prevented, and only where proven — not guessed:**
- `codex`: a real `context_compacted` event was directly observed in a live codex session's
  detailed rollout log (`~/.codex/sessions/**/rollout-*.jsonl`) — NOT visible in the simplified
  `--json` stdout stream this router otherwise parses, so detection means reading that file
  separately by thread id after each call.
- `command-code`: the installed CLI's own compiled source contains `compaction_start`/
  `compaction_done` events using the same `.emit()` pattern already confirmed to reach the
  external NDJSON stream for other event types — strong evidence, not yet live-observed
  (would need a genuinely huge context to force for real).
- `agy`: explicitly NOT checked. Its compiled binary confirms a compaction concept exists
  (`"Conversation compacted"`, boundary-marker strings) but the only structured trace of it
  lives in agy's *render* package, not its data model — `stream-json` output showed no
  compaction-shaped event. Building detection on a render-layer artifact would be guessing.
- `claude-code`: skipped by explicit choice, not tested. `--autocompact` exists and is at
  least configurable if this becomes worth revisiting.

When detected, the thread's `compaction_detected` flag is set (sticky — once true, stays
true) and surfaced loudly in `cli-relay list` and every subsequent call's output.

**Also added: a turn-count advisory.** `RESUME_WARNING_THRESHOLD = 10` — not derived from any
verified per-model context-window size (that kind of number goes stale, the same trap the
Nemotron/GLM catalog rotation already burned this project on once). Purely a crude, model-
agnostic proxy, purely advisory, never blocks — warns past 10 resumes on one thread, visible
in `cli-relay list`'s `turns` column.

**This detection alone is reactive, not a real fix** — it tells you something risky already
happened, it doesn't stop it. The proactive counterpart, shipped 2026-08-24 (full design in
`docs/pinned-facts-design.md`): a per-thread **pinned-facts ledger**. `cli-relay pin <thread>
"<fact>"` stores a fact that cli-relay itself re-injects into every future `fresh` **and**
`resume` prompt on that thread, external to and independent of whatever the backend's own
compaction does to its internal memory — a correction's survival no longer depends on the
backend remembering it correctly through a compaction event at all. Pins deliberately persist
across a `fresh` restart (unlike turn count/compaction flag, which reset) — the recommended
recovery from a compaction-risky thread (pin the load-bearing facts, then restart fresh) now
carries them forward automatically instead of requiring manual re-typing. Verified live:
resuming a thread correctly answered a fact that was never in the visible prompt, and a
genuinely new native session after a `fresh` restart still knew it. Deliberately NOT
auto-detecting "this looks like a correction" from prompt text to auto-pin it — that's
guessing at intent, the same trap this whole project has avoided everywhere else.

## Known gaps (not blocking, worth knowing)

- `command-code` resume stays disabled until its seed-turn-drop bug is root-caused.
- `claude-code` calls hit real Anthropic billing against the Pro plan (confirmed ~$0.07-0.13
  per short test call) — not free the way codex/agy effectively are for testing.
- Grandchild processes that double-fork/setsid out of a backend's process group would survive
  a router-initiated kill (documented in `cli-relay.mjs`, not solved — no known instance of this
  happening yet).
- **`SPAWN_TIMEOUT_MS` bumped 10m → 20m (2026-08-24).** Observed live 2026-08-20: at least 3
  real threads doing genuine audit-scale work hit `last_timed_out: true`, not stuck processes.
  20m is still a
  guess, not a verified figure — watch `cli-relay list` for more timeouts before assuming
  it's the right number either.
- **`agy`'s model catalog rotates without notice (found 2026-08-31).** The hardcoded
  `gemini-3.5-flash-medium` in `src/adapters/agy.mjs` was silently removed from agy's own
  model list, breaking every `cli-relay agy` call until caught and bumped to
  `gemini-3.6-flash-medium`. No detection for this beyond the call itself failing loud (which
  it does correctly) — if agy calls start failing with "invalid model selection," check
  `agy models` for a renamed/retired model before assuming cli-relay itself is broken.
- **A narrow SIGINT window can still stick a thread at `status: "running"` (found 2026-09-01,
  not introduced by anything recent — pre-existing since the original signal-handling work).**
  Between critical section 1 saving `status: "running"` and `runChild` actually setting
  `activeChildPgid`, a SIGINT lands in the signal handler's "nothing spawned yet" branch and
  exits immediately with no unwind. The lock itself is already released by that point (CS1
  finished), so the thread doesn't self-heal via lock staleness — it stays stuck until
  `LOCK_STALE_MS` (~21 min) passes on the *next* invocation against that thread. Narrow
  window, real gap; not closed here.
- `doctor`'s `which`/`where` child processes aren't tracked by the SIGINT handler — a Ctrl-C
  during `doctor` reports "nothing spawned yet" even though those children are briefly alive.
  Low severity (`which` exits in milliseconds).
- A prompt whose text is literally `--dry-run` or `--print-command` gets stripped from the
  prompt and treated as the flag — an edge case the flag's argv-scanning approach introduces,
  not expected to matter in practice.
