# Pinned-facts ledger — design doc

Status as of 2026-08-24: **built and live-tested on the `dev` branch** (separate git
worktree, `~/Projects/cli-relay-dev` — the live `main`/symlinked path was never touched
during the build). Not yet merged to `main` — that's a deliberate, separate "go live" step.
Verified live: injection works on resume (a fact never in the visible prompt came back
correctly), and survives a `fresh` restart into a genuinely new native session. This doc
originally captured the pre-build design; kept below as the record of what was agreed and
why, now annotated with what actually shipped.

## Why

Everything shipped so far for the 2026-08-20 compaction-risk discussion (turn-count
advisory, `compaction_detected` flag) is retrospective — it tells you something risky
already happened, or is about to, and leaves recovery to a human noticing. This is the
proactive answer: stop trying to detect or predict compaction, and instead make cli-relay
independently own the facts that must survive it, external to whatever the backend's own
memory does.

## Data model

Add `pinned_facts: [{text, pinned_at}]` to each thread's session record. Objects with
timestamps, not bare strings — every other field in this map already carries a timestamp
(`created_iso`, `last_run_iso`, `run_started_iso`); an untimestamped fact would be the one
inconsistent thing in the record.

**Pins persist across a `fresh` restart of the same thread name — this is the decision that
matters most.** Turn count, `compaction_detected`, and the native session id all reset on
`fresh` (clean slate, new backend conversation). Pins do not. They're facts about the *work*,
not about the backend's current memory state. This is what closes the loop with what already
exists: turn-count threshold flags a thread as compaction-risky → pin the load-bearing facts
if not already pinned → `fresh` restart → the new native session's very first prompt
automatically carries every pinned fact, zero manual re-typing. Without persistence-across-
fresh, "recap on restart" stays a manual chore.

## CLI surface

Matches the existing `list`/`reset` housekeeping pattern:

```
cli-relay pin <thread> "<fact>"      — append (requires the thread to already exist, same as reset)
cli-relay unpin <thread> <index>     — remove by index
cli-relay pins <thread>              — list a thread's pins with their timestamps
```

`pin`/`unpin` mutate the map → `withLock`, exactly like `reset`. `pins` is read-only, no lock,
same as `list`.

## Injection

Not folded into `fresh`/`resume`'s existing prompt argument — kept as separate, deliberate
commands, same "one clear action per invocation" discipline the router already follows.
When a thread has pins, **both** `fresh` and `resume` prepend a formatted block before the
prompt reaches the backend:

```
[PINNED FACTS for this thread — externally verified, override anything else in this
conversation's history including your own summarized memory of earlier turns. Treat any
contradiction between these and your own recollection as your recollection being wrong.]
1. <fact> (pinned <date>)
2. <fact> (pinned <date>)
[END PINNED FACTS]

<the actual prompt>
```

Deliberately blunt wording ("treat your recollection as wrong") — soft framing risks the
model weighing it as just another fact rather than the override it needs to be to actually
defeat a bad compaction.

## Guardrails

Soft, non-blocking advisory past a pin count (proposed: 8) — nudge toward curation, don't
block. Past that point the honest move is a single curated recap, not a growing list — same
"advisory, never blocks" posture as `RESUME_WARNING_THRESHOLD`. `reset` clears pins along
with everything else (no special-casing — they're part of the thread record). `cli-relay
list` gets a `pins` count column; full text only via `cli-relay pins <thread>`.

Deliberately NOT building: auto-detecting "this looks like a correction" from prompt text to
auto-pin it. That's guessing at intent — the same trap this whole project has avoided
everywhere else. Pinning is an explicit, deliberate act, always.

## Build workflow — how this gets shipped without touching the live path

`~/bin/cli-relay` is a symlink into `~/Projects/cli-relay/cli-relay.mjs` on `main`, in this one
directory. A plain `git checkout -b dev` in this same directory would change the live file
immediately — before a single line is finished, let alone merged. A branch alone doesn't
protect anything if it's checked out where the symlink points.

**Actual safe version: a separate git worktree.**
```
git worktree add ../cli-relay-dev dev
```
This gives `dev` its own directory and its own checked-out files. `~/Projects/cli-relay`
stays on `main`, completely untouched, for the entire build — the live symlink never moves.
"Go live" is a real, deliberate, single step later: merge `dev` into `main` in the original
worktree, only when nothing's actively using it.

**Once built:** extend `tests/smoke.sh` for pin/unpin/pins and the fresh-persists-pins
behavior, full Fable review pass (same as everything else in this repo), then merge.

## Resolved during the build

- Pin-count advisory threshold: **8** (`PIN_WARNING_THRESHOLD`), non-blocking, matches
  `RESUME_WARNING_THRESHOLD`'s posture.
- Truncation in `pins <thread>`'s listing: **not needed.** `cli-relay list`'s table only shows
  a pin *count* column, never the fact text, so the cramped-table truncation concern that
  applies to session ids there doesn't apply here. `pins <thread>` is a dedicated command you
  run specifically to read the full text — showing it truncated there would be the wrong
  default.
- Fresh-mode injection: confirmed necessary, not just resume. Since pins persist across
  `fresh`, the very first prompt of a brand-new native session needs the block too, or the
  "restart carries facts forward automatically" claim wouldn't actually hold.

## Fable review pass (2026-08-24) — one real fix, two consistency nits

- **Real gap, fixed:** `reset` destroyed pins silently while `fresh`'s overwrite warning
  explicitly reassures the user pins survive — backwards asymmetry, since the one operation
  that actually erases pins was the quiet one. `reset` now warns before deleting a thread with
  pins, naming the count and pointing at `cli-relay pins <thread>` to check first.
- **Consistency nit, fixed:** `cmdPins`' "no such thread" path used `console.error` + direct
  `process.exit(1)` instead of throwing, the one place its discipline didn't match
  `reset`/`unpin`. Now throws, propagating through `main().catch` for the same `cli-relay error: `
  prefix and exit code everywhere else gets.
- **Philosophy consistency, added:** `pins_injected` count added to the per-call JSON payload
  — every other per-call fact this router can know (turn count, compaction detection, resume
  failures) already surfaces there per the file's own "never a collapsed success bool"
  standard; pin injection working silently in the background was the one exception.
- Confirmed clean, no changes needed: injection point (prepending to the prompt string is
  correct — no shell is ever involved, so no injection-vector risk from pin content); lock
  discipline in `cmdPin`/`cmdUnpin` matches `cmdReset` exactly; no interaction bugs with
  turn_count/compaction_detected/consecutive_resume_failures, each independently checked.
