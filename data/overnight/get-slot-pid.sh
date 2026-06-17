#!/usr/bin/env bash
# BUG-017: print the PID actually owning the slot's LISTEN socket.
# Never trust the spawn PID — on Windows, Start-Process java often returns
# the launcher PID, not the real java.exe. The kill-by-port lookup below
# is the same logic used by src/admin.js#getListenerPid for the recycle API.
#
# Usage: ./get-slot-pid.sh <slot-number>     # 1..5
#        ./get-slot-pid.sh --port <port>
#
# Prints the PID to stdout, or nothing (exit 1) if no listener found.

set -euo pipefail

# Slot N -> port. Mirrors PORT_BY_SLOT in src/admin.js.
declare -A PORT_BY_SLOT=( [1]=25565 [2]=25566 [3]=25567 [4]=25568 [5]=25569 )

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") <slot-number>
       $(basename "$0") --port <port>

slot-number: 1..5 (mapped to ports 25565..25569)
EOF
  exit 2
}

if [ $# -lt 1 ]; then usage; fi

if [ "$1" = "--port" ]; then
  [ $# -eq 2 ] || usage
  PORT="$2"
else
  SLOT="$1"
  PORT="${PORT_BY_SLOT[$SLOT]:-}"
  if [ -z "$PORT" ]; then
    echo "unknown slot: $SLOT (expected 1..5)" >&2
    exit 2
  fi
fi

# Detect platform. MSYS_NT and MINGW_NT are git-bash on Windows.
UNAME="$(uname -s 2>/dev/null || echo unknown)"

case "$UNAME" in
  MSYS_NT*|MINGW*_NT*|CYGWIN_NT*)
    # Windows: netstat -ano. Filter to LISTENING + match :<port> at end of
    # local address (avoids matching the same port number inside an
    # ESTABLISHED row's foreign-address column).
    PID="$(netstat -ano -p TCP \
      | tr -d '\r' \
      | awk -v port=":$PORT" '
          /LISTENING/ {
            local = $2
            n = length(local)
            p = length(port)
            if (substr(local, n - p + 1) == port) { print $NF; exit }
          }
        ')"
    ;;
  Linux*|Darwin*)
    # POSIX: lsof first (clean), fall back to ss.
    PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)"
    if [ -z "$PID" ]; then
      PID="$(ss -lntp "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2 || true)"
    fi
    ;;
  *)
    echo "unsupported platform: $UNAME" >&2
    exit 3
    ;;
esac

if [ -z "${PID:-}" ]; then
  echo "no listener on port $PORT" >&2
  exit 1
fi

echo "$PID"
