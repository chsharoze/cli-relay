# Cherry-pick brief: patterns from cli-continues → cli-relay

Context: cli-relay is a zero-dependency Node.js CLI that routes prompts to four AI coding-agent
CLIs (codex, agy, claude-code, command-code) and resumes a prior conversation by asking the
backend to resume ITSELF via its own native flag (native resume-by-id, not transcript replay).
It was recently modularized into `cli-relay.mjs` (orchestration only) + `src/{config,core,commands,
adapters}/`. A separate, much larger project called `cli-continues` (github.com/yigitkonur/
cli-continues, cloned read-only at `~/Projects/cli-continues` if you want to look at its actual
source for inspiration — do NOT copy its transcript-parsing code, only the patterns below) was
deep-dive audited by two independent models, and both converged on six specific, concrete
patterns worth adapting into cli-relay. Implement all six, adapted to cli-relay's much simpler
scope — do not import cli-continues' dependencies (commander, chalk, zod, etc.) or its
transcript-parsing/handoff layer. cli-relay stays zero-npm-dependency, Node builtins only.

## The six changes

1. **Adapter registry with a load-time completeness assertion.** cli-relay already has a
   canonical list of backend names (derivable from `src/adapters/*.mjs` filenames via
   `loadAdapters()`). Add an explicit assertion at startup that every backend the router is
   configured to know about (define this as a single frozen array of expected backend names,
   e.g. `EXPECTED_BACKENDS = ['codex', 'agy', 'claude-code', 'command-code']`) actually has a
   loaded adapter with the required shape (`fresh`, `parse`, `env` at minimum — `resume` and
   `checkCompaction` are optional). If one is missing or malformed, throw a clear, specific
   error at startup (`Adapter registry incomplete: missing or malformed adapter(s) for X` —
   list exactly which ones and why) rather than failing confusingly later on first use.

2. **Injectable-predicate binary detection with fallback binary names, for a new `cli-relay
   doctor` command.** Add a `doctor` housekeeping command (alongside list/reset/pin/unpin/pins)
   that checks each backend's binary is actually resolvable on PATH. Design:
   `resolveBinaryName(candidates, isAvailable = realWhichCheck)` where `candidates` is an
   ordered array of binary names to try (most backends will just have one candidate; make the
   adapter interface support an optional array), `isAvailable` is an injectable async predicate
   (default implementation shells out to `which`/`where`), enumerate all backends via
   `Promise.allSettled` so one failing check doesn't kill the others, and print a clear
   available/unavailable report per backend (backend name, binary tried, found/not-found, and
   which specific candidate resolved if more than one was tried). This needs to be genuinely
   testable — the injectable predicate is the point, don't skip it.

3. **Composite `backend:thread` identity + ambiguity-safe thread lookup.** Currently a `thread`
   name alone is assumed unique across the whole map. Audit whether this is already implicitly
   guaranteed (check: can two different backends both register a session under the same thread
   name today? If `s.backend !== backend` already throws on a name collision across backends,
   this may already be handled — verify before "fixing" something that isn't broken). If there
   is a genuine gap, add explicit ambiguity handling to `list`/`pins`/wherever a thread name is
   looked up by partial/prefix match (if any such lookup exists) — exact match first, then
   unique-prefix match, and if multiple candidates remain, list them all and refuse to guess
   rather than silently picking the first. Do NOT invent a prefix-matching feature that doesn't
   currently exist just to then "fix" it — only act on what's actually there. If, after
   auditing, there's nothing to fix here, say so explicitly in your final summary rather than
   forcing a change.

4. **Minimal typed error model.** Replace ad-hoc `throw new Error(...)` call sites in the
   critical paths (backend-not-found, mode validation, thread-ownership mismatch, no-confirmed-
   session-for-resume) with a small `RelayError` class carrying a `code` and optional
   `exitCode`/`cause`, defined once (e.g. `src/core/errors.mjs`), and handle it once in
   `main().catch()` at the bottom of cli-relay.mjs — preserving the EXACT same user-facing error
   text and exit codes as today (this is a refactor of error plumbing, not a behavior change).
   Every existing exit code (0/1/2/3, plus the signal-derived 128+n codes) must be identical
   after this change — verify by diffing `tests/smoke.sh` output before/after.

5. **`--dry-run` / `--print-command` flag.** Add a flag that, when passed on a `fresh` or
   `resume` invocation, prints the exact argv array that would be spawned (backend binary +
   full args, after pin-injection is applied to the prompt) and exits 0 WITHOUT actually
   spawning the child process or touching the session map at all (no critical-section writes,
   no lock acquisition — a true no-op preview). Document it in the usage text.

6. **"Did you mean?" suggestions on a failed thread lookup.** When `resume`/`pin`/`unpin`/
   `pins`/`reset` is given a thread name that doesn't exist in the map, before failing loud,
   check for near-matches (case-insensitive substring match against existing thread names is
   sufficient — no need for a fuzzy-distance algorithm) and if any exist, list up to 3 of them
   in the error message ("did you mean: X, Y, Z?"). Keep the existing fail-loud exit codes
   unchanged — this only enriches the error message text, it must not change exit codes or make
   a previously-failing case now succeed.

## Hard constraints (do not violate any of these)

- Zero npm dependencies. Node builtins only (`node:fs`, `node:path`, `node:os`,
  `node:child_process`, `node:url`). No `package.json` dependencies added.
- Every existing CLI behavior must be preserved EXACTLY: usage text (except where you're adding
  new documented flags/commands), exit codes, JSON output shape on `fresh`/`resume`, the
  fail-loud-on-unconfirmed-resume guarantee, the resume circuit breaker, atomic map writes, lock
  staleness/self-heal behavior (do NOT touch `src/core/lock.mjs`'s reclaim logic — it was just
  hardened through four rounds of adversarial review, leave it exactly as-is), and pin
  validation. This is additive work, not a rewrite.
- Do not touch `src/core/lock.mjs` at all.
- Run `tests/smoke.sh` (it exercises real backend calls — agy is cheap, codex is used only for a
  fast-fail scenario) after your changes and fix anything it catches. It must still pass 32/32.
- Self-review your own diff for regressions before finishing.
- Commit your work on this branch when done, with a clear commit message describing what you
  did for each of the six items (or why you determined item 3 needed no change).

Work only in this worktree/branch. Do not touch `main`, `dev`, or any other worktree.
