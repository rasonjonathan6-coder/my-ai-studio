#!/usr/bin/env bash
# Real end-to-end API exercise against a running backend.
# Every step prints the actual server response; nothing is assumed to pass.
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
EMAIL="smoke_$(date +%s)@example.com"
PASS="smoke-password-12345"
JAR=$(mktemp)
FAILED=0

step() { printf '\n===== %s =====\n' "$1"; }
check() { local code=$1;
  if [ "$code" -eq 0 ]; then echo "RESULT: PASS ($2)"; else echo "RESULT: FAIL ($2)"; FAILED=$((FAILED+1)); fi
}

step "1. register user"
REG=$(curl -s -c "$JAR" -w '\nHTTP:%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"displayName\":\"Smoke\"}")
echo "$REG"
[ "$(echo "$REG" | tail -1)" = "HTTP:201" ]; check $? "register"

step "2. GET /api/auth/me"
ME=$(curl -s -b "$JAR" -w '\nHTTP:%{http_code}' "$BASE/api/auth/me")
echo "$ME"
echo "$ME" | grep -q "$EMAIL"; check $? "me"

step "3. duplicate registration must be rejected (409)"
DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
echo "status=$DUP"; [ "$DUP" = "409" ]; check $? "duplicate"

step "4. create project from android-calculator template"
PROJ=$(curl -s -b "$JAR" -w '\nHTTP:%{http_code}' -X POST "$BASE/api/projects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Calculator","template":"android-calculator"}')
echo "$PROJ"
PID=$(echo "$PROJ" | head -1 | python3 -c 'import sys,json; print(json.load(sys.stdin)["project"]["id"])')
echo "projectId=$PID"
[ -n "$PID" ]; check $? "create project"

step "5. list files (real generated template)"
FILES=$(curl -s -b "$JAR" "$BASE/api/projects/$PID/files?depth=6")
echo "$FILES" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("fileCount:",len(d["files"])); [print(" ",f["path"]) for f in d["files"][:25]]'
echo "$FILES" | grep -q 'gradlew'; check $? "gradlew generated"

step "6. read a real file"
READ=$(curl -s -b "$JAR" "$BASE/api/projects/$PID/file?path=app/src/main/java/com/myaistudio/calculator/Calculator.kt")
echo "$READ" | head -5
echo "$READ" | grep -q 'object Calculator'; check $? "read file"

step "7. path traversal must be blocked"
TRAV=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/projects/$PID/file?path=../../../../etc/passwd")
echo "status=$TRAV"; [ "$TRAV" = "400" ]; check $? "traversal blocked"

step "8. real terminal command"
TERM=$(curl -s -b "$JAR" -w '\nHTTP:%{http_code}' -X POST "$BASE/api/projects/$PID/terminal" \
  -H 'Content-Type: application/json' -d '{"command":"ls -1 && echo TERMINAL_OK"}')
echo "$TERM"
echo "$TERM" | grep -q 'TERMINAL_OK'; check $? "terminal executed"

step "9. run real tests (gradle test)"
TESTS=$(curl -s -b "$JAR" -w '\nHTTP:%{http_code}' -X POST "$BASE/api/projects/$PID/test")
echo "$TESTS" | head -c 1200; echo
echo "$TESTS" | grep -q '"passed"'; check $? "tests response"
echo "$TESTS" | python3 -c '
import sys, json
line = [l for l in sys.stdin.read().split(chr(10)) if l.startswith("{")]
d = json.loads(line[0])["test"]
print("framework:", d["framework"], "status:", d["status"], "passed:", d["passed"], "failed:", d["failed"], "duration_ms:", d["durationMs"])
sys.exit(0 if d["passed"] >= 1 and d["failed"] == 0 else 1)
'; check $? "gradle unit tests really ran and passed"

step "10. build real debug APK"
BUILD=$(curl -s -b "$JAR" -w '\nHTTP:%{http_code}' -X POST "$BASE/api/projects/$PID/build" \
  -H 'Content-Type: application/json' -d '{"target":"debug"}')
echo "$BUILD" | head -c 2500; echo
echo "$BUILD" | grep -q '"status":"succeeded"'; check $? "build succeeded"

step "11. export real ZIP"
EXPORT=$(curl -s -b "$JAR" -X POST "$BASE/api/projects/$PID/export")
echo "$EXPORT" | head -c 800; echo
echo "$EXPORT" | grep -q '"ok":true'; check $? "export zip"

step "12. security scan"
SCAN=$(curl -s -b "$JAR" -X POST "$BASE/api/projects/$PID/security/scan")
echo "$SCAN" | head -c 600; echo

step "13. system status (real probes)"
curl -s "$BASE/api/system/status" -o /tmp/status.json
python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/status.json'))
for p in d['probes']:
    print('  %-18s %-14s %s' % (p['name'], p['state'], p['detail'] or ''))
print('  backend:', d['executionBackend'], 'sandboxEnabled:', d['sandboxEnabled'])
PYEOF

step "14. cross-user access must be denied"
OTHERJAR=$(mktemp)
curl -s -c "$OTHERJAR" -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"other_$(date +%s)@example.com\",\"password\":\"$PASS\"}" > /dev/null
CROSS=$(curl -s -o /dev/null -w '%{http_code}' -b "$OTHERJAR" "$BASE/api/projects/$PID")
echo "foreign project access status=$CROSS"; [ "$CROSS" = "404" ]; check $? "cross-user denied"

step "15. unauthenticated access must be denied"
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/projects")
echo "status=$NOAUTH"; [ "$NOAUTH" = "401" ]; check $? "unauth denied"

step "16. agent run reports a real state (honest failure when unconfigured, real work when configured)"
AGENT=$(curl -s -b "$JAR" -X POST "$BASE/api/projects/$PID/agent/run" \
  -H 'Content-Type: application/json' -d '{"prompt":"add a power function"}')
echo "$AGENT"
# The run is asynchronous, and with a live key it takes minutes, so poll for a
# terminal state instead of a fixed sleep. The assertion is that the run reaches
# a real outcome and never stays queued, not that it fails.
TERMINAL=""
for _ in $(seq 1 60); do
  RUNS=$(curl -s -b "$JAR" "$BASE/api/projects/$PID/agent/runs")
  STATUS=$(printf '%s' "$RUNS" | python3 -c 'import json,sys;r=json.load(sys.stdin)["runs"];print(r[0]["status"] if r else "none")' 2>/dev/null)
  case "$STATUS" in succeeded|failed) TERMINAL="$RUNS"; break;; esac
  sleep 5
done
if [ -z "$TERMINAL" ]; then
  echo "$RUNS" | head -c 700; echo
  check 1 "agent run reaches a terminal state"
else
  echo "$TERMINAL" | head -c 700; echo
  if printf '%s' "$TERMINAL" | grep -q 'OPENROUTER_NOT_CONFIGURED'; then
    echo "  (OpenRouter not configured: explicit refusal, no actions performed)"
  fi
  check 0 "agent run reaches a terminal state"
fi

rm -f "$JAR" "$OTHERJAR"
printf '\n===== SMOKE SUMMARY =====\nFAILURES: %s\n' "$FAILED"
exit "$FAILED"
