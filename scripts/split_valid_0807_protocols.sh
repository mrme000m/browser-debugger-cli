#!/usr/bin/env bash
# Split a valid protocol-creds CSV into per-protocol CSVs.
# With no argument, uses the newest CSV in the 0807 valid dir.
set -euo pipefail

VALID_DIR="/Volumes/Untitled/cookies/data/0807/urlp/valid"
PROTOCOLS="${1:-sftp,ssh,smtp}"
CSV="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$CSV" ]]; then
    CSV="$(ls -t "$VALID_DIR"/protocol_creds_*.csv 2>/dev/null | grep -v '_uncertain\.csv$' | head -1 || true)"
fi

if [[ -z "$CSV" || ! -f "$CSV" ]]; then
    echo "No valid CSV found. Run scan_0807_protocols.sh first or pass a CSV path."
    exit 1
fi

echo "Splitting: $CSV"
python3 "$SCRIPT_DIR/split_protocol_csv.py" "$CSV" --protocols "$PROTOCOLS"
