# review.md: review rules for cli-relay

Read this before reviewing any diff in this repo. The reviewer is never the builder.

## Severities

- High: data loss, a secret printed or committed, a change that breaks every open session or a deployed service, a silent default-behaviour change in a public interface.
- Medium: a feature stops working for one path, a test that passes for the wrong reason, a guard that can be bypassed.
- Low: naming, wording, formatting, dead code that is not on the changed lines.

## What to check

- Does the default behaviour stay byte-identical when no new option is passed? Say which code paths you traced.
- Is every new option covered by a test that would fail without the change?
- Does the change touch a shared file (settings, hooks, deploy script, schema)? Name the blast radius.
- Static review has a ceiling: if a parameter looks plausible but unverified, say "run it" instead of guessing.

## What to ignore

- Style that a formatter would fix.
- Pre-existing issues outside the changed lines. Mention once, do not fix.
- Commit message wording.

## Loop rules

- At most three review rounds on one change. After three, stop and ask for an architectural rethink.
- A follow-up review reads only the new diff since the last round.
- When a bug is one of a class, name the class so the builder fixes every instance at once.

## Learned (append one line per slip, newest last)

- 2026-10-31: per-call flags go before fresh|resume; a flag after the thread verb is swallowed into the prompt and the backend reports no query (seen with --model on command-code).
