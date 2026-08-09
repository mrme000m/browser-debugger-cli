#!/usr/bin/env python3
"""Split a valid-protocol CSV into per-protocol CSV files.

By default pulls out SFTP, SSH and SMTP into separate files.
Other protocols can be selected with --protocols.
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Split a valid protocol CSV by protocol.")
    ap.add_argument("csv", type=Path, help="Input CSV (e.g. valid_protocol_creds.csv)")
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Output directory (default: same as input CSV)",
    )
    ap.add_argument(
        "--protocols",
        default="sftp,ssh,smtp",
        help="Comma-separated protocols to extract (default: sftp,ssh,smtp)",
    )
    args = ap.parse_args()

    if not args.csv.is_file():
        print(f"Error: CSV not found: {args.csv}", file=sys.stderr)
        return 2

    out_dir = args.out_dir or args.csv.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    wanted = {p.strip().lower() for p in args.protocols.split(",") if p.strip()}
    rows_by_proto: dict[str, list[dict]] = defaultdict(list)

    with args.csv.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if not fieldnames or "protocol" not in fieldnames:
            print("Error: CSV missing 'protocol' column", file=sys.stderr)
            return 2
        for row in reader:
            proto = row.get("protocol", "").strip().lower()
            if proto in wanted:
                rows_by_proto[proto].append(row)

    for proto, rows in sorted(rows_by_proto.items()):
        out_path = out_dir / f"{proto}_valid_creds.csv"
        with out_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"{out_path}: {len(rows)} rows")

    return 0


if __name__ == "__main__":
    sys.exit(main())
