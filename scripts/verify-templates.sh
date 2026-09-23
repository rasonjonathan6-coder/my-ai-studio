#!/usr/bin/env bash
# Creates each Android template through the real API and runs a real Gradle
# build for it, asserting that an APK is actually produced. This is the check
# that a template is not just plausible-looking source: without it a template
# can look complete and still fail to compile.
#
# Usage: BASE=http://127.0.0.1:8080 scripts/verify-templates.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
EMAIL="templates-$(date +%s)@example.com"
PASS="templates-pass-12345"
FAILURES=0

result() { printf 'RESULT: %s (%s)\n' "$1" "$2"; [ "$1" = PASS ] || FAILURES=$((FAILURES + 1)); }

TOKEN=$(curl -s -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')
[ -n "$TOKEN" ] || { echo "FAILED: could not register"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

for template in android-hello android-calculator android-floating-translator; do
  echo "--- $template"
  PROJECT_ID=$(curl -s -X POST "$BASE/api/projects" -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"name\":\"$template\",\"template\":\"$template\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["project"]["id"])')
  [ -n "$PROJECT_ID" ] || { result FAIL "$template create"; continue; }

  curl -s -X POST "$BASE/api/projects/$PROJECT_ID/build" -H "$AUTH" -H 'content-type: application/json' \
    -d '{"kind":"android-debug"}' > /tmp/tv_build_$template.json

  STATE=$(python3 -c 'import json;print(json.load(open("/tmp/tv_build_'$template'.json"))["build"]["status"])')
  APK_PATH=$(python3 -c 'import json;print(json.load(open("/tmp/tv_build_'$template'.json")).get("build",{}).get("apk",{}).get("relPath") or "")')
  APK_SIZE=$(python3 -c 'import json;print(json.load(open("/tmp/tv_build_'$template'.json")).get("build",{}).get("apk",{}).get("sizeBytes") or 0)')

  if [ "$STATE" = succeeded ] && [ -n "$APK_PATH" ] && [ "$APK_SIZE" -gt 100000 ]; then
    result PASS "$template build ($APK_PATH, ${APK_SIZE}B)"
  else
    result FAIL "$template build (status=$STATE apk=$APK_PATH)"
    tail -25 /tmp/tv_build_$template.json
  fi
done

echo "FAILURES: $FAILURES"
[ "$FAILURES" -eq 0 ]
