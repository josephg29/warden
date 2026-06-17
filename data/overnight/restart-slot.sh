#!/usr/bin/env bash
# Manual slot restart wrapper around the recycle-slot admin endpoint
# (POST /api/admin/slots/:n/recycle).
#
# When the dashboard is up, prefer this over the bare 11-step manual
# sequence — the API does it atomically and uses the listener-PID lookup
# (BUG-017) instead of the spawn PID. This script just adds a polite
# wait + result summary.
#
# Usage: ./restart-slot.sh <slot-number>
#        ./restart-slot.sh <slot-number> --dashboard http://127.0.0.1:8080

set -euo pipefail

DASHBOARD="${DASHBOARD:-http://127.0.0.1:8080}"

usage() {
  echo "usage: $(basename "$0") <slot-number> [--dashboard URL]" >&2
  exit 2
}

if [ $# -lt 1 ]; then usage; fi
SLOT="$1"; shift
case "$SLOT" in 1|2|3|4|5) ;; *) echo "bad slot: $SLOT" >&2; exit 2;; esac

while [ $# -gt 0 ]; do
  case "$1" in
    --dashboard) DASHBOARD="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; usage;;
  esac
done

# Sanity: dashboard reachable?
if ! curl -fsS --max-time 5 "$DASHBOARD/api/server" >/dev/null 2>&1; then
  cat >&2 <<EOF
dashboard not reachable at $DASHBOARD

if the dashboard is genuinely down, fall back to the manual sequence:
  1. ./get-slot-pid.sh $SLOT   # find the real listener PID
  2. taskkill /F /PID <pid>    # or kill -9 on POSIX
  3. rm -rf ../mc-test-slot${SLOT}/world{,_nether,_the_end}
  4. spawn java + reconnect bot via the dashboard once it's back

EOF
  exit 1
fi

echo "[restart-slot] recycling slot $SLOT via $DASHBOARD ..."
RESPONSE="$(curl -fsS -X POST "$DASHBOARD/api/admin/slots/$SLOT/recycle" \
  -H 'content-type: application/json' \
  -d '{}' || true)"

if [ -z "$RESPONSE" ]; then
  echo "[restart-slot] FAILED — no response from recycle endpoint" >&2
  exit 1
fi

echo "$RESPONSE"
