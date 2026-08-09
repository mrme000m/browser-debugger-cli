#!/usr/bin/env bash
# Repeatable CSV scan of protocol credentials in the 0807 cleaned dump.
# Progress is saved to a JSON state file so reruns resume where they left off.
#
# Usage:
#   bash scan_0807_protocols.sh [MAX] [CONCURRENCY] [PROTOCOL]
#
# PROTOCOL is a single protocol (e.g. ftp, sftp, ssh, smtp) or omitted to scan all.
set -euo pipefail

ROOT="/Volumes/Untitled/cookies/data/0807/urlp/cleaned"
OUT_DIR="/Volumes/Untitled/cookies/data/0807/urlp/valid"
TS="$(date +%Y%m%d_%H%M%S)"

MAX="${1:-5000}"          # first arg: candidate limit; 0 = unlimited
CONCURRENCY="${2:-8}"     # second arg: parallel workers
PROTOCOL="${3:-}"         # third arg: single protocol to scan (optional)

if [[ -n "$PROTOCOL" ]]; then
    PROTOCOLS="$PROTOCOL"
    OUT_FILE="${OUT_DIR}/${PROTOCOL}_creds_${TS}.csv"
    STATE_FILE="${OUT_DIR}/${PROTOCOL}_creds_state.json"
else
    PROTOCOLS="ftp,ftps,sftp,ssh,smtp,smtps,http,https"
    OUT_FILE="${OUT_DIR}/protocol_creds_${TS}.csv"
    STATE_FILE="${OUT_DIR}/protocol_creds_state.json"
fi

mkdir -p "$OUT_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 "$SCRIPT_DIR/check_protocol_creds.py" \
  "$ROOT" \
  --protocols "$PROTOCOLS" \
  --out "$OUT_FILE" \
  --state "$STATE_FILE" \
  --max "$MAX" \
  --concurrency "$CONCURRENCY" \
  2> >(tee /tmp/scan_protocols.log >&2)

echo "---"
echo "CSV:        $OUT_FILE"
echo "State:      $STATE_FILE"
wc -l "$OUT_FILE"
