#!/usr/bin/env bash
# smoke.sh — repeatable regression check for route.mjs.
#
# Exercises the real router against real backends (not mocks) — agy is used for anything
# that costs money-per-call, since agy is free/cheap; codex is used only for the fast-fail
# scenarios (bad resume id) where its error mode is exactly what's under test. claude-code
# and command-code are intentionally NOT exercised here by default — claude-code hits real
# Anthropic billing per call (see README), and command-code's resume is disabled anyway.
#
# Backs up and restores your configured session map around the run so this is safe to
# run any time without disturbing real thread state.
#
# Usage: ./tests/smoke.sh

set -uo pipefail
ROUTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/route.mjs"
CONFIG_MODULE="$(dirname "$ROUTE")/src/config.mjs"
if ! MAP=$(node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { MAP_PATH } = await import(pathToFileURL(process.argv[1]).href);
  process.stdout.write(MAP_PATH);
' "$CONFIG_MODULE"); then
  echo "failed to resolve configured route session map" >&2
  exit 1
fi
[ -n "$MAP" ] || { echo "configured route session map is empty" >&2; exit 1; }
BACKUP="$MAP.smoke-backup.$$"
PASS=0
FAIL=0

restore_map() {
  rm -f "$MAP" "$MAP.lock"
  [ -f "$BACKUP" ] && mv "$BACKUP" "$MAP"
}
trap restore_map EXIT

[ -f "$MAP" ] && cp "$MAP" "$BACKUP"
rm -f "$MAP" "$MAP.lock"

check() {
  local desc="$1" expected_code="$2" actual_code="$3"
  if [ "$actual_code" = "$expected_code" ]; then
    echo "PASS: $desc (exit $actual_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc (expected exit $expected_code, got $actual_code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "== list on empty map =="
out=$(node "$ROUTE" list); code=$?
check "list on empty map" 0 "$code"
echo "$out" | grep -q "no threads recorded" && echo "PASS: empty-map message correct" && PASS=$((PASS+1)) || { echo "FAIL: empty-map message wrong: $out"; FAIL=$((FAIL+1)); }

echo
echo "== fresh + resume against agy (real call, real context retention check) =="
fresh_out=$(node "$ROUTE" agy smoke-thread fresh "Reply with exactly: PONG"); fresh_code=$?
check "agy fresh" 0 "$fresh_code"
answer_parsed=$(echo "$fresh_out" | python3 -c "import json,sys; print(json.load(sys.stdin)['answer_parsed'])" 2>/dev/null)
[ "$answer_parsed" = "True" ] && echo "PASS: agy fresh produced a parsed answer" && PASS=$((PASS+1)) || { echo "FAIL: agy fresh answer_parsed=$answer_parsed"; FAIL=$((FAIL+1)); }

resume_out=$(node "$ROUTE" agy smoke-thread resume "What word did I just ask you to reply with? Answer with just that word."); resume_code=$?
check "agy resume" 0 "$resume_code"
resume_answer=$(echo "$resume_out" | python3 -c "import json,sys; print(json.load(sys.stdin)['answer'])" 2>/dev/null)
echo "$resume_answer" | grep -qi "PONG" && echo "PASS: agy resume correctly recalled context" && PASS=$((PASS+1)) || { echo "FAIL: agy resume did not recall context, got: $resume_answer"; FAIL=$((FAIL+1)); }

echo
echo "== list shows the thread, reset removes it =="
node "$ROUTE" list | grep -q "smoke-thread" && echo "PASS: list shows the thread" && PASS=$((PASS+1)) || { echo "FAIL: thread missing from list"; FAIL=$((FAIL+1)); }
reset_out=$(node "$ROUTE" reset smoke-thread); reset_code=$?
check "reset existing thread" 0 "$reset_code"
reset2_out=$(node "$ROUTE" reset smoke-thread 2>&1); reset2_code=$?
check "reset already-gone thread fails" 1 "$reset2_code"

echo
echo "== pinned facts: pin, verify injection, verify persistence across a fresh restart =="
node "$ROUTE" agy pin-smoke fresh "Reply with exactly: PONG" > /dev/null 2>&1
pin_out=$(node "$ROUTE" pin pin-smoke "the secret code word for this thread is BANANA77"); pin_code=$?
check "pin on existing thread" 0 "$pin_code"
echo "$pin_out" | grep -q "1 total" && echo "PASS: pin count correct" && PASS=$((PASS+1)) || { echo "FAIL: pin output wrong: $pin_out"; FAIL=$((FAIL+1)); }

pins_out=$(node "$ROUTE" pins pin-smoke); pins_code=$?
check "pins listing" 0 "$pins_code"
echo "$pins_out" | grep -q "BANANA77" && echo "PASS: pins listing shows the fact" && PASS=$((PASS+1)) || { echo "FAIL: pins listing missing fact: $pins_out"; FAIL=$((FAIL+1)); }

resume_pin_out=$(node "$ROUTE" agy pin-smoke resume "What is the secret code word for this thread? Answer with just the word.")
resume_pin_answer=$(echo "$resume_pin_out" | python3 -c "import json,sys; print(json.load(sys.stdin)['answer'])" 2>/dev/null)
echo "$resume_pin_answer" | grep -qi "BANANA77" && echo "PASS: resume received the injected pin (never stated in the visible prompt)" && PASS=$((PASS+1)) || { echo "FAIL: pin was not injected on resume, got: $resume_pin_answer"; FAIL=$((FAIL+1)); }

# The core design claim: a genuinely NEW native session (fresh, not resume) still knows the
# pinned fact, because pins persist across fresh restarts and get re-injected either way.
old_id=$(python3 -c "import json; print(json.load(open('$MAP'))['sessions']['pin-smoke']['native_session_id'])")
fresh2_out=$(node "$ROUTE" agy pin-smoke fresh "What is the secret code word for this thread? Answer with just the word." 2>/dev/null)
new_id=$(echo "$fresh2_out" | python3 -c "import json,sys; print(json.load(sys.stdin)['native_session_id'])" 2>/dev/null)
fresh2_answer=$(echo "$fresh2_out" | python3 -c "import json,sys; print(json.load(sys.stdin)['answer'])" 2>/dev/null)
[ "$new_id" != "$old_id" ] && echo "PASS: fresh restart produced a genuinely new native session" && PASS=$((PASS+1)) || { echo "FAIL: session id did not change on fresh: $new_id"; FAIL=$((FAIL+1)); }
echo "$fresh2_answer" | grep -qi "BANANA77" && echo "PASS: pin survived fresh restart and was injected into the brand-new session" && PASS=$((PASS+1)) || { echo "FAIL: pin did not survive fresh restart, got: $fresh2_answer"; FAIL=$((FAIL+1)); }

unpin_out=$(node "$ROUTE" unpin pin-smoke 1); unpin_code=$?
check "unpin by index" 0 "$unpin_code"
pins_after=$(node "$ROUTE" pins pin-smoke)
echo "$pins_after" | grep -q "no pinned facts" && echo "PASS: pin removed" && PASS=$((PASS+1)) || { echo "FAIL: pin still present after unpin: $pins_after"; FAIL=$((FAIL+1)); }

pin_missing_out=$(node "$ROUTE" pin does-not-exist "x" 2>&1); pin_missing_code=$?
check "pin on nonexistent thread fails" 1 "$pin_missing_code"
unpin_bad_out=$(node "$ROUTE" unpin pin-smoke 99 2>&1); unpin_bad_code=$?
check "unpin out-of-range index fails" 1 "$unpin_bad_code"

# Fable review finding: reset must warn before silently destroying pins (was quiet before).
node "$ROUTE" pin pin-smoke "a fact that reset is about to destroy" > /dev/null 2>&1
reset_warn_out=$(node "$ROUTE" reset pin-smoke 2>&1); reset_warn_code=$?
check "reset on a pinned thread still succeeds" 0 "$reset_warn_code"
echo "$reset_warn_out" | grep -q "will be destroyed by reset" && echo "PASS: reset warns before destroying pins" && PASS=$((PASS+1)) || { echo "FAIL: reset did not warn about pins: $reset_warn_out"; FAIL=$((FAIL+1)); }

echo
echo "== circuit breaker: seed 2 prior failures, live-fire the 3rd against codex with a bad id =="
cat > "$MAP" << 'EOF'
{"version":1,"sessions":{"circuit-smoke":{"backend":"codex","native_session_id":"00000000-0000-0000-0000-000000000000","confirmed":true,"status":"ready","last_run_iso":"2026-01-01T00:00:00.000Z","last_exit_code":1,"consecutive_resume_failures":2}}}
EOF
cd /tmp
trip_out=$(node "$ROUTE" codex circuit-smoke resume "test" --skip-git-repo-check 2>&1); trip_code=$?
# codex's own nonzero exit on a bad id means route exits 1, not 3 — see README exit-code table
check "circuit breaker 3rd-strike call" 1 "$trip_code"
confirmed_after=$(python3 -c "import json; print(json.load(open('$MAP'))['sessions']['circuit-smoke']['confirmed'])")
[ "$confirmed_after" = "False" ] && echo "PASS: thread auto-unconfirmed after 3 failures" && PASS=$((PASS+1)) || { echo "FAIL: still confirmed=$confirmed_after"; FAIL=$((FAIL+1)); }

retry_out=$(node "$ROUTE" codex circuit-smoke resume "test again" 2>&1); retry_code=$?
check "resume refused on auto-unconfirmed thread" 1 "$retry_code"
echo "$retry_out" | grep -q "refusing to guess" && echo "PASS: refusal message correct" && PASS=$((PASS+1)) || { echo "FAIL: wrong refusal message: $retry_out"; FAIL=$((FAIL+1)); }

echo
echo "== signal handling: SIGINT mid-run must exit 130, clean up child + lock =="
rm -f "$MAP" "$MAP.lock"
node "$ROUTE" agy sig-smoke fresh "Write a very long, detailed essay about the history of distributed systems." > /tmp/route-smoke-sig.out 2>&1 &
RPID=$!
sleep 3
kill -INT "$RPID" 2>/dev/null
wait "$RPID"; sig_code=$?
check "SIGINT exits 130" 130 "$sig_code"
pgrep -f "agy.*sig-smoke" > /dev/null && { echo "FAIL: agy child still running after SIGINT"; FAIL=$((FAIL+1)); } || { echo "PASS: no orphaned agy process"; PASS=$((PASS+1)); }
[ -d "$MAP.lock" ] && { echo "FAIL: lock directory left behind"; FAIL=$((FAIL+1)); } || { echo "PASS: lock cleaned up"; PASS=$((PASS+1)); }
rm -f /tmp/route-smoke-sig.out

echo
echo "== signal handling: SIGINT while genuinely pre-spawn (lock held elsewhere) must abort =="
echo "== immediately WITHOUT spawning a child — the distinct branch from the mid-run case above =="
rm -f "$MAP" "$MAP.lock"
mkdir "$MAP.lock"
sleep 30 & HOLDER_PID=$!
python3 -c "import json; json.dump({'pid': $HOLDER_PID, 'ts': __import__('time').time()*1000}, open('$MAP.lock/holder.json','w'))"
node "$ROUTE" agy prespawn-smoke fresh "Reply with exactly: PONG" > /tmp/route-smoke-prespawn.out 2>&1 &
RPID=$!
sleep 1
start_ts=$(date +%s)
kill -INT "$RPID" 2>/dev/null
wait "$RPID"; prespawn_code=$?
elapsed=$(( $(date +%s) - start_ts ))
check "pre-spawn SIGINT exits 130" 130 "$prespawn_code"
[ "$elapsed" -lt 5 ] && echo "PASS: exited promptly ($elapsed s, not waiting on LOCK_TIMEOUT_MS)" && PASS=$((PASS+1)) || { echo "FAIL: took ${elapsed}s to exit — didn't abort immediately"; FAIL=$((FAIL+1)); }
pgrep -f "agy.*prespawn-smoke" > /dev/null && { echo "FAIL: agy was spawned despite pre-spawn interrupt"; FAIL=$((FAIL+1)); } || { echo "PASS: no child was ever spawned"; PASS=$((PASS+1)); }
kill "$HOLDER_PID" 2>/dev/null
rm -rf "$MAP.lock" /tmp/route-smoke-prespawn.out

echo
echo "===================="
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
