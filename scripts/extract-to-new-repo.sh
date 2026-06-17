#!/usr/bin/env bash
# Extract warden to its own git repo with a clean (squashed) history. We
# deliberately do NOT use `git subtree split` here because the parent
# monorepo's history may contain leaked secrets (e.g. data/settings.json
# was committed with an API key in it before this script existed). subtree
# split would preserve that. Instead we copy the working tree, create a
# fresh repo with a single squash commit, then push.
#
# Usage:
#   ./extract-to-new-repo.sh <destination-dir> [--remote <git-url>]
#
# Example:
#   ./extract-to-new-repo.sh ~/code/warden \
#     --remote git@github.com:josephg29/warden.git

set -euo pipefail

if [ $# -lt 1 ]; then
  cat >&2 <<EOF
usage: $(basename "$0") <destination-dir> [--remote <git-url>]

destination-dir   absolute or ~-relative path; must not exist or be empty
--remote          optional git remote URL to set as 'origin' and push to
EOF
  exit 2
fi

DEST="$1"; shift
REMOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

# Resolve relative paths and ~
DEST="${DEST/#\~/$HOME}"

# Source: this script lives in <repo>/scripts/ inside the working tree.
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
  echo "error: destination $DEST exists and is non-empty" >&2
  exit 1
fi

echo "[extract] source:      $SRC"
echo "[extract] destination: $DEST"

mkdir -p "$DEST"

# Copy the working tree using git's own file list. This respects .gitignore
# exactly (so personal data files we just gitignored are NOT copied) and
# includes both tracked AND untracked-not-ignored files (so brand-new files
# you haven't committed yet still ship). Portable across Linux/macOS/Windows
# git-bash since it doesn't depend on rsync.
echo "[extract] enumerating files via git ls-files..."
cd "$SRC"
# --cached: tracked. --others: untracked. --exclude-standard: respect .gitignore.
# Note: if warden sits inside a parent repo that has node_modules/
# committed (which can happen with monorepo "full snapshot" commits), git
# ls-files will return those paths despite our local .gitignore — gitignore
# only filters UNTRACKED files. We therefore filter the list explicitly to
# guarantee node_modules/, .git/, and personal data dirs never ship.
FILE_COUNT=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    node_modules/*|*/node_modules/*) continue ;;
    .git/*|*/.git/*)                 continue ;;
    data/settings.json|data/bots.json) continue ;;
    data/memory/*|data/msa-cache/*|data/snapshots/*|data/diagnostics/*|data/logs/*) continue ;;
    data/overnight/state.json|data/overnight/slots.json) continue ;;
    data/overnight/*.log|data/overnight/*.log.err|data/overnight/*.jsonl) continue ;;
    data/overnight/*.out|data/overnight/*.err|data/overnight/*.pid) continue ;;
    data/overnight/cloudflared.log|data/dashboard-heartbeat) continue ;;
    data/mc-test-slot*|data/mc-test*.out|data/mc-control.out) continue ;;
    data/dev-server.log|data/dev-server-err.log) continue ;;
    data/minecraft-server/*) continue ;;
    AI/*|server.log|server.err|.env|.env.local|.env.*.local) continue ;;
    .tools/*|*/.tools/*) continue ;;
    .DS_Store|Thumbs.db|*/.DS_Store|*/Thumbs.db) continue ;;
  esac
  dir="$(dirname "$f")"
  mkdir -p "$DEST/$dir"
  cp "$f" "$DEST/$f"
  FILE_COUNT=$((FILE_COUNT + 1))
done < <(git ls-files --cached --others --exclude-standard)
cd - >/dev/null
echo "[extract] copied $FILE_COUNT files"

# Create the data/ skeleton with a placeholder so the directory survives a
# fresh clone (otherwise the dashboard's first run can't write to it).
mkdir -p "$DEST/data/overnight"
cat > "$DEST/data/.gitkeep" <<EOF
This directory is created at runtime by the dashboard. Configuration files
(settings.json, bots.json) live here per-host and are gitignored.
EOF

# Sanity check: scan the destination for genuinely-private strings before we
# initialise git. Build the regex from fragments so this script doesn't
# false-positive on itself when scanned. Note: the GitHub username (which
# appears in package.json / README's repo URL) is INTENTIONALLY public and
# is NOT included in this regex.
echo "[extract] scanning for personal references..."
PERSONAL_RE="$(printf 'bigfatjoey|%s|%s|%s|%s|%s|csk-ywy59|sk-b6486f|C:\\\\\\\\%s|/c/%s|Linse' \
  'VioTxR5M9x' '4mziG-KLER' 'DbReOESsIN' 'hbC0sUDrl7' 'pWuL01qflQ' \
  'secondmind' 'secondmind')"
if grep -rEn "$PERSONAL_RE" "$DEST" \
    --exclude-dir=node_modules \
    --exclude="extract-to-new-repo.sh" 2>/dev/null; then
  echo
  echo "[extract] ABORT: personal references found in destination — review and remove before retrying" >&2
  exit 1
fi
echo "[extract] clean."

# Initialise the new repo.
echo "[extract] initialising fresh git history..."
cd "$DEST"
git init -b main >/dev/null
git add .
git commit -m "Initial public release

Operational layer for running a fleet of LLM-driven Minecraft bots.
Includes dashboard, watchdog, atomic slot recycle, snapshot-before-wipe,
disk surveillance, and brain hardening (hard-block, oscillation detector,
memory/inventory diff, chat throttle, worldborder clamp, typed LLM errors,
safe-error reporter).

See CHANGELOG.md for the full bug catalogue this release closes." >/dev/null

if [ -n "$REMOTE" ]; then
  echo "[extract] adding remote: $REMOTE"
  git remote add origin "$REMOTE"
  echo "[extract] pushing to $REMOTE main..."
  git push -u origin main
fi

cat <<EOF

[extract] DONE.

next steps:
  cd $DEST
  npm install
  cp .env.example .env  # add your CEREBRAS_API_KEY
  npm test              # smoke

if you skipped --remote, set it now:
  git remote add origin git@github.com:josephg29/warden.git
  git push -u origin main

EOF
