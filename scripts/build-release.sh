#!/usr/bin/env bash
# Assembles release/ from artifacts that actually exist.
#
# Every step is conditional on the real artifact being present: if no APK was
# built, release/apk/ is omitted rather than filled with a placeholder. Checksums
# are computed from the files on disk with sha256sum.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
GIT_REV="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

rm -rf "$OUT"
mkdir -p "$OUT"/{deployment,docs,source,checksums}

# --- docs: the real markdown files -----------------------------------------
copied_docs=0
for f in "$ROOT"/*.md; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in FINAL_REPORT.md|RELEASE_NOTES.md) continue;; esac
  cp "$f" "$OUT/docs/"
  copied_docs=$((copied_docs + 1))
done
echo "docs: $copied_docs files"

# --- deployment: docker + CI definitions -----------------------------------
cp "$ROOT/docker-compose.yml" "$OUT/deployment/" 2>/dev/null
cp "$ROOT/Dockerfile" "$OUT/deployment/" 2>/dev/null
cp "$ROOT/.env.example" "$OUT/deployment/" 2>/dev/null
mkdir -p "$OUT/deployment/workflows"
cp "$ROOT"/.github/workflows/*.yml "$OUT/deployment/workflows/" 2>/dev/null
mkdir -p "$OUT/deployment/scripts"
cp "$ROOT"/scripts/*.sh "$OUT/deployment/scripts/" 2>/dev/null
echo "deployment: $(find "$OUT/deployment" -type f | wc -l) files"

# --- source: tracked files only, so nothing untracked or secret sneaks in ---
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" archive --format=tar.gz -o "$OUT/source/my-ai-studio-$GIT_REV.tar.gz" HEAD
  echo "source: my-ai-studio-$GIT_REV.tar.gz ($(du -h "$OUT/source/my-ai-studio-$GIT_REV.tar.gz" | cut -f1))"
else
  echo "source: NOT AVAILABLE (not a git repository)"
fi

# --- apk: only if a real APK was supplied ----------------------------------
APK_SRC="${1:-}"
if [ -n "$APK_SRC" ] && [ -f "$APK_SRC" ]; then
  mkdir -p "$OUT/apk"
  cp "$APK_SRC" "$OUT/apk/app-debug.apk"
  echo "apk: copied $(stat -c%s "$OUT/apk/app-debug.apk") bytes"
else
  echo "apk: NOT AVAILABLE (no APK path supplied; run with ./scripts/build-release.sh /path/to/app-debug.apk)"
fi

# --- checksums -------------------------------------------------------------
( cd "$OUT" && find . -type f ! -name 'SHA256SUMS.txt' -print0 | sort -z | xargs -0 sha256sum > checksums/SHA256SUMS.txt )
echo "checksums: $(wc -l < "$OUT/checksums/SHA256SUMS.txt") entries"

cat > "$OUT/README.md" <<EOF
# My AI Studio - release

Assembled from commit \`$GIT_REV\`.

| Directory | Contents |
| --- | --- |
| \`apk/\` | Real debug APK, present only when a build actually produced one. |
| \`deployment/\` | Docker, environment template, GitHub Actions workflows, helper scripts. |
| \`docs/\` | Project documentation. |
| \`source/\` | \`git archive\` of the tracked tree at this commit. |
| \`checksums/\` | \`SHA256SUMS.txt\` for every file above. |

Verify with \`cd release && sha256sum -c checksums/SHA256SUMS.txt\`.
EOF

echo "release written to $OUT"
